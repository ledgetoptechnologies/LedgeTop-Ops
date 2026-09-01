import { HTTPException } from "hono/http-exception";
import { PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import type { Env } from "../types";
import { constantTimeEqual } from "../security";
import type { ClientPortalSession } from "./types";
import {
  nativeRequestMutationGuardSql,
  resolveNativeRequestAuthority,
  type NativeRequestAuthorityProof,
} from "./native-request-authority";

export const REQUEST_ATTACHMENT_MAX_FILES = 10;
export const REQUEST_ATTACHMENT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const REQUEST_ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const REQUEST_ATTACHMENT_PART_BYTES = 8 * 1024 * 1024;
export const REQUEST_ATTACHMENT_TICKET_SECONDS = 300;

const allowedTypes = new Map<string, ReadonlySet<string>>([
  ["image/jpeg", new Set(["jpg", "jpeg"])],
  ["image/png", new Set(["png"])],
  ["image/webp", new Set(["webp"])],
  ["image/heic", new Set(["heic"])],
  ["image/heif", new Set(["heif"])],
  ["application/pdf", new Set(["pdf"])],
]);

const encoder = new TextEncoder();

export interface RequestAttachmentRow {
  id: string;
  draft_id: string;
  account_id: string;
  created_by_identity_id: string;
  client_upload_id: string;
  object_key: string;
  multipart_upload_id: string;
  original_name: string;
  declared_size: number;
  content_type: string;
  status: "uploading" | "quarantined" | "scanning" | "accepted" | "rejected" | "aborted" | "expired";
  actual_size: number | null;
  etag: string | null;
  expires_at: string;
  submitted_request_id: string | null;
  scanner_verdict?: string | null;
  verified_sha256?: string | null;
}

export interface RequestAttachmentPart {
  partNumber: number;
  etag: string;
  size: number;
}

function database(env: Env): D1Database {
  const candidate = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return typeof candidate.withSession === "function" ? candidate.withSession("first-primary") : env.DELIVERY_DB;
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmacBytes(secret: string | Uint8Array, value: string): Promise<ArrayBuffer> {
  const bytes = typeof secret === "string" ? encoder.encode(secret) : secret;
  const raw = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}

function awsEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

async function signingKey(secret: string, date: string): Promise<Uint8Array> {
  const dateKey = new Uint8Array(await hmacBytes(`AWS4${secret}`, date));
  const regionKey = new Uint8Array(await hmacBytes(dateKey, "auto"));
  const serviceKey = new Uint8Array(await hmacBytes(regionKey, "s3"));
  return new Uint8Array(await hmacBytes(serviceKey, "aws4_request"));
}

function signerConfiguration(env: Env): { host: string; bucket: string; accessKeyId: string; secretAccessKey: string } {
  let endpoint: URL;
  try { endpoint = new URL(env.R2_S3_ENDPOINT); }
  catch { throw new HTTPException(503, { message: "Request attachments are not configured" }); }
  if (
    env.CLIENT_REQUEST_ATTACHMENTS_ENABLED !== "true" ||
    !env.CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET ||
    env.CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET.length < 32 ||
    !env.R2_BUCKET_NAME ||
    !env.CLIENT_REQUEST_ATTACHMENT_R2_ACCESS_KEY_ID ||
    !env.CLIENT_REQUEST_ATTACHMENT_R2_SECRET_ACCESS_KEY ||
    !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(endpoint.hostname)
  ) throw new HTTPException(503, { message: "Request attachments are not configured" });
  return {
    host: endpoint.host,
    bucket: env.R2_BUCKET_NAME,
    accessKeyId: env.CLIENT_REQUEST_ATTACHMENT_R2_ACCESS_KEY_ID,
    secretAccessKey: env.CLIENT_REQUEST_ATTACHMENT_R2_SECRET_ACCESS_KEY,
  };
}

export function requestAttachmentsAvailable(env: Env): boolean {
  try { signerConfiguration(env); return true; }
  catch { return false; }
}

export function validateRequestAttachment(name: string, rawContentType: string, size: number): { name: string; contentType: string } {
  const normalized = name.normalize("NFC").trim();
  if (!normalized || normalized.length > 255 || /[\\/\0-\x1f\x7f]/.test(normalized) || normalized === "." || normalized === "..")
    throw new HTTPException(400, { message: "The attachment name is invalid" });
  if (!Number.isSafeInteger(size) || size <= 0 || size > REQUEST_ATTACHMENT_MAX_FILE_BYTES)
    throw new HTTPException(413, { message: "Attachments must be 25 MiB or smaller" });
  const contentType = rawContentType.toLowerCase().split(";", 1)[0]!.trim();
  const extension = normalized.includes(".") ? normalized.split(".").pop()!.toLowerCase() : "";
  if (!allowedTypes.get(contentType)?.has(extension))
    throw new HTTPException(415, { message: "Only JPEG, PNG, WebP, HEIC, HEIF, and PDF attachments are accepted" });
  return { name: normalized, contentType };
}

export function requestAttachmentPartLength(size: number, partNumber: number): number {
  const count = Math.ceil(size / REQUEST_ATTACHMENT_PART_BYTES);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > count)
    throw new HTTPException(400, { message: "The attachment part number is invalid" });
  return partNumber === count ? size - REQUEST_ATTACHMENT_PART_BYTES * (count - 1) : REQUEST_ATTACHMENT_PART_BYTES;
}

export function canonicalRequestAttachmentEtag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const unquoted = trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
  return /^[a-f0-9]{32}$/i.test(unquoted) ? unquoted.toLowerCase() : null;
}

export async function presignRequestAttachmentPart(input: {
  env: Env; key: string; uploadId: string; partNumber: number; contentLength: number; contentType: string; now?: Date;
}): Promise<{ url: string; expiresAt: string }> {
  const config = signerConfiguration(input.env);
  const expires = REQUEST_ATTACHMENT_TICKET_SECONDS;
  const now = input.now ?? new Date();
  const timestamp = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = timestamp.slice(0, 8);
  const scope = `${date}/auto/s3/aws4_request`;
  const path = `/${awsEncode(config.bucket)}/${input.key.split("/").map(awsEncode).join("/")}`;
  const signedHeaders = "content-length;content-type;host";
  const parameters = new Map<string, string>([
    ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"], ["X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD"],
    ["X-Amz-Credential", `${config.accessKeyId}/${scope}`], ["X-Amz-Date", timestamp],
    ["X-Amz-Expires", String(expires)], ["X-Amz-SignedHeaders", signedHeaders],
    ["partNumber", String(input.partNumber)], ["uploadId", input.uploadId],
  ]);
  const query = [...parameters].map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("&");
  const canonicalHeaders = `content-length:${input.contentLength}\ncontent-type:${input.contentType}\nhost:${config.host}\n`;
  const canonical = `PUT\n${path}\n${query}\n${canonicalHeaders}\n${signedHeaders}\nUNSIGNED-PAYLOAD`;
  const stringToSign = `AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${await digest(canonical)}`;
  const signature = hex(await hmacBytes(await signingKey(config.secretAccessKey, date), stringToSign));
  return { url: `https://${config.host}${path}?${query}&X-Amz-Signature=${signature}`, expiresAt: new Date(now.getTime() + expires * 1000).toISOString() };
}

const draftAccessSql = `
  JOIN client_accounts a ON a.id=? AND a.status='active'
    AND (a.project_alpha_source_id IS NULL OR a.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}')
  JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
  JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
  WHERE d.id=? AND d.account_id=a.id AND d.state='draft' AND d.catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}' AND (
    (d.project_id IS NULL AND (m.role='manager' OR d.created_by_identity_id=i.id)) OR
    (d.project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM client_project_grants g JOIN projects p ON p.id=g.project_id AND p.active=1
        AND (p.project_alpha_source_id IS NULL OR p.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}')
      WHERE g.account_id=a.id AND g.project_id=d.project_id AND g.revoked_at IS NULL AND g.can_request_service=1
        AND (m.role='manager' OR EXISTS (
          SELECT 1 FROM client_member_project_grants mg
          WHERE mg.account_id=a.id AND mg.identity_id=i.id AND mg.project_id=d.project_id AND mg.revoked_at IS NULL
        ))
    ))
  )`;

async function nativeDraftOwner(env: Env, session: ClientPortalSession, draftId: string): Promise<{
  accountId: string; storageIdentityId: string; sourceId: string; proof: NativeRequestAuthorityProof;
} | null> {
  if (!session.nativeSourceId || !session.nativePortalIdentityId || !session.workspaceId) return null;
  const row = await database(env).prepare(`SELECT draft.account_id,draft.created_by_identity_id,
      draft.portal_project_public_id,draft.catalog_source_id
    FROM client_service_request_drafts draft
    JOIN portal_native_request_storage_bindings binding ON binding.workspace_id=draft.portal_workspace_id
      AND binding.source_id=draft.catalog_source_id AND binding.account_id=draft.account_id
      AND binding.storage_identity_id=draft.created_by_identity_id AND binding.state='active'
    WHERE draft.id=? AND draft.state='draft' AND draft.portal_workspace_id=?
      AND draft.portal_identity_id=? AND draft.catalog_source_id=?`)
    .bind(draftId, session.workspaceId, session.nativePortalIdentityId, session.nativeSourceId)
    .first<{ account_id: string; created_by_identity_id: string; portal_project_public_id: string | null; catalog_source_id: string }>();
  if (!row) return null;
  const proof = await resolveNativeRequestAuthority(env, session, row.portal_project_public_id);
  return proof?.sourceId === row.catalog_source_id
    ? { accountId: row.account_id, storageIdentityId: row.created_by_identity_id, sourceId: row.catalog_source_id, proof }
    : null;
}

export interface AuthorizedRequestAttachment {
  row: RequestAttachmentRow;
  nativeProof: NativeRequestAuthorityProof | null;
}

export interface NativeRequestAttachmentPartLease {
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

async function nativeRequestOwner(env: Env, session: ClientPortalSession, requestId: string): Promise<{
  accountId: string; sourceId: string;
} | null> {
  if (!session.nativeSourceId || !session.nativePortalIdentityId || !session.workspaceId) return null;
  const row = await database(env).prepare(`SELECT request.account_id,request.portal_project_public_id,request.catalog_source_id
    FROM client_service_requests request
    JOIN portal_native_request_storage_bindings binding ON binding.workspace_id=request.portal_workspace_id
      AND binding.source_id=request.catalog_source_id AND binding.account_id=request.account_id AND binding.state='active'
    WHERE request.id=? AND request.portal_workspace_id=? AND request.portal_identity_id=? AND request.catalog_source_id=?`)
    .bind(requestId, session.workspaceId, session.nativePortalIdentityId, session.nativeSourceId)
    .first<{ account_id: string; portal_project_public_id: string | null; catalog_source_id: string }>();
  if (!row) return null;
  const proof = await resolveNativeRequestAuthority(env, session, row.portal_project_public_id);
  return proof?.sourceId === row.catalog_source_id ? { accountId: row.account_id, sourceId: row.catalog_source_id } : null;
}

export async function getAuthorizedRequestAttachmentContext(env: Env, session: ClientPortalSession, draftId: string, attachmentId: string): Promise<AuthorizedRequestAttachment | null> {
  if (session.nativeSourceId) {
    const owner = await nativeDraftOwner(env, session, draftId);
    const row = owner ? await database(env).prepare(`SELECT * FROM client_service_request_attachments
      WHERE id=? AND draft_id=? AND account_id=?`).bind(attachmentId, draftId, owner.accountId).first<RequestAttachmentRow>() : null;
    return row && owner ? { row, nativeProof: owner.proof } : null;
  }
  const row = await database(env).prepare(`SELECT attachment.* FROM client_service_request_attachments attachment
    JOIN client_service_request_drafts d ON d.id=attachment.draft_id ${draftAccessSql}
    AND attachment.id=? AND attachment.account_id=a.id`)
    .bind(session.accountId, session.identityId, draftId, attachmentId).first<RequestAttachmentRow>();
  return row ? { row, nativeProof: null } : null;
}

export async function getAuthorizedRequestAttachment(env: Env, session: ClientPortalSession, draftId: string, attachmentId: string): Promise<RequestAttachmentRow | null> {
  return (await getAuthorizedRequestAttachmentContext(env, session, draftId, attachmentId))?.row ?? null;
}

export async function listRequestAttachments(env: Env, session: ClientPortalSession, draftId: string): Promise<RequestAttachmentRow[] | null> {
  if (session.nativeSourceId) {
    const owner = await nativeDraftOwner(env, session, draftId);
    if (!owner) return null;
    return (await database(env).prepare(`SELECT * FROM client_service_request_attachments
      WHERE draft_id=? AND account_id=? AND status<>'aborted' ORDER BY created_at,id`)
      .bind(draftId, owner.accountId).all<RequestAttachmentRow>()).results;
  }
  const allowed = await database(env).prepare(`SELECT d.id FROM client_service_request_drafts d ${draftAccessSql}`)
    .bind(session.accountId, session.identityId, draftId).first<{ id: string }>();
  if (!allowed) return null;
  const rows = await database(env).prepare(`SELECT * FROM client_service_request_attachments WHERE draft_id=? AND status<>'aborted' ORDER BY created_at,id`)
    .bind(draftId).all<RequestAttachmentRow>();
  return rows.results;
}

const submittedRequestAccessSql = `
  JOIN client_accounts a ON a.id=? AND a.status='active'
    AND (a.project_alpha_source_id IS NULL OR a.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}')
  JOIN client_identity_links i ON i.id=? AND i.account_id=a.id AND i.revoked_at IS NULL
  JOIN client_account_members m ON m.account_id=a.id AND m.identity_id=i.id AND m.revoked_at IS NULL
  WHERE request.id=? AND request.account_id=a.id AND request.catalog_source_id='${PRIMARY_ALPHA_SOURCE_ID}' AND (
    (request.project_id IS NULL AND (m.role='manager' OR request.created_by_identity_id=i.id)) OR
    (request.project_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM client_project_grants g JOIN projects p ON p.id=g.project_id AND p.active=1
        AND (p.project_alpha_source_id IS NULL OR p.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}')
      WHERE g.account_id=a.id AND g.project_id=request.project_id AND g.revoked_at IS NULL
        AND (m.role='manager' OR EXISTS (
          SELECT 1 FROM client_member_project_grants mg
          WHERE mg.account_id=a.id AND mg.identity_id=i.id AND mg.project_id=request.project_id AND mg.revoked_at IS NULL
        ))
    ))
  )`;

export async function listSubmittedRequestAttachments(env: Env, session: ClientPortalSession, requestId: string): Promise<RequestAttachmentRow[] | null> {
  if (session.nativeSourceId) {
    const owner = await nativeRequestOwner(env, session, requestId);
    if (!owner) return null;
    return (await database(env).prepare(`SELECT * FROM client_service_request_attachments
      WHERE submitted_request_id=? AND account_id=? AND status='accepted' ORDER BY created_at,id`)
      .bind(requestId, owner.accountId).all<RequestAttachmentRow>()).results;
  }
  const allowed = await database(env).prepare(`SELECT request.id FROM client_service_requests request ${submittedRequestAccessSql}`)
    .bind(session.accountId, session.identityId, requestId).first<{ id: string }>();
  if (!allowed) return null;
  const rows = await database(env).prepare("SELECT * FROM client_service_request_attachments WHERE submitted_request_id=? AND status='accepted' ORDER BY created_at,id")
    .bind(requestId).all<RequestAttachmentRow>();
  return rows.results;
}

export async function getSubmittedRequestAttachment(env: Env, session: ClientPortalSession, requestId: string, attachmentId: string): Promise<RequestAttachmentRow | null> {
  if (session.nativeSourceId) {
    const owner = await nativeRequestOwner(env, session, requestId);
    return owner ? database(env).prepare(`SELECT * FROM client_service_request_attachments
      WHERE id=? AND submitted_request_id=? AND account_id=? AND status='accepted'`)
      .bind(attachmentId, requestId, owner.accountId).first<RequestAttachmentRow>() : null;
  }
  return database(env).prepare(`SELECT attachment.* FROM client_service_request_attachments attachment
    JOIN client_service_requests request ON request.id=attachment.submitted_request_id ${submittedRequestAccessSql}
    AND attachment.id=? AND attachment.status='accepted' AND attachment.account_id=a.id`)
    .bind(session.accountId, session.identityId, requestId, attachmentId).first<RequestAttachmentRow>();
}

export async function initializeRequestAttachment(env: Env, session: ClientPortalSession, draftId: string, input: {
  clientUploadId: string; name: string; contentType: string; size: number;
}): Promise<{ row: RequestAttachmentRow; resumed: boolean }> {
  signerConfiguration(env);
  const file = validateRequestAttachment(input.name, input.contentType, input.size);
  if (session.nativeSourceId) return initializeNativeRequestAttachment(env, session, draftId, input, file);
  const existing = await database(env).prepare(`SELECT attachment.* FROM client_service_request_attachments attachment
    JOIN client_service_request_drafts d ON d.id=attachment.draft_id ${draftAccessSql}
    AND attachment.client_upload_id=? AND attachment.account_id=a.id`)
    .bind(session.accountId, session.identityId, draftId, input.clientUploadId).first<RequestAttachmentRow>();
  if (existing) {
    if (existing.original_name !== file.name || existing.content_type !== file.contentType || existing.declared_size !== input.size)
      throw new HTTPException(409, { message: "This upload ID belongs to a different attachment" });
    return { row: existing, resumed: true };
  }
  const id = crypto.randomUUID();
  const key = `_ltds/quarantine/request-attachments/${id}/object`;
  const pendingUploadId = `pending:${crypto.randomUUID()}`;
  const inserted = await database(env).prepare(`INSERT INTO client_service_request_attachments
    (id,draft_id,account_id,created_by_identity_id,client_upload_id,object_key,multipart_upload_id,original_name,declared_size,content_type,status,expires_at)
    SELECT ?,d.id,d.account_id,i.id,?,?,?,?,?,?,'uploading',datetime('now','+24 hours')
    FROM client_service_request_drafts d ${draftAccessSql}
      AND (SELECT COUNT(*) FROM client_service_request_attachments current WHERE current.draft_id=d.id AND current.status NOT IN ('rejected','aborted','expired')) < ?
      AND COALESCE((SELECT SUM(current.declared_size) FROM client_service_request_attachments current WHERE current.draft_id=d.id AND current.status NOT IN ('rejected','aborted','expired')),0)+? <= ?`)
    .bind(id, input.clientUploadId, key, pendingUploadId, file.name, input.size, file.contentType,
      session.accountId, session.identityId, draftId,
      REQUEST_ATTACHMENT_MAX_FILES, input.size, REQUEST_ATTACHMENT_MAX_TOTAL_BYTES).run();
  if (inserted.meta.changes !== 1) {
    const draft = await database(env).prepare(`SELECT d.id FROM client_service_request_drafts d ${draftAccessSql}`)
      .bind(session.accountId, session.identityId, draftId).first<{ id: string }>();
    if (!draft) throw new HTTPException(404, { message: "Service request draft not found" });
    throw new HTTPException(413, { message: "A request can include at most 10 attachments and 100 MiB total" });
  }
  let multipart: R2MultipartUpload | undefined;
  try {
    multipart = await env.DATA_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: file.contentType },
      customMetadata: { attachmentId: id },
    });
    const updated = await database(env).prepare(`UPDATE client_service_request_attachments SET multipart_upload_id=?,updated_at=datetime('now') WHERE id=? AND multipart_upload_id=? AND status='uploading'`)
      .bind(multipart.uploadId, id, pendingUploadId).run();
    if (updated.meta.changes !== 1) {
      await multipart.abort();
      throw new Error("Attachment upload initialization lost its claim");
    }
  } catch (error) {
    if (multipart) { try { await multipart.abort(); } catch { /* cleanup retry handles it */ } }
    await database(env).prepare("DELETE FROM client_service_request_attachments WHERE id=? AND status='uploading'").bind(id).run();
    throw error;
  }
  const row = await getAuthorizedRequestAttachment(env, session, draftId, id);
  if (!row) throw new Error("Initialized attachment could not be reloaded");
  return { row, resumed: false };
}

async function initializeNativeRequestAttachment(
  env: Env,
  session: ClientPortalSession,
  draftId: string,
  input: { clientUploadId: string; name: string; contentType: string; size: number },
  file: { name: string; contentType: string },
): Promise<{ row: RequestAttachmentRow; resumed: boolean }> {
  const owner = await nativeDraftOwner(env, session, draftId);
  if (!owner) throw new HTTPException(404, { message: "Service request draft not found" });
  const existing = await database(env).prepare(`SELECT * FROM client_service_request_attachments
    WHERE draft_id=? AND account_id=? AND client_upload_id=?`)
    .bind(draftId, owner.accountId, input.clientUploadId).first<RequestAttachmentRow>();
  if (existing) {
    if (existing.original_name !== file.name || existing.content_type !== file.contentType || existing.declared_size !== input.size)
      throw new HTTPException(409, { message: "This upload ID belongs to a different attachment" });
    return { row: existing, resumed: true };
  }
  const id = crypto.randomUUID();
  const key = `_ltds/quarantine/request-attachments/${id}/object`;
  const pendingUploadId = `pending:${crypto.randomUUID()}`;
  const authorityGuard = nativeRequestMutationGuardSql(owner.proof);
  const inserted = await database(env).prepare(`INSERT INTO client_service_request_attachments
    (id,draft_id,account_id,created_by_identity_id,client_upload_id,object_key,multipart_upload_id,
     original_name,declared_size,content_type,status,expires_at)
    SELECT ?,draft.id,draft.account_id,draft.created_by_identity_id,?,?,?,?,?,?,'uploading',datetime('now','+24 hours')
    FROM client_service_request_drafts draft
    JOIN portal_native_request_storage_bindings binding ON binding.workspace_id=draft.portal_workspace_id
      AND binding.source_id=draft.catalog_source_id AND binding.account_id=draft.account_id
      AND binding.storage_identity_id=draft.created_by_identity_id AND binding.state='active'
    WHERE draft.id=? AND draft.state='draft' AND draft.portal_workspace_id=? AND draft.portal_identity_id=?
      AND draft.catalog_source_id=?
      AND ${authorityGuard.sql}
      AND (SELECT COUNT(*) FROM client_service_request_attachments current
        WHERE current.draft_id=draft.id AND current.status NOT IN ('rejected','aborted','expired'))<?
      AND COALESCE((SELECT SUM(current.declared_size) FROM client_service_request_attachments current
        WHERE current.draft_id=draft.id AND current.status NOT IN ('rejected','aborted','expired')),0)+?<=?`)
    .bind(id, input.clientUploadId, key, pendingUploadId, file.name, input.size, file.contentType,
      draftId, session.workspaceId, session.nativePortalIdentityId, owner.sourceId,
      ...authorityGuard.bindings,
      REQUEST_ATTACHMENT_MAX_FILES, input.size, REQUEST_ATTACHMENT_MAX_TOTAL_BYTES).run();
  if (inserted.meta.changes !== 1)
    throw new HTTPException(413, { message: "A request can include at most 10 attachments and 100 MiB total" });
  let multipart: R2MultipartUpload | undefined;
  try {
    multipart = await env.DATA_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: file.contentType }, customMetadata: { attachmentId: id },
    });
    const claimed = await database(env).prepare(`UPDATE client_service_request_attachments
      SET multipart_upload_id=?,updated_at=datetime('now')
      WHERE id=? AND multipart_upload_id=? AND status='uploading' AND ${authorityGuard.sql}`)
      .bind(multipart.uploadId, id, pendingUploadId, ...authorityGuard.bindings).run();
    if (claimed.meta.changes !== 1) { await multipart.abort(); throw new Error("Attachment upload initialization lost its claim"); }
  } catch (error) {
    if (multipart) { try { await multipart.abort(); } catch { /* cleanup retry handles it */ } }
    await database(env).prepare("DELETE FROM client_service_request_attachments WHERE id=? AND status='uploading'").bind(id).run();
    throw error;
  }
  const row = await getAuthorizedRequestAttachment(env, session, draftId, id);
  if (!row) throw new Error("Initialized attachment could not be reloaded");
  return { row, resumed: false };
}

export async function requestAttachmentCheckpoints(env: Env, attachmentId: string): Promise<RequestAttachmentPart[]> {
  const rows = await database(env).prepare("SELECT part_number,etag,size FROM client_service_request_attachment_parts WHERE attachment_id=? ORDER BY part_number")
    .bind(attachmentId).all<{ part_number: number; etag: string; size: number }>();
  return rows.results.map(row => ({ partNumber: row.part_number, etag: row.etag, size: row.size }));
}

export async function issueNativeRequestAttachmentPartLease(
  env: Env,
  row: RequestAttachmentRow,
  proof: NativeRequestAuthorityProof,
  partNumber: number,
  now = new Date(),
): Promise<NativeRequestAttachmentPartLease | null> {
  const guard = nativeRequestMutationGuardSql(proof);
  const reused = await database(env).prepare(`UPDATE portal_native_request_attachment_part_tickets
    SET last_issued_at=?
    WHERE attachment_id=? AND part_number=? AND workspace_id=? AND identity_id=? AND source_id=?
      AND consumed_at IS NULL AND datetime(expires_at)>datetime(?)
      AND EXISTS(SELECT 1 FROM client_service_request_attachments attachment
        JOIN client_service_request_drafts draft ON draft.id=attachment.draft_id
        WHERE attachment.id=portal_native_request_attachment_part_tickets.attachment_id
          AND attachment.id=? AND attachment.status='uploading' AND attachment.submitted_request_id IS NULL
          AND draft.state='draft' AND draft.portal_workspace_id=? AND draft.portal_identity_id=?
          AND draft.catalog_source_id=?)
      AND ${guard.sql}
    RETURNING nonce,issued_at issuedAt,expires_at expiresAt`)
    .bind(now.toISOString(), row.id, partNumber, proof.workspaceId, proof.identityId, proof.sourceId,
      now.toISOString(), row.id, proof.workspaceId, proof.identityId, proof.sourceId, ...guard.bindings)
    .first<NativeRequestAttachmentPartLease>();
  if (reused) return reused;

  const nonce = crypto.randomUUID();
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + REQUEST_ATTACHMENT_TICKET_SECONDS * 1000).toISOString();
  return database(env).prepare(`INSERT INTO portal_native_request_attachment_part_tickets
      (attachment_id,part_number,nonce,workspace_id,identity_id,source_id,issued_at,expires_at,last_issued_at)
    SELECT attachment.id,?,?,?,?,?,?,?,? FROM client_service_request_attachments attachment
    JOIN client_service_request_drafts draft ON draft.id=attachment.draft_id
    WHERE attachment.id=? AND attachment.status='uploading' AND attachment.submitted_request_id IS NULL
      AND draft.state='draft' AND draft.portal_workspace_id=? AND draft.portal_identity_id=?
      AND draft.catalog_source_id=? AND ${guard.sql}
    ON CONFLICT(attachment_id,part_number) DO UPDATE SET
      nonce=excluded.nonce,workspace_id=excluded.workspace_id,identity_id=excluded.identity_id,
      source_id=excluded.source_id,issued_at=excluded.issued_at,expires_at=excluded.expires_at,
      consumed_at=NULL,last_issued_at=excluded.last_issued_at
    WHERE portal_native_request_attachment_part_tickets.consumed_at IS NOT NULL
      OR datetime(portal_native_request_attachment_part_tickets.expires_at)<=datetime(?)
    RETURNING nonce,issued_at issuedAt,expires_at expiresAt`)
    .bind(partNumber, nonce, proof.workspaceId, proof.identityId, proof.sourceId, issuedAt, expiresAt, issuedAt,
      row.id, proof.workspaceId, proof.identityId, proof.sourceId, ...guard.bindings, issuedAt)
    .first<NativeRequestAttachmentPartLease>();
}

export async function checkpointRequestAttachment(
  env: Env,
  row: RequestAttachmentRow,
  partNumber: number,
  rawEtag: unknown,
  size: number,
  native?: { proof: NativeRequestAuthorityProof; ticketNonce: string },
): Promise<RequestAttachmentPart> {
  if (row.status !== "uploading") throw new HTTPException(409, { message: "The attachment is not accepting parts" });
  const etag = canonicalRequestAttachmentEtag(rawEtag);
  const expectedSize = requestAttachmentPartLength(row.declared_size, partNumber);
  if (!etag || size !== expectedSize) throw new HTTPException(400, { message: "The attachment checkpoint is invalid" });
  if (native) {
    const guard = nativeRequestMutationGuardSql(native.proof);
    const db = database(env);
    const results = await db.batch([
      db.prepare(`INSERT INTO client_service_request_attachment_parts(attachment_id,part_number,etag,size)
        SELECT attachment.id,?,?,? FROM client_service_request_attachments attachment
        JOIN client_service_request_drafts draft ON draft.id=attachment.draft_id
        JOIN portal_native_request_attachment_part_tickets ticket ON ticket.attachment_id=attachment.id
          AND ticket.part_number=? AND ticket.nonce=? AND ticket.workspace_id=? AND ticket.identity_id=?
          AND ticket.source_id=? AND datetime(ticket.expires_at)>datetime('now')
          AND (ticket.consumed_at IS NULL OR EXISTS(SELECT 1 FROM client_service_request_attachment_parts saved
            WHERE saved.attachment_id=attachment.id AND saved.part_number=? AND saved.etag=? AND saved.size=?))
        WHERE attachment.id=? AND attachment.status='uploading' AND attachment.submitted_request_id IS NULL
          AND draft.state='draft' AND draft.portal_workspace_id=? AND draft.portal_identity_id=?
          AND draft.catalog_source_id=? AND ${guard.sql}
        ON CONFLICT(attachment_id,part_number) DO UPDATE SET
          etag=excluded.etag,size=excluded.size,updated_at=datetime('now')
        WHERE client_service_request_attachment_parts.etag=excluded.etag
          AND client_service_request_attachment_parts.size=excluded.size`)
        .bind(partNumber, etag, size, partNumber, native.ticketNonce, native.proof.workspaceId,
          native.proof.identityId, native.proof.sourceId, partNumber, etag, size, row.id,
          native.proof.workspaceId, native.proof.identityId, native.proof.sourceId, ...guard.bindings),
      db.prepare(`UPDATE portal_native_request_attachment_part_tickets SET consumed_at=COALESCE(consumed_at,datetime('now'))
        WHERE attachment_id=? AND part_number=? AND nonce=? AND workspace_id=? AND identity_id=? AND source_id=?
          AND datetime(expires_at)>datetime('now') AND EXISTS(
            SELECT 1 FROM client_service_request_attachments attachment
            JOIN client_service_request_drafts draft ON draft.id=attachment.draft_id
            JOIN client_service_request_attachment_parts saved ON saved.attachment_id=attachment.id
              AND saved.part_number=? AND saved.etag=? AND saved.size=?
            WHERE attachment.id=? AND attachment.status='uploading' AND attachment.submitted_request_id IS NULL
              AND draft.state='draft' AND draft.portal_workspace_id=? AND draft.portal_identity_id=?
              AND draft.catalog_source_id=? AND ${guard.sql})`)
        .bind(row.id, partNumber, native.ticketNonce, native.proof.workspaceId, native.proof.identityId,
          native.proof.sourceId, partNumber, etag, size, row.id, native.proof.workspaceId,
          native.proof.identityId, native.proof.sourceId, ...guard.bindings),
    ]);
    if (!results[0]?.meta.changes)
      throw new HTTPException(409, { message: "The attachment ticket expired or access changed. Request a new part ticket." });
    const saved = await db.prepare(`SELECT part_number partNumber,etag,size FROM client_service_request_attachment_parts
      WHERE attachment_id=? AND part_number=?`).bind(row.id, partNumber).first<RequestAttachmentPart>();
    if (!saved) throw new HTTPException(409, { message: "The attachment checkpoint could not be recorded" });
    return saved;
  }
  await database(env).prepare(`INSERT INTO client_service_request_attachment_parts(attachment_id,part_number,etag,size)
    VALUES (?,?,?,?) ON CONFLICT(attachment_id,part_number) DO UPDATE SET etag=excluded.etag,size=excluded.size,updated_at=datetime('now')`)
    .bind(row.id, partNumber, etag, size).run();
  return { partNumber, etag, size };
}

async function deleteRemovedAttachmentObject(env: Env, row: Pick<RequestAttachmentRow, "id" | "object_key">): Promise<void> {
  try { await env.DATA_BUCKET.delete(row.object_key); }
  catch (error) {
    console.error(JSON.stringify({
      event: "client-request-attachment.delete-failed",
      attachmentId: row.id,
      message: error instanceof Error ? error.message : "unknown",
    }));
    throw new HTTPException(503, { message: "The attachment was removed from the draft, but quarantine cleanup is still pending. Retry removal." });
  }
}

export async function abortRequestAttachment(
  env: Env,
  row: RequestAttachmentRow,
  nativeProof?: NativeRequestAuthorityProof,
): Promise<{ idempotent: boolean }> {
  if (row.submitted_request_id !== null)
    throw new HTTPException(409, { message: "Submitted request attachments are immutable" });
  if (row.status === "aborted") {
    await deleteRemovedAttachmentObject(env, row);
    return { idempotent: true };
  }
  const db = database(env);
  if (nativeProof) {
    const guard = nativeRequestMutationGuardSql(nativeProof);
    const result = await db.prepare(`UPDATE client_service_request_attachments
      SET status='aborted',updated_at=datetime('now')
      WHERE id=? AND submitted_request_id IS NULL
        AND status IN ('uploading','quarantined','scanning','accepted','rejected','expired')
        AND EXISTS (SELECT 1 FROM client_service_request_drafts draft
          WHERE draft.id=client_service_request_attachments.draft_id AND draft.state='draft'
            AND draft.portal_workspace_id=? AND draft.portal_identity_id=? AND draft.catalog_source_id=?)
        AND ${guard.sql}`)
      .bind(row.id, nativeProof.workspaceId, nativeProof.identityId, nativeProof.sourceId, ...guard.bindings).run();
    if (result.meta.changes !== 1) {
      const current = await db.prepare(`SELECT attachment.status,attachment.submitted_request_id,draft.state draft_state
        FROM client_service_request_attachments attachment JOIN client_service_request_drafts draft ON draft.id=attachment.draft_id
        WHERE attachment.id=?`).bind(row.id).first<{
          status: RequestAttachmentRow["status"];
          submitted_request_id: string | null;
          draft_state: string;
        }>();
      if (current?.status !== "aborted" || current.submitted_request_id !== null)
        throw new HTTPException(409, { message: current?.draft_state === "submitted"
          ? "The request was submitted before this attachment could be removed"
          : "The attachment changed or access expired before it could be removed" });
    }
    if (row.status === "uploading" && !row.multipart_upload_id.startsWith("pending:")) {
      try { await env.DATA_BUCKET.resumeMultipartUpload(row.object_key, row.multipart_upload_id).abort(); }
      catch (error) {
        console.error(JSON.stringify({ event: "client-request-attachment.abort-failed", attachmentId: row.id, message: error instanceof Error ? error.message : "unknown" }));
        throw new HTTPException(503, { message: "The attachment was removed from the draft, but multipart cleanup is pending. Retry removal." });
      }
    }
    await db.prepare("DELETE FROM client_service_request_attachment_parts WHERE attachment_id=?").bind(row.id).run();
    await deleteRemovedAttachmentObject(env, row);
    return { idempotent: result.meta.changes !== 1 };
  }
  if (row.status === "uploading" && !row.multipart_upload_id.startsWith("pending:")) {
    try { await env.DATA_BUCKET.resumeMultipartUpload(row.object_key, row.multipart_upload_id).abort(); }
    catch (error) {
      console.error(JSON.stringify({ event: "client-request-attachment.abort-failed", attachmentId: row.id, message: error instanceof Error ? error.message : "unknown" }));
      throw new HTTPException(503, { message: "The attachment could not be removed yet. Please retry." });
    }
  }
  const result = await db.prepare(`UPDATE client_service_request_attachments
    SET status='aborted',updated_at=datetime('now')
    WHERE id=? AND submitted_request_id IS NULL
      AND status IN ('uploading','quarantined','scanning','accepted','rejected','expired')
      AND EXISTS (SELECT 1 FROM client_service_request_drafts draft
        WHERE draft.id=client_service_request_attachments.draft_id AND draft.state='draft')`)
    .bind(row.id).run();
  if (result.meta.changes !== 1) {
    const current = await db.prepare(`SELECT attachment.status,attachment.submitted_request_id,draft.state draft_state
      FROM client_service_request_attachments attachment
      JOIN client_service_request_drafts draft ON draft.id=attachment.draft_id
      WHERE attachment.id=?`).bind(row.id).first<{
        status: RequestAttachmentRow["status"];
        submitted_request_id: string | null;
        draft_state: string;
      }>();
    if (current?.status === "aborted" && current.submitted_request_id === null) {
      await deleteRemovedAttachmentObject(env, row);
      return { idempotent: true };
    }
    if (current?.submitted_request_id !== null || current?.draft_state === "submitted")
      throw new HTTPException(409, { message: "The request was submitted before this attachment could be removed" });
    throw new HTTPException(409, { message: "The attachment changed before it could be removed" });
  }
  await db.prepare("DELETE FROM client_service_request_attachment_parts WHERE attachment_id=?").bind(row.id).run();
  await deleteRemovedAttachmentObject(env, row);
  return { idempotent: result.meta.changes !== 1 };
}

function validMagic(contentType: string, bytes: Uint8Array): boolean {
  if (contentType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === "image/png") return [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a].every((value, index) => bytes[index] === value);
  if (contentType === "image/webp") return new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (contentType === "application/pdf") return new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-";
  if (contentType === "image/heic" || contentType === "image/heif") {
    if (new TextDecoder().decode(bytes.slice(4, 8)) !== "ftyp") return false;
    const brand = new TextDecoder().decode(bytes.slice(8, 12));
    return contentType === "image/heic" ? /^(heic|heix|hevc|hevx)$/.test(brand) : /^(mif1|msf1|heif)$/.test(brand);
  }
  return false;
}

export async function completeRequestAttachment(
  env: Env,
  row: RequestAttachmentRow,
  requested: Array<{ partNumber: number; etag: string }>,
  nativeProof?: NativeRequestAuthorityProof,
): Promise<{ status: RequestAttachmentRow["status"]; idempotent: boolean }> {
  if (["quarantined", "scanning", "accepted"].includes(row.status)) return { status: row.status, idempotent: true };
  if (row.status !== "uploading" || row.multipart_upload_id.startsWith("pending:")) throw new HTTPException(409, { message: "The attachment is not awaiting completion" });
  const saved = await requestAttachmentCheckpoints(env, row.id);
  if (saved.length !== requested.length || saved.some((part, index) => part.partNumber !== requested[index]?.partNumber || part.etag !== requested[index]?.etag))
    throw new HTTPException(409, { message: "Attachment checkpoints do not match" });
  const count = Math.ceil(row.declared_size / REQUEST_ATTACHMENT_PART_BYTES);
  if (saved.length !== count || saved.some((part, index) => part.partNumber !== index + 1 || part.size !== requestAttachmentPartLength(row.declared_size, part.partNumber)))
    throw new HTTPException(409, { message: "All attachment parts must be uploaded before completion" });
  const guard = nativeProof ? nativeRequestMutationGuardSql(nativeProof) : null;
  const completionClaim = crypto.randomUUID();
  const claim = await database(env).prepare(`UPDATE client_service_request_attachments
    SET completion_claimed_at=?,updated_at=datetime('now')
    WHERE id=? AND status='uploading' AND completion_claimed_at IS NULL
      ${guard ? `AND EXISTS(SELECT 1 FROM client_service_request_drafts draft
        WHERE draft.id=client_service_request_attachments.draft_id AND draft.state='draft'
          AND draft.portal_workspace_id=? AND draft.portal_identity_id=? AND draft.catalog_source_id=?)
        AND ${guard.sql}` : ""}
    RETURNING id`)
    .bind(completionClaim, row.id, ...(nativeProof ? [nativeProof.workspaceId, nativeProof.identityId, nativeProof.sourceId] : []),
      ...(guard?.bindings ?? [])).first<{ id: string }>();
  if (!claim) throw new HTTPException(409, { message: nativeProof
    ? "Attachment access changed before completion"
    : "Attachment completion is already in progress" });
  const nativeCompletionMutation = async (
    setSql: string,
    bindings: unknown[],
  ): Promise<boolean> => {
    if (!nativeProof || !guard) return false;
    const result = await database(env).prepare(`UPDATE client_service_request_attachments
      SET ${setSql},updated_at=datetime('now')
      WHERE id=? AND status='uploading' AND completion_claimed_at=?
        AND EXISTS(SELECT 1 FROM client_service_request_drafts draft
          WHERE draft.id=client_service_request_attachments.draft_id AND draft.state='draft'
            AND draft.portal_workspace_id=? AND draft.portal_identity_id=? AND draft.catalog_source_id=?)
        AND ${guard.sql}`)
      .bind(...bindings, row.id, completionClaim, nativeProof.workspaceId, nativeProof.identityId,
        nativeProof.sourceId, ...guard.bindings).run();
    return result.meta.changes === 1;
  };
  const releaseNativeClaimAfterAuthorityLoss = async (): Promise<void> => {
    if (!nativeProof) return;
    await database(env).prepare(`UPDATE client_service_request_attachments
      SET completion_claimed_at=NULL,updated_at=datetime('now')
      WHERE id=? AND status='uploading' AND completion_claimed_at=?
        AND EXISTS(SELECT 1 FROM client_service_request_drafts draft
          WHERE draft.id=client_service_request_attachments.draft_id
            AND draft.portal_workspace_id=? AND draft.portal_identity_id=? AND draft.catalog_source_id=?)`)
      .bind(row.id, completionClaim, nativeProof.workspaceId, nativeProof.identityId, nativeProof.sourceId).run();
  };
  const failClosedAfterAuthorityLoss = async (deleteObject: boolean): Promise<never> => {
    if (deleteObject) {
      try { await env.DATA_BUCKET.delete(row.object_key); }
      catch (error) {
        console.error(JSON.stringify({
          event: "client-request-attachment.revoked-completion-cleanup-failed",
          attachmentId: row.id,
          message: error instanceof Error ? error.message : "unknown",
        }));
      }
    }
    await releaseNativeClaimAfterAuthorityLoss();
    throw new HTTPException(409, { message: "Attachment access changed during completion" });
  };
  const releaseClaimAfterIoFailure = async (error: unknown, objectMayExist: boolean): Promise<never> => {
    if (nativeProof) {
      if (!(await nativeCompletionMutation("completion_claimed_at=NULL", [])))
        await failClosedAfterAuthorityLoss(objectMayExist);
    } else {
      await database(env).prepare("UPDATE client_service_request_attachments SET completion_claimed_at=NULL,updated_at=datetime('now') WHERE id=? AND status='uploading' AND completion_claimed_at=?")
        .bind(row.id, completionClaim).run();
    }
    throw error;
  };

  let object: R2Object | null = null;
  try {
    object = await env.DATA_BUCKET.resumeMultipartUpload(row.object_key, row.multipart_upload_id).complete(requested);
  } catch (error) {
    let completed: R2Object | null = null;
    try { completed = await env.DATA_BUCKET.head(row.object_key); }
    catch (headError) { await releaseClaimAfterIoFailure(headError, true); }
    if (completed?.size === row.declared_size) object = completed;
    else await releaseClaimAfterIoFailure(error, false);
  }
  if (!object) {
    await releaseClaimAfterIoFailure(new Error("Multipart completion returned no object"), true);
    throw new Error("unreachable");
  }
  const completedObject = object;
  let probeBytes: Uint8Array | null = null;
  try {
    const probe = completedObject.size === row.declared_size
      ? await env.DATA_BUCKET.get(row.object_key, { range: { offset: 0, length: Math.min(32, completedObject.size) } })
      : null;
    probeBytes = probe ? new Uint8Array(await probe.arrayBuffer()) : null;
  } catch (error) {
    await releaseClaimAfterIoFailure(error, true);
  }
  if (!probeBytes || !validMagic(row.content_type, probeBytes)) {
    const reason = completedObject.size !== row.declared_size ? "size_mismatch" : "content_signature_mismatch";
    if (nativeProof) {
      if (!(await nativeCompletionMutation(
        "status='rejected',rejection_reason=?,actual_size=?,completed_at=datetime('now'),completion_claimed_at=NULL",
        [reason, completedObject.size],
      ))) await failClosedAfterAuthorityLoss(true);
    } else {
      await database(env).prepare("UPDATE client_service_request_attachments SET status='rejected',rejection_reason=?,actual_size=?,completed_at=datetime('now'),completion_claimed_at=NULL,updated_at=datetime('now') WHERE id=? AND status='uploading' AND completion_claimed_at=?")
        .bind(reason, completedObject.size, row.id, completionClaim).run();
    }
    await env.DATA_BUCKET.delete(row.object_key);
    await database(env).prepare("DELETE FROM client_service_request_attachment_parts WHERE attachment_id=?").bind(row.id).run();
    throw new HTTPException(completedObject.size !== row.declared_size ? 422 : 415, { message: "The uploaded attachment did not match its declared file type and size" });
  }
  if (nativeProof) {
    if (!(await nativeCompletionMutation(
      "status='quarantined',actual_size=?,etag=?,completed_at=datetime('now'),completion_claimed_at=NULL",
      [completedObject.size, completedObject.etag],
    ))) await failClosedAfterAuthorityLoss(true);
  } else {
    await database(env).prepare("UPDATE client_service_request_attachments SET status='quarantined',actual_size=?,etag=?,completed_at=datetime('now'),completion_claimed_at=NULL,updated_at=datetime('now') WHERE id=? AND status='uploading' AND completion_claimed_at=?")
      .bind(completedObject.size, completedObject.etag, row.id, completionClaim).run();
  }
  await database(env).prepare("DELETE FROM client_service_request_attachment_parts WHERE attachment_id=?").bind(row.id).run();
  return { status: "quarantined", idempotent: false };
}

export async function acceptRequestAttachmentScanReceipt(env: Env, authorization: string | null, attachmentId: string, input: { verdict: "clean" | "rejected"; sha256: string }): Promise<"accepted" | "rejected"> {
  const expected = env.CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET || "";
  const supplied = (authorization || "").replace(/^Bearer\s+/i, "");
  if (expected.length < 32 || !supplied || !constantTimeEqual(expected, supplied)) throw new HTTPException(401, { message: "Invalid scanner credential" });
  if (!/^[a-f0-9]{64}$/i.test(input.sha256)) throw new HTTPException(400, { message: "A valid SHA-256 digest is required" });
  const row = await database(env).prepare("SELECT * FROM client_service_request_attachments WHERE id=?").bind(attachmentId).first<RequestAttachmentRow>();
  if (!row || !["quarantined", "scanning", "accepted", "rejected"].includes(row.status)) throw new HTTPException(404, { message: "Quarantined attachment not found" });
  if (row.status === "accepted" || row.status === "rejected") {
    if (row.verified_sha256 !== input.sha256.toLowerCase() || row.scanner_verdict !== input.verdict)
      throw new HTTPException(409, { message: "The scanner receipt does not match the recorded verdict" });
    if (row.status === "rejected") await deleteRemovedAttachmentObject(env, row);
    return row.status;
  }
  if (!(await env.DATA_BUCKET.head(row.object_key))) throw new HTTPException(409, { message: "The quarantined attachment is missing" });
  const status = input.verdict === "clean" ? "accepted" : "rejected";
  const db = database(env);
  const updated = await db.prepare("UPDATE client_service_request_attachments SET status=?,scanner_verdict=?,verified_sha256=?,scanned_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND submitted_request_id IS NULL AND status IN ('quarantined','scanning')")
    .bind(status, input.verdict, input.sha256.toLowerCase(), row.id).run();
  if (updated.meta.changes !== 1) {
    const current = await db.prepare("SELECT status,scanner_verdict,verified_sha256 FROM client_service_request_attachments WHERE id=?")
      .bind(row.id).first<Pick<RequestAttachmentRow, "status" | "scanner_verdict" | "verified_sha256">>();
    if (current && (current.status === "accepted" || current.status === "rejected")
      && current.verified_sha256 === input.sha256.toLowerCase() && current.scanner_verdict === input.verdict) {
      if (current.status === "rejected") await deleteRemovedAttachmentObject(env, row);
      return current.status;
    }
    throw new HTTPException(404, { message: "Quarantined attachment not found" });
  }
  if (status === "rejected") await deleteRemovedAttachmentObject(env, row);
  return status;
}

export async function readRequestAttachmentScanReceipt(request: Request): Promise<{ verdict: "clean" | "rejected"; sha256: string }> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && (!Number.isSafeInteger(Number(declared)) || Number(declared) < 0 || Number(declared) > 1024))
    throw new HTTPException(413, { message: "The scanner receipt is too large" });
  if (!request.body) throw new HTTPException(400, { message: "A scanner receipt is required" });
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 1024) { await reader.cancel(); throw new HTTPException(413, { message: "The scanner receipt is too large" }); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new HTTPException(400, { message: "A valid scanner receipt is required" }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HTTPException(400, { message: "A valid scanner receipt is required" });
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "verdict" && key !== "sha256") || (value.verdict !== "clean" && value.verdict !== "rejected") || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256))
    throw new HTTPException(400, { message: "A valid scanner receipt is required" });
  return { verdict: value.verdict, sha256: value.sha256.toLowerCase() };
}

export async function cleanupExpiredRequestAttachments(env: Env, now = new Date()): Promise<void> {
  const expired = await database(env).prepare("SELECT id,object_key,multipart_upload_id,status FROM client_service_request_attachments WHERE submitted_request_id IS NULL AND status IN ('uploading','quarantined','scanning') AND datetime(expires_at)<=datetime(?) LIMIT 100")
    .bind(now.toISOString()).all<{ id: string; object_key: string; multipart_upload_id: string; status: string }>();
  for (const row of expired.results) {
    try {
      if (row.status === "uploading" && !row.multipart_upload_id.startsWith("pending:")) await env.DATA_BUCKET.resumeMultipartUpload(row.object_key, row.multipart_upload_id).abort();
      await env.DATA_BUCKET.delete(row.object_key);
      await database(env).prepare("UPDATE client_service_request_attachments SET status='expired',updated_at=datetime(?) WHERE id=? AND submitted_request_id IS NULL AND status IN ('uploading','quarantined','scanning')")
        .bind(now.toISOString(), row.id).run();
      await database(env).prepare("DELETE FROM client_service_request_attachment_parts WHERE attachment_id=?").bind(row.id).run();
    } catch (error) {
      console.error(JSON.stringify({ event: "client-request-attachment.cleanup-failed", attachmentId: row.id, message: error instanceof Error ? error.message : "unknown" }));
    }
  }
}
