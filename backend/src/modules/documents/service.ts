import { randomUUID } from "node:crypto";
import { dbNow, type Db } from "../../db/client.js";
import { conflict, forbidden, HttpError, invalid, notFound } from "../../http/errors.js";
import { audit } from "../../shared/audit.js";
import { idempotent } from "../../shared/idempotency.js";
import type { Context, SessionUser } from "../identity/service.js";

const NO_STORAGE = "File uploads aren't available yet.";
const MAX_BYTES = 5 * 1024 * 1024;
const LINK_SECONDS = 300;
const SIGNATURES: Record<string, number[]> = {
  "application/pdf": [0x25, 0x50, 0x44, 0x46, 0x2d],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/png": [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

export async function startUpload(
  ctx: Context,
  user: SessionUser,
  input: { fileName: string; contentType: string; size: number; purpose: string },
) {
  const storage = ctx.providers.storage;
  if (!storage) throw new HttpError(503, NO_STORAGE);
  if (!SIGNATURES[input.contentType]) throw invalid("Upload a PDF, JPEG or PNG file.");
  if (input.size > MAX_BYTES) throw invalid("Files can be up to 5 MB.");
  const id = randomUUID();
  // The key has no user-supplied text, so a file name can't reach into another folder.
  const objectKey = `private/${user.businessId}/${id}`;
  await ctx.db
    .insertInto("uploads")
    .values({
      id,
      business_id: user.businessId,
      owner_user_id: user.id,
      purpose: input.purpose,
      file_name: input.fileName,
      content_type: input.contentType,
      size_bytes: input.size,
      object_key: objectKey,
    })
    .execute();
  return { id, uploadUrl: await storage.presignPut(objectKey, input.contentType, LINK_SECONDS) };
}

/** Checks what actually arrived, since the browser's description of it proves nothing. */
export async function completeUpload(ctx: Context, user: SessionUser, id: string) {
  const storage = ctx.providers.storage;
  if (!storage) throw new HttpError(503, NO_STORAGE);
  const upload = await ctx.db
    .selectFrom("uploads")
    .selectAll()
    .where("id", "=", id)
    .where("business_id", "=", user.businessId)
    .executeTakeFirst();
  if (!upload || upload.owner_user_id !== user.id) throw notFound("This file");
  if (upload.state === "validated") return { id, state: upload.state };
  if (upload.state === "rejected") throw invalid("This file was rejected. Please upload it again.");
  const stored = await storage.head(upload.object_key);
  if (!stored) throw conflict("The file hasn't finished uploading.");
  const signature = SIGNATURES[upload.content_type]!;
  const start = stored.size ? await storage.readStart(upload.object_key, signature.length) : Buffer.alloc(0);
  const valid = stored.size > 0 && stored.size <= MAX_BYTES && signature.every((byte, i) => start[i] === byte);
  if (!valid) {
    await storage.remove(upload.object_key);
    await ctx.db.updateTable("uploads").set({ state: "rejected" }).where("id", "=", id).execute();
    throw invalid("This file isn't a valid PDF, JPEG or PNG of up to 5 MB.");
  }
  await ctx.db.updateTable("uploads").set({ state: "validated", size_bytes: stored.size }).where("id", "=", id).execute();
  return { id, state: "validated" };
}

/** A short-lived link for the person who uploaded the file, or the owner. Everyone else gets 404. */
export async function uploadLink(ctx: Context, user: SessionUser, id: string) {
  const storage = ctx.providers.storage;
  if (!storage) throw new HttpError(503, NO_STORAGE);
  const upload = await ctx.db
    .selectFrom("uploads")
    .selectAll()
    .where("id", "=", id)
    .where("business_id", "=", user.businessId)
    .executeTakeFirst();
  if (!upload || (user.role !== "owner" && upload.owner_user_id !== user.id)) throw notFound("This file");
  if (upload.state !== "validated") throw conflict("This file isn't available.");
  await audit(ctx.db, {
    businessId: user.businessId,
    actorUserId: user.id,
    action: "upload.link",
    entityType: "upload",
    entityId: id,
  });
  return { url: await storage.presignGet(upload.object_key, LINK_SECONDS, upload.file_name) };
}

export async function listAgreements(db: Db, businessId: string, residentId?: string) {
  let query = db.selectFrom("agreements").selectAll().where("business_id", "=", businessId).orderBy("created_at", "desc");
  if (residentId) query = query.where("resident_id", "=", residentId);
  return (await query.execute()).map((a) => ({
    id: a.id,
    residentId: a.resident_id,
    title: a.title,
    status: a.status,
    created: a.created_at.toISOString(),
  }));
}

export async function createAgreement(
  ctx: Context,
  actor: SessionUser,
  input: { residentId: string; title: string },
  key: string,
) {
  return ctx.db.transaction().execute((trx) =>
    idempotent(trx, { actor: actor.id, endpoint: "POST /agreements", key, payload: input }, async () => {
      const resident = await trx
        .selectFrom("resident_profiles")
        .select("id")
        .where("id", "=", input.residentId)
        .where("business_id", "=", actor.businessId)
        .executeTakeFirst();
      if (!resident) throw notFound("This resident");
      const id = randomUUID();
      await trx
        .insertInto("agreements")
        .values({
          id,
          business_id: actor.businessId,
          resident_id: input.residentId,
          title: input.title,
          provider_request_id: null,
          document_hash: null,
          signed_upload_id: null,
        })
        .execute();
      await audit(trx, {
        businessId: actor.businessId,
        actorUserId: actor.id,
        action: "agreement.created",
        entityType: "agreement",
        entityId: id,
      });
      return { id };
    }),
  );
}

/** The signed copy once it exists, otherwise the provider's signing page. Signed status is the provider's to set. */
export async function agreementLink(ctx: Context, user: SessionUser, id: string) {
  const agreement = await ctx.db
    .selectFrom("agreements as a")
    .innerJoin("resident_profiles as r", "r.id", "a.resident_id")
    .innerJoin("users as u", "u.id", "r.user_id")
    .leftJoin("uploads as f", "f.id", "a.signed_upload_id")
    .select(["a.id", "a.title", "a.status", "a.resident_id", "u.name", "u.email", "f.object_key", "f.file_name"])
    .where("a.id", "=", id)
    .where("a.business_id", "=", user.businessId)
    .executeTakeFirst();
  if (!agreement) throw notFound("This agreement");
  if (user.role === "corporate" || (user.role === "resident" && agreement.resident_id !== user.residentId))
    throw forbidden();
  if (agreement.status === "Cancelled") throw conflict("This agreement was cancelled.");
  if (agreement.status === "Signed" && agreement.object_key) {
    if (!ctx.providers.storage) throw new HttpError(503, NO_STORAGE);
    return {
      url: await ctx.providers.storage.presignGet(agreement.object_key, LINK_SECONDS, agreement.file_name ?? "agreement.pdf"),
    };
  }
  const signing = ctx.providers.signing;
  if (!signing) throw new HttpError(503, "E-signing isn't connected yet.");
  const link = await signing.signingLink({
    agreementId: id,
    title: agreement.title,
    name: agreement.name,
    email: agreement.email ?? "",
  });
  await ctx.db
    .updateTable("agreements")
    .set({ status: "Sent", provider_request_id: link.requestId, updated_at: dbNow })
    .where("id", "=", id)
    .where("status", "=", "Draft")
    .execute();
  return { url: link.url };
}
