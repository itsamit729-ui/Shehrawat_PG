import { randomUUID } from "node:crypto";
import type { Db, Trx } from "../db/client.js";

export interface AuditEntry {
  businessId: string;
  actorUserId: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

/** Never put passwords, codes, tokens or full contact details in metadata. */
export async function audit(db: Db | Trx, entry: AuditEntry) {
  await db
    .insertInto("audit_events")
    .values({
      id: randomUUID(),
      business_id: entry.businessId,
      actor_user_id: entry.actorUserId,
      action: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId ?? null,
      request_id: entry.requestId ?? null,
      metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
    })
    .execute();
}
