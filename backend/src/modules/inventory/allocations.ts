import { randomUUID } from "node:crypto";
import { sql, type ExpressionBuilder, type Expression, type SqlBool } from "kysely";
import { dbNow, dbNowPlus, isLockTimeout, lockingTransaction, withDeadlockRetry, type Db, type Trx } from "../../db/client.js";
import type { Database, Sharing } from "../../db/schema.js";
import { conflict, invalid, notFound } from "../../http/errors.js";
import { idempotent } from "../../shared/idempotency.js";
import { addDays, businessToday } from "../../shared/dates.js";
import { paiseToRupees } from "../../shared/money.js";

export const HOLD_SECONDS = 15 * 60;
const MAX_MOVE_IN_DAYS_AHEAD = 180;
const NO_BED = "That room type has just been taken for this date. Please choose another.";

/**
 * The single definition of "this allocation occupies its bed at some point from `start` onward",
 * because new stays are open-ended. Availability screens and the locked check inside createHold
 * share it, so they can never disagree. Holds past their expiry stop counting immediately, even
 * if no sweep job has run.
 */
function blocksStay(
  eb: ExpressionBuilder<Database & { a: Database["bed_allocations"] }, "a">,
  start: string,
): Expression<SqlBool> {
  return eb.and([
    eb("a.state", "in", ["held", "confirmed", "occupied"]),
    sql<SqlBool>`(a.state <> 'held' OR a.hold_expires_at > UTC_TIMESTAMP(6))`,
    sql<SqlBool>`(a.stay_end IS NULL OR a.stay_end > ${start})`,
  ]);
}

export interface FreeBedCounts {
  [propertyId: string]: Partial<Record<Sharing, number>>;
}

/** Tentative counts for listings, from `from` onward. POST /holds is the authoritative answer. */
export async function countFreeBeds(db: Db, businessId: string, from: string) {
  const rows = await db
    .selectFrom("beds as b")
    .innerJoin("rooms as r", "r.id", "b.room_id")
    .select(["r.property_id", "r.sharing", (eb) => eb.fn.countAll<number>().as("free")])
    .where("b.business_id", "=", businessId)
    .where("b.active", "=", 1)
    .where("b.blocked", "=", 0)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("bed_allocations as a")
            .select("a.id")
            .whereRef("a.bed_id", "=", "b.id")
            .where((inner) => blocksStay(inner, from)),
        ),
      ),
    )
    .groupBy(["r.property_id", "r.sharing"])
    .execute();
  const counts: FreeBedCounts = {};
  for (const row of rows) (counts[row.property_id] ??= {})[row.sharing] = Number(row.free);
  return counts;
}

/** Bed status on `today`, for the owner's inventory screen. */
export async function listBedsWithStatus(db: Db, businessId: string, today: string) {
  const beds = await db
    .selectFrom("beds as b")
    .innerJoin("rooms as r", "r.id", "b.room_id")
    .select(["b.id", "b.blocked", "b.code", "r.code as room_code", "r.property_id", "r.sharing"])
    .where("b.business_id", "=", businessId)
    .where("b.active", "=", 1)
    .orderBy("r.property_id")
    .orderBy("r.code")
    .orderBy("b.code")
    .execute();
  const allocations = await db
    .selectFrom("bed_allocations as a")
    .leftJoin("bookings as k", "k.id", "a.booking_id")
    .select(["a.bed_id", "a.state", "k.resident_id"])
    .where("a.business_id", "=", businessId)
    .where("a.stay_start", "<=", today)
    .where((eb) => blocksStay(eb, today))
    .execute();
  const byBed = new Map(allocations.map((a) => [a.bed_id, a]));
  return beds.map((b) => {
    const allocation = byBed.get(b.id);
    const status = b.blocked
      ? "Blocked"
      : allocation
        ? allocation.state === "held"
          ? "Held"
          : "Occupied"
        : "Available";
    return {
      id: b.id,
      propertyId: b.property_id,
      room: b.room_code + b.code,
      type: b.sharing,
      status,
      ...(allocation?.resident_id ? { residentId: allocation.resident_id } : {}),
    };
  });
}

/** Locks in ID order, so two transactions wanting overlapping beds queue instead of deadlocking. */
async function lockBeds(trx: Trx, bedIds: string[]) {
  if (!bedIds.length) return [];
  return trx
    .selectFrom("beds")
    .select(["id", "active", "blocked"])
    .where("id", "in", bedIds)
    .orderBy("id")
    .forUpdate()
    .execute();
}

/** Marks elapsed holds on beds this transaction has locked, before it checks for overlaps. */
async function releaseElapsedHolds(trx: Trx, bedIds: string[]) {
  const stale = await trx
    .selectFrom("bed_allocations")
    .select(["id", "hold_id", "booking_id"])
    .where("bed_id", "in", bedIds)
    .where("state", "=", "held")
    .where("hold_expires_at", "<=", dbNow)
    .execute();
  if (stale.length) await expireAllocations(trx, stale);
}

async function expireAllocations(trx: Trx, stale: { id: string; hold_id: string | null; booking_id: string }[]) {
  await trx
    .updateTable("bed_allocations")
    .set({ state: "released", updated_at: dbNow })
    .where("id", "in", stale.map((s) => s.id))
    .execute();
  const holdIds = stale.flatMap((s) => (s.hold_id ? [s.hold_id] : []));
  if (holdIds.length)
    await trx
      .updateTable("holds")
      .set({ state: "expired" })
      .where("id", "in", holdIds)
      .where("state", "=", "active")
      .execute();
  await trx
    .updateTable("bookings")
    .set({ state: "expired", updated_at: dbNow })
    .where("id", "in", stale.map((s) => s.booking_id))
    .where("state", "=", "held")
    .execute();
}

export interface HoldRequest {
  businessId: string;
  propertyId: string;
  sharing: Sharing;
  moveIn: string;
  actor: string;
  idempotencyKey: string;
}

export interface HoldResult {
  id: string;
  expiresAt: string;
  amount: number;
}

export function assertMoveInDate(moveIn: string, today = businessToday()) {
  if (moveIn < today) throw invalid("Choose a future move-in date.");
  if (moveIn > addDays(today, MAX_MOVE_IN_DAYS_AHEAD))
    throw invalid(`Bookings open up to ${MAX_MOVE_IN_DAYS_AHEAD} days ahead.`);
}

/**
 * Reserves one bed of the requested type for 15 minutes, or fails with 409. The hold is a row with
 * an expiry, not an open transaction: this commits within milliseconds and checkout happens later.
 * The amount is computed here, so the client can never influence the quote.
 */
export async function createHold(db: Db, input: HoldRequest): Promise<HoldResult> {
  assertMoveInDate(input.moveIn);
  const payload = { propertyId: input.propertyId, sharing: input.sharing, moveIn: input.moveIn };
  try {
    return await withDeadlockRetry(() =>
      lockingTransaction(db, (trx) =>
        idempotent(
          trx,
          { actor: input.actor, endpoint: "POST /holds", key: input.idempotencyKey, payload },
          () => reserveBed(trx, input),
        ),
      ),
    );
  } catch (e) {
    if (isLockTimeout(e)) throw conflict(NO_BED);
    throw e;
  }
}

async function reserveBed(trx: Trx, input: HoldRequest): Promise<HoldResult> {
  const rate = await trx
    .selectFrom("property_rates as pr")
    .innerJoin("properties as p", "p.id", "pr.property_id")
    .select("pr.monthly_rent_paise")
    .where("pr.property_id", "=", input.propertyId)
    .where("pr.sharing", "=", input.sharing)
    .where("p.business_id", "=", input.businessId)
    .executeTakeFirst();
  if (!rate) throw notFound("This room type");

  const candidates = await trx
    .selectFrom("beds as b")
    .innerJoin("rooms as r", "r.id", "b.room_id")
    .select("b.id")
    .where("r.property_id", "=", input.propertyId)
    .where("r.sharing", "=", input.sharing)
    .where("b.business_id", "=", input.businessId)
    .where("b.active", "=", 1)
    .where("b.blocked", "=", 0)
    .execute();
  const candidateIds = candidates.map((c) => c.id);
  if (!candidateIds.length) throw conflict(NO_BED);

  // Locking every candidate serializes holds per room type, which is ample at this size and means
  // the choice below cannot be invalidated by a competitor. Status is re-read under the lock.
  const locked = await lockBeds(trx, candidateIds);
  await releaseElapsedHolds(trx, candidateIds);
  const taken = await trx
    .selectFrom("bed_allocations as a")
    .select("a.bed_id")
    .where("a.bed_id", "in", candidateIds)
    .where((eb) => blocksStay(eb, input.moveIn))
    .execute();
  const takenIds = new Set(taken.map((t) => t.bed_id));
  const bed = locked.find((b) => b.active === 1 && b.blocked === 0 && !takenIds.has(b.id));
  if (!bed) throw conflict(NO_BED);

  const bookingId = randomUUID();
  const holdId = randomUUID();
  await trx
    .insertInto("bookings")
    .values({ id: bookingId, business_id: input.businessId, resident_id: null, state: "held" })
    .execute();
  await trx
    .insertInto("holds")
    .values({
      id: holdId,
      business_id: input.businessId,
      booking_id: bookingId,
      amount_paise: rate.monthly_rent_paise,
      expires_at: dbNowPlus(HOLD_SECONDS),
    })
    .execute();
  const hold = await trx
    .selectFrom("holds")
    .select(["expires_at", "amount_paise"])
    .where("id", "=", holdId)
    .executeTakeFirstOrThrow();
  await trx
    .insertInto("bed_allocations")
    .values({
      id: randomUUID(),
      business_id: input.businessId,
      bed_id: bed.id,
      booking_id: bookingId,
      hold_id: holdId,
      state: "held",
      hold_expires_at: hold.expires_at,
      stay_start: input.moveIn,
      stay_end: null,
    })
    .execute();
  return {
    id: holdId,
    expiresAt: hold.expires_at.toISOString(),
    amount: paiseToRupees(Number(hold.amount_paise)),
  };
}

/** Available ↔ Blocked, refused while any current or future stay or live hold uses the bed. */
export async function setBedBlocked(db: Db, businessId: string, bedId: string, blocked: boolean) {
  await withDeadlockRetry(() =>
    lockingTransaction(db, async (trx) => {
      const bed = await trx
        .selectFrom("beds")
        .select("id")
        .where("id", "=", bedId)
        .where("business_id", "=", businessId)
        .forUpdate()
        .executeTakeFirst();
      if (!bed) throw notFound("This bed");
      if (blocked) {
        await releaseElapsedHolds(trx, [bedId]);
        const inUse = await trx
          .selectFrom("bed_allocations as a")
          .select("a.id")
          .where("a.bed_id", "=", bedId)
          .where((eb) => blocksStay(eb, businessToday()))
          .executeTakeFirst();
        if (inUse) throw conflict("This bed has a current or upcoming stay, so it can't be blocked.");
      }
      await trx.updateTable("beds").set({ blocked: blocked ? 1 : 0 }).where("id", "=", bedId).execute();
    }),
  );
}

/**
 * Housekeeping only: correctness never depends on this running, because every read and allocation
 * already ignores elapsed holds. Beds lock first, matching createHold's order.
 */
export async function sweepElapsedHolds(db: Db, batchSize = 100) {
  const due = await db
    .selectFrom("bed_allocations")
    .select("bed_id")
    .where("state", "=", "held")
    .where("hold_expires_at", "<=", dbNow)
    .limit(batchSize)
    .execute();
  const bedIds = [...new Set(due.map((d) => d.bed_id))];
  if (!bedIds.length) return 0;
  await withDeadlockRetry(() =>
    lockingTransaction(db, async (trx) => {
      await lockBeds(trx, bedIds);
      await releaseElapsedHolds(trx, bedIds);
    }),
  );
  return due.length;
}
