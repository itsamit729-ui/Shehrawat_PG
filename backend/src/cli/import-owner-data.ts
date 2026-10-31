import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb, lockingTransaction, type Db, type Trx } from "../db/client.js";
import type { ResidentStatus, Sharing } from "../db/schema.js";
import { postInvoice, postLedger, recordOpeningPayment } from "../modules/finance/service.js";
import { normalizeEmail, normalizePhone } from "../modules/identity/service.js";
import { assignBed } from "../modules/inventory/allocations.js";
import { csvRecords } from "../shared/csv.js";
import { isCalendarDate } from "../shared/dates.js";
import { rupeesToPaise } from "../shared/money.js";

class DryRun extends Error {}
type Row = Record<string, string>;
const SHARINGS = ["single", "double", "triple"];
const STATUSES = ["Active", "Notice", "Moved out"];
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const list = (value: string | undefined, separator = "|") =>
  (value ?? "").split(separator).map((v) => v.trim()).filter(Boolean);
const yes = (value: string | undefined) => /^(y|yes|true|1)$/i.test(value ?? "");

/**
 * Loads the owner's filled-in templates. Dry run by default, which does everything and rolls back,
 * so every problem is listed before anything changes. Safe to repeat: existing rows are matched by
 * name, code or email. Residents are not emailed; each one uses "forgot password" to get in.
 */
export async function importOwnerData(db: Db, businessSlug: string, dir: string, opts: { apply: boolean; removeSamples: boolean }) {
  const read = (file: string): Row[] => {
    const path = join(dir, file);
    return existsSync(path) ? csvRecords(readFileSync(path, "utf8")) : [];
  };
  const problems: string[] = [];
  const counts: Record<string, number> = {};
  const count = (what: string) => void (counts[what] = (counts[what] ?? 0) + 1);
  const business = await db.selectFrom("businesses").select("id").where("slug", "=", businessSlug).executeTakeFirst();
  if (!business) throw new Error(`No business with slug "${businessSlug}". Run create-owner first.`);
  const businessId = business.id;

  const money = (where: string, value: string | undefined, allowZero = false) => {
    const n = Number(value);
    if (!value || !Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
      problems.push(`${where}: "${value ?? ""}" isn't a valid rupee amount`);
      return 0;
    }
    return rupeesToPaise(n);
  };
  const date = (where: string, value: string | undefined) => {
    if (value && isCalendarDate(value)) return value;
    problems.push(`${where}: "${value ?? ""}" isn't a date in YYYY-MM-DD form`);
    return "2000-01-01";
  };

  const run = async (trx: Trx) => {
    const settings: Record<string, unknown> = {};
    for (const row of read("01_business.csv")) {
      if (row.setting === "business_name" && row.value) settings.businessName = row.value;
      if (row.setting === "rent_day" && row.value) {
        const day = Number(row.value);
        if (Number.isInteger(day) && day >= 1 && day <= 28) settings.rentDay = day;
        else problems.push(`01_business.csv: rent_day must be 1 to 28, not "${row.value}"`);
      }
    }
    const menu: Record<string, unknown> = {};
    for (const row of read("09_meal_menu.csv")) {
      const day = DAYS.indexOf((row.day ?? "").toLowerCase());
      if (day < 0) problems.push(`09_meal_menu.csv: "${row.day}" isn't a day of the week`);
      else menu[day] = { breakfast: row.breakfast ?? "", lunch: row.lunch ?? "", dinner: row.dinner ?? "" };
    }
    if (Object.keys(menu).length) settings.mealMenu = menu;
    if (Object.keys(settings).length) {
      await trx.insertInto("business_settings").ignore().values({ business_id: businessId, settings: "{}" }).execute();
      const current = await trx
        .selectFrom("business_settings")
        .select("settings")
        .where("business_id", "=", businessId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      await trx
        .updateTable("business_settings")
        .set({ settings: JSON.stringify({ ...(current.settings as object), ...settings }) })
        .where("business_id", "=", businessId)
        .execute();
      count("settings saved");
    }

    const propertyIds = new Map<string, string>();
    for (const row of read("02_properties.csv")) {
      const name = row.property_name;
      if (!name) {
        problems.push("02_properties.csv: a row has no property_name");
        continue;
      }
      const values = {
        area: row.area ?? "",
        sector: row.sector ?? "",
        gender: row.gender ?? "Unisex",
        audience: row.audience ?? "",
        food: yes(row.food_included) ? 1 : 0,
        ac: yes(row.ac) ? 1 : 0,
        img: row.cover_image ?? "",
        gallery: JSON.stringify(list(row.gallery_images)),
        landmarks: JSON.stringify(list(row.landmarks).map((l) => l.split(":").map((part) => part.trim()))),
        amenities: JSON.stringify(list(row.amenities)),
        blurb: row.description ?? "",
      };
      if (!["Men", "Women", "Unisex"].includes(values.gender))
        problems.push(`02_properties.csv, ${name}: gender must be Men, Women or Unisex`);
      const existing = await trx
        .selectFrom("properties")
        .select("id")
        .where("business_id", "=", businessId)
        .where("name", "=", name)
        .executeTakeFirst();
      const id = existing?.id ?? randomUUID();
      if (existing) await trx.updateTable("properties").set(values).where("id", "=", id).execute();
      else await trx.insertInto("properties").values({ id, business_id: businessId, name, rating: 0, reviews: 0, ...values }).execute();
      propertyIds.set(name, id);
      count(existing ? "properties updated" : "properties added");
    }
    const propertyId = async (where: string, name: string | undefined) => {
      const known = name ? propertyIds.get(name) : undefined;
      if (known) return known;
      const row = name
        ? await trx.selectFrom("properties").select("id").where("business_id", "=", businessId).where("name", "=", name).executeTakeFirst()
        : undefined;
      if (!row) problems.push(`${where}: no property named "${name ?? ""}"`);
      return row?.id;
    };

    for (const row of read("03_room_rates.csv")) {
      const where = `03_room_rates.csv, ${row.property_name} ${row.sharing}`;
      const id = await propertyId(where, row.property_name);
      const sharing = row.sharing as Sharing;
      if (!SHARINGS.includes(sharing)) problems.push(`${where}: sharing must be single, double or triple`);
      const paise = money(where, row.monthly_rent_inr);
      if (!id || !paise || !SHARINGS.includes(sharing)) continue;
      await trx
        .insertInto("property_rates")
        .values({ property_id: id, sharing, monthly_rent_paise: paise })
        .onDuplicateKeyUpdate({ monthly_rent_paise: paise })
        .execute();
      count("rates saved");
    }

    for (const row of read("04_rooms_beds.csv")) {
      const where = `04_rooms_beds.csv, ${row.property_name} room ${row.room_code}`;
      const id = await propertyId(where, row.property_name);
      const sharing = row.sharing as Sharing;
      if (!SHARINGS.includes(sharing)) problems.push(`${where}: sharing must be single, double or triple`);
      if (!row.room_code) problems.push(`${where}: room_code is empty`);
      const beds = list(row.bed_codes);
      if (!beds.length) problems.push(`${where}: bed_codes is empty`);
      if (!id || !row.room_code || !beds.length || !SHARINGS.includes(sharing)) continue;
      const room = await trx.selectFrom("rooms").select("id").where("property_id", "=", id).where("code", "=", row.room_code).executeTakeFirst();
      const roomId = room?.id ?? randomUUID();
      if (!room) {
        await trx.insertInto("rooms").values({ id: roomId, business_id: businessId, property_id: id, code: row.room_code, sharing }).execute();
        count("rooms added");
      }
      const blocked = list(row.blocked_bed_codes);
      for (const code of beds) {
        const bed = await trx.selectFrom("beds").select("id").where("room_id", "=", roomId).where("code", "=", code).executeTakeFirst();
        if (bed) continue;
        await trx
          .insertInto("beds")
          .values({ id: randomUUID(), business_id: businessId, room_id: roomId, code, blocked: blocked.includes(code) ? 1 : 0 })
          .execute();
        count("beds added");
      }
    }

    const companyIds = new Map<string, string>();
    for (const row of read("05_company_accounts.csv")) {
      const name = row.company_name;
      if (!name) {
        problems.push("05_company_accounts.csv: a row has no company_name");
        continue;
      }
      const existing = await trx
        .selectFrom("corporate_accounts")
        .select("id")
        .where("business_id", "=", businessId)
        .where("name", "=", name)
        .executeTakeFirst();
      const id = existing?.id ?? randomUUID();
      if (!existing) {
        await trx.insertInto("corporate_accounts").values({ id, business_id: businessId, name }).execute();
        count("companies added");
      }
      companyIds.set(name, id);
      if (row.contact_email) {
        const email = normalizeEmail(row.contact_email);
        const user = await trx.selectFrom("users").select(["id", "role"]).where("business_id", "=", businessId).where("email", "=", email).executeTakeFirst();
        if (user && user.role !== "corporate") {
          problems.push(`05_company_accounts.csv, ${name}: ${email} already belongs to a ${user.role}`);
          continue;
        }
        const userId = user?.id ?? randomUUID();
        if (!user)
          await trx
            .insertInto("users")
            .values({
              id: userId,
              business_id: businessId,
              role: "corporate",
              name: row.contact_name || name,
              email,
              phone: row.contact_phone ? normalizePhone(row.contact_phone) : null,
              password_hash: null,
            })
            .execute();
        await trx.insertInto("corporate_memberships").ignore().values({ user_id: userId, corporate_id: id }).execute();
      }
    }

    const residentIds = new Map<string, { id: string; corporateId: string | null }>();
    for (const row of read("06_residents.csv")) {
      const email = normalizeEmail(row.email ?? "");
      const where = `06_residents.csv, ${row.full_name || email}`;
      if (!email.includes("@")) problems.push(`${where}: email is missing or invalid`);
      if (!row.full_name) problems.push(`${where}: full_name is empty`);
      const status = (row.status || "Active") as ResidentStatus;
      if (!STATUSES.includes(status)) problems.push(`${where}: status must be Active, Notice or Moved out`);
      const joined = date(where, row.joined_on);
      const paise = money(where, row.monthly_rent_inr);
      const property = await propertyId(where, row.property_name);
      let phone: string | null = null;
      try {
        phone = row.phone ? normalizePhone(row.phone) : null;
      } catch {
        problems.push(`${where}: "${row.phone}" isn't a valid Indian mobile number`);
      }
      const corporateId = row.company_name ? (companyIds.get(row.company_name) ?? null) : null;
      if (row.company_name && !corporateId) problems.push(`${where}: no company named "${row.company_name}" in 05_company_accounts.csv`);
      if (!property || !email.includes("@") || !paise) continue;

      const user = await trx
        .selectFrom("users as u")
        .leftJoin("resident_profiles as r", "r.user_id", "u.id")
        .select(["u.id", "u.role", "r.id as resident_id"])
        .where("u.business_id", "=", businessId)
        .where("u.email", "=", email)
        .executeTakeFirst();
      if (user && user.role !== "resident") {
        problems.push(`${where}: ${email} already belongs to a ${user.role}`);
        continue;
      }
      if (user?.resident_id) {
        residentIds.set(email, { id: user.resident_id, corporateId });
        count("residents already present");
        continue;
      }
      const userId = user?.id ?? randomUUID();
      if (!user)
        await trx
          .insertInto("users")
          .values({ id: userId, business_id: businessId, role: "resident", name: row.full_name ?? "", email, phone, password_hash: null })
          .execute();
      const residentId = randomUUID();
      await trx
        .insertInto("resident_profiles")
        .values({
          id: residentId,
          business_id: businessId,
          user_id: userId,
          corporate_id: corporateId,
          property_id: property,
          room_label: `${row.room_code ?? ""}${row.bed_code ?? ""}`,
          monthly_rent_paise: paise,
          status,
          joined_on: joined,
        })
        .execute();
      residentIds.set(email, { id: residentId, corporateId });
      count("residents added");

      if (status !== "Moved out" && row.room_code && row.bed_code) {
        const bed = await trx
          .selectFrom("beds as b")
          .innerJoin("rooms as r", "r.id", "b.room_id")
          .select("b.id")
          .where("r.property_id", "=", property)
          .where("r.code", "=", row.room_code)
          .where("b.code", "=", row.bed_code)
          .executeTakeFirst();
        if (!bed) problems.push(`${where}: no bed ${row.room_code}/${row.bed_code} in ${row.property_name}`);
        else
          try {
            await assignBed(trx, { businessId, residentId, bedId: bed.id, start: joined });
            count("beds occupied");
          } catch {
            problems.push(`${where}: bed ${row.room_code}/${row.bed_code} is already taken`);
          }
      }
      if (phone && row.whatsapp_opt_in_source)
        await trx
          .insertInto("contacts")
          .ignore()
          .values({
            id: randomUUID(),
            business_id: businessId,
            phone,
            name: row.full_name ?? "",
            resident_id: residentId,
            opt_in_source: row.whatsapp_opt_in_source,
            opted_in_at: new Date(),
          })
          .execute();
    }
    const residentByEmail = async (where: string, raw: string | undefined) => {
      const email = normalizeEmail(raw ?? "");
      const known = residentIds.get(email);
      if (known) return known;
      const row = await trx
        .selectFrom("users as u")
        .innerJoin("resident_profiles as r", "r.user_id", "u.id")
        .select(["r.id", "r.corporate_id"])
        .where("u.business_id", "=", businessId)
        .where("u.email", "=", email)
        .executeTakeFirst();
      if (!row) problems.push(`${where}: no resident with email "${raw ?? ""}"`);
      return row ? { id: row.id, corporateId: row.corporate_id } : null;
    };

    for (const row of read("07_opening_dues.csv")) {
      const where = `07_opening_dues.csv, ${row.resident_email} ${row.period}`;
      const resident = await residentByEmail(where, row.resident_email);
      const amount = money(where, row.amount_inr);
      const paid = row.already_paid_inr ? money(where, row.already_paid_inr, true) : 0;
      const dueOn = date(where, row.due_on);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.period ?? "")) problems.push(`${where}: period must be YYYY-MM`);
      if (paid > amount) problems.push(`${where}: already_paid_inr is more than amount_inr`);
      if (!resident || !amount || paid > amount || !/^\d{4}-(0[1-9]|1[0-2])$/.test(row.period ?? "")) continue;
      const chargeType = (row.charge_type || "rent").toLowerCase();
      const { id, created } = await postInvoice(trx, {
        businessId,
        residentId: resident.id,
        corporateId: resident.corporateId,
        period: row.period!,
        chargeType,
        description: row.description || `Opening balance: ${chargeType} for ${row.period}`,
        dueOn,
        amountPaise: amount,
      });
      if (created) {
        count("opening dues added");
        if (paid) await recordOpeningPayment(trx, businessId, id, paid);
      }
    }

    for (const row of read("08_deposits_held.csv")) {
      const where = `08_deposits_held.csv, ${row.resident_email}`;
      const resident = await residentByEmail(where, row.resident_email);
      const amount = money(where, row.amount_inr);
      if (!resident || !amount) continue;
      const already = await trx
        .selectFrom("ledger_entries")
        .select("id")
        .where("source_type", "=", "deposit")
        .where("source_id", "=", resident.id)
        .executeTakeFirst();
      if (already) continue;
      await postLedger(trx, businessId, { type: "deposit", id: resident.id }, [
        { account: "cash", debit: amount },
        { account: "deposit_liability", credit: amount },
      ]);
      count("deposits recorded");
    }

    if (opts.removeSamples) {
      const keep = new Set(read("02_properties.csv").map((r) => r.property_name));
      const others = await trx.selectFrom("properties").select(["id", "name"]).where("business_id", "=", businessId).execute();
      for (const property of others.filter((p) => !keep.has(p.name))) {
        const used = await trx
          .selectFrom("bed_allocations as a")
          .innerJoin("beds as b", "b.id", "a.bed_id")
          .innerJoin("rooms as r", "r.id", "b.room_id")
          .select("a.id")
          .where("r.property_id", "=", property.id)
          .executeTakeFirst();
        const resident = await trx.selectFrom("resident_profiles").select("id").where("property_id", "=", property.id).executeTakeFirst();
        const lead = await trx.selectFrom("leads").select("id").where("property_id", "=", property.id).executeTakeFirst();
        if (used || resident || lead) {
          problems.push(`Kept "${property.name}": it isn't in your file but has bookings, residents or leads`);
          continue;
        }
        const rooms = await trx.selectFrom("rooms").select("id").where("property_id", "=", property.id).execute();
        if (rooms.length) await trx.deleteFrom("beds").where("room_id", "in", rooms.map((r) => r.id)).execute();
        await trx.deleteFrom("rooms").where("property_id", "=", property.id).execute();
        await trx.deleteFrom("property_rates").where("property_id", "=", property.id).execute();
        await trx.deleteFrom("properties").where("id", "=", property.id).execute();
        count("sample properties removed");
      }
    }

    // Any problem, or a dry run, rolls back everything. A half-imported business helps nobody.
    if (problems.length || !opts.apply) throw new DryRun();
  };

  let applied = false;
  try {
    await lockingTransaction(db, run);
    applied = true;
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
  }
  return { applied, problems, counts };
}

if (process.argv[1]?.includes("import-owner-data")) {
  const { values } = parseArgs({
    options: {
      dir: { type: "string" },
      apply: { type: "boolean", default: false },
      "remove-samples": { type: "boolean", default: false },
    },
  });
  if (!values.dir) {
    console.error("Usage: npm run import:owner-data -- --dir <folder> [--apply] [--remove-samples]");
    process.exit(1);
  }
  const config = loadConfig();
  const db = createDb(config.db);
  const result = await importOwnerData(db, config.businessSlug, values.dir, {
    apply: values.apply,
    removeSamples: values["remove-samples"],
  });
  await db.destroy();
  for (const [what, n] of Object.entries(result.counts)) console.info(`${what}: ${n}`);
  for (const problem of result.problems) console.error(`PROBLEM: ${problem}`);
  console.info(
    result.applied
      ? "Imported."
      : result.problems.length
        ? "Nothing was changed. Fix the problems above and run it again."
        : "Dry run only, and nothing was changed. Add --apply to save this.",
  );
  process.exit(result.problems.length ? 1 : 0);
}
