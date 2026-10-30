import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { hashPassword } from "../src/modules/identity/crypto.js";
import { call, createHarness, DATABASE_URL, type Harness } from "./helpers.js";

const PASSWORD = "the-owner-password-1";

describe.skipIf(!DATABASE_URL)("owner password sign-in", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(1, { OWNER_LOGIN: "password" });
    await h.db
      .updateTable("users")
      .set({ phone: null, password_hash: await hashPassword(PASSWORD) })
      .where("id", "=", h.ownerId)
      .execute();
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    await h.db.deleteFrom("rate_limits").execute();
  });

  const login = (body: object, ip?: string) => call(h, "POST", "/auth/login", { body, ip });

  it("signs in with no phone or email on the account", async () => {
    const response = await login({ role: "owner", password: PASSWORD, challengeId: "" });
    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({ id: h.ownerId, role: "owner" });
    const cookie = response.cookies.find((c) => c.name === "sg_session")!;
    const beds = await call(h, "GET", "/beds", { client: { cookie: `sg_session=${cookie.value}` } });
    expect(beds.statusCode).toBe(200);
  });

  it("rejects a wrong password", async () => {
    expect((await login({ role: "owner", password: "not-the-password" })).statusCode).toBe(401);
  });

  it("requires a password", async () => {
    expect((await login({ role: "owner", password: "" })).statusCode).toBe(422);
    expect((await login({ role: "owner", challengeId: crypto.randomUUID(), otp: "123456" })).statusCode).toBe(422);
  });

  it("throttles guessing, even from different addresses", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++)
      last = (await login({ role: "owner", password: "not-the-password" }, `198.51.100.${i % 3}`)).statusCode;
    expect(last).toBe(429);
  });

  it("throttles one address sooner", async () => {
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await login({ role: "owner", password: "not-the-password" })).statusCode;
    expect(last).toBe(429);
  });

  it("doesn't open the resident path to the owner", async () => {
    await h.db.updateTable("users").set({ email: "owner@example.com" }).where("id", "=", h.ownerId).execute();
    const response = await login({ role: "resident", email: "owner@example.com", password: PASSWORD });
    expect(response.statusCode).toBe(401);
    await h.db.updateTable("users").set({ email: null }).where("id", "=", h.ownerId).execute();
  });
});

describe.skipIf(!DATABASE_URL)("owner password sign-in when not enabled", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(1);
    await h.db
      .updateTable("users")
      .set({ password_hash: await hashPassword(PASSWORD) })
      .where("id", "=", h.ownerId)
      .execute();
  });
  afterAll(async () => h?.close());

  it("doesn't accept a password from the owner", async () => {
    const response = await call(h, "POST", "/auth/login", { body: { role: "owner", password: PASSWORD } });
    expect(response.statusCode).toBe(422);
  });
});
