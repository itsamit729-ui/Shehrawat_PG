import { dbNow, type Db } from "../db/client.js";
import { processRazorpayEvent, reconcileOrders, runMonthlyBilling, sendRefund } from "../modules/finance/service.js";
import type { Context } from "../modules/identity/service.js";
import {
  deliverMessage,
  processWhatsAppEvent,
  queueDailyReminders,
  sendCampaignBatch,
  sendRuleMessage,
  startCampaign,
} from "../modules/messaging/service.js";
import { getSettings } from "../modules/operations/service.js";
import { businessToday } from "../shared/dates.js";
import { enqueueJob, type JobHandler } from "./runner.js";

const RECONCILE_MS = 5 * 60 * 1000;

/** The occurrence keys make this safe from any number of ticks, processes and restarts. */
export async function scheduleBusinessJobs(db: Db, now = Date.now()) {
  await enqueueJob(db, { kind: "payments.reconcile", dedupeKey: String(Math.floor(now / RECONCILE_MS)) });
  await enqueueJob(db, { kind: "daily.run", dedupeKey: businessToday(new Date(now)) });
}

export function businessHandlers(ctx: Context): Record<string, JobHandler> {
  return {
    "webhook.process": async (payload) => {
      const { inboxId } = payload as { inboxId: string };
      const event = await ctx.db
        .selectFrom("webhook_inbox")
        .select(["provider", "payload", "processed_at"])
        .where("id", "=", inboxId)
        .executeTakeFirst();
      if (!event || event.processed_at) return;
      if (event.provider === "razorpay") await processRazorpayEvent(ctx, event.payload);
      else {
        // A single business runs on this service, and Meta's payload doesn't name it.
        const business = await ctx.db.selectFrom("businesses").select("id").executeTakeFirstOrThrow();
        await processWhatsAppEvent(ctx, business.id, event.payload);
      }
      await ctx.db.updateTable("webhook_inbox").set({ processed_at: dbNow }).where("id", "=", inboxId).execute();
    },
    "refund.send": async (payload) => sendRefund(ctx, (payload as { refundId: string }).refundId),
    "payments.reconcile": async () => void (await reconcileOrders(ctx)),
    "daily.run": async () => {
      for (const { id } of await ctx.db.selectFrom("businesses").select("id").execute()) {
        const settings = await getSettings(ctx.db, id);
        if (settings.billingEnabled) await runMonthlyBilling(ctx.db, id, settings.rentDay);
        await queueDailyReminders(ctx, id);
      }
    },
    "message.send": async (payload) => {
      const { messageId, confirmsConsent } = payload as { messageId: string; confirmsConsent?: boolean };
      await deliverMessage(ctx, messageId, confirmsConsent);
    },
    "campaign.start": async (payload) => startCampaign(ctx, (payload as { campaignId: string }).campaignId),
    "campaign.batch": async (payload) => {
      const { campaignId, sequence } = payload as { campaignId: string; sequence: number };
      await sendCampaignBatch(ctx, campaignId, sequence);
    },
    "rule.send": async (payload) => {
      const { rule, residentId, params } = payload as { rule: string; residentId: string; params: string[] };
      await sendRuleMessage(ctx, rule, residentId, params);
    },
  };
}
