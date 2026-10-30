import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createDb, type Db } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { hashPassword } from "../src/modules/identity/crypto.js";
import type { Providers } from "../src/providers/index.js";

/** These suites need a real MySQL 8 because locking behaviour is exactly what they prove. */
export const DATABASE_URL = process.env.TEST_DATABASE_URL;
export const ORIGIN = "http://localhost:5173";

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
    ...env,
  });

const TABLES = [
  "bed_allocations", "holds", "bookings", "resident_profiles", "corporate_memberships", "corporate_accounts",
  "beds", "rooms", "property_rates", "properties", "audit_events", "idempotency_keys", "jobs", "rate_limits",
  "password_tokens", "otp_challenges", "sessions", "users", "businesses",
];

export interface Sent {
  otps: { phone: string; code: string }[];
  links: { to: string; purpose: string; url: string }[];
}

export interface Harness {
  app: FastifyInstance;
  db: Db;
  sent: Sent;
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
  const providers: Providers = {
    sms: { sendOtp: async (phone, code) => void sent.otps.push({ phone, code }) },
    mail: {
      sendPasswordLink: async ({ to, purpose, url }) => void sent.links.push({ to, purpose, url }),
    },
  };
  const app = await buildApp({ config, db, providers, logger: false });
  return {
    app,
    db,
    sent,
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
