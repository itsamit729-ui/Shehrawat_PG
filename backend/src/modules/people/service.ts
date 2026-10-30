import { randomUUID } from "node:crypto";
import { dbNow, isDuplicate, type Db } from "../../db/client.js";
import type { ResidentStatus } from "../../db/schema.js";
import { conflict, invalid, notFound } from "../../http/errors.js";
import { audit } from "../../shared/audit.js";
import { paiseToRupees, rupeesToPaise } from "../../shared/money.js";
import {
  deliverPasswordLink,
  issuePasswordToken,
  normalizeEmail,
  normalizePhone,
  type Context,
} from "../identity/service.js";

const DUPLICATE_CONTACT = "A person with this email or phone already exists.";

export interface ResidentInput {
  name: string;
  email: string;
  phone: string;
  propertyId: string;
  room: string;
  rent: number;
  status: ResidentStatus;
  joined: string;
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

async function assertOwnProperty(db: Db, businessId: string, propertyId: string) {
  const property = await db
    .selectFrom("properties")
    .select("id")
    .where("id", "=", propertyId)
    .where("business_id", "=", businessId)
    .executeTakeFirst();
  if (!property) throw invalid("Choose one of your properties.");
}

/** Creates the profile and an invited account. Does not reserve a bed. */
export async function createResident(
  ctx: Context,
  actor: { id: string; businessId: string },
  input: ResidentInput,
  requestId: string,
) {
  await assertOwnProperty(ctx.db, actor.businessId, input.propertyId);
  const email = normalizeEmail(input.email);
  const userId = randomUUID();
  const residentId = randomUUID();
  let token: string;
  try {
    token = await ctx.db.transaction().execute(async (trx) => {
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
      await trx
        .insertInto("resident_profiles")
        .values({
          id: residentId,
          business_id: actor.businessId,
          user_id: userId,
          corporate_id: null,
          property_id: input.propertyId,
          room_label: input.room,
          monthly_rent_paise: rupeesToPaise(input.rent),
          status: input.status,
          joined_on: input.joined,
        })
        .execute();
      await audit(trx, {
        businessId: actor.businessId,
        actorUserId: actor.id,
        action: "resident.created",
        entityType: "resident",
        entityId: residentId,
        requestId,
      });
      return issuePasswordToken(trx, userId, "invite");
    });
  } catch (e) {
    if (isDuplicate(e)) throw conflict(DUPLICATE_CONTACT);
    throw e;
  }
  deliverPasswordLink(ctx, { email, name: input.name }, "invite", token);
  return { id: residentId };
}

export async function updateResident(
  ctx: Context,
  actor: { id: string; businessId: string },
  residentId: string,
  input: Partial<ResidentInput>,
  requestId: string,
) {
  if (input.propertyId) await assertOwnProperty(ctx.db, actor.businessId, input.propertyId);
  const fields = Object.keys(input);
  if (!fields.length) throw invalid("Nothing to update.");
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const resident = await trx
        .selectFrom("resident_profiles")
        .select("user_id")
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
          updated_at: dbNow,
        })
        .where("id", "=", residentId)
        .execute();
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
