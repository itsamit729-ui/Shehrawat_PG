import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { dbNow } from "../../db/client.js";
import { invalid, notFound } from "../../http/errors.js";
import { requireRole } from "../../http/pipeline.js";
import { audit } from "../../shared/audit.js";
import { businessToday, isCalendarDate } from "../../shared/dates.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import { consumeLimit } from "../../shared/rate-limit.js";
import type { Context } from "../identity/service.js";
import { createHold, listBedsWithStatus, setBedBlocked } from "./allocations.js";
import { listProperties } from "./properties.js";

const holdBody = z.object({
  propertyId: z.uuid(),
  sharing: z.enum(["single", "double", "triple"]),
  moveIn: z.string().refine(isCalendarDate, "Enter a valid move-in date."),
});
const propertyPatch = z
  .object({
    id: z.string().optional(),
    name: z.string().trim().min(1).max(160),
    area: z.string().trim().min(1).max(160),
    sector: z.string().trim().min(1).max(160),
    gender: z.enum(["Men", "Women", "Unisex"]),
    blurb: z.string().trim().min(1).max(4000),
  })
  .partial();
const bedPatch = z.object({ id: z.string().optional(), status: z.enum(["Available", "Blocked"]) });
const idParam = z.object({ id: z.uuid() });

export function inventoryRoutes(app: FastifyInstance, opts: { ctx: Context; businessId: string }) {
  const { ctx, businessId } = opts;

  app.get("/properties", async () => listProperties(ctx.db, businessId));

  app.patch("/properties/:id", async (request, reply) => {
    const user = requireRole(request, "owner");
    const { id } = idParam.parse(request.params);
    const { id: _ignored, ...changes } = propertyPatch.parse(request.body);
    if (!Object.keys(changes).length) throw invalid("Nothing to update.");
    const result = await ctx.db
      .updateTable("properties")
      .set({ ...changes, updated_at: dbNow })
      .where("id", "=", id)
      .where("business_id", "=", user.businessId)
      .executeTakeFirst();
    if (!result.numUpdatedRows) throw notFound("This property");
    await audit(ctx.db, {
      businessId: user.businessId,
      actorUserId: user.id,
      action: "property.updated",
      entityType: "property",
      entityId: id,
      requestId: request.id,
      metadata: { fields: Object.keys(changes) },
    });
    return reply.status(204).send();
  });

  app.get("/beds", async (request) => {
    const user = requireRole(request, "owner");
    return listBedsWithStatus(ctx.db, user.businessId, businessToday());
  });

  app.patch("/beds/:id", async (request, reply) => {
    const user = requireRole(request, "owner");
    const { id } = idParam.parse(request.params);
    const { status } = bedPatch.parse(request.body);
    await setBedBlocked(ctx.db, user.businessId, id, status === "Blocked");
    await audit(ctx.db, {
      businessId: user.businessId,
      actorUserId: user.id,
      action: status === "Blocked" ? "bed.blocked" : "bed.unblocked",
      entityType: "bed",
      entityId: id,
      requestId: request.id,
    });
    return reply.status(204).send();
  });

  // Public, because prospects hold a bed before they have an account. The limit stops one client
  // from tying up a home's beds with free 15-minute holds.
  app.post("/holds", async (request) => {
    const body = holdBody.parse(request.body);
    const idempotencyKey = requireIdempotencyKey(request.headers["idempotency-key"]);
    await consumeLimit(ctx.db, ctx.secret, { scope: "holds-ip", subject: request.ip, max: 10, seconds: 3600 });
    return createHold(ctx.db, {
      businessId,
      ...body,
      actor: request.user?.id ?? "public",
      idempotencyKey,
    });
  });
}
