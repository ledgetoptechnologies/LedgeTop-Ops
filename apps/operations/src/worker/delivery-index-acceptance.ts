import { mediaKind, mime } from "./delivery";

export interface DeliveryIndexObservation {
  key: string;
  revision: number;
  current: {
    providerVersion: string | null;
    notificationObservationVersion: string | null;
    etag: string;
    size: number;
    uploadedAt: string;
  } | null;
}

/** Read BEFORE HEAD/list observation, using the same primary D1 session as
 * acceptance. Tombstone revisions detect a racing create/remove even when
 * both snapshots appear absent. Migration 0206 is a caller readiness gate. */
export async function readDeliveryIndexObservation(
  db: D1DatabaseSession, key: string,
): Promise<DeliveryIndexObservation> {
  validKey(key);
  const row = await db.prepare(`SELECT revisions.revision,file_record.r2_key present_key,
      file_record.provider_version,file_record.notification_observation_version,file_record.etag,file_record.size,file_record.uploaded_at
    FROM delivery_file_index_revisions revisions
    LEFT JOIN file_index file_record ON file_record.r2_key=revisions.r2_key WHERE revisions.r2_key=?`)
    .bind(key).first<{ revision: number; present_key: string | null; provider_version: string | null;
      notification_observation_version: string | null; etag: string; size: number; uploaded_at: string }>();
  return { key, revision: row?.revision ?? 0, current: row?.present_key ? {
    providerVersion: row.provider_version, notificationObservationVersion: row.notification_observation_version,
    etag: row.etag, size: row.size, uploadedAt: row.uploaded_at,
  } : null };
}

function validKey(key: string): void {
  if (typeof key !== "string" || !key || new TextEncoder().encode(key).byteLength>1024)
    throw new Error("delivery-index-key-invalid");
}

function validSnapshot(snapshot: DeliveryIndexObservation): void {
  validKey(snapshot.key);
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision<0
    || snapshot.current && snapshot.revision===0) throw new Error("delivery-index-snapshot-invalid");
}

const REVISION_MATCH = `COALESCE((SELECT revision FROM delivery_file_index_revisions WHERE r2_key=?),0)=?`;

function storedUtcTime(value: string): number {
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value.replace(" ","T")}Z`);
}

/** Exactly one changed row is required by receipt acceptance. The observation
 * marker distinguishes an upload already indexed by upload/repair from an
 * upload already accepted for notification. Never execute this separately
 * from the receipt transaction; it is not a general file-index writer. */
export function prepareDeliveryIndexCreateAcceptance(
  db: D1DatabaseSession,
  snapshot: DeliveryIndexObservation,
  observed: Pick<R2Object, "key" | "version" | "httpEtag" | "size" | "uploaded">,
): D1PreparedStatement {
  validSnapshot(snapshot);
  if (observed.key!==snapshot.key || typeof observed.version!=="string" || !observed.version
    || observed.version.trim()!==observed.version || observed.version.length>512
    || typeof observed.httpEtag!=="string" || !observed.httpEtag
    || !Number.isSafeInteger(observed.size) || observed.size<0
    || !(observed.uploaded instanceof Date) || !Number.isFinite(observed.uploaded.getTime()))
    throw new Error("delivery-index-observation-invalid");
  if (snapshot.current?.providerVersion===observed.version
    && (snapshot.current.etag.replace(/^"|"$/g, "")!==observed.httpEtag.replace(/^"|"$/g, "")
      || snapshot.current.size!==observed.size || storedUtcTime(snapshot.current.uploadedAt)!==observed.uploaded.getTime()))
    throw new Error("delivery-index-provider-identity-conflict");
  const values = [observed.version,observed.version,observed.httpEtag,observed.size,
    observed.uploaded.toISOString(),mime(snapshot.key),mediaKind(snapshot.key)];
  if (snapshot.current) return db.prepare(`UPDATE file_index SET provider_version=?,notification_observation_version=?,
      etag=?,size=?,uploaded_at=?,content_type=?,media_kind=?,updated_at=datetime('now')
    WHERE r2_key=? AND ${REVISION_MATCH} AND notification_observation_version IS NOT ?`)
    .bind(...values,snapshot.key,snapshot.key,snapshot.revision,observed.version);
  return db.prepare(`INSERT INTO file_index
      (provider_version,notification_observation_version,etag,size,uploaded_at,content_type,media_kind,r2_key)
    SELECT ?,?,?,?,?,?,?,? WHERE ${REVISION_MATCH} AND NOT EXISTS(SELECT 1 FROM file_index WHERE r2_key=?)`)
    .bind(...values,snapshot.key,snapshot.key,snapshot.revision,snapshot.key);
}

/** Unknown legacy identity is not an attributable removal. The consumer must
 * apply its explicit legacy cleanup/no-notice policy instead of synthesizing
 * a provider version from an ETag or the current clock. */
export function prepareDeliveryIndexDeleteAcceptance(
  db: D1DatabaseSession, snapshot: DeliveryIndexObservation,
): D1PreparedStatement {
  validSnapshot(snapshot);
  if (!snapshot.current?.providerVersion) throw new Error("delivery-index-removal-identity-unavailable");
  if (snapshot.current.providerVersion.trim()!==snapshot.current.providerVersion || snapshot.current.providerVersion.length>512)
    throw new Error("delivery-index-removal-identity-invalid");
  return db.prepare(`DELETE FROM file_index WHERE r2_key=? AND provider_version=? AND etag=? AND ${REVISION_MATCH}`)
    .bind(snapshot.key,snapshot.current.providerVersion,snapshot.current.etag,snapshot.key,snapshot.revision);
}
