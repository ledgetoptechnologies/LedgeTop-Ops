/**
 * Additive, server-side promotion from immutable verified quarantine to the
 * TrueNAS rclone-ready prefix.  A ready journal entry records publication, not
 * a local pickup receipt: rclone MOVE is expected to remove that object.
 */
import { buildIncomingRcloneReadyPlan, type MultipartCopyPlan } from "./incoming-rclone-plan";
import { validateIncomingBasicSample } from "./incoming-basic-validation";
import type { IncomingEnv } from "./incoming";

const IDENTITY_VERSION = 1;

type SourceIdentity = { version: number; etag: string; bytes: number; objectVersion: string };
type StoredPart = { partNumber: number; etag: string };
export type PromotionState = "pending" | "copying" | "publishing" | "ready" | "unavailable" | "failed";

type JournalRow = {
  uploadId: string; sourceIdentity: string; sourceKey: string; destinationKey: string;
  multipartUploadId: string | null; partsJson: string; state: PromotionState;
  errorCode: string | null; publicationStartedAt: string | null; publishedAt: string | null;
  destinationEtag: string | null; destinationBytes: number | null; destinationVersion: string | null;
};
type EligibleUpload = {
  id: string; requestId: string; objectKey: string; originalName: string; contentType: string;
  status: string; verificationState: string; declaredBytes: number; actualEtag: string | null; actualBytes: number | null; revokedAt: string | null; expiresAt: string; retained: number;
};

export type IncomingPromotionStatus = {
  uploadId: string; sourceKey: string; destinationKey: string; state: PromotionState;
  completedParts: number; multipartUploadId: string | null; errorCode: string | null;
  /** A ready entry remains published even after a TrueNAS MOVE removes R2. */
  publicationStartedAt: string | null; publishedAt: string | null;
  destinationEtag: string | null; destinationBytes: number | null; destinationVersion: string | null;
};

function identity(row: EligibleUpload): SourceIdentity {
  const bytes = row.actualBytes;
  if (!row.actualEtag || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new Error("basic_object_identity_missing");
  }
  // The R2 version is added only after the basic validation HEAD.  It is not
  // malware/AV evidence and never changes verification_state.
  return { version: IDENTITY_VERSION, etag: row.actualEtag.toLowerCase(), bytes, objectVersion: "" };
}

function encodeIdentity(value: SourceIdentity): string { return JSON.stringify(value); }
function decodeIdentity(value: string): SourceIdentity {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object") throw new Error();
    const x = parsed as Partial<SourceIdentity>;
    const bytes = x.bytes;
    if (x.version !== IDENTITY_VERSION || typeof x.etag !== "string" || !/^[a-f0-9-]{1,128}$/i.test(x.etag)
      || typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes <= 0 || typeof x.objectVersion !== "string" || !x.objectVersion) throw new Error();
    return { version: x.version, etag: x.etag.toLowerCase(), bytes, objectVersion: x.objectVersion };
  } catch { throw new Error("promotion_journal_identity_invalid"); }
}
function decodeParts(value: string): StoredPart[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 10_000) throw new Error();
    const parts = parsed.map((part): StoredPart => {
      if (!part || typeof part !== "object") throw new Error();
      const x = part as Partial<StoredPart>;
      const partNumber = x.partNumber;
      if (typeof partNumber !== "number" || !Number.isInteger(partNumber) || partNumber < 1 || typeof x.etag !== "string" || !x.etag) throw new Error();
      return { partNumber, etag: x.etag };
    });
    if (new Set(parts.map(part => part.partNumber)).size !== parts.length) throw new Error();
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  } catch { throw new Error("promotion_journal_parts_invalid"); }
}
function status(row: JournalRow): IncomingPromotionStatus {
  return { uploadId: row.uploadId, sourceKey: row.sourceKey, destinationKey: row.destinationKey, state: row.state,
    completedParts: decodeParts(row.partsJson).length, multipartUploadId: row.multipartUploadId, errorCode: row.errorCode,
    publicationStartedAt: row.publicationStartedAt, publishedAt: row.publishedAt,
    destinationEtag: row.destinationEtag, destinationBytes: row.destinationBytes, destinationVersion: row.destinationVersion };
}
function sameObject(object: R2Object, expected: SourceIdentity): boolean {
  return object.size === expected.bytes && object.etag.toLowerCase() === expected.etag && object.version === expected.objectVersion;
}
function r2Body(object: R2ObjectBody | R2Object | null): R2ObjectBody | null {
  return object && "body" in object ? object : null;
}
function hasExactRange(range: R2Range | undefined, offset: number, length: number): boolean {
  return !!range && "offset" in range && "length" in range && range.offset === offset && range.length === length;
}
async function readSmallBody(body: ReadableStream<Uint8Array>, expectedBytes: number): Promise<Uint8Array> {
  const reader = body.getReader(); const result = new Uint8Array(expectedBytes); let used = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (used + chunk.value.byteLength > expectedBytes) throw new Error("basic_sample_wrong_length");
      result.set(chunk.value, used); used += chunk.value.byteLength;
    }
  } finally { reader.releaseLock(); }
  if (used !== expectedBytes) throw new Error("basic_sample_wrong_length");
  return result;
}
function errorCode(error: unknown): string {
  const value = error instanceof Error ? error.message : "promotion_r2_error";
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value) ? value.toLowerCase() : "promotion_r2_error";
}

async function journal(db: D1Database, uploadId: string): Promise<JournalRow | null> {
  return db.withSession("first-primary").prepare(`SELECT upload_id uploadId,source_identity sourceIdentity,source_key sourceKey,destination_key destinationKey,
    multipart_upload_id multipartUploadId,parts_json partsJson,state,error_code errorCode,publication_started_at publicationStartedAt,published_at publishedAt
    ,destination_etag destinationEtag,destination_bytes destinationBytes,destination_version destinationVersion
    FROM file_request_upload_promotion_journal WHERE upload_id=?`).bind(uploadId).first<JournalRow>();
}
function destinationBindsSource(object: R2Object, source: SourceIdentity): boolean {
  const metadata = object.customMetadata;
  return object.size === source.bytes && metadata?.["promotion-source-etag"] === source.etag
    && metadata["promotion-source-version"] === source.objectVersion && metadata["promotion-source-bytes"] === String(source.bytes);
}
async function recoverPublishing(env: IncomingEnv, row: JournalRow): Promise<JournalRow> {
  const source = decodeIdentity(row.sourceIdentity);
  const object = await env.INCOMING_BUCKET.head(row.destinationKey);
  // A present, metadata-bound object confirms publication. A missing object is
  // deliberately not treated as delivery: rclone MOVE and a failed completion
  // response are observationally indistinguishable.
  if (object && destinationBindsSource(object, source)) {
    await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_journal SET state='ready',published_at=COALESCE(published_at,datetime('now')),
      destination_etag=?,destination_bytes=?,destination_version=?,error_code=NULL,updated_at=datetime('now') WHERE upload_id=? AND state='publishing'`)
      .bind(object.etag.toLowerCase(), object.size, object.version, row.uploadId).run();
  }
  return (await journal(env.DELIVERY_DB, row.uploadId))!;
}
async function basicCheck(db: D1Database, uploadId: string): Promise<SourceIdentity | null> {
  const row = await db.withSession("first-primary").prepare(`SELECT object_etag etag,object_bytes bytes,object_version objectVersion
    FROM file_request_upload_basic_checks WHERE upload_id=?`).bind(uploadId).first<{ etag: string; bytes: number; objectVersion: string }>();
  if (!row || !row.etag || !Number.isSafeInteger(row.bytes) || row.bytes <= 0 || !row.objectVersion) return null;
  return { version: IDENTITY_VERSION, etag: row.etag.toLowerCase(), bytes: row.bytes, objectVersion: row.objectVersion };
}
async function eligible(db: D1Database, uploadId: string): Promise<EligibleUpload | null> {
  return db.withSession("first-primary").prepare(`SELECT u.id,u.request_id requestId,u.object_key objectKey,u.original_name originalName,u.content_type contentType,
    u.status,u.verification_state verificationState,u.declared_size declaredBytes,u.etag actualEtag,u.actual_size actualBytes,r.revoked_at revokedAt,r.expires_at expiresAt,
    CASE WHEN datetime(u.created_at,'+14 days')>datetime('now') THEN 1 ELSE 0 END retained
    FROM file_request_uploads u JOIN file_requests r ON r.id=u.request_id WHERE u.id=?`).bind(uploadId).first<EligibleUpload>();
}
async function noteRetry(env: IncomingEnv, uploadId: string, code: string): Promise<void> {
  await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_journal SET error_code=?,updated_at=datetime('now')
    WHERE upload_id=? AND state IN ('pending','copying')`).bind(code, uploadId).run();
}
function requestIsActive(row: EligibleUpload): boolean {
  const expiry = Date.parse(row.expiresAt);
  return row.retained === 1 && row.revokedAt === null && Number.isFinite(expiry) && expiry > Date.now();
}
async function mark(env: IncomingEnv, uploadId: string, state: "unavailable" | "failed", code: string): Promise<JournalRow> {
  await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_journal SET state=?,error_code=?,updated_at=datetime('now')
    WHERE upload_id=? AND state IN ('pending','copying')`).bind(state, code, uploadId).run();
  const row = await journal(env.DELIVERY_DB, uploadId);
  if (!row) throw new Error("promotion_journal_missing");
  return row;
}
async function guard(env: IncomingEnv, row: JournalRow): Promise<{ row: EligibleUpload; identity: SourceIdentity } | null> {
  const upload = await eligible(env.DELIVERY_DB, row.uploadId);
  if (!upload || upload.status !== "quarantined" || upload.verificationState === "rejected" || !requestIsActive(upload)) {
    await mark(env, row.uploadId, "unavailable", "promotion_not_eligible"); return null;
  }
  const expected = decodeIdentity(row.sourceIdentity);
  const basic = await basicCheck(env.DELIVERY_DB, row.uploadId);
  if (!basic || encodeIdentity(basic) !== encodeIdentity(expected)) {
    await mark(env, row.uploadId, "unavailable", "basic_check_missing_or_changed"); return null;
  }
  let proof: SourceIdentity;
  try { proof = identity(upload); } catch { await mark(env, row.uploadId, "unavailable", "basic_object_identity_missing"); return null; }
  if (proof.etag !== expected.etag || proof.bytes !== expected.bytes || upload.objectKey !== row.sourceKey) {
    await mark(env, row.uploadId, "unavailable", "verified_object_changed"); return null;
  }
  const object = await env.INCOMING_BUCKET.head(row.sourceKey);
  if (!object || !sameObject(object, expected)) { await mark(env, row.uploadId, "unavailable", "quarantine_object_changed"); return null; }
  return { row: upload, identity: expected };
}

/** Creates a durable, source-identity-fenced journal entry; it never reads bytes. */
export async function beginIncomingRclonePromotion(env: IncomingEnv, uploadId: string): Promise<IncomingPromotionStatus> {
  const current = await journal(env.DELIVERY_DB, uploadId);
  if (current) return status(current);
  const upload = await eligible(env.DELIVERY_DB, uploadId);
  if (!upload || upload.status !== "quarantined" || upload.verificationState === "rejected" || !requestIsActive(upload)) {
    throw new Error("promotion_not_eligible");
  }
  const basicIdentity = identity(upload);
  const object = await env.INCOMING_BUCKET.head(upload.objectKey);
  const source = { ...basicIdentity, objectVersion: object?.version ?? "" };
  if (!object || !source.objectVersion || !sameObject(object, source) || upload.declaredBytes !== source.bytes) throw new Error("quarantine_object_changed");
  const plan = buildIncomingRcloneReadyPlan({ requestId: upload.requestId, uploadId: upload.id, originalName: upload.originalName, sourceBytes: source.bytes, transferMode: "move" });
  if (upload.objectKey !== plan.sourceKey) throw new Error("quarantine_key_noncanonical");
  const sampleLength = Math.min(4096, source.bytes);
  const sampleObject = r2Body(await env.INCOMING_BUCKET.get(upload.objectKey, { range: { offset: 0, length: sampleLength }, onlyIf: { etagMatches: source.etag } }));
  if (!sampleObject || !sameObject(sampleObject, source) || !hasExactRange(sampleObject.range, 0, sampleLength)) throw new Error("quarantine_object_changed");
  const basic = validateIncomingBasicSample({ originalName: upload.originalName, contentType: upload.contentType, declaredBytes: upload.declaredBytes,
    expected: { objectEtag: source.etag, objectBytes: source.bytes, objectVersion: source.objectVersion },
    observed: { objectEtag: sampleObject.etag.toLowerCase(), objectBytes: sampleObject.size, objectVersion: sampleObject.version },
    sample: await readSmallBody(sampleObject.body, sampleLength),
  });
  try {
    await env.DELIVERY_DB.batch([
      env.DELIVERY_DB.prepare(`INSERT INTO file_request_upload_basic_checks(upload_id,object_etag,object_bytes,object_version,check_version)
        VALUES(?,?,?,?,?) ON CONFLICT(upload_id) DO UPDATE SET object_etag=excluded.object_etag,object_bytes=excluded.object_bytes,object_version=excluded.object_version,check_version=excluded.check_version,checked_at=datetime('now')`)
        .bind(upload.id, basic.objectEtag, basic.objectBytes, basic.objectVersion, basic.checkVersion),
      env.DELIVERY_DB.prepare(`INSERT INTO file_request_upload_promotion_journal(upload_id,source_identity,source_key,destination_key,state)
        VALUES(?,?,?,?, 'pending')`).bind(upload.id, encodeIdentity({ version: IDENTITY_VERSION, etag: basic.objectEtag.toLowerCase(), bytes: basic.objectBytes, objectVersion: basic.objectVersion }), plan.sourceKey, plan.readyKey),
    ]);
  } catch {
    // A concurrent begin can win the unique upload row; return its exact journal.
  }
  const created = await journal(env.DELIVERY_DB, uploadId);
  if (!created) throw new Error("promotion_journal_create_failed");
  return status(created);
}

/** One bounded operation: create, upload exactly one part, or publish exactly once. */
export async function resumeIncomingRclonePromotionStep(env: IncomingEnv, uploadId: string): Promise<IncomingPromotionStatus> {
  let row = await journal(env.DELIVERY_DB, uploadId);
  if (!row) return beginIncomingRclonePromotion(env, uploadId);
  // Publishing is deliberately terminal until an operator resolves it. R2 can
  // complete a multipart request while its response is lost, and rclone MOVE
  // can delete the ready object before recovery observes it. Replaying would
  // release the same quarantined file twice.
  if (row.state === "publishing") return status(await recoverPublishing(env, row));
  if (row.state === "ready" || row.state === "unavailable" || row.state === "failed") return status(row);
  const checked = await guard(env, row);
  if (!checked) return status((await journal(env.DELIVERY_DB, uploadId))!);
  const plan = buildIncomingRcloneReadyPlan({ requestId: checked.row.requestId, uploadId, originalName: checked.row.originalName, sourceBytes: checked.identity.bytes, transferMode: "move" });
  if (row.state === "pending") {
    try {
      const multipart = await env.INCOMING_BUCKET.createMultipartUpload(row.destinationKey, { httpMetadata: { contentType: checked.row.contentType }, customMetadata: {
        "promotion-source-etag": checked.identity.etag, "promotion-source-version": checked.identity.objectVersion, "promotion-source-bytes": String(checked.identity.bytes),
      } });
      const saved = await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_journal SET state='copying',multipart_upload_id=?,error_code=NULL,updated_at=datetime('now')
        WHERE upload_id=? AND state='pending' AND multipart_upload_id IS NULL`).bind(multipart.uploadId, uploadId).run();
      if (!saved.meta.changes) await multipart.abort().catch(() => undefined);
    } catch (error) { await noteRetry(env, uploadId, errorCode(error)); }
    return status((await journal(env.DELIVERY_DB, uploadId))!);
  }
  const parts = decodeParts(row.partsJson);
  if (parts.length < plan.multipartCopy.partCount) {
    const partNumber = parts.length + 1;
    const offset = (partNumber - 1) * plan.multipartCopy.partBytes;
    const length = partNumber === plan.multipartCopy.partCount ? plan.multipartCopy.lastPartBytes : plan.multipartCopy.partBytes;
    try {
      const source = r2Body(await env.INCOMING_BUCKET.get(row.sourceKey, { range: { offset, length }, onlyIf: { etagMatches: checked.identity.etag } }));
      if (!source || !sameObject(source, checked.identity) || !hasExactRange(source.range, offset, length)) throw new Error("quarantine_object_changed");
      // R2 multipart requires a known-length stream. FixedLengthStream keeps
      // this range copy streaming; it does not materialize a whole part.
      const body = source.body.pipeThrough(new FixedLengthStream(length));
      const uploaded = await env.INCOMING_BUCKET.resumeMultipartUpload(row.destinationKey, row.multipartUploadId!).uploadPart(partNumber, body);
      await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_journal SET parts_json=?,error_code=NULL,updated_at=datetime('now')
        WHERE upload_id=? AND state='copying' AND multipart_upload_id=? AND parts_json=?`).bind(JSON.stringify([...parts, { partNumber: uploaded.partNumber, etag: uploaded.etag }]), uploadId, row.multipartUploadId, row.partsJson).run();
    } catch (error) { errorCode(error) === "quarantine_object_changed" ? await mark(env, uploadId, "unavailable", "quarantine_object_changed") : await noteRetry(env, uploadId, errorCode(error)); }
    return status((await journal(env.DELIVERY_DB, uploadId))!);
  }
  // Commit an *uncertain* publication fence before complete. If complete
  // succeeds but this Worker dies before a follow-up write, TrueNAS MOVE can
  // remove the object immediately; this prevents a second release. Only the
  // post-complete D1 update may call the state ready.
  const fence = await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_journal SET state='publishing',publication_started_at=datetime('now'),error_code=NULL,updated_at=datetime('now')
    WHERE upload_id=? AND state='copying' AND multipart_upload_id=? AND parts_json=?
      AND EXISTS (SELECT 1 FROM file_request_uploads u JOIN file_requests r ON r.id=u.request_id
        WHERE u.id=? AND u.status='quarantined' AND u.verification_state<>'rejected' AND r.revoked_at IS NULL AND datetime(r.expires_at)>datetime('now')
          AND datetime(u.created_at,'+14 days')>datetime('now'))`)
    .bind(uploadId, row.multipartUploadId, row.partsJson, uploadId).run();
  if (!fence.meta.changes) return status((await journal(env.DELIVERY_DB, uploadId))!);
  try {
    const destination = await env.INCOMING_BUCKET.resumeMultipartUpload(row.destinationKey, row.multipartUploadId!).complete(parts);
    await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_journal SET state='ready',published_at=COALESCE(published_at,datetime('now')),updated_at=datetime('now')
      ,destination_etag=?,destination_bytes=?,destination_version=? WHERE upload_id=? AND state='publishing'`)
      .bind(destination.etag.toLowerCase(), destination.size, destination.version, uploadId).run();
  } catch (error) {
    // Do not change publishing back to a retryable state: the provider may
    // have completed the upload despite a lost response, and rclone may have
    // moved it. readStatus exposes this actionable uncertain state.
    await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_journal SET error_code=?,updated_at=datetime('now')
      WHERE upload_id=? AND state='publishing'`).bind(errorCode(error), uploadId).run();
    console.error(JSON.stringify({ event: "incoming_promotion_complete_ambiguous", uploadId, errorCode: errorCode(error) }));
  }
  return status((await journal(env.DELIVERY_DB, uploadId))!);
}

export async function readIncomingRclonePromotionStatus(env: IncomingEnv, uploadId: string): Promise<IncomingPromotionStatus | null> {
  const row = await journal(env.DELIVERY_DB, uploadId);
  return row ? status(row) : null;
}

/** Workflow retry exhaustion may stop only pre-publication work. It must never
 * rewrite publishing (ambiguous), ready (published), or unavailable state. */
export async function markIncomingRclonePromotionExhausted(env: IncomingEnv, uploadId: string): Promise<IncomingPromotionStatus | null> {
  await env.DELIVERY_DB.prepare(`UPDATE file_request_upload_promotion_journal SET state='failed',error_code='retry_exhausted',updated_at=datetime('now')
    WHERE upload_id=? AND state IN ('pending','copying')`).bind(uploadId).run();
  return readIncomingRclonePromotionStatus(env, uploadId);
}

export function incomingPromotionMultipartPlanForTest(sourceBytes: number): MultipartCopyPlan {
  return buildIncomingRcloneReadyPlan({ requestId: "request_123", uploadId: "upload_456", originalName: "file.bin", sourceBytes, transferMode: "move" }).multipartCopy;
}
