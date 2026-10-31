import { randomUUID } from "node:crypto";
import { dbNow, type Db, type Trx } from "../../db/client.js";
import { conflict, forbidden, invalid, notFound } from "../../http/errors.js";
import { audit } from "../../shared/audit.js";
import { idempotent } from "../../shared/idempotency.js";
import { paiseToRupees } from "../../shared/money.js";
import { enqueueJob } from "../../jobs/runner.js";
import type { Context, SessionUser } from "../identity/service.js";

export interface Settings {
  businessName?: string;
  rentDay: number;
  billingEnabled: boolean;
  campaignRecipientCap: number;
  mealMenu?: Partial<Record<string, { breakfast: string; lunch: string; dinner: string }>>;
  rentReminder?: boolean;
  paymentReceipt?: boolean;
  moveInWelcome?: boolean;
  complaintUpdate?: boolean;
  agreementReminder?: boolean;
}

// Billing stays off until the owner has confirmed the billing rules.
const DEFAULTS: Settings = { rentDay: 5, billingEnabled: false, campaignRecipientCap: 250 };

export async function getSettings(db: Db | Trx, businessId: string): Promise<Settings> {
  const row = await db
    .selectFrom("business_settings")
    .select("settings")
    .where("business_id", "=", businessId)
    .executeTakeFirst();
  return { ...DEFAULTS, ...(row?.settings as Partial<Settings> | undefined) };
}

export const residentSafeSettings = (s: Settings) => ({
  rentDay: s.rentDay,
  ...(s.businessName ? { businessName: s.businessName } : {}),
  ...(s.mealMenu ? { mealMenu: s.mealMenu } : {}),
});

/** Merges under a row lock, so two tabs saving different settings can't undo each other. */
export async function saveSettings(ctx: Context, actor: SessionUser, changes: Partial<Settings>, requestId: string) {
  const keys = Object.keys(changes);
  if (!keys.length) throw invalid("Nothing to update.");
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto("business_settings")
      .ignore()
      .values({ business_id: actor.businessId, settings: "{}" })
      .execute();
    const row = await trx
      .selectFrom("business_settings")
      .select("settings")
      .where("business_id", "=", actor.businessId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await trx
      .updateTable("business_settings")
      .set({ settings: JSON.stringify({ ...(row.settings as object), ...changes }), updated_at: dbNow })
      .where("business_id", "=", actor.businessId)
      .execute();
    await audit(trx, {
      businessId: actor.businessId,
      actorUserId: actor.id,
      action: "settings.updated",
      entityType: "settings",
      entityId: actor.businessId,
      requestId,
      metadata: { keys },
    });
  });
}

const iso = (d: Date) => d.toISOString();

export async function listTickets(db: Db, businessId: string, residentId?: string) {
  let query = db.selectFrom("tickets").selectAll().where("business_id", "=", businessId).orderBy("created_at", "desc");
  if (residentId) query = query.where("resident_id", "=", residentId);
  return (await query.execute()).map((t) => ({
    id: t.id,
    residentId: t.resident_id,
    subject: t.subject,
    category: t.category,
    description: t.description,
    status: t.status,
    priority: t.priority,
    created: iso(t.created_at),
    assignee: t.assignee,
  }));
}

export interface TicketInput {
  subject: string;
  category: string;
  priority: string;
  description: string;
}

export async function createTicket(
  ctx: Context,
  user: SessionUser,
  input: TicketInput & { residentId?: string },
  key: string,
) {
  // A resident's ticket is always their own, whatever the request names.
  const residentId = user.role === "resident" ? user.residentId : input.residentId;
  if (!residentId) throw invalid("Choose a resident for this request.");
  const { residentId: _ignored, ...fields } = input;
  return ctx.db.transaction().execute((trx) =>
    idempotent(trx, { actor: user.id, endpoint: "POST /tickets", key, payload: input }, async () => {
      const resident = await trx
        .selectFrom("resident_profiles")
        .select("id")
        .where("id", "=", residentId)
        .where("business_id", "=", user.businessId)
        .executeTakeFirst();
      if (!resident) throw notFound("This resident");
      const id = randomUUID();
      await trx
        .insertInto("tickets")
        .values({ id, business_id: user.businessId, resident_id: residentId, ...fields })
        .execute();
      return { id };
    }),
  );
}

export async function updateTicket(
  ctx: Context,
  user: SessionUser,
  id: string,
  changes: Partial<TicketInput> & { status?: "Open" | "In progress" | "Resolved"; assignee?: string },
) {
  const ticket = await ctx.db
    .selectFrom("tickets")
    .select(["resident_id", "status"])
    .where("id", "=", id)
    .where("business_id", "=", user.businessId)
    .executeTakeFirst();
  if (!ticket) throw notFound("This request");
  if (user.role !== "owner" && ticket.resident_id !== user.residentId) throw forbidden();
  // Only the owner moves a ticket along, so a resident's edit carries their own text and no more.
  const { status, assignee, priority, ...text } = changes;
  const allowed = user.role === "owner" ? changes : text;
  if (!Object.keys(allowed).length) return;
  await ctx.db
    .updateTable("tickets")
    .set({ ...allowed, updated_at: dbNow })
    .where("id", "=", id)
    .execute();
  if (user.role === "owner" && status && status !== ticket.status && ctx.providers.whatsapp)
    await enqueueJob(ctx.db, {
      kind: "rule.send",
      dedupeKey: `complaint:${id}:${status}`,
      payload: { rule: "complaintUpdate", residentId: ticket.resident_id, params: [status] },
    });
}

export async function listLeads(db: Db, businessId: string) {
  const rows = await db
    .selectFrom("leads")
    .selectAll()
    .where("business_id", "=", businessId)
    .orderBy("created_at", "desc")
    .limit(1000)
    .execute();
  return rows.map((l) => ({
    id: l.id,
    name: l.name,
    phone: l.phone,
    email: l.email,
    propertyId: l.property_id ?? "",
    date: l.visit_on ?? "",
    status: l.status,
    notes: l.notes,
    kind: l.kind,
  }));
}

export interface LeadInput {
  name: string;
  phone: string;
  email: string;
  propertyId: string;
  date: string;
  kind: string;
  notes: string;
  status: "New" | "Contacted" | "Visit scheduled" | "Converted" | "Closed";
}

async function leadProperty(db: Db, businessId: string, propertyId: string) {
  if (!propertyId) return null;
  const property = await db
    .selectFrom("properties")
    .select("id")
    .where("id", "=", propertyId)
    .where("business_id", "=", businessId)
    .executeTakeFirst();
  if (!property) throw invalid("Choose one of the listed homes.");
  return property.id;
}

export async function createLead(ctx: Context, businessId: string, input: LeadInput, ownerAdded: boolean) {
  const id = randomUUID();
  await ctx.db
    .insertInto("leads")
    .values({
      id,
      business_id: businessId,
      property_id: await leadProperty(ctx.db, businessId, input.propertyId),
      kind: input.kind,
      name: input.name,
      phone: input.phone,
      email: input.email,
      visit_on: input.date || null,
      // The public can't choose a lead's place in the owner's pipeline.
      status: ownerAdded ? input.status : "New",
      notes: input.notes,
    })
    .execute();
  return { id };
}

export async function updateLead(ctx: Context, businessId: string, id: string, input: Partial<LeadInput>) {
  const { propertyId, date, ...rest } = input;
  const result = await ctx.db
    .updateTable("leads")
    .set({
      ...rest,
      ...(propertyId !== undefined ? { property_id: await leadProperty(ctx.db, businessId, propertyId) } : {}),
      ...(date !== undefined ? { visit_on: date || null } : {}),
      updated_at: dbNow,
    })
    .where("id", "=", id)
    .where("business_id", "=", businessId)
    .executeTakeFirst();
  if (!result.numUpdatedRows) throw notFound("This lead");
}

export async function createRequest(
  ctx: Context,
  user: SessionUser,
  type: "referrals" | "move-outs" | "housing-requests",
  input: { residentId?: string; corporateId?: string; details: Record<string, unknown> },
  key: string,
) {
  // Membership comes from the session. An ID in the body must agree with it, or it's someone else's.
  if (user.role === "resident" && input.residentId && input.residentId !== user.residentId) throw forbidden();
  if (user.role === "corporate" && input.corporateId && input.corporateId !== user.corporateId) throw forbidden();
  const residentId = user.role === "resident" ? user.residentId : user.role === "owner" ? input.residentId : undefined;
  const corporateId = user.role === "corporate" ? user.corporateId : user.role === "owner" ? input.corporateId : undefined;
  if (type === "housing-requests" ? !corporateId : !residentId) throw forbidden();
  return ctx.db.transaction().execute((trx) =>
    idempotent(trx, { actor: user.id, endpoint: `POST /${type}`, key, payload: input }, async () => {
      if (type === "move-outs") {
        const open = await trx
          .selectFrom("service_requests")
          .select("id")
          .where("resident_id", "=", residentId!)
          .where("type", "=", "move-outs")
          .where("status", "=", "Requested")
          .executeTakeFirst();
        if (open) throw conflict("A move-out request is already open.");
      }
      const id = randomUUID();
      await trx
        .insertInto("service_requests")
        .values({
          id,
          business_id: user.businessId,
          type,
          resident_id: residentId ?? null,
          corporate_id: corporateId ?? null,
          details: JSON.stringify(input.details),
        })
        .execute();
      await audit(trx, {
        businessId: user.businessId,
        actorUserId: user.id,
        action: `${type}.created`,
        entityType: "service_request",
        entityId: id,
      });
      return { id };
    }),
  );
}

export async function listRequests(db: Db, businessId: string, scope: { residentId?: string; corporateId?: string }) {
  let query = db
    .selectFrom("service_requests")
    .selectAll()
    .where("business_id", "=", businessId)
    .orderBy("created_at", "desc")
    .limit(1000);
  if (scope.residentId) query = query.where("resident_id", "=", scope.residentId);
  if (scope.corporateId) query = query.where("corporate_id", "=", scope.corporateId);
  return (await query.execute()).map((r) => ({
    ...(r.details as object),
    id: r.id,
    type: r.type,
    status: r.status,
    created: iso(r.created_at),
    ...(r.resident_id ? { residentId: r.resident_id } : {}),
    ...(r.corporate_id ? { corporateId: r.corporate_id } : {}),
  }));
}

export async function listRefundRequests(db: Db, businessId: string) {
  const rows = await db
    .selectFrom("refunds as f")
    .innerJoin("payments as p", "p.id", "f.payment_id")
    .select(["f.id", "f.amount_paise", "f.reason", "f.state", "f.created_at", "p.provider_payment_id"])
    .where("f.business_id", "=", businessId)
    .orderBy("f.created_at", "desc")
    .limit(500)
    .execute();
  return rows.map((r) => ({
    id: r.id,
    type: "refunds",
    paymentId: r.provider_payment_id ?? "",
    amount: paiseToRupees(Number(r.amount_paise)),
    reason: r.reason,
    status: r.state,
    created: iso(r.created_at),
  }));
}

export async function listPayments(db: Db, businessId: string) {
  const rows = await db
    .selectFrom("payments")
    .selectAll()
    .where("business_id", "=", businessId)
    .orderBy("created_at", "desc")
    .limit(1000)
    .execute();
  return rows.map((p) => ({
    id: p.id,
    reference: p.reference,
    method: p.method,
    source: p.source,
    amount: paiseToRupees(Number(p.amount_paise)),
    status: p.state,
    created: iso(p.created_at),
  }));
}

export async function listExpenses(db: Db, businessId: string) {
  const rows = await db
    .selectFrom("expenses")
    .selectAll()
    .where("business_id", "=", businessId)
    .orderBy("spent_on", "desc")
    .limit(2000)
    .execute();
  return rows.map((e) => ({
    id: e.id,
    category: e.category,
    description: e.description,
    amount: paiseToRupees(Number(e.amount_paise)),
    date: e.spent_on,
  }));
}

export async function listInvoices(db: Db, businessId: string, scope: { residentId?: string; corporateId?: string }) {
  let query = db
    .selectFrom("invoices")
    .selectAll()
    .where("business_id", "=", businessId)
    .where("status", "!=", "Void")
    .orderBy("due_on", "desc")
    .limit(5000);
  if (scope.residentId) query = query.where("resident_id", "=", scope.residentId);
  if (scope.corporateId) query = query.where("corporate_id", "=", scope.corporateId);
  return (await query.execute()).map((i) => ({
    id: i.id,
    residentId: i.resident_id ?? "",
    ...(i.corporate_id ? { corporateId: i.corporate_id } : {}),
    period: i.period,
    due: i.due_on,
    amount: paiseToRupees(Number(i.amount_paise)),
    paid: paiseToRupees(Number(i.paid_paise)),
    status: i.status,
    description: i.description,
  }));
}

/** A company sees where its people stay, derived from their profiles. */
export async function listAllocations(db: Db, businessId: string, corporateId?: string) {
  let query = db
    .selectFrom("resident_profiles as r")
    .innerJoin("users as u", "u.id", "r.user_id")
    .select(["r.id", "r.corporate_id", "u.name", "r.property_id", "r.room_label", "r.joined_on", "r.status"])
    .where("r.business_id", "=", businessId)
    .where("r.corporate_id", "is not", null);
  if (corporateId) query = query.where("r.corporate_id", "=", corporateId);
  return (await query.execute()).map((r) => ({
    id: r.id,
    corporateId: r.corporate_id!,
    employee: r.name,
    propertyId: r.property_id,
    room: r.room_label,
    start: r.joined_on,
    end: "",
    status: r.status,
  }));
}

export const listCorporates = async (db: Db, businessId: string) =>
  db.selectFrom("corporate_accounts").select(["id", "name"]).where("business_id", "=", businessId).orderBy("name").execute();
