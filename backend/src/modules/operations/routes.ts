import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../../http/pipeline.js";
import { isCalendarDate } from "../../shared/dates.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import { consumeLimits } from "../../shared/rate-limit.js";
import type { Context } from "../identity/service.js";
import {
  createLead,
  createRequest,
  createTicket,
  saveSettings,
  updateLead,
  updateTicket,
} from "./service.js";

const idParam = z.object({ id: z.uuid() });
const date = z.string().refine(isCalendarDate, "Enter a valid date.");
const ticketText = {
  subject: z.string().trim().min(1).max(160),
  category: z.string().trim().min(1).max(64),
  description: z.string().trim().min(1).max(4000),
};
const priority = z.enum(["Low", "Normal", "Medium", "High", "Urgent"]);
const ticketCreate = z.object({ ...ticketText, priority: priority.default("Normal"), residentId: z.uuid().optional() });
const ticketPatch = z
  .object({
    ...ticketText,
    priority,
    status: z.enum(["Open", "In progress", "Resolved"]),
    assignee: z.enum(["Unassigned", "Property team", "Maintenance team", "Owner"]),
  })
  .partial();

const leadStatus = z.enum(["New", "Contacted", "Visit scheduled", "Converted", "Closed"]);
const lead = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().trim().max(32).default(""),
  email: z.union([z.email().max(254), z.literal("")]).default(""),
  propertyId: z.union([z.uuid(), z.literal("")]).default(""),
  date: z.union([date, z.literal("")]).default(""),
  kind: z.enum(["Enquiry", "Visit", "Corporate", "Property partner"]).default("Enquiry"),
  status: leadStatus.default("New"),
  notes: z.string().trim().max(4000).default(""),
  // The partner and company forms send these. They're kept readable in the lead's notes.
  company: z.string().trim().max(160).optional(),
  address: z.string().trim().max(255).optional(),
  capacity: z.coerce.number().int().positive().max(100000).optional(),
});
const leadPatch = z
  .object({
    name: z.string().trim().min(1).max(160),
    phone: z.string().trim().max(32),
    email: z.union([z.email().max(254), z.literal("")]),
    propertyId: z.union([z.uuid(), z.literal("")]),
    date: z.union([date, z.literal("")]),
    kind: z.enum(["Enquiry", "Visit", "Corporate", "Property partner"]),
    status: leadStatus,
    notes: z.string().trim().max(4000),
  })
  .partial();

const referral = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().trim().min(1).max(32),
  note: z.string().trim().max(1000).default(""),
  residentId: z.uuid().optional(),
});
const moveOut = z.object({
  date,
  reason: z.string().trim().min(1).max(1000),
  residentId: z.uuid().optional(),
});
const housing = z.object({
  corporateId: z.uuid().optional(),
  propertyId: z.union([z.uuid(), z.literal("")]).default(""),
  beds: z.coerce.number().int().min(1).max(500),
  start: date,
  notes: z.string().trim().max(1000).default(""),
  employee: z.string().trim().max(160).optional(),
  email: z.union([z.email().max(254), z.literal("")]).optional(),
});

const meals = z.object({
  breakfast: z.string().trim().max(255),
  lunch: z.string().trim().max(255),
  dinner: z.string().trim().max(255),
});
// Strict, because this is a settings form and never a place for anything else, secrets included.
const settings = z
  .object({
    businessName: z.string().trim().min(1).max(160),
    rentDay: z.number().int().min(1).max(28),
    billingEnabled: z.boolean(),
    campaignRecipientCap: z.number().int().min(1).max(100000),
    mealMenu: z.partialRecord(z.enum(["0", "1", "2", "3", "4", "5", "6"]), meals),
    rentReminder: z.boolean(),
    paymentReceipt: z.boolean(),
    moveInWelcome: z.boolean(),
    complaintUpdate: z.boolean(),
    agreementReminder: z.boolean(),
  })
  .partial()
  .strict();

export function operationsRoutes(app: FastifyInstance, opts: { ctx: Context; businessId: string }) {
  const { ctx, businessId } = opts;
  const key = (request: FastifyRequest) => requireIdempotencyKey(request.headers["idempotency-key"]);

  app.post("/tickets", async (request, reply) => {
    const user = requireRole(request, "owner", "resident");
    return reply.status(201).send(await createTicket(ctx, user, ticketCreate.parse(request.body), key(request)));
  });

  app.patch("/tickets/:id", async (request, reply) => {
    const user = requireRole(request, "owner", "resident");
    await updateTicket(ctx, user, idParam.parse(request.params).id, ticketPatch.parse(request.body));
    return reply.status(204).send();
  });

  // Public, with limits by address so a script can't flood the owner's list.
  app.post("/leads", async (request, reply) => {
    const { company, address, capacity, ...input } = lead.parse(request.body);
    const ownerAdded = request.user?.role === "owner";
    if (!ownerAdded)
      await consumeLimits(ctx.db, ctx.secret, [
        { scope: "leads-ip-hour", subject: request.ip, max: 5, seconds: 3600 },
        { scope: "leads-ip-day", subject: request.ip, max: 20, seconds: 86400 },
      ]);
    const extra = [
      company && `Company: ${company}`,
      address && `Address: ${address}`,
      capacity && (company ? `Beds required: ${capacity}` : `Capacity: ${capacity}`),
    ].filter(Boolean);
    const notes = [...extra, input.notes].filter(Boolean).join("\n");
    return reply.status(201).send(await createLead(ctx, businessId, { ...input, notes }, ownerAdded));
  });

  app.patch("/leads/:id", async (request, reply) => {
    const user = requireRole(request, "owner");
    await updateLead(ctx, user.businessId, idParam.parse(request.params).id, leadPatch.parse(request.body));
    return reply.status(204).send();
  });

  app.post("/referrals", async (request, reply) => {
    const user = requireRole(request, "owner", "resident");
    const { residentId, ...details } = referral.parse(request.body);
    const created = await createRequest(
      ctx,
      user,
      "referrals",
      { ...(residentId ? { residentId } : {}), details },
      key(request),
    );
    return reply.status(201).send(created);
  });

  // Records the request only. Notice terms and settlement stay with the owner.
  app.post("/move-outs", async (request, reply) => {
    const user = requireRole(request, "owner", "resident");
    const { residentId, ...details } = moveOut.parse(request.body);
    const created = await createRequest(
      ctx,
      user,
      "move-outs",
      { ...(residentId ? { residentId } : {}), details },
      key(request),
    );
    return reply.status(201).send(created);
  });

  // A company's request, never a reservation.
  app.post("/housing-requests", async (request, reply) => {
    const user = requireRole(request, "owner", "corporate");
    const { corporateId, ...details } = housing.parse(request.body);
    const created = await createRequest(
      ctx,
      user,
      "housing-requests",
      { ...(corporateId ? { corporateId } : {}), details },
      key(request),
    );
    return reply.status(201).send(created);
  });

  app.post("/settings", async (request, reply) => {
    const user = requireRole(request, "owner");
    await saveSettings(ctx, user, settings.parse(request.body), request.id);
    return reply.status(204).send();
  });
}
