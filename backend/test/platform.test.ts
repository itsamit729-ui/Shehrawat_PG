import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { FastifyBaseLogger } from "fastify";
import { migrate } from "../src/db/migrate.js";
import { scheduleHousekeeping } from "../src/jobs/housekeeping.js";
import { claimJobs, enqueueJob, runDueJobs } from "../src/jobs/runner.js";
import { seedSampleInventory } from "../src/cli/seed-dev.js";
import { call, createHarness, DATABASE_URL, testConfig, type Harness } from "./helpers.js";

const silent = { error() {} } as unknown as FastifyBaseLogger;

describe.skipIf(!DATABASE_URL)("platform", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(1);
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    await h.db.deleteFrom("jobs").execute();
  });

  it("applies nothing on a second migration run", async () => {
    expect(await migrate(testConfig().db)).toEqual([]);
  });

  it("allows only one owner per business", async () => {
    await expect(
      h.db
        .insertInto("users")
        .values({
          id: crypto.randomUUID(),
          business_id: h.businessId,
          role: "owner",
          status: "active",
          name: "Second owner",
          email: null,
          phone: "+919811122233",
          password_hash: null,
        })
        .execute(),
    ).rejects.toThrow();
  });

  it("reports readiness only with a working database", async () => {
    expect((await h.app.inject({ url: "/healthz" })).statusCode).toBe(200);
    expect((await h.app.inject({ url: "/readyz" })).statusCode).toBe(200);
  });

  it("returns properties in the shape the frontend reads", async () => {
    const [property] = (await call(h, "GET", "/properties")).json();
    expect(property).toMatchObject({
      name: expect.any(String),
      food: true,
      ac: false,
      rating: 4.5,
      gallery: [],
      beds: expect.any(Number),
      rooms: { double: { price: 14299, left: expect.any(Number) } },
    });
    expect(property.business_id).toBeUndefined();
  });

  describe("job queue", () => {
    it("schedules each housekeeping occurrence once", async () => {
      const now = Date.now();
      await scheduleHousekeeping(h.db, now);
      await scheduleHousekeeping(h.db, now);
      const rows = await h.db.selectFrom("jobs").select("id").execute();
      expect(rows).toHaveLength(1);
    });

    it("never gives one job to two concurrent claimers", async () => {
      for (let i = 0; i < 6; i++) await enqueueJob(h.db, { kind: "noop", dedupeKey: String(i) });
      const claims = await Promise.all([claimJobs(h.db, 4), claimJobs(h.db, 4), claimJobs(h.db, 4)]);
      const ids = claims.flat().map((j) => j.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(6);
    });

    it("reclaims a job whose process died mid-run", async () => {
      await enqueueJob(h.db, { kind: "noop", dedupeKey: "crash" });
      expect(await claimJobs(h.db, 1)).toHaveLength(1);
      expect(await claimJobs(h.db, 1)).toHaveLength(0);
      await sql`UPDATE jobs SET lease_expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND`.execute(h.db);
      const [again] = await claimJobs(h.db, 1);
      expect(again?.attempts).toBe(2);
    });

    it("retries a failure later, then retires it as dead", async () => {
      await enqueueJob(h.db, { kind: "boom", dedupeKey: "x" });
      await sql`UPDATE jobs SET max_attempts = 2`.execute(h.db);
      const handlers = {
        boom: async () => {
          throw new Error("provider down");
        },
      };
      await runDueJobs(h.db, handlers, silent);
      let job = await h.db.selectFrom("jobs").selectAll().executeTakeFirstOrThrow();
      expect(job.state).toBe("queued");
      expect(job.run_at.getTime()).toBeGreaterThan(Date.now());
      expect(job.last_error).toBe("provider down");
      await sql`UPDATE jobs SET run_at = UTC_TIMESTAMP(6)`.execute(h.db);
      await runDueJobs(h.db, handlers, silent);
      job = await h.db.selectFrom("jobs").selectAll().executeTakeFirstOrThrow();
      expect(job.state).toBe("dead");
    });

    it("completes a successful job", async () => {
      await enqueueJob(h.db, { kind: "ok", dedupeKey: "y", payload: { a: 1 } });
      let seen: unknown;
      await runDueJobs(h.db, { ok: async (payload) => void (seen = payload) }, silent);
      expect(seen).toEqual({ a: 1 });
      const job = await h.db.selectFrom("jobs").selectAll().executeTakeFirstOrThrow();
      expect(job.state).toBe("done");
    });
  });

  it("seeds exactly 500 sample beds across six homes", async () => {
    const business = crypto.randomUUID();
    await h.db.insertInto("businesses").values({ id: business, slug: "seed-test", name: "Seed" }).execute();
    expect(await seedSampleInventory(h.db, business)).toBe(6);
    const beds = await h.db.selectFrom("beds").select(sql<number>`COUNT(*)`.as("n")).where("business_id", "=", business).executeTakeFirstOrThrow();
    expect(Number(beds.n)).toBe(500);
  });
});
