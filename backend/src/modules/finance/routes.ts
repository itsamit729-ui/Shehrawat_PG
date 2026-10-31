import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../../config.js";
import { isDuplicate } from "../../db/client.js";
import { HttpError, unauthorized } from "../../http/errors.js";
import { requireRole, requireUser } from "../../http/pipeline.js";
import { enqueueJob } from "../../jobs/runner.js";
import { isCalendarDate } from "../../shared/dates.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import { consumeLimit } from "../../shared/rate-limit.js";
import type { Context } from "../identity/service.js";
import {
  createExpense,
  createHoldOrder,
  createInvoiceOrder,
  createManualInvoice,
  paymentStatus,
  recordManualPayment,
  requestRefund,
} from "./service.js";

const date = z.string().refine(isCalendarDate, "Enter a valid date.");
const holdOrder = z.object({
  holdId: z.uuid(),
  name: z.string().trim().min(1).max(160),
  phone: z.string().min(1).max(32),
  email: z.email().max(254),
  moveIn: date,
  occupation: z.string().trim().max(160).default(""),
});
const invoiceOrder = z.object({ invoiceId: z.uuid() });
const manualPayment = z.object({
  invoiceId: z.uuid(),
  amount: z.number().positive(),
  method: z.enum(["Bank transfer", "UPI", "Cash"]),
  reference: z.string().trim().min(1).max(128),
});
const refund = z.object({
  paymentId: z.string().trim().min(1).max(64),
  amount: z.number().positive(),
  reason: z.string().trim().min(1).max(500),
});
const invoice = z.object({
  residentId: z.uuid(),
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Enter the period as YYYY-MM."),
  due: date,
  amount: z.number().positive(),
  description: z.string().trim().min(1).max(255),
});
const expense = z.object({
  category: z.enum(["Food", "Utilities", "Staff", "Maintenance", "Other"]),
  description: z.string().trim().min(1).max(255),
  amount: z.number().positive(),
  date,
});

export function financeRoutes(app: FastifyInstance, opts: { ctx: Context; businessId: string }) {
  const { ctx, businessId } = opts;
  const key = (request: FastifyRequest) => requireIdempotencyKey(request.headers["idempotency-key"]);

  // Public for a prospect's hold. An invoice needs a session that may see it.
  app.post("/payment-orders", async (request) => {
    const body = request.body as { invoiceId?: unknown } | null;
    if (body?.invoiceId !== undefined)
      return createInvoiceOrder(ctx, requireUser(request), invoiceOrder.parse(body).invoiceId);
    const { holdId, ...customer } = holdOrder.parse(body);
    await consumeLimit(ctx.db, ctx.secret, { scope: "orders-ip", subject: request.ip, max: 20, seconds: 3600 });
    return createHoldOrder(ctx, businessId, holdId, customer);
  });

  app.get("/payments/status", async (request) => {
    const { orderId } = z.object({ orderId: z.uuid() }).parse(request.query);
    return paymentStatus(ctx, businessId, orderId, request.user);
  });

  app.post("/payments/manual", async (request) => {
    const user = requireRole(request, "owner");
    return recordManualPayment(ctx, user, manualPayment.parse(request.body), key(request), request.id);
  });

  app.post("/refunds", async (request) => {
    const user = requireRole(request, "owner");
    return requestRefund(ctx, user, refund.parse(request.body), key(request), request.id);
  });

  app.post("/invoices", async (request, reply) => {
    const user = requireRole(request, "owner");
    const created = await createManualInvoice(ctx, user, invoice.parse(request.body), key(request), request.id);
    return reply.status(201).send(created);
  });

  app.post("/expenses", async (request, reply) => {
    const user = requireRole(request, "owner");
    const created = await createExpense(ctx, user, expense.parse(request.body), key(request), request.id);
    return reply.status(201).send(created);
  });
}

const signatureMatches = (expected: Buffer, given: unknown) => {
  if (typeof given !== "string") return false;
  const sent = Buffer.from(given.replace(/^sha256=/, ""), "hex");
  return sent.length === expected.length && timingSafeEqual(sent, expected);
};

/** Saved before the provider is answered, so an acknowledged event can't be lost. */
async function acceptWebhook(ctx: Context, provider: string, eventId: string, raw: Buffer) {
  const id = randomUUID();
  try {
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("webhook_inbox")
        .values({ id, provider, event_id: eventId, payload: raw.toString("utf8") })
        .execute();
      await enqueueJob(trx, { kind: "webhook.process", dedupeKey: id, payload: { inboxId: id } });
    });
  } catch (e) {
    // Already saved by an earlier delivery, so this one only needs acknowledging.
    if (!isDuplicate(e)) throw e;
  }
}

/**
 * Outside the API plugin: providers send no Origin, cookie or CSRF token, so the signature over the
 * exact bytes received is what authenticates these. Hence the raw body parser.
 */
export function webhookRoutes(config: Config, ctx: Context) {
  return async (app: FastifyInstance) => {
    app.addContentTypeParser("application/json", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_r, body, done) =>
      done(null, body),
    );

    app.post("/razorpay", async (request, reply) => {
      if (!config.razorpay) throw new HttpError(503, "Payments are not configured.");
      const raw = request.body as Buffer;
      const expected = createHmac("sha256", config.razorpay.webhookSecret).update(raw).digest();
      if (!signatureMatches(expected, request.headers["x-razorpay-signature"])) throw unauthorized();
      const header = request.headers["x-razorpay-event-id"];
      const eventId = typeof header === "string" && header ? header : createHash("sha256").update(raw).digest("hex");
      await acceptWebhook(ctx, "razorpay", eventId, raw);
      return reply.status(200).send({ ok: true });
    });

    app.get("/whatsapp", async (request, reply) => {
      const query = request.query as Record<string, string | undefined>;
      if (
        !config.whatsapp ||
        query["hub.mode"] !== "subscribe" ||
        query["hub.verify_token"] !== config.whatsapp.verifyToken
      )
        return reply.status(403).send({ message: "Verification failed." });
      return reply.type("text/plain").send(query["hub.challenge"] ?? "");
    });

    app.post("/whatsapp", async (request, reply) => {
      if (!config.whatsapp) throw new HttpError(503, "WhatsApp is not configured.");
      const raw = request.body as Buffer;
      const expected = createHmac("sha256", config.whatsapp.appSecret).update(raw).digest();
      if (!signatureMatches(expected, request.headers["x-hub-signature-256"])) throw unauthorized();
      // Meta has no event ID, so identical bytes count as the same delivery.
      await acceptWebhook(ctx, "whatsapp", createHash("sha256").update(raw).digest("hex"), raw);
      return reply.status(200).send({ ok: true });
    });
  };
}
