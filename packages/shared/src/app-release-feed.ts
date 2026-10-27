/** Shared validation and immutable-artifact reads for the Windows app feed. */

export type AppReleaseCatalogRow = {
  release_id: string;
  platform: "windows";
  channel: "pilot";
  version: string;
  version_major: number;
  version_minor: number;
  version_patch: number;
  version_revision: number;
  installer_type: "exe";
  artifact_key: string;
  size_bytes: number;
  sha256: string;
  strong_etag: string;
  source_commit: string;
  min_supported: string | null;
  notes: string | null;
};

export type AppReleaseControl = { enabled: number; storage_accepted: number };

export class AppReleaseFeedError extends Error {
  constructor(readonly status: 404 | 409 | 412 | 416 | 428 | 503, readonly code: string) {
    super(code);
  }
}

const hex = (bytes: ArrayBuffer | undefined): string | null => bytes
  ? Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("")
  : null;
const sha256Pattern = /^[0-9a-f]{64}$/;
const sourceCommitPattern = /^[0-9a-f]{40}$/;
const strongETagPattern = /^"[\x21\x23-\x7e]*"$/;
// Match the Unicode whitespace used by System.Char.IsWhiteSpace/Trim rather
// than JavaScript's slightly different String.trim set (notably U+0085/U+FEFF).
const dotNetTrimBoundary = /^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;

function validOptionalNativeText(value: string | null, maximum: number): boolean {
  return value === null || typeof value === "string" && value.length > 0 && value.length <= maximum
    && !dotNetTrimBoundary.test(value) && !/\p{Cc}/u.test(value);
}

export function parseCanonicalWindowsAppVersion(value: unknown): [number, number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = /^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some(part => part > 65535)) return null;
  return parts as [number, number, number, number];
}

function validCatalogRow(value: AppReleaseCatalogRow): boolean {
  const parts = parseCanonicalWindowsAppVersion(value.version);
  return !!parts && value.platform === "windows" && value.channel === "pilot"
    && parts.every((part, index) => part === [value.version_major, value.version_minor, value.version_patch, value.version_revision][index])
    && value.installer_type === "exe" && typeof value.release_id === "string" && value.release_id.length > 0
    && typeof value.artifact_key === "string" && value.artifact_key.length > 0 && value.artifact_key.length <= 512
    && !value.artifact_key.includes("..") && !/[\u0000-\u001f\u007f]/.test(value.artifact_key)
    && Number.isSafeInteger(value.size_bytes) && value.size_bytes >= 1 && value.size_bytes <= 1073741824
    && sha256Pattern.test(value.sha256) && strongETagPattern.test(value.strong_etag) && value.strong_etag.length <= 512
    && sourceCommitPattern.test(value.source_commit)
    && validOptionalNativeText(value.min_supported, 120)
    && validOptionalNativeText(value.notes, 600);
}

/** R2 checksums are provider verified at write time; HTTP ETag remains a
 * separate strong version token and is never assumed to be a SHA-256. */
export function appReleaseObjectMatches(object: R2Object | R2ObjectBody, release: AppReleaseCatalogRow): boolean {
  const metadata = object.customMetadata;
  return validCatalogRow(release) && object.key === release.artifact_key && object.size === release.size_bytes
    && object.httpEtag === release.strong_etag && strongETagPattern.test(object.httpEtag) && !object.httpEtag.startsWith("W/")
    && hex(object.checksums.sha256) === release.sha256
    && metadata?.appReleaseVersion === release.version
    && metadata?.sourceCommit === release.source_commit
    && metadata?.installerType === release.installer_type
    && metadata?.sha256 === release.sha256;
}

export async function readAppReleaseControl(database: D1Database): Promise<AppReleaseControl> {
  let row: AppReleaseControl | null;
  try {
    row = await database.withSession("first-primary").prepare(
      "SELECT enabled,storage_accepted FROM app_release_control WHERE singleton=1",
    ).first<AppReleaseControl>();
  } catch {
    throw new AppReleaseFeedError(503, "app_release_configuration_unavailable");
  }
  if (!row || ![0, 1].includes(row.enabled) || ![0, 1].includes(row.storage_accepted)
    || row.enabled === 1 && row.storage_accepted !== 1) {
    throw new AppReleaseFeedError(503, "app_release_configuration_unavailable");
  }
  return row;
}

async function readCatalogRow(database: D1Database, version?: string): Promise<AppReleaseCatalogRow | null> {
  const versionClause = version === undefined ? "h.release_id=r.release_id" : "r.version=?";
  const query = `SELECT r.release_id,r.platform,r.channel,r.version,r.version_major,r.version_minor,
      r.version_patch,r.version_revision,r.installer_type,r.artifact_key,r.size_bytes,r.sha256,
      r.strong_etag,r.source_commit,r.min_supported,r.notes
    FROM app_release_catalog r ${version === undefined ? "JOIN app_release_head h ON h.platform=r.platform AND h.channel=r.channel" : ""}
    WHERE ${versionClause} AND r.platform='windows' AND r.channel='pilot'
      AND NOT EXISTS(SELECT 1 FROM app_release_withdrawals w WHERE w.release_id=r.release_id)
    LIMIT 2`;
  let result: { results: AppReleaseCatalogRow[] };
  try {
    const statement = database.withSession("first-primary").prepare(query);
    result = await (version === undefined ? statement : statement.bind(version)).all<AppReleaseCatalogRow>();
  } catch {
    throw new AppReleaseFeedError(503, "app_release_catalog_unavailable");
  }
  if (result.results.length > 1) throw new AppReleaseFeedError(503, "app_release_catalog_ambiguous");
  const row = result.results[0] ?? null;
  if (row && !validCatalogRow(row)) throw new AppReleaseFeedError(503, "app_release_catalog_invalid");
  return row;
}

async function readAndVerifyObject(bucket: R2Bucket | undefined, release: AppReleaseCatalogRow): Promise<R2Object> {
  if (!bucket) throw new AppReleaseFeedError(503, "app_release_storage_unavailable");
  let object: R2Object | null;
  try { object = await bucket.head(release.artifact_key); }
  catch { throw new AppReleaseFeedError(503, "app_release_storage_unavailable"); }
  if (!object || !appReleaseObjectMatches(object, release)) throw new AppReleaseFeedError(409, "app_release_artifact_mismatch");
  return object;
}

export async function readLatestAppRelease(
  database: D1Database,
  bucket: R2Bucket | undefined,
): Promise<AppReleaseCatalogRow | null> {
  const control = await readAppReleaseControl(database);
  if (control.enabled !== 1) return null;
  // A head which points to a withdrawn or malformed record is a broken release
  // control state, not an ordinary no-offer result.
  let head: { release_id: string } | null;
  try {
    head = await database.withSession("first-primary").prepare(
      "SELECT release_id FROM app_release_head WHERE platform='windows' AND channel='pilot' LIMIT 2",
    ).first<{ release_id: string }>();
  } catch { throw new AppReleaseFeedError(503, "app_release_catalog_unavailable"); }
  if (!head) return null;
  const row = await readCatalogRow(database);
  if (!row || row.release_id !== head.release_id) throw new AppReleaseFeedError(409, "app_release_head_unavailable");
  await readAndVerifyObject(bucket, row);
  return row;
}

export async function readAppReleaseVersion(
  database: D1Database,
  bucket: R2Bucket | undefined,
  version: string,
): Promise<AppReleaseCatalogRow> {
  if (!parseCanonicalWindowsAppVersion(version)) throw new AppReleaseFeedError(404, "app_release_unavailable");
  const control = await readAppReleaseControl(database);
  if (control.enabled !== 1) throw new AppReleaseFeedError(404, "app_release_unavailable");
  const row = await readCatalogRow(database, version);
  if (!row) throw new AppReleaseFeedError(404, "app_release_unavailable");
  await readAndVerifyObject(bucket, row);
  return row;
}

export function nativeWindowsAppOffer(release: AppReleaseCatalogRow, base: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    available: true,
    platform: "windows",
    channel: "pilot",
    version: release.version,
    sizeBytes: release.size_bytes,
    sha256: release.sha256,
    strongETag: release.strong_etag,
    sourceCommit: release.source_commit,
    installerType: "exe",
    downloadUrl: `${base}/download/${release.version}?platform=windows&channel=pilot`,
    ...(release.min_supported === null ? {} : { minSupported: release.min_supported }),
    ...(release.notes === null ? {} : { notes: release.notes }),
  };
}

/** Compatibility shape consumed by the existing browser Get the app dialog. */
export function legacyWindowsAppOffer(release: AppReleaseCatalogRow, base: string): Record<string, unknown> {
  return {
    available: true,
    platform: "windows",
    channel: "pilot",
    version: release.version,
    size: release.size_bytes,
    sha256: release.sha256,
    downloadUrl: `${base}/download/${release.version}?platform=windows&channel=pilot`,
    ...(release.min_supported === null ? {} : { minSupported: release.min_supported }),
    ...(release.notes === null ? {} : { notes: release.notes }),
  };
}

export type AppByteRange = { start: number; end: number; length: number };

export function parseAppByteRange(value: string, size: number): AppByteRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2]) return null;
  let start: number, end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
    end = Math.min(end, size - 1);
  }
  return { start, end, length: end - start + 1 };
}

function downloadHeaders(release: AppReleaseCatalogRow, length: number, partial: AppByteRange | null): Headers {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, no-store",
    "Cloudflare-CDN-Cache-Control": "no-store",
    "Content-Length": String(length),
    "Content-Type": "application/octet-stream",
    "ETag": release.strong_etag,
    "X-Content-Type-Options": "nosniff",
  });
  if (partial) headers.set("Content-Range", `bytes ${partial.start}-${partial.end}/${release.size_bytes}`);
  return headers;
}

function exactLengthStream(body: ReadableStream<Uint8Array>, expected: number): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          if (total !== expected) throw new Error("app_release_body_length_mismatch");
          controller.close();
          return;
        }
        if (!(next.value instanceof Uint8Array)) throw new Error("app_release_body_invalid");
        total += next.value.byteLength;
        if (total > expected) throw new Error("app_release_body_length_mismatch");
        controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
        await reader.cancel(error).catch(() => {});
      }
    },
    cancel(reason) { void reader.cancel(reason).catch(() => {}); },
  }, { highWaterMark: 0 });
}

export async function serveAppReleaseBytes(
  request: Request,
  bucket: R2Bucket | undefined,
  release: AppReleaseCatalogRow,
  beforeBody?: () => Promise<void>,
): Promise<Response> {
  const ifMatch = request.headers.get("If-Match");
  const rangeHeader = request.headers.get("Range");
  const ifRange = request.headers.get("If-Range");
  if (ifMatch !== null && ifMatch !== release.strong_etag)
    throw new AppReleaseFeedError(412, "app_release_version_changed");
  // Browser download links are ordinary authenticated GET/HEAD requests and
  // cannot attach If-Match. Range/resume requests remain conditional so a
  // stale partial is never mixed with a different immutable artifact.
  if (rangeHeader !== null && ifMatch === null)
    throw new AppReleaseFeedError(428, "app_release_if_match_required");
  if (rangeHeader !== null && ifRange === null)
    throw new AppReleaseFeedError(428, "app_release_if_range_required");
  if (rangeHeader !== null && ifRange !== release.strong_etag)
    throw new AppReleaseFeedError(412, "app_release_version_changed");
  const partial = rangeHeader !== null ? parseAppByteRange(rangeHeader, release.size_bytes) : null;
  if (rangeHeader !== null && !partial) {
    return new Response(null, { status: 416, headers: new Headers({
      "Accept-Ranges": "bytes", "Cache-Control": "private, no-store",
      "Cloudflare-CDN-Cache-Control": "no-store", "Content-Range": `bytes */${release.size_bytes}`,
      "Content-Length": "0", "ETag": release.strong_etag, "X-Content-Type-Options": "nosniff",
    }) });
  }
  const object = await readAndVerifyObject(bucket, release);
  if (beforeBody) await beforeBody();
  if (request.method === "HEAD") return new Response(null, { status: partial ? 206 : 200,
    headers: downloadHeaders(release, partial?.length ?? release.size_bytes, partial) });
  if (!bucket) throw new AppReleaseFeedError(503, "app_release_storage_unavailable");
  let result: R2ObjectBody | R2Object | null;
  try {
    result = await bucket.get(release.artifact_key, {
      // R2 Conditional.etagMatches takes the opaque value without HTTP quotes.
      onlyIf: { etagMatches: object.httpEtag.slice(1, -1) },
      ...(partial ? { range: { offset: partial.start, length: partial.length } } : {}),
    });
  } catch { throw new AppReleaseFeedError(503, "app_release_storage_unavailable"); }
  if (!result || !("body" in result) || !appReleaseObjectMatches(result, release))
    throw new AppReleaseFeedError(409, "app_release_artifact_mismatch");
  if (partial) {
    const actualRange = result.range;
    if (!actualRange || !("offset" in actualRange) || actualRange.offset !== partial.start
      || !("length" in actualRange) || actualRange.length !== partial.length)
      throw new AppReleaseFeedError(409, "app_release_range_mismatch");
  }
  const status = partial ? 206 : 200;
  return new Response(exactLengthStream(result.body as ReadableStream<Uint8Array>, partial?.length ?? release.size_bytes), {
    status, headers: downloadHeaders(release, partial?.length ?? release.size_bytes, partial),
  });
}
