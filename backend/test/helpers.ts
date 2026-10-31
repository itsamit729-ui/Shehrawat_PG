import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { buildApp, createContext } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, dbNow, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { hashPassword } from "../src/modules/identity/crypto.js";
import type { Context } from "../src/modules/identity/service.js";
import type { GoogleProfile, PaymentLink, Providers } from "../src/providers/index.js";

/** These suites need a real MySQL 8 because locking behaviour is exactly what they prove. */
export const DATABASE_URL = process.env.TEST_DATABASE_URL;
export const ORIGIN = "http://localhost:5173";
export const WEBHOOK_SECRET = "test-webhook-secret";

export const testConfig = (env: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: DATABASE_URL!,
    DB_TLS: process.env.TEST_DB_TLS ?? "off",
    DB_CA_CERT: process.env.TEST_DB_CA_CERT ?? "",
    DB_POOL_SIZE: "10",
    AUTH_SECRET: "test-secret-".repeat(4),
    FRONTEND_ORIGINS: ORIGIN,
    FRONTEND_URL: ORIGIN,
    TRUST_PROXY_HOPS: "0",
    REQUIRE_EMAIL_VERIFICATION: "false",
    RAZORPAY_KEY_ID: "rzp_test",
    RAZORPAY_KEY_SECRET: "test-key-secret",
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    WHATSAPP_TOKEN: "test-token",
    WHATSAPP_PHONE_NUMBER_ID: "1",
    WHATSAPP_BUSINESS_ACCOUNT_ID: "2",
    WHATSAPP_APP_SECRET: WEBHOOK_SECRET,
    WHATSAPP_VERIFY_TOKEN: "test-verify",
    ...env,
  });

const TABLES = [
  "campaign_recipients", "campaigns", "messages", "conversations", "contacts", "agreements", "uploads",
  "service_requests", "leads", "tickets", "webhook_inbox", "expenses", "ledger_entries", "refunds",
  "payment_applications", "payments", "payment_orders", "invoice_lines", "invoices", "business_settings",
  "bed_allocations", "holds", "bookings", "resident_profiles", "corporate_memberships", "corporate_accounts",
  "beds", "rooms", "property_rates", "properties", "audit_events", "idempotency_keys", "jobs", "rate_limits",
  "password_tokens", "otp_challenges", "sessions", "google_identities", "users", "businesses",
];

export interface Sent {
  otps: { phone: string; code: string }[];
  links: { to: string; purpose: string; url: string }[];
}

/** What the fake providers were asked to do, and how to make them misbehave. */
export interface Fakes {
  links: { referenceId: string; amountPaise: number; expiresInSeconds?: number }[];
  linkPayments: Record<string, PaymentLink["payments"]>;
  loseNextLinkResponse: boolean;
  refunds: { paymentId: string; amountPaise: number; receipt: string }[];
  refundResult: () => Promise<{ id: string; status: string }>;
  whatsapp: { to: string; body?: string; template?: string }[];
  approvedTemplates: Set<string>;
  stored: Record<string, Buffer>;
}

export interface Harness {
  ctx: Context;
  fakes: Fakes;
  app: FastifyInstance;
  db: Db;
  sent: Sent;
  googleProfiles: Record<string, GoogleProfile>;
  businessId: string;
  ownerId: string;
  ownerPhone: string;
  propertyId: string;
  otherPropertyId: string;
  close(): Promise<void>;
}

export const flush = () => new Promise((r) => setTimeout(r, 25));

/** Wipes the test database and builds an app with one owner, and one property with `beds` double beds. */
export async function createHarness(beds = 3, env: Record<string, string> = {}): Promise<Harness> {
  const config = testConfig(env);
  await migrate(config.db);
  const db = createDb(config.db);
  for (const table of TABLES) await sql`DELETE FROM ${sql.table(table)}`.execute(db);

  const businessId = randomUUID();
  const ownerId = randomUUID();
  const ownerPhone = "+919876543210";
  await db.insertInto("businesses").values({ id: businessId, slug: config.businessSlug, name: "Test PG" }).execute();
  await db
    .insertInto("users")
    .values({
      id: ownerId,
      business_id: businessId,
      role: "owner",
      status: "active",
      name: "Owner",
      email: null,
      phone: ownerPhone,
      password_hash: null,
    })
    .execute();
  const propertyId = await addProperty(db, businessId, "Home One", beds);
  const otherPropertyId = await addProperty(db, businessId, "Home Two", 1);

  const sent: Sent = { otps: [], links: [] };
  const googleProfiles: Record<string, GoogleProfile> = {};
  const fakes: Fakes = {
    links: [],
    linkPayments: {},
    loseNextLinkResponse: false,
    refunds: [],
    refundResult: async () => ({ id: `rfnd_${fakes.refunds.length}`, status: "pending" }),
    whatsapp: [],
    approvedTemplates: new Set(),
    stored: {},
  };
  const linkFor = (referenceId: string): PaymentLink => ({
    id: `plink_${referenceId}`,
    url: `https://rzp.test/${referenceId}`,
    status: "created",
    payments: fakes.linkPayments[referenceId] ?? [],
  });
  const providers: Providers = {
    payments: {
      createPaymentLink: async (input) => {
        fakes.links.push(input);
        if (fakes.loseNextLinkResponse) {
          fakes.loseNextLinkResponse = false;
          throw new Error("Connection reset");
        }
        return linkFor(input.referenceId);
      },
      findPaymentLink: async (referenceId) =>
        fakes.links.some((l) => l.referenceId === referenceId) ? linkFor(referenceId) : null,
      fetchPaymentLink: async (id) => linkFor(id.replace("plink_", "")),
      refund: async (input) => {
        fakes.refunds.push(input);
        return fakes.refundResult();
      },
    },
    whatsapp: {
      sendText: async (to, body) => {
        fakes.whatsapp.push({ to, body });
        return { id: `wamid.out${fakes.whatsapp.length}` };
      },
      sendTemplate: async (to, template) => {
        fakes.whatsapp.push({ to, template });
        return { id: `wamid.out${fakes.whatsapp.length}` };
      },
      templateApproved: async (name) => fakes.approvedTemplates.has(name),
    },
    storage: {
      presignPut: async (key) => `https://storage.test/put/${key}`,
      presignGet: async (key) => `https://storage.test/get/${key}`,
      head: async (key) =>
        fakes.stored[key] ? { size: fakes.stored[key].length, contentType: "application/octet-stream" } : null,
      readStart: async (key, bytes) => fakes.stored[key]!.subarray(0, bytes),
      remove: async (key) => void delete fakes.stored[key],
    },
    sms: { sendOtp: async (phone, code) => void sent.otps.push({ phone, code }) },
    mail: {
      sendPasswordLink: async ({ to, purpose, url }) => void sent.links.push({ to, purpose, url }),
    },
    google: {
      exchangeCode: async (code) => {
        const profile = googleProfiles[code];
        if (!profile) throw new Error("Unknown code");
        return profile;
      },
    },
  };
  const app = await buildApp({ config, db, providers, logger: false });
  return {
    ctx: createContext(config, db, providers, app.log),
    fakes,
    app,
    db,
    sent,
    googleProfiles,
    businessId,
    ownerId,
    ownerPhone,
    propertyId,
    otherPropertyId,
    close: async () => {
      await app.close();
      await db.destroy();
    },
  };
}

export async function addProperty(db: Db, businessId: string, name: string, bedCount: number) {
  const propertyId = randomUUID();
  await db
    .insertInto("properties")
    .values({
      id: propertyId,
      business_id: businessId,
      name,
      area: "Sector 1",
      sector: "Near metro",
      gender: "Unisex",
      audience: "Everyone",
      food: 1,
      ac: 0,
      rating: 4.5,
      reviews: 10,
      img: "/images/room.jpg",
      gallery: "[]",
      landmarks: "[]",
      amenities: "[]",
      blurb: "A test home",
    })
    .execute();
  await db
    .insertInto("property_rates")
    .values({ property_id: propertyId, sharing: "double", monthly_rent_paise: 1429900 })
    .execute();
  const roomId = randomUUID();
  await db
    .insertInto("rooms")
    .values({ id: roomId, business_id: businessId, property_id: propertyId, code: "101", sharing: "double" })
    .execute();
  for (let i = 0; i < bedCount; i++)
    await db
      .insertInto("beds")
      .values({ id: randomUUID(), business_id: businessId, room_id: roomId, code: String.fromCharCode(65 + i) })
      .execute();
  return propertyId;
}

/** Adds an active password-based account directly, for tests about what that account may see. */
export async function addResident(h: Harness, email: string, password: string, propertyId = h.propertyId) {
  const userId = randomUUID();
  const residentId = randomUUID();
  await h.db
    .insertInto("users")
    .values({
      id: userId,
      business_id: h.businessId,
      role: "resident",
      status: "active",
      name: email.split("@")[0]!,
      email,
      phone: null,
      password_hash: await hashPassword(password),
      email_verified_at: dbNow as never,
    })
    .execute();
  await h.db
    .insertInto("resident_profiles")
    .values({
      id: residentId,
      business_id: h.businessId,
      user_id: userId,
      corporate_id: null,
      property_id: propertyId,
      room_label: "101A",
      monthly_rent_paise: 1429900,
      status: "Active",
      joined_on: "2026-01-01",
    })
    .execute();
  return { userId, residentId };
}

export interface Client {
  cookie?: string;
  csrf?: string;
}

interface CallOptions {
  body?: unknown;
  client?: Client;
  origin?: string | null;
  key?: string;
  csrf?: string;
  ip?: string;
}

export async function call(h: Harness, method: "GET" | "POST" | "PATCH", path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = {};
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  if (opts.client?.cookie) headers.cookie = opts.client.cookie;
  const csrf = opts.csrf ?? opts.client?.csrf;
  if (csrf) headers["x-csrf-token"] = csrf;
  if (opts.key) headers["idempotency-key"] = opts.key;
  return h.app.inject({
    method,
    url: "/api/v1" + path,
    headers,
    remoteAddress: opts.ip ?? "203.0.113.1",
    ...(opts.body !== undefined ? { payload: opts.body as object } : {}),
  });
}

function clientFrom(response: Awaited<ReturnType<typeof call>>): Client {
  const cookie = response.cookies.find((c) => c.name === "sg_session");
  return { cookie: `sg_session=${cookie?.value}`, csrf: response.json().csrfToken };
}

export async function loginOwner(h: Harness) {
  const request = await call(h, "POST", "/auth/otp/request", { body: { phone: h.ownerPhone } });
  await flush();
  const code = h.sent.otps.at(-1)!.code;
  const login = await call(h, "POST", "/auth/login", {
    body: { role: "owner", challengeId: request.json().challengeId, otp: code },
  });
  if (login.statusCode !== 200) throw new Error(`Owner login failed: ${login.body}`);
  // Each test signs in fresh, so the cooldown from this login must not leak into the next.
  await h.db.deleteFrom("rate_limits").execute();
  return clientFrom(login);
}

export async function loginPassword(h: Harness, email: string, password: string, role = "resident") {
  const login = await call(h, "POST", "/auth/login", { body: { role, email, password } });
  if (login.statusCode !== 200) throw new Error(`Login failed: ${login.body}`);
  return clientFrom(login);
}

export const tomorrow = () => new Date(Date.now() + 36 * 3600 * 1000).toISOString().slice(0, 10);
