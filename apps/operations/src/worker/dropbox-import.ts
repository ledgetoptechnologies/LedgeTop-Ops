import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { DropboxImportClient, DropboxImportError, refreshDropboxToken } from "./dropbox-import-client";
import { normalizeCrudKey } from "./r2-crud-validation";
import type { Env, StaffPrincipal } from "./types";

const MIN_PART_SIZE = 8 * 1024 * 1024;
const MAX_PART_SIZE = 5 * 1024 * 1024 * 1024;
const TARGET_MAX_PARTS = 9_999; // reserve one part below R2's 10,000-part limit
const PART_SIZE_GRANULARITY = 1024 * 1024;

export function dropboxImportPartSize(totalSize: number): number {
  const required = Math.ceil(totalSize / TARGET_MAX_PARTS);
  const rounded = Math.ceil(required / PART_SIZE_GRANULARITY) * PART_SIZE_GRANULARITY;
  const partSize = Math.max(MIN_PART_SIZE, rounded);
  if (partSize > MAX_PART_SIZE) throw new Error("file-too-large-for-multipart");
  return partSize;
}
const MAX_FILES = 10_000;
const MAX_BYTES = 500 * 1024 ** 3; // 500 GiB, matches staff upload limit

interface ImportAuthorization {
  id: string;
  staff_id: string;
  credential_ciphertext: string;
  credential_iv: string;
  key_id: string;
  token_expires_at: string | null;
  revoked_at: string | null;
}

interface ImportJob {
  id: string;
  staff_id: string;
  authorization_id: string;
  source_path: string;
  destination_prefix: string;
  conflict_mode: "autorename" | "skip" | "replace" | "fail";
  status: string;
  file_count: number;
  processed_files: number;
  succeeded_files: number;
  failed_files: number;
  total_bytes: number;
  processed_bytes: number;
}

interface ImportItem {
  id: string;
  job_id: string;
  ordinal: number;
  dropbox_path: string;
  dropbox_id: string | null;
  destination_key: string;
  size: number;
  status: string;
  attempts: number;
  downloaded_bytes: number;
  uploaded_bytes: number;
  r2_etag: string | null;
  error_code: string | null;
  error_message: string | null;
}

// AES-GCM encryption for OAuth credentials (mirrors delivery-side grants.ts)
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`ltds-dropbox-import:v1:${secret}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptImportSecret(value: unknown, secret: string, purpose: string): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource, additionalData: encoder.encode(`ltds-dropbox-import:v1:${purpose}`) as BufferSource },
    await encryptionKey(secret), plaintext as BufferSource,
  );
  return { ciphertext: base64Url(new Uint8Array(ciphertext)), iv: base64Url(iv) };
}

export async function decryptImportSecret<T>(ciphertext: string, iv: string, secret: string, purpose: string): Promise<T> {
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(iv) as BufferSource, additionalData: encoder.encode(`ltds-dropbox-import:v1:${purpose}`) as BufferSource },
    await encryptionKey(secret), fromBase64Url(ciphertext) as BufferSource,
  );
  return JSON.parse(decoder.decode(plaintext)) as T;
}

function opsDb(env: Env) {
  return env.OPS_DB.withSession("first-primary");
}

export async function loadDropboxImportCredential(
  env: Env,
  authId: string,
  staffId: string,
  options: { allowExpired?: boolean } = {},
): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: string }> {
  const expiryClause = options.allowExpired ? "" : " AND datetime(expires_at)>datetime('now')";
  const row = await opsDb(env).prepare(
    `SELECT credential_ciphertext,credential_iv,key_id,token_expires_at,expires_at,revoked_at FROM dropbox_import_authorizations WHERE id=? AND staff_id=? AND revoked_at IS NULL${expiryClause}`,
  ).bind(authId, staffId).first<ImportAuthorization & { expires_at: string }>();
  if (!row || row.revoked_at) throw new Error("authorization-expired");
  if (row.token_expires_at && Date.parse(row.token_expires_at) <= Date.now() + 120000) {
    // Token is about to expire -- try refresh
    if (!env.DROPBOX_CLIENT_ID || !env.DROPBOX_CLIENT_SECRET) throw new Error("authorization-expired");
    const credential = await decryptImportSecret<{ accessToken: string; refreshToken?: string; expiresAt?: string }>(
      row.credential_ciphertext, row.credential_iv, env.DROPBOX_IMPORT_TOKEN_SECRET!, `authorization:${authId}`,
    );
    if (!credential.refreshToken) throw new Error("authorization-expired");
    const refreshed = await refreshDropboxToken(env.DROPBOX_CLIENT_ID, env.DROPBOX_CLIENT_SECRET, credential.refreshToken);
    const updated = { ...credential, ...refreshed, refreshToken: refreshed.refreshToken || credential.refreshToken };
    const encrypted = await encryptImportSecret(updated, env.DROPBOX_IMPORT_TOKEN_SECRET!, `authorization:${authId}`);
    await opsDb(env).prepare(
      "UPDATE dropbox_import_authorizations SET credential_ciphertext=?,credential_iv=?,token_expires_at=?,last_used_at=datetime('now') WHERE id=? AND revoked_at IS NULL",
    ).bind(encrypted.ciphertext, encrypted.iv, updated.expiresAt || null, authId).run();
    return updated;
  }
  if (!env.DROPBOX_IMPORT_TOKEN_SECRET) throw new Error("not-configured");
  return decryptImportSecret<{ accessToken: string; refreshToken?: string; expiresAt?: string }>(
    row.credential_ciphertext, row.credential_iv, env.DROPBOX_IMPORT_TOKEN_SECRET, `authorization:${authId}`,
  );
}

export async function revokeDropboxImportAuthorization(env: Env, authId: string, staffId: string): Promise<void> {
  const credential = await loadDropboxImportCredential(env, authId, staffId, { allowExpired: true });
  await new DropboxImportClient({ accessToken: credential.accessToken }).revoke();
  await opsDb(env).prepare(
    "UPDATE dropbox_import_authorizations SET credential_ciphertext='',credential_iv='',revoked_at=COALESCE(revoked_at,datetime('now')) WHERE id=? AND staff_id=? AND revoked_at IS NULL",
  ).bind(authId, staffId).run();
}


export async function jobCancelled(env: Env, jobId: string): Promise<boolean> {
  const row = await opsDb(env).prepare("SELECT status,cancel_requested_at FROM dropbox_import_jobs WHERE id=?").bind(jobId)
    .first<{ status: string; cancel_requested_at: string | null }>();
  return !row || row.status === "cancelling" || row.status === "cancelled" || Boolean(row.cancel_requested_at);
}

async function resolveDestinationKeyForItem(env: Env, destKey: string, conflictMode: string): Promise<string | null> {
  if (conflictMode === "skip" && await env.DATA_BUCKET.head(destKey)) return null;
  if (conflictMode === "fail" && await env.DATA_BUCKET.head(destKey)) throw new Error("destination-exists");
  if (conflictMode === "replace") return destKey;
  // autorename: find unique name
  if (!await env.DATA_BUCKET.head(destKey)) return destKey;
  const slash = destKey.lastIndexOf("/");
  const parent = slash >= 0 ? destKey.slice(0, slash + 1) : "";
  const name = slash >= 0 ? destKey.slice(slash + 1) : destKey;
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let i = 2; i <= 1001; i++) {
    const candidate = `${parent}${stem} (${i})${ext}`;
    if (!await env.DATA_BUCKET.head(candidate)) return candidate;
  }
  throw new Error("destination-unavailable");
}

function destination_prefix_trim(prefix: string): string {
  return prefix.replace(/^\/+|\/+$/g, "");
}

export async function importOneFile(
  env: Env,
  client: DropboxImportClient,
  item: ImportItem,
  conflictMode: string,
): Promise<{ r2Etag: string; size: number }> {
  // item.destination_key is the full R2 key set by replaceImportItems.
  // resolveDestinationKey applies the conflict policy to determine the final key.
  const destKey = await resolveDestinationKeyForItem(env, item.destination_key, conflictMode);
  if (!destKey) return { r2Etag: "", size: 0 }; // skipped

  // Download from Dropbox in chunks and upload to R2 via multipart
  const totalSize = item.size;
  if (totalSize > MAX_BYTES) throw new Error("file-too-large");

  if (totalSize === 0) {
    const written = await env.DATA_BUCKET.put(destKey, new Uint8Array(0));
    if (!written) throw new Error("r2-upload-failed");
    return { r2Etag: written.httpEtag, size: 0 };
  }

  // Use bounded range downloads and multipart upload for every non-empty file.
  // Each buffered part is bounded and the chosen size stays below R2's part-count ceiling.
  const partSize = dropboxImportPartSize(totalSize);
  const multipart = await env.DATA_BUCKET.createMultipartUpload(destKey, {
    httpMetadata: { contentType: "application/octet-stream" },
  });
  try {
    const parts: Array<{ partNumber: number; etag: string }> = [];
    let offset = 0;
    let partNumber = 1;

    while (offset < totalSize) {
      if (await jobCancelled(env, item.job_id)) {
        throw new Error("cancelled");
      }
      const length = Math.min(partSize, totalSize - offset);
      const sourceRef = item.dropbox_id || item.dropbox_path;
      const response = await client.downloadFile(sourceRef, { offset, length });
      const chunk = new Uint8Array(await response.arrayBuffer());
      if (chunk.byteLength !== length) throw new Error("dropbox-short-read");
      const result = await multipart.uploadPart(partNumber, chunk);
      parts.push({ partNumber: result.partNumber, etag: result.etag });
      offset += chunk.byteLength;
      partNumber += 1;

      // Checkpoint progress
      await opsDb(env).prepare(
        "UPDATE dropbox_import_items SET downloaded_bytes=?,uploaded_bytes=?,updated_at=datetime('now') WHERE id=?",
      ).bind(offset, offset, item.id).run();
      await opsDb(env).prepare(
        "UPDATE dropbox_import_jobs SET processed_bytes=(SELECT COALESCE(SUM(uploaded_bytes),0) FROM dropbox_import_items WHERE job_id=?),updated_at=datetime('now') WHERE id=? AND status='running'",
      ).bind(item.job_id, item.job_id).run();
    }

    const completed = await multipart.complete(parts);
    return { r2Etag: completed.httpEtag, size: totalSize };
  } catch (error) {
    try { await multipart.abort(); } catch { /* best effort cleanup */ }
    throw error;
  }
}

async function markItemResult(env: Env, item: ImportItem, result: { r2Etag: string; size: number }): Promise<void> {
  await env.OPS_DB.batch([
    opsDb(env).prepare(
      "UPDATE dropbox_import_items SET status='completed',r2_etag=?,uploaded_bytes=?,downloaded_bytes=?,error_code=NULL,error_message=NULL,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=?",
    ).bind(result.r2Etag || null, result.size, result.size, item.id),
    opsDb(env).prepare(
      "UPDATE dropbox_import_jobs SET processed_files=processed_files+1,succeeded_files=succeeded_files+1,updated_at=datetime('now') WHERE id=? AND status IN ('running','cancelling')",
    ).bind(item.job_id),
  ]);
}

async function markItemFailure(env: Env, item: ImportItem, error: unknown): Promise<void> {
  const isRetryable = error instanceof DropboxImportError && error.retryable;
  const status = isRetryable && item.attempts < 4 ? "retrying" : "failed";
  const code = error instanceof Error ? error.message : "import-failed";
  const message = error instanceof Error ? error.message.slice(0, 240) : "Import failed";
  await env.OPS_DB.batch([
    opsDb(env).prepare(
      "UPDATE dropbox_import_items SET status=?,error_code=?,error_message=?,updated_at=datetime('now') WHERE id=?",
    ).bind(status, code, message, item.id),
    ...(status === "failed" ? [opsDb(env).prepare(
      "UPDATE dropbox_import_jobs SET processed_files=processed_files+1,failed_files=failed_files+1,updated_at=datetime('now') WHERE id=? AND status IN ('running','cancelling')",
    ).bind(item.job_id)] : []),
  ]);
}

async function finalizeJob(env: Env, jobId: string): Promise<void> {
  const job = await opsDb(env).prepare("SELECT * FROM dropbox_import_jobs WHERE id=?").bind(jobId).first<ImportJob>();
  if (!job) return;
  const cancelled = await jobCancelled(env, jobId);
  const status = cancelled ? "cancelled" : job.failed_files > 0 ? (job.succeeded_files > 0 ? "partial" : "failed") : "completed";
  await env.OPS_DB.batch([
    opsDb(env).prepare(
      "UPDATE dropbox_import_items SET status='cancelled',error_code='cancelled',error_message='The remaining files were cancelled.',updated_at=datetime('now') WHERE job_id=? AND status IN ('queued','running','retrying')",
    ).bind(jobId),
    opsDb(env).prepare(
      "UPDATE dropbox_import_jobs SET status=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('queued','running','cancelling')",
    ).bind(status, jobId),
  ]);
  try {
    await revokeDropboxImportAuthorization(env, job.authorization_id, job.staff_id);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "dropbox-import.authorization-revoke-deferred",
      authorizationId: job.authorization_id,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

export async function runDropboxImportJob(env: Env, jobId: string, step: Pick<WorkflowStep, "do" | "sleep">): Promise<void> {
  const job = await opsDb(env).prepare("SELECT * FROM dropbox_import_jobs WHERE id=?").bind(jobId).first<ImportJob>();
  if (!job) throw new Error("job-not-found");

  try {
    if (job.status === "queued") {
      // Snapshot the Dropbox selection into items
      const credential = await loadDropboxImportCredential(env, job.authorization_id, job.staff_id);
      const client = new DropboxImportClient({ accessToken: credential.accessToken });
      const items = await step.do("snapshot-dropbox", async () => {
        return snapshotDropboxSelection(env, client, job);
      });
      await step.do("persist-items", async () => {
        await replaceImportItems(env, job, items);
        return { count: items.length };
      });
    }

    const current = await opsDb(env).prepare("SELECT * FROM dropbox_import_jobs WHERE id=?").bind(jobId).first<ImportJob>();
    if (!current || !["running", "cancelling"].includes(current.status)) return;

    const credential = await loadDropboxImportCredential(env, current.authorization_id, current.staff_id);
    const client = new DropboxImportClient({ accessToken: credential.accessToken });

    const items = await opsDb(env).prepare("SELECT * FROM dropbox_import_items WHERE job_id=? ORDER BY ordinal").bind(jobId).all<ImportItem>();
    for (const item of items.results) {
      if (!["queued", "retrying"].includes(item.status)) continue;
      if (await jobCancelled(env, jobId)) {
        await opsDb(env).prepare("UPDATE dropbox_import_jobs SET status='cancelling',cancel_requested_at=COALESCE(cancel_requested_at,datetime('now')) WHERE id=?").bind(jobId).run();
        break;
      }

      let current_item = item;
      for (let attempt = current_item.attempts; attempt < 4; attempt += 1) {
        const outcome = await step.do(`import-${item.ordinal}-${attempt}`, async () => {
          await opsDb(env).prepare(
            "UPDATE dropbox_import_items SET status='running',attempts=attempts+1,error_code=NULL,error_message=NULL,updated_at=datetime('now') WHERE id=? AND status IN ('queued','retrying')",
          ).bind(item.id).run();
          current_item = (await opsDb(env).prepare("SELECT * FROM dropbox_import_items WHERE id=?").bind(item.id).first<ImportItem>())!;
          try {
            const result = await importOneFile(env, client, current_item, current.conflict_mode);
            await markItemResult(env, current_item, result);
            return { terminal: true };
          } catch (error) {
            await markItemFailure(env, current_item, error);
            console.error(JSON.stringify({ event: "dropbox-import.item-failed", jobId, itemId: item.id, error: error instanceof Error ? error.message : String(error) }));
            const retryable = error instanceof DropboxImportError && error.retryable;
            return { terminal: !retryable };
          }
        });
        if (outcome.terminal) break;
        await step.sleep(`retry-wait-${item.ordinal}-${attempt}`, `${Math.min(300, 5 * 2 ** attempt)} seconds`);
        current_item = (await opsDb(env).prepare("SELECT * FROM dropbox_import_items WHERE id=?").bind(item.id).first<ImportItem>())!;
      }
    }

    await step.do("finalize-job", async () => {
      await finalizeJob(env, jobId);
      return { finalized: true };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: "dropbox-import.workflow-failed", jobId, error: message }));
    await opsDb(env).prepare(
      "UPDATE dropbox_import_jobs SET status='failed',error_code='import-failed',error_message=?,completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status IN ('queued','running')",
    ).bind(message.slice(0, 240), jobId).run();
    throw error;
  }
}

interface DropboxFileEntry {
  dropboxPath: string;
  dropboxId: string | null;
  size: number;
}

async function snapshotDropboxSelection(env: Env, client: DropboxImportClient, job: ImportJob): Promise<DropboxFileEntry[]> {
  const files: DropboxFileEntry[] = [];
  const sourcePath = job.source_path;

  let cursor: string | undefined;
  let hasMore = true;
  while (hasMore) {
    const result = cursor
      ? await client.listFolderContinue(cursor)
      : await client.listFolder(sourcePath || "", true);
    for (const entry of result.entries) {
      if (entry[".tag"] === "file") {
        files.push({
          dropboxPath: entry.pathDisplay || entry.name,
          // A rev reference is immutable; an id is only a rename-stable fallback.
          dropboxId: entry.rev ? `rev:${entry.rev}` : entry.id || null,
          size: entry.size || 0,
        });
      }
    }
    cursor = result.cursor;
    hasMore = result.hasMore;
    if (files.length > MAX_FILES) throw new Error("file-limit");
  }

  if (!files.length) throw new Error("empty-selection");
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (totalBytes > MAX_BYTES) throw new Error("byte-limit");

  return files;
}

async function replaceImportItems(env: Env, job: ImportJob, files: DropboxFileEntry[]): Promise<void> {
  const statements: D1PreparedStatement[] = [
    opsDb(env).prepare("DELETE FROM dropbox_import_items WHERE job_id=?").bind(job.id),
  ];
  files.forEach((file, ordinal) => {
    const destKey = normalizeCrudKey(`${destination_prefix_trim(job.destination_prefix)}/${file.dropboxPath.replace(/^\/+/, "")}`, false);
    statements.push(
      opsDb(env).prepare(
        "INSERT INTO dropbox_import_items (id,job_id,ordinal,dropbox_path,dropbox_id,destination_key,size,status) VALUES (?,?,?,?,?,?,?, 'queued')",
      ).bind(crypto.randomUUID(), job.id, ordinal, file.dropboxPath, file.dropboxId, destKey, file.size),
    );
  });
  statements.push(
    opsDb(env).prepare(
      "UPDATE dropbox_import_jobs SET status='running',file_count=?,total_bytes=?,processed_files=0,succeeded_files=0,failed_files=0,processed_bytes=0,started_at=COALESCE(started_at,datetime('now')),updated_at=datetime('now') WHERE id=? AND status='queued'",
    ).bind(files.length, files.reduce((sum, f) => sum + f.size, 0), job.id),
  );
  await env.OPS_DB.batch(statements);
}

export class DropboxImportWorkflow extends WorkflowEntrypoint<Env> {
  async run(event: Readonly<WorkflowEvent<{ jobId: string }>>, step: WorkflowStep): Promise<void> {
    await runDropboxImportJob(this.env, event.payload.jobId, step);
  }
}

// Cleanup function for the scheduled cron
export async function cleanupDropboxImports(env: Env, now = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  await opsDb(env).prepare(
    "UPDATE dropbox_import_jobs SET status='expired',cancel_requested_at=COALESCE(cancel_requested_at,datetime(?)),updated_at=datetime(?) WHERE status IN ('queued','running','cancelling') AND datetime(expires_at)<=datetime(?)",
  ).bind(nowIso, nowIso, nowIso).run();
  await opsDb(env).prepare(
    "UPDATE dropbox_import_items SET status='cancelled',error_code='cancelled',error_message='The remaining files were cancelled.',updated_at=datetime(?) WHERE job_id IN (SELECT id FROM dropbox_import_jobs WHERE status='expired') AND status IN ('queued','running','retrying')",
  ).bind(nowIso).run();

  // Revoke expired authorizations
  const auths = await opsDb(env).prepare(
    "SELECT id,staff_id FROM dropbox_import_authorizations WHERE revoked_at IS NULL AND datetime(expires_at)<=datetime(?)",
  ).bind(nowIso).all<{ id: string; staff_id: string }>();
  for (const auth of auths.results) {
    try {
      await revokeDropboxImportAuthorization(env, auth.id, auth.staff_id);
    } catch (error) {
      console.warn(JSON.stringify({
        event: "dropbox-import.authorization-revoke-retry",
        authorizationId: auth.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  // Clean old OAuth states
  await opsDb(env).prepare(
    "DELETE FROM dropbox_import_oauth_states WHERE consumed_at IS NOT NULL OR datetime(expires_at)<=datetime(?)",
  ).bind(nowIso).run();

  // Purge old completed jobs (90 days)
  const cutoff = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  await opsDb(env).prepare(
    "DELETE FROM dropbox_import_jobs WHERE status IN ('completed','partial','failed','cancelled','expired') AND datetime(updated_at)<=datetime(?)",
  ).bind(cutoff).run();
}