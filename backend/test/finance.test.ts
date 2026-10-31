import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { importOwnerData } from "../src/cli/import-owner-data.js";
import { businessHandlers } from "../src/jobs/business.js";
import { runMonthlyBilling } from "../src/modules/finance/service.js";
import { botReply, deliverMessage, processWhatsAppEvent, sendCampaignBatch, startCampaign } from "../src/modules/messaging/service.js";
import {
  addResident,
  call,
  createHarness,
  DATABASE_URL,
  loginOwner,
  loginPassword,
  ORIGIN,
  tomorrow,
  WEBHOOK_SECRET,
  type Harness,
} from "./helpers.js";

const key = () => randomUUID();
const customer = { name: "Asha", phone: "9876500001", email: "asha@example.com", occupation: "Engineer" };

describe.skipIf(!DATABASE_URL)("finance, operations, messaging and documents", () => {
  let h: Harness;
  beforeEach(async () => {
    if (h) await h.close();
    h = await createHarness(2);
  });
  afterAll(() => h?.close());

  const hold = async () => {
    const response = await call(h, "POST", "/holds", {
      body: { propertyId: h.propertyId, sharing: "double", moveIn: tomorrow() },
      key: key(),
    });
    expect(response.statusCode).toBe(200);
    return response.json() as { id: string; amount: number };
  };
  const holdOrder = async (holdId: string) => {
    const response = await call(h, "POST", "/payment-orders", { body: { holdId, ...customer, moveIn: tomorrow() } });
    expect(response.statusCode).toBe(200);
    return response.json() as { orderId: string; checkoutUrl: string };
  };
  const paidEvent = (orderId: string, paymentId: string, amount = 1429900) => ({
    event: "payment_link.paid",
    payload: {
      payment_link: { entity: { id: `plink_${orderId}`, reference_id: orderId } },
      payment: { entity: { id: paymentId, amount, currency: "INR", status: "captured" } },
    },
  });
  const postWebhook = (path: string, body: unknown, headers: Record<string, string>, signature?: string) => {
    const raw = JSON.stringify(body);
    const signed = signature ?? createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    return h.app.inject({
      method: "POST",
      url: `/webhooks/${path}`,
      headers: {
        "content-type": "application/json",
        ...(path === "razorpay" ? { "x-razorpay-signature": signed } : { "x-hub-signature-256": `sha256=${signed}` }),
        ...headers,
      },
      payload: raw,
    });
  };
  const runJobs = async () => {
    const handlers = businessHandlers(h.ctx);
    for (let round = 0; round < 5; round++) {
      const jobs = await h.db
        .selectFrom("jobs")
        .selectAll()
        .where("state", "=", "queued")
        .where("kind", "in", Object.keys(handlers))
        .where("run_at", "<=", new Date(Date.now() + 86400_000 * 365))
        .execute();
      if (!jobs.length) return;
      for (const job of jobs) {
        await handlers[job.kind]!(job.payload);
        await h.db.updateTable("jobs").set({ state: "done" }).where("id", "=", job.id).execute();
      }
    }
  };
  const ledgerBalanced = async () => {
    const rows = await h.db.selectFrom("ledger_entries").select(["batch_id", "debit_paise", "credit_paise"]).execute();
    const batches = new Map<string, number>();
    for (const r of rows)
      batches.set(r.batch_id, (batches.get(r.batch_id) ?? 0) + Number(r.debit_paise) - Number(r.credit_paise));
    return [...batches.values()].every((v) => v === 0);
  };
  const addInvoice = async (client: Awaited<ReturnType<typeof loginOwner>>, residentId: string, period = "2026-10") => {
    const response = await call(h, "POST", "/invoices", {
      client,
      key: key(),
      body: { residentId, period, due: `${period}-05`, amount: 5000, description: "Rent October", paid: 0, status: "Due" },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id as string;
  };

  it("takes the amount from the hold, and reuses one link when the response was lost", async () => {
    const { id, amount } = await hold();
    h.fakes.loseNextLinkResponse = true;
    const first = await holdOrder(id);
    const second = await holdOrder(id);
    expect(second.checkoutUrl).toBe(first.checkoutUrl);
    expect(h.fakes.links).toHaveLength(1);
    expect(h.fakes.links[0]!.amountPaise).toBe(Math.round(amount * 100));
  });

  it("rejects a badly signed webhook without saving it", async () => {
    const response = await postWebhook("razorpay", paidEvent("x", "pay_x"), { "x-razorpay-event-id": "e0" }, "00ff");
    expect(response.statusCode).toBe(401);
    expect(await h.db.selectFrom("webhook_inbox").select("id").execute()).toHaveLength(0);
  });

  it("confirms a booking once, whichever way duplicate payment events arrive", async () => {
    const { id } = await hold();
    const { orderId } = await holdOrder(id);
    const event = paidEvent(orderId, "pay_1");
    expect((await postWebhook("razorpay", event, { "x-razorpay-event-id": "e1" })).statusCode).toBe(200);
    expect((await postWebhook("razorpay", event, { "x-razorpay-event-id": "e1" })).statusCode).toBe(200);
    expect((await postWebhook("razorpay", event, { "x-razorpay-event-id": "e2" })).statusCode).toBe(200);
    await runJobs();

    expect(await h.db.selectFrom("webhook_inbox").select("id").execute()).toHaveLength(2);
    expect(await h.db.selectFrom("payments").select("id").execute()).toHaveLength(1);
    expect(await h.db.selectFrom("resident_profiles").select("id").execute()).toHaveLength(1);
    const invoices = await h.db.selectFrom("invoices").selectAll().execute();
    expect(invoices).toHaveLength(1);
    expect(invoices[0]!.status).toBe("Paid");
    const booking = await h.db.selectFrom("bookings").select("state").executeTakeFirstOrThrow();
    expect(booking.state).toBe("confirmed");
    const status = await call(h, "GET", `/payments/status?orderId=${orderId}`);
    expect(status.json()).toEqual({ status: "confirmed" });
    expect(await ledgerBalanced()).toBe(true);
    expect(h.sent.links.some((l) => l.to === customer.email && l.purpose === "invite")).toBe(true);
  });

  it("sends a late payment to review, and never takes the bed from the next person", async () => {
    const { id } = await hold();
    const { orderId } = await holdOrder(id);
    await h.db.updateTable("holds").set({ expires_at: new Date(Date.now() - 1000) }).where("id", "=", id).execute();
    await h.db.updateTable("bed_allocations").set({ hold_expires_at: new Date(Date.now() - 1000) }).where("hold_id", "=", id).execute();
    await postWebhook("razorpay", paidEvent(orderId, "pay_late"), { "x-razorpay-event-id": "late" });
    await runJobs();

    expect((await h.db.selectFrom("payment_orders").select("status").executeTakeFirstOrThrow()).status).toBe("review");
    expect((await h.db.selectFrom("payments").select("state").executeTakeFirstOrThrow()).state).toBe("review");
    expect((await h.db.selectFrom("bookings").select("state").executeTakeFirstOrThrow()).state).toBe("payment_review");
    expect(await h.db.selectFrom("resident_profiles").select("id").execute()).toHaveLength(0);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("sends a payment for the wrong amount to review", async () => {
    const { id } = await hold();
    const { orderId } = await holdOrder(id);
    await postWebhook("razorpay", paidEvent(orderId, "pay_short", 100), { "x-razorpay-event-id": "short" });
    await runJobs();
    expect((await h.db.selectFrom("payment_orders").select("status").executeTakeFirstOrThrow()).status).toBe("review");
    expect(await h.db.selectFrom("resident_profiles").select("id").execute()).toHaveLength(0);
  });

  it("finds a payment whose webhook never came, through reconciliation", async () => {
    const { id } = await hold();
    const { orderId } = await holdOrder(id);
    h.fakes.linkPayments[orderId] = [{ id: "pay_missed", amountPaise: 1429900, currency: "INR", captured: true }];
    await h.db.updateTable("payment_orders").set({ created_at: new Date(Date.now() - 600_000) }).where("id", "=", orderId).execute();
    await businessHandlers(h.ctx)["payments.reconcile"]!({});
    await businessHandlers(h.ctx)["payments.reconcile"]!({});
    expect(await h.db.selectFrom("payments").select("id").execute()).toHaveLength(1);
    expect((await h.db.selectFrom("payment_orders").select("status").executeTakeFirstOrThrow()).status).toBe("confirmed");
  });

  it("bills each resident once per month, and respects a manual rent invoice", async () => {
    const { residentId } = await addResident(h, "a@example.com", "resident-password-1");
    const other = await addResident(h, "b@example.com", "resident-password-1");
    const owner = await loginOwner(h);
    await addInvoice(owner, residentId, "2026-11");
    expect(await runMonthlyBilling(h.db, h.businessId, 5, "2026-11")).toBe(1);
    expect(await runMonthlyBilling(h.db, h.businessId, 5, "2026-11")).toBe(0);
    const invoices = await h.db.selectFrom("invoices").select("resident_id").execute();
    expect(invoices.filter((i) => i.resident_id === residentId)).toHaveLength(1);
    expect(invoices.filter((i) => i.resident_id === other.residentId)).toHaveLength(1);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("works in February without an invalid date, and skips who joined during the month", async () => {
    const { userId, residentId } = await addResident(h, "a@example.com", "resident-password-1");
    await h.db.updateTable("resident_profiles").set({ joined_on: "2027-02-10" }).where("user_id", "=", userId).execute();
    expect(await runMonthlyBilling(h.db, h.businessId, 5, "2027-02")).toBe(0);
    expect(await runMonthlyBilling(h.db, h.businessId, 5, "2027-03")).toBe(1);
    const invoice = await h.db.selectFrom("invoices").select("resident_id").executeTakeFirstOrThrow();
    expect(invoice.resident_id).toBe(residentId);
  });

  it("records a manual receipt once per key and refuses more than the balance", async () => {
    const { residentId } = await addResident(h, "a@example.com", "resident-password-1");
    const owner = await loginOwner(h);
    const invoiceId = await addInvoice(owner, residentId);
    const k = key();
    const body = { invoiceId, amount: 2000, method: "UPI", reference: "UTR1" };
    expect((await call(h, "POST", "/payments/manual", { client: owner, key: k, body })).statusCode).toBe(200);
    expect((await call(h, "POST", "/payments/manual", { client: owner, key: k, body })).statusCode).toBe(200);
    const invoice = await h.db.selectFrom("invoices").selectAll().executeTakeFirstOrThrow();
    expect(Number(invoice.paid_paise)).toBe(200000);
    expect(invoice.status).toBe("Part paid");
    const over = await call(h, "POST", "/payments/manual", {
      client: owner,
      key: key(),
      body: { ...body, amount: 3001 },
    });
    expect(over.statusCode).toBe(422);
    expect(await h.db.selectFrom("payments").select("id").execute()).toHaveLength(1);
    expect(await ledgerBalanced()).toBe(true);
  });

  it("shows a refund as refunded only once the provider says so, and stays in review if unknown", async () => {
    const { id } = await hold();
    const { orderId } = await holdOrder(id);
    await postWebhook("razorpay", paidEvent(orderId, "pay_r"), { "x-razorpay-event-id": "r1" });
    await runJobs();
    const owner = await loginOwner(h);
    const refund = (amount: number) =>
      call(h, "POST", "/refunds", { client: owner, key: key(), body: { paymentId: "pay_r", amount, reason: "Cancelled" } });
    expect((await refund(99999999)).statusCode).toBe(422);
    expect((await refund(1000)).statusCode).toBe(200);
    await runJobs();
    const pending = await h.db.selectFrom("refunds").selectAll().executeTakeFirstOrThrow();
    expect(pending.state).toBe("Pending");
    expect(h.fakes.refunds[0]!.receipt).toBe(pending.id);

    const processed = { event: "refund.processed", payload: { refund: { entity: { id: pending.provider_refund_id } } } };
    await postWebhook("razorpay", processed, { "x-razorpay-event-id": "r2" });
    await runJobs();
    expect((await h.db.selectFrom("refunds").select("state").executeTakeFirstOrThrow()).state).toBe("Refunded");
    // A late failure event doesn't undo a refund the provider already completed.
    const failed = { event: "refund.failed", payload: { refund: { entity: { id: pending.provider_refund_id } } } };
    await postWebhook("razorpay", failed, { "x-razorpay-event-id": "r3" });
    await runJobs();
    expect((await h.db.selectFrom("refunds").select("state").executeTakeFirstOrThrow()).state).toBe("Refunded");

    h.fakes.refundResult = async () => {
      throw new Error("Connection reset");
    };
    expect((await refund(500)).statusCode).toBe(200);
    await runJobs();
    const states = (await h.db.selectFrom("refunds").select("state").execute()).map((r) => r.state);
    expect(states).toContain("Review");
    expect(await ledgerBalanced()).toBe(true);
  });

  it("gives each role only its own records", async () => {
    const a = await addResident(h, "a@example.com", "resident-password-1");
    const b = await addResident(h, "b@example.com", "resident-password-1");
    const owner = await loginOwner(h);
    const invoiceB = await addInvoice(owner, b.residentId);
    const resident = await loginPassword(h, "a@example.com", "resident-password-1");
    const ticket = await call(h, "POST", "/tickets", {
      client: resident,
      key: key(),
      // The body names someone else, and the session wins.
      body: { subject: "Fan", category: "Maintenance", description: "Broken", residentId: b.residentId, priority: "Normal" },
    });
    expect(ticket.statusCode).toBe(201);
    const row = await h.db.selectFrom("tickets").select("resident_id").executeTakeFirstOrThrow();
    expect(row.resident_id).toBe(a.residentId);

    const portal = (await call(h, "GET", "/portal", { client: resident })).json();
    expect(portal.invoices).toEqual([]);
    expect(portal.tickets).toHaveLength(1);
    for (const hidden of ["leads", "expenses", "conversations", "payments", "campaigns"]) expect(portal[hidden]).toBeUndefined();
    expect(portal.settings.billingEnabled).toBeUndefined();

    const order = await call(h, "POST", "/payment-orders", { client: resident, body: { invoiceId: invoiceB } });
    expect(order.statusCode).toBe(403);
    const moveOut = await call(h, "POST", "/move-outs", {
      client: resident,
      key: key(),
      body: { date: tomorrow(), reason: "Leaving", residentId: b.residentId },
    });
    expect(moveOut.statusCode).toBe(403);
    const status = await call(h, "PATCH", `/tickets/${ticket.json().id}`, { client: resident, body: { status: "Resolved" } });
    expect(status.statusCode).toBe(204);
    expect((await h.db.selectFrom("tickets").select("status").executeTakeFirstOrThrow()).status).toBe("Open");
    expect((await call(h, "GET", "/conversations", { client: resident })).statusCode).toBe(403);
    expect((await call(h, "POST", "/settings", { client: resident, body: { rentDay: 2 } })).statusCode).toBe(403);
  });

  it("accepts public leads under a limit, and keeps partner details", async () => {
    const lead = (ip: string) =>
      call(h, "POST", "/leads", {
        ip,
        body: { name: "P", phone: "9", email: "p@example.com", propertyId: "", date: tomorrow(), kind: "Property partner", status: "Closed", address: "MG Road", capacity: "30" },
      });
    expect((await lead("198.51.100.1")).statusCode).toBe(201);
    const row = await h.db.selectFrom("leads").selectAll().executeTakeFirstOrThrow();
    expect(row.status).toBe("New");
    expect(row.notes).toContain("MG Road");
    for (let i = 0; i < 4; i++) await lead("198.51.100.2");
    expect((await lead("198.51.100.2")).statusCode).toBe(201);
    expect((await lead("198.51.100.2")).statusCode).toBe(429);
  });

  it("refuses settings it doesn't know, and merges the ones it does", async () => {
    const owner = await loginOwner(h);
    expect((await call(h, "POST", "/settings", { client: owner, body: { apiKey: "x" } })).statusCode).toBe(422);
    expect((await call(h, "POST", "/settings", { client: owner, body: { rentDay: 29 } })).statusCode).toBe(422);
    await call(h, "POST", "/settings", { client: owner, body: { rentDay: 7 } });
    await call(h, "POST", "/settings", { client: owner, body: { mealMenu: { 1: { breakfast: "Poha", lunch: "Dal", dinner: "Roti" } } } });
    const { settings } = (await call(h, "GET", "/portal", { client: owner })).json();
    expect(settings.rentDay).toBe(7);
    expect(settings.mealMenu["1"].breakfast).toBe("Poha");
    expect(settings.billingEnabled).toBe(false);
  });

  const inbound = (id: string, body: string, from = "919876500009") => ({
    entry: [
      {
        changes: [
          {
            value: {
              contacts: [{ wa_id: from, profile: { name: "Ravi" } }],
              messages: [{ id, from, type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  });

  it("answers the WhatsApp verification handshake only with the right token", async () => {
    const good = await h.app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=42" });
    expect(good.body).toBe("42");
    const bad = await h.app.inject({ method: "GET", url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=no&hub.challenge=42" });
    expect(bad.statusCode).toBe(403);
  });

  it("de-duplicates inbound messages and answers through the bot", async () => {
    await postWebhook("whatsapp", inbound("wamid.1", "what is the rent?"), {});
    await postWebhook("whatsapp", inbound("wamid.1", "what is the rent?"), {});
    await processWhatsAppEvent(h.ctx, h.businessId, inbound("wamid.1", "what is the rent?"));
    await runJobs();
    const messages = await h.db.selectFrom("messages").select(["sender", "status"]).execute();
    expect(messages.filter((m) => m.sender === "customer")).toHaveLength(1);
    expect(messages.filter((m) => m.sender === "bot")).toHaveLength(1);
    expect(h.fakes.whatsapp).toHaveLength(1);
    const owner = await loginOwner(h);
    const [conversation] = (await call(h, "GET", "/conversations", { client: owner })).json();
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.mode).toBe("Bot");
    const refused = await call(h, "POST", "/messages/send", {
      client: owner,
      key: key(),
      body: { conversationId: conversation.id, body: "Hello" },
    });
    expect(refused.statusCode).toBe(409);
  });

  it("hands over what it can't answer, and pauses the bot for a person", async () => {
    await processWhatsAppEvent(h.ctx, h.businessId, inbound("wamid.1", "my geyser is leaking"));
    const conversation = await h.db.selectFrom("conversations").select("mode").executeTakeFirstOrThrow();
    expect(conversation.mode).toBe("Human");
    await processWhatsAppEvent(h.ctx, h.businessId, inbound("wamid.2", "what is the rent?"));
    const bot = await h.db.selectFrom("messages").select("id").where("sender", "=", "bot").execute();
    expect(bot).toHaveLength(1);
    expect(botReply("call me please", "https://x").handoff).toBe(true);
  });

  it("stops a queued reply when the person opts out or the window closes first", async () => {
    await processWhatsAppEvent(h.ctx, h.businessId, inbound("wamid.1", "my geyser is leaking"));
    await runJobs();
    h.fakes.whatsapp.length = 0;
    const owner = await loginOwner(h);
    const conversation = await h.db.selectFrom("conversations").select("id").executeTakeFirstOrThrow();
    const send = () =>
      call(h, "POST", "/messages/send", { client: owner, key: key(), body: { conversationId: conversation.id, body: "On it" } });
    const first = await send();
    expect(first.statusCode).toBe(200);
    await processWhatsAppEvent(h.ctx, h.businessId, inbound("wamid.2", "STOP"));
    await deliverMessage(h.ctx, first.json().id);
    expect(h.fakes.whatsapp).toHaveLength(0);
    expect((await h.db.selectFrom("messages").select("status").where("id", "=", first.json().id).executeTakeFirstOrThrow()).status).toBe("failed");
    expect((await send()).statusCode).toBe(409);
    await runJobs();
    expect(h.fakes.whatsapp.map((m) => m.body)).toEqual(["You've been opted out. Reply START to opt back in."]);

    await processWhatsAppEvent(h.ctx, h.businessId, inbound("wamid.3", "START"));
    await h.db.updateTable("conversations").set({ last_inbound_at: new Date(Date.now() - 25 * 3600_000) }).execute();
    expect((await send()).statusCode).toBe(409);
  });

  it("sends a campaign only to who opted in, and rechecks at send time", async () => {
    const owner = await loginOwner(h);
    const scheduled = new Date(Date.now() + 3600_000).toISOString();
    const body = { name: "Offer", template: "offer_one", audience: "Opted-in leads", scheduled, status: "Draft", recipients: 0, delivered: 0 };
    const created = await call(h, "POST", "/campaigns", { client: owner, key: key(), body });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect((await call(h, "POST", "/campaigns/schedule", { client: owner, key: key(), body: { id } })).statusCode).toBe(422);
    h.fakes.approvedTemplates.add("offer_one");
    expect((await call(h, "POST", "/campaigns/schedule", { client: owner, key: key(), body: { id } })).statusCode).toBe(422);

    await processWhatsAppEvent(h.ctx, h.businessId, inbound("wamid.1", "START", "919876500011"));
    await processWhatsAppEvent(h.ctx, h.businessId, inbound("wamid.2", "START", "919876500012"));
    await processWhatsAppEvent(h.ctx, h.businessId, inbound("wamid.3", "hello", "919876500013"));
    await runJobs();
    h.fakes.whatsapp.length = 0;
    expect((await call(h, "POST", "/campaigns/schedule", { client: owner, key: key(), body: { id } })).statusCode).toBe(204);
    await startCampaign(h.ctx, id);
    expect(await h.db.selectFrom("campaign_recipients").select("contact_id").execute()).toHaveLength(2);
    await processWhatsAppEvent(h.ctx, h.businessId, inbound("wamid.4", "STOP", "919876500012"));
    await sendCampaignBatch(h.ctx, id, 0);
    const sent = h.fakes.whatsapp.filter((m) => m.template === "offer_one");
    expect(sent.map((m) => m.to)).toEqual(["+919876500011"]);
    const states = (await h.db.selectFrom("campaign_recipients").select("state").execute()).map((r) => r.state).sort();
    expect(states).toEqual(["sent", "skipped"]);
    expect((await h.db.selectFrom("campaigns").select("status").executeTakeFirstOrThrow()).status).toBe("Sent");
  });

  it("moves message status forward only, whatever order callbacks arrive", async () => {
    await processWhatsAppEvent(h.ctx, h.businessId, inbound("wamid.1", "my geyser is leaking"));
    await runJobs();
    const status = (s: string, id: string) => ({ entry: [{ changes: [{ value: { statuses: [{ id, status: s }] } }] }] });
    const sent = await h.db.selectFrom("messages").select("provider_message_id").where("sender", "=", "bot").executeTakeFirstOrThrow();
    const id = sent.provider_message_id!;
    await processWhatsAppEvent(h.ctx, h.businessId, status("read", id));
    await processWhatsAppEvent(h.ctx, h.businessId, status("delivered", id));
    await processWhatsAppEvent(h.ctx, h.businessId, status("failed", id));
    const row = await h.db.selectFrom("messages").select("status").where("provider_message_id", "=", id).executeTakeFirstOrThrow();
    expect(row.status).toBe("read");
  });

  it("keeps private files from everyone but their uploader and the owner, and checks the contents", async () => {
    await addResident(h, "a@example.com", "resident-password-1");
    await addResident(h, "b@example.com", "resident-password-1");
    const a = await loginPassword(h, "a@example.com", "resident-password-1");
    const b = await loginPassword(h, "b@example.com", "resident-password-1");
    const start = (client: typeof a, overrides = {}) =>
      call(h, "POST", "/uploads", {
        client,
        body: { fileName: "../../id.pdf", contentType: "application/pdf", size: 100, purpose: "resident-document", ...overrides },
      });
    expect((await start(a, { contentType: "text/html" })).statusCode).toBe(422);
    expect((await start(a, { size: 6 * 1024 * 1024 })).statusCode).toBe(422);
    const { id, uploadUrl } = (await start(a)).json();
    expect(uploadUrl).not.toContain("id.pdf");
    const upload = await h.db.selectFrom("uploads").select("object_key").executeTakeFirstOrThrow();
    expect((await call(h, "POST", `/uploads/${id}/complete`, { client: a })).statusCode).toBe(409);

    h.fakes.stored[upload.object_key] = Buffer.from("%PDF-1.7 contents");
    expect((await call(h, "POST", `/uploads/${id}/link`, { client: a })).statusCode).toBe(409);
    expect((await call(h, "POST", `/uploads/${id}/complete`, { client: b })).statusCode).toBe(404);
    expect((await call(h, "POST", `/uploads/${id}/complete`, { client: a })).statusCode).toBe(200);
    expect((await call(h, "POST", `/uploads/${id}/link`, { client: a })).statusCode).toBe(200);
    expect((await call(h, "POST", `/uploads/${id}/link`, { client: b })).statusCode).toBe(404);
    expect((await call(h, "POST", `/uploads/${id}/link`, { client: await loginOwner(h) })).statusCode).toBe(200);

    const fake = (await start(a)).json();
    const key2 = (await h.db.selectFrom("uploads").select("object_key").where("id", "=", fake.id).executeTakeFirstOrThrow()).object_key;
    h.fakes.stored[key2] = Buffer.from("<script>alert(1)</script>");
    expect((await call(h, "POST", `/uploads/${fake.id}/complete`, { client: a })).statusCode).toBe(422);
    expect(h.fakes.stored[key2]).toBeUndefined();
  });

  it("says so plainly when e-signing has no provider, and protects agreements", async () => {
    const a = await addResident(h, "a@example.com", "resident-password-1");
    await addResident(h, "b@example.com", "resident-password-1");
    const owner = await loginOwner(h);
    const created = await call(h, "POST", "/agreements", {
      client: owner,
      key: key(),
      body: { residentId: a.residentId, title: "Stay agreement", status: "Draft", created: new Date().toISOString() },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    const other = await loginPassword(h, "b@example.com", "resident-password-1");
    expect((await call(h, "POST", `/agreements/${id}/link`, { client: other, body: {} })).statusCode).toBe(403);
    const mine = await loginPassword(h, "a@example.com", "resident-password-1");
    expect((await call(h, "POST", `/agreements/${id}/link`, { client: mine, body: {} })).statusCode).toBe(503);
  });

  it("assigns and frees a bed through the resident form, and links a company", async () => {
    const owner = await loginOwner(h);
    const companyId = randomUUID();
    await h.db.insertInto("corporate_accounts").values({ id: companyId, business_id: h.businessId, name: "Acme" }).execute();
    const beds = (await call(h, "GET", "/beds", { client: owner })).json() as { id: string; status: string; propertyId: string }[];
    const bed = beds.find((b) => b.propertyId === h.propertyId)!;
    const created = await call(h, "POST", "/residents", {
      client: owner,
      body: { name: "R", email: "r@example.com", phone: "9876500020", propertyId: h.propertyId, room: "x", rent: 9000, status: "Active", joined: "2026-01-01", bedId: bed.id, corporateId: companyId },
    });
    expect(created.statusCode).toBe(201);
    const statusOf = async () =>
      ((await call(h, "GET", "/beds", { client: owner })).json() as { id: string; status: string }[]).find((b) => b.id === bed.id)!.status;
    expect(await statusOf()).toBe("Occupied");
    const { allocations } = (await call(h, "GET", "/portal", { client: owner })).json();
    expect(allocations[0].corporateId).toBe(companyId);
    const second = await call(h, "POST", "/residents", {
      client: owner,
      body: { name: "S", email: "s@example.com", phone: "9876500021", propertyId: h.propertyId, room: "x", rent: 9000, status: "Active", joined: "2026-01-01", bedId: bed.id },
    });
    expect(second.statusCode).toBe(409);
    const moved = await call(h, "PATCH", `/residents/${created.json().id}`, { client: owner, body: { status: "Moved out" } });
    expect(moved.statusCode).toBe(204);
    expect(await statusOf()).toBe("Available");
  });

  it("imports the owner's files, repeatably, and changes nothing on a dry run or a problem", async () => {
    const dir = mkdtempSync(join(tmpdir(), "owner-"));
    mkdirSync(dir, { recursive: true });
    const write = (name: string, text: string) => writeFileSync(join(dir, name), text);
    write("01_business.csv", "setting,value,notes\nrent_day,7,\nbusiness_name,Sehrawat PG,\n");
    write("02_properties.csv", 'property_name,area,sector,gender,audience,food_included,ac,cover_image,gallery_images,landmarks,amenities,description\nReal Home,DLF,"Sector 25, Gurugram",Unisex,Students,yes,no,/a.jpg,/a.jpg|/b.jpg,Metro:5 min,WiFi|Laundry,Nice\n');
    write("03_room_rates.csv", "property_name,sharing,monthly_rent_inr\nReal Home,double,12000\n");
    write("04_rooms_beds.csv", "property_name,room_code,sharing,bed_codes,blocked_bed_codes\nReal Home,201,double,A|B,B\n");
    write("05_company_accounts.csv", "company_name,contact_name,contact_email,contact_phone\nAcme,Boss,boss@acme.example,9876500030\n");
    write("06_residents.csv", "full_name,email,phone,property_name,room_code,bed_code,monthly_rent_inr,status,joined_on,company_name,whatsapp_opt_in_source\nRia,ria@example.com,9876500031,Real Home,201,A,12000,Active,2026-01-15,Acme,signed form 2026-01\n");
    write("07_opening_dues.csv", "resident_email,period,charge_type,description,due_on,amount_inr,already_paid_inr\nria@example.com,2026-10,rent,,2026-10-05,12000,2000\n");
    write("08_deposits_held.csv", "resident_email,amount_inr,received_on,reference\nria@example.com,24000,2026-01-15,RCPT1\n");
    write("09_meal_menu.csv", "day,breakfast,lunch,dinner\nMonday,Poha,Dal,Roti\n");

    const options = { apply: false, removeSamples: true };
    const dry = await importOwnerData(h.db, "sehrawat", dir, options);
    expect(dry.problems).toEqual([]);
    expect(dry.applied).toBe(false);
    expect(await h.db.selectFrom("properties").select("id").where("name", "=", "Real Home").execute()).toHaveLength(0);

    const applied = await importOwnerData(h.db, "sehrawat", dir, { ...options, apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.counts["sample properties removed"]).toBe(2);
    const again = await importOwnerData(h.db, "sehrawat", dir, { ...options, apply: true });
    expect(again.problems).toEqual([]);
    expect(await h.db.selectFrom("resident_profiles").select("id").execute()).toHaveLength(1);
    expect(await h.db.selectFrom("beds").select("id").execute()).toHaveLength(2);
    const invoice = await h.db.selectFrom("invoices").selectAll().executeTakeFirstOrThrow();
    expect([Number(invoice.paid_paise), invoice.status]).toEqual([200000, "Part paid"]);
    const deposits = await h.db.selectFrom("ledger_entries").selectAll().where("account", "=", "deposit_liability").execute();
    expect(deposits).toHaveLength(1);
    expect(await ledgerBalanced()).toBe(true);
    const contact = await h.db.selectFrom("contacts").selectAll().executeTakeFirstOrThrow();
    expect(contact.opt_in_source).toBe("signed form 2026-01");

    write("03_room_rates.csv", "property_name,sharing,monthly_rent_inr\nNo Such Home,quad,abc\n");
    write("02_properties.csv", "property_name,area,sector,gender,audience,food_included,ac,cover_image,gallery_images,landmarks,amenities,description\nBrand New,DLF,S,Unisex,,,,,,,,\n");
    const broken = await importOwnerData(h.db, "sehrawat", dir, { apply: true, removeSamples: false });
    expect(broken.applied).toBe(false);
    expect(broken.problems.length).toBeGreaterThan(1);
    expect(await h.db.selectFrom("properties").select("id").where("name", "=", "Brand New").execute()).toHaveLength(0);
  });

  it("allows the frontend origin but refuses webhooks without a raw signature", async () => {
    const response = await h.app.inject({
      method: "POST",
      url: "/webhooks/razorpay",
      headers: { "content-type": "application/json", origin: ORIGIN },
      payload: "{}",
    });
    expect(response.statusCode).toBe(401);
  });
});
