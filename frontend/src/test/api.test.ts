import { describe, it, expect, vi, afterEach } from "vitest";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});
async function client() {
  vi.resetModules();
  vi.stubEnv("VITE_API_BASE_URL", "https://api.example.com/api/v1");
  vi.stubEnv("VITE_DEMO_MODE", "false");
  return import("../api");
}
describe("live API boundary", () => {
  it("sends credentialed requests and uses the server CSRF token for mutations", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "u1", csrfToken: "server-token" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "T1" }), { status: 201 }),
      );
    vi.stubGlobal("fetch", fetcher);
    const { request, DEMO } = await client();
    expect(DEMO).toBe(false);
    await request("/auth/session");
    await request("/tickets", {
      method: "POST",
      body: { subject: "Help" },
      key: "idempotency-1",
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "https://api.example.com/api/v1/tickets",
      expect.objectContaining({
        credentials: "include",
        method: "POST",
        headers: expect.objectContaining({
          "X-CSRF-Token": "server-token",
          "Idempotency-Key": "idempotency-1",
        }),
        body: JSON.stringify({ subject: "Help" }),
      }),
    );
  });
  it("preserves conflict errors rather than treating a failed hold as success", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ message: "This bed is no longer available." }),
            { status: 409 },
          ),
        ),
    );
    const { request } = await client();
    await expect(
      request("/holds", { method: "POST", body: { propertyId: "lotus" } }),
    ).rejects.toMatchObject({
      status: 409,
      message: "This bed is no longer available.",
    });
  });
  it("does not silently substitute preview data when the network fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network")));
    const { request } = await client();
    await expect(request("/properties")).rejects.toMatchObject({ status: 0 });
  });
});
