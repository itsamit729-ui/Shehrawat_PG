import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireRole, requireUser } from "../../http/pipeline.js";
import { requireIdempotencyKey } from "../../shared/idempotency.js";
import { consumeLimit } from "../../shared/rate-limit.js";
import type { Context } from "../identity/service.js";
import { agreementLink, completeUpload, createAgreement, startUpload, uploadLink } from "./service.js";

const idParam = z.object({ id: z.uuid() });
const upload = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.string().max(64),
  size: z.number().int().positive(),
  purpose: z.enum(["resident-document"]),
});
const agreement = z.object({ residentId: z.uuid(), title: z.string().trim().min(1).max(160) });

export function documentRoutes(app: FastifyInstance, opts: { ctx: Context }) {
  const { ctx } = opts;

  app.post("/uploads", async (request) => {
    const user = requireUser(request);
    await consumeLimit(ctx.db, ctx.secret, { scope: "uploads-user", subject: user.id, max: 20, seconds: 3600 });
    return startUpload(ctx, user, upload.parse(request.body));
  });

  app.post("/uploads/:id/complete", async (request) =>
    completeUpload(ctx, requireUser(request), idParam.parse(request.params).id),
  );

  app.post("/uploads/:id/link", async (request) =>
    uploadLink(ctx, requireUser(request), idParam.parse(request.params).id),
  );

  app.post("/agreements", async (request, reply) => {
    const user = requireRole(request, "owner");
    const key = requireIdempotencyKey(request.headers["idempotency-key"]);
    return reply.status(201).send(await createAgreement(ctx, user, agreement.parse(request.body), key));
  });

  app.post("/agreements/:id/link", async (request) =>
    agreementLink(ctx, requireUser(request), idParam.parse(request.params).id),
  );
}
