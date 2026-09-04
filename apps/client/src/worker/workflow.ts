import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { decodeItemRef, isHiddenKey, keyWithinRoot, normalizeRoot } from "./files";
import { buildZipLayout, crc32, estimateZipArchiveSize, readZipPart, uniqueZipEntryNames, type ZipManifestEntry } from "./zip";
import {
  buildOnePassZipPrefixPart, buildOnePassZipTrailer, initialOnePassZipState, joinZipBytes,
  planOnePassZipMultipart, type OnePassZipEntry, type OnePassZipState,
} from "./one-pass-zip";
import { classifyWorkflowFailure } from "./bulk-download-errors";
import type { Env } from "./types";
import { isMovedSourceMarker } from "@ltds/shared";
import { listDownloadableObjects, type DownloadTombstone } from "./downloadable-files";
export { classifyWorkflowFailure } from "./bulk-download-errors";

export const MAX_ARCHIVE_SOURCE_BYTES = 100 * 1024 * 1024 * 1024;
export const BULK_DOWNLOAD_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const BULK_DOWNLOAD_RETENTION_DURATION = "7 days";
export const BULK_DOWNLOAD_CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CRC_CHUNK = 8 * 1024 * 1024;
const CRC_PROGRESS_CHECKPOINT = 64 * 1024 * 1024;
const CRC_FILE_CHECKPOINT = 25;
const CRC_BATCH_MAX_FILES = 64;
const ZIP_PART = 16 * 1024 * 1024;
export const CRC_CONCURRENCY = 4;
export const UPLOAD_CONCURRENCY = 2;
const CRC_PROGRESS_WEIGHT = 0.5;
const WORKFLOW_STEP_LIMIT = 25_000;
const WORKFLOW_STEP_RESERVE = 100;
const WORKER_SUBREQUEST_LIMIT = 25_000;
const SUBREQUEST_RESERVE = 100;
const MANIFEST_MAX_BYTES = 16 * 1024 * 1024;
export const CHECKSUM_SQL_CHUNK = 100;
const D1_QUERY_LIMIT = 1_000;
const D1_QUERY_RESERVE = 25;
export const ALIAS_LOOKUP_MAX_JSON_BYTES = 512 * 1024;
export const CACHE_REUSE_CLAIM_QUERIES = 2;
const workflowTextEncoder = new TextEncoder();
// Snapshot, cache resolution/lookup, multipart create/finalize, ready transition,
// retention sleep, and retention expiry. Upload parts are counted separately.
const SUCCESS_FIXED_STEPS = 8;

interface JobRow { id: string; share_id: string; share_version: number; request_json: string; manifest_key: string; archive_key: string; parent_job_id?: string | null; part_index?: number | null; part_count?: number; }
interface Requested { all?: boolean; items?: string[]; }
interface Source extends ZipManifestEntry { physicalKey: string; etag: string; }
interface Snapshot { root: string; shareId: string; shareVersion: number; sources: Array<Omit<Source, "crc32">>; }
interface FinalManifest { root: string; entries: Source[]; fileCount: number; totalBytes: number; }
interface ResolvedSnapshot extends Omit<Snapshot, "sources"> { fingerprint: string; sources: OnePassZipEntry[]; }
interface ArchiveCacheRow { archive_key: string; archive_etag: string; archive_size: number; file_count: number; total_bytes: number; }
interface ChecksumRow { r2_key: string; etag: string; size: number; crc32: number; }
type Tombstone = DownloadTombstone;
type CrcWorkUnit =
  | { kind: "batch"; indexes: number[]; totalBytes: number }
  | { kind: "chunk"; sourceIndex: number; start: number; length: number };

export function finalBulkManifestKey(snapshotKey: string): string { return `${snapshotKey}.final.json`; }
export function resolvedBulkManifestKey(snapshotKey: string): string { return `${snapshotKey}.resolved.json`; }

function hex(bytes: ArrayBuffer): string { return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join(""); }

export async function bulkSelectionFingerprint(snapshotValue: Snapshot): Promise<string> {
  const canonical = JSON.stringify({
    format: "ltds-zip64-descriptor-v1",
    shareId: snapshotValue.shareId,
    shareVersion: snapshotValue.shareVersion,
    root: snapshotValue.root,
    sources: snapshotValue.sources.map(source => ({ key: source.physicalKey, name: source.name, size: source.size, etag: source.etag })),
  });
  return hex(await crypto.subtle.digest("SHA-256", workflowTextEncoder.encode(canonical)));
}

export function bulkCacheArtifactKey(shareId: string, fingerprint: string, jobId: string): string {
  return `_ltds/bulk-download-cache/v1/${encodeURIComponent(shareId)}/${fingerprint}/${jobId}.zip`;
}

/** Drain every sibling before propagating failure: cleanup must not race an upload. */
export async function drainParallel<T>(tasks: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
  const results = await Promise.all(tasks.map(async task => {
    try { return { ok: true as const, value: await task() }; }
    catch (error) { return { ok: false as const, error }; }
  }));
  return results.map(result => { if (!result.ok) throw result.error; return result.value; });
}

/** Stable consecutive windows preserve original step IDs and same-file CRC dependencies. */
export function planCrcWindows(units: readonly CrcWorkUnit[]): number[][] {
  const windows: number[][] = [];
  let current: number[] = [];
  const chunkSources = new Set<number>();
  units.forEach((unit, index) => {
    if (current.length >= CRC_CONCURRENCY || (unit.kind === "chunk" && chunkSources.has(unit.sourceIndex))) {
      windows.push(current); current = []; chunkSources.clear();
    }
    current.push(index);
    if (unit.kind === "chunk") chunkSources.add(unit.sourceIndex);
  });
  if (current.length) windows.push(current);
  return windows;
}

export interface BulkPreparationEstimate {
  archiveSize: number;
  crcSteps: number;
  uploadParts: number;
  workflowSteps: number;
  maximumUploadPartSourceReads: number;
}

export interface OnePassBulkPreparationEstimate {
  archiveSize: number;
  /** Kept for API compatibility; descriptor ZIPs do not need CRC-only steps. */
  crcSteps: 0;
  uploadParts: number;
  workflowSteps: number;
  maximumUploadPartSourceReads: number;
  maximumCompletedEntriesPerPart: number;
  maximumD1QueriesPerStep: number;
  snapshotAliasQueries: number;
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
  const crcUnits = planCrcWorkUnits(sources);
  const crcSteps = crcUnits.length;
  // Count the exact checkpoints the execution loop emits, not every CRC window:
  // a large single file has one window per chunk but checkpoints only every 64 MiB.
  let crcProgressSteps = 0;
  let completedBytes = 0;
  let completedFiles = 0;
  for (const window of planCrcWindows(crcUnits)) {
    const previousBytes = completedBytes;
    const previousFiles = completedFiles;
    for (const unitIndex of window) {
      const unit = crcUnits[unitIndex]!;
      if (unit.kind === "batch") {
        completedBytes += unit.totalBytes;
        completedFiles = unit.indexes.at(-1)! + 1;
      } else {
        completedBytes += unit.length;
        if (unit.start + unit.length === sources[unit.sourceIndex]!.size) completedFiles = unit.sourceIndex + 1;
      }
    }
    if (shouldCheckpointCrcChunk(previousBytes, completedBytes) || shouldCheckpointCrcFile(previousFiles, completedFiles, sources.length)) crcProgressSteps += 1;
  }
  const progressSteps = crcProgressSteps + Math.ceil(uploadParts / UPLOAD_CONCURRENCY);
  const partSourceReads = new Uint32Array(uploadParts);
  const archiveNames = uniqueZipEntryNames(sources.map(source => source.name));
  let offset = 0;
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index]!;
    const nameLength = workflowTextEncoder.encode(archiveNames[index]!).length;
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
    workflowSteps: SUCCESS_FIXED_STEPS + crcSteps + uploadParts + progressSteps,
    maximumUploadPartSourceReads: partSourceReads.length ? Math.max(...partSourceReads) : 0,
  };
}

export function estimateOnePassBulkPreparation(sources: readonly (Pick<Source, "name" | "size"> & Partial<Pick<Source, "physicalKey">>)[]): OnePassBulkPreparationEstimate {
  const plan = planOnePassZipMultipart(sources);
  const names = uniqueZipEntryNames(sources.map(source => source.name));
  const partReads = Array<number>(plan.partCount).fill(0);
  const partCompletions = Array<number>(plan.partCount).fill(0);
  let offset = 0;
  sources.forEach((source, index) => {
    const headerSize = 50 + workflowTextEncoder.encode(names[index]!).length;
    const dataStart = offset + headerSize;
    const dataEnd = dataStart + source.size;
    if (source.size > 0) {
      const firstPart = Math.floor(dataStart / plan.partSize);
      const lastPart = Math.floor((dataEnd - 1) / plan.partSize);
      for (let part = firstPart; part <= lastPart; part += 1) {
        const overlap = Math.min(dataEnd, (part + 1) * plan.partSize) - Math.max(dataStart, part * plan.partSize);
        partReads[part]! += Math.ceil(overlap / (8 * 1024 * 1024));
      }
    }
    offset = dataEnd + 24;
    partCompletions[Math.min(plan.partCount - 1, Math.floor((offset - 1) / plan.partSize))]! += 1;
  });
  const maximumUploadPartSourceReads = partReads.length ? Math.max(...partReads) : 0;
  const maximumCompletedEntriesPerPart = partCompletions.length ? Math.max(...partCompletions) : 0;
  const checksumLookupQueries = Math.ceil(sources.length / CHECKSUM_SQL_CHUNK);
  const maximumChecksumWriteQueries = Math.ceil(maximumCompletedEntriesPerPart / CHECKSUM_SQL_CHUNK);
  const physicalKeys = sources.flatMap(source => source.physicalKey ? [source.physicalKey] : []);
  const snapshotAliasQueries = physicalKeys.length === sources.length
    ? planAliasLookupBatches(aliasKeysForPhysicalKeys(physicalKeys)).length + 3
    : 0;
  // resolve: lookup + touch; final part: writes + full checksum lookup + progress.
  const maximumD1QueriesPerStep = Math.max(
    checksumLookupQueries * 2,
    maximumChecksumWriteQueries + checksumLookupQueries + 1,
    snapshotAliasQueries,
    CACHE_REUSE_CLAIM_QUERIES,
  );
  return {
    archiveSize: plan.archiveSize,
    crcSteps: 0,
    uploadParts: plan.partCount,
    workflowSteps: SUCCESS_FIXED_STEPS + plan.partCount,
    maximumUploadPartSourceReads,
    maximumCompletedEntriesPerPart,
    maximumD1QueriesPerStep,
    snapshotAliasQueries,
  };
}

export function assertBulkPreparationCapacity(snapshotValue: Snapshot): OnePassBulkPreparationEstimate {
  const manifestBytes = workflowTextEncoder.encode(JSON.stringify(snapshotValue)).byteLength;
  if (manifestBytes > MANIFEST_MAX_BYTES) throw new Error("manifest-capacity");
  const estimate = estimateOnePassBulkPreparation(snapshotValue.sources);
  if (estimate.uploadParts > 10_000) throw new Error("multipart-part-limit");
  if (estimate.workflowSteps > WORKFLOW_STEP_LIMIT - WORKFLOW_STEP_RESERVE) throw new Error("workflow-step-capacity");
  // Each upload step also persists newly observed checksums in D1 batches,
  // writes the R2 part, and updates its D1 progress checkpoint.
  const checksumWrites = Math.ceil(estimate.maximumCompletedEntriesPerPart / CHECKSUM_SQL_CHUNK);
  if (estimate.maximumUploadPartSourceReads + checksumWrites + 2 > WORKER_SUBREQUEST_LIMIT - SUBREQUEST_RESERVE) throw new Error("subrequest-capacity");
  if (estimate.maximumD1QueriesPerStep > D1_QUERY_LIMIT - D1_QUERY_RESERVE) throw new Error("d1-query-capacity");
  return estimate;
}

function capacityFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return ["manifest-capacity", "multipart-part-limit", "workflow-step-capacity", "subrequest-capacity", "d1-query-capacity"].includes(message);
}

/**
 * Preserve the source sort order and prefer one archive. Only split when the
 * per-archive byte or execution-capacity boundary requires it. Recursive
 * bisection is deterministic and guarantees that every emitted part can run
 * in an independent Workflow instance.
 */
export function partitionBulkSnapshot(snapshotValue: Snapshot): Snapshot[] {
  const byteGroups: Array<Array<Omit<Source, "crc32">>> = [];
  let current: Array<Omit<Source, "crc32">> = [];
  let currentBytes = 0;
  for (const source of snapshotValue.sources) {
    if (source.size > MAX_ARCHIVE_SOURCE_BYTES) throw new Error("single-source-capacity");
    if (current.length && currentBytes + source.size > MAX_ARCHIVE_SOURCE_BYTES) {
      byteGroups.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(source);
    currentBytes += source.size;
  }
  if (current.length) byteGroups.push(current);

  const result: Snapshot[] = [];
  const fit = (sources: Array<Omit<Source, "crc32">>): void => {
    const candidate = { ...snapshotValue, sources };
    try {
      assertBulkPreparationCapacity(candidate);
      result.push(candidate);
    } catch (error) {
      if (!capacityFailure(error) || sources.length === 1) throw error;
      const middle = Math.ceil(sources.length / 2);
      fit(sources.slice(0, middle));
      fit(sources.slice(middle));
    }
  };
  for (const sources of byteGroups) fit(sources);
  return result;
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
export function aliasKeysForPhysicalKeys(physicalKeys: readonly string[],maximumBytes=MANIFEST_MAX_BYTES): string[] {
  const keys: string[] = [];
  let retainedBytes=0;
  for (const key of physicalKeys) {
    const parts = key.split("/");
    let prefix="";
    for (let index = 0; index < parts.length; index += 1){
      prefix+=`${index?"/":""}${parts[index]}`;
      const aliasKey=`${prefix}${index<parts.length-1?"/":""}`;
      retainedBytes+=workflowTextEncoder.encode(aliasKey).byteLength;
      // Enforce the cap before retaining the candidate so adversarial deep
      // paths cannot first materialize an unbounded prefix array.
      if(retainedBytes>maximumBytes)throw new Error("manifest-capacity");
      keys.push(aliasKey);
    }
  }
  return keys;
}

/** Keep each one-parameter JSON lookup comfortably below D1's value limit. */
export function planAliasLookupBatches(keys: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 2;
  for (const key of new Set(keys)) {
    const itemBytes = workflowTextEncoder.encode(JSON.stringify(key)).byteLength;
    const addedBytes = itemBytes + (batch.length ? 1 : 0);
    if (batch.length && bytes + addedBytes > ALIAS_LOOKUP_MAX_JSON_BYTES) {
      batches.push(batch); batch = []; bytes = 2;
    }
    batch.push(key);
    bytes += itemBytes + (batch.length > 1 ? 1 : 0);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
function isTrashed(tombstones: Tombstone[], key: string): boolean {
  return tombstones.some(tombstone => tombstone.tombstone_kind === "exact" ? tombstone.physical_key === key : key.startsWith(tombstone.physical_key));
}
async function loadAliases(env: Env, keys: string[]): Promise<Map<string, string>> {
  const aliases = new Map<string, string>();
  for (const batch of planAliasLookupBatches(keys)) {
    const result = await db(env).prepare(`SELECT f.physical_key,f.display_name FROM file_aliases f
      JOIN json_each(?) requested ON f.physical_key=requested.value`).bind(JSON.stringify(batch)).all<{ physical_key: string; display_name: string }>();
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

async function loadChecksumCache(env: Env, sources: readonly OnePassZipEntry[]): Promise<Map<string, number>> {
  const found = new Map<string, number>();
  for (let offset = 0; offset < sources.length; offset += 100) {
    const batch = sources.slice(offset, offset + 100);
    const rows = await db(env).prepare(`SELECT r2_key,etag,size,crc32 FROM bulk_download_object_checksums
      WHERE r2_key IN (${batch.map(() => "?").join(",")})`).bind(...batch.map(source => source.physicalKey)).all<ChecksumRow>();
    const expected = new Map(batch.map(source => [source.physicalKey, source]));
    for (const row of rows.results) {
      const source = expected.get(row.r2_key);
      if (source && row.etag === source.etag && row.size === source.size && Number.isInteger(row.crc32) && row.crc32 >= 0 && row.crc32 <= 0xffffffff)
        found.set(row.r2_key, row.crc32);
    }
  }
  return found;
}

async function touchChecksumCache(env: Env, sources: readonly OnePassZipEntry[]): Promise<void> {
  const hits = sources.filter(source => source.crc32 !== undefined);
  for (let offset = 0; offset < hits.length; offset += CHECKSUM_SQL_CHUNK) {
    const identities = hits.slice(offset, offset + CHECKSUM_SQL_CHUNK).map(source => ({
      key: source.physicalKey, etag: source.etag, size: source.size, crc32: source.crc32,
    }));
    await env.DELIVERY_DB.prepare(`WITH identities AS (
      SELECT json_extract(value,'$.key') AS r2_key,json_extract(value,'$.etag') AS etag,
        json_extract(value,'$.size') AS size,json_extract(value,'$.crc32') AS crc32 FROM json_each(?)
    ) UPDATE bulk_download_object_checksums SET last_used_at=datetime('now')
      WHERE (r2_key,etag,size,crc32) IN (SELECT r2_key,etag,size,crc32 FROM identities)`)
      .bind(JSON.stringify(identities)).run();
  }
}

async function persistCalculatedChecksums(
  env: Env,
  sources: readonly OnePassZipEntry[],
  checksums: readonly { entryIndex: number; crc32: number; calculated: boolean }[],
): Promise<void> {
  const values = checksums.filter(value => value.calculated);
  for (let offset = 0; offset < values.length; offset += CHECKSUM_SQL_CHUNK) {
    const rows = values.slice(offset, offset + CHECKSUM_SQL_CHUNK).map(value => {
      const source = sources[value.entryIndex]!;
      return { key: source.physicalKey, etag: source.etag, size: source.size, crc32: value.crc32 };
    });
    await env.DELIVERY_DB.prepare(`INSERT INTO bulk_download_object_checksums(r2_key,etag,size,crc32)
      SELECT json_extract(value,'$.key'),json_extract(value,'$.etag'),json_extract(value,'$.size'),json_extract(value,'$.crc32')
      FROM json_each(?) WHERE true ON CONFLICT(r2_key,etag,size) DO UPDATE SET crc32=excluded.crc32,
        calculated_at=datetime('now'),last_used_at=datetime('now')`)
      .bind(JSON.stringify(rows)).run();
  }
}

async function resolveSnapshotChecksums(env: Env, snapshotValue: Snapshot): Promise<ResolvedSnapshot> {
  const fingerprint = await bulkSelectionFingerprint(snapshotValue);
  const provisional = snapshotValue.sources.map(source => ({ ...source })) as OnePassZipEntry[];
  const cached = await loadChecksumCache(env, provisional);
  const sources = provisional.map(source => cached.has(source.physicalKey) ? { ...source, crc32: cached.get(source.physicalKey)! } : source);
  await touchChecksumCache(env, sources);
  return { ...snapshotValue, fingerprint, sources };
}

async function completedEntries(env: Env, resolved: ResolvedSnapshot): Promise<Source[]> {
  const cached = await loadChecksumCache(env, resolved.sources);
  return resolved.sources.map(source => {
    const checksum = source.crc32 ?? cached.get(source.physicalKey);
    if (checksum === undefined) throw new Error("checksum-cache-incomplete");
    return { ...source, crc32: checksum };
  });
}

async function reuseCachedArchive(env: Env, job: JobRow, resolved: ResolvedSnapshot): Promise<ArchiveCacheRow | null> {
  const row = await db(env).prepare(`SELECT c.archive_key,c.archive_etag,c.archive_size,c.file_count,c.total_bytes
    FROM bulk_download_archive_cache c JOIN bulk_download_archive_generations g ON g.archive_key=c.archive_key
    WHERE c.share_id=? AND c.share_version=? AND c.selection_fingerprint=? AND datetime(c.expires_at)>datetime('now')
      AND g.state='active' AND g.archive_etag=c.archive_etag AND g.archive_size=c.archive_size`)
    .bind(job.share_id, job.share_version, resolved.fingerprint).first<ArchiveCacheRow>();
  if (!row) return null;
  const head = await env.DATA_BUCKET.head(row.archive_key);
  if (!head || head.etag !== row.archive_etag || head.size !== row.archive_size) return null;
  // D1 batch is transactional: cleanup cannot observe the renewed cache lease
  // without also observing this running job's reference to the exact archive.
  const claimResults = await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare(`UPDATE bulk_download_archive_cache SET expires_at=datetime('now','+30 days'),last_used_at=datetime('now')
      WHERE share_id=? AND share_version=? AND selection_fingerprint=? AND archive_key=? AND archive_etag=?
        AND archive_size=? AND datetime(expires_at)>datetime('now') AND EXISTS (
          SELECT 1 FROM bulk_download_archive_generations WHERE archive_key=? AND archive_etag=? AND archive_size=? AND state='active'
        )`)
      .bind(job.share_id, job.share_version, resolved.fingerprint, row.archive_key, row.archive_etag, row.archive_size,
        row.archive_key, row.archive_etag, row.archive_size),
    env.DELIVERY_DB.prepare(`UPDATE bulk_download_jobs SET archive_key=?,archive_fingerprint=?,archive_size=?,updated_at=datetime('now')
      WHERE id=? AND status IN ('queued','running') AND EXISTS (
        SELECT 1 FROM bulk_download_archive_cache WHERE share_id=? AND share_version=? AND selection_fingerprint=?
          AND archive_key=? AND archive_etag=? AND archive_size=? AND datetime(expires_at)>datetime('now')
          AND EXISTS (SELECT 1 FROM bulk_download_archive_generations WHERE archive_key=? AND archive_etag=? AND archive_size=? AND state='active')
      )`).bind(row.archive_key, resolved.fingerprint, row.archive_size, job.id, job.share_id, job.share_version,
        resolved.fingerprint, row.archive_key, row.archive_etag, row.archive_size, row.archive_key, row.archive_etag, row.archive_size),
  ]);
  if (!claimResults[0]?.meta.changes || !claimResults[1]?.meta.changes) return null;
  return row;
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
  const aliasKeys = aliasKeysForPhysicalKeys(physicalKeys);
  if (planAliasLookupBatches(aliasKeys).length + 3 > D1_QUERY_LIMIT - D1_QUERY_RESERVE) throw new Error("d1-query-capacity");
  const aliases = await loadAliases(env, aliasKeys);
  const sources = physicalKeys.map(key => ({ physicalKey: key, key, name: displayPath(key, root, aliases), size: files.get(key)!.size, etag: files.get(key)!.etag }));
  return { root, shareId: share.id, shareVersion: share.share_version, sources };
}

export class BulkDownloadWorkflow extends WorkflowEntrypoint<Env> {
  async run(event: Readonly<WorkflowEvent<{ jobId: string; prepared?: boolean }>>, step: WorkflowStep): Promise<void> {
    const jobId = event.payload.jobId; const job = await db(this.env).prepare("SELECT id,share_id,share_version,request_json,manifest_key,archive_key,parent_job_id,part_index,part_count FROM bulk_download_jobs WHERE id=?").bind(jobId).first<JobRow>();
    if (!job) throw new Error("job-not-found");
    try {
      if (!event.payload.prepared) {
        await step.do("snapshot-selection", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, async () => { const value = await snapshot(this.env, job); await this.env.DATA_BUCKET.put(job.manifest_key, JSON.stringify(value)); const totalBytes = value.sources.reduce((total, source) => total + source.size, 0); await db(this.env).prepare("UPDATE bulk_download_jobs SET status='running',file_count=?,total_bytes=?,updated_at=datetime('now') WHERE id=?").bind(value.sources.length, totalBytes, job.id).run(); return { count: value.sources.length, totalBytes, root: value.root }; });
        const completeSnapshot = await readJson<Snapshot>(this.env, job.manifest_key);
        const partitions = partitionBulkSnapshot(completeSnapshot);
        if (partitions.length > 1) {
          const width = Math.max(2, String(partitions.length).length);
          for (let index = 0; index < partitions.length; index += 1) {
            const partNumber = index + 1;
            const suffix = String(partNumber).padStart(width, "0");
            const childId = `${job.id}-p${suffix}`;
            const manifestKey = `_ltds/tmp-downloads/${completeSnapshot.shareId}/${job.id}/part-${suffix}.json`;
            const archiveKey = `_ltds/tmp-downloads/${completeSnapshot.shareId}/${job.id}/part-${suffix}.zip`;
            const part = partitions[index]!;
            await step.do(`spawn-part-${suffix}`, { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" } }, async () => {
              await this.env.DATA_BUCKET.put(manifestKey, JSON.stringify(part));
              await db(this.env).prepare(`INSERT OR IGNORE INTO bulk_download_jobs
                (id,share_id,share_version,request_json,status,manifest_key,archive_key,expires_at,parent_job_id,part_index,part_count,file_count,total_bytes)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
                childId, job.share_id, job.share_version, "{}", "queued", manifestKey, archiveKey,
                new Date(Date.now() + BULK_DOWNLOAD_RETENTION_MS).toISOString(), job.id, partNumber, partitions.length,
                part.sources.length, part.sources.reduce((total, source) => total + source.size, 0),
              ).run();
              try { await this.env.BULK_DOWNLOAD_WORKFLOW.create({ id: childId, params: { jobId: childId, prepared: true } }); }
              catch (error) {
                // A Workflow step can be retried after create() succeeded but
                // before its result was checkpointed. Verify the deterministic
                // instance instead of depending on provider error text.
                try {
                  const existing = await this.env.BULK_DOWNLOAD_WORKFLOW.get(childId);
                  const status = await existing.status();
                  if (status.status === "unknown") throw error;
                } catch {
                  throw error;
                }
              }
              return { childId, partNumber };
            });
          }
          await step.do("mark-split-download-running", async () => {
            await db(this.env).prepare("UPDATE bulk_download_jobs SET part_count=?,archive_size=NULL,updated_at=datetime('now') WHERE id=?").bind(partitions.length, job.id).run();
            // Retain the immutable parent snapshot until normal expiry so a
            // replay of the fan-out can still reconstruct its child identities.
            return { partCount: partitions.length };
          });
          return;
        }
      }
      const snap = await readJson<Snapshot>(this.env, job.manifest_key);
      assertBulkPreparationCapacity(snap);
      if (event.payload.prepared) {
        const totalBytes = snap.sources.reduce((total, source) => total + source.size, 0);
        await step.do("mark-prepared-part-running", async () => {
          await db(this.env).prepare("UPDATE bulk_download_jobs SET status='running',file_count=?,total_bytes=?,updated_at=datetime('now') WHERE id=?").bind(snap.sources.length, totalBytes, job.id).run();
          return { count: snap.sources.length, totalBytes };
        });
      }
      const resolution = await step.do("resolve-checksum-cache", async () => {
        const value = await resolveSnapshotChecksums(this.env, snap);
        await this.env.DATA_BUCKET.put(resolvedBulkManifestKey(job.manifest_key), JSON.stringify(value));
        return { fingerprint: value.fingerprint, cachedChecksums: value.sources.filter(source => source.crc32 !== undefined).length };
      });
      const resolved = await readJson<ResolvedSnapshot>(this.env, resolvedBulkManifestKey(job.manifest_key));
      if (resolved.fingerprint !== resolution.fingerprint) throw new Error("resolved-manifest-identity-mismatch");
      const cachedArchive = await step.do("reuse-completed-archive", async () => reuseCachedArchive(this.env, job, resolved));
      if (cachedArchive) {
        await step.do("mark-cached-archive-ready", async () => {
          const result = await db(this.env).prepare(`UPDATE bulk_download_jobs SET status='ready',archive_key=?,archive_fingerprint=?,
            archive_size=?,file_count=?,processed_files=?,total_bytes=?,processed_bytes=?,multipart_upload_id=NULL,
            expires_at=datetime('now','+7 days'),updated_at=datetime('now') WHERE id=? AND (
              status IN ('queued','running') OR (status='ready' AND archive_key=? AND archive_fingerprint=? AND archive_size=?)
            )`)
            .bind(cachedArchive.archive_key, resolved.fingerprint, cachedArchive.archive_size, cachedArchive.file_count,
              cachedArchive.file_count, cachedArchive.total_bytes, cachedArchive.total_bytes, job.id,
              cachedArchive.archive_key, resolved.fingerprint, cachedArchive.archive_size).run();
          if (!result.meta.changes) throw new Error("job-no-longer-active");
          return { status: "ready", cache: "hit" };
        });
        await step.sleep("cached-download-retention", BULK_DOWNLOAD_RETENTION_DURATION);
        await step.do("expire-cached-download", async () => {
          await this.env.DATA_BUCKET.delete([job.manifest_key, resolvedBulkManifestKey(job.manifest_key), finalBulkManifestKey(job.manifest_key)]);
          await db(this.env).prepare("UPDATE bulk_download_jobs SET status='expired',updated_at=datetime('now') WHERE id=? AND status='ready'").bind(job.id).run();
          return { status: "expired" };
        });
        return;
      }

      const plan = planOnePassZipMultipart(resolved.sources);
      if (plan.partCount > 10_000) throw new Error("multipart-part-limit");
      const archiveKey = bulkCacheArtifactKey(job.share_id, resolved.fingerprint, job.id);
      const upload = await step.do("create-one-pass-multipart-upload", async () => {
        const result = await this.env.DATA_BUCKET.createMultipartUpload(archiveKey, { httpMetadata: { contentType: "application/zip", contentDisposition: "attachment" } });
        await db(this.env).prepare(`UPDATE bulk_download_jobs SET archive_key=?,archive_fingerprint=?,multipart_upload_id=?,archive_size=?,
          updated_at=datetime('now') WHERE id=? AND status='running'`).bind(archiveKey, resolved.fingerprint, result.uploadId, plan.archiveSize, job.id).run();
        return { uploadId: result.uploadId };
      });
      const parts: Array<{ partNumber: number; etag: string }> = [];
      let state: OnePassZipState = initialOnePassZipState();
      for (let partNumber = 1; partNumber <= plan.prefixPartCount; partNumber += 1) {
        const result = await step.do(`write-one-pass-part-${partNumber}`, { retries: { limit: 4, delay: "10 seconds", backoff: "exponential" } }, async () => {
          const built = await buildOnePassZipPrefixPart(this.env.DATA_BUCKET, resolved.sources, state, plan.partSize);
          await persistCalculatedChecksums(this.env, resolved.sources, built.completedChecksums);
          const uploaded = await this.env.DATA_BUCKET.resumeMultipartUpload(archiveKey, upload.uploadId).uploadPart(partNumber, built.bytes);
          const totalBytes = resolved.sources.reduce((total, source) => total + source.size, 0);
          const progress = plan.prefixSize > 0 ? Math.min(totalBytes - 1, Math.floor(totalBytes * built.state.archiveOffset / plan.prefixSize)) : 0;
          await db(this.env).prepare(`UPDATE bulk_download_jobs SET processed_files=MAX(processed_files,?),processed_bytes=MAX(processed_bytes,?),
            updated_at=datetime('now') WHERE id=? AND status='running'`).bind(built.state.completedFiles, Math.max(0, progress), job.id).run();
          return { state: built.state, part: { partNumber: uploaded.partNumber, etag: uploaded.etag } };
        });
        state = result.state;
        parts.push(result.part);
      }
      const finalPartNumber = plan.prefixPartCount + 1;
      const finalPart = await step.do(`write-one-pass-part-${finalPartNumber}`, { retries: { limit: 4, delay: "10 seconds", backoff: "exponential" } }, async () => {
        const built = await buildOnePassZipPrefixPart(this.env.DATA_BUCKET, resolved.sources, state, plan.finalPrefixBytes);
        await persistCalculatedChecksums(this.env, resolved.sources, built.completedChecksums);
        if (built.state.stage !== "done" || built.state.archiveOffset !== plan.prefixSize) throw new Error("ZIP prefix did not finish at the planned boundary");
        const entries = await completedEntries(this.env, resolved);
        const manifest: FinalManifest = { root: resolved.root, entries, fileCount: entries.length, totalBytes: entries.reduce((total, source) => total + source.size, 0) };
        await this.env.DATA_BUCKET.put(finalBulkManifestKey(job.manifest_key), JSON.stringify(manifest));
        const trailer = buildOnePassZipTrailer(entries);
        if (trailer.length !== plan.trailerSize) throw new Error("ZIP trailer size changed");
        const bytes = joinZipBytes(built.bytes, trailer);
        if (bytes.length > plan.partSize || bytes.length !== plan.archiveSize - plan.prefixPartCount * plan.partSize) throw new Error("ZIP final part does not match the multipart plan");
        const uploaded = await this.env.DATA_BUCKET.resumeMultipartUpload(archiveKey, upload.uploadId).uploadPart(finalPartNumber, bytes);
        await db(this.env).prepare(`UPDATE bulk_download_jobs SET processed_files=file_count,processed_bytes=MAX(0,total_bytes-1),
          updated_at=datetime('now') WHERE id=? AND status='running'`).bind(job.id).run();
        return { part: { partNumber: uploaded.partNumber, etag: uploaded.etag } };
      });
      parts.push(finalPart.part);
      await step.do("complete-one-pass-multipart-upload", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => {
        let object = await this.env.DATA_BUCKET.head(archiveKey);
        if (!object || object.size !== plan.archiveSize) {
          object = await this.env.DATA_BUCKET.resumeMultipartUpload(archiveKey, upload.uploadId).complete(parts);
        }
        if (object.size !== plan.archiveSize) throw new Error("ZIP completed with an unexpected size");
        const persisted = await this.env.DELIVERY_DB.batch([
          this.env.DELIVERY_DB.prepare(`INSERT INTO bulk_download_archive_generations(archive_key,archive_etag,archive_size,state)
            VALUES(?,?,?,'active') ON CONFLICT(archive_key) DO UPDATE SET archive_etag=excluded.archive_etag,
              archive_size=excluded.archive_size WHERE bulk_download_archive_generations.state='active'`)
            .bind(archiveKey, object.etag, plan.archiveSize),
          this.env.DELIVERY_DB.prepare(`INSERT INTO bulk_download_archive_cache
          (share_id,share_version,selection_fingerprint,archive_key,archive_etag,archive_size,file_count,total_bytes,expires_at)
          VALUES (?,?,?,?,?,?,?,?,datetime('now','+30 days'))
          ON CONFLICT(share_id,share_version,selection_fingerprint) DO UPDATE SET archive_key=excluded.archive_key,
            archive_etag=excluded.archive_etag,archive_size=excluded.archive_size,file_count=excluded.file_count,total_bytes=excluded.total_bytes,
            expires_at=excluded.expires_at,last_used_at=datetime('now')`)
          .bind(job.share_id, job.share_version, resolved.fingerprint, archiveKey, object.etag, plan.archiveSize,
            resolved.sources.length, resolved.sources.reduce((total, source) => total + source.size, 0)),
        ]);
        if (!persisted[0]?.meta.changes || !persisted[1]?.meta.changes) throw new Error("archive-generation-not-active");
        return { archiveSize: plan.archiveSize, etag: object.etag };
      });
      await step.do("mark-ready", async () => {
        const result = await db(this.env).prepare(`UPDATE bulk_download_jobs SET status='ready',processed_files=file_count,
          processed_bytes=total_bytes,multipart_upload_id=NULL,expires_at=datetime('now','+7 days'),updated_at=datetime('now')
          WHERE id=? AND (status IN ('queued','running') OR
            (status='ready' AND archive_key=? AND archive_fingerprint=? AND archive_size=?))`)
          .bind(job.id, archiveKey, resolved.fingerprint, plan.archiveSize).run();
        if (!result.meta.changes) throw new Error("job-no-longer-active");
        return { status: "ready" };
      });
      await step.sleep("temporary-download-retention", BULK_DOWNLOAD_RETENTION_DURATION);
      await step.do("expire-temporary-download", async () => {
        await this.env.DATA_BUCKET.delete([job.manifest_key, resolvedBulkManifestKey(job.manifest_key), finalBulkManifestKey(job.manifest_key)]);
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
        const current = await db(this.env).prepare("SELECT archive_key,archive_fingerprint,multipart_upload_id FROM bulk_download_jobs WHERE id=?")
          .bind(job.id).first<{ archive_key: string; archive_fingerprint: string | null; multipart_upload_id: string | null }>();
        if (current?.multipart_upload_id) {
          try { await this.env.DATA_BUCKET.resumeMultipartUpload(current.archive_key, current.multipart_upload_id).abort(); } catch { /* already completed or absent */ }
        }
        await this.env.DATA_BUCKET.delete([
          // Once an archive has a fingerprint, another Workflow may already
          // have selected it for reuse without persisting its job reference.
          // Abort incomplete multipart state above, but leave any completed
          // generation to the protected >24-hour orphan sweep.
          ...(!current?.archive_fingerprint && current?.archive_key ? [current.archive_key] : []),
          job.manifest_key,
          resolvedBulkManifestKey(job.manifest_key),
          finalBulkManifestKey(job.manifest_key),
        ]);
        return { cleaned: true };
      });
      await step.do("mark-failed", async () => { await db(this.env).prepare("UPDATE bulk_download_jobs SET status='failed',error_code=?,error_message=?,updated_at=datetime('now') WHERE id=? AND status IN ('queued','running')").bind(failure.code, failure.message, job.id).run(); return { status: "failed" }; });
      throw error;
    }
  }
}
