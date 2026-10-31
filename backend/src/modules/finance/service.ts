import { createHash, randomUUID } from "node:crypto";
import { sql } from "kysely";
import { dbNow, isDuplicate, lockingTransaction, withDeadlockRetry, type Db, type Trx } from "../../db/client.js";
import { conflict, forbidden, HttpError, invalid, notFound } from "../../http/errors.js";
import { audit } from "../../shared/audit.js";
import { businessToday } from "../../shared/dates.js";
import { idempotent } from "../../shared/idempotency.js";
import { paiseToRupees, rupeesToPaise } from "../../shared/money.js";
import { enqueueJob } from "../../jobs/runner.js";
import { ProviderRejected } from "../../providers/index.js";
import {
  deliverPasswordLink,
  issuePasswordToken,
  normalizeEmail,
  normalizePhone,
  type Context,
  type SessionUser,
} from "../identity/service.js";
import { confirmHeldAllocation, lockHeldAllocation, releaseHeldAllocation } from "../inventory/allocations.js";

export type LedgerAccount =
  | "cash"
  | "gateway_clearing"
  | "receivable"
  | "rent_income"
  | "other_income"
  | "customer_credit"
  | "deposit_liability"
  | "expense"
  | "refunds";

export interface LedgerLine {
  account: LedgerAccount;
  debit?: number;
  credit?: number;
}

/** Every financial effect goes through here, and a batch that doesn't balance can't be posted. */
export async function postLedger(
  trx: Trx,
  businessId: string,
  source: { type: string; id: string },
  lines: LedgerLine[],
) {
  const debits = lines.reduce((sum, line) => sum + (line.debit ?? 0), 0);
  const credits = lines.reduce((sum, line) => sum + (line.credit ?? 0), 0);
  if (debits !== credits || debits <= 0) throw new Error("Unbalanced ledger batch");
  const batchId = randomUUID();
  await trx
    .insertInto("ledger_entries")
    .values(
      lines.map((line) => ({
        id: randomUUID(),
        business_id: businessId,
        batch_id: batchId,
        account: line.account,
        debit_paise: line.debit ?? 0,
        credit_paise: line.credit ?? 0,
        source_type: source.type,
        source_id: source.id,
      })),
    )
    .execute();
}

export interface NewInvoice {
  businessId: string;
  residentId: string | null;
  corporateId: string | null;
  period: string;
  chargeType: string;
  description: string;
  dueOn: string;
  amountPaise: number;
}

/**
 * The key names who the charge is for rather than who pays, so moving a resident to company
 * billing can't charge the same month twice. Returns the existing invoice when the key is taken.
 */
export async function postInvoice(trx: Trx, input: NewInvoice) {
  const subject = input.residentId ? `resident:${input.residentId}` : `corporate:${input.corporateId}`;
  const billingKey = createHash("sha256").update(`${subject}|${input.period}|${input.chargeType}`).digest("hex");
  const existing = await trx
    .selectFrom("invoices")
    .select("id")
    .where("business_id", "=", input.businessId)
    .where("billing_key", "=", billingKey)
    .executeTakeFirst();
  if (existing) return { id: existing.id, created: false };
  const id = randomUUID();
  await trx
    .insertInto("invoices")
    .values({
      id,
      business_id: input.businessId,
      resident_id: input.residentId,
      corporate_id: input.corporateId,
      period: input.period,
      charge_type: input.chargeType,
      billing_key: billingKey,
      description: input.description,
      due_on: input.dueOn,
      amount_paise: input.amountPaise,
    })
    .execute();
  await trx
    .insertInto("invoice_lines")
    .values({
      id: randomUUID(),
      invoice_id: id,
      kind: input.chargeType,
      description: input.description,
      amount_paise: input.amountPaise,
    })
    .execute();
  await postLedger(trx, input.businessId, { type: "invoice", id }, [
    { account: "receivable", debit: input.amountPaise },
    { account: input.chargeType === "rent" ? "rent_income" : "other_income", credit: input.amountPaise },
  ]);
  return { id, created: true };
}

/** Owner-created invoice. A repeat for the same person, period and description is refused. */
export async function createManualInvoice(
  ctx: Context,
  actor: SessionUser,
  input: { residentId: string; period: string; due: string; amount: number; description: string },
  key: string,
  requestId: string,
) {
  const amountPaise = rupeesToPaise(input.amount);
  return ctx.db.transaction().execute((trx) =>
    idempotent(trx, { actor: actor.id, endpoint: "POST /invoices", key, payload: input }, async () => {
      const resident = await trx
        .selectFrom("resident_profiles")
        .select(["id", "corporate_id"])
        .where("id", "=", input.residentId)
        .where("business_id", "=", actor.businessId)
        .executeTakeFirst();
      if (!resident) throw notFound("This resident");
      // Rent stays recognizable, so the monthly run can't bill the same month again.
      const rent = /^rent\b/i.test(input.description.trim());
      const { id, created } = await postInvoice(trx, {
        businessId: actor.businessId,
        residentId: resident.id,
        corporateId: resident.corporate_id,
        period: input.period,
        chargeType: rent ? "rent" : `manual:${input.description.trim().toLowerCase().slice(0, 24)}`,
        description: input.description.trim(),
        dueOn: input.due,
        amountPaise,
      });
      if (!created) throw conflict("This invoice already exists for the billing period.");
      await audit(trx, {
        businessId: actor.businessId,
        actorUserId: actor.id,
        action: "invoice.created",
        entityType: "invoice",
        entityId: id,
        requestId,
      });
      return { id };
    }),
  );
}

async function applyToInvoice(trx: Trx, paymentId: string, invoiceId: string, amountPaise: number) {
  const invoice = await trx
    .selectFrom("invoices")
    .select(["amount_paise", "paid_paise", "status"])
    .where("id", "=", invoiceId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const paid = Number(invoice.paid_paise) + amountPaise;
  if (invoice.status === "Void" || paid > Number(invoice.amount_paise)) return false;
  await trx
    .updateTable("invoices")
    .set({
      paid_paise: paid,
      status: paid === Number(invoice.amount_paise) ? "Paid" : "Part paid",
      updated_at: dbNow,
    })
    .where("id", "=", invoiceId)
    .execute();
  await trx
    .insertInto("payment_applications")
    .values({ payment_id: paymentId, invoice_id: invoiceId, amount_paise: amountPaise })
    .execute();
  return true;
}

async function queueReceipt(ctx: Context, trx: Trx, invoiceId: string, paymentId: string, amountPaise: number) {
  if (!ctx.providers.whatsapp) return;
  const invoice = await trx.selectFrom("invoices").select("resident_id").where("id", "=", invoiceId).executeTakeFirst();
  if (invoice?.resident_id)
    await enqueueJob(trx, {
      kind: "rule.send",
      dedupeKey: `receipt:${paymentId}`,
      payload: { rule: "paymentReceipt", residentId: invoice.resident_id, params: [String(paiseToRupees(amountPaise))] },
    });
}

/** For the importer: what a resident had already paid against a due carried over from before. */
export async function recordOpeningPayment(trx: Trx, businessId: string, invoiceId: string, amountPaise: number) {
  const paymentId = randomUUID();
  await trx
    .insertInto("payments")
    .values({
      id: paymentId,
      business_id: businessId,
      order_id: null,
      source: "manual",
      method: "Opening balance",
      reference: "Imported",
      provider_payment_id: null,
      amount_paise: amountPaise,
      state: "captured",
      recorded_by: null,
    })
    .execute();
  if (!(await applyToInvoice(trx, paymentId, invoiceId, amountPaise))) throw new Error("Paid is more than the invoice");
  await postLedger(trx, businessId, { type: "payment", id: paymentId }, [
    { account: "cash", debit: amountPaise },
    { account: "receivable", credit: amountPaise },
  ]);
}

/** A receipt the owner saw outside the gateway. It needs a reference, and the actor is recorded. */
export async function recordManualPayment(
  ctx: Context,
  actor: SessionUser,
  input: { invoiceId: string; amount: number; method: string; reference: string },
  key: string,
  requestId: string,
) {
  const amountPaise = rupeesToPaise(input.amount);
  return ctx.db.transaction().execute((trx) =>
    idempotent(trx, { actor: actor.id, endpoint: "POST /payments/manual", key, payload: input }, async () => {
      const invoice = await trx
        .selectFrom("invoices")
        .select("id")
        .where("id", "=", input.invoiceId)
        .where("business_id", "=", actor.businessId)
        .executeTakeFirst();
      if (!invoice) throw notFound("This invoice");
      const paymentId = randomUUID();
      await trx
        .insertInto("payments")
        .values({
          id: paymentId,
          business_id: actor.businessId,
          order_id: null,
          source: "manual",
          method: input.method,
          reference: input.reference,
          provider_payment_id: null,
          amount_paise: amountPaise,
          state: "captured",
          recorded_by: actor.id,
        })
        .execute();
      if (!(await applyToInvoice(trx, paymentId, input.invoiceId, amountPaise)))
        throw invalid("Enter an amount above zero and no higher than the balance.");
      await postLedger(trx, actor.businessId, { type: "payment", id: paymentId }, [
        { account: "cash", debit: amountPaise },
        { account: "receivable", credit: amountPaise },
      ]);
      await queueReceipt(ctx, trx, input.invoiceId, paymentId, amountPaise);
      await audit(trx, {
        businessId: actor.businessId,
        actorUserId: actor.id,
        action: "payment.manual",
        entityType: "payment",
        entityId: paymentId,
        requestId,
        metadata: { method: input.method, amountPaise },
      });
      return { id: paymentId };
    }),
  );
}

export interface HoldCustomer {
  name: string;
  phone: string;
  email: string;
  moveIn: string;
  occupation: string;
}

const NO_PAYMENTS = "Online payments aren't available yet. Please contact the property team.";

/** Calls the provider outside any transaction, then keeps its link so a retry reuses it. */
async function openCheckout(
  ctx: Context,
  order: {
    id: string;
    amountPaise: number;
    description: string;
    expiresInSeconds?: number;
    customer?: { name: string; phone: string; email: string };
  },
) {
  const payments = ctx.providers.payments;
  if (!payments) throw new HttpError(503, NO_PAYMENTS);
  const callbackUrl = `${ctx.frontendUrl}/payment/status?order_id=${order.id}`;
  let link;
  try {
    const { id: referenceId, ...details } = order;
    link = await payments.createPaymentLink({ referenceId, callbackUrl, ...details });
  } catch {
    // The request may have succeeded with its response lost. Never create a second payable link.
    link = await payments.findPaymentLink(order.id).catch(() => null);
    if (!link) throw new HttpError(502, "We couldn't start the payment. Please try again in a minute.");
  }
  await ctx.db
    .updateTable("payment_orders")
    .set({ provider_order_id: link.id, checkout_url: link.url, updated_at: dbNow })
    .where("id", "=", order.id)
    .execute();
  return { orderId: order.id, checkoutUrl: link.url };
}

/** For a prospect's hold. The amount comes from the hold, never from the browser. */
export async function createHoldOrder(ctx: Context, businessId: string, holdId: string, customer: HoldCustomer) {
  if (!ctx.providers.payments) throw new HttpError(503, NO_PAYMENTS);
  const safeCustomer = {
    ...customer,
    phone: normalizePhone(customer.phone),
    email: normalizeEmail(customer.email),
  };
  const order = await ctx.db.transaction().execute(async (trx) => {
    const hold = await trx
      .selectFrom("holds")
      .select(["id", "amount_paise", "state", sql<number>`expires_at > UTC_TIMESTAMP(6)`.as("live")])
      .where("id", "=", holdId)
      .where("business_id", "=", businessId)
      .forUpdate()
      .executeTakeFirst();
    if (!hold) throw notFound("This hold");
    if (hold.state !== "active" || !hold.live)
      throw conflict("This hold has expired. Please choose your room again.");
    const existing = await trx
      .selectFrom("payment_orders")
      .select(["id", "amount_paise", "checkout_url"])
      .where("hold_id", "=", holdId)
      .executeTakeFirst();
    if (existing) return { id: existing.id, amountPaise: Number(existing.amount_paise), url: existing.checkout_url };
    const id = randomUUID();
    await trx
      .insertInto("payment_orders")
      .values({
        id,
        business_id: businessId,
        hold_id: holdId,
        invoice_id: null,
        amount_paise: hold.amount_paise,
        provider_order_id: null,
        checkout_url: null,
        customer: JSON.stringify(safeCustomer),
      })
      .execute();
    return { id, amountPaise: Number(hold.amount_paise), url: null };
  });
  if (order.url) return { orderId: order.id, checkoutUrl: order.url };
  return openCheckout(ctx, {
    id: order.id,
    amountPaise: order.amountPaise,
    description: "Sehrawat PG booking",
    // Razorpay refuses anything under 15 minutes, so a link can outlive its hold. Payment made
    // in that gap goes to review and never displaces anyone.
    expiresInSeconds: 20 * 60,
    customer: safeCustomer,
  });
}

/** For an invoice the caller may see. The amount is its current balance. */
export async function createInvoiceOrder(ctx: Context, user: SessionUser, invoiceId: string) {
  if (!ctx.providers.payments) throw new HttpError(503, NO_PAYMENTS);
  const invoice = await ctx.db
    .selectFrom("invoices")
    .select(["id", "resident_id", "corporate_id", "amount_paise", "paid_paise", "status", "description"])
    .where("id", "=", invoiceId)
    .where("business_id", "=", user.businessId)
    .executeTakeFirst();
  if (!invoice) throw notFound("This invoice");
  assertInvoiceAccess(user, invoice);
  const balance = Number(invoice.amount_paise) - Number(invoice.paid_paise);
  if (balance <= 0 || invoice.status === "Void") throw conflict("This invoice has nothing left to pay.");
  const open = await ctx.db
    .selectFrom("payment_orders")
    .select(["id", "checkout_url"])
    .where("invoice_id", "=", invoiceId)
    .where("status", "=", "pending")
    .where("amount_paise", "=", balance)
    .executeTakeFirst();
  if (open?.checkout_url) return { orderId: open.id, checkoutUrl: open.checkout_url };
  const id = open?.id ?? randomUUID();
  if (!open)
    await ctx.db
      .insertInto("payment_orders")
      .values({
        id,
        business_id: user.businessId,
        hold_id: null,
        invoice_id: invoiceId,
        amount_paise: balance,
        provider_order_id: null,
        checkout_url: null,
        customer: null,
      })
      .execute();
  return openCheckout(ctx, { id, amountPaise: balance, description: invoice.description });
}

function assertInvoiceAccess(user: SessionUser, invoice: { resident_id: string | null; corporate_id: string | null }) {
  if (user.role === "owner") return;
  if (user.role === "corporate" && user.corporateId && invoice.corporate_id === user.corporateId) return;
  // Company-billed invoices are for the company to pay, not the resident.
  if (user.role === "resident" && user.residentId && invoice.resident_id === user.residentId && !invoice.corporate_id)
    return;
  throw forbidden();
}

/** A hold's order is reached only through its unguessable ID. An invoice's also checks the caller. */
export async function paymentStatus(ctx: Context, businessId: string, orderId: string, user: SessionUser | null) {
  const order = await ctx.db
    .selectFrom("payment_orders as o")
    .leftJoin("invoices as i", "i.id", "o.invoice_id")
    .select(["o.status", "o.invoice_id", "i.resident_id", "i.corporate_id"])
    .where("o.id", "=", orderId)
    .where("o.business_id", "=", businessId)
    .executeTakeFirst();
  if (!order) throw notFound("This payment");
  if (order.invoice_id) {
    if (!user) throw new HttpError(401, "Please sign in to continue.");
    assertInvoiceAccess(user, order);
  }
  return { status: order.status };
}

export interface Capture {
  orderId: string;
  providerPaymentId: string;
  amountPaise: number;
  currency: string;
}

type Delivery = { email: string; name: string; token: string } | null;

/**
 * The one place captured money becomes business state, from a webhook or the reconciliation job.
 * The provider ID is unique, so duplicate and out-of-order events can't credit twice, and a booking
 * only confirms if its hold is still live: late money goes to review and never displaces anyone.
 */
export async function applyCapture(ctx: Context, capture: Capture) {
  try {
    await captureOnce(ctx, capture);
  } catch (e) {
    // Rolled back in full. If the cause was a duplicate of this very payment, it's already recorded.
    // Anything else, such as a clash on a new account, must retry rather than lose the money.
    if (!isDuplicate(e)) throw e;
    const recorded = await ctx.db
      .selectFrom("payments")
      .select("id")
      .where("provider_payment_id", "=", capture.providerPaymentId)
      .executeTakeFirst();
    if (!recorded) throw e;
  }
}

async function captureOnce(ctx: Context, capture: Capture) {
  const delivery = await withDeadlockRetry(() =>
    lockingTransaction(ctx.db, async (trx): Promise<Delivery> => {
      const order = await trx
        .selectFrom("payment_orders")
        .selectAll()
        .where("id", "=", capture.orderId)
        .executeTakeFirst();
      if (!order) throw new Error("Capture for an unknown order");
      // Beds lock first, matching the common lock order.
      const allocation = order.hold_id ? await lockHeldAllocation(trx, order.hold_id) : null;
      const locked = await trx
        .selectFrom("payment_orders")
        .select("status")
        .where("id", "=", order.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const paymentId = randomUUID();
      const matches = capture.amountPaise === Number(order.amount_paise) && capture.currency === order.currency;
      const insertPayment = (state: "captured" | "review") =>
        trx
          .insertInto("payments")
          .values({
            id: paymentId,
            business_id: order.business_id,
            order_id: order.id,
            source: "razorpay",
            method: "Online",
            reference: capture.providerPaymentId,
            provider_payment_id: capture.providerPaymentId,
            amount_paise: capture.amountPaise,
            state,
            recorded_by: null,
          })
          .execute();
      const review = async () => {
        await insertPayment("review");
        await postLedger(trx, order.business_id, { type: "payment", id: paymentId }, [
          { account: "gateway_clearing", debit: capture.amountPaise },
          { account: "customer_credit", credit: capture.amountPaise },
        ]);
        await trx
          .updateTable("payment_orders")
          .set({ status: "review", updated_at: dbNow })
          .where("id", "=", order.id)
          .where("status", "!=", "confirmed")
          .execute();
        await audit(trx, {
          businessId: order.business_id,
          actorUserId: null,
          action: "payment.review",
          entityType: "payment",
          entityId: paymentId,
        });
        return null;
      };
      {
        const seen = await trx
          .selectFrom("payments")
          .select("id")
          .where("provider_payment_id", "=", capture.providerPaymentId)
          .executeTakeFirst();
        if (seen) return null;
        if (!matches || locked.status === "confirmed") {
          if (allocation?.state === "held" && !matches) await releaseHeldAllocation(trx, allocation);
          return await review();
        }

        if (order.invoice_id) {
          await insertPayment("captured");
          if (!(await applyToInvoice(trx, paymentId, order.invoice_id, capture.amountPaise))) {
            await trx.updateTable("payments").set({ state: "review" }).where("id", "=", paymentId).execute();
            await postLedger(trx, order.business_id, { type: "payment", id: paymentId }, [
              { account: "gateway_clearing", debit: capture.amountPaise },
              { account: "customer_credit", credit: capture.amountPaise },
            ]);
            await trx
              .updateTable("payment_orders")
              .set({ status: "review", updated_at: dbNow })
              .where("id", "=", order.id)
              .execute();
            return null;
          }
          await postLedger(trx, order.business_id, { type: "payment", id: paymentId }, [
            { account: "gateway_clearing", debit: capture.amountPaise },
            { account: "receivable", credit: capture.amountPaise },
          ]);
          await trx
            .updateTable("payment_orders")
            .set({ status: "confirmed", updated_at: dbNow })
            .where("id", "=", order.id)
            .execute();
          await queueReceipt(ctx, trx, order.invoice_id, paymentId, capture.amountPaise);
          return null;
        }

        if (!allocation?.live || allocation.state !== "held") {
          if (allocation) await releaseHeldAllocation(trx, allocation);
          return await review();
        }
        const customer = order.customer as HoldCustomer | null;
        const account = customer ? await claimResidentAccount(trx, order.business_id, customer) : null;
        if (!account) {
          await releaseHeldAllocation(trx, allocation);
          return await review();
        }
        const residentId = randomUUID();
        await trx
          .insertInto("resident_profiles")
          .values({
            id: residentId,
            business_id: order.business_id,
            user_id: account.userId,
            corporate_id: null,
            property_id: allocation.propertyId,
            room_label: allocation.roomLabel,
            monthly_rent_paise: allocation.rentPaise,
            status: "Active",
            joined_on: allocation.stayStart,
          })
          .execute();
        await confirmHeldAllocation(trx, allocation, residentId);
        await insertPayment("captured");
        const { id: invoiceId } = await postInvoice(trx, {
          businessId: order.business_id,
          residentId,
          corporateId: null,
          period: allocation.stayStart.slice(0, 7),
          chargeType: "rent",
          description: "Rent, first month (paid at booking)",
          dueOn: allocation.stayStart,
          amountPaise: capture.amountPaise,
        });
        await applyToInvoice(trx, paymentId, invoiceId, capture.amountPaise);
        await postLedger(trx, order.business_id, { type: "payment", id: paymentId }, [
          { account: "gateway_clearing", debit: capture.amountPaise },
          { account: "receivable", credit: capture.amountPaise },
        ]);
        await trx
          .updateTable("payment_orders")
          .set({ status: "confirmed", updated_at: dbNow })
          .where("id", "=", order.id)
          .execute();
        await audit(trx, {
          businessId: order.business_id,
          actorUserId: null,
          action: "booking.confirmed",
          entityType: "booking",
          entityId: allocation.bookingId,
        });
        if (ctx.providers.whatsapp)
          await enqueueJob(trx, {
            kind: "rule.send",
            dedupeKey: `welcome:${residentId}`,
            payload: { rule: "moveInWelcome", residentId, params: [customer!.name, allocation.stayStart] },
          });
        return account.token ? { email: customer!.email, name: customer!.name, token: account.token } : null;
      }
    }),
  );
  if (delivery) deliverPasswordLink(ctx, delivery, "invite", delivery.token);
}

/**
 * Same rule as the owner adding a resident: paying for a bed doesn't prove an email, so an unproven
 * self-service account loses its way in. Returns null when this contact can't become this resident.
 */
async function claimResidentAccount(trx: Trx, businessId: string, customer: HoldCustomer) {
  const matches = await trx
    .selectFrom("users as u")
    .leftJoin("resident_profiles as r", "r.user_id", "u.id")
    .select(["u.id", "u.role", "u.status", "u.email", "u.email_verified_at", "r.id as resident_id"])
    .where("u.business_id", "=", businessId)
    .where((eb) => eb.or([eb("u.email", "=", customer.email), eb("u.phone", "=", customer.phone)]))
    .forUpdate()
    .execute();
  if (matches.length > 1) return null;
  const existing = matches[0];
  if (existing) {
    if (existing.role !== "resident" || existing.resident_id || existing.status === "disabled") return null;
    if (existing.email !== customer.email) return null;
    if (existing.email_verified_at) {
      await trx
        .updateTable("users")
        .set({ phone: customer.phone, updated_at: dbNow })
        .where("id", "=", existing.id)
        .execute();
      return { userId: existing.id, token: null };
    }
    await trx
      .updateTable("users")
      .set({ name: customer.name, phone: customer.phone, password_hash: null, status: "invited", updated_at: dbNow })
      .where("id", "=", existing.id)
      .execute();
    await trx
      .updateTable("sessions")
      .set({ revoked_at: dbNow })
      .where("user_id", "=", existing.id)
      .where("revoked_at", "is", null)
      .execute();
    await trx.deleteFrom("google_identities").where("user_id", "=", existing.id).execute();
    return { userId: existing.id, token: await issuePasswordToken(trx, existing.id, "invite") };
  }
  const userId = randomUUID();
  await trx
    .insertInto("users")
    .values({
      id: userId,
      business_id: businessId,
      role: "resident",
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
      password_hash: null,
    })
    .execute();
  return { userId, token: await issuePasswordToken(trx, userId, "invite") };
}

/** Compares unresolved orders with the provider, because a webhook can be missed entirely. */
export async function reconcileOrders(ctx: Context, limit = 25) {
  const payments = ctx.providers.payments;
  if (!payments) return 0;
  const open = await ctx.db
    .selectFrom("payment_orders")
    .select(["id", "provider_order_id", "created_at"])
    .where("status", "in", ["pending", "processing"])
    .where("provider_order_id", "is not", null)
    .where("created_at", "<", sql<Date>`UTC_TIMESTAMP(6) - INTERVAL 5 MINUTE`)
    .where("created_at", ">", sql<Date>`UTC_TIMESTAMP(6) - INTERVAL 7 DAY`)
    .orderBy("created_at")
    .limit(limit)
    .execute();
  for (const order of open) {
    const link = await payments.fetchPaymentLink(order.provider_order_id!);
    for (const payment of link.payments)
      if (payment.captured)
        await applyCapture(ctx, {
          orderId: order.id,
          providerPaymentId: payment.id,
          amountPaise: payment.amountPaise,
          currency: payment.currency,
        });
    if (["expired", "cancelled"].includes(link.status) && !link.payments.some((p) => p.captured))
      await ctx.db
        .updateTable("payment_orders")
        .set({ status: "failed", updated_at: dbNow })
        .where("id", "=", order.id)
        .where("status", "in", ["pending", "processing"])
        .execute();
  }
  return open.length;
}

/**
 * Creates a pending refund and queues the provider call. Only the provider's confirmation marks it
 * refunded. The balance is checked under a lock on the payment, so two requests can't both pass.
 */
export async function requestRefund(
  ctx: Context,
  actor: SessionUser,
  input: { paymentId: string; amount: number; reason: string },
  key: string,
  requestId: string,
) {
  if (!ctx.providers.payments) throw new HttpError(503, NO_PAYMENTS);
  const amountPaise = rupeesToPaise(input.amount);
  return ctx.db.transaction().execute((trx) =>
    idempotent(trx, { actor: actor.id, endpoint: "POST /refunds", key, payload: input }, async () => {
      const payment = await trx
        .selectFrom("payments")
        .select(["id", "source", "amount_paise", "provider_payment_id"])
        .where("business_id", "=", actor.businessId)
        .where((eb) =>
          eb.or([eb("provider_payment_id", "=", input.paymentId), eb("id", "=", input.paymentId)]),
        )
        .forUpdate()
        .executeTakeFirst();
      if (!payment) throw notFound("This payment");
      if (payment.source !== "razorpay" || !payment.provider_payment_id)
        throw invalid("Only online payments can be refunded here. Record cash or bank refunds as an expense.");
      const row = await trx
        .selectFrom("refunds")
        .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("amount_paise"), sql<number>`0`).as("total"))
        .where("payment_id", "=", payment.id)
        .where("state", "!=", "Failed")
        .executeTakeFirstOrThrow();
      if (Number(row.total) + amountPaise > Number(payment.amount_paise))
        throw invalid("This is more than the payment's refundable balance.");
      const id = randomUUID();
      await trx
        .insertInto("refunds")
        .values({
          id,
          business_id: actor.businessId,
          payment_id: payment.id,
          amount_paise: amountPaise,
          reason: input.reason,
          provider_refund_id: null,
          requested_by: actor.id,
        })
        .execute();
      await enqueueJob(trx, { kind: "refund.send", dedupeKey: id, payload: { refundId: id } });
      await audit(trx, {
        businessId: actor.businessId,
        actorUserId: actor.id,
        action: "refund.requested",
        entityType: "refund",
        entityId: id,
        requestId,
        metadata: { amountPaise },
      });
      return { id };
    }),
  );
}

/**
 * The refund's ID is the receipt, which Razorpay won't accept twice on a payment. The row moves to
 * Review before the call and only a clear answer moves it on, so a lost response or a crash waits
 * for the provider's webhook, and a "duplicate receipt" refusal can never read as a failed refund.
 */
export async function sendRefund(ctx: Context, refundId: string) {
  const payments = ctx.providers.payments;
  if (!payments) throw new Error("Payments are not configured");
  const refund = await ctx.db
    .selectFrom("refunds as f")
    .innerJoin("payments as p", "p.id", "f.payment_id")
    .select(["f.id", "f.state", "f.amount_paise", "f.provider_refund_id", "p.provider_payment_id"])
    .where("f.id", "=", refundId)
    .executeTakeFirstOrThrow();
  if (refund.provider_refund_id || refund.state !== "Pending") return;
  const claimed = await ctx.db
    .updateTable("refunds")
    .set({ state: "Review", updated_at: dbNow })
    .where("id", "=", refundId)
    .where("state", "=", "Pending")
    .executeTakeFirst();
  if (!claimed.numUpdatedRows) return;
  let result;
  try {
    result = await payments.refund({
      paymentId: refund.provider_payment_id!,
      amountPaise: Number(refund.amount_paise),
      receipt: refund.id,
    });
  } catch (e) {
    if (e instanceof ProviderRejected)
      await ctx.db.updateTable("refunds").set({ state: "Failed", updated_at: dbNow }).where("id", "=", refundId).execute();
    else ctx.log.error({ refundId }, "A refund has an unknown outcome and needs review");
    return;
  }
  await ctx.db
    .updateTable("refunds")
    .set({ state: "Pending", provider_refund_id: result.id, updated_at: dbNow })
    .where("id", "=", refundId)
    .where("state", "=", "Review")
    .execute();
  if (result.status === "processed") await settleRefund(ctx, { providerRefundId: result.id, receipt: refundId }, "processed");
}

export async function settleRefund(
  ctx: Context,
  ids: { providerRefundId: string; receipt?: string },
  outcome: "processed" | "failed",
) {
  await ctx.db.transaction().execute(async (trx) => {
    const refund = await trx
      .selectFrom("refunds")
      .select(["id", "business_id", "state", "amount_paise"])
      .where((eb) =>
        eb.or([
          eb("provider_refund_id", "=", ids.providerRefundId),
          ...(ids.receipt ? [eb("id", "=", ids.receipt)] : []),
        ]),
      )
      .forUpdate()
      .executeTakeFirst();
    // A terminal state never regresses, whichever order the events arrive in.
    if (!refund || refund.state === "Refunded" || refund.state === "Failed") return;
    await trx
      .updateTable("refunds")
      .set({
        state: outcome === "processed" ? "Refunded" : "Failed",
        provider_refund_id: ids.providerRefundId,
        updated_at: dbNow,
      })
      .where("id", "=", refund.id)
      .execute();
    if (outcome === "processed")
      await postLedger(trx, refund.business_id, { type: "refund", id: refund.id }, [
        { account: "refunds", debit: Number(refund.amount_paise) },
        { account: "gateway_clearing", credit: Number(refund.amount_paise) },
      ]);
  });
}

/** Handles one saved webhook. Everything it calls is idempotent, so a rerun changes nothing. */
export async function processRazorpayEvent(ctx: Context, payload: unknown) {
  const event = payload as {
    event?: string;
    payload?: {
      payment_link?: { entity?: { reference_id?: string } };
      payment?: { entity?: { id?: string; amount?: number; currency?: string; status?: string } };
      refund?: { entity?: { id?: string; receipt?: string | null } };
    };
  };
  const reference = event.payload?.payment_link?.entity?.reference_id;
  if (event.event === "payment_link.paid") {
    const payment = event.payload?.payment?.entity;
    if (!reference || !payment?.id || payment.status !== "captured") return;
    const order = await ctx.db.selectFrom("payment_orders").select("id").where("id", "=", reference).executeTakeFirst();
    if (!order) return;
    await applyCapture(ctx, {
      orderId: order.id,
      providerPaymentId: payment.id,
      amountPaise: Number(payment.amount),
      currency: payment.currency ?? "",
    });
  } else if (event.event === "payment_link.expired" || event.event === "payment_link.cancelled") {
    if (reference)
      await ctx.db
        .updateTable("payment_orders")
        .set({ status: "failed", updated_at: dbNow })
        .where("id", "=", reference)
        .where("status", "in", ["pending", "processing"])
        .execute();
  } else if (event.event === "refund.processed" || event.event === "refund.failed") {
    const refund = event.payload?.refund?.entity;
    if (refund?.id)
      await settleRefund(
        ctx,
        { providerRefundId: refund.id, ...(refund.receipt ? { receipt: refund.receipt } : {}) },
        event.event === "refund.processed" ? "processed" : "failed",
      );
  }
}

export async function createExpense(
  ctx: Context,
  actor: SessionUser,
  input: { category: string; description: string; amount: number; date: string },
  key: string,
  requestId: string,
) {
  const amountPaise = rupeesToPaise(input.amount);
  return ctx.db.transaction().execute((trx) =>
    idempotent(trx, { actor: actor.id, endpoint: "POST /expenses", key, payload: input }, async () => {
      const id = randomUUID();
      await trx
        .insertInto("expenses")
        .values({
          id,
          business_id: actor.businessId,
          category: input.category,
          description: input.description,
          amount_paise: amountPaise,
          spent_on: input.date,
          recorded_by: actor.id,
        })
        .execute();
      await postLedger(trx, actor.businessId, { type: "expense", id }, [
        { account: "expense", debit: amountPaise },
        { account: "cash", credit: amountPaise },
      ]);
      await audit(trx, {
        businessId: actor.businessId,
        actorUserId: actor.id,
        action: "expense.created",
        entityType: "expense",
        entityId: id,
        requestId,
        metadata: { amountPaise },
      });
      return { id };
    }),
  );
}

/**
 * Bills every current resident once per period, only after the owner turns billing on, because
 * proration and late fees are still undecided. Retrying returns existing invoices.
 */
export async function runMonthlyBilling(db: Db, businessId: string, rentDay: number, period = businessToday().slice(0, 7)) {
  const residents = await db
    .selectFrom("resident_profiles")
    .select(["id", "corporate_id", "monthly_rent_paise", "joined_on"])
    .where("business_id", "=", businessId)
    .where("status", "in", ["Active", "Notice"])
    // Someone who joined mid-month gets a manual invoice for now, because proration is undecided.
    .where("joined_on", "<=", `${period}-01`)
    .execute();
  let created = 0;
  for (const resident of residents) {
    const made = await db.transaction().execute((trx) =>
      postInvoice(trx, {
        businessId,
        residentId: resident.id,
        corporateId: resident.corporate_id,
        period,
        chargeType: "rent",
        description: `Rent for ${period}`,
        dueOn: `${period}-${String(rentDay).padStart(2, "0")}`,
        amountPaise: Number(resident.monthly_rent_paise),
      }),
    );
    if (made.created) created++;
  }
  return created;
}

export const invoiceToApi = (i: {
  id: string;
  resident_id: string | null;
  corporate_id: string | null;
  period: string;
  due_on: string;
  amount_paise: number;
  paid_paise: number;
  status: string;
  description: string;
}) => ({
  id: i.id,
  residentId: i.resident_id ?? "",
  ...(i.corporate_id ? { corporateId: i.corporate_id } : {}),
  period: i.period,
  due: i.due_on,
  amount: paiseToRupees(Number(i.amount_paise)),
  paid: paiseToRupees(Number(i.paid_paise)),
  status: i.status,
  description: i.description,
});
