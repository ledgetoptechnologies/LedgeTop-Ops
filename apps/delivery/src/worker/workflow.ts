import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { decodeItemRef, isHiddenKey, keyWithinRoot, normalizeRoot } from "./files";
import { buildZipLayout, crc32, readZipPart, type ZipManifestEntry } from "./zip";
import { classifyWorkflowFailure } from "./bulk-download-errors";
import type { Env } from "./types";
export { classifyWorkflowFailure } from "./bulk-download-errors";

const MAX_FILES = 2_000;
const MAX_BYTES = 100 * 1024 * 1024 * 1024;
const CRC_CHUNK = 8 * 1024 * 1024;
const CRC_PROGRESS_CHECKPOINT = 64 * 1024 * 1024;
const CRC_FILE_CHECKPOINT = 25;
const ZIP_PART = 16 * 1024 * 1024;
const CRC_PROGRESS_WEIGHT = 0.5;

interface JobRow { id: string; share_id: string; share_version: number; request_json: string; manifest_key: string; archive_key: string; }
interface Requested { all?: boolean; items?: string[]; }
interface Source extends ZipManifestEntry { physicalKey: string; etag: string; }
interface Snapshot { root: string; shareId: string; shareVersion: number; sources: Array<Omit<Source, "crc32">>; }
interface FinalManifest { root: string; entries: Source[]; fileCount: number; totalBytes: number; }
interface Tombstone { physical_key: string; tombstone_kind: "exact" | "prefix"; }

export function crcProgressBytes(totalBytes: number, completedBytes: number): number {
  if (totalBytes <= 0) return 0;
  return Math.min(Math.floor(totalBytes * CRC_PROGRESS_WEIGHT), Math.floor(Math.max(0, completedBytes) * CRC_PROGRESS_WEIGHT));
}

export function assemblyProgressBytes(totalBytes: number, archiveSize: number, uploadedBytes: number): number {
  if (totalBytes <= 0) return 0;
  const crcShare = Math.floor(totalBytes * CRC_PROGRESS_WEIGHT);
  const assemblyShare = totalBytes - crcShare;
  if (archiveSize <= 0) return crcShare;
  const fraction = Math.min(1, Math.max(0, uploadedBytes) / archiveSize);
  return Math.min(totalBytes, crcShare + Math.floor(assemblyShare * fraction));
}

export function shouldCheckpointCrcChunk(previousBytes: number, nextBytes: number): boolean {
  return Math.floor(Math.max(0, nextBytes) / CRC_PROGRESS_CHECKPOINT) > Math.floor(Math.max(0, previousBytes) / CRC_PROGRESS_CHECKPOINT);
}

export function shouldCheckpointCrcFile(completedFiles: number, fileCount: number): boolean {
  return completedFiles === fileCount || completedFiles % CRC_FILE_CHECKPOINT === 0;
}

function db(env: Env): ReturnType<D1Database["withSession"]> { return env.DELIVERY_DB.withSession("first-primary"); }
async function readJson<T>(env: Env, key: string): Promise<T> {
  const object = await env.DATA_BUCKET.get(key); if (!object) throw new Error("workflow-manifest-missing");
  return JSON.parse(await object.text()) as T;
}
function displayPath(key: string, root: string, aliases: Map<string, string>): string {
  const relative = key.slice(root.length).replace(/\/$/, ""); const segments = relative.split("/"); let physical = root; const names: string[] = [];
  segments.forEach((segment, index) => { physical += segment; const alias = aliases.get(physical + (index === segments.length - 1 ? "" : "/")); names.push(alias || segment); physical += "/"; });
  return names.join("/");
}
function isTrashed(tombstones: Tombstone[], key: string): boolean {
  return tombstones.some(tombstone => tombstone.tombstone_kind === "exact" ? tombstone.physical_key === key : key.startsWith(tombstone.physical_key));
}
async function loadAliases(env: Env, keys: string[]): Promise<Map<string, string>> {
  const aliases = new Map<string, string>(); const unique = [...new Set(keys)];
  for (let offset = 0; offset < unique.length; offset += 100) {
    const batch = unique.slice(offset, offset + 100); if (!batch.length) continue;
    const result = await db(env).prepare(`SELECT physical_key,display_name FROM file_aliases WHERE physical_key IN (${batch.map(() => "?").join(",")})`).bind(...batch).all<{ physical_key: string; display_name: string }>();
    for (const row of result.results) aliases.set(row.physical_key, row.display_name);
  }
  return aliases;
}

export async function readSourceRange(
  bucket: R2Bucket,
  source: { physicalKey: string; etag: string },
  start: number,
  length: number,
): Promise<Uint8Array> {
  const object = await bucket.get(source.physicalKey, {
    range: { offset: start, length },
    onlyIf: { etagMatches: source.etag },
  });
  if (!object || !("arrayBuffer" in object)) throw new Error("source-changed-or-disappeared");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== length) throw new Error("source-short-read");
  return bytes;
}

export async function snapshot(env: Env, job: JobRow): Promise<Snapshot> {
  const share = await db(env).prepare(`SELECT s.id,s.share_version,s.r2_prefix FROM shares s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND s.share_version=? AND s.revoked_at IS NULL AND p.active=1 AND (s.expires_at IS NULL OR datetime(s.expires_at)>datetime('now'))`).bind(job.share_id, job.share_version).first<{ id: string; share_version: number; r2_prefix: string }>();
  if (!share) throw new Error("share-revoked");
  const tombstones = (await db(env).prepare("SELECT physical_key,tombstone_kind FROM delivery_tombstones WHERE restored_at IS NULL").all<Tombstone>()).results;
  const request = JSON.parse(job.request_json) as Requested; const root = normalizeRoot(share.r2_prefix); const folderPrefixes = new Set<string>(); const refs = request.items || [];
  const files = new Map<string, { size: number; etag: string }>();
  if (request.all === true) folderPrefixes.add(root);
  for (const ref of refs) {
    const key = keyWithinRoot(root, decodeItemRef(ref)); if (isTrashed(tombstones, key)) continue; const head = await env.DATA_BUCKET.head(key);
    if (head && !key.endsWith("/")) files.set(key, { size: head.size, etag: head.etag });
    else folderPrefixes.add(key.endsWith("/") ? key : `${key}/`);
  }
  for (const prefix of folderPrefixes) {
    let cursor: string | undefined;
    do {
      const listed = await env.DATA_BUCKET.list({ prefix, limit: 1000, cursor });
      for (const object of listed.objects) if (!object.key.endsWith("/") && !isHiddenKey(object.key) && !isTrashed(tombstones, object.key)) files.set(object.key, { size: object.size, etag: object.etag });
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  const physicalKeys = [...files.keys()].sort((left, right) => left.localeCompare(right));
  if (!physicalKeys.length) throw new Error("empty-selection");
  if (physicalKeys.length > MAX_FILES) throw new Error("file-limit");
  const aliasKeys = physicalKeys.flatMap(key => { const parts = key.split("/"); const values: string[] = []; for (let index = 1; index <= parts.length; index += 1) values.push(`${parts.slice(0, index).join("/")}${index < parts.length ? "/" : ""}`); return values; });
  const aliases = await loadAliases(env, aliasKeys);
  const sources = physicalKeys.map(key => ({ physicalKey: key, key, name: displayPath(key, root, aliases), size: files.get(key)!.size, etag: files.get(key)!.etag }));
  const totalBytes = sources.reduce((total, source) => total + source.size, 0); if (totalBytes > MAX_BYTES) throw new Error("byte-limit");
  return { root, shareId: share.id, shareVersion: share.share_version, sources };
}

export class BulkDownloadWorkflow extends WorkflowEntrypoint<Env> {
  async run(event: Readonly<WorkflowEvent<{ jobId: string }>>, step: WorkflowStep): Promise<void> {
    const jobId = event.payload.jobId; const job = await db(this.env).prepare("SELECT id,share_id,share_version,request_json,manifest_key,archive_key FROM bulk_download_jobs WHERE id=?").bind(jobId).first<JobRow>();
    if (!job) throw new Error("job-not-found");
    try {
      await step.do("snapshot-selection", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, async () => { const value = await snapshot(this.env, job); await this.env.DATA_BUCKET.put(job.manifest_key, JSON.stringify(value)); const totalBytes = value.sources.reduce((total, source) => total + source.size, 0); await db(this.env).prepare("UPDATE bulk_download_jobs SET status='running',file_count=?,total_bytes=?,updated_at=datetime('now') WHERE id=?").bind(value.sources.length, totalBytes, job.id).run(); return { count: value.sources.length, totalBytes, root: value.root }; });
      const snap = await readJson<Snapshot>(this.env, job.manifest_key);
      const prepared: Source[] = [];
      const totalSourceBytes = snap.sources.reduce((total, source) => total + source.size, 0);
      let completedCrcBytes = 0;
      for (let index = 0; index < snap.sources.length; index += 1) {
        const source = snap.sources[index]!; let offset = 0; let crc = 0xffffffff;
        while (offset < source.size) {
          const start = offset; const length = Math.min(CRC_CHUNK, source.size - offset);
          const part = await step.do(`crc-${index}-${start}`, { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, async () => {
            const bytes = await readSourceRange(this.env.DATA_BUCKET, source, start, length);
            const nextOffset = start + bytes.length;
            const nextCrc = crc32(bytes, crc);
            if (shouldCheckpointCrcChunk(completedCrcBytes + start, completedCrcBytes + nextOffset)) {
              await db(this.env).prepare("UPDATE bulk_download_jobs SET processed_files=?,processed_bytes=?,updated_at=datetime('now') WHERE id=? AND status='running'")
                .bind(index, crcProgressBytes(totalSourceBytes, completedCrcBytes + nextOffset), job.id).run();
            }
            return { crc: nextCrc, offset: nextOffset };
          });
          crc = part.crc; offset = part.offset;
        }
        prepared.push({ ...source, crc32: (crc ^ 0xffffffff) >>> 0 });
        completedCrcBytes += source.size;
        if (shouldCheckpointCrcFile(index + 1, snap.sources.length)) {
          await step.do(`mark-crc-file-${index}`, async () => {
            await db(this.env).prepare("UPDATE bulk_download_jobs SET processed_files=?,processed_bytes=?,updated_at=datetime('now') WHERE id=? AND status='running'")
              .bind(index + 1, crcProgressBytes(totalSourceBytes, completedCrcBytes), job.id).run();
            return { processedFiles: index + 1 };
          });
        }
      }
      const finalManifest = await step.do("write-final-manifest", async () => { const result: FinalManifest = { root: snap.root, entries: prepared, fileCount: prepared.length, totalBytes: prepared.reduce((total, source) => total + source.size, 0) }; await this.env.DATA_BUCKET.put(job.manifest_key, JSON.stringify(result)); return result; });
      const layout = buildZipLayout(finalManifest.entries);
      const upload = await step.do("create-multipart-upload", async () => { const result = await this.env.DATA_BUCKET.createMultipartUpload(job.archive_key, { httpMetadata: { contentType: "application/zip", contentDisposition: "attachment" } }); await db(this.env).prepare("UPDATE bulk_download_jobs SET multipart_upload_id=?,archive_size=?,updated_at=datetime('now') WHERE id=?").bind(result.uploadId, layout.archiveSize, job.id).run(); return { uploadId: result.uploadId, archiveSize: layout.archiveSize }; });
      const parts: Array<{ partNumber: number; etag: string }> = [];
      const partCount = Math.ceil(layout.archiveSize / ZIP_PART); if (partCount > 10_000) throw new Error("multipart-part-limit");
      for (let partNumber = 1; partNumber <= partCount; partNumber += 1) {
        const start = (partNumber - 1) * ZIP_PART; const length = Math.min(ZIP_PART, layout.archiveSize - start);
        const part = await step.do(`upload-${partNumber}`, { retries: { limit: 4, delay: "10 seconds", backoff: "exponential" } }, async () => {
          const bytes = await readZipPart(this.env.DATA_BUCKET, layout, start, length); const uploadRef = this.env.DATA_BUCKET.resumeMultipartUpload(job.archive_key, upload.uploadId); const result = await uploadRef.uploadPart(partNumber, bytes); await db(this.env).prepare("UPDATE bulk_download_jobs SET processed_bytes=?,updated_at=datetime('now') WHERE id=?").bind(assemblyProgressBytes(finalManifest.totalBytes, layout.archiveSize, start + length), job.id).run(); return { partNumber: result.partNumber, etag: result.etag };
        });
        parts.push(part);
      }
      await step.do("complete-multipart-upload", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => { const uploadRef = this.env.DATA_BUCKET.resumeMultipartUpload(job.archive_key, upload.uploadId); await uploadRef.complete(parts); return { archiveSize: layout.archiveSize }; });
      await step.do("mark-ready", async () => {
        const result = await db(this.env).prepare("UPDATE bulk_download_jobs SET status='ready',processed_files=file_count,processed_bytes=total_bytes,multipart_upload_id=NULL,expires_at=datetime('now','+24 hours'),updated_at=datetime('now') WHERE id=? AND status IN ('queued','running')").bind(job.id).run();
        if (!result.meta.changes) throw new Error("job-no-longer-active");
        return { status: "ready" };
      });
      await step.sleep("temporary-download-retention", "24 hours");
      await step.do("expire-temporary-download", async () => {
        await this.env.DATA_BUCKET.delete([job.archive_key, job.manifest_key]);
        await db(this.env).prepare("UPDATE bulk_download_jobs SET status='expired',updated_at=datetime('now') WHERE id=? AND status='ready'").bind(job.id).run();
        return { status: "expired" };
      });
    } catch (error) {
      const rawError = error instanceof Error ? error.message : String(error);
      const failure = classifyWorkflowFailure(rawError);
      console.error(JSON.stringify({ event: "bulk-download.workflow-failed", jobId: job.id, shareId: job.share_id, code: failure.code, error: rawError }));
      const failureState = await step.do("read-failure-state", async () => db(this.env).prepare("SELECT status FROM bulk_download_jobs WHERE id=?").bind(job.id).first<{ status: string }>());
      if (failureState?.status === "ready") {
        console.error(JSON.stringify({ event: "bulk-download.retention-failed", jobId: job.id, status: failureState.status, error: rawError }));
        return;
      }
      await step.do("cleanup-failed-artifacts", async () => {
        const current = await db(this.env).prepare("SELECT multipart_upload_id FROM bulk_download_jobs WHERE id=?").bind(job.id).first<{ multipart_upload_id: string | null }>();
        if (current?.multipart_upload_id) {
          try { await this.env.DATA_BUCKET.resumeMultipartUpload(job.archive_key, current.multipart_upload_id).abort(); } catch { /* already completed or absent */ }
        }
        await this.env.DATA_BUCKET.delete([job.archive_key, job.manifest_key]);
        return { cleaned: true };
      });
      await step.do("mark-failed", async () => { await db(this.env).prepare("UPDATE bulk_download_jobs SET status='failed',error_code=?,error_message=?,updated_at=datetime('now') WHERE id=? AND status IN ('queued','running')").bind(failure.code, failure.message, job.id).run(); return { status: "failed" }; });
      throw error;
    }
  }
}
