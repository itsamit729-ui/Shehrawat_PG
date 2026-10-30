import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole, requireUser } from "../../http/pipeline.js";
import { businessToday, isCalendarDate } from "../../shared/dates.js";
import { listBedsWithStatus } from "../inventory/allocations.js";
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
    if (user.role === "owner")
      return {
        beds: await listBedsWithStatus(ctx.db, user.businessId, businessToday()),
        residents: await listResidents(ctx.db, user.businessId),
      };
    if (user.role === "resident")
      return { residents: user.residentId ? await listResidentById(ctx.db, user.businessId, user.residentId) : [] };
    return {
      residents: user.corporateId ? await listCorporateResidents(ctx.db, user.businessId, user.corporateId) : [],
    };
  });
}
