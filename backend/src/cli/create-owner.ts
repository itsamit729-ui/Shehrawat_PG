import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { normalizePhone } from "../modules/identity/service.js";

/** Bootstraps the business and its one owner. There is deliberately no API route for this. */
const { values } = parseArgs({
  options: {
    phone: { type: "string" },
    name: { type: "string" },
    "business-name": { type: "string", default: "Sehrawat PG" },
  },
});
if (!values.phone || !values.name) {
  console.error('Usage: npm run create-owner -- --phone 98XXXXXXXX --name "Owner name"');
  process.exit(1);
}

const config = loadConfig();
const db = createDb(config.db);
try {
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
        phone: normalizePhone(values.phone!),
        password_hash: null,
      })
      .execute();
  });
  console.log("Owner created. They can now sign in with an SMS code.");
} finally {
  await db.destroy();
}
