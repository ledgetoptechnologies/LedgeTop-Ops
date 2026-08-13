import type { Env, ShareRow } from "./types";

export function firstAccessDedupeKey(shareId: string, recipientPrincipalPublicId?: string): string {
  return `first_access:${shareId}${recipientPrincipalPublicId ? `:${recipientPrincipalPublicId}` : ""}`;
}

export async function recordFirstAccessNotification(env: Pick<Env, "DELIVERY_DB">, share: Pick<ShareRow, "id" | "recipient_email" | "public_id" | "client_name" | "project_name" | "r2_prefix">): Promise<void> {
  const members = await env.DELIVERY_DB.prepare(`SELECT member.recipient_principal_public_id,member.recipient_normalized_email
    FROM shares current_share
    JOIN delivery_share_audience_snapshots audience
      ON audience.share_id=current_share.id AND audience.share_version=current_share.share_version
    JOIN delivery_share_recipient_members member
      ON member.share_id=audience.share_id AND member.share_version=audience.share_version
    WHERE current_share.id=? ORDER BY member.recipient_principal_public_id`).bind(share.id).all<{
      recipient_principal_public_id: string;
      recipient_normalized_email: string;
    }>();
  const recipients = members.results.length
    ? members.results.map(member => ({
        email: member.recipient_normalized_email,
        dedupeKey: firstAccessDedupeKey(share.id, member.recipient_principal_public_id),
      }))
    : share.recipient_email
      ? [{ email: share.recipient_email, dedupeKey: firstAccessDedupeKey(share.id) }]
      : [];
  if (!recipients.length) return;
  const payload = JSON.stringify({ publicId: share.public_id, clientName: share.client_name, projectName: share.project_name, r2Prefix: share.r2_prefix });
  await env.DELIVERY_DB.batch(recipients.map(recipient => env.DELIVERY_DB.prepare(`INSERT OR IGNORE INTO delivery_notifications
    (id,dedupe_key,share_id,kind,recipient_email,payload_json) VALUES (?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), recipient.dedupeKey, share.id, "first_access", recipient.email, payload)));
}
