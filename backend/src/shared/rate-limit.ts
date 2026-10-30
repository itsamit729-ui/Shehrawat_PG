import { sql } from "kysely";
import type { Db } from "../db/client.js";
import { tooMany } from "../http/errors.js";
import { hmac } from "../modules/identity/crypto.js";

export interface Limit {
  scope: string;
  subject: string;
  max: number;
  seconds: number;
}

/**
 * Counts a hit against a durable window that starts at the first hit, and throws 429 once it is
 * over the limit. The subject is stored only as a keyed hash, so phones and IPs stay out of this table.
 */
export async function consumeLimit(db: Db, secret: string, limit: Limit) {
  const keyHash = hmac(secret, `rate:${limit.scope}:${limit.subject}`);
  const expired = sql`window_started_at <= UTC_TIMESTAMP(6) - INTERVAL window_seconds SECOND`;
  // hits must be assigned first: MySQL evaluates these left to right, using already-updated values.
  await sql`
    INSERT INTO rate_limits (key_hash, window_started_at, window_seconds, hits)
    VALUES (${keyHash}, UTC_TIMESTAMP(6), ${limit.seconds}, 1)
    ON DUPLICATE KEY UPDATE
      hits = IF(${expired}, 1, hits + 1),
      window_started_at = IF(hits = 1, UTC_TIMESTAMP(6), window_started_at),
      window_seconds = ${limit.seconds}
  `.execute(db);
  const row = await db
    .selectFrom("rate_limits")
    .select("hits")
    .where("key_hash", "=", keyHash)
    .executeTakeFirst();
  if (row && row.hits > limit.max) throw tooMany();
}

export async function consumeLimits(db: Db, secret: string, limits: Limit[]) {
  for (const limit of limits) await consumeLimit(db, secret, limit);
}
