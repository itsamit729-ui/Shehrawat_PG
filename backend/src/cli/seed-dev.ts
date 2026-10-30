import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { createDb, type Db } from "../db/client.js";
import type { Sharing } from "../db/schema.js";
import { rupeesToPaise } from "../shared/money.js";

interface SampleProperty {
  name: string;
  area: string;
  sector: string;
  gender: string;
  audience: string;
  food: boolean;
  ac: boolean;
  rating: number;
  reviews: number;
  img: string;
  gallery: string[];
  landmarks: string[][];
  rooms: Record<Sharing, { price: number }>;
  amenities: string[];
  blurb: string;
}

// 500 beds across six homes, matching the capacity assumption in the blueprint.
const CAPACITIES = [90, 70, 110, 80, 50, 100];
const BEDS_PER_ROOM: Record<Sharing, number> = { single: 1, double: 2, triple: 3 };

/** Sample listings for local and staging use only. The client supplies the real ones. */
export async function seedSampleInventory(db: Db, businessId: string) {
  const file = new URL("../../seed/sample-properties.json", import.meta.url);
  const samples = JSON.parse(await readFile(file, "utf8")) as SampleProperty[];
  for (const [index, sample] of samples.entries()) {
    const propertyId = randomUUID();
    await db
      .insertInto("properties")
      .values({
        id: propertyId,
        business_id: businessId,
        name: sample.name.replace("Aangan", "Sehrawat"),
        area: sample.area,
        sector: sample.sector,
        gender: sample.gender,
        audience: sample.audience,
        food: sample.food ? 1 : 0,
        ac: sample.ac ? 1 : 0,
        rating: sample.rating,
        reviews: sample.reviews,
        img: "/images/" + sample.img.split("/").pop(),
        gallery: JSON.stringify(sample.gallery),
        landmarks: JSON.stringify(sample.landmarks),
        amenities: JSON.stringify(sample.amenities),
        blurb: sample.blurb,
      })
      .execute();
    const sharings = Object.keys(sample.rooms) as Sharing[];
    await db
      .insertInto("property_rates")
      .values(
        sharings.map((sharing) => ({
          property_id: propertyId,
          sharing,
          monthly_rent_paise: rupeesToPaise(sample.rooms[sharing].price),
        })),
      )
      .execute();
    let remaining = CAPACITIES[index] ?? 50;
    for (let number = 101; remaining > 0; number++) {
      const sharing = sharings[number % sharings.length]!;
      const count = Math.min(remaining, BEDS_PER_ROOM[sharing]);
      const roomId = randomUUID();
      await db
        .insertInto("rooms")
        .values({ id: roomId, business_id: businessId, property_id: propertyId, code: String(number), sharing })
        .execute();
      await db
        .insertInto("beds")
        .values(
          Array.from({ length: count }, (_, bed) => ({
            id: randomUUID(),
            business_id: businessId,
            room_id: roomId,
            code: String.fromCharCode(65 + bed),
          })),
        )
        .execute();
      remaining -= count;
    }
  }
  return samples.length;
}

if (process.argv[1]?.includes("seed-dev")) {
  const config = loadConfig();
  if (config.production) throw new Error("Sample data must never be seeded into production.");
  const db = createDb(config.db);
  try {
    let business = await db
      .selectFrom("businesses")
      .select("id")
      .where("slug", "=", config.businessSlug)
      .executeTakeFirst();
    if (!business) {
      business = { id: randomUUID() };
      await db
        .insertInto("businesses")
        .values({ id: business.id, slug: config.businessSlug, name: "Sehrawat PG" })
        .execute();
    }
    const existing = await db
      .selectFrom("properties")
      .select("id")
      .where("business_id", "=", business.id)
      .executeTakeFirst();
    if (existing) console.log("Properties already exist, so nothing was added.");
    else console.log(`Seeded ${await seedSampleInventory(db, business.id)} sample properties.`);
  } finally {
    await db.destroy();
  }
}
