import type { Db } from "../../db/client.js";
import type { Sharing } from "../../db/schema.js";
import { businessToday } from "../../shared/dates.js";
import { paiseToRupees } from "../../shared/money.js";
import { countFreeBeds, listBedsWithStatus } from "./allocations.js";

/** Public listing fields, in the Property shape of frontend/src/domain.ts. */
export async function listProperties(db: Db, businessId: string) {
  const today = businessToday();
  const [properties, rates, free, beds] = await Promise.all([
    db.selectFrom("properties").selectAll().where("business_id", "=", businessId).orderBy("name").execute(),
    db
      .selectFrom("property_rates as pr")
      .innerJoin("properties as p", "p.id", "pr.property_id")
      .select(["pr.property_id", "pr.sharing", "pr.monthly_rent_paise"])
      .where("p.business_id", "=", businessId)
      .execute(),
    countFreeBeds(db, businessId, today),
    listBedsWithStatus(db, businessId, today),
  ]);
  return properties.map((p) => {
    const rooms: Partial<Record<Sharing, { price: number; left: number }>> = {};
    for (const rate of rates)
      if (rate.property_id === p.id)
        rooms[rate.sharing] = {
          price: paiseToRupees(Number(rate.monthly_rent_paise)),
          left: free[p.id]?.[rate.sharing] ?? 0,
        };
    const own = beds.filter((b) => b.propertyId === p.id);
    return {
      id: p.id,
      name: p.name,
      area: p.area,
      sector: p.sector,
      gender: p.gender,
      audience: p.audience,
      food: p.food === 1,
      ac: p.ac === 1,
      rating: Number(p.rating),
      reviews: p.reviews,
      img: p.img,
      gallery: p.gallery,
      landmarks: p.landmarks,
      rooms,
      amenities: p.amenities,
      beds: own.length,
      occupied: own.filter((b) => b.status === "Occupied").length,
      blurb: p.blurb,
    };
  });
}
