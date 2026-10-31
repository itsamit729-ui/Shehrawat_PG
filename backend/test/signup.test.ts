import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addResident,
  call,
  createHarness,
  DATABASE_URL,
  flush,
  loginOwner,
  loginPassword,
  type Client,
  type Harness,
} from "./helpers.js";

const PASSWORD = "a-long-enough-password";
const resident = (email: string) => ({ role: "resident", name: "Asha", email, password: PASSWORD });
const company = (email: string) => ({ role: "corporate", name: "Rahul", companyName: "Acme", email, password: PASSWORD });
const tokenOf = (url: string) => new URL(url).searchParams.get("token");
const GOOGLE = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret", API_URL: "https://api.example.com" };

function addOwnerResident(h: Harness) {
  return async (email: string, phone: string) =>
    call(h, "POST", "/residents", {
      client: await loginOwner(h),
      body: {
        name: "Real Resident",
        email,
        phone,
        propertyId: h.propertyId,
        room: "101A",
        rent: 14299,
        status: "Active",
        joined: "2026-10-01",
      },
    });
}

/** Runs the browser's side of Google sign-in and returns the callback's response. */
async function googleLogin(h: Harness, code: string, sub: string, email: string, client?: Client, verified = true) {
  h.googleProfiles[code] = { sub, email, emailVerified: verified };
  const start = client
    ? await call(h, "POST", "/auth/google/link", { client })
    : await call(h, "GET", "/auth/google/start");
  const state = start.cookies.find((c) => c.name === "sg_google_state")!.value;
  return call(h, "GET", `/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`, {
    client: { cookie: `sg_google_state=${state}${client ? `; ${client.cookie}` : ""}` },
  });
}

describe.skipIf(!DATABASE_URL)("signup without email verification", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(1, { REQUIRE_EMAIL_VERIFICATION: "false", ...GOOGLE });
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    await h.db.deleteFrom("rate_limits").execute();
    h.sent.links.length = 0;
  });
  const signup = (body: object, ip?: string) => call(h, "POST", "/auth/signup", { body, ip });

  it("creates an account that signs in separately and sees no one's records", async () => {
    const response = await signup(resident("Asha@Example.com"));
    expect(response.statusCode).toBe(202);
    expect(response.json().verificationRequired).toBe(false);
    expect(response.cookies.find((c) => c.name === "sg_session")).toBeUndefined();
    await flush();
    expect(h.sent.links).toHaveLength(0);
    const client = await loginPassword(h, "asha@example.com", PASSWORD);
    expect((await call(h, "GET", "/portal", { client })).json()).toEqual({ residents: [] });
    expect((await call(h, "GET", "/beds", { client })).statusCode).toBe(403);
  });

  it("answers the same for a taken email and leaves its password alone", async () => {
    const first = await signup(resident("taken@example.com"));
    const again = await signup({ ...resident("TAKEN@example.com"), password: "a-different-password" });
    expect(again.statusCode).toBe(first.statusCode);
    expect(again.json()).toEqual(first.json());
    await loginPassword(h, "taken@example.com", PASSWORD);
  });

  it("creates a company with its contact person", async () => {
    expect((await signup(company("rahul@acme.example"))).statusCode).toBe(202);
    const client = await loginPassword(h, "rahul@acme.example", PASSWORD, "corporate");
    const session = (await call(h, "GET", "/auth/session", { client })).json();
    const row = await h.db
      .selectFrom("corporate_accounts")
      .select("name")
      .where("id", "=", session.corporateId)
      .executeTakeFirstOrThrow();
    expect(row.name).toBe("Acme");
  });

  it("rejects bad requests", async () => {
    expect((await signup({ ...resident("owner@example.com"), role: "owner" })).statusCode).toBe(422);
    expect((await signup({ ...resident("short@example.com"), password: "too-short" })).statusCode).toBe(422);
    expect((await signup({ ...company("c@example.com"), companyName: "" })).statusCode).toBe(422);
    const foreign = await call(h, "POST", "/auth/signup", {
      body: resident("foreign@example.com"),
      origin: "https://evil.example",
    });
    expect(foreign.statusCode).toBe(403);
  });

  it("limits attempts per email and per address", async () => {
    let last = 0;
    for (let i = 0; i < 4; i++) last = (await signup(resident("again@example.com"))).statusCode;
    expect(last).toBe(429);
    for (let i = 0; i < 11; i++) last = (await signup(resident(`b${i}@example.com`), "198.51.100.9")).statusCode;
    expect(last).toBe(429);
  }, 30_000);

  it("can't claim an account the owner invited", async () => {
    expect((await addOwnerResident(h)("invited@example.com", "9811111101")).statusCode).toBe(201);
    await signup(resident("invited@example.com"));
    const user = await h.db
      .selectFrom("users")
      .select(["password_hash", "status"])
      .where("email", "=", "invited@example.com")
      .executeTakeFirstOrThrow();
    expect(user).toEqual({ password_hash: null, status: "invited" });
  });

  it("ends every way into an unproven account when the owner adds that resident", async () => {
    await signup(resident("early@example.com"));
    const squatter = await loginPassword(h, "early@example.com", PASSWORD);
    const linked = await googleLogin(h, "squat", "squatter-sub", "squatter@gmail.example", squatter);
    expect(linked.headers.location).toContain("google_connected=1");

    expect((await addOwnerResident(h)("early@example.com", "9811111102")).statusCode).toBe(201);
    await flush();

    expect((await call(h, "GET", "/auth/session", { client: squatter })).statusCode).toBe(401);
    await expect(loginPassword(h, "early@example.com", PASSWORD)).rejects.toThrow();
    // Their Google account no longer reaches this resident: it only gets an empty account of its own.
    const google = await googleLogin(h, "squat2", "squatter-sub", "squatter@gmail.example");
    const googleClient = { cookie: `sg_session=${google.cookies.find((c) => c.name === "sg_session")!.value}` };
    expect((await call(h, "GET", "/portal", { client: googleClient })).json()).toEqual({ residents: [] });

    const link = h.sent.links.at(-1)!;
    expect(link).toMatchObject({ to: "early@example.com", purpose: "invite" });
    const newPassword = PASSWORD + "-new";
    await call(h, "POST", "/auth/set-password", { body: { token: tokenOf(link.url), password: newPassword } });
    const client = await loginPassword(h, "early@example.com", newPassword);
    expect((await call(h, "GET", "/portal", { client })).json().residents[0]).toMatchObject({ room: "101A" });
  });

  it("keeps a proven account signed in when the owner adds that resident", async () => {
    await signup(resident("proven@example.com"));
    await call(h, "POST", "/auth/recover", { body: { email: "proven@example.com" } });
    await flush();
    await call(h, "POST", "/auth/set-password", {
      body: { token: tokenOf(h.sent.links.at(-1)!.url), password: PASSWORD },
    });
    const client = await loginPassword(h, "proven@example.com", PASSWORD);
    h.sent.links.length = 0;

    expect((await addOwnerResident(h)("proven@example.com", "9811111106")).statusCode).toBe(201);
    await flush();
    expect(h.sent.links).toHaveLength(0);
    expect((await call(h, "GET", "/portal", { client })).json().residents).toHaveLength(1);
  });

  it("won't add a resident over a company's account or an existing resident", async () => {
    await signup(company("rahul@beta.example"));
    expect((await addOwnerResident(h)("rahul@beta.example", "9811111103")).statusCode).toBe(409);
    await loginPassword(h, "rahul@beta.example", PASSWORD, "corporate");
    expect((await addOwnerResident(h)("twice@example.com", "9811111104")).statusCode).toBe(201);
    expect((await addOwnerResident(h)("twice@example.com", "9811111105")).statusCode).toBe(409);
  });
});

describe.skipIf(!DATABASE_URL)("signup with email verification", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(1, { REQUIRE_EMAIL_VERIFICATION: "true" });
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    await h.db.deleteFrom("rate_limits").execute();
    h.sent.links.length = 0;
  });
  const login = (email: string, password = PASSWORD) =>
    call(h, "POST", "/auth/login", { body: { role: "resident", email, password } });
  async function signUpAndGetLink(email: string) {
    const response = await call(h, "POST", "/auth/signup", { body: resident(email) });
    expect(response.json().verificationRequired).toBe(true);
    await flush();
    const link = h.sent.links.at(-1)!;
    expect(link).toMatchObject({ to: email, purpose: "verify" });
    expect(link.url).toContain("/verify-email?token=");
    return tokenOf(link.url);
  }

  it("blocks sign-in until the emailed link is used, and only once", async () => {
    const token = await signUpAndGetLink("verify@example.com");
    expect((await login("verify@example.com", "not-the-password")).statusCode).toBe(401);
    expect((await login("verify@example.com")).statusCode).toBe(403);
    expect((await call(h, "POST", "/auth/verify-email", { body: { token } })).statusCode).toBe(204);
    expect((await login("verify@example.com")).statusCode).toBe(200);
    expect((await call(h, "POST", "/auth/verify-email", { body: { token } })).statusCode).toBe(422);
  });

  it("doesn't let a verification link set a password", async () => {
    const token = await signUpAndGetLink("noset@example.com");
    const response = await call(h, "POST", "/auth/set-password", { body: { token, password: "attacker-password-1" } });
    expect(response.statusCode).toBe(422);
    expect((await login("noset@example.com")).statusCode).toBe(403);
  });

  it("sends another link only to an unverified account, with the same answer", async () => {
    await signUpAndGetLink("resend@example.com");
    h.sent.links.length = 0;
    const known = await call(h, "POST", "/auth/resend-verification", { body: { email: "resend@example.com" } });
    const unknown = await call(h, "POST", "/auth/resend-verification", { body: { email: "ghost@example.com" } });
    expect(known.json()).toEqual(unknown.json());
    await flush();
    expect(h.sent.links.map((l) => l.to)).toEqual(["resend@example.com"]);
  });

  it("ends a session if the account turns out to be unverified", async () => {
    const { userId } = await addResident(h, "turned@example.com", PASSWORD);
    const client = await loginPassword(h, "turned@example.com", PASSWORD);
    await h.db.updateTable("users").set({ email_verified_at: null }).where("id", "=", userId).execute();
    expect((await call(h, "GET", "/auth/session", { client })).statusCode).toBe(401);
  });
});

describe.skipIf(!DATABASE_URL)("changing a password", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(1);
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    await h.db.deleteFrom("rate_limits").execute();
  });
  const change = (client: Client, currentPassword: string, password: string) =>
    call(h, "POST", "/auth/change-password", { client, body: { currentPassword, password } });

  it("replaces the password and every other session", async () => {
    await addResident(h, "change@example.com", PASSWORD);
    const other = await loginPassword(h, "change@example.com", PASSWORD);
    const client = await loginPassword(h, "change@example.com", PASSWORD);
    const response = await change(client, PASSWORD, PASSWORD + "-new");
    expect(response.statusCode).toBe(200);
    expect((await call(h, "GET", "/auth/session", { client: other })).statusCode).toBe(401);
    const cookie = response.cookies.find((c) => c.name === "sg_session")!.value;
    expect((await call(h, "GET", "/auth/session", { client: { cookie: `sg_session=${cookie}` } })).statusCode).toBe(200);
    await expect(loginPassword(h, "change@example.com", PASSWORD)).rejects.toThrow();
    await loginPassword(h, "change@example.com", PASSWORD + "-new");
  });

  it("needs the current password and a long enough new one", async () => {
    await addResident(h, "wrong@example.com", PASSWORD);
    const client = await loginPassword(h, "wrong@example.com", PASSWORD);
    expect((await change(client, "not-the-password", PASSWORD + "-new")).statusCode).toBe(400);
    expect((await change(client, PASSWORD, "too-short")).statusCode).toBe(422);
    await loginPassword(h, "wrong@example.com", PASSWORD);
  });

  it("isn't available to the owner or to visitors", async () => {
    expect((await change(await loginOwner(h), PASSWORD, PASSWORD + "-new")).statusCode).toBe(403);
    const visitor = await call(h, "POST", "/auth/change-password", {
      body: { currentPassword: PASSWORD, password: PASSWORD + "-new" },
    });
    expect(visitor.statusCode).toBe(401);
  });
});

describe.skipIf(!DATABASE_URL)("Google sign-in", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(1, { REQUIRE_EMAIL_VERIFICATION: "true", ...GOOGLE });
  });
  afterAll(async () => h?.close());
  beforeEach(async () => {
    await h.db.deleteFrom("rate_limits").execute();
  });
  const sessionCookie = (r: Awaited<ReturnType<typeof call>>) => r.cookies.find((c) => c.name === "sg_session");

  it("creates a verified resident, and signs the same person in again", async () => {
    const first = await googleLogin(h, "c1", "sub-1", "New@Gmail.example");
    expect(first.statusCode).toBe(303);
    expect(first.headers.location).toMatch(/\/resident\/home$/);
    const client = { cookie: `sg_session=${sessionCookie(first)!.value}` };
    const session = (await call(h, "GET", "/auth/session", { client })).json();
    expect(session).toMatchObject({ role: "resident" });
    const again = await googleLogin(h, "c2", "sub-1", "new@gmail.example");
    const secondClient = { cookie: `sg_session=${sessionCookie(again)!.value}` };
    expect((await call(h, "GET", "/auth/session", { client: secondClient })).json().id).toBe(session.id);
  });

  it("never signs in to a password account with a matching email", async () => {
    await addResident(h, "existing@example.com", PASSWORD);
    const response = await googleLogin(h, "c3", "sub-3", "existing@example.com");
    expect(response.headers.location).toContain("google_error=existing");
    expect(sessionCookie(response)).toBeUndefined();
  });

  it("rejects a wrong state and an unverified Google email", async () => {
    const start = await call(h, "GET", "/auth/google/start");
    const state = start.cookies.find((c) => c.name === "sg_google_state")!.value;
    h.googleProfiles.c4 = { sub: "sub-4", email: "state@example.com", emailVerified: true };
    const forged = await call(h, "GET", "/auth/google/callback?code=c4&state=forged", {
      client: { cookie: `sg_google_state=${state}` },
    });
    expect(forged.headers.location).toContain("google_error=failed");
    const unverified = await googleLogin(h, "c5", "sub-5", "unverified@example.com", undefined, false);
    expect(unverified.headers.location).toContain("google_error=failed");
    expect(sessionCookie(unverified)).toBeUndefined();
  });

  it("connects to a signed-in resident, once", async () => {
    await addResident(h, "link@example.com", PASSWORD);
    const client = await loginPassword(h, "link@example.com", PASSWORD);
    const linked = await googleLogin(h, "c6", "sub-6", "link.google@gmail.example", client);
    expect(linked.headers.location).toContain("/resident/security?google_connected=1");
    expect((await call(h, "POST", "/auth/google/link", { client })).statusCode).toBe(409);
    const signIn = await googleLogin(h, "c7", "sub-6", "link.google@gmail.example");
    const session = await call(h, "GET", "/auth/session", {
      client: { cookie: `sg_session=${sessionCookie(signIn)!.value}` },
    });
    expect(session.json().name).toBe("link");
  });

  it("isn't for the owner", async () => {
    const client = await loginOwner(h);
    expect((await call(h, "POST", "/auth/google/link", { client })).statusCode).toBe(403);
  });
});

describe.skipIf(!DATABASE_URL)("Google sign-in when not configured", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(1);
  });
  afterAll(async () => h?.close());

  it("reports it's off and refuses to start", async () => {
    expect((await call(h, "GET", "/auth/google/enabled")).json()).toEqual({ enabled: false });
    expect((await call(h, "GET", "/auth/google/start")).statusCode).toBe(503);
  });
});
