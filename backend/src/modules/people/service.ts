import { randomUUID } from "node:crypto";
import { dbNow, isDuplicate, lockingTransaction, withDeadlockRetry, type Db, type Trx } from "../../db/client.js";
import type { ResidentStatus } from "../../db/schema.js";
import { conflict, invalid, notFound } from "../../http/errors.js";
import { audit } from "../../shared/audit.js";
import { businessToday } from "../../shared/dates.js";
import { paiseToRupees, rupeesToPaise } from "../../shared/money.js";
import {
  deliverPasswordLink,
  issuePasswordToken,
  normalizeEmail,
  normalizePhone,
  type Context,
} from "../identity/service.js";
import { assignBed, endResidentStays } from "../inventory/allocations.js";

const DUPLICATE_CONTACT = "A person with this email or phone already exists.";

/** These can place someone on a bed, so they read current data under locks, like every allocation. */
const inBedTransaction = <T>(db: Db, work: (trx: Trx) => Promise<T>) =>
  withDeadlockRetry(() => lockingTransaction(db, work));

export interface ResidentInput {
  name: string;
  email: string;
  phone: string;
  propertyId: string;
  room: string;
  rent: number;
  status: ResidentStatus;
  joined: string;
  corporateId?: string;
  bedId?: string;
}

function residentQuery(db: Db, businessId: string) {
  return db
    .selectFrom("resident_profiles as r")
    .innerJoin("users as u", "u.id", "r.user_id")
    .select([
      "r.id",
      "u.name",
      "u.email",
      "u.phone",
      "r.property_id",
      "r.room_label",
      "r.monthly_rent_paise",
      "r.status",
      "r.joined_on",
      "r.corporate_id",
    ])
    .where("r.business_id", "=", businessId)
    .orderBy("r.created_at", "desc");
}

type ResidentRow = Awaited<ReturnType<ReturnType<typeof residentQuery>["execute"]>>[number];

/** The Resident shape of frontend/src/domain.ts. */
function toApi(r: ResidentRow) {
  return {
    id: r.id,
    name: r.name,
    email: r.email ?? "",
    phone: r.phone ?? "",
    propertyId: r.property_id,
    room: r.room_label,
    rent: paiseToRupees(Number(r.monthly_rent_paise)),
    status: r.status,
    joined: r.joined_on,
    ...(r.corporate_id ? { corporateId: r.corporate_id } : {}),
  };
}

export const listResidents = async (db: Db, businessId: string) =>
  (await residentQuery(db, businessId).execute()).map(toApi);

export const listResidentById = async (db: Db, businessId: string, residentId: string) =>
  (await residentQuery(db, businessId).where("r.id", "=", residentId).execute()).map(toApi);

export const listCorporateResidents = async (db: Db, businessId: string, corporateId: string) =>
  (await residentQuery(db, businessId).where("r.corporate_id", "=", corporateId).execute()).map(toApi);

async function assertOwnCorporate(db: Db, businessId: string, corporateId: string | undefined) {
  if (!corporateId) return;
  const company = await db
    .selectFrom("corporate_accounts")
    .select("id")
    .where("id", "=", corporateId)
    .where("business_id", "=", businessId)
    .executeTakeFirst();
  if (!company) throw invalid("Choose one of your company accounts.");
}

async function assertOwnProperty(db: Db, businessId: string, propertyId: string) {
  const property = await db
    .selectFrom("properties")
    .select("id")
    .where("id", "=", propertyId)
    .where("business_id", "=", businessId)
    .executeTakeFirst();
  if (!property) throw invalid("Choose one of your properties.");
}

/**
 * Creates the profile and an invited account. Does not reserve a bed.
 *
 * A self-service account with this email and no profile becomes this resident. If its email was
 * never proven, its password, sessions and Google link end here and only the invitation gets in.
 */
export async function createResident(
  ctx: Context,
  actor: { id: string; businessId: string },
  input: ResidentInput,
  requestId: string,
) {
  await assertOwnProperty(ctx.db, actor.businessId, input.propertyId);
  await assertOwnCorporate(ctx.db, actor.businessId, input.corporateId);
  const email = normalizeEmail(input.email);
  const residentId = randomUUID();
  let token: string | null;
  try {
    token = await inBedTransaction(ctx.db, async (trx) => {
      const existing = await trx
        .selectFrom("users as u")
        .leftJoin("resident_profiles as r", "r.user_id", "u.id")
        .select(["u.id", "u.role", "u.status", "u.email_verified_at", "r.id as resident_id"])
        .where("u.business_id", "=", actor.businessId)
        .where("u.email", "=", email)
        .forUpdate()
        .executeTakeFirst();
      if (existing && (existing.role !== "resident" || existing.resident_id || existing.status === "disabled"))
        throw conflict(DUPLICATE_CONTACT);
      const userId = existing?.id ?? randomUUID();
      const proven = Boolean(existing?.email_verified_at);
      if (existing) {
        await trx
          .updateTable("users")
          .set({
            name: input.name,
            phone: normalizePhone(input.phone),
            ...(proven ? {} : { password_hash: null, status: "invited" as const }),
            updated_at: dbNow,
          })
          .where("id", "=", userId)
          .execute();
        if (!proven) {
          await trx
            .updateTable("sessions")
            .set({ revoked_at: dbNow })
            .where("user_id", "=", userId)
            .where("revoked_at", "is", null)
            .execute();
          await trx.deleteFrom("google_identities").where("user_id", "=", userId).execute();
        }
      } else {
        await trx
          .insertInto("users")
          .values({
            id: userId,
            business_id: actor.businessId,
            role: "resident",
            name: input.name,
            email,
            phone: normalizePhone(input.phone),
            password_hash: null,
          })
          .execute();
      }
      await trx
        .insertInto("resident_profiles")
        .values({
          id: residentId,
          business_id: actor.businessId,
          user_id: userId,
          corporate_id: input.corporateId || null,
          property_id: input.propertyId,
          room_label: input.room,
          monthly_rent_paise: rupeesToPaise(input.rent),
          status: input.status,
          joined_on: input.joined,
        })
        .execute();
      if (input.bedId) await placeOnBed(trx, actor.businessId, residentId, input.bedId, input.joined);
      await audit(trx, {
        businessId: actor.businessId,
        actorUserId: actor.id,
        action: "resident.created",
        entityType: "resident",
        entityId: residentId,
        requestId,
      });
      return proven ? null : issuePasswordToken(trx, userId, "invite");
    });
  } catch (e) {
    if (isDuplicate(e)) throw conflict(DUPLICATE_CONTACT);
    throw e;
  }
  if (token) deliverPasswordLink(ctx, { email, name: input.name }, "invite", token);
  return { id: residentId };
}

/** The bed decides the home and room label, so the profile can't disagree with the allocation. */
async function placeOnBed(trx: Trx, businessId: string, residentId: string, bedId: string, start: string) {
  const { propertyId, roomLabel } = await assignBed(trx, { businessId, residentId, bedId, start });
  await trx
    .updateTable("resident_profiles")
    .set({ property_id: propertyId, room_label: roomLabel, updated_at: dbNow })
    .where("id", "=", residentId)
    .execute();
}

export async function updateResident(
  ctx: Context,
  actor: { id: string; businessId: string },
  residentId: string,
  input: Partial<ResidentInput>,
  requestId: string,
) {
  if (input.propertyId) await assertOwnProperty(ctx.db, actor.businessId, input.propertyId);
  await assertOwnCorporate(ctx.db, actor.businessId, input.corporateId);
  const fields = Object.keys(input);
  if (!fields.length) throw invalid("Nothing to update.");
  try {
    await inBedTransaction(ctx.db, async (trx) => {
      const resident = await trx
        .selectFrom("resident_profiles")
        .select(["user_id", "status", "joined_on"])
        .where("id", "=", residentId)
        .where("business_id", "=", actor.businessId)
        .forUpdate()
        .executeTakeFirst();
      if (!resident) throw notFound("This resident");
      if (input.name || input.email || input.phone)
        await trx
          .updateTable("users")
          .set({
            ...(input.name ? { name: input.name } : {}),
            ...(input.email ? { email: normalizeEmail(input.email) } : {}),
            ...(input.phone ? { phone: normalizePhone(input.phone) } : {}),
            updated_at: dbNow,
          })
          .where("id", "=", resident.user_id)
          .execute();
      await trx
        .updateTable("resident_profiles")
        .set({
          ...(input.propertyId ? { property_id: input.propertyId } : {}),
          ...(input.room ? { room_label: input.room } : {}),
          ...(input.rent !== undefined ? { monthly_rent_paise: rupeesToPaise(input.rent) } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.joined ? { joined_on: input.joined } : {}),
          ...(input.corporateId !== undefined ? { corporate_id: input.corporateId || null } : {}),
          updated_at: dbNow,
        })
        .where("id", "=", residentId)
        .execute();
      // Moving out frees the bed. A move to a new bed ends the old stay first.
      if (input.status === "Moved out" && resident.status !== "Moved out")
        await endResidentStays(trx, residentId, businessToday());
      if (input.bedId) {
        await endResidentStays(trx, residentId, businessToday());
        const today = businessToday();
        const joined = input.joined ?? resident.joined_on;
        await placeOnBed(trx, actor.businessId, residentId, input.bedId, joined > today ? joined : today);
      }
      await audit(trx, {
        businessId: actor.businessId,
        actorUserId: actor.id,
        action: "resident.updated",
        entityType: "resident",
        entityId: residentId,
        requestId,
        metadata: { fields },
      });
    });
  } catch (e) {
    if (isDuplicate(e)) throw conflict(DUPLICATE_CONTACT);
    throw e;
  }
}
