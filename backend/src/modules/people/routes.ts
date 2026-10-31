import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole, requireUser } from "../../http/pipeline.js";
import { businessToday, isCalendarDate } from "../../shared/dates.js";
import { listAgreements } from "../documents/service.js";
import { listBedsWithStatus } from "../inventory/allocations.js";
import { listCampaigns, listConversations } from "../messaging/service.js";
import {
  getSettings,
  listAllocations,
  listCorporates,
  listExpenses,
  listInvoices,
  listLeads,
  listPayments,
  listRefundRequests,
  listRequests,
  listTickets,
  residentSafeSettings,
} from "../operations/service.js";
import type { Context } from "../identity/service.js";
import {
  createResident,
  listCorporateResidents,
  listResidentById,
  listResidents,
  updateResident,
} from "./service.js";

const resident = z.object({
  name: z.string().trim().min(1).max(160),
  email: z.email().max(254),
  phone: z.string().min(1).max(32),
  propertyId: z.uuid(),
  room: z.string().trim().min(1).max(32),
  rent: z.number().positive(),
  status: z.enum(["Active", "Notice", "Moved out"]),
  joined: z.string().refine(isCalendarDate, "Enter a valid date."),
  corporateId: z.union([z.uuid(), z.literal("")]).optional(),
  bedId: z.union([z.uuid(), z.literal("")]).optional(),
});
const residentPatch = resident.partial();
const idParam = z.object({ id: z.uuid() });

export function peopleRoutes(app: FastifyInstance, opts: { ctx: Context }) {
  const { ctx } = opts;

  app.post("/residents", async (request, reply) => {
    const user = requireRole(request, "owner");
    const created = await createResident(ctx, user, resident.parse(request.body), request.id);
    return reply.status(201).send(created);
  });

  app.patch("/residents/:id", async (request, reply) => {
    const user = requireRole(request, "owner");
    const { id } = idParam.parse(request.params);
    await updateResident(ctx, user, id, residentPatch.parse(request.body), request.id);
    return reply.status(204).send();
  });

  // Each role gets only its own slice. Omitted collections render as empty in the frontend.
  app.get("/portal", async (request) => {
    const user = requireUser(request);
    const { db } = ctx;
    const { businessId } = user;
    if (user.role === "owner") {
      const [settings, requests, refunds] = await Promise.all([
        getSettings(db, businessId),
        listRequests(db, businessId, {}),
        listRefundRequests(db, businessId),
      ]);
      return {
        beds: await listBedsWithStatus(db, businessId, businessToday()),
        residents: await listResidents(db, businessId),
        invoices: await listInvoices(db, businessId, {}),
        tickets: await listTickets(db, businessId),
        leads: await listLeads(db, businessId),
        agreements: await listAgreements(db, businessId),
        campaigns: await listCampaigns(db, businessId),
        conversations: await listConversations(db, businessId),
        expenses: await listExpenses(db, businessId),
        allocations: await listAllocations(db, businessId),
        payments: await listPayments(db, businessId),
        corporates: await listCorporates(db, businessId),
        requests: [...requests, ...refunds],
        settings,
      };
    }
    if (user.role === "resident") {
      if (!user.residentId) return { residents: [] };
      const safe = residentSafeSettings(await getSettings(db, businessId));
      const scope = { residentId: user.residentId };
      return {
        residents: await listResidentById(db, businessId, user.residentId),
        invoices: await listInvoices(db, businessId, scope),
        tickets: await listTickets(db, businessId, user.residentId),
        agreements: await listAgreements(db, businessId, user.residentId),
        requests: await listRequests(db, businessId, scope),
        settings: safe,
      };
    }
    if (!user.corporateId) return { residents: [] };
    const scope = { corporateId: user.corporateId };
    return {
      residents: await listCorporateResidents(db, businessId, user.corporateId),
      invoices: await listInvoices(db, businessId, scope),
      allocations: await listAllocations(db, businessId, user.corporateId),
      requests: await listRequests(db, businessId, scope),
    };
  });
}
