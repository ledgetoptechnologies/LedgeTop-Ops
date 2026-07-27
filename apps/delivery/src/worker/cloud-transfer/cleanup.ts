import { cloudDb } from "./repository";
import type { CloudProviderAdapter, CloudTransferEnv, CloudCredential } from "./types";
import { decryptWithRotation } from "./grants";

const HISTORY_DAYS = 90;

export async function eraseCloudAuthorization(env: CloudTransferEnv, authorizationId: string): Promise<void> {
  await cloudDb(env).prepare(`UPDATE cloud_transfer_authorizations SET credential_ciphertext='',credential_iv='',revoked_at=COALESCE(revoked_at,datetime('now'))
    WHERE id=?`).bind(authorizationId).run();
}

export async function cleanupCloudTransfers(
  env: CloudTransferEnv,
  adapters: Partial<Record<"dropbox" | "google", CloudProviderAdapter>> = {},
  now = new Date(),
): Promise<void> {
  const nowIso = now.toISOString();
  await cloudDb(env).prepare(`UPDATE cloud_transfer_jobs SET status='expired',cancel_requested_at=COALESCE(cancel_requested_at,datetime(?)),updated_at=datetime(?)
    WHERE status IN ('queued','running','cancelling') AND datetime(expires_at)<=datetime(?)`).bind(nowIso, nowIso, nowIso).run();
  await cloudDb(env).prepare(`UPDATE cloud_transfer_items SET status='cancelled',error_code='cancelled',error_message='The remaining files were cancelled.',
    upload_state_ciphertext=NULL,upload_state_iv=NULL,source_grant_hash=NULL,source_grant_ciphertext=NULL,source_grant_iv=NULL,source_grant_expires_at=NULL,updated_at=datetime(?)
    WHERE job_id IN (SELECT id FROM cloud_transfer_jobs WHERE status='expired') AND status IN ('queued','running','retrying')`).bind(nowIso).run();

  const authorizations = (await cloudDb(env).prepare(`SELECT a.id,a.provider,a.credential_ciphertext,a.credential_iv,a.key_id
    FROM cloud_transfer_authorizations a WHERE a.revoked_at IS NULL AND datetime(a.expires_at)<=datetime(?)`).bind(nowIso)
    .all<{ id: string; provider: "dropbox" | "google"; credential_ciphertext: string; credential_iv: string; key_id: string }>()).results;
  for (const authorization of authorizations) {
    const adapter = adapters[authorization.provider];
    if (adapter?.revoke && authorization.credential_ciphertext) {
      try {
        const credential = await decryptWithRotation<CloudCredential>({
          ciphertext: authorization.credential_ciphertext, iv: authorization.credential_iv, keyId: authorization.key_id,
        }, env, `authorization:${authorization.id}:${authorization.provider}`);
        await adapter.revoke(credential);
      } catch (error) {
        console.error(JSON.stringify({ event: "cloud-transfer.authorization-revoke-failed", authorizationId: authorization.id, provider: authorization.provider,
          error: error instanceof Error ? error.message : String(error) }));
      }
    }
    await eraseCloudAuthorization(env, authorization.id);
  }

  await cloudDb(env).prepare("DELETE FROM cloud_oauth_states WHERE consumed_at IS NOT NULL OR datetime(expires_at)<=datetime(?)").bind(nowIso).run();
  await cloudDb(env).prepare(`UPDATE cloud_transfer_items SET upload_state_ciphertext=NULL,upload_state_iv=NULL,source_grant_hash=NULL,
    source_grant_ciphertext=NULL,source_grant_iv=NULL,source_grant_expires_at=NULL
    WHERE job_id IN (SELECT id FROM cloud_transfer_jobs WHERE status IN ('completed','partial','failed','cancelled','expired'))`).run();
  const cutoff = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString();
  await cloudDb(env).prepare(`DELETE FROM cloud_transfer_jobs WHERE status IN ('completed','partial','failed','cancelled','expired') AND datetime(updated_at)<=datetime(?)`).bind(cutoff).run();
  const currentWindow = Math.floor(now.getTime() / 3_600_000);
  await cloudDb(env).prepare("DELETE FROM cloud_transfer_quota WHERE window_start<?").bind(currentWindow - 48).run();
}
