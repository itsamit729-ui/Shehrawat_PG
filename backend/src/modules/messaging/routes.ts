import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../../http/pipeline.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import type { Context } from "../identity/service.js";
import {
  createCampaign,
  listConversations,
  queueStaffMessage,
  scheduleCampaign,
  updateCampaign,
  updateConversation,
} from "./service.js";

const idParam = z.object({ id: z.uuid() });
const conversationPatch = z.object({
  id: z.string().optional(),
  mode: z.enum(["Bot", "Human"]).optional(),
  assignee: z.enum(["Unassigned", "Property team", "Maintenance team", "Owner"]).optional(),
});
const send = z.object({ conversationId: z.uuid(), body: z.string().trim().min(1).max(4096) });
const campaign = z.object({
  name: z.string().trim().min(1).max(160),
  template: z
    .string()
    .trim()
    .regex(/^[a-z0-9_]{1,128}$/, "Use the template's exact WhatsApp name, such as rent_reminder."),
  audience: z.enum(["Opted-in leads", "Opted-in residents"]),
  scheduled: z.string().min(1).max(40),
});

export function messagingRoutes(app: FastifyInstance, opts: { ctx: Context }) {
  const { ctx } = opts;
  const key = (request: FastifyRequest) => requireIdempotencyKey(request.headers["idempotency-key"]);

  app.get("/conversations", async (request) => {
    const user = requireRole(request, "owner");
    return listConversations(ctx.db, user.businessId);
  });

  app.patch("/conversations/:id", async (request, reply) => {
    const user = requireRole(request, "owner");
    const { id: _ignored, ...changes } = conversationPatch.parse(request.body);
    await updateConversation(ctx, user.businessId, idParam.parse(request.params).id, changes);
    return reply.status(204).send();
  });

  app.post("/messages/send", async (request) => {
    const user = requireRole(request, "owner");
    const { conversationId, body } = send.parse(request.body);
    return queueStaffMessage(ctx, user, conversationId, body, key(request));
  });

  app.post("/campaigns", async (request, reply) => {
    const user = requireRole(request, "owner");
    return reply.status(201).send(await createCampaign(ctx, user, campaign.parse(request.body), key(request)));
  });

  app.patch("/campaigns/:id", async (request, reply) => {
    const user = requireRole(request, "owner");
    await updateCampaign(ctx, user.businessId, idParam.parse(request.params).id, campaign.partial().parse(request.body));
    return reply.status(204).send();
  });

  app.post("/campaigns/schedule", async (request, reply) => {
    const user = requireRole(request, "owner");
    await scheduleCampaign(ctx, user, idParam.parse(request.body).id, request.id);
    return reply.status(204).send();
  });
}
