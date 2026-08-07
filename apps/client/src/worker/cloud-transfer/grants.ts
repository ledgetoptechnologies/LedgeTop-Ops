import { cloudDb } from "./repository";
import type { CloudTransferEnv, CloudTransferItem } from "./types";
import { isMovedSourceMarker } from "@ltds/shared";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function base64Url(bytes: Uint8Array): string {
  let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("encrypted-data-invalid");
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
}
function randomToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes)); return base64Url(value);
}
async function digest(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
async function encryptionKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("CLOUD_TRANSFER_TOKEN_SECRET must contain at least 32 characters");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`ltds-cloud-transfer:v1:${secret}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptCloudSecret(value: unknown, secret: string, purpose: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(`ltds-cloud-transfer:v1:${purpose}`) },
    await encryptionKey(secret), plaintext,
  );
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), iv: base64Url(iv) };
}

export async function decryptCloudSecret<T>(ciphertext: string, iv: string, secret: string, purpose: string): Promise<T> {
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64Url(iv), additionalData: encoder.encode(`ltds-cloud-transfer:v1:${purpose}`) },
      await encryptionKey(secret), fromBase64Url(ciphertext),
    );
    return JSON.parse(decoder.decode(plaintext)) as T;
  } catch {
    throw new Error("authorization-expired");
  }
}

export async function decryptWithRotation<T>(
  encrypted: { ciphertext: string; iv: string; keyId: string },
  env: CloudTransferEnv,
  purpose: string,
): Promise<T> {
  const currentId = env.CLOUD_TRANSFER_KEY_ID || "v1";
  if (encrypted.keyId === currentId) return decryptCloudSecret<T>(encrypted.ciphertext, encrypted.iv, env.CLOUD_TRANSFER_TOKEN_SECRET, purpose);
  if (env.CLOUD_TRANSFER_PREVIOUS_TOKEN_SECRET && encrypted.keyId === env.CLOUD_TRANSFER_PREVIOUS_KEY_ID) {
    return decryptCloudSecret<T>(encrypted.ciphertext, encrypted.iv, env.CLOUD_TRANSFER_PREVIOUS_TOKEN_SECRET, purpose);
  }
  throw new Error("authorization-expired");
}

export async function createSourceGrant(
  env: CloudTransferEnv,
  item: Pick<CloudTransferItem, "id" | "job_id" | "source_key" | "source_etag">,
  ttlSeconds = 900,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomToken();
  const tokenHash = await digest(token);
  const expiresAt = new Date(Date.now() + Math.min(1_800, Math.max(60, ttlSeconds)) * 1000).toISOString();
  const encrypted = await encryptCloudSecret(
    { itemId: item.id, jobId: item.job_id, key: item.source_key, etag: item.source_etag },
    env.CLOUD_TRANSFER_TOKEN_SECRET,
    `source-grant:${item.id}`,
  );
  await cloudDb(env).prepare(`UPDATE cloud_transfer_items SET source_grant_hash=?,source_grant_ciphertext=?,source_grant_iv=?,source_grant_expires_at=?,updated_at=datetime('now')
    WHERE id=? AND job_id=?`).bind(tokenHash, encrypted.ciphertext, encrypted.iv, expiresAt, item.id, item.job_id).run();
  return { token, expiresAt };
}

export async function validateSourceGrant(
  env: CloudTransferEnv,
  token: string,
  now = new Date(),
): Promise<{ item: CloudTransferItem; object: R2Object }> {
  if (!/^[A-Za-z0-9_-]{40,}$/.test(token)) throw new Error("source-grant-invalid");
  const item = await cloudDb(env).prepare(`SELECT i.* FROM cloud_transfer_items i JOIN cloud_transfer_jobs j ON j.id=i.job_id
    JOIN shares s ON s.id=j.share_id JOIN projects p ON p.id=s.project_id
    WHERE i.source_grant_hash=? AND datetime(i.source_grant_expires_at)>datetime(?) AND i.status IN ('queued','running','retrying')
      AND j.status IN ('queued','running') AND s.share_version=j.share_version AND s.revoked_at IS NULL AND p.active=1
      AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime(?))`)
    .bind(await digest(token), now.toISOString(), now.toISOString()).first<CloudTransferItem>();
  if (!item) throw new Error("source-grant-invalid");
  const object = await env.DATA_BUCKET.head(item.source_key);
  if (!object || isMovedSourceMarker(object)) throw new Error("source-missing");
  if (object.etag !== item.source_etag || object.size !== item.source_size) throw new Error("source-changed");
  return { item, object };
}

export async function readGrantedSource(
  env: CloudTransferEnv,
  token: string,
  range?: { offset: number; length: number },
): Promise<R2ObjectBody> {
  const { item } = await validateSourceGrant(env, token);
  const object = await env.DATA_BUCKET.get(item.source_key, {
    ...(range ? { range } : {}),
    onlyIf: { etagMatches: item.source_etag },
  });
  if (!object || !("body" in object)) throw new Error("source-changed");
  return object;
}
