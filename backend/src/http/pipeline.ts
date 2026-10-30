import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import type { Role } from "../db/schema.js";
import { csrfTokenFor, safeEqual } from "../modules/identity/crypto.js";
import { lookupSession, type Context, type SessionUser } from "../modules/identity/service.js";
import { forbidden, HttpError, unauthorized } from "./errors.js";

export const SESSION_COOKIE = "sg_session";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    sessionToken: string | null;
  }
}

export function setSessionCookie(config: Config, reply: FastifyReply, token: string, maxAge: number) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    domain: config.cookie.domain,
    maxAge,
  });
}

export function clearSessionCookie(config: Config, reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, {
    path: "/",
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    domain: config.cookie.domain,
  });
}

/**
 * Runs before every route: rejects foreign origins on mutations, resolves the session, then
 * requires the CSRF token whenever a mutation arrives with a live session attached.
 */
export function installRequestPipeline(app: FastifyInstance, opts: { config: Config; ctx: Context }) {
  const { config, ctx } = opts;
  app.decorateRequest("user", null);
  app.decorateRequest("sessionToken", null);
  app.addHook("onRequest", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const mutation = !SAFE_METHODS.has(request.method);
    if (mutation && !config.frontendOrigins.includes(String(request.headers.origin)))
      throw new HttpError(403, "This request came from an unrecognized site.");
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;
    const user = await lookupSession(ctx, token);
    if (!user) {
      clearSessionCookie(config, reply);
      return;
    }
    if (mutation) {
      const sent = request.headers["x-csrf-token"];
      if (typeof sent !== "string" || !safeEqual(sent, csrfTokenFor(config.authSecret, token)))
        throw new HttpError(403, "Your session needs refreshing. Please reload the page and try again.");
    }
    request.user = user;
    request.sessionToken = token;
  });
}

export function requireUser(request: FastifyRequest) {
  if (!request.user) throw unauthorized();
  return request.user;
}

export function requireRole(request: FastifyRequest, ...roles: Role[]) {
  const user = requireUser(request);
  if (!roles.includes(user.role)) throw forbidden();
  return user;
}
