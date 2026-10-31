import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { dbNow, type Db, type Trx } from "../../db/client.js";
import { conflict, HttpError, invalid, notFound } from "../../http/errors.js";
import { enqueueJob } from "../../jobs/runner.js";
import { audit } from "../../shared/audit.js";
import { addDays, businessToday } from "../../shared/dates.js";
import { idempotent } from "../../shared/idempotency.js";
import { ProviderRejected, type WhatsAppProvider } from "../../providers/index.js";
import type { Context, SessionUser } from "../identity/service.js";
import { getSettings, type Settings } from "../operations/service.js";

const NO_WHATSAPP = "WhatsApp isn't connected yet.";
const CAMPAIGN_BATCH = 20;

/** Stored as the +91 form used everywhere else. Meta sends digits only. */
const fromMetaPhone = (wa: string) => (wa.startsWith("+") ? wa : `+${wa}`);

const inWindow = sql<number>`c.last_inbound_at > UTC_TIMESTAMP(6) - INTERVAL 24 HOUR`;

export async function listConversations(db: Db, businessId: string) {
  const conversations = await db
    .selectFrom("conversations as c")
    .innerJoin("contacts as t", "t.id", "c.contact_id")
    .select(["c.id", "t.name", "t.phone", "t.resident_id", "c.mode", "c.assignee", "c.last_inbound_at"])
    .where("c.business_id", "=", businessId)
    .orderBy("c.last_inbound_at", "desc")
    .limit(200)
    .execute();
  if (!conversations.length) return [];
  const messages = await db
    .selectFrom("messages")
    .select(["id", "conversation_id", "body", "sender", "status", "created_at"])
    .where("conversation_id", "in", conversations.map((c) => c.id))
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return conversations.map((c) => ({
    id: c.id,
    name: c.name || c.phone,
    residentId: c.resident_id ?? "",
    mode: c.mode,
    assignee: c.assignee,
    lastInbound: c.last_inbound_at?.toISOString() ?? "",
    messages: messages
      .filter((m) => m.conversation_id === c.id)
      .map((m) => ({
        id: m.id,
        body: m.body,
        sender: m.sender,
        time: m.created_at.toISOString(),
        status: m.status,
      })),
  }));
}

export async function updateConversation(
  ctx: Context,
  businessId: string,
  id: string,
  changes: { mode?: "Bot" | "Human"; assignee?: string },
) {
  if (!Object.keys(changes).length) return;
  const result = await ctx.db
    .updateTable("conversations")
    .set(changes)
    .where("id", "=", id)
    .where("business_id", "=", businessId)
    .executeTakeFirst();
  if (!result.numUpdatedRows) throw notFound("This conversation");
}

export async function queueStaffMessage(ctx: Context, actor: SessionUser, conversationId: string, body: string, key: string) {
  if (!ctx.providers.whatsapp) throw new HttpError(503, NO_WHATSAPP);
  return ctx.db.transaction().execute((trx) =>
    idempotent(
      trx,
      { actor: actor.id, endpoint: "POST /messages/send", key, payload: { conversationId, body } },
      async () => {
        const conversation = await trx
          .selectFrom("conversations as c")
          .innerJoin("contacts as t", "t.id", "c.contact_id")
          .select(["c.id", "c.mode", "t.opted_out_at", inWindow.as("open")])
          .where("c.id", "=", conversationId)
          .where("c.business_id", "=", actor.businessId)
          .executeTakeFirst();
        if (!conversation) throw notFound("This conversation");
        if (conversation.mode !== "Human") throw conflict("Take over this conversation before replying.");
        if (conversation.opted_out_at) throw conflict("This person has opted out of messages.");
        if (!conversation.open) throw conflict("The 24-hour reply window has closed. Use an approved template.");
        return queueMessage(trx, conversationId, "staff", body);
      },
    ),
  );
}

/** `confirmsConsent` is for the one message allowed to reach someone who just opted out. */
async function queueMessage(
  trx: Trx,
  conversationId: string,
  sender: "staff" | "bot",
  body: string,
  confirmsConsent = false,
) {
  const id = randomUUID();
  await trx
    .insertInto("messages")
    .values({ id, conversation_id: conversationId, sender, body, provider_message_id: null, status: "queued" })
    .execute();
  await enqueueJob(trx, { kind: "message.send", dedupeKey: id, payload: { messageId: id, confirmsConsent } });
  return { id };
}

/**
 * Consent and the window are checked again here, because either can change after the message was
 * queued. The row moves to "review" before the call: if the process dies mid-send, this message is
 * left for a person rather than resent, since WhatsApp has no idempotency key.
 */
export async function deliverMessage(ctx: Context, messageId: string, confirmsConsent = false) {
  const whatsapp = ctx.providers.whatsapp;
  if (!whatsapp) return;
  const message = await ctx.db
    .selectFrom("messages as m")
    .innerJoin("conversations as c", "c.id", "m.conversation_id")
    .innerJoin("contacts as t", "t.id", "c.contact_id")
    .select(["m.id", "m.body", "m.status", "t.phone", "t.opted_out_at", inWindow.as("open")])
    .where("m.id", "=", messageId)
    .executeTakeFirst();
  if (!message || message.status !== "queued") return;
  const setStatus = (status: "failed" | "review" | "sent", providerId?: string) =>
    ctx.db
      .updateTable("messages")
      .set({ status, ...(providerId ? { provider_message_id: providerId } : {}) })
      .where("id", "=", messageId)
      .execute();
  if ((message.opted_out_at && !confirmsConsent) || !message.open) return void (await setStatus("failed"));
  await setStatus("review");
  try {
    const { id } = await whatsapp.sendText(message.phone, message.body);
    await setStatus("sent", id);
  } catch (e) {
    if (e instanceof ProviderRejected) await setStatus("failed");
    else ctx.log.error("A WhatsApp message has an unknown outcome and needs review");
  }
}

const STATUS_RANK = { sent: 1, delivered: 2, read: 3 } as const;

/** Callbacks arrive out of order, so a status only ever moves forward. */
async function applyStatus(db: Db, providerId: string, status: string) {
  if (status === "failed") {
    await db
      .updateTable("messages")
      .set({ status: "failed" })
      .where("provider_message_id", "=", providerId)
      .where("status", "in", ["sent", "review"])
      .execute();
    await db
      .updateTable("campaign_recipients")
      .set({ state: "failed" })
      .where("provider_message_id", "=", providerId)
      .where("state", "in", ["sent", "review"])
      .execute();
    return;
  }
  const rank = STATUS_RANK[status as keyof typeof STATUS_RANK];
  if (!rank) return;
  const earlier = (Object.keys(STATUS_RANK) as (keyof typeof STATUS_RANK)[]).filter((s) => STATUS_RANK[s] < rank);
  await db
    .updateTable("messages")
    .set({ status: status as "sent" })
    .where("provider_message_id", "=", providerId)
    .where("status", "in", ["review", "queued", ...earlier])
    .execute();
  await db
    .updateTable("campaign_recipients")
    .set({ state: status as "sent" })
    .where("provider_message_id", "=", providerId)
    .where("state", "in", ["review", ...earlier])
    .execute();
}

const OPT_OUT = /^\s*(stop|unsubscribe|opt ?out)\s*$/i;
const OPT_IN = /^\s*(start|subscribe|opt ?in)\s*$/i;

/** Deliberately rule-based: anything it can't answer goes to a person, and it never invents facts. */
export function botReply(body: string, frontendUrl: string): { text: string; handoff: boolean } {
  const text = body.toLowerCase();
  if (/\b(human|agent|staff|owner|manager|person|call me)\b/.test(text))
    return { text: "Thanks. Someone from our team will reply here soon.", handoff: true };
  if (/\b(rent|price|cost|fee|charges?|availab)/.test(text))
    return { text: `You can see homes, room types and current rents here: ${frontendUrl}/explore`, handoff: false };
  if (/\b(visit|tour|see the|location|address)\b/.test(text))
    return { text: `You can choose a home and request a visit here: ${frontendUrl}/explore`, handoff: false };
  if (/^\s*(hi|hello|hey|namaste)\b/.test(text))
    return {
      text: "Welcome to Sehrawat PG. Ask about rent or a visit, or say 'staff' to reach our team. Reply STOP to opt out.",
      handoff: false,
    };
  return { text: "Thanks for your message. Someone from our team will reply here soon.", handoff: true };
}

interface InboundMessage {
  id: string;
  from: string;
  type?: string;
  text?: { body?: string };
}

/** Handles one saved webhook. A message ID seen before changes nothing, so reruns are safe. */
export async function processWhatsAppEvent(ctx: Context, businessId: string, payload: unknown) {
  const entries = (payload as { entry?: { changes?: { value?: unknown }[] }[] }).entry ?? [];
  for (const change of entries.flatMap((e) => e.changes ?? [])) {
    const value = (change.value ?? {}) as {
      contacts?: { wa_id?: string; profile?: { name?: string } }[];
      messages?: InboundMessage[];
      statuses?: { id: string; status: string }[];
    };
    for (const message of value.messages ?? []) {
      const name = value.contacts?.find((c) => c.wa_id === message.from)?.profile?.name ?? "";
      await receiveMessage(ctx, businessId, message, name);
    }
    for (const status of value.statuses ?? []) await applyStatus(ctx.db, status.id, status.status);
  }
}

async function receiveMessage(ctx: Context, businessId: string, message: InboundMessage, name: string) {
  const phone = fromMetaPhone(message.from);
  const body = message.type === "text" ? (message.text?.body ?? "") : `[${message.type ?? "unsupported"} message]`;
  await ctx.db.transaction().execute(async (trx) => {
    const resident = await trx
      .selectFrom("users as u")
      .innerJoin("resident_profiles as r", "r.user_id", "u.id")
      .select("r.id")
      .where("u.business_id", "=", businessId)
      .where("u.phone", "=", phone)
      .executeTakeFirst();
    await trx
      .insertInto("contacts")
      .ignore()
      .values({
        id: randomUUID(),
        business_id: businessId,
        phone,
        name: name.slice(0, 160),
        resident_id: resident?.id ?? null,
        opt_in_source: null,
      })
      .execute();
    const contact = await trx
      .selectFrom("contacts")
      .select("id")
      .where("business_id", "=", businessId)
      .where("phone", "=", phone)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await trx
      .insertInto("conversations")
      .ignore()
      .values({ id: randomUUID(), business_id: businessId, contact_id: contact.id })
      .execute();
    const conversation = await trx
      .selectFrom("conversations")
      .select(["id", "mode"])
      .where("contact_id", "=", contact.id)
      .executeTakeFirstOrThrow();
    const inserted = await trx
      .insertInto("messages")
      .ignore()
      .values({
        id: randomUUID(),
        conversation_id: conversation.id,
        sender: "customer",
        body,
        provider_message_id: message.id,
        status: "received",
      })
      .executeTakeFirst();
    if (!inserted.numInsertedOrUpdatedRows) return;
    await trx
      .updateTable("conversations")
      .set({ last_inbound_at: dbNow })
      .where("id", "=", conversation.id)
      .execute();

    // Opt-out takes effect at once and outranks everything else, including a human's assignment.
    if (OPT_OUT.test(body)) {
      await trx.updateTable("contacts").set({ opted_out_at: dbNow }).where("id", "=", contact.id).execute();
      if (ctx.providers.whatsapp)
        await queueMessage(trx, conversation.id, "bot", "You've been opted out. Reply START to opt back in.", true);
      return;
    }
    if (OPT_IN.test(body)) {
      await trx
        .updateTable("contacts")
        .set({ opted_out_at: null, opted_in_at: dbNow, opt_in_source: "whatsapp:start" })
        .where("id", "=", contact.id)
        .execute();
      if (ctx.providers.whatsapp)
        await queueMessage(trx, conversation.id, "bot", "You're opted in. Reply STOP at any time to opt out.");
      return;
    }
    if (conversation.mode !== "Bot" || !ctx.providers.whatsapp) return;
    const reply = botReply(body, ctx.frontendUrl);
    await queueMessage(trx, conversation.id, "bot", reply.text);
    if (reply.handoff)
      await trx
        .updateTable("conversations")
        .set({ mode: "Human", assignee: "Owner" })
        .where("id", "=", conversation.id)
        .execute();
  });
}

export async function listCampaigns(db: Db, businessId: string) {
  const rows = await db
    .selectFrom("campaigns as k")
    .leftJoin("campaign_recipients as r", "r.campaign_id", "k.id")
    .select([
      "k.id",
      "k.name",
      "k.template",
      "k.audience",
      "k.scheduled_at",
      "k.status",
      sql<number>`COUNT(r.contact_id)`.as("recipients"),
      sql<number>`COALESCE(SUM(r.state IN ('delivered', 'read')), 0)`.as("delivered"),
    ])
    .where("k.business_id", "=", businessId)
    .groupBy(["k.id", "k.name", "k.template", "k.audience", "k.scheduled_at", "k.status", "k.created_at"])
    .orderBy("k.created_at", "desc")
    .execute();
  return rows.map((k) => ({
    id: k.id,
    name: k.name,
    template: k.template,
    audience: k.audience,
    scheduled: k.scheduled_at.toISOString(),
    status: k.status,
    recipients: Number(k.recipients),
    delivered: Number(k.delivered),
  }));
}

/** A form's datetime-local value has no zone. Business times are Indian time. */
export function parseBusinessTime(value: string) {
  const zoned = /(Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}+05:30`;
  const parsed = new Date(zoned);
  if (Number.isNaN(parsed.getTime())) throw invalid("Enter a valid time.");
  return parsed;
}

export interface CampaignInput {
  name: string;
  template: string;
  audience: "Opted-in leads" | "Opted-in residents";
  scheduled: string;
}

export async function createCampaign(ctx: Context, actor: SessionUser, input: CampaignInput, key: string) {
  return ctx.db.transaction().execute((trx) =>
    idempotent(trx, { actor: actor.id, endpoint: "POST /campaigns", key, payload: input }, async () => {
      const id = randomUUID();
      await trx
        .insertInto("campaigns")
        .values({
          id,
          business_id: actor.businessId,
          name: input.name,
          template: input.template,
          audience: input.audience,
          scheduled_at: parseBusinessTime(input.scheduled),
        })
        .execute();
      return { id };
    }),
  );
}

export async function updateCampaign(ctx: Context, businessId: string, id: string, input: Partial<CampaignInput>) {
  const { scheduled, ...rest } = input;
  const result = await ctx.db
    .updateTable("campaigns")
    .set({ ...rest, ...(scheduled ? { scheduled_at: parseBusinessTime(scheduled) } : {}), updated_at: dbNow })
    .where("id", "=", id)
    .where("business_id", "=", businessId)
    .where("status", "=", "Draft")
    .executeTakeFirst();
  if (!result.numUpdatedRows) throw conflict("Only a draft campaign can be changed.");
}

/** Who may receive marketing right now. A recorded opt-in is required, and an opt-out always wins. */
function audienceQuery(db: Db | Trx, businessId: string, audience: CampaignInput["audience"]) {
  return db
    .selectFrom("contacts")
    .where("business_id", "=", businessId)
    .where("opted_in_at", "is not", null)
    .where("opted_out_at", "is", null)
    .where("resident_id", audience === "Opted-in residents" ? "is not" : "is", null);
}

export async function scheduleCampaign(ctx: Context, actor: SessionUser, id: string, requestId: string) {
  const whatsapp = ctx.providers.whatsapp;
  if (!whatsapp) throw new HttpError(503, NO_WHATSAPP);
  const campaign = await ctx.db
    .selectFrom("campaigns")
    .selectAll()
    .where("id", "=", id)
    .where("business_id", "=", actor.businessId)
    .executeTakeFirst();
  if (!campaign) throw notFound("This campaign");
  if (campaign.status !== "Draft") throw conflict("This campaign has already been scheduled.");
  if (campaign.scheduled_at.getTime() <= Date.now()) throw invalid("Choose a future schedule time.");
  if (!(await whatsapp.templateApproved(campaign.template)))
    throw invalid("This template isn't approved by WhatsApp yet.");
  const { count } = await audienceQuery(ctx.db, actor.businessId, campaign.audience)
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  const { campaignRecipientCap } = await getSettings(ctx.db, actor.businessId);
  if (!Number(count)) throw invalid("Nobody in this audience has opted in.");
  if (Number(count) > campaignRecipientCap)
    throw invalid(`This reaches ${count} people, above the limit of ${campaignRecipientCap} set in settings.`);
  await ctx.db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("campaigns")
      .set({ status: "Scheduled", updated_at: dbNow })
      .where("id", "=", id)
      .where("status", "=", "Draft")
      .executeTakeFirst();
    if (!updated.numUpdatedRows) throw conflict("This campaign has already been scheduled.");
    await enqueueJob(trx, { kind: "campaign.start", dedupeKey: id, payload: { campaignId: id }, runAt: campaign.scheduled_at });
    await audit(trx, {
      businessId: actor.businessId,
      actorUserId: actor.id,
      action: "campaign.scheduled",
      entityType: "campaign",
      entityId: id,
      requestId,
      metadata: { recipients: Number(count) },
    });
  });
}

/** Recipients are fixed at start time, so an opt-out before then is never included. */
export async function startCampaign(ctx: Context, campaignId: string) {
  await ctx.db.transaction().execute(async (trx) => {
    const campaign = await trx
      .selectFrom("campaigns")
      .select(["business_id", "audience", "status"])
      .where("id", "=", campaignId)
      .forUpdate()
      .executeTakeFirst();
    if (!campaign || campaign.status !== "Scheduled") return;
    const contacts = await audienceQuery(trx, campaign.business_id, campaign.audience).select("id").execute();
    if (contacts.length)
      await trx
        .insertInto("campaign_recipients")
        .ignore()
        .values(contacts.map((c) => ({ campaign_id: campaignId, contact_id: c.id, provider_message_id: null })))
        .execute();
    await trx.updateTable("campaigns").set({ status: "Sending", updated_at: dbNow }).where("id", "=", campaignId).execute();
    await enqueueJob(trx, { kind: "campaign.batch", dedupeKey: `${campaignId}:0`, payload: { campaignId, sequence: 0 } });
  });
}

/** Rechecks consent per person, and marks each row before the call so a crash can't double-send. */
export async function sendCampaignBatch(ctx: Context, campaignId: string, sequence: number) {
  const whatsapp = ctx.providers.whatsapp;
  if (!whatsapp) return;
  const campaign = await ctx.db
    .selectFrom("campaigns")
    .select(["template", "status"])
    .where("id", "=", campaignId)
    .executeTakeFirst();
  if (campaign?.status !== "Sending") return;
  const batch = await ctx.db
    .selectFrom("campaign_recipients as r")
    .innerJoin("contacts as t", "t.id", "r.contact_id")
    .select(["r.contact_id", "t.phone", "t.name", "t.opted_out_at", "t.opted_in_at"])
    .where("r.campaign_id", "=", campaignId)
    .where("r.state", "=", "queued")
    .limit(CAMPAIGN_BATCH)
    .execute();
  for (const person of batch) {
    const row = ctx.db
      .updateTable("campaign_recipients")
      .where("campaign_id", "=", campaignId)
      .where("contact_id", "=", person.contact_id);
    if (person.opted_out_at || !person.opted_in_at) {
      await row.set({ state: "skipped" }).execute();
      continue;
    }
    await row.set({ state: "review" }).execute();
    try {
      const { id } = await whatsapp.sendTemplate(person.phone, campaign.template, []);
      await row.set({ state: "sent", provider_message_id: id, sent_at: dbNow }).execute();
    } catch (e) {
      if (e instanceof ProviderRejected) await row.set({ state: "failed" }).execute();
    }
  }
  if (batch.length === CAMPAIGN_BATCH) {
    const next = sequence + 1;
    await enqueueJob(ctx.db, { kind: "campaign.batch", dedupeKey: `${campaignId}:${next}`, payload: { campaignId, sequence: next } });
    return;
  }
  await ctx.db.updateTable("campaigns").set({ status: "Sent", updated_at: dbNow }).where("id", "=", campaignId).execute();
}

const RULE_TEMPLATE: Record<string, { key: keyof Settings; template: string }> = {
  rentReminder: { key: "rentReminder", template: "rent_reminder" },
  paymentReceipt: { key: "paymentReceipt", template: "payment_receipt" },
  moveInWelcome: { key: "moveInWelcome", template: "move_in_welcome" },
  complaintUpdate: { key: "complaintUpdate", template: "complaint_update" },
  agreementReminder: { key: "agreementReminder", template: "agreement_reminder" },
};

/** An automation runs only if its rule is on and this person opted in, both checked at send time. */
export async function sendRuleMessage(ctx: Context, rule: string, residentId: string, params: string[]) {
  const whatsapp: WhatsAppProvider | null | undefined = ctx.providers.whatsapp;
  const definition = RULE_TEMPLATE[rule];
  if (!whatsapp || !definition) return;
  const contact = await ctx.db
    .selectFrom("contacts")
    .select(["phone", "business_id"])
    .where("resident_id", "=", residentId)
    .where("opted_in_at", "is not", null)
    .where("opted_out_at", "is", null)
    .executeTakeFirst();
  if (!contact) return;
  const settings = await getSettings(ctx.db, contact.business_id);
  if (settings[definition.key] !== true) return;
  try {
    await whatsapp.sendTemplate(contact.phone, definition.template, params);
  } catch (e) {
    // Retrying a timeout could send twice, and a reminder isn't worth that.
    if (!(e instanceof ProviderRejected)) ctx.log.error({ rule }, "An automated message has an unknown outcome");
  }
}

/** Reminders for rent due in three days and agreements left unsigned for three days. */
export async function queueDailyReminders(ctx: Context, businessId: string, today = businessToday()) {
  if (!ctx.providers.whatsapp) return;
  const due = await ctx.db
    .selectFrom("invoices")
    .select(["id", "resident_id", "due_on", "amount_paise", "paid_paise"])
    .where("business_id", "=", businessId)
    .where("status", "in", ["Due", "Part paid"])
    .where("due_on", "=", addDays(today, 3))
    .where("resident_id", "is not", null)
    .where("corporate_id", "is", null)
    .execute();
  for (const invoice of due)
    await enqueueJob(ctx.db, {
      kind: "rule.send",
      dedupeKey: `rent:${invoice.id}`,
      payload: {
        rule: "rentReminder",
        residentId: invoice.resident_id,
        params: [invoice.due_on, String((Number(invoice.amount_paise) - Number(invoice.paid_paise)) / 100)],
      },
    });
  const unsigned = await ctx.db
    .selectFrom("agreements")
    .select(["id", "resident_id", "title"])
    .where("business_id", "=", businessId)
    .where("status", "=", "Sent")
    .where("updated_at", "<", sql<Date>`UTC_TIMESTAMP(6) - INTERVAL 3 DAY`)
    .execute();
  for (const agreement of unsigned)
    await enqueueJob(ctx.db, {
      kind: "rule.send",
      dedupeKey: `agreement:${agreement.id}:${today}`,
      payload: { rule: "agreementReminder", residentId: agreement.resident_id, params: [agreement.title] },
    });
}
