import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { Algorithm, hash, verify } from "@node-rs/argon2";

// OWASP's recommended minimum for Argon2id.
const ARGON2 = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string) => hash(password, ARGON2);

// Verified when no account matches, so a login takes the same time for known and unknown emails.
const DUMMY_HASH = hashPassword(randomBytes(32).toString("hex"));

export async function verifyPassword(storedHash: string | null, password: string) {
  try {
    const matched = await verify(storedHash ?? (await DUMMY_HASH), password);
    return matched && storedHash !== null;
  } catch {
    return false;
  }
}

export const randomToken = () => randomBytes(32).toString("base64url");
export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const hmac = (secret: string, value: string) => createHmac("sha256", secret).update(value).digest("hex");
export const generateOtp = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

export function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export const otpHmac = (secret: string, challengeId: string, code: string) =>
  hmac(secret, `otp:${challengeId}:${code}`);

/** Derived from the session token, so it needs no storage and dies with the session. */
export const csrfTokenFor = (secret: string, sessionToken: string) => hmac(secret, `csrf:${sessionToken}`);
