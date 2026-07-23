import { createRemoteJWKSet, jwtVerify } from "jose";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { requestPage } from "./page";
import { constantTimeEqual, createUploadSession, hasBlockedMagic, hmac, presignR2Part, validateIncomingFile, verifyUploadSession } from "./security";

type Env = {
  OPS_DB: D1Database;
  DELIVERY_DB: D1Database;
  INCOMING_BUCKET: R2Bucket;
  PUBLIC_BASE_URL: string;
  EXPECTED_HOST: string;
  ENVIRONMENT: string;
  TEAM_DOMAIN: string;
  OPERATIONS_AUD: string;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
  INCOMING_SESSION_SECRET: string;
  INCOMING_ACCESS_CODE_PEPPER: string;
  AUDIT_IP_SECRET: string;
  R2_ACCOUNT_ID: string;
  R2_INCOMING_BUCKET_NAME: string;
  R2_INCOMING_ACCESS_KEY_ID: string;
  R2_INCOMING_SECRET_ACCESS_KEY: string;
  INCOMING_PICKUP_SECRET: string;
  INCOMING_LIFECYCLE_WORKFLOW: Workflow;
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
  status: string;
}

const app = new Hono<{ Bindings: Env }>();
const json = <T extends z.ZodType>(schema: T, value: unknown): z.infer<T> => {
  const result = schema.safeParse(value);
  if (!result.success) throw new HTTPException(400, { message: "Invalid request" });
  return result.data;
};
const randomId = (bytes = 18): string => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const safeName = (value: string): string => value.normalize("NFC").replace(/[\\/\0-\x1f\x7f]/g, "_").replace(/^\.+/, "_").slice(0, 255);

async function requestRow(env: Env, publicId: string): Promise<RequestRow> {
  const row = await env.DELIVERY_DB.withSession("first-primary")
    .prepare(`SELECT id,public_id,title,expires_at,revoked_at,access_code_hash,max_files,max_bytes,reserved_files,reserved_bytes
      FROM file_requests WHERE public_id=?`).bind(publicId).first<RequestRow>();
  if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.now()) throw new HTTPException(404, { message: "This file request is unavailable" });
  return row;
}

async function exactLimit(env: Env, key: string, limit: number, periodSeconds: number): Promise<void> {
  const bucket = Math.floor(Date.now() / (periodSeconds * 1000));
  const result = await env.DELIVERY_DB.prepare(`INSERT INTO public_rate_limits (rate_key,window_bucket,count,expires_at)
    VALUES (?,?,1,datetime('now',?)) ON CONFLICT(rate_key,window_bucket) DO UPDATE SET count=count+1
    WHERE count < ?`).bind(key, bucket, `+${periodSeconds * 2} seconds`, limit).run();
  if (result.meta.changes !== 1) throw new HTTPException(429, { message: "Too many requests. Please wait and try again." });
}

async function validateTurnstile(env: Env, request: Request, token: string): Promise<void> {
  if (!env.TURNSTILE_SECRET) {
    if (env.ENVIRONMENT === "production") throw new HTTPException(503, { message: "Secure uploads are not configured" });
    return;
  }
  const body = new URLSearchParams({
    secret: env.TURNSTILE_SECRET,
    response: token,
    remoteip: request.headers.get("CF-Connecting-IP") || "",
    idempotency_key: crypto.randomUUID(),
  });
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  const result = await response.json<{ success?: boolean; hostname?: string }>();
  if (!response.ok || result.success !== true || result.hostname !== env.EXPECTED_HOST) {
    throw new HTTPException(403, { message: "Human verification failed" });
  }
}

async function contributor(env: Env, requestId: string, cookie: string | undefined): Promise<string> {
  return verifyUploadSession(env.INCOMING_SESSION_SECRET, cookie, requestId);
}

async function staff(request: Request, env: Env): Promise<{ id: string; email: string }> {
  const assertion = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!assertion) throw new HTTPException(401, { message: "Cloudflare Access authentication required" });
  let subject = "";
  let email = "";
  try {
    const issuer = env.TEAM_DOMAIN.replace(/\/$/, "");
    const verified = await jwtVerify(assertion, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)), {
      issuer, audience: env.OPERATIONS_AUD, algorithms: ["RS256"],
    });
    if (verified.payload.type !== "app" || typeof verified.payload.sub !== "string" || typeof verified.payload.email !== "string") throw new Error("human required");
    subject = verified.payload.sub;
    email = verified.payload.email.trim().toLowerCase();
  } catch {
    throw new HTTPException(401, { message: "Invalid Cloudflare Access authentication" });
  }
  const user = await env.OPS_DB.withSession("first-primary").prepare(
    "SELECT id,access_subject FROM staff_users WHERE email=? AND status='active'",
  ).bind(email).first<{ id: string; access_subject: string | null }>();
  if (!user || (user.access_subject && user.access_subject !== subject)) throw new HTTPException(403, { message: "Staff account is not authorized" });
  if (!user.access_subject) {
    const bound = await env.OPS_DB.prepare("UPDATE staff_users SET access_subject=?,last_seen_at=datetime('now'),updated_at=datetime('now') WHERE id=? AND access_subject IS NULL")
      .bind(subject, user.id).run();
    if (bound.meta.changes !== 1) throw new HTTPException(403, { message: "Staff identity could not be bound" });
  }
  const permission = await env.OPS_DB.withSession("first-primary").prepare(`SELECT
    EXISTS(SELECT 1 FROM staff_permission_overrides WHERE staff_id=? AND permission_key='delivery.share' AND effect='deny' AND scope='global') AS denied,
    (EXISTS(SELECT 1 FROM staff_permission_overrides WHERE staff_id=? AND permission_key='delivery.share' AND effect='allow' AND scope='global')
      OR EXISTS(SELECT 1 FROM staff_role_assignments a JOIN role_permissions p ON p.role_id=a.role_id
        WHERE a.staff_id=? AND a.scope='global' AND p.permission_key='delivery.share')) AS allowed`)
    .bind(user.id, user.id, user.id).first<{ denied: number; allowed: number }>();
  if (!permission || permission.denied || !permission.allowed) throw new HTTPException(403, { message: "Global delivery administration is required" });
  return { id: user.id, email };
}

function mutationOrigin(request: Request, env: Env): void {
  if (request.headers.get("Origin") !== new URL(env.PUBLIC_BASE_URL).origin) throw new HTTPException(403, { message: "Request origin was rejected" });
}

app.use("*", async (c, next) => {
  if (c.env.ENVIRONMENT === "production" && new URL(c.req.url).hostname !== c.env.EXPECTED_HOST) return c.text("Misdirected request", 421);
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Content-Security-Policy", "default-src 'none'; script-src 'self' https://challenges.cloudflare.com 'unsafe-inline'; frame-src https://challenges.cloudflare.com; style-src 'unsafe-inline'; connect-src 'self' https://*.r2.cloudflarestorage.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
});

app.get("/health", (c) => c.json({ ok: true }));
app.get("/r/:publicId", async (c) => {
  await requestRow(c.env, c.req.param("publicId"));
  return c.html(requestPage(c.req.param("publicId"), c.env.TURNSTILE_SITE_KEY), 200, {
    "Cache-Control": "private, no-store",
  });
});

app.post("/api/public/requests/:publicId/authorize", async (c) => {
  mutationOrigin(c.req.raw, c.env);
  const row = await requestRow(c.env, c.req.param("publicId"));
  const input = json(z.object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
    message: z.string().trim().max(2000).optional().default(""),
    accessCode: z.string().max(128).optional().default(""),
    turnstileToken: z.string().max(4096),
  }), await c.req.json());
  const address = await hmac(c.env.AUDIT_IP_SECRET, c.req.header("CF-Connecting-IP") || "unknown");
  await exactLimit(c.env, `incoming:authorize:${row.id}:${address}`, 10, 60);
  await validateTurnstile(c.env, c.req.raw, input.turnstileToken);
  if (row.access_code_hash) {
    const supplied = await hmac(c.env.INCOMING_ACCESS_CODE_PEPPER, `incoming-code:v1:${row.id}:${input.accessCode}`);
    if (!constantTimeEqual(supplied, row.access_code_hash)) throw new HTTPException(403, { message: "The access code is incorrect" });
  }
  const contributorId = crypto.randomUUID();
  await c.env.DELIVERY_DB.prepare(`INSERT INTO file_request_contributors
    (id,request_id,name,email,message,client_address_hash) VALUES (?,?,?,?,?,?)`)
    .bind(contributorId, row.id, input.name, input.email, input.message || null, address).run();
  const expiresAt = Math.min(Date.parse(row.expires_at), Date.now() + 60 * 60 * 1000);
  c.header("Set-Cookie", await createUploadSession(c.env.INCOMING_SESSION_SECRET, row.id, contributorId, expiresAt));
  c.header("Cache-Control", "no-store");
  return c.json({ ok: true, expiresAt: new Date(expiresAt).toISOString() });
});

app.post("/api/public/requests/:publicId/files/init", async (c) => {
  mutationOrigin(c.req.raw, c.env);
  const row = await requestRow(c.env, c.req.param("publicId"));
  const contributorId = await contributor(c.env, row.id, c.req.header("Cookie"));
  const input = json(z.object({
    name: z.string().max(255),
    size: z.number().int().positive(),
    contentType: z.string().min(1).max(255),
    lastModified: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  }), await c.req.json());
  const originalName = validateIncomingFile(input.name, input.contentType, input.size);
  const reserved = await c.env.DELIVERY_DB.prepare(`UPDATE file_requests SET reserved_files=reserved_files+1,
    reserved_bytes=reserved_bytes+?,updated_at=datetime('now') WHERE id=? AND revoked_at IS NULL
    AND datetime(expires_at)>datetime('now') AND reserved_files < max_files AND reserved_bytes+? <= max_bytes`)
    .bind(input.size, row.id, input.size).run();
  if (reserved.meta.changes !== 1) throw new HTTPException(413, { message: "This request has reached its file or size limit" });
  const fileId = crypto.randomUUID();
  const key = `quarantine/${row.id}/${fileId}/${safeName(originalName)}`;
  try {
    const multipart = await c.env.INCOMING_BUCKET.createMultipartUpload(key, {
      httpMetadata: { contentType: input.contentType },
      customMetadata: { requestId: row.id, contributorId, originalName: safeName(originalName), declaredSha256: input.sha256 || "" },
    });
    await c.env.DELIVERY_DB.prepare(`INSERT INTO file_request_uploads
      (id,request_id,contributor_id,object_key,upload_id,original_name,declared_size,content_type,declared_sha256,status)
      VALUES (?,?,?,?,?,?,?,?,?,'uploading')`).bind(
      fileId, row.id, contributorId, key, multipart.uploadId, originalName, input.size, input.contentType, input.sha256 || null,
    ).run();
    try {
      await c.env.INCOMING_LIFECYCLE_WORKFLOW.create({ id: fileId, params: { uploadId: fileId } });
    } catch (workflowError) {
      try { await multipart.abort(); } catch { /* best effort */ }
      await c.env.DELIVERY_DB.prepare("DELETE FROM file_request_uploads WHERE id=?").bind(fileId).run();
      throw workflowError;
    }
    return c.json({ fileId, partSize: 32 * 1024 * 1024 });
  } catch (error) {
    await c.env.DELIVERY_DB.prepare("UPDATE file_requests SET reserved_files=MAX(0,reserved_files-1),reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?")
      .bind(input.size, row.id).run();
    throw error;
  }
});

async function ownedUpload(env: Env, requestId: string, contributorId: string, fileId: string): Promise<UploadRow> {
  const upload = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,request_id,contributor_id,object_key,
    upload_id,original_name,declared_size,content_type,status FROM file_request_uploads WHERE id=? AND request_id=? AND contributor_id=?`)
    .bind(fileId, requestId, contributorId).first<UploadRow>();
  if (!upload) throw new HTTPException(404, { message: "Upload not found" });
  return upload;
}

app.post("/api/public/requests/:publicId/files/:fileId/part-ticket", async (c) => {
  mutationOrigin(c.req.raw, c.env);
  const row = await requestRow(c.env, c.req.param("publicId"));
  const contributorId = await contributor(c.env, row.id, c.req.header("Cookie"));
  const upload = await ownedUpload(c.env, row.id, contributorId, c.req.param("fileId"));
  if (upload.status !== "uploading") throw new HTTPException(409, { message: "Upload is not accepting parts" });
  const input = json(z.object({ partNumber: z.number().int().min(1).max(10_000) }), await c.req.json());
  await exactLimit(c.env, `incoming:parts:${upload.id}`, Math.min(10_000, Math.ceil(upload.declared_size / (5 * 1024 ** 2)) + 10), 3600);
  const url = await presignR2Part({
    accountId: c.env.R2_ACCOUNT_ID, bucket: c.env.R2_INCOMING_BUCKET_NAME, key: upload.object_key,
    uploadId: upload.upload_id, partNumber: input.partNumber, accessKeyId: c.env.R2_INCOMING_ACCESS_KEY_ID,
    secretAccessKey: c.env.R2_INCOMING_SECRET_ACCESS_KEY, expiresSeconds: 300,
  });
  c.header("Cache-Control", "no-store");
  return c.json({ url, expiresIn: 300 });
});

app.post("/api/public/requests/:publicId/files/:fileId/complete", async (c) => {
  mutationOrigin(c.req.raw, c.env);
  const row = await requestRow(c.env, c.req.param("publicId"));
  const contributorId = await contributor(c.env, row.id, c.req.header("Cookie"));
  const upload = await ownedUpload(c.env, row.id, contributorId, c.req.param("fileId"));
  if (upload.status !== "uploading") throw new HTTPException(409, { message: "Upload is not awaiting completion" });
  const input = json(z.object({ parts: z.array(z.object({ partNumber: z.number().int().min(1).max(10_000), etag: z.string().min(1).max(256) })).min(1).max(10_000) }), await c.req.json());
  const partNumbers = new Set(input.parts.map((part) => part.partNumber));
  if (partNumbers.size !== input.parts.length) throw new HTTPException(400, { message: "Duplicate multipart part" });
  const object = await c.env.INCOMING_BUCKET.resumeMultipartUpload(upload.object_key, upload.upload_id).complete(input.parts);
  if (object.size !== upload.declared_size) {
    await c.env.INCOMING_BUCKET.delete(upload.object_key);
    await c.env.DELIVERY_DB.batch([
      c.env.DELIVERY_DB.prepare("UPDATE file_request_uploads SET status='rejected',rejection_reason='size_mismatch',completed_at=datetime('now') WHERE id=?").bind(upload.id),
      c.env.DELIVERY_DB.prepare("UPDATE file_requests SET reserved_files=MAX(0,reserved_files-1),reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?").bind(upload.declared_size, row.id),
    ]);
    throw new HTTPException(422, { message: "Uploaded size did not match the selected file" });
  }
  const probe = await c.env.INCOMING_BUCKET.get(upload.object_key, { range: { offset: 0, length: Math.min(4096, object.size) } });
  if (!probe || hasBlockedMagic(new Uint8Array(await probe.arrayBuffer()))) {
    await c.env.INCOMING_BUCKET.delete(upload.object_key);
    await c.env.DELIVERY_DB.batch([
      c.env.DELIVERY_DB.prepare("UPDATE file_request_uploads SET status='rejected',rejection_reason='blocked_content',completed_at=datetime('now') WHERE id=?").bind(upload.id),
      c.env.DELIVERY_DB.prepare("UPDATE file_requests SET reserved_files=MAX(0,reserved_files-1),reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?").bind(upload.declared_size, row.id),
    ]);
    throw new HTTPException(415, { message: "The uploaded content type is not accepted" });
  }
  const transitioned = await c.env.DELIVERY_DB.prepare(`UPDATE file_request_uploads
    SET status='quarantined',actual_size=?,etag=?,completed_at=datetime('now')
    WHERE id=? AND status='uploading' AND EXISTS (
      SELECT 1 FROM file_requests
      WHERE id=file_request_uploads.request_id AND revoked_at IS NULL AND datetime(expires_at)>datetime('now')
    )`).bind(object.size, object.etag, upload.id).run();
  if (transitioned.meta.changes !== 1) {
    await c.env.INCOMING_BUCKET.delete(upload.object_key);
    await c.env.DELIVERY_DB.batch([
      c.env.DELIVERY_DB.prepare("UPDATE file_request_uploads SET status='rejected',rejection_reason='request_unavailable',completed_at=datetime('now') WHERE id=? AND status='uploading'").bind(upload.id),
      c.env.DELIVERY_DB.prepare("UPDATE file_requests SET reserved_files=MAX(0,reserved_files-1),reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?").bind(upload.declared_size, row.id),
    ]);
    throw new HTTPException(410, { message: "This file request is no longer accepting uploads" });
  }
  return c.json({ ok: true, status: "quarantined" });
});

app.post("/api/admin/requests", async (c) => {
  mutationOrigin(c.req.raw, c.env);
  const principal = await staff(c.req.raw, c.env);
  const input = json(z.object({
    title: z.string().trim().min(1).max(160),
    expiresInHours: z.number().int().min(1).max(7 * 24).default(7 * 24),
    accessCode: z.string().min(8).max(128).optional(),
    maxFiles: z.number().int().min(1).max(500).default(500),
    maxBytes: z.number().int().min(1).max(2 * 1024 ** 4).default(2 * 1024 ** 4),
  }), await c.req.json());
  const id = crypto.randomUUID();
  const publicId = randomId(24);
  const codeHash = input.accessCode ? await hmac(c.env.INCOMING_ACCESS_CODE_PEPPER, `incoming-code:v1:${id}:${input.accessCode}`) : null;
  await c.env.DELIVERY_DB.prepare(`INSERT INTO file_requests
    (id,public_id,title,created_by,expires_at,access_code_hash,max_files,max_bytes)
    VALUES (?,?,?,?,datetime('now',?),?,?,?)`).bind(
    id, publicId, input.title, principal.id, `+${input.expiresInHours} hours`, codeHash, input.maxFiles, input.maxBytes,
  ).run();
  return c.json({ id, url: `${c.env.PUBLIC_BASE_URL}/r/${publicId}`, expiresInHours: input.expiresInHours }, 201);
});

app.post("/api/internal/uploads/:uploadId/accepted", async (c) => {
  const authorization = c.req.header("Authorization") || "";
  const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!c.env.INCOMING_PICKUP_SECRET || !supplied || !constantTimeEqual(supplied, c.env.INCOMING_PICKUP_SECRET)) {
    throw new HTTPException(401, { message: "Invalid pickup credential" });
  }
  const input = json(z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/i) }), await c.req.json());
  const upload = await c.env.DELIVERY_DB.withSession("first-primary").prepare(
    "SELECT id,object_key,status FROM file_request_uploads WHERE id=?",
  ).bind(c.req.param("uploadId")).first<{ id: string; object_key: string; status: string }>();
  if (!upload || upload.status !== "quarantined") throw new HTTPException(404, { message: "Quarantined upload not found" });
  if (await c.env.INCOMING_BUCKET.head(upload.object_key)) {
    throw new HTTPException(409, { message: "Remove the quarantined object only after verified local promotion" });
  }
  const result = await c.env.DELIVERY_DB.prepare(`UPDATE file_request_uploads
    SET status='accepted',declared_sha256=?,updated_at=datetime('now')
    WHERE id=? AND status='quarantined'`).bind(input.sha256.toLowerCase(), upload.id).run();
  if (result.meta.changes !== 1) throw new HTTPException(409, { message: "Upload status changed" });
  return c.json({ ok: true, status: "accepted" });
});

app.get("/api/admin/requests", async (c) => {
  await staff(c.req.raw, c.env);
  const rows = await c.env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,public_id,title,expires_at,revoked_at,
    max_files,max_bytes,reserved_files,reserved_bytes,created_at FROM file_requests ORDER BY created_at DESC LIMIT 100`).all();
  return c.json({ requests: rows.results });
});

app.onError((error, c) => {
  if (error instanceof HTTPException) return c.json({ message: error.message }, error.status);
  console.error("incoming_request_failed", error);
  return c.json({ message: "Unexpected server error" }, 500);
});

interface LifecycleUpload {
  id: string; request_id: string; object_key: string; upload_id: string; declared_size: number; status: string;
}

async function lifecycleUpload(env: Env, uploadId: string): Promise<LifecycleUpload | null> {
  return env.DELIVERY_DB.withSession("first-primary").prepare(
    "SELECT id,request_id,object_key,upload_id,declared_size,status FROM file_request_uploads WHERE id=?",
  ).bind(uploadId).first<LifecycleUpload>();
}

async function expireUpload(env: Env, upload: LifecycleUpload): Promise<void> {
  if (upload.status === "uploading") {
    try { await env.INCOMING_BUCKET.resumeMultipartUpload(upload.object_key, upload.upload_id).abort(); } catch { /* already gone */ }
  } else {
    await env.INCOMING_BUCKET.delete(upload.object_key);
  }
  await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare("UPDATE file_request_uploads SET status='expired',updated_at=datetime('now') WHERE id=? AND status IN ('uploading','quarantined','rejected')").bind(upload.id),
    env.DELIVERY_DB.prepare("UPDATE file_requests SET reserved_files=MAX(0,reserved_files-1),reserved_bytes=MAX(0,reserved_bytes-?) WHERE id=?").bind(upload.declared_size, upload.request_id),
  ]);
}

export class IncomingUploadLifecycleWorkflow extends WorkflowEntrypoint<Env> {
  async run(event: Readonly<WorkflowEvent<{ uploadId: string }>>, step: WorkflowStep): Promise<void> {
    await step.sleep("incomplete-upload-window", "24 hours");
    const afterDay = await lifecycleUpload(this.env, event.payload.uploadId);
    if (!afterDay || afterDay.status === "accepted" || afterDay.status === "expired") return;
    if (afterDay.status === "uploading") {
      await step.do("expire-incomplete-upload", async () => { await expireUpload(this.env, afterDay); return { expired: true }; });
      return;
    }
    await step.sleep("quarantine-retention", "13 days");
    const afterRetention = await lifecycleUpload(this.env, event.payload.uploadId);
    if (!afterRetention || afterRetention.status === "accepted" || afterRetention.status === "expired") return;
    await step.do("expire-quarantined-upload", async () => { await expireUpload(this.env, afterRetention); return { expired: true }; });
  }
}

export default {
  fetch: (request: Request, env: Env, context: ExecutionContext) => app.fetch(request, env, context),
};
