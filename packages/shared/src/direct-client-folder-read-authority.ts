/** Private Operations proof for a current native direct-folder file read. */
export const DIRECT_CLIENT_FOLDER_READ_PROTOCOL = "direct-client-folder-read" as const;
export const DIRECT_CLIENT_FOLDER_READ_MAX_BYTES = 16_384;
export type DirectClientFolderReadRequest = Readonly<{
  protocolVersion: 1; requestId: string; grantId: string; grantVersion: number; workspaceId: string;
  targetId: string; clientAuthorityId: string; sourceId: "project-alpha:primary";
  recipientRecordId: string; issuer: string; subject: string; folderRef: string;
}>;
export type DirectClientFolderReadResult =
  | Readonly<{ ok: true; protocolVersion: 1; requestId: string; requestSha256: string; observedAt: string;
      authorization: Readonly<{ workspaceId: string; targetId: string; targetRevision: number; clientAuthorityId: string;
        sourceId: "project-alpha:primary"; recipientRecordId: string; grantId: string; grantVersion: number; folderRef: string;
        publicationRevision: number; snapshotId: string; snapshotSha256: string; currentRecipientRecordId: string;
        currentRecipientProfileVersion: number; currentRecipientRelationshipVersion: number | null }> }>
  | Readonly<{ ok: false; protocolVersion: 1; code: "invalid" | "denied" | "unavailable" | "disabled" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const B64URL = /^[A-Za-z0-9_-]{2,1400}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return names.every(key => typeof key === "string" && descriptors[key]?.enumerable && "value" in descriptors[key]!)
    ? value as Record<string, unknown> : null;
}
const text = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max
  && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
export function parseDirectClientFolderReadRequest(value: unknown): DirectClientFolderReadRequest | null {
  const row = exact(value, ["protocolVersion", "requestId", "grantId", "grantVersion", "workspaceId", "targetId",
    "clientAuthorityId", "sourceId", "recipientRecordId", "issuer", "subject", "folderRef"]);
  if (!row || row.protocolVersion !== 1 || !UUID.test(String(row.requestId)) || !UUID.test(String(row.grantId))
    || !Number.isSafeInteger(row.grantVersion) || Number(row.grantVersion) < 1 || !text(row.workspaceId, 200)
    || !UUID.test(String(row.targetId)) || !UUID.test(String(row.clientAuthorityId))
    || row.sourceId !== "project-alpha:primary" || !text(row.recipientRecordId, 200)
    || !text(row.issuer, 512) || !text(row.subject, 512) || typeof row.folderRef !== "string" || !B64URL.test(row.folderRef)) return null;
  return row as unknown as DirectClientFolderReadRequest;
}
export function canonicalDirectClientFolderReadRequest(value: DirectClientFolderReadRequest): string {
  return JSON.stringify({ protocolVersion: value.protocolVersion, requestId: value.requestId, grantId: value.grantId,
    grantVersion: value.grantVersion, workspaceId: value.workspaceId, targetId: value.targetId,
    clientAuthorityId: value.clientAuthorityId, sourceId: value.sourceId, recipientRecordId: value.recipientRecordId,
    issuer: value.issuer, subject: value.subject, folderRef: value.folderRef });
}
export async function hashDirectClientFolderReadRequest(value: DirectClientFolderReadRequest): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(canonicalDirectClientFolderReadRequest(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export const sha256DirectClientFolderReadRequest = hashDirectClientFolderReadRequest;
export function parseDirectClientFolderReadResult(value: unknown): DirectClientFolderReadResult | null {
  if (typeof value !== "string" || !value) return null;
  try {
    if (encoder.encode(value).byteLength > DIRECT_CLIENT_FOLDER_READ_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(value);
    if (JSON.stringify(parsed) !== value || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (row.ok === false) {
      const failure = exact(row, ["ok", "protocolVersion", "code"]);
      return failure && failure.protocolVersion === 1 && ["invalid", "denied", "unavailable", "disabled"].includes(String(failure.code))
        ? failure as unknown as DirectClientFolderReadResult : null;
    }
    const success = exact(row, ["ok", "protocolVersion", "requestId", "requestSha256", "observedAt", "authorization"]);
    const authorization = success && exact(success.authorization, ["workspaceId", "targetId", "targetRevision", "clientAuthorityId",
      "sourceId", "recipientRecordId", "grantId", "grantVersion", "folderRef", "publicationRevision", "snapshotId", "snapshotSha256",
      "currentRecipientRecordId", "currentRecipientProfileVersion", "currentRecipientRelationshipVersion"]);
    if (!success || success.ok !== true || success.protocolVersion !== 1 || !UUID.test(String(success.requestId))
      || !HASH.test(String(success.requestSha256)) || typeof success.observedAt !== "string" || !Number.isFinite(Date.parse(success.observedAt))
      || !authorization || !text(authorization.workspaceId, 200) || !UUID.test(String(authorization.targetId))
      || !UUID.test(String(authorization.clientAuthorityId)) || !Number.isSafeInteger(authorization.targetRevision)
      || Number(authorization.targetRevision) < 1 || authorization.sourceId !== "project-alpha:primary"
      || !text(authorization.recipientRecordId, 200) || !UUID.test(String(authorization.grantId))
      || !Number.isSafeInteger(authorization.grantVersion) || Number(authorization.grantVersion) < 1
      || typeof authorization.folderRef !== "string" || !B64URL.test(authorization.folderRef)
      || !Number.isSafeInteger(authorization.publicationRevision) || Number(authorization.publicationRevision) < 1
      || !text(authorization.snapshotId, 200) || !HASH.test(String(authorization.snapshotSha256))
      || !text(authorization.currentRecipientRecordId, 200)
      || !Number.isSafeInteger(authorization.currentRecipientProfileVersion) || Number(authorization.currentRecipientProfileVersion) < 1
      || !(authorization.currentRecipientRelationshipVersion === null
        || Number.isSafeInteger(authorization.currentRecipientRelationshipVersion)
          && Number(authorization.currentRecipientRelationshipVersion) >= 1)) return null;
    return success as unknown as DirectClientFolderReadResult;
  } catch { return null; }
}
