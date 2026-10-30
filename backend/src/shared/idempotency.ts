import { createHash } from "node:crypto";
import { isDuplicate, type Trx } from "../db/client.js";
import { HttpError, invalid } from "../http/errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireIdempotencyKey(value: unknown) {
  if (typeof value !== "string" || !UUID.test(value))
    throw invalid("This request is missing a valid Idempotency-Key.");
  return value.toLowerCase();
}

export function payloadHash(payload: unknown) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Runs `work` at most once per actor, endpoint and key, inside the caller's transaction, so a
 * rollback also releases the key. A concurrent duplicate waits on the row inserted here, then
 * either replays the committed result or proceeds if the first attempt rolled back.
 */
export async function idempotent<T>(
  trx: Trx,
  scope: { actor: string; endpoint: string; key: string; payload: unknown },
  work: () => Promise<T>,
): Promise<T> {
  const hash = payloadHash(scope.payload);
  const row = () =>
    trx
      .selectFrom("idempotency_keys")
      .select(["payload_hash", "response"])
      .where("actor", "=", scope.actor)
      .where("endpoint", "=", scope.endpoint)
      .where("idempotency_key", "=", scope.key);
  try {
    await trx
      .insertInto("idempotency_keys")
      .values({
        actor: scope.actor,
        endpoint: scope.endpoint,
        idempotency_key: scope.key,
        payload_hash: hash,
        response: null,
      })
      .execute();
  } catch (e) {
    if (!isDuplicate(e)) throw e;
    const existing = await row().executeTakeFirstOrThrow();
    if (existing.payload_hash !== hash)
      throw new HttpError(422, "This Idempotency-Key was already used for a different request.");
    return existing.response as T;
  }
  const result = await work();
  await trx
    .updateTable("idempotency_keys")
    .set({ response: JSON.stringify(result) })
    .where("actor", "=", scope.actor)
    .where("endpoint", "=", scope.endpoint)
    .where("idempotency_key", "=", scope.key)
    .execute();
  return result;
}
