import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { sweepElapsedHolds } from "../src/modules/inventory/allocations.js";
import {
  addResident,
  call,
  createHarness,
  DATABASE_URL,
  loginOwner,
  loginPassword,
  tomorrow,
  type Harness,
} from "./helpers.js";

const PASSWORD = "a-long-enough-password";

describe.skipIf(!DATABASE_URL)("beds and holds", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(3);
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    await h.db.deleteFrom("rate_limits").execute();
  });
  afterEach(async () => {
    await h.db.deleteFrom("bed_allocations").execute();
    await h.db.deleteFrom("holds").execute();
    await h.db.deleteFrom("bookings").execute();
    await h.db.deleteFrom("idempotency_keys").execute();
    await h.db.updateTable("beds").set({ blocked: 0 }).execute();
  });

  const hold = (propertyId = h.propertyId, key: string = randomUUID(), moveIn = tomorrow(), ip?: string) =>
    call(h, "POST", "/holds", { body: { propertyId, sharing: "double", moveIn }, key, ip });

  const activeAllocations = () =>
    h.db.selectFrom("bed_allocations").select(["bed_id", "state"]).where("state", "=", "held").execute();

  it("holds a bed for 15 minutes of database time at the server's price", async () => {
    const response = await hold();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.amount).toBe(14299);
    const minutes = (new Date(body.expiresAt).getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(14.5);
    expect(minutes).toBeLessThanOrEqual(15.1);
    expect(await activeAllocations()).toHaveLength(1);
  });

  it("gives one winner when 20 requests compete for the last bed", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => hold(h.otherPropertyId, randomUUID(), tomorrow(), `198.51.100.${i}`)),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(19);
    expect(await activeAllocations()).toHaveLength(1);
  });

  it("never double-allocates a bed when 20 requests compete for 3 beds", async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => hold(h.propertyId, randomUUID(), tomorrow(), `198.51.100.${i}`)),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);
    const allocations = await activeAllocations();
    expect(new Set(allocations.map((a) => a.bed_id)).size).toBe(3);
  });

  it("replays the same result for a repeated key, even when sent concurrently", async () => {
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => hold(h.propertyId, key)));
    for (const r of results) expect(r.statusCode).toBe(200);
    expect(new Set(results.map((r) => r.json().id)).size).toBe(1);
    expect(await activeAllocations()).toHaveLength(1);
  });

  it("rejects a reused key with a different payload", async () => {
    const key = randomUUID();
    expect((await hold(h.propertyId, key)).statusCode).toBe(200);
    expect((await hold(h.otherPropertyId, key)).statusCode).toBe(422);
  });

  it("does not consume the key when the request fails", async () => {
    const key = randomUUID();
    await hold(h.otherPropertyId);
    expect((await hold(h.otherPropertyId, key)).statusCode).toBe(409);
    await h.db.deleteFrom("bed_allocations").execute();
    expect((await hold(h.otherPropertyId, key)).statusCode).toBe(200);
  });

  it("requires an idempotency key", async () => {
    const r = await call(h, "POST", "/holds", {
      body: { propertyId: h.propertyId, sharing: "double", moveIn: tomorrow() },
    });
    expect(r.statusCode).toBe(422);
  });

  it("frees an elapsed hold immediately, with no sweep having run", async () => {
    await hold(h.otherPropertyId);
    expect((await hold(h.otherPropertyId)).statusCode).toBe(409);
    await sql`UPDATE bed_allocations SET hold_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND`.execute(h.db);
    expect((await hold(h.otherPropertyId)).statusCode).toBe(200);
    const states = await h.db.selectFrom("holds").select("state").orderBy("created_at").execute();
    expect(states.map((s) => s.state)).toEqual(["expired", "active"]);
  });

  it("reports the expired bed as free in listings before any sweep", async () => {
    await hold(h.otherPropertyId);
    const left = async () => {
      const properties = (await call(h, "GET", "/properties")).json();
      return properties.find((p: { id: string }) => p.id === h.otherPropertyId).rooms.double.left;
    };
    expect(await left()).toBe(0);
    await sql`UPDATE bed_allocations SET hold_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND`.execute(h.db);
    expect(await left()).toBe(1);
  });

  it("marks elapsed holds and their bookings in the housekeeping sweep", async () => {
    await hold(h.propertyId);
    await sql`UPDATE bed_allocations SET hold_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND`.execute(h.db);
    expect(await sweepElapsedHolds(h.db)).toBe(1);
    expect(await activeAllocations()).toHaveLength(0);
    const booking = await h.db.selectFrom("bookings").select("state").executeTakeFirstOrThrow();
    expect(booking.state).toBe("expired");
  });

  it("does not let a future stay be overwritten by an earlier open-ended hold", async () => {
    const farOut = new Date(Date.now() + 40 * 86400 * 1000).toISOString().slice(0, 10);
    expect((await hold(h.otherPropertyId, randomUUID(), farOut)).statusCode).toBe(200);
    expect((await hold(h.otherPropertyId, randomUUID(), tomorrow())).statusCode).toBe(409);
  });

  it("allows a new stay on the day an earlier stay ends", async () => {
    await hold(h.otherPropertyId);
    const end = tomorrow();
    await sql`UPDATE bed_allocations SET stay_start = ${"2026-01-01"}, stay_end = ${end}`.execute(h.db);
    expect((await hold(h.otherPropertyId, randomUUID(), end)).statusCode).toBe(200);
  });

  it("rejects past dates and unknown properties", async () => {
    expect((await hold(h.propertyId, randomUUID(), "2020-01-01")).statusCode).toBe(422);
    expect((await hold(h.propertyId, randomUUID(), "2026-02-31")).statusCode).toBe(422);
    expect((await hold(randomUUID())).statusCode).toBe(404);
  });

  it("limits how many free holds one client can take", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await hold(h.propertyId, randomUUID(), tomorrow(), "192.0.2.77")).statusCode;
    expect(last).toBe(429);
  });

  describe("owner inventory", () => {
    it("blocks a free bed so it can't be held", async () => {
      const owner = await loginOwner(h);
      const beds = (await call(h, "GET", "/beds", { client: owner })).json();
      const bed = beds.find((b: { propertyId: string }) => b.propertyId === h.otherPropertyId);
      expect(bed.status).toBe("Available");
      const patch = await call(h, "PATCH", `/beds/${bed.id}`, {
        client: owner,
        body: { id: bed.id, status: "Blocked" },
      });
      expect(patch.statusCode).toBe(204);
      expect((await hold(h.otherPropertyId)).statusCode).toBe(409);
    });

    it("refuses to block a bed with a live hold, and shows it as held", async () => {
      const owner = await loginOwner(h);
      await hold(h.otherPropertyId);
      const beds = (await call(h, "GET", "/beds", { client: owner })).json();
      const bed = beds.find((b: { propertyId: string }) => b.propertyId === h.otherPropertyId);
      const patch = await call(h, "PATCH", `/beds/${bed.id}`, { client: owner, body: { status: "Blocked" } });
      expect(patch.statusCode).toBe(409);
    });

    it("edits only allowlisted property fields", async () => {
      const owner = await loginOwner(h);
      const patch = await call(h, "PATCH", `/properties/${h.propertyId}`, {
        client: owner,
        body: { id: h.propertyId, blurb: "Updated blurb", rating: 1, business_id: randomUUID() },
      });
      expect(patch.statusCode).toBe(204);
      const row = await h.db.selectFrom("properties").selectAll().where("id", "=", h.propertyId).executeTakeFirstOrThrow();
      expect(row.blurb).toBe("Updated blurb");
      expect(Number(row.rating)).toBe(4.5);
      expect(row.business_id).toBe(h.businessId);
    });
  });

  describe("access control", () => {
    it("rejects anonymous callers on every owner and portal route", async () => {
      const id = randomUUID();
      const attempts = await Promise.all([
        call(h, "GET", "/beds"),
        call(h, "GET", "/portal"),
        call(h, "PATCH", `/beds/${id}`, { body: { status: "Blocked" } }),
        call(h, "PATCH", `/properties/${id}`, { body: { name: "x" } }),
        call(h, "POST", "/residents", { body: {} }),
        call(h, "PATCH", `/residents/${id}`, { body: { name: "x" } }),
      ]);
      for (const a of attempts) expect(a.statusCode).toBe(401);
    });

    it("forbids a resident from owner routes", async () => {
      await addResident(h, "plain@example.com", PASSWORD);
      const client = await loginPassword(h, "plain@example.com", PASSWORD);
      const attempts = await Promise.all([
        call(h, "GET", "/beds", { client }),
        call(h, "PATCH", `/properties/${h.propertyId}`, { client, body: { name: "Hacked" } }),
        call(h, "POST", "/residents", { client, body: {} }),
      ]);
      for (const a of attempts) expect(a.statusCode).toBe(403);
    });

    it("shows a resident only their own record", async () => {
      const mine = await addResident(h, "mine@example.com", PASSWORD);
      const theirs = await addResident(h, "theirs@example.com", PASSWORD);
      const client = await loginPassword(h, "mine@example.com", PASSWORD);
      const portal = (await call(h, "GET", "/portal", { client })).json();
      expect(portal.residents.map((r: { id: string }) => r.id)).toEqual([mine.residentId]);
      expect(JSON.stringify(portal)).not.toContain(theirs.residentId);
      expect(portal.beds).toBeUndefined();
      const edit = await call(h, "PATCH", `/residents/${theirs.residentId}`, { client, body: { name: "Hacked" } });
      expect(edit.statusCode).toBe(403);
    });

    it("shows a company only its own employees", async () => {
      const corporateId = randomUUID();
      const other = randomUUID();
      for (const id of [corporateId, other])
        await h.db.insertInto("corporate_accounts").values({ id, business_id: h.businessId, name: id }).execute();
      const contact = await addResident(h, "contact@example.com", PASSWORD);
      await h.db.updateTable("users").set({ role: "corporate" }).where("id", "=", contact.userId).execute();
      await h.db.deleteFrom("resident_profiles").where("id", "=", contact.residentId).execute();
      await h.db.insertInto("corporate_memberships").values({ user_id: contact.userId, corporate_id: corporateId }).execute();
      const employee = await addResident(h, "employee@example.com", PASSWORD);
      const stranger = await addResident(h, "stranger@example.com", PASSWORD);
      await h.db.updateTable("resident_profiles").set({ corporate_id: corporateId }).where("id", "=", employee.residentId).execute();
      await h.db.updateTable("resident_profiles").set({ corporate_id: other }).where("id", "=", stranger.residentId).execute();
      const client = await loginPassword(h, "contact@example.com", PASSWORD, "corporate");
      const portal = (await call(h, "GET", "/portal", { client })).json();
      expect(portal.residents.map((r: { id: string }) => r.id)).toEqual([employee.residentId]);
    });
  });
});
