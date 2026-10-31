import { createHmac } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { webhookRoutes } from "../src/modules/finance/routes.js";
import type { Context } from "../src/modules/identity/service.js";
import { botReply, parseBusinessTime } from "../src/modules/messaging/service.js";
import { presignS3 } from "../src/providers/storage.js";
import { csvRecords, parseCsv } from "../src/shared/csv.js";

describe("csv", () => {
  it("handles quotes, commas, newlines and Excel's byte order mark", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });
  it("skips blank rows and trims cells", () => {
    expect(csvRecords("name,age\n A , 3 \n,\n\n")).toEqual([{ name: "A", age: "3" }]);
  });
  it("refuses an unclosed quote rather than guessing", () => {
    expect(() => parseCsv('a\n"oops')).toThrow();
  });
});

describe("bot", () => {
  it("answers only what it knows and hands over everything else", () => {
    expect(botReply("what is the rent", "https://x").text).toContain("https://x/explore");
    expect(botReply("what is the rent", "https://x").handoff).toBe(false);
    expect(botReply("the tap is broken", "https://x").handoff).toBe(true);
    expect(botReply("please connect me to staff", "https://x").handoff).toBe(true);
  });
});

describe("campaign times", () => {
  it("reads a form's time as Indian time, and keeps an explicit zone", () => {
    expect(parseBusinessTime("2026-11-01T10:00").toISOString()).toBe("2026-11-01T04:30:00.000Z");
    expect(parseBusinessTime("2026-11-01T10:00:00.000Z").toISOString()).toBe("2026-11-01T10:00:00.000Z");
    expect(() => parseBusinessTime("soon")).toThrow();
  });
});

describe("storage links", () => {
  const input = {
    method: "PUT" as const,
    host: "store.example.com",
    path: "/bucket/private/a b",
    region: "auto",
    accessKey: "AK",
    secretKey: "SK",
    seconds: 300,
    now: new Date("2026-01-02T03:04:05.000Z"),
    headers: { "Content-Type": "application/pdf" },
  };
  it("signs the method, path and content type, and carries the expiry", () => {
    const url = new URL(presignS3(input));
    expect(url.pathname).toBe("/bucket/private/a%20b");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260102T030405Z");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("content-type;host");
    expect(url.searchParams.get("X-Amz-Credential")).toBe("AK/20260102/auto/s3/aws4_request");
    const signature = url.searchParams.get("X-Amz-Signature");
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    for (const changed of [{ method: "GET" as const }, { path: "/bucket/other" }, { headers: { "Content-Type": "image/png" } }])
      expect(new URL(presignS3({ ...input, ...changed })).searchParams.get("X-Amz-Signature")).not.toBe(signature);
  });
});

describe("webhook endpoints", () => {
  const secret = "whsec";
  const config = {
    razorpay: { keyId: "a", keySecret: "b", webhookSecret: secret },
    whatsapp: { token: "t", phoneNumberId: "1", businessAccountId: "2", appSecret: secret, verifyToken: "v" },
  } as unknown as Config;
  const build = async () => {
    const saved = { count: 0 };
    const ctx = {
      db: { transaction: () => ({ execute: async () => void saved.count++ }) },
    } as unknown as Context;
    const app = Fastify();
    await app.register(webhookRoutes(config, ctx), { prefix: "/webhooks" });
    return { app, saved };
  };
  // Spacing a re-serialized body would lose, which is why the signature must cover the raw bytes.
  const raw = '{ "event":   "payment_link.paid" }';
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  const post = (app: FastifyInstance, url: string, headers: Record<string, string>) =>
    app.inject({ method: "POST", url, headers: { "content-type": "application/json; charset=utf-8", ...headers }, payload: raw });

  it("accepts a signature over the exact bytes, and refuses anything else", async () => {
    const { app, saved } = await build();
    expect((await post(app, "/webhooks/razorpay", { "x-razorpay-signature": signature })).statusCode).toBe(200);
    expect((await post(app, "/webhooks/whatsapp", { "x-hub-signature-256": `sha256=${signature}` })).statusCode).toBe(200);
    expect(saved.count).toBe(2);
    expect((await post(app, "/webhooks/razorpay", { "x-razorpay-signature": "00".repeat(32) })).statusCode).toBe(401);
    expect((await post(app, "/webhooks/razorpay", { "x-razorpay-signature": "not-hex" })).statusCode).toBe(401);
    expect((await post(app, "/webhooks/whatsapp", {})).statusCode).toBe(401);
    expect(saved.count).toBe(2);
    await app.close();
  });
});

describe("optional integrations", () => {
  const env = {
    NODE_ENV: "test",
    DATABASE_URL: "mysql://x@localhost/y",
    DB_TLS: "off",
    AUTH_SECRET: "x".repeat(32),
    FRONTEND_ORIGINS: "http://localhost",
    FRONTEND_URL: "http://localhost",
  };
  it("stay off until every one of their settings is present", () => {
    const off = loadConfig(env);
    expect([off.razorpay, off.whatsapp, off.storage]).toEqual([null, null, null]);
    expect(loadConfig({ ...env, RAZORPAY_KEY_ID: "a", RAZORPAY_KEY_SECRET: "b" }).razorpay).toBeNull();
    expect(loadConfig({ ...env, RAZORPAY_KEY_ID: "a", RAZORPAY_KEY_SECRET: "b", RAZORPAY_WEBHOOK_SECRET: "c" }).razorpay).not.toBeNull();
  });
});
