import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { decodeItemRef, isHiddenKey, keyWithinRoot, normalizeRoot } from "./files";
import { buildZipLayout, crc32, estimateZipArchiveSize, readZipPart, uniqueZipEntryNames, type ZipManifestEntry } from "./zip";
import { classifyWorkflowFailure } from "./bulk-download-errors";
import type { Env } from "./types";
import { isMovedSourceMarker } from "@ltds/shared";
import { listDownloadableObjects, type DownloadTombstone } from "./downloadable-files";
export { classifyWorkflowFailure } from "./bulk-download-errors";

const MAX_BYTES = 100 * 1024 * 1024 * 1024;
const CRC_CHUNK = 8 * 1024 * 1024;
const CRC_PROGRESS_CHECKPOINT = 64 * 1024 * 1024;
const CRC_FILE_CHECKPOINT = 25;
const CRC_BATCH_MAX_FILES = 64;
const ZIP_PART = 16 * 1024 * 1024;
const CRC_PROGRESS_WEIGHT = 0.5;
const WORKFLOW_STEP_LIMIT = 25_000;
const WORKFLOW_STEP_RESERVE = 100;
const WORKER_SUBREQUEST_LIMIT = 25_000;
const SUBREQUEST_RESERVE = 100;
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
// Snapshot, final-manifest write, multipart create/complete, ready transition,
// retention sleep, and retention expiry.
const SUCCESS_FIXED_STEPS = 7;

interface JobRow { id: string; share_id: string; share_version: number; request_json: string; manifest_key: string; archive_key: string; }
interface Requested { all?: boolean; items?: string[]; }
interface Source extends ZipManifestEntry { physicalKey: string; etag: string; }
interface Snapshot { root: string; shareId: string; shareVersion: number; sources: Array<Omit<Source, "crc32">>; }
interface FinalManifest { root: string; entries: Source[]; fileCount: number; totalBytes: number; }
type Tombstone = DownloadTombstone;
type CrcWorkUnit =
  | { kind: "batch"; indexes: number[]; totalBytes: number }
  | { kind: "chunk"; sourceIndex: number; start: number; length: number };

export interface BulkPreparationEstimate {
  archiveSize: number;
  crcSteps: number;
  uploadParts: number;
  workflowSteps: number;
  maximumUploadPartSourceReads: number;
}

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

export function shouldCheckpointCrcFile(previousFiles: number, completedFiles: number, fileCount: number): boolean {
  return completedFiles === fileCount
    || Math.floor(completedFiles / CRC_FILE_CHECKPOINT) > Math.floor(previousFiles / CRC_FILE_CHECKPOINT);
}

export function planCrcWorkUnits(sources: readonly Pick<Source, "size">[]): CrcWorkUnit[] {
  const units: CrcWorkUnit[] = [];
  let batchIndexes: number[] = [];
  let batchBytes = 0;
  const flushBatch = () => {
    if (batchIndexes.length) units.push({ kind: "batch", indexes: batchIndexes, totalBytes: batchBytes });
    batchIndexes = [];
    batchBytes = 0;
  };
  sources.forEach((source, sourceIndex) => {
    if (!Number.isSafeInteger(source.size) || source.size < 0) throw new Error("invalid-source-size");
    if (source.size <= CRC_CHUNK) {
      if (batchIndexes.length && (batchIndexes.length >= CRC_BATCH_MAX_FILES || batchBytes + source.size > CRC_CHUNK)) flushBatch();
      batchIndexes.push(sourceIndex);
      batchBytes += source.size;
      return;
    }
    flushBatch();
    for (let start = 0; start < source.size; start += CRC_CHUNK) {
      units.push({ kind: "chunk", sourceIndex, start, length: Math.min(CRC_CHUNK, source.size - start) });
    }
  });
  flushBatch();
  return units;
}

export function estimateBulkPreparation(sources: readonly Pick<Source, "name" | "size">[]): BulkPreparationEstimate {
  const archiveSize = estimateZipArchiveSize(sources);
  const uploadParts = Math.ceil(archiveSize / ZIP_PART);
  const crcSteps = planCrcWorkUnits(sources).length;
  const partSourceReads = new Uint32Array(uploadParts);
  const archiveNames = uniqueZipEntryNames(sources.map(source => source.name));
  let offset = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    const nameLength = new TextEncoder().encode(archiveNames[index]!).length;
    offset += 50 + nameLength;
    if (source.size > 0) {
      const firstPart = Math.floor(offset / ZIP_PART);
      const lastPart = Math.floor((offset + source.size - 1) / ZIP_PART);
      for (let part = firstPart; part <= lastPart; part += 1) partSourceReads[part]! += 1;
    }
    offset += source.size;
  }
  return {
    archiveSize,
    crcSteps,
    uploadParts,
    workflowSteps: SUCCESS_FIXED_STEPS + crcSteps + uploadParts,
    maximumUploadPartSourceReads: partSourceReads.length ? Math.max(...partSourceReads) : 0,
  };
}

export function assertBulkPreparationCapacity(snapshotValue: Snapshot): BulkPreparationEstimate {
  const manifestBytes = new TextEncoder().encode(JSON.stringify(snapshotValue)).byteLength;
  if (manifestBytes > MANIFEST_MAX_BYTES) throw new Error("manifest-capacity");
  const estimate = estimateBulkPreparation(snapshotValue.sources);
  if (estimate.uploadParts > 10_000) throw new Error("multipart-part-limit");
  if (estimate.workflowSteps > WORKFLOW_STEP_LIMIT - WORKFLOW_STEP_RESERVE) throw new Error("workflow-step-capacity");
  // Each upload step also writes the part and its D1 progress checkpoint.
  if (estimate.maximumUploadPartSourceReads + 2 > WORKER_SUBREQUEST_LIMIT - SUBREQUEST_RESERVE) throw new Error("subrequest-capacity");
  return estimate;
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
  if (request.all === true) {
    for (const object of await listDownloadableObjects(env.DATA_BUCKET, root, tombstones)) {
      files.set(object.key, { size: object.size, etag: object.etag });
    }
  }
  for (const ref of refs) {
    const key = keyWithinRoot(root, decodeItemRef(ref)); if (isTrashed(tombstones, key)) continue; const head = await env.DATA_BUCKET.head(key);
    if (head && !key.endsWith("/") && !isMovedSourceMarker(head)) files.set(key, { size: head.size, etag: head.etag });
    else folderPrefixes.add(key.endsWith("/") ? key : `${key}/`);
  }
  for (const prefix of folderPrefixes) {
    let cursor: string | undefined;
    do {
      const listed = await env.DATA_BUCKET.list({ prefix, limit: 1000, cursor, include:["customMetadata"] });
      for (const object of listed.objects) if (!object.key.endsWith("/") && !isHiddenKey(object.key) && !isTrashed(tombstones, object.key) && !isMovedSourceMarker(object)) files.set(object.key, { size: object.size, etag: object.etag });
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }
  const physicalKeys = [...files.keys()].sort((left, right) => left.localeCompare(right));
  if (!physicalKeys.length) throw new Error("empty-selection");
  const aliasKeys: string[] = []; let aliasMetadataBytes = 0; const textEncoder = new TextEncoder();
  for (const key of physicalKeys) {
    const parts = key.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const aliasKey = `${parts.slice(0, index).join("/")}${index < parts.length ? "/" : ""}`;
      aliasMetadataBytes += textEncoder.encode(aliasKey).length;
      if (aliasMetadataBytes > MANIFEST_MAX_BYTES) throw new Error("manifest-capacity");
      aliasKeys.push(aliasKey);
    }
  }
  const aliases = await loadAliases(env, aliasKeys);
  const sources = physicalKeys.map(key => ({ physicalKey: key, key, name: displayPath(key, root, aliases), size: files.get(key)!.size, etag: files.get(key)!.etag }));
  const totalBytes = sources.reduce((total, source) => total + source.size, 0); if (totalBytes > MAX_BYTES) throw new Error("byte-limit");
  const result = { root, shareId: share.id, shareVersion: share.share_version, sources };
  assertBulkPreparationCapacity(result);
  return result;
}

export class BulkDownloadWorkflow extends WorkflowEntrypoint<Env> {
  async run(event: Readonly<WorkflowEvent<{ jobId: string }>>, step: WorkflowStep): Promise<void> {
    const jobId = event.payload.jobId; const job = await db(this.env).prepare("SELECT id,share_id,share_version,request_json,manifest_key,archive_key FROM bulk_download_jobs WHERE id=?").bind(jobId).first<JobRow>();
    if (!job) throw new Error("job-not-found");
    try {
      await step.do("snapshot-selection", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, async () => { const value = await snapshot(this.env, job); await this.env.DATA_BUCKET.put(job.manifest_key, JSON.stringify(value)); const totalBytes = value.sources.reduce((total, source) => total + source.size, 0); await db(this.env).prepare("UPDATE bulk_download_jobs SET status='running',file_count=?,total_bytes=?,updated_at=datetime('now') WHERE id=?").bind(value.sources.length, totalBytes, job.id).run(); return { count: value.sources.length, totalBytes, root: value.root }; });
      const snap = await readJson<Snapshot>(this.env, job.manifest_key);
      const prepared: Source[] = new Array(snap.sources.length);
      const totalSourceBytes = snap.sources.reduce((total, source) => total + source.size, 0);
      let completedCrcBytes = 0;
      let completedFiles = 0;
      const crcStates = new Array<number>(snap.sources.length).fill(0xffffffff);
      const workUnits = planCrcWorkUnits(snap.sources);
      for (let unitIndex = 0; unitIndex < workUnits.length; unitIndex += 1) {
        const unit = workUnits[unitIndex]!;
        const previousBytes = completedCrcBytes;
        const previousFiles = completedFiles;
        if (unit.kind === "batch") {
          const result = await step.do(`crc-batch-${unitIndex}`, { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, async () => {
            const entries: Array<{ sourceIndex: number; crc32: number }> = [];
            for (const sourceIndex of unit.indexes) {
              const source = snap.sources[sourceIndex]!;
              const bytes = source.size ? await readSourceRange(this.env.DATA_BUCKET, source, 0, source.size) : new Uint8Array();
              entries.push({ sourceIndex, crc32: (crc32(bytes) ^ 0xffffffff) >>> 0 });
            }
            const nextBytes = previousBytes + unit.totalBytes;
            const nextFiles = unit.indexes.at(-1)! + 1;
            if (shouldCheckpointCrcChunk(previousBytes, nextBytes) || shouldCheckpointCrcFile(previousFiles, nextFiles, snap.sources.length)) {
              await db(this.env).prepare("UPDATE bulk_download_jobs SET processed_files=?,processed_bytes=?,updated_at=datetime('now') WHERE id=? AND status='running'")
                .bind(nextFiles, crcProgressBytes(totalSourceBytes, nextBytes), job.id).run();
            }
            return { entries, bytes: unit.totalBytes, completedFiles: nextFiles };
          });
          for (const entry of result.entries) prepared[entry.sourceIndex] = { ...snap.sources[entry.sourceIndex]!, crc32: entry.crc32 };
          completedCrcBytes += result.bytes;
          completedFiles = result.completedFiles;
          continue;
        }
        const source = snap.sources[unit.sourceIndex]!;
        const priorCrc = crcStates[unit.sourceIndex]!;
        const result = await step.do(`crc-${unit.sourceIndex}-${unit.start}`, { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, async () => {
          const bytes = await readSourceRange(this.env.DATA_BUCKET, source, unit.start, unit.length);
          const sourceComplete = unit.start + bytes.length === source.size;
          const nextBytes = previousBytes + bytes.length;
          const nextFiles = sourceComplete ? unit.sourceIndex + 1 : previousFiles;
          if (shouldCheckpointCrcChunk(previousBytes, nextBytes) || shouldCheckpointCrcFile(previousFiles, nextFiles, snap.sources.length)) {
            await db(this.env).prepare("UPDATE bulk_download_jobs SET processed_files=?,processed_bytes=?,updated_at=datetime('now') WHERE id=? AND status='running'")
              .bind(nextFiles, crcProgressBytes(totalSourceBytes, nextBytes), job.id).run();
          }
          return { crc: crc32(bytes, priorCrc), bytes: bytes.length, sourceComplete, completedFiles: nextFiles };
        });
        crcStates[unit.sourceIndex] = result.crc;
        completedCrcBytes += result.bytes;
        completedFiles = result.completedFiles;
        if (result.sourceComplete) prepared[unit.sourceIndex] = { ...source, crc32: (result.crc ^ 0xffffffff) >>> 0 };
      }
      await step.do("write-final-manifest", async () => {
        const result: FinalManifest = { root: snap.root, entries: prepared, fileCount: prepared.length, totalBytes: prepared.reduce((total, source) => total + source.size, 0) };
        await this.env.DATA_BUCKET.put(job.manifest_key, JSON.stringify(result));
        // Do not persist a potentially multi-megabyte manifest as Workflow step
        // state. R2 is the durable source of truth for the assembly phase.
        return { fileCount: result.fileCount, totalBytes: result.totalBytes };
      });
      const finalManifest = await readJson<FinalManifest>(this.env, job.manifest_key);
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
