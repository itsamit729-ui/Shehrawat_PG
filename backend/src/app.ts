import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyError } from "fastify";
import { sql } from "kysely";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { HttpError } from "./http/errors.js";
import { installRequestPipeline } from "./http/pipeline.js";
import { identityRoutes } from "./modules/identity/routes.js";
import type { Context } from "./modules/identity/service.js";
import { inventoryRoutes } from "./modules/inventory/routes.js";
import { peopleRoutes } from "./modules/people/routes.js";
import { createProviders, type Providers } from "./providers/index.js";

export async function buildApp(deps: { config: Config; db: Db; providers?: Providers; logger?: boolean }) {
  const { config, db } = deps;
  const app = Fastify({
    // Fastify's default request log has no headers or bodies, so cookies and passwords stay out of it.
    logger: deps.logger ?? true,
    trustProxy: (_address, hop) => hop < config.trustProxyHops,
    bodyLimit: 64 * 1024,
    genReqId: () => randomUUID(),
  });

  const business = await db
    .selectFrom("businesses")
    .select("id")
    .where("slug", "=", config.businessSlug)
    .executeTakeFirst();
  if (!business)
    throw new Error(`No business with slug "${config.businessSlug}". Run the create-owner or seed command first.`);

  const ctx: Context = {
    db,
    secret: config.authSecret,
    frontendUrl: config.frontendUrl,
    providers: deps.providers ?? createProviders(config),
    log: app.log,
  };

  await app.register(helmet);
  await app.register(cors, {
    origin: config.frontendOrigins,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Accept", "Content-Type", "X-CSRF-Token", "Idempotency-Key"],
  });
  await app.register(cookie);

  app.setErrorHandler((error: FastifyError | HttpError | ZodError, request, reply) => {
    if (error instanceof ZodError) {
      const message = error.issues[0]?.message ?? "Please check the details and try again.";
      return reply.status(422).send({ message });
    }
    if (error instanceof HttpError) return reply.status(error.statusCode).send({ message: error.message });
    const status = (error as FastifyError).statusCode;
    if (status && status < 500)
      return reply.status(status).send({ message: "This request could not be understood." });
    request.log.error({ err: error }, "Unhandled error");
    return reply.status(500).send({ message: "Something went wrong on our side. Please try again." });
  });
  app.setNotFoundHandler((_request, reply) => reply.status(404).send({ message: "This isn't available." }));

  app.get("/healthz", async () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      await sql`SELECT 1`.execute(db);
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "unavailable" });
    }
  });

  await app.register(
    async (api) => {
      installRequestPipeline(api, { config, ctx });
      identityRoutes(api, { config, ctx, businessId: business.id });
      inventoryRoutes(api, { ctx, businessId: business.id });
      peopleRoutes(api, { ctx });
    },
    { prefix: "/api/v1" },
  );
  return app;
}
