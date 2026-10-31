import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { Config } from "../../config.js";
import { dbNow, isDuplicate } from "../../db/client.js";
import { conflict, HttpError } from "../../http/errors.js";
import { requireRole, setSessionCookie } from "../../http/pipeline.js";
import { audit } from "../../shared/audit.js";
import { consumeLimits } from "../../shared/rate-limit.js";
import { safeEqual } from "./crypto.js";
import { createSession, normalizeEmail, type Context } from "./service.js";

const STATE_COOKIE = "sg_google_state";
const STATE_PATH = "/api/v1/auth/google";
const callbackQuery = z.object({ code: z.string().default(""), state: z.string().default("") });

/** Google sign-in for residents. A company account needs a company name, which Google can't supply. */
export function googleRoutes(app: FastifyInstance, opts: { config: Config; ctx: Context; businessId: string }) {
  const { config, ctx, businessId } = opts;
  const google = config.google;
  const stateOptions = {
    path: STATE_PATH,
    httpOnly: true,
    secure: config.cookie.secure,
    sameSite: config.cookie.sameSite,
    domain: config.cookie.domain,
  };

  function required() {
    if (!google) throw new HttpError(503, "Google sign-in is not configured.");
    return google;
  }

  function beginAuthorization(reply: FastifyReply, prefix = "") {
    const { clientId, redirectUri } = required();
    const state = prefix + randomBytes(32).toString("base64url");
    reply.setCookie(STATE_COOKIE, state, { ...stateOptions, maxAge: 600 });
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email",
      state,
      prompt: "select_account",
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  app.get("/auth/google/enabled", async () => ({ enabled: Boolean(google) }));

  app.get("/auth/google/start", async (_request, reply) => reply.redirect(beginAuthorization(reply), 302));

  app.post("/auth/google/link", async (request, reply) => {
    const user = requireRole(request, "resident");
    required();
    const linked = await ctx.db
      .selectFrom("google_identities")
      .select("google_sub")
      .where("user_id", "=", user.id)
      .executeTakeFirst();
    if (linked) throw conflict("A Google account is already connected.");
    return reply.send({ url: beginAuthorization(reply, "link.") });
  });

  app.get("/auth/google/callback", async (request, reply) => {
    required();
    const fail = (reason = "failed") => reply.redirect(`${config.frontendUrl}/login?google_error=${reason}`, 303);
    const expected = request.cookies[STATE_COOKIE];
    reply.clearCookie(STATE_COOKIE, stateOptions);
    const query = callbackQuery.safeParse(request.query);
    if (!query.success || !query.data.code || !expected || !safeEqual(query.data.state, expected)) return fail();
    const linking = expected.startsWith("link.");

    let profile;
    try {
      await consumeLimits(ctx.db, ctx.secret, [
        { scope: "google-ip", subject: request.ip, max: 20, seconds: 15 * 60 },
      ]);
      profile = await ctx.providers.google.exchangeCode(query.data.code);
    } catch {
      return fail();
    }
    const email = normalizeEmail(profile.email ?? "");
    if (!profile.sub || !email || !profile.emailVerified) return fail();

    const identity = await ctx.db
      .selectFrom("google_identities as g")
      .innerJoin("users as u", "u.id", "g.user_id")
      .select(["g.user_id", "u.role", "u.status", "u.business_id"])
      .where("g.google_sub", "=", profile.sub)
      .executeTakeFirst();

    if (linking) {
      const user = request.user;
      if (user?.role !== "resident" || (identity && identity.user_id !== user.id)) return fail();
      if (!identity) {
        try {
          await ctx.db.insertInto("google_identities").values({ google_sub: profile.sub, user_id: user.id }).execute();
        } catch (e) {
          if (isDuplicate(e)) return fail();
          throw e;
        }
      }
      return reply.redirect(`${config.frontendUrl}/resident/security?google_connected=1`, 303);
    }

    let userId = identity?.user_id;
    if (identity) {
      if (identity.status !== "active" || identity.role !== "resident" || identity.business_id !== businessId)
        return fail();
    } else {
      // A matching address must never silently grant access to an existing account.
      const taken = await ctx.db
        .selectFrom("users")
        .select("id")
        .where("business_id", "=", businessId)
        .where("email", "=", email)
        .executeTakeFirst();
      if (taken) return fail("existing");
      const newId = randomUUID();
      const sub = profile.sub;
      try {
        await ctx.db.transaction().execute(async (trx) => {
          await trx
            .insertInto("users")
            .values({
              id: newId,
              business_id: businessId,
              role: "resident",
              status: "active",
              name: email.split("@")[0]!,
              email,
              phone: null,
              password_hash: null,
              email_verified_at: dbNow as never,
            })
            .execute();
          await trx.insertInto("google_identities").values({ google_sub: sub, user_id: newId }).execute();
          await audit(trx, {
            businessId,
            actorUserId: newId,
            action: "auth.signed_up",
            entityType: "user",
            entityId: newId,
            metadata: { method: "google" },
          });
        });
      } catch (e) {
        if (isDuplicate(e)) return fail();
        throw e;
      }
      userId = newId;
    }

    const { token, maxAgeSeconds } = await createSession(ctx, userId!, request.cookies.sg_session);
    setSessionCookie(config, reply, token, maxAgeSeconds);
    return reply.redirect(`${config.frontendUrl}/resident/home`, 303);
  });
}
