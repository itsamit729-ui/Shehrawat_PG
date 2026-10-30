import { sql } from "kysely";
import type { Db } from "../db/client.js";
import { sweepElapsedHolds } from "../modules/inventory/allocations.js";
import { enqueueJob, type JobHandler } from "./runner.js";

const INTERVAL_MS = 5 * 60 * 1000;

/** The occurrence key makes this safe from any number of ticks, processes and restarts. */
export async function scheduleHousekeeping(db: Db, now = Date.now()) {
  await enqueueJob(db, { kind: "housekeeping", dedupeKey: String(Math.floor(now / INTERVAL_MS)) });
}

export function housekeepingHandlers(db: Db): Record<string, JobHandler> {
  return {
    housekeeping: async () => {
      await sweepElapsedHolds(db);
      await db.deleteFrom("sessions").where("absolute_expires_at", "<", sql<Date>`UTC_TIMESTAMP(6) - INTERVAL 7 DAY`).execute();
      // Kept for 90 days because the monthly OTP allowance is counted from these rows.
      await db.deleteFrom("otp_challenges").where("created_at", "<", sql<Date>`UTC_TIMESTAMP(6) - INTERVAL 90 DAY`).execute();
      await db.deleteFrom("password_tokens").where("expires_at", "<", sql<Date>`UTC_TIMESTAMP(6) - INTERVAL 7 DAY`).execute();
      await db.deleteFrom("idempotency_keys").where("created_at", "<", sql<Date>`UTC_TIMESTAMP(6) - INTERVAL 7 DAY`).execute();
      await db.deleteFrom("rate_limits").where("window_started_at", "<", sql<Date>`UTC_TIMESTAMP(6) - INTERVAL 2 DAY`).execute();
      await db
        .deleteFrom("jobs")
        .where("state", "=", "done")
        .where("finished_at", "<", sql<Date>`UTC_TIMESTAMP(6) - INTERVAL 7 DAY`)
        .execute();
    },
  };
}
