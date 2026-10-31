import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { migrationChecksum } from "../src/db/migrate.js";
import { createProviders } from "../src/providers/index.js";
import { HttpError } from "../src/http/errors.js";
import {
  csrfTokenFor,
  generateOtp,
  hashPassword,
  otpHmac,
  verifyPassword,
} from "../src/modules/identity/crypto.js";
import { assertPasswordPolicy, normalizeEmail, normalizePhone } from "../src/modules/identity/service.js";
import { assertMoveInDate } from "../src/modules/inventory/allocations.js";
import { addDays, businessToday, isCalendarDate } from "../src/shared/dates.js";
import { requireIdempotencyKey } from "../src/shared/idempotency.js";
import { paiseToRupees, rupeesToPaise } from "../src/shared/money.js";

const baseEnv = {
  DATABASE_URL: "mysql://u:p@db.example.com:3306/app",
  AUTH_SECRET: "x".repeat(32),
  FRONTEND_ORIGINS: "https://app.example.com",
  FRONTEND_URL: "https://app.example.com",
};

describe("money", () => {
  it("converts rupees to integer paise without float drift", () => {
    expect(rupeesToPaise(14299)).toBe(1429900);
    expect(rupeesToPaise(14299.99)).toBe(1429999);
    expect(rupeesToPaise(0.07)).toBe(7);
    expect(paiseToRupees(1429999)).toBe(14299.99);
  });
  it("rejects zero, negatives and fractions of a paisa", () => {
    for (const bad of [0, -1, 10.001, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => rupeesToPaise(bad)).toThrow(HttpError);
  });
});

describe("dates", () => {
  it("uses Indian business dates, not UTC", () => {
    expect(businessToday(new Date("2026-10-30T19:00:00Z"))).toBe("2026-10-31");
    expect(businessToday(new Date("2026-10-30T18:00:00Z"))).toBe("2026-10-30");
  });
  it("rejects impossible calendar dates", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2026-02-31")).toBe(false);
    expect(isCalendarDate("31-01-2026")).toBe(false);
  });
  it("limits how far ahead a move-in can be", () => {
    expect(() => assertMoveInDate("2026-10-29", "2026-10-30")).toThrow(HttpError);
    expect(() => assertMoveInDate("2026-10-30", "2026-10-30")).not.toThrow();
    expect(() => assertMoveInDate(addDays("2026-10-30", 180), "2026-10-30")).not.toThrow();
    expect(() => assertMoveInDate(addDays("2026-10-30", 181), "2026-10-30")).toThrow(HttpError);
  });
});

describe("contact normalization", () => {
  it("stores one form of an Indian mobile number", () => {
    for (const typed of ["9876543210", "+91 98765 43210", "09876543210", "91-9876543210"])
      expect(normalizePhone(typed)).toBe("+919876543210");
  });
  it("rejects anything else", () => {
    for (const bad of ["12345", "1234567890", "+1 415 555 0100", "98765432101"])
      expect(() => normalizePhone(bad)).toThrow(HttpError);
  });
  it("lowercases email", () => {
    expect(normalizeEmail("  Rohit@Example.COM ")).toBe("rohit@example.com");
  });
});

describe("credentials", () => {
  it("hashes with Argon2id and verifies only the right password", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(stored, "correct horse battery")).toBe(true);
    expect(await verifyPassword(stored, "wrong horse battery")).toBe(false);
  });
  it("never accepts a password for an account with no hash", async () => {
    expect(await verifyPassword(null, "anything at all")).toBe(false);
  });
  it("enforces the password length policy", () => {
    expect(() => assertPasswordPolicy("short")).toThrow(HttpError);
    expect(() => assertPasswordPolicy("x".repeat(129))).toThrow(HttpError);
    expect(() => assertPasswordPolicy("x".repeat(12))).not.toThrow();
  });
  it("generates six-digit codes bound to one challenge", () => {
    for (let i = 0; i < 200; i++) expect(generateOtp()).toMatch(/^\d{6}$/);
    expect(otpHmac("s", "a", "123456")).not.toBe(otpHmac("s", "b", "123456"));
  });
  it("derives a different CSRF token for each session and secret", () => {
    expect(csrfTokenFor("s", "one")).not.toBe(csrfTokenFor("s", "two"));
    expect(csrfTokenFor("s", "one")).not.toBe(csrfTokenFor("t", "one"));
  });
});

describe("idempotency keys", () => {
  it("accepts only UUIDs", () => {
    expect(requireIdempotencyKey("7C9E6679-7425-40DE-944B-E07FC1F90AE7")).toBe(
      "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    );
    expect(() => requireIdempotencyKey("abc")).toThrow(HttpError);
    expect(() => requireIdempotencyKey(undefined)).toThrow(HttpError);
  });
});

describe("account settings", () => {
  it("requires email verification unless explicitly turned off", () => {
    expect(loadConfig(baseEnv).requireEmailVerification).toBe(true);
    expect(loadConfig({ ...baseEnv, REQUIRE_EMAIL_VERIFICATION: "flase" }).requireEmailVerification).toBe(true);
    expect(loadConfig({ ...baseEnv, REQUIRE_EMAIL_VERIFICATION: "False" }).requireEmailVerification).toBe(false);
  });
  it("needs a key and sender for a real mail provider", () => {
    expect(() => loadConfig({ ...baseEnv, MAIL_PROVIDER: "brevo" })).toThrow(/MAIL_FROM/);
    expect(() => loadConfig({ ...baseEnv, MAIL_PROVIDER: "resend", RESEND_API_KEY: "k" })).toThrow(/MAIL_FROM/);
    expect(loadConfig({ ...baseEnv, MAIL_PROVIDER: "brevo", BREVO_API_KEY: "k", MAIL_FROM: "a@b.c" }).mail.apiKey).toBe("k");
  });
  it("leaves Google off until it is fully configured", () => {
    expect(loadConfig({ ...baseEnv, GOOGLE_CLIENT_ID: "id" }).google).toBeNull();
    const on = { ...baseEnv, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", API_URL: "https://api.example.com/" };
    expect(loadConfig(on).google?.redirectUri).toBe("https://api.example.com/api/v1/auth/google/callback");
  });
});

describe("mail providers", () => {
  const brevo = loadConfig({ ...baseEnv, MAIL_PROVIDER: "brevo", BREVO_API_KEY: "key", MAIL_FROM: "a@b.c" });
  const message = { to: "x@example.com", name: "X", purpose: "verify" as const, url: "https://a.example/v?a=1&b=2" };
  it("sends the link through the provider with its key", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await createProviders(brevo).mail.sendPasswordLink(message);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("key");
    expect(String(init.body)).toContain("https://a.example/v?a=1&#38;b=2");
    vi.unstubAllGlobals();
  });
  it("fails without repeating the provider's response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("secret link", { status: 400 })));
    const error = await createProviders(brevo).mail.sendPasswordLink(message).catch((e: Error) => e);
    expect(String(error)).not.toContain("secret link");
    expect((error as { code?: string }).code).toBe("400");
    vi.unstubAllGlobals();
  });
});

describe("migration checksums", () => {
  it("match across Windows and Linux line endings", () => {
    expect(migrationChecksum("CREATE TABLE a;\r\nCREATE TABLE b;\r\n")).toBe(
      migrationChecksum("CREATE TABLE a;\nCREATE TABLE b;\n"),
    );
  });
  it("still notice a real edit", () => {
    expect(migrationChecksum("CREATE TABLE a;\n")).not.toBe(migrationChecksum("CREATE TABLE b;\n"));
  });
});

describe("configuration", () => {
  it("names bad settings without printing secret values", () => {
    expect(() => loadConfig({ ...baseEnv, AUTH_SECRET: "too-short-secret-value" })).toThrow(/AUTH_SECRET/);
    expect(() => loadConfig({ ...baseEnv, AUTH_SECRET: "too-short-secret-value" })).not.toThrow(/too-short/);
  });
  it("refuses wildcard origins", () => {
    expect(() => loadConfig({ ...baseEnv, FRONTEND_ORIGINS: "*" })).toThrow(/exact/);
  });
  it("refuses production without verified database TLS", () => {
    const production = { ...baseEnv, NODE_ENV: "production" };
    expect(() => loadConfig({ ...production, DB_TLS: "off" })).toThrow(/DB_TLS/);
    expect(() => loadConfig(production)).toThrow(/DB_CA_CERT/);
  });
  it("refuses production with the dev SMS and mail printers", () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: "production", DB_CA_CERT: "pem" })).toThrow(/dev SMS/);
  });
  it("allows the log providers in production only when chosen by name", () => {
    const production = { ...baseEnv, NODE_ENV: "production", DB_CA_CERT: "pem" };
    const chosen = loadConfig({ ...production, SMS_PROVIDER: "log", MAIL_PROVIDER: "log" });
    expect(chosen.logsAuthSecrets).toBe(true);
    expect(() => loadConfig({ ...production, SMS_PROVIDER: "log" })).toThrow(/dev SMS/);
    expect(() => loadConfig({ ...production, SMS_PROVIDER: "other", MAIL_PROVIDER: "log" })).toThrow(/SMS_PROVIDER/);
  });
});
