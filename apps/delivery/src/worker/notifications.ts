import type { Env, ShareRow } from "./types";

export function firstAccessDedupeKey(shareId: string): string { return `first_access:${shareId}`; }

export async function recordFirstAccessNotification(env: Pick<Env, "DELIVERY_DB">, share: Pick<ShareRow, "id" | "recipient_email" | "public_id" | "client_name" | "project_name" | "r2_prefix">): Promise<void> {
  if (!share.recipient_email) return;
  await env.DELIVERY_DB.prepare(`INSERT OR IGNORE INTO delivery_notifications
    (id,dedupe_key,share_id,kind,recipient_email,payload_json) VALUES (?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), firstAccessDedupeKey(share.id), share.id, "first_access", share.recipient_email,
      JSON.stringify({ publicId: share.public_id, clientName: share.client_name, projectName: share.project_name, r2Prefix: share.r2_prefix }))
    .run();
}
