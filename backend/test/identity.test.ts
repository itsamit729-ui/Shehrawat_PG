import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { sha256 } from "../src/modules/identity/crypto.js";
import {
  addResident,
  call,
  createHarness,
  DATABASE_URL,
  flush,
  loginOwner,
  loginPassword,
  ORIGIN,
  type Harness,
} from "./helpers.js";

const PASSWORD = "a-long-enough-password";

describe.skipIf(!DATABASE_URL)("identity", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    await h.db.deleteFrom("rate_limits").execute();
    await h.db.deleteFrom("otp_challenges").execute();
    h.sent.otps.length = 0;
    h.sent.links.length = 0;
  });

  async function requestOtp(phone = h.ownerPhone) {
    const response = await call(h, "POST", "/auth/otp/request", { body: { phone } });
    await flush();
    return response;
  }

  describe("owner OTP", () => {
    it("signs in with the right code and returns a session the frontend can use", async () => {
      const challengeId = (await requestOtp()).json().challengeId;
      const login = await call(h, "POST", "/auth/login", {
        body: { role: "owner", challengeId, otp: h.sent.otps[0]!.code },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().user).toMatchObject({ id: h.ownerId, role: "owner" });
      expect(login.json().user.businessId).toBeUndefined();
      const cookie = login.cookies.find((c) => c.name === "sg_session")!;
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.sameSite).toBe("Lax");
      const session = await call(h, "GET", "/auth/session", {
        client: { cookie: `sg_session=${cookie.value}` },
      });
      expect(session.json().csrfToken).toBe(login.json().csrfToken);
    });

    it("answers identically for an unknown phone and sends nothing", async () => {
      const unknown = await requestOtp("9000000000");
      expect(unknown.statusCode).toBe(200);
      expect(unknown.json().challengeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(h.sent.otps).toHaveLength(0);
      const login = await call(h, "POST", "/auth/login", {
        body: { role: "owner", challengeId: unknown.json().challengeId, otp: "123456" },
      });
      expect(login.statusCode).toBe(401);
    });

    it("stores only a keyed hash of the code", async () => {
      const challengeId = (await requestOtp()).json().challengeId;
      const row = await h.db.selectFrom("otp_challenges").selectAll().where("id", "=", challengeId).executeTakeFirstOrThrow();
      expect(row.code_hmac).not.toContain(h.sent.otps[0]!.code);
      expect(row.code_hmac).toHaveLength(64);
    });

    it("rejects an expired code", async () => {
      const challengeId = (await requestOtp()).json().challengeId;
      await sql`UPDATE otp_challenges SET expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE id = ${challengeId}`.execute(h.db);
      const login = await call(h, "POST", "/auth/login", {
        body: { role: "owner", challengeId, otp: h.sent.otps[0]!.code },
      });
      expect(login.statusCode).toBe(401);
    });

    it("stops accepting even the right code after five wrong attempts", async () => {
      const challengeId = (await requestOtp()).json().challengeId;
      const code = h.sent.otps[0]!.code;
      const wrong = code === "000000" ? "000001" : "000000";
      for (let i = 0; i < 5; i++) {
        const attempt = await call(h, "POST", "/auth/login", { body: { role: "owner", challengeId, otp: wrong } });
        expect(attempt.statusCode).toBe(401);
      }
      const login = await call(h, "POST", "/auth/login", { body: { role: "owner", challengeId, otp: code } });
      expect(login.statusCode).toBe(401);
    });

    it("works only once", async () => {
      const challengeId = (await requestOtp()).json().challengeId;
      const body = { role: "owner", challengeId, otp: h.sent.otps[0]!.code };
      expect((await call(h, "POST", "/auth/login", { body })).statusCode).toBe(200);
      expect((await call(h, "POST", "/auth/login", { body })).statusCode).toBe(401);
    });

    it("invalidates the previous code when a new one is requested", async () => {
      const first = (await requestOtp()).json().challengeId;
      const firstCode = h.sent.otps[0]!.code;
      await h.db.deleteFrom("rate_limits").execute();
      await requestOtp();
      const login = await call(h, "POST", "/auth/login", {
        body: { role: "owner", challengeId: first, otp: firstCode },
      });
      expect(login.statusCode).toBe(401);
    });

    it("allows one send per 60 seconds, for known and unknown phones alike", async () => {
      expect((await requestOtp()).statusCode).toBe(200);
      expect((await requestOtp()).statusCode).toBe(429);
      expect((await requestOtp("9000000000")).statusCode).toBe(200);
      expect((await requestOtp("9000000000")).statusCode).toBe(429);
      expect(h.sent.otps).toHaveLength(1);
    });

    it("cannot be replaced by the password path", async () => {
      await h.db.updateTable("users").set({ email: "owner@example.com" }).where("id", "=", h.ownerId).execute();
      const login = await call(h, "POST", "/auth/login", {
        body: { role: "resident", email: "owner@example.com", password: PASSWORD },
      });
      expect(login.statusCode).toBe(401);
      await h.db.updateTable("users").set({ email: null }).where("id", "=", h.ownerId).execute();
    });
  });

  describe("password login", () => {
    it("gives the same answer for a wrong password, unknown email and wrong role", async () => {
      await addResident(h, "same@example.com", PASSWORD);
      const responses = await Promise.all([
        call(h, "POST", "/auth/login", { body: { role: "resident", email: "same@example.com", password: "wrong-password-here" } }),
        call(h, "POST", "/auth/login", { body: { role: "resident", email: "nobody@example.com", password: PASSWORD } }),
        call(h, "POST", "/auth/login", { body: { role: "corporate", email: "same@example.com", password: PASSWORD } }),
      ]);
      for (const r of responses) {
        expect(r.statusCode).toBe(401);
        expect(r.json().message).toBe(responses[0]!.json().message);
      }
    });

    it("throttles repeated attempts on one account, even with the right password", async () => {
      await addResident(h, "limited@example.com", PASSWORD);
      const body = { role: "resident", email: "limited@example.com", password: "wrong-password-here" };
      for (let i = 0; i < 10; i++) await call(h, "POST", "/auth/login", { body });
      const blocked = await call(h, "POST", "/auth/login", { body: { ...body, password: PASSWORD } });
      expect(blocked.statusCode).toBe(429);
    });

    it("keeps throttling across a restart because counts are stored in the database", async () => {
      const count = await h.db.selectFrom("rate_limits").select(sql<number>`COUNT(*)`.as("n")).executeTakeFirstOrThrow();
      expect(Number(count.n)).toBe(0);
      await requestOtp();
      const after = await h.db.selectFrom("rate_limits").select("key_hash").execute();
      expect(after.length).toBeGreaterThan(0);
      expect(JSON.stringify(after)).not.toContain(h.ownerPhone);
    });

    it("refuses disabled accounts", async () => {
      const { userId } = await addResident(h, "gone@example.com", PASSWORD);
      await h.db.updateTable("users").set({ status: "disabled" }).where("id", "=", userId).execute();
      const login = await call(h, "POST", "/auth/login", {
        body: { role: "resident", email: "gone@example.com", password: PASSWORD },
      });
      expect(login.statusCode).toBe(401);
    });
  });

  describe("sessions", () => {
    it("stores only a hash of the token", async () => {
      await addResident(h, "hash@example.com", PASSWORD);
      const client = await loginPassword(h, "hash@example.com", PASSWORD);
      const token = client.cookie!.split("=")[1]!;
      const rows = await h.db.selectFrom("sessions").select("token_hash").execute();
      expect(rows.map((r) => r.token_hash)).toContain(sha256(token));
      expect(rows.map((r) => r.token_hash)).not.toContain(token);
    });

    it("ends on logout and a replayed cookie no longer works", async () => {
      await addResident(h, "out@example.com", PASSWORD);
      const client = await loginPassword(h, "out@example.com", PASSWORD);
      expect((await call(h, "POST", "/auth/logout", { client })).statusCode).toBe(204);
      expect((await call(h, "GET", "/auth/session", { client })).statusCode).toBe(401);
    });

    it("rotates the session ID on login and revokes the old one", async () => {
      await addResident(h, "rotate@example.com", PASSWORD);
      const first = await loginPassword(h, "rotate@example.com", PASSWORD);
      const second = await call(h, "POST", "/auth/login", {
        client: first,
        body: { role: "resident", email: "rotate@example.com", password: PASSWORD },
      });
      expect(second.statusCode).toBe(200);
      expect((await call(h, "GET", "/auth/session", { client: first })).statusCode).toBe(401);
    });

    it("expires on idle and at the absolute limit", async () => {
      await addResident(h, "idle@example.com", PASSWORD);
      for (const column of ["idle_expires_at", "absolute_expires_at"]) {
        const client = await loginPassword(h, "idle@example.com", PASSWORD);
        const hash = sha256(client.cookie!.split("=")[1]!);
        await sql`UPDATE sessions SET ${sql.ref(column)} = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE token_hash = ${hash}`.execute(h.db);
        expect((await call(h, "GET", "/auth/session", { client })).statusCode).toBe(401);
      }
    });

    it("gives owners the short 30-minute idle and 12-hour absolute limits", async () => {
      await loginOwner(h);
      const row = await h.db
        .selectFrom("sessions")
        .select([
          sql<number>`TIMESTAMPDIFF(MINUTE, created_at, idle_expires_at)`.as("idle"),
          sql<number>`TIMESTAMPDIFF(HOUR, created_at, absolute_expires_at)`.as("absolute"),
        ])
        .where("user_id", "=", h.ownerId)
        .orderBy("created_at", "desc")
        .executeTakeFirstOrThrow();
      expect(Number(row.idle)).toBeLessThanOrEqual(30);
      expect(Number(row.absolute)).toBeLessThanOrEqual(12);
    });
  });

  describe("request protection", () => {
    it("rejects mutations from an unknown or missing origin", async () => {
      const body = { phone: h.ownerPhone };
      expect((await call(h, "POST", "/auth/otp/request", { body, origin: "https://evil.example" })).statusCode).toBe(403);
      expect((await call(h, "POST", "/auth/otp/request", { body, origin: null })).statusCode).toBe(403);
    });

    it("requires the CSRF token on mutations from a signed-in session", async () => {
      await addResident(h, "csrf@example.com", PASSWORD);
      const client = await loginPassword(h, "csrf@example.com", PASSWORD);
      const noToken = await call(h, "POST", "/auth/logout", { client: { cookie: client.cookie } });
      expect(noToken.statusCode).toBe(403);
      const badToken = await call(h, "POST", "/auth/logout", { client: { cookie: client.cookie }, csrf: "0".repeat(64) });
      expect(badToken.statusCode).toBe(403);
      expect((await call(h, "POST", "/auth/logout", { client })).statusCode).toBe(204);
    });

    it("answers CORS preflight only for the allowed origin, with credentials", async () => {
      const allowed = await h.app.inject({
        method: "OPTIONS",
        url: "/api/v1/holds",
        headers: { origin: ORIGIN, "access-control-request-method": "POST" },
      });
      expect(allowed.headers["access-control-allow-origin"]).toBe(ORIGIN);
      expect(allowed.headers["access-control-allow-credentials"]).toBe("true");
      const denied = await h.app.inject({
        method: "OPTIONS",
        url: "/api/v1/holds",
        headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
      });
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("marks API responses as never cacheable", async () => {
      expect((await call(h, "GET", "/properties")).headers["cache-control"]).toBe("no-store");
    });
  });

  describe("invitation and recovery", () => {
    function tokenFrom(url: string) {
      return new URL(url).searchParams.get("token")!;
    }

    it("takes a new resident from invitation to first login, once", async () => {
      const owner = await loginOwner(h);
      const created = await call(h, "POST", "/residents", {
        client: owner,
        body: {
          name: "Priya Sharma",
          email: "Priya@Example.com",
          phone: "9811111111",
          propertyId: h.propertyId,
          room: "101A",
          rent: 14299,
          status: "Active",
          joined: "2026-10-01",
        },
      });
      expect(created.statusCode).toBe(201);
      await flush();
      const token = tokenFrom(h.sent.links[0]!.url);
      expect(h.sent.links[0]).toMatchObject({ to: "priya@example.com", purpose: "invite" });

      const beforeSetup = await call(h, "POST", "/auth/login", {
        body: { role: "resident", email: "priya@example.com", password: PASSWORD },
      });
      expect(beforeSetup.statusCode).toBe(401);

      expect((await call(h, "POST", "/auth/set-password", { body: { token, password: "too-short" } })).statusCode).toBe(422);
      expect((await call(h, "POST", "/auth/set-password", { body: { token, password: PASSWORD } })).statusCode).toBe(204);
      expect((await call(h, "POST", "/auth/set-password", { body: { token, password: PASSWORD + "2" } })).statusCode).toBe(422);
      await loginPassword(h, "priya@example.com", PASSWORD);
    });

    it("answers recovery the same way for unknown accounts and sends nothing", async () => {
      const r = await call(h, "POST", "/auth/recover", { body: { email: "ghost@example.com" } });
      await flush();
      expect(r.statusCode).toBe(200);
      expect(h.sent.links).toHaveLength(0);
    });

    it("never emails the owner a recovery link", async () => {
      await h.db.updateTable("users").set({ email: "owner@example.com" }).where("id", "=", h.ownerId).execute();
      await call(h, "POST", "/auth/recover", { body: { email: "owner@example.com" } });
      await flush();
      expect(h.sent.links).toHaveLength(0);
      await h.db.updateTable("users").set({ email: null }).where("id", "=", h.ownerId).execute();
    });

    it("revokes existing sessions when the password is reset", async () => {
      await addResident(h, "reset@example.com", PASSWORD);
      const client = await loginPassword(h, "reset@example.com", PASSWORD);
      await call(h, "POST", "/auth/recover", { body: { email: "reset@example.com" } });
      await flush();
      const token = tokenFrom(h.sent.links[0]!.url);
      await call(h, "POST", "/auth/set-password", { body: { token, password: PASSWORD + "-new" } });
      expect((await call(h, "GET", "/auth/session", { client })).statusCode).toBe(401);
      await expect(loginPassword(h, "reset@example.com", PASSWORD)).rejects.toThrow();
      await loginPassword(h, "reset@example.com", PASSWORD + "-new");
    });

    it("rejects an expired recovery link", async () => {
      await addResident(h, "late@example.com", PASSWORD);
      await call(h, "POST", "/auth/recover", { body: { email: "late@example.com" } });
      await flush();
      const token = tokenFrom(h.sent.links[0]!.url);
      await sql`UPDATE password_tokens SET expires_at = UTC_TIMESTAMP(6) - INTERVAL 1 SECOND WHERE token_hash = ${sha256(token)}`.execute(h.db);
      const r = await call(h, "POST", "/auth/set-password", { body: { token, password: PASSWORD + "-new" } });
      expect(r.statusCode).toBe(422);
    });
  });
});
