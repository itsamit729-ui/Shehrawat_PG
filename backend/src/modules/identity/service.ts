import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { sql } from "kysely";
import { dbNow, dbNowPlus, type Db, type Trx } from "../../db/client.js";
import type { Role } from "../../db/schema.js";
import { HttpError, invalid } from "../../http/errors.js";
import type { Providers } from "../../providers/index.js";
import { audit } from "../../shared/audit.js";
import { consumeLimits } from "../../shared/rate-limit.js";
import {
  generateOtp,
  hashPassword,
  otpHmac,
  randomToken,
  safeEqual,
  sha256,
  verifyPassword,
} from "./crypto.js";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const OTP_TTL = 5 * MINUTE;
const OTP_MAX_ATTEMPTS = 5;
// Planning allowance from the blueprint. Going over warns but never locks the owner out.
const OTP_MONTHLY_ALLOWANCE = 30;
const SESSION_LIMITS: Record<Role, { idle: number; absolute: number }> = {
  owner: { idle: 30 * MINUTE, absolute: 12 * HOUR },
  resident: { idle: DAY, absolute: 7 * DAY },
  corporate: { idle: DAY, absolute: 7 * DAY },
};
const TOKEN_TTL = { invite: 7 * DAY, recovery: HOUR };
// Avoids a database write on every request.
const SESSION_TOUCH_INTERVAL_MS = 60_000;

const BAD_LOGIN = "Those details didn't match. Please check them and try again.";
const BAD_OTP = "That code is incorrect or has expired. Please request a new one.";
const BAD_TOKEN = "This link has expired or was already used. Please request a new one.";

export interface SessionUser {
  id: string;
  name: string;
  role: Role;
  businessId: string;
  residentId?: string;
  corporateId?: string;
}

export interface Context {
  db: Db;
  secret: string;
  frontendUrl: string;
  providers: Providers;
  log: FastifyBaseLogger;
}

/** Indian mobile numbers are stored as +91XXXXXXXXXX whichever way they were typed. */
export function normalizePhone(input: string) {
  const digits = input.replace(/[\s()-]/g, "");
  const match = /^(?:\+?91|0)?([6-9]\d{9})$/.exec(digits);
  if (!match) throw invalid("Enter a valid 10-digit Indian mobile number.");
  return "+91" + match[1];
}

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function assertPasswordPolicy(password: string) {
  if (password.length < 12) throw invalid("Use at least 12 characters.");
  if (password.length > 128) throw invalid("Use at most 128 characters.");
}

// ---- Owner OTP ----

/**
 * Answers the same way whether or not the phone belongs to the owner, including the challenge ID
 * and the rate limits, and sends the SMS without waiting so response time reveals nothing either.
 */
export async function requestOwnerOtp(ctx: Context, businessId: string, rawPhone: string, ip: string) {
  const phone = normalizePhone(rawPhone);
  await consumeLimits(ctx.db, ctx.secret, [
    { scope: "otp-phone-cooldown", subject: phone, max: 1, seconds: MINUTE },
    { scope: "otp-phone-daily", subject: phone, max: 10, seconds: DAY },
    { scope: "otp-ip-daily", subject: ip, max: 20, seconds: DAY },
  ]);
  const challengeId = randomUUID();
  const owner = await ctx.db
    .selectFrom("users")
    .select("id")
    .where("business_id", "=", businessId)
    .where("role", "=", "owner")
    .where("phone", "=", phone)
    .where("status", "=", "active")
    .executeTakeFirst();
  if (!owner) return { challengeId };

  const code = generateOtp();
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .updateTable("otp_challenges")
      .set({ invalidated_at: dbNow })
      .where("user_id", "=", owner.id)
      .where("consumed_at", "is", null)
      .where("invalidated_at", "is", null)
      .execute();
    await trx
      .insertInto("otp_challenges")
      .values({
        id: challengeId,
        user_id: owner.id,
        code_hmac: otpHmac(ctx.secret, challengeId, code),
        expires_at: dbNowPlus(OTP_TTL) as never,
      })
      .execute();
  });
  void ctx.providers.sms
    .sendOtp(phone, code)
    .catch((err: unknown) => ctx.log.error({ err: safeError(err) }, "Owner OTP could not be sent"));
  void warnIfOverOtpAllowance(ctx, owner.id);
  return { challengeId };
}

async function warnIfOverOtpAllowance(ctx: Context, ownerId: string) {
  try {
    const row = await ctx.db
      .selectFrom("otp_challenges")
      .select((eb) => eb.fn.countAll<number>().as("sent"))
      .where("user_id", "=", ownerId)
      .where("created_at", ">=", sql<Date>`UTC_TIMESTAMP(6) - INTERVAL 30 DAY`)
      .executeTakeFirstOrThrow();
    if (Number(row.sent) > OTP_MONTHLY_ALLOWANCE)
      ctx.log.warn({ sent: Number(row.sent) }, "Owner OTP sends exceed the 30-day planning allowance");
  } catch (err) {
    ctx.log.error({ err: safeError(err) }, "Could not check the OTP allowance");
  }
}

export async function verifyOwnerOtp(ctx: Context, businessId: string, challengeId: string, code: string) {
  // Runs in its own transaction: a wrong guess must commit its attempt, not roll it back.
  const userId = await ctx.db.transaction().execute(async (trx) => {
    const challenge = await trx
      .selectFrom("otp_challenges as c")
      .innerJoin("users as u", "u.id", "c.user_id")
      .select([
        "c.id",
        "c.user_id",
        "c.code_hmac",
        "c.attempts",
        "c.consumed_at",
        "c.invalidated_at",
        "u.role",
        "u.status",
        "u.business_id",
        sql<number>`c.expires_at > UTC_TIMESTAMP(6)`.as("live"),
      ])
      .where("c.id", "=", challengeId)
      .forUpdate()
      .executeTakeFirst();
    if (
      !challenge ||
      challenge.business_id !== businessId ||
      challenge.role !== "owner" ||
      challenge.status !== "active" ||
      challenge.consumed_at ||
      challenge.invalidated_at ||
      !challenge.live ||
      challenge.attempts >= OTP_MAX_ATTEMPTS
    )
      return null;
    const matched = safeEqual(challenge.code_hmac, otpHmac(ctx.secret, challengeId, code));
    await trx
      .updateTable("otp_challenges")
      .set({ attempts: challenge.attempts + 1, ...(matched ? { consumed_at: dbNow } : {}) })
      .where("id", "=", challengeId)
      .execute();
    return matched ? challenge.user_id : null;
  });
  if (!userId) throw new HttpError(401, BAD_OTP);
  return userId;
}

// ---- Owner password, the stopgap for when SMS isn't available ----

export async function verifyOwnerPassword(ctx: Context, businessId: string, password: string, ip: string) {
  // The second limit counts every address, because there is no account name for a guesser to supply.
  await consumeLimits(ctx.db, ctx.secret, [
    { scope: "owner-login-ip", subject: ip, max: 10, seconds: 15 * MINUTE },
    { scope: "owner-login-all", subject: businessId, max: 30, seconds: 15 * MINUTE },
  ]);
  const owner = await ctx.db
    .selectFrom("users")
    .select(["id", "password_hash"])
    .where("business_id", "=", businessId)
    .where("role", "=", "owner")
    .where("status", "=", "active")
    .executeTakeFirst();
  const matched = await verifyPassword(owner?.password_hash ?? null, password);
  if (!owner || !matched) throw new HttpError(401, BAD_LOGIN);
  return owner.id;
}

// ---- Password login ----

export async function verifyPasswordLogin(
  ctx: Context,
  businessId: string,
  input: { role: Role; email: string; password: string; ip: string },
) {
  const email = normalizeEmail(input.email);
  await consumeLimits(ctx.db, ctx.secret, [
    { scope: "login-account", subject: email, max: 10, seconds: 15 * MINUTE },
    { scope: "login-ip", subject: input.ip, max: 100, seconds: HOUR },
  ]);
  const user = await ctx.db
    .selectFrom("users")
    .select(["id", "role", "status", "password_hash"])
    .where("business_id", "=", businessId)
    .where("email", "=", email)
    .executeTakeFirst();
  // Owners sign in by OTP only, and a role mismatch must look like any other failure.
  const eligible = user && user.status === "active" && user.role === input.role && user.role !== "owner";
  const matched = await verifyPassword(eligible ? user.password_hash : null, input.password);
  if (!eligible || !matched) throw new HttpError(401, BAD_LOGIN);
  return user.id;
}

// ---- Sessions ----

export async function createSession(ctx: Context, userId: string, previousToken?: string) {
  const user = await ctx.db
    .selectFrom("users")
    .select(["role", "business_id"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  const limits = SESSION_LIMITS[user.role];
  const token = randomToken();
  await ctx.db.transaction().execute(async (trx) => {
    // Login always issues a new ID, so a token planted before sign-in is useless afterwards.
    if (previousToken)
      await trx
        .updateTable("sessions")
        .set({ revoked_at: dbNow })
        .where("token_hash", "=", sha256(previousToken))
        .execute();
    await trx
      .insertInto("sessions")
      .values({
        token_hash: sha256(token),
        user_id: userId,
        idle_expires_at: dbNowPlus(limits.idle) as never,
        absolute_expires_at: dbNowPlus(limits.absolute) as never,
      })
      .execute();
    await trx.updateTable("users").set({ last_login_at: dbNow }).where("id", "=", userId).execute();
    await audit(trx, {
      businessId: user.business_id,
      actorUserId: userId,
      action: "auth.login",
      entityType: "user",
      entityId: userId,
    });
  });
  return { token, maxAgeSeconds: limits.absolute };
}

export async function lookupSession(ctx: Context, token: string): Promise<SessionUser | null> {
  const tokenHash = sha256(token);
  const row = await ctx.db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .leftJoin("resident_profiles as r", "r.user_id", "u.id")
    .leftJoin("corporate_memberships as m", "m.user_id", "u.id")
    .select([
      "u.id",
      "u.name",
      "u.role",
      "u.business_id",
      "s.last_seen_at",
      "r.id as resident_id",
      "m.corporate_id",
    ])
    .where("s.token_hash", "=", tokenHash)
    .where("s.revoked_at", "is", null)
    .where("s.idle_expires_at", ">", dbNow)
    .where("s.absolute_expires_at", ">", dbNow)
    .where("u.status", "=", "active")
    .executeTakeFirst();
  if (!row) return null;
  if (Date.now() - row.last_seen_at.getTime() > SESSION_TOUCH_INTERVAL_MS) {
    await ctx.db
      .updateTable("sessions")
      .set({ last_seen_at: dbNow, idle_expires_at: dbNowPlus(SESSION_LIMITS[row.role].idle) as never })
      .where("token_hash", "=", tokenHash)
      .execute();
  }
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    businessId: row.business_id,
    ...(row.role === "resident" && row.resident_id ? { residentId: row.resident_id } : {}),
    ...(row.role === "corporate" && row.corporate_id ? { corporateId: row.corporate_id } : {}),
  };
}

export async function revokeSession(ctx: Context, token: string) {
  await ctx.db
    .updateTable("sessions")
    .set({ revoked_at: dbNow })
    .where("token_hash", "=", sha256(token))
    .execute();
}

// ---- Invitations and recovery ----

/** Part of the caller's transaction. Deliver the link only after that transaction commits. */
export async function issuePasswordToken(trx: Trx, userId: string, purpose: "invite" | "recovery") {
  const token = randomToken();
  await trx
    .updateTable("password_tokens")
    .set({ used_at: dbNow })
    .where("user_id", "=", userId)
    .where("used_at", "is", null)
    .execute();
  await trx
    .insertInto("password_tokens")
    .values({
      token_hash: sha256(token),
      user_id: userId,
      purpose,
      expires_at: dbNowPlus(TOKEN_TTL[purpose]) as never,
    })
    .execute();
  return token;
}

export function deliverPasswordLink(
  ctx: Context,
  user: { email: string; name: string },
  purpose: "invite" | "recovery",
  token: string,
) {
  const url = `${ctx.frontendUrl}/set-password?token=${encodeURIComponent(token)}`;
  void ctx.providers.mail
    .sendPasswordLink({ to: user.email, name: user.name, purpose, url })
    .catch((err: unknown) => ctx.log.error({ err: safeError(err), purpose }, "Password link could not be sent"));
}

/** Always succeeds from the caller's point of view, so it can't confirm an account exists. */
export async function requestRecovery(ctx: Context, businessId: string, rawEmail: string, ip: string) {
  const email = normalizeEmail(rawEmail);
  await consumeLimits(ctx.db, ctx.secret, [
    { scope: "recover-account", subject: email, max: 3, seconds: HOUR },
    { scope: "recover-ip", subject: ip, max: 20, seconds: HOUR },
  ]);
  const user = await ctx.db
    .selectFrom("users")
    .select(["id", "name", "email", "role"])
    .where("business_id", "=", businessId)
    .where("email", "=", email)
    .where("status", "in", ["invited", "active"])
    .executeTakeFirst();
  // Owner recovery is the agreed manual process, not an emailed link.
  if (!user?.email || user.role === "owner") return;
  const token = await ctx.db.transaction().execute((trx) => issuePasswordToken(trx, user.id, "recovery"));
  deliverPasswordLink(ctx, { email: user.email, name: user.name }, "recovery", token);
}

export async function setPasswordWithToken(ctx: Context, token: string, password: string, ip: string) {
  assertPasswordPolicy(password);
  await consumeLimits(ctx.db, ctx.secret, [{ scope: "set-password-ip", subject: ip, max: 20, seconds: HOUR }]);
  // Hash first: Argon2 is deliberately slow and shouldn't run while a row is locked.
  const passwordHash = await hashPassword(password);
  await ctx.db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("password_tokens as t")
      .innerJoin("users as u", "u.id", "t.user_id")
      .select(["t.user_id", "t.purpose", "u.business_id", "u.status", "u.role"])
      .where("t.token_hash", "=", sha256(token))
      .where("t.used_at", "is", null)
      .where("t.expires_at", ">", dbNow)
      .forUpdate()
      .executeTakeFirst();
    if (!row || row.status === "disabled" || row.role === "owner") throw new HttpError(422, BAD_TOKEN);
    await trx
      .updateTable("password_tokens")
      .set({ used_at: dbNow })
      .where("token_hash", "=", sha256(token))
      .execute();
    await trx
      .updateTable("users")
      .set({ password_hash: passwordHash, status: "active", updated_at: dbNow })
      .where("id", "=", row.user_id)
      .execute();
    // Anyone signed in with the old password loses access now.
    await trx
      .updateTable("sessions")
      .set({ revoked_at: dbNow })
      .where("user_id", "=", row.user_id)
      .where("revoked_at", "is", null)
      .execute();
    await audit(trx, {
      businessId: row.business_id,
      actorUserId: row.user_id,
      action: row.purpose === "invite" ? "auth.invite_accepted" : "auth.password_recovered",
      entityType: "user",
      entityId: row.user_id,
    });
  });
}

/** Provider errors can echo the request, which may hold a code or link. Keep only the type and a code. */
function safeError(err: unknown) {
  const e = err as { name?: string; code?: string } | null;
  return { name: e?.name ?? "Error", code: e?.code };
}
