import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Config } from "../../config.js";
import { clearSessionCookie, requireRole, requireUser, setSessionCookie } from "../../http/pipeline.js";
import { csrfTokenFor } from "./crypto.js";
import {
  changePassword,
  createSession,
  lookupSession,
  requestOwnerOtp,
  requestRecovery,
  resendVerification,
  revokeSession,
  setPasswordWithToken,
  signUp,
  verifyEmail,
  verifyOwnerOtp,
  verifyOwnerPassword,
  verifyPasswordLogin,
  type Context,
  type SessionUser,
} from "./service.js";

const otpRequest = z.object({ phone: z.string().min(1).max(32) });
const login = z.discriminatedUnion("role", [
  z.object({
    role: z.literal("owner"),
    challengeId: z.uuid(),
    otp: z.string().regex(/^\d{6}$/, "Enter the 6-digit code."),
  }),
  z.object({
    role: z.enum(["resident", "corporate"]),
    email: z.email().max(254),
    password: z.string().min(1).max(128),
  }),
]);
const ownerPassword = z.object({ password: z.string().min(1, "Enter your password.").max(128) });
const newAccount = {
  name: z.string().trim().min(1, "Enter your name.").max(160),
  email: z.email().max(254),
  password: z.string().min(1).max(128),
};
const signup = z.discriminatedUnion("role", [
  z.object({ role: z.literal("resident"), ...newAccount }),
  z.object({
    role: z.literal("corporate"),
    ...newAccount,
    companyName: z.string().trim().min(1, "Enter your company name.").max(160),
  }),
]);
const recover = z.object({ email: z.email().max(254) });
const verify = z.object({ token: z.string().min(16).max(128) });
const change = z.object({ currentPassword: z.string().min(1).max(128), password: z.string().min(1).max(128) });
const CHECK_EMAIL = "If this account is eligible, an email will arrive shortly. Check your spam folder too.";
const setPassword = z.object({ token: z.string().min(16).max(128), password: z.string().min(1).max(128) });

// businessId stays server-side: the frontend's Session model has no use for it.
function publicUser({ id, name, role, residentId, corporateId }: SessionUser) {
  return { id, name, role, residentId, corporateId };
}

export function identityRoutes(app: FastifyInstance, opts: { config: Config; ctx: Context; businessId: string }) {
  const { config, ctx, businessId } = opts;

  app.get("/auth/session", async (request) => {
    const user = requireUser(request);
    return { ...publicUser(user), csrfToken: csrfTokenFor(config.authSecret, request.sessionToken!) };
  });

  app.post("/auth/otp/request", async (request) => {
    const { phone } = otpRequest.parse(request.body);
    return requestOwnerOtp(ctx, businessId, phone, request.ip);
  });

  app.post("/auth/login", async (request, reply) => {
    let userId: string;
    if (config.ownerLogin === "password" && (request.body as { role?: unknown } | null)?.role === "owner") {
      const { password } = ownerPassword.parse(request.body);
      userId = await verifyOwnerPassword(ctx, businessId, password, request.ip);
    } else {
      const body = login.parse(request.body);
      userId =
        body.role === "owner"
          ? await verifyOwnerOtp(ctx, businessId, body.challengeId, body.otp)
          : await verifyPasswordLogin(ctx, businessId, {
              role: body.role,
              email: body.email,
              password: body.password,
              ip: request.ip,
            });
    }
    const { token, maxAgeSeconds } = await createSession(ctx, userId, request.cookies.sg_session);
    setSessionCookie(config, reply, token, maxAgeSeconds);
    const user = await lookupSession(ctx, token);
    return { user: publicUser(user!), csrfToken: csrfTokenFor(config.authSecret, token) };
  });

  app.post("/auth/signup", async (request, reply) => {
    await signUp(ctx, businessId, signup.parse(request.body), request.ip);
    const verificationRequired = config.requireEmailVerification;
    return reply.status(202).send({
      verificationRequired,
      message: verificationRequired
        ? CHECK_EMAIL
        : "You can sign in now. If you already have an account, use its existing password.",
    });
  });

  app.post("/auth/resend-verification", async (request) => {
    const { email } = recover.parse(request.body);
    await resendVerification(ctx, businessId, email, request.ip);
    return { message: CHECK_EMAIL };
  });

  app.post("/auth/verify-email", async (request, reply) => {
    const { token } = verify.parse(request.body);
    await verifyEmail(ctx, token, request.ip);
    return reply.status(204).send();
  });

  // The owner's password comes from create-owner, so it changes through --reset-password.
  app.post("/auth/change-password", async (request, reply) => {
    const user = requireRole(request, "resident", "corporate");
    const { currentPassword, password } = change.parse(request.body);
    await changePassword(ctx, user, currentPassword, password, request.ip);
    const { token, maxAgeSeconds } = await createSession(ctx, user.id, request.sessionToken ?? undefined);
    setSessionCookie(config, reply, token, maxAgeSeconds);
    const fresh = await lookupSession(ctx, token);
    return { user: publicUser(fresh!), csrfToken: csrfTokenFor(config.authSecret, token) };
  });

  app.post("/auth/logout", async (request, reply) => {
    // Already signed out is still a success, so a stale tab can always log out.
    if (request.sessionToken) await revokeSession(ctx, request.sessionToken);
    clearSessionCookie(config, reply);
    return reply.status(204).send();
  });

  app.post("/auth/recover", async (request) => {
    const { email } = recover.parse(request.body);
    await requestRecovery(ctx, businessId, email, request.ip);
    return { message: "If this account exists, recovery instructions will be sent." };
  });

  app.post("/auth/set-password", async (request, reply) => {
    const { token, password } = setPassword.parse(request.body);
    await setPasswordWithToken(ctx, token, password, request.ip);
    return reply.status(204).send();
  });
}
