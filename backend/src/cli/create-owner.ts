import { randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb, dbNow, isDuplicate } from "../db/client.js";
import { hashPassword } from "../modules/identity/crypto.js";
import { normalizePhone } from "../modules/identity/service.js";

/** Bootstraps the business and its one owner. There is deliberately no API route for this. */
const { values } = parseArgs({
  options: {
    phone: { type: "string" },
    name: { type: "string" },
    "business-name": { type: "string", default: "Sehrawat PG" },
    "reset-password": { type: "boolean", default: false },
  },
});
const reset = values["reset-password"];
if (!reset && !values.name) {
  console.error('Usage: npm run create-owner -- --name "Owner name" [--phone 98XXXXXXXX]');
  console.error("   or: npm run create-owner -- --reset-password");
  process.exit(1);
}

function showPassword(password: string) {
  console.log(`\nOwner password: ${password}\n`);
  console.log("Save it now. It is shown only this once and can't be recovered.");
  console.log("If it is lost, run: npm run create-owner -- --reset-password");
}

const config = loadConfig();
const db = createDb(config.db);
try {
  // Random and long, so it is safe to sign in with this alone.
  const password = randomBytes(18).toString("base64url");
  if (reset) {
    const owner = await db
      .selectFrom("users as u")
      .innerJoin("businesses as b", "b.id", "u.business_id")
      .select("u.id")
      .where("b.slug", "=", config.businessSlug)
      .where("u.role", "=", "owner")
      .executeTakeFirst();
    if (!owner) throw new Error("There is no owner yet, so create one first.");
    const passwordHash = await hashPassword(password);
    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("users")
        .set({ password_hash: passwordHash, status: "active", updated_at: dbNow })
        .where("id", "=", owner.id)
        .execute();
      await trx
        .updateTable("sessions")
        .set({ revoked_at: dbNow })
        .where("user_id", "=", owner.id)
        .where("revoked_at", "is", null)
        .execute();
    });
    showPassword(password);
  } else {
    const passwordHash = await hashPassword(password);
    await db.transaction().execute(async (trx) => {
      let business = await trx
        .selectFrom("businesses")
        .select("id")
        .where("slug", "=", config.businessSlug)
        .executeTakeFirst();
      if (!business) {
        business = { id: randomUUID() };
        await trx
          .insertInto("businesses")
          .values({ id: business.id, slug: config.businessSlug, name: values["business-name"]! })
          .execute();
      }
      await trx
        .insertInto("users")
        .values({
          id: randomUUID(),
          business_id: business.id,
          role: "owner",
          status: "active",
          name: values.name!,
          email: null,
          phone: values.phone ? normalizePhone(values.phone) : null,
          password_hash: passwordHash,
        })
        .execute();
    });
    console.log("Owner created.");
    showPassword(password);
  }
} catch (e) {
  if (!isDuplicate(e)) throw e;
  console.error("An owner already exists. To get a new password, run: npm run create-owner -- --reset-password");
  process.exitCode = 1;
} finally {
  await db.destroy();
}
