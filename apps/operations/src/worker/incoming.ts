import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requirePermission } from "./acl";
import { auditStatement } from "./request-security";
import { hmac, randomToken } from "./crypto";
import {
  createIncomingSession,
  hasBlockedIncomingMagic,
  incomingConstantTimeEqual,
  incomingMultipartPartSize,
  presignIncomingPart,
  validateIncomingFile,
  verifyIncomingSession,
} from "./incoming-security";
import { incomingRequestPage } from "./incoming-page";
import {
  INCOMING_UPLOADS_DISABLED_CODE,
  INCOMING_UPLOADS_DISABLED_MESSAGE,
  incomingPublicRequestDecision,
  incomingUploadsCapability,
} from "./incoming-policy";
import type { Env, StaffPrincipal } from "./types";

export type IncomingEnv = Env & {
  INCOMING_BUCKET: R2Bucket;
  INCOMING_UPLOADS_ENABLED?: string;
  INCOMING_BASE_URL: string;
  INCOMING_EXPECTED_HOST?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET: string;
  INCOMING_SESSION_SECRET: string;
  INCOMING_ACCESS_CODE_PEPPER: string;
  INCOMING_PICKUP_SECRET: string;
  R2_INCOMING_BUCKET_NAME: string;
  INCOMING_LIFECYCLE_WORKFLOW?: Workflow;
};

type StaffVariables = {
  principal: StaffPrincipal;
  administrator: boolean;
};

interface RequestRow {
  id: string;
  public_id: string;
  title: string;
  expires_at: string;
  revoked_at: string | null;
  access_code_hash: string | null;
  max_files: number;
  max_bytes: number;
  reserved_files: number;
  reserved_bytes: number;
  session_version: number;
}

interface UploadRow {
  id: string;
  request_id: string;
  contributor_id: string;
  object_key: string;
  upload_id: string;
  original_name: string;
  declared_size: number;
  content_type: string;
  declared_sha256: string | null;
  client_upload_id: string | null;
  completion_claimed_at?: string | null;
  quota_released_at?: string | null;
  status: string;
}

interface PartCheckpoint {
  partNumber: number;
  etag: string;
  size: number;
}

const SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const NEVER_EXPIRES = "9999-12-31T23:59:59.000Z";

function parseJson<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new HTTPException(400, { message: "Invalid request" });
  return result.data;
}

async function jsonBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const value = await request.json().catch(() => {
    throw new HTTPException(400, { message: "Request body must be JSON" });
  });
  return parseJson(schema, value);
}

function safeName(value: string): string {
  return value.normalize("NFC").replace(/[\\/\0-\x1f\x7f]/g, "_").replace(/^\.+/, "_").slice(0, 255);
}

async function activeRequest(env: IncomingEnv, publicId: string): Promise<RequestRow> {
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT id,public_id,title,expires_at,revoked_at,access_code_hash,max_files,max_bytes,reserved_files,reserved_bytes,session_version
     FROM file_requests WHERE public_id=?`,
  ).bind(publicId).first<RequestRow>();
  if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) {
    throw new HTTPException(404, { message: "This file request is unavailable" });
  }
  return row;
}

async function exactLimit(env: IncomingEnv, key: string, limit: number, periodSeconds: number): Promise<void> {
  const bucket = Math.floor(Date.now() / (periodSeconds * 1000));
  const result = await env.DELIVERY_DB.prepare(
    `INSERT INTO public_rate_limits (rate_key,window_bucket,count,expires_at)
     VALUES (?,?,1,datetime('now',?))
     ON CONFLICT(rate_key,window_bucket) DO UPDATE SET count=count+1 WHERE count < ?`,
  ).bind(key, bucket, `+${periodSeconds * 2} seconds`, limit).run();
  if (result.meta.changes !== 1) {
    throw new HTTPException(429, { message: "Too many requests. Please wait and try again." });
  }
}

async function validateTurnstile(env: IncomingEnv, request: Request, token: string): Promise<void> {
  if (!env.TURNSTILE_SECRET) {
    if (env.ENVIRONMENT === "production") {
      throw new HTTPException(503, { message: "Secure uploads are not configured" });
    }
    return;
  }
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET,
      response: token,
      remoteip: request.headers.get("CF-Connecting-IP") || "",
      idempotency_key: crypto.randomUUID(),
    }),
  });
  const result = await response.json<{ success?: boolean; hostname?: string }>();
  const expectedHost = env.INCOMING_EXPECTED_HOST || new URL(env.INCOMING_BASE_URL).hostname;
  if (!response.ok || result.success !== true || result.hostname !== expectedHost) {
    throw new HTTPException(403, { message: "Human verification failed" });
  }
}

function requirePublicOrigin(request: Request, env: IncomingEnv): void {
  if (request.headers.get("Origin") !== new URL(env.INCOMING_BASE_URL).origin) {
    throw new HTTPException(403, { message: "Request origin was rejected" });
  }
}

async function addressHash(env: IncomingEnv, request: Request): Promise<string> {
  return hmac(env.AUDIT_IP_SECRET, request.headers.get("CF-Connecting-IP") || "unknown");
}

async function session(
  env: IncomingEnv,
  row: RequestRow,
  request: Request,
): Promise<{ contributorId: string; cookie: string }> {
  const verified = await verifyIncomingSession(env.INCOMING_SESSION_SECRET, request.headers.get("Cookie") || undefined, row.id, row.session_version);
  const expiresAt = Math.min(Date.parse(row.expires_at), Date.now() + SESSION_WINDOW_MS);
  return {
    contributorId: verified.contributorId,
    cookie: await createIncomingSession(env.INCOMING_SESSION_SECRET, row.id, verified.contributorId, row.session_version, expiresAt),
  };
}

async function ownedUpload(
  env: IncomingEnv,
  requestId: string,
  contributorId: string,
  fileId: string,
): Promise<UploadRow> {
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,content_type,
      declared_sha256,client_upload_id,completion_claimed_at,quota_released_at,status
     FROM file_request_uploads WHERE id=? AND request_id=? AND contributor_id=?`,
  ).bind(fileId, requestId, contributorId).first<UploadRow>();
  if (!row) throw new HTTPException(404, { message: "Upload not found" });
  return row;
}

async function checkpoints(env: IncomingEnv, uploadId: string): Promise<PartCheckpoint[]> {
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT part_number partNumber,etag,size
     FROM file_request_upload_parts WHERE upload_id=? ORDER BY part_number`,
  ).bind(uploadId).all<PartCheckpoint>();
  return rows.results;
}

async function deterministicFileId(
  env: IncomingEnv,
  requestId: string,
  contributorId: string,
  clientUploadId: string,
): Promise<string> {
  return `inc_${await hmac(env.INCOMING_SESSION_SECRET, `incoming-upload:v1:${requestId}:${contributorId}:${clientUploadId}`)}`;
}

async function releaseQuota(env: IncomingEnv, upload: Pick<UploadRow, "id" | "request_id" | "declared_size">, from: string[]): Promise<boolean> {
  const placeholders = from.map(() => "?").join(",");
  const changed = await env.DELIVERY_DB.prepare(
    `UPDATE file_request_uploads SET status='expired',updated_at=datetime('now')
     WHERE id=? AND status IN (${placeholders})
     RETURNING id`,
  ).bind(upload.id, ...from).first<{ id: string }>();
  if (!changed) return false;
  await releaseReservedQuota(env, upload);
  return true;
}

async function releaseReservedQuota(
  env: IncomingEnv,
  upload: Pick<UploadRow, "id" | "request_id" | "declared_size">,
): Promise<boolean> {
  const changed = await env.DELIVERY_DB.prepare(
    `UPDATE file_request_uploads SET quota_released_at=datetime('now'),updated_at=datetime('now')
     WHERE id=? AND quota_released_at IS NULL RETURNING id`,
  ).bind(upload.id).first<{ id: string }>();
  if (!changed) return false;
  await env.DELIVERY_DB.prepare(
    `UPDATE file_requests SET reserved_files=MAX(0,reserved_files-1),
     reserved_bytes=MAX(0,reserved_bytes-?),updated_at=datetime('now') WHERE id=?`,
  ).bind(upload.declared_size, upload.request_id).run();
  return true;
}

const publicApp = new Hono<{ Bindings: IncomingEnv }>();

publicApp.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("X-Robots-Tag", "noindex, nofollow");
  if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
});

publicApp.get("/health", (c) => c.json({ ok: true, service: "ltds-ops-incoming" }));

publicApp.get("/r/:publicId", async (c) => {
  const row = await activeRequest(c.env, c.req.param("publicId"));
  return c.html(incomingRequestPage({
    publicId: row.public_id,
    title: row.title,
    turnstileSiteKey: c.env.TURNSTILE_SITE_KEY,
  }), 200, {
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
});

publicApp.post("/api/public/requests/:publicId/authorize", async (c) => {
  requirePublicOrigin(c.req.raw, c.env);
  const row = await activeRequest(c.env, c.req.param("publicId"));
  const input = await jsonBody(c.req.raw, z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
    message: z.string().trim().max(2000).optional().default(""),
    accessCode: z.string().max(128).optional().default(""),
    turnstileToken: z.string().max(4096),
  }));
  const address = await addressHash(c.env, c.req.raw);
  await exactLimit(c.env, `incoming:authorize:${row.id}:${address}`, 10, 60);
  await validateTurnstile(c.env, c.req.raw, input.turnstileToken);
  if (row.access_code_hash) {
    const supplied = await hmac(c.env.INCOMING_ACCESS_CODE_PEPPER, `incoming-code:v1:${row.id}:${input.accessCode}`);
    if (!incomingConstantTimeEqual(supplied, row.access_code_hash)) {
      throw new HTTPException(403, { message: "The access code is incorrect" });
    }
  }
  let contributorId: string | undefined;
  try {
    contributorId = (await verifyIncomingSession(
      c.env.INCOMING_SESSION_SECRET,
      c.req.header("Cookie"),
      row.id,
      row.session_version,
    )).contributorId;
  } catch {
    // A missing or expired session starts a new contributor identity.
  }
  if (!contributorId) {
    contributorId = crypto.randomUUID();
    await c.env.DELIVERY_DB.prepare(
      `INSERT INTO file_request_contributors
       (id,request_id,name,email,message,client_address_hash) VALUES (?,?,?,?,?,?)`,
    ).bind(contributorId, row.id, input.name, input.email, input.message || null, address).run();
  }
  const expiresAt = Math.min(Date.parse(row.expires_at), Date.now() + SESSION_WINDOW_MS);
  c.header("Set-Cookie", await createIncomingSession(c.env.INCOMING_SESSION_SECRET, row.id, contributorId, row.session_version, expiresAt));
  return c.json({ ok: true, expiresAt: new Date(expiresAt).toISOString() });
});

publicApp.post("/api/public/requests/:publicId/files/init", async (c) => {
  requirePublicOrigin(c.req.raw, c.env);
  const row = await activeRequest(c.env, c.req.param("publicId"));
  const current = await session(c.env, row, c.req.raw);
  c.header("Set-Cookie", current.cookie);
  const input = await jsonBody(c.req.raw, z.object({
    clientUploadId: z.string().trim().min(8).max(160),
    name: z.string().max(255),
    size: z.number().int().positive(),
    contentType: z.string().min(1).max(255),
    lastModified: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  }));
  const originalName = validateIncomingFile(input.name, input.contentType, input.size);
  const fileId = await deterministicFileId(c.env, row.id, current.contributorId, input.clientUploadId);
  const existing = await c.env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,content_type,
      declared_sha256,client_upload_id,completion_claimed_at,quota_released_at,status
     FROM file_request_uploads WHERE id=?`,
  ).bind(fileId).first<UploadRow>();
  if (existing) {
    if (
      existing.request_id !== row.id
      || existing.contributor_id !== current.contributorId
      || existing.client_upload_id !== input.clientUploadId
      || existing.original_name !== originalName
      || existing.declared_size !== input.size
      || existing.content_type !== input.contentType
      || (existing.declared_sha256 || null) !== (input.sha256?.toLowerCase() || null)
    ) {
      throw new HTTPException(409, { message: "This client upload ID belongs to a different file" });
    }
    if (existing.upload_id.startsWith("pending:")) {
      throw new HTTPException(409, { message: "Upload initialization is already in progress; retry shortly" });
    }
    return c.json({
      fileId: existing.id,
      partSize: incomingMultipartPartSize(existing.declared_size),
      status: existing.status,
      completedParts: await checkpoints(c.env, existing.id),
      resumed: true,
    });
  }

  const reserved = await c.env.DELIVERY_DB.prepare(
    `UPDATE file_requests SET reserved_files=reserved_files+1,reserved_bytes=reserved_bytes+?,updated_at=datetime('now')
     WHERE id=? AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')
     AND reserved_files < max_files AND reserved_bytes+? <= max_bytes`,
  ).bind(input.size, row.id, input.size).run();
  if (reserved.meta.changes !== 1) {
    throw new HTTPException(413, { message: "This request has reached its file or size limit" });
  }

  const key = `quarantine/${row.id}/${fileId}/object`;
  const pendingUploadId = `pending:${randomToken(12)}`;
  let multipart: R2MultipartUpload | undefined;
  let reservationReleased = false;
  try {
    try {
      await c.env.DELIVERY_DB.prepare(
        `INSERT INTO file_request_uploads
         (id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,content_type,
          declared_sha256,client_upload_id,status)
         VALUES (?,?,?,?,?,?,?,?,?,?,'uploading')`,
      ).bind(
        fileId,
        row.id,
        current.contributorId,
        key,
        pendingUploadId,
        originalName,
        input.size,
        input.contentType,
        input.sha256?.toLowerCase() || null,
        input.clientUploadId,
      ).run();
    } catch (insertError) {
      await c.env.DELIVERY_DB.prepare(
        `UPDATE file_requests SET reserved_files=MAX(0,reserved_files-1),
         reserved_bytes=MAX(0,reserved_bytes-?),updated_at=datetime('now') WHERE id=?`,
      ).bind(input.size, row.id).run();
      reservationReleased = true;
      const raced = await c.env.DELIVERY_DB.withSession("first-primary").prepare(
        `SELECT id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,content_type,
          declared_sha256,client_upload_id,completion_claimed_at,quota_released_at,status
         FROM file_request_uploads WHERE id=?`,
      ).bind(fileId).first<UploadRow>();
      if (!raced) throw insertError;
      if (
        raced.request_id !== row.id
        || raced.contributor_id !== current.contributorId
        || raced.client_upload_id !== input.clientUploadId
        || raced.original_name !== originalName
        || raced.declared_size !== input.size
        || raced.content_type !== input.contentType
        || (raced.declared_sha256 || null) !== (input.sha256?.toLowerCase() || null)
      ) {
        throw new HTTPException(409, { message: "This client upload ID belongs to a different file" });
      }
      throw new HTTPException(409, { message: "Upload initialization is already in progress; retry shortly" });
    }

    multipart = await c.env.INCOMING_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: {
        requestId: row.id,
        contributorId: current.contributorId,
        originalName: safeName(originalName),
      },
    });
    const initialized = await c.env.DELIVERY_DB.prepare(
      `UPDATE file_request_uploads SET upload_id=?,updated_at=datetime('now')
       WHERE id=? AND upload_id=? AND status='uploading'`,
    ).bind(multipart.uploadId, fileId, pendingUploadId).run();
    if (initialized.meta.changes !== 1) {
      await multipart.abort();
      throw new Error("Incoming upload initialization lost its D1 claim");
    }
    if (c.env.INCOMING_LIFECYCLE_WORKFLOW) {
      try {
        await c.env.INCOMING_LIFECYCLE_WORKFLOW.create({ id: fileId, params: { uploadId: fileId } });
      } catch (workflowError) {
        try { await multipart.abort(); } catch { /* best effort */ }
        await c.env.DELIVERY_DB.prepare("DELETE FROM file_request_uploads WHERE id=?").bind(fileId).run();
        throw workflowError;
      }
    }
    return c.json({
      fileId,
      partSize: incomingMultipartPartSize(input.size),
      status: "uploading",
      completedParts: [],
      resumed: false,
    });
  } catch (error) {
    if (multipart) {
      try { await multipart.abort(); } catch { /* best effort */ }
    }
    await c.env.DELIVERY_DB.prepare("DELETE FROM file_request_uploads WHERE id=? AND status='uploading'")
      .bind(fileId).run();
    if (!reservationReleased) {
      await c.env.DELIVERY_DB.prepare(
        `UPDATE file_requests SET reserved_files=MAX(0,reserved_files-1),
         reserved_bytes=MAX(0,reserved_bytes-?),updated_at=datetime('now') WHERE id=?`,
      ).bind(input.size, row.id).run();
    }
    throw error;
  }
});

publicApp.post("/api/public/requests/:publicId/files/:fileId/part-ticket", async (c) => {
  requirePublicOrigin(c.req.raw, c.env);
  const row = await activeRequest(c.env, c.req.param("publicId"));
  const current = await session(c.env, row, c.req.raw);
  c.header("Set-Cookie", current.cookie);
  const upload = await ownedUpload(c.env, row.id, current.contributorId, c.req.param("fileId"));
  if (upload.status !== "uploading") throw new HTTPException(409, { message: "Upload is not accepting parts" });
  const input = await jsonBody(c.req.raw, z.object({ partNumber: z.number().int().min(1).max(10_000) }));
  const partSize = incomingMultipartPartSize(upload.declared_size);
  if (input.partNumber > Math.ceil(upload.declared_size / partSize)) {
    throw new HTTPException(400, { message: "Part number exceeds the file size" });
  }
  await exactLimit(c.env, `incoming:parts:${upload.id}`, Math.ceil(upload.declared_size / partSize) * 4 + 20, 3600);
  const url = await presignIncomingPart({
    accountId: c.env.R2_ACCOUNT_ID,
    bucket: c.env.R2_INCOMING_BUCKET_NAME,
    key: upload.object_key,
    uploadId: upload.upload_id,
    partNumber: input.partNumber,
    accessKeyId: c.env.R2_ACCESS_KEY_ID || "",
    secretAccessKey: c.env.R2_SECRET_ACCESS_KEY || "",
    expiresSeconds: 300,
  });
  return c.json({ url, expiresIn: 300, partNumber: input.partNumber });
});

publicApp.put("/api/public/requests/:publicId/files/:fileId/parts/:partNumber", async (c) => {
  requirePublicOrigin(c.req.raw, c.env);
  const row = await activeRequest(c.env, c.req.param("publicId"));
  const current = await session(c.env, row, c.req.raw);
  c.header("Set-Cookie", current.cookie);
  const upload = await ownedUpload(c.env, row.id, current.contributorId, c.req.param("fileId"));
  if (upload.status !== "uploading") throw new HTTPException(409, { message: "Upload is not accepting parts" });
  const partNumber = Number(c.req.param("partNumber"));
  const input = await jsonBody(c.req.raw, z.object({
    etag: z.string().trim().min(1).max(256),
    size: z.number().int().positive(),
  }));
  const partSize = incomingMultipartPartSize(upload.declared_size);
  const partCount = Math.ceil(upload.declared_size / partSize);
  const expectedSize = partNumber === partCount
    ? upload.declared_size - partSize * (partCount - 1)
    : partSize;
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCount || input.size !== expectedSize) {
    throw new HTTPException(400, { message: "Invalid part checkpoint" });
  }
  await c.env.DELIVERY_DB.prepare(
    `INSERT INTO file_request_upload_parts (upload_id,part_number,etag,size)
     VALUES (?,?,?,?)
     ON CONFLICT(upload_id,part_number) DO UPDATE SET
       etag=excluded.etag,size=excluded.size,updated_at=datetime('now')`,
  ).bind(upload.id, partNumber, input.etag, input.size).run();
  return c.json({ ok: true, partNumber });
});

publicApp.get("/api/public/requests/:publicId/files/:fileId/resume", async (c) => {
  const row = await activeRequest(c.env, c.req.param("publicId"));
  const current = await session(c.env, row, c.req.raw);
  c.header("Set-Cookie", current.cookie);
  const upload = await ownedUpload(c.env, row.id, current.contributorId, c.req.param("fileId"));
  return c.json({
    fileId: upload.id,
    status: upload.status,
    partSize: incomingMultipartPartSize(upload.declared_size),
    completedParts: await checkpoints(c.env, upload.id),
  });
});

publicApp.post("/api/public/requests/:publicId/files/:fileId/complete", async (c) => {
  requirePublicOrigin(c.req.raw, c.env);
  const row = await activeRequest(c.env, c.req.param("publicId"));
  const current = await session(c.env, row, c.req.raw);
  c.header("Set-Cookie", current.cookie);
  const upload = await ownedUpload(c.env, row.id, current.contributorId, c.req.param("fileId"));
  if (upload.status === "quarantined" || upload.status === "accepted") {
    return c.json({ ok: true, status: upload.status, idempotent: true });
  }
  if (upload.status !== "uploading") throw new HTTPException(409, { message: "Upload is not awaiting completion" });
  const input = await jsonBody(c.req.raw, z.object({
    parts: z.array(z.object({
      partNumber: z.number().int().min(1).max(10_000),
      etag: z.string().min(1).max(256),
    })).min(1).max(10_000),
  }));
  const saved = await checkpoints(c.env, upload.id);
  if (
    saved.length !== input.parts.length
    || saved.some((part, index) =>
      part.partNumber !== input.parts[index]?.partNumber || part.etag !== input.parts[index]?.etag)
  ) {
    throw new HTTPException(409, { message: "Upload checkpoints do not match the completion request" });
  }
  const claim = await c.env.DELIVERY_DB.prepare(
    `UPDATE file_request_uploads SET completion_claimed_at=datetime('now'),updated_at=datetime('now')
     WHERE id=? AND status='uploading' AND completion_claimed_at IS NULL RETURNING id`,
  ).bind(upload.id).first<{ id: string }>();
  if (!claim) throw new HTTPException(409, { message: "Upload completion is already in progress" });
  let object: R2Object;
  try {
    object = await c.env.INCOMING_BUCKET
      .resumeMultipartUpload(upload.object_key, upload.upload_id)
      .complete(input.parts);
  } catch (error) {
    const completed=await c.env.INCOMING_BUCKET.head(upload.object_key);
    if(completed&&completed.size===upload.declared_size)object=completed;
    else{
      await c.env.DELIVERY_DB.prepare(
        `UPDATE file_request_uploads SET completion_claimed_at=NULL,updated_at=datetime('now')
         WHERE id=? AND status='uploading'`,
      ).bind(upload.id).run();
      throw error;
    }
  }
  if (object.size !== upload.declared_size) {
    await c.env.INCOMING_BUCKET.delete(upload.object_key);
    await c.env.DELIVERY_DB.prepare(
      `UPDATE file_request_uploads SET status='rejected',rejection_reason='size_mismatch',
       completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='uploading'`,
    ).bind(upload.id).run();
    await releaseReservedQuota(c.env, upload);
    throw new HTTPException(422, { message: "Uploaded size did not match the selected file" });
  }
  const probe = await c.env.INCOMING_BUCKET.get(upload.object_key, {
    range: { offset: 0, length: Math.min(4096, object.size) },
  });
  if (!probe || hasBlockedIncomingMagic(new Uint8Array(await probe.arrayBuffer()))) {
    await c.env.INCOMING_BUCKET.delete(upload.object_key);
    await c.env.DELIVERY_DB.prepare(
      `UPDATE file_request_uploads SET status='rejected',rejection_reason='blocked_content',
       completed_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND status='uploading'`,
    ).bind(upload.id).run();
    await releaseReservedQuota(c.env, upload);
    throw new HTTPException(415, { message: "The uploaded content type is not accepted" });
  }
  const transitioned = await c.env.DELIVERY_DB.prepare(
    `UPDATE file_request_uploads SET status='quarantined',actual_size=?,etag=?,
     completed_at=datetime('now'),updated_at=datetime('now')
     WHERE id=? AND status='uploading' AND EXISTS (
       SELECT 1 FROM file_requests WHERE id=file_request_uploads.request_id
       AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')
     )`,
  ).bind(object.size, object.etag, upload.id).run();
  if (transitioned.meta.changes !== 1) {
    await c.env.INCOMING_BUCKET.delete(upload.object_key);
    await releaseQuota(c.env, upload, ["uploading"]);
    throw new HTTPException(410, { message: "This file request is no longer accepting uploads" });
  }
  return c.json({ ok: true, status: "quarantined", idempotent: false });
});

publicApp.post("/api/internal/uploads/:uploadId/accepted", async (c) => {
  const supplied = (c.req.header("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (
    !c.env.INCOMING_PICKUP_SECRET
    || !supplied
    || !incomingConstantTimeEqual(supplied, c.env.INCOMING_PICKUP_SECRET)
  ) {
    throw new HTTPException(401, { message: "Invalid pickup credential" });
  }
  const input = await jsonBody(c.req.raw, z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/i) }));
  const upload = await c.env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT id,request_id,object_key,declared_size,status
     FROM file_request_uploads WHERE id=?`,
  ).bind(c.req.param("uploadId")).first<UploadRow>();
  if (!upload) throw new HTTPException(404, { message: "Quarantined upload not found" });
  if (upload.status === "accepted") return c.json({ ok: true, status: "accepted", idempotent: true });
  if (upload.status !== "quarantined") throw new HTTPException(404, { message: "Quarantined upload not found" });
  if (await c.env.INCOMING_BUCKET.head(upload.object_key)) {
    throw new HTTPException(409, { message: "Remove the quarantined object only after verified local promotion" });
  }
  const result = await c.env.DELIVERY_DB.prepare(
    `UPDATE file_request_uploads SET status='accepted',verified_sha256=?,updated_at=datetime('now')
     WHERE id=? AND status='quarantined'`,
  ).bind(input.sha256.toLowerCase(), upload.id).run();
  if (result.meta.changes !== 1) throw new HTTPException(409, { message: "Upload status changed" });
  await releaseReservedQuota(c.env, upload);
  return c.json({ ok: true, status: "accepted", idempotent: false });
});

publicApp.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
  console.error("incoming_request_failed", error);
  return c.json({ message: "Unexpected server error" }, 500);
});

export function isIncomingPublicRequest(request: Request, env: IncomingEnv): boolean {
  const expected = env.INCOMING_EXPECTED_HOST || new URL(env.INCOMING_BASE_URL).hostname;
  return new URL(request.url).hostname === expected;
}

export function dispatchIncomingPublicRequest(
  request: Request,
  env: IncomingEnv,
  context: ExecutionContext,
): Response | Promise<Response> | null {
  if (!isIncomingPublicRequest(request, env)) return null;
  const decision = incomingPublicRequestDecision(env, request.method, new URL(request.url).pathname);
  if (decision === "health") {
    return Response.json(
      { status: "ok", service: "ltds-ops-incoming", incomingUploads: incomingUploadsCapability(env) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  if (decision === "disabled") {
    return Response.json(
      { error: INCOMING_UPLOADS_DISABLED_CODE, message: INCOMING_UPLOADS_DISABLED_MESSAGE },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Cloudflare-CDN-Cache-Control": "no-store",
          "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
          "Referrer-Policy": "no-referrer",
          "X-Content-Type-Options": "nosniff",
          "X-Robots-Tag": "noindex, nofollow",
        },
      },
    );
  }
  return publicApp.fetch(request, env, context);
}

const staffApp = new Hono<{ Bindings: IncomingEnv; Variables: StaffVariables }>();

staffApp.use("*", async (c, next) => {
  if (!incomingUploadsCapability(c.env).enabled) {
    return c.json(
      { error: INCOMING_UPLOADS_DISABLED_CODE, message: INCOMING_UPLOADS_DISABLED_MESSAGE },
      503,
    );
  }
  await next();
});

async function requireIncomingStaff(c: {
  env: IncomingEnv;
  get(name: "principal"): StaffPrincipal;
}, permission: "file_requests.view" | "file_requests.create" | "file_requests.manage"): Promise<StaffPrincipal> {
  const principal = c.get("principal");
  await requirePermission(c.env, principal, permission);
  return principal;
}

async function currentLink(env: IncomingEnv): Promise<Record<string, unknown> | null> {
  return env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT r.id,r.public_id publicId,r.title,r.access_code_hash IS NOT NULL hasAccessCode,
      r.max_files maxFiles,r.max_bytes maxBytes,r.reserved_files reservedFiles,r.reserved_bytes reservedBytes,
      r.created_at createdAt,
      (SELECT COUNT(*) FROM file_request_uploads u WHERE u.request_id=r.id AND u.status='quarantined') pendingFiles,
      (SELECT COUNT(*) FROM file_request_uploads u WHERE u.request_id=r.id AND u.status='accepted') acceptedFiles
     FROM incoming_link_state s
     JOIN file_requests r ON r.id=s.active_request_id
     WHERE s.slot='default' AND r.revoked_at IS NULL AND datetime(r.expires_at)>datetime('now')
     LIMIT 1`,
  ).first<Record<string, unknown>>();
}

async function recentUploads(env: IncomingEnv, requestId: string): Promise<unknown[]> {
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT u.id,u.original_name fileName,u.declared_size size,u.status,
      COALESCE(u.completed_at,u.created_at) uploadedAt,c.name contributorName
     FROM file_request_uploads u
     JOIN file_request_contributors c ON c.id=u.contributor_id
     WHERE u.request_id=? ORDER BY u.created_at DESC LIMIT 25`,
  ).bind(requestId).all();
  return rows.results;
}

async function createReusableLink(
  env: IncomingEnv,
  principal: StaffPrincipal,
  input: { title: string; accessCode?: string; maxFiles: number; maxBytes: number },
  rotate: boolean,
): Promise<Record<string, unknown>> {
  const existing = await currentLink(env);
  if (existing && !rotate) return existing;
  const id = crypto.randomUUID();
  const publicId = randomToken(24);
  const codeHash = input.accessCode
    ? await hmac(env.INCOMING_ACCESS_CODE_PEPPER, `incoming-code:v1:${id}:${input.accessCode}`)
    : null;
  const statements: D1PreparedStatement[] = [];
  if (rotate) {
    statements.push(env.DELIVERY_DB.prepare(
      `UPDATE file_requests SET revoked_at=datetime('now'),revoked_reason='rotated',updated_at=datetime('now')
       WHERE id=(SELECT active_request_id FROM incoming_link_state WHERE slot='default')
       AND revoked_at IS NULL`,
    ));
  }
  statements.push(env.DELIVERY_DB.prepare(
    `INSERT INTO file_requests
     (id,public_id,title,created_by,expires_at,access_code_hash,max_files,max_bytes)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).bind(id, publicId, input.title, principal.id, NEVER_EXPIRES, codeHash, input.maxFiles, input.maxBytes));
  statements.push(env.DELIVERY_DB.prepare(
    `INSERT INTO incoming_link_state (slot,active_request_id,updated_at)
     VALUES ('default',?,datetime('now'))
     ON CONFLICT(slot) DO UPDATE SET active_request_id=excluded.active_request_id,updated_at=datetime('now')`,
  ).bind(id));
  await env.DELIVERY_DB.batch(statements);
  return {
    id,
    publicId,
    title: input.title,
    hasAccessCode: Boolean(codeHash),
    maxFiles: input.maxFiles,
    maxBytes: input.maxBytes,
    reservedFiles: 0,
    reservedBytes: 0,
    pendingFiles: 0,
    acceptedFiles: 0,
    createdAt: new Date().toISOString(),
  };
}

const linkSchema = z.object({
  title: z.string().trim().min(1).max(160).default("Send files to Ledge Top Drone Services"),
  accessCode: z.string().min(8).max(128).optional(),
  maxFiles: z.number().int().min(1).max(500).default(500),
  maxBytes: z.number().int().min(1).max(2 * 1024 ** 4).default(2 * 1024 ** 4),
});

staffApp.get("/", async (c) => {
  await requireIncomingStaff(c, "file_requests.view");
  const link = await currentLink(c.env);
  const uploads=link?await recentUploads(c.env,String(link.id)):[];
  return c.json({
    link: link
      ? {
          id:String(link.id),
          url:`${c.env.INCOMING_BASE_URL}/r/${String(link.publicId)}`,
          accessCodeProtected:Boolean(link.hasAccessCode),
          createdAt:String(link.createdAt),
          outstandingFiles:Number(link.reservedFiles||0),
          outstandingBytes:Number(link.reservedBytes||0),
          recentUploads:uploads,
        }
      : null,
  });
});

staffApp.post("/", async (c) => {
  const principal = await requireIncomingStaff(c, "file_requests.create");
  const input = await jsonBody(c.req.raw, linkSchema);
  const link = await createReusableLink(c.env, principal, input, false);
  await c.env.OPS_DB.batch([await auditStatement(c.env,c.req.raw,principal,"file_request.link.created","file_request",String(link.id),null,{accessCodeProtected:Boolean(link.hasAccessCode)})]);
  return c.json({ link: { ...link, url: `${c.env.INCOMING_BASE_URL}/r/${String(link.publicId)}` } }, 201);
});

staffApp.post("/rotate", async (c) => {
  const principal = await requireIncomingStaff(c, "file_requests.manage");
  const input = await jsonBody(c.req.raw, linkSchema);
  const link = await createReusableLink(c.env, principal, input, true);
  await c.env.OPS_DB.batch([await auditStatement(c.env,c.req.raw,principal,"file_request.link.rotated","file_request",String(link.id),null,{accessCodeProtected:Boolean(link.hasAccessCode)})]);
  return c.json({ link: { ...link, url: `${c.env.INCOMING_BASE_URL}/r/${String(link.publicId)}` } }, 201);
});

staffApp.patch("/", async (c) => {
  const principal=await requireIncomingStaff(c, "file_requests.manage");
  const input = await jsonBody(c.req.raw, z.object({
    title: z.string().trim().min(1).max(160).optional(),
    accessCode: z.union([z.string().min(8).max(128), z.null()]).optional(),
    maxFiles: z.number().int().min(1).max(500).optional(),
    maxBytes: z.number().int().min(1).max(2 * 1024 ** 4).optional(),
  }));
  const link = await currentLink(c.env);
  if (!link) throw new HTTPException(404, { message: "Incoming link not found" });
  const id = String(link.id);
  const codeHash = input.accessCode === undefined
    ? undefined
    : input.accessCode === null
      ? null
      : await hmac(c.env.INCOMING_ACCESS_CODE_PEPPER, `incoming-code:v1:${id}:${input.accessCode}`);
  const updates: string[] = [];
  const values: unknown[] = [];
  if (input.title !== undefined) { updates.push("title=?"); values.push(input.title); }
  if (codeHash !== undefined) { updates.push("access_code_hash=?","session_version=session_version+1"); values.push(codeHash); }
  if (input.maxFiles !== undefined) { updates.push("max_files=MAX(reserved_files,?)"); values.push(input.maxFiles); }
  if (input.maxBytes !== undefined) { updates.push("max_bytes=MAX(reserved_bytes,?)"); values.push(input.maxBytes); }
  if (!updates.length) throw new HTTPException(400, { message: "No changes were supplied" });
  updates.push("updated_at=datetime('now')");
  await c.env.DELIVERY_DB.prepare(`UPDATE file_requests SET ${updates.join(",")} WHERE id=?`)
    .bind(...values, id).run();
  await c.env.OPS_DB.batch([await auditStatement(c.env,c.req.raw,principal,"file_request.link.updated","file_request",id,null,{accessCodeChanged:codeHash!==undefined,limitsChanged:input.maxFiles!==undefined||input.maxBytes!==undefined})]);
  return c.json({ ok: true });
});

staffApp.delete("/", async (c) => {
  const principal=await requireIncomingStaff(c, "file_requests.manage");
  const current=await currentLink(c.env);
  const result = await c.env.DELIVERY_DB.batch([
    c.env.DELIVERY_DB.prepare(
      `UPDATE file_requests SET revoked_at=datetime('now'),revoked_reason='staff_revoked',updated_at=datetime('now')
       WHERE id=(SELECT active_request_id FROM incoming_link_state WHERE slot='default')
       AND revoked_at IS NULL`,
    ),
    c.env.DELIVERY_DB.prepare(
      "UPDATE incoming_link_state SET active_request_id=NULL,updated_at=datetime('now') WHERE slot='default'",
    ),
  ]);
  if(current)await c.env.OPS_DB.batch([await auditStatement(c.env,c.req.raw,principal,"file_request.link.revoked","file_request",String(current.id),null)]);
  return c.json({ ok: true, revoked: result[0]?.meta.changes || 0 });
});

staffApp.get("/uploads", async (c) => {
  await requireIncomingStaff(c, "file_requests.view");
  const link = await currentLink(c.env);
  if (!link) return c.json({ uploads: [] });
  const rows = await c.env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT u.id,u.original_name originalName,u.declared_size declaredSize,u.actual_size actualSize,
      u.content_type contentType,u.status,u.rejection_reason rejectionReason,u.created_at createdAt,
      u.completed_at completedAt,c.name contributorName,c.email contributorEmail
     FROM file_request_uploads u
     JOIN file_request_contributors c ON c.id=u.contributor_id
     WHERE u.request_id=? ORDER BY u.created_at DESC LIMIT 100`,
  ).bind(String(link.id)).all();
  return c.json({ uploads: rows.results });
});

staffApp.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error("incoming_staff_request_failed", error);
  return c.json({ error: "Unexpected server error" }, 500);
});

export function createIncomingStaffRouter(): typeof staffApp {
  return staffApp;
}

interface LifecycleUpload {
  id: string;
  request_id: string;
  object_key: string;
  upload_id: string;
  declared_size: number;
  status: string;
}

async function lifecycleUpload(env: IncomingEnv, uploadId: string): Promise<LifecycleUpload | null> {
  return env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT id,request_id,object_key,upload_id,declared_size,status
     FROM file_request_uploads WHERE id=?`,
  ).bind(uploadId).first<LifecycleUpload>();
}

async function expireUpload(env: IncomingEnv, upload: LifecycleUpload): Promise<void> {
  if (upload.status === "uploading") {
    try {
      await env.INCOMING_BUCKET.resumeMultipartUpload(upload.object_key, upload.upload_id).abort();
    } catch {
      // The multipart upload may already have been aborted by R2 lifecycle cleanup.
    }
  } else {
    await env.INCOMING_BUCKET.delete(upload.object_key);
  }
  await releaseQuota(env, upload, ["uploading", "quarantined", "rejected"]);
  await env.DELIVERY_DB.prepare("DELETE FROM file_request_upload_parts WHERE upload_id=?").bind(upload.id).run();
}

export class IncomingUploadLifecycleWorkflow extends WorkflowEntrypoint<IncomingEnv, { uploadId: string }> {
  async run(event: Readonly<WorkflowEvent<{ uploadId: string }>>, step: WorkflowStep): Promise<void> {
    await step.sleep("incomplete-upload-window", "24 hours");
    const afterDay = await lifecycleUpload(this.env, event.payload.uploadId);
    if (!afterDay || afterDay.status === "accepted" || afterDay.status === "expired") return;
    if (afterDay.status === "uploading") {
      await step.do("expire-incomplete-upload", async () => {
        await expireUpload(this.env, afterDay);
        return { expired: true };
      });
      return;
    }
    await step.sleep("quarantine-retention", "13 days");
    const afterRetention = await lifecycleUpload(this.env, event.payload.uploadId);
    if (!afterRetention || afterRetention.status === "accepted" || afterRetention.status === "expired") return;
    await step.do("expire-quarantined-upload", async () => {
      await expireUpload(this.env, afterRetention);
      return { expired: true };
    });
  }
}
