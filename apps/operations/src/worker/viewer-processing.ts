import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  ViewerServiceError,
  type Permission,
  type ViewerProcessingEventV1,
  type ViewerProcessingPermission,
} from "@ltds/shared";
import { z } from "zod";
import { sqlScope } from "./acl";
import { sendAdminAlert } from "./alerts";
import { sendNotificationMail } from "./mailer";
import type { Env, StaffPrincipal } from "./types";
import { viewerIntegrationEnabled, viewerServiceClient } from "./viewer-integration";
import { defaultViewerUnits, resolveViewerUnits } from "./viewer-units";

type Variables = { principal: StaffPrincipal; administrator: boolean };
type ViewerApp = Hono<{ Bindings: Env; Variables: Variables }>;

const encoder = new TextEncoder();
const MAX_EVENT_BYTES = 16 * 1024;
const EVENT_CLOCK_SKEW_SECONDS = 300;
const opaqueId = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const unitsSchema = z.object({ displayUnits: z.enum(["imperial", "metric"]) }).strict();
const eventSchema = z.object({
  schemaVersion: z.literal(1),
  eventId: opaqueId,
  type: z.enum(["processing.ready_for_review", "processing.failed"]),
  occurredAt: z.iso.datetime({ offset: true }),
  projectId: opaqueId,
  taskId: opaqueId,
  attemptId: opaqueId,
  requestedBySubject: z.string().regex(/^ops:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  status: z.string().trim().min(1).max(80),
  error: z.object({
    code: z.string().trim().min(1).max(80),
    message: z.string().trim().min(1).max(500),
  }).strict().optional(),
  reviewUrl: z.url().max(2048).optional(),
}).strict().superRefine((value, context) => {
  if (value.type === "processing.failed" && !value.error)
    context.addIssue({ code: "custom", path: ["error"], message: "A failed event requires a safe error summary" });
  if (value.type === "processing.ready_for_review" && !value.reviewUrl)
    context.addIssue({ code: "custom", path: ["reviewUrl"], message: "A review-ready event requires a review URL" });
});

export function viewerProcessingEnabled(
  env: Pick<Env, "VIEWER_INTEGRATION_ENABLED" | "VIEWER_PROCESSING_ENABLED">,
): boolean {
  return viewerIntegrationEnabled(env) && env.VIEWER_PROCESSING_ENABLED === "true";
}

const viewerPermissionMapping: ReadonlyArray<{
  ops: Extract<Permission,
    "viewer.view" | "viewer.datasets.manage" | "viewer.processing.manage" |
    "viewer.publish" | "viewer.storage.purge">;
  viewer: readonly ViewerProcessingPermission[];
}> = [
  { ops: "viewer.view", viewer: [
    "viewer.projects.read", "viewer.datasets.read", "viewer.gcp.read", "viewer.processing.read", "viewer.providers.read",
  ] },
  { ops: "viewer.datasets.manage", viewer: [
    "viewer.projects.write", "viewer.datasets.write", "viewer.datasets.import",
  ] },
  { ops: "viewer.processing.manage", viewer: [
    "viewer.gcp.write", "viewer.processing.write", "viewer.providers.write",
  ] },
  { ops: "viewer.publish", viewer: ["viewer.processing.publish"] },
  { ops: "viewer.storage.purge", viewer: ["viewer.storage.purge"] },
];

export async function viewerAdminPermissions(
  env: Env,
  principal: StaffPrincipal,
): Promise<ViewerProcessingPermission[]> {
  const permissions: ViewerProcessingPermission[] = [];
  for (const mapping of viewerPermissionMapping) {
    const scope = await sqlScope(env, principal, mapping.ops);
    if (scope.global && !scope.deniedGlobal) permissions.push(...mapping.viewer);
  }
  return permissions;
}

function viewerError(error: unknown): never {
  if (error instanceof ViewerServiceError)
    throw new HTTPException(error.status as 404 | 409 | 503, { message: error.message });
  throw error;
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer));
  return [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function signViewerProcessingEvent(input: {
  secret: string;
  method: string;
  path: string;
  body: string;
  timestamp: number;
  nonce: string;
}): Promise<{ contentSha256: string; signature: string }> {
  const contentSha256 = await sha256Hex(encoder.encode(input.body));
  const canonical = [
    "ltds-viewer-event-v1", input.method.toUpperCase(), input.path,
    String(input.timestamp), input.nonce, contentSha256,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(input.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return {
    contentSha256,
    signature: base64Url(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical))),
  };
}

async function boundedBody(request: Request): Promise<string> {
  const declared = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(declared) && declared > MAX_EVENT_BYTES)
    throw new HTTPException(413, { message: "Viewer event is too large" });
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_EVENT_BYTES) {
      await reader.cancel();
      throw new HTTPException(413, { message: "Viewer event is too large" });
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function safeEventMessage(value: string): string {
  return value
    .replace(/\b(?:bearer|token|secret|password|authorization)\s*[:=]?\s*\S+/gi, "[redacted]")
    .replace(/(?:[A-Za-z]:\\|\/mnt\/|\/home\/|\/data\/)[^\s]+/g, "[path redacted]")
    .slice(0, 500);
}

function validateReviewUrl(env: Env, value: string | undefined, attemptId: string): string | null {
  if (!value) return null;
  try {
    const base = new URL(env.PUBLIC_BASE_URL), url = new URL(value);
    if (base.protocol !== "https:" || base.username || base.password ||
      url.protocol !== "https:" || url.username || url.password || url.hash ||
      url.origin !== base.origin || url.pathname !== "/operations/processing" ||
      url.search !== `?attemptId=${encodeURIComponent(attemptId)}`)
      throw new Error("canonical_url");
    return `${base.origin}/operations/processing?attemptId=${encodeURIComponent(attemptId)}`;
  } catch {
    throw new HTTPException(400, { message: "Operations review URL is invalid" });
  }
}

async function verifyEventSignature(env: Env, request: Request, body: string): Promise<{
  keyId: string; nonce: string; bodyHash: string;
}> {
  const keyId = request.headers.get("X-LTDS-Viewer-Key-Id") || "";
  const timestampText = request.headers.get("X-LTDS-Viewer-Timestamp") || "";
  const nonce = request.headers.get("X-LTDS-Viewer-Nonce") || "";
  const bodyHash = request.headers.get("X-LTDS-Viewer-Content-SHA256") || "";
  const signature = request.headers.get("X-LTDS-Viewer-Signature") || "";
  const secret = keyId === env.VIEWER_EVENT_KEY_ID
    ? env.VIEWER_EVENT_HMAC_SECRET
    : keyId === env.VIEWER_EVENT_PREVIOUS_KEY_ID
      ? env.VIEWER_EVENT_PREVIOUS_HMAC_SECRET
      : undefined;
  if (!secret || secret.length < 32 ||
    !/^\d{10}$/.test(timestampText) || !/^[A-Za-z0-9._:-]{16,128}$/.test(nonce) ||
    !/^[a-f0-9]{64}$/.test(bodyHash) || !/^[A-Za-z0-9_-]{43,88}$/.test(signature))
    throw new HTTPException(401, { message: "Viewer event authentication failed" });
  const timestamp = Number(timestampText);
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > EVENT_CLOCK_SKEW_SECONDS)
    throw new HTTPException(401, { message: "Viewer event authentication failed" });
  const expected = await signViewerProcessingEvent({
    secret, method: request.method,
    path: new URL(request.url).pathname, body, timestamp, nonce,
  });
  if (expected.contentSha256 !== bodyHash)
    throw new HTTPException(401, { message: "Viewer event authentication failed" });
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
  const supplied = signature.replace(/-/g, "+").replace(/_/g, "/");
  const padded = supplied + "=".repeat((4 - supplied.length % 4) % 4);
  let bytes: Uint8Array;
  try { bytes = Uint8Array.from(atob(padded), character => character.charCodeAt(0)); }
  catch { throw new HTTPException(401, { message: "Viewer event authentication failed" }); }
  const canonical = [
    "ltds-viewer-event-v1", request.method.toUpperCase(), new URL(request.url).pathname,
    timestampText, nonce, bodyHash,
  ].join("\n");
  if (!await crypto.subtle.verify("HMAC", key, new Uint8Array(bytes).buffer, encoder.encode(canonical)))
    throw new HTTPException(401, { message: "Viewer event authentication failed" });
  return { keyId, nonce, bodyHash };
}

export async function pruneViewerEventNonces(env: Pick<Env, "OPS_DB">): Promise<number> {
  const expired = await env.OPS_DB.prepare(
    "DELETE FROM viewer_event_nonces WHERE datetime(expires_at)<=datetime('now')",
  ).run();
  return expired.meta.changes || 0;
}

interface NotificationRow {
  id: string;
  event_id: string;
  event_type: "processing.ready_for_review" | "processing.failed";
  task_id: string;
  attempt_id: string;
  requested_by_subject: string;
  error_message: string | null;
  review_url: string | null;
  attempt_count: number;
}

export async function processViewerProcessingNotifications(env: Env): Promise<number> {
  if (!viewerProcessingEnabled(env)) return 0;
  let processed = 0;
  for (; processed < 20; processed += 1) {
    const row = await env.OPS_DB.prepare(`SELECT outbox.id,outbox.event_id,outbox.attempt_count,
      event.event_type,event.task_id,event.attempt_id,event.requested_by_subject,event.error_message,event.review_url
      FROM viewer_processing_notification_outbox outbox
      JOIN viewer_processing_events event ON event.event_id=outbox.event_id
      WHERE ((outbox.status='pending' AND datetime(outbox.next_attempt_at)<=datetime('now'))
        OR (outbox.status='processing' AND datetime(outbox.lease_expires_at)<=datetime('now')))
        AND outbox.attempt_count<3 ORDER BY outbox.created_at LIMIT 1`).first<NotificationRow>();
    if (!row) break;
    const claimed = await env.OPS_DB.prepare(`UPDATE viewer_processing_notification_outbox SET
      status='processing',attempt_count=attempt_count+1,lease_expires_at=datetime('now','+10 minutes'),updated_at=datetime('now')
      WHERE id=? AND attempt_count<3 AND ((status='pending' AND datetime(next_attempt_at)<=datetime('now'))
        OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))`)
      .bind(row.id).run();
    if (!claimed.meta.changes) { processed -= 1; continue; }
    const staffId = row.requested_by_subject.slice(4);
    const recipient = await env.OPS_DB.prepare(
      "SELECT email FROM staff_users WHERE id=? AND status='active'",
    ).bind(staffId).first<string>("email") || env.ALERT_TO || null;
    if (!recipient || !/^\S+@\S+\.\S+$/.test(recipient)) {
      await env.OPS_DB.prepare(`UPDATE viewer_processing_notification_outbox SET
        status='suppressed',lease_expires_at=NULL,last_error='recipient-unavailable',updated_at=datetime('now') WHERE id=?`)
        .bind(row.id).run();
      continue;
    }
    const failed = row.event_type === "processing.failed";
    const subject = failed ? "3D processing failed" : "3D model ready for review";
    const text = failed
      ? `Task ${row.task_id}, attempt ${row.attempt_id}: ${row.error_message || "Processing failed"}`
      : `Task ${row.task_id}, attempt ${row.attempt_id} is ready for review.${row.review_url ? `\n\nReview: ${row.review_url}` : ""}`;
    try {
      await sendNotificationMail(env, {
        to: recipient, fromName: "LTDS 3D Processing", subject, text,
        html: `<p>${text.replace(/[&<>]/g, value => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[value]!)
          .replace(/\n\n/g, "</p><p>")}</p>`,
        messageIdKey: row.id,
      });
      await env.OPS_DB.prepare(`UPDATE viewer_processing_notification_outbox SET
        status='sent',delivered_at=datetime('now'),lease_expires_at=NULL,updated_at=datetime('now') WHERE id=?`)
        .bind(row.id).run();
    } catch (error) {
      const attempt = row.attempt_count + 1, terminal = attempt >= 3;
      const message = safeEventMessage(error instanceof Error ? error.message : "notification-send-failed");
      await env.OPS_DB.prepare(`UPDATE viewer_processing_notification_outbox SET status=?,
        next_attempt_at=datetime('now',?),lease_expires_at=NULL,last_error=?,updated_at=datetime('now') WHERE id=?`)
        .bind(terminal ? "failed" : "pending", terminal ? "+0 seconds" : `+${2 ** attempt * 5} minutes`, message, row.id).run();
      if (terminal) await sendAdminAlert(env, "3D processing notification failed", `Event ${row.event_id}: ${message}`);
    }
  }
  return processed;
}

export function viewerMachineEventRequest(method: string, path: string): boolean {
  return method.toUpperCase() === "POST" && path === "/api/viewer/events";
}

export function registerViewerProcessingRoutes(app: ViewerApp): void {
  app.post("/api/viewer/events", async c => {
    if (!viewerProcessingEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const rawBody = await boundedBody(c.req.raw);
    const authenticated = await verifyEventSignature(c.env, c.req.raw, rawBody);
    const suppliedIdempotency = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    let decoded: unknown;
    try { decoded = JSON.parse(rawBody); }
    catch { throw new HTTPException(400, { message: "Viewer event must be JSON" }); }
    const parsed = eventSchema.safeParse(decoded);
    if (!parsed.success || !suppliedIdempotency.success || suppliedIdempotency.data !== parsed.data.eventId)
      throw new HTTPException(400, { message: "Viewer event is invalid" });
    const event: ViewerProcessingEventV1 = parsed.data;
    if (Math.abs(Date.now() - Date.parse(event.occurredAt)) > 24 * 60 * 60 * 1000)
      throw new HTTPException(400, { message: "Viewer event time is invalid" });
    const reviewUrl = validateReviewUrl(c.env, event.reviewUrl, event.attemptId);
    const errorMessage = event.error ? safeEventMessage(event.error.message) : null;
    const sanitized = JSON.stringify({
      ...event,
      ...(event.error ? { error: { code: event.error.code, message: errorMessage } } : {}),
      ...(reviewUrl ? { reviewUrl } : {}),
    });
    const expiry = new Date(Date.now() + EVENT_CLOCK_SKEW_SECONDS * 2 * 1000).toISOString();
    const existing = await c.env.OPS_DB.prepare(
      "SELECT request_fingerprint FROM viewer_processing_events WHERE event_id=?",
    ).bind(event.eventId).first<string>("request_fingerprint");
    if (existing && existing !== authenticated.bodyHash)
      throw new HTTPException(409, { message: "Viewer event id was already used for a different event" });
    const nonceCount = await c.env.OPS_DB.prepare(
      "SELECT COUNT(*) count FROM viewer_event_nonces WHERE datetime(expires_at)>datetime('now')",
    ).first<number>("count") || 0;
    if (nonceCount >= 20_000)
      throw new HTTPException(503, { message: "Viewer event replay protection is temporarily at capacity" });
    const results = await c.env.OPS_DB.batch([
      c.env.OPS_DB.prepare(`INSERT OR IGNORE INTO viewer_event_nonces(key_id,nonce,expires_at)
        VALUES(?,?,?)`).bind(authenticated.keyId, authenticated.nonce, expiry),
      c.env.OPS_DB.prepare(`INSERT OR IGNORE INTO viewer_processing_events(
        event_id,event_type,occurred_at,project_id,task_id,attempt_id,requested_by_subject,status,
        error_code,error_message,review_url,request_fingerprint,idempotency_key,payload_json)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1`).bind(
        event.eventId, event.type, event.occurredAt, event.projectId, event.taskId, event.attemptId,
        event.requestedBySubject, event.status, event.error?.code || null, errorMessage, reviewUrl,
        authenticated.bodyHash, suppliedIdempotency.data, sanitized,
      ),
      c.env.OPS_DB.prepare(`INSERT OR IGNORE INTO viewer_processing_notification_outbox(id,event_id)
        SELECT ?,? WHERE changes()=1`).bind(`viewer-processing:${event.eventId}`, event.eventId),
      c.env.OPS_DB.prepare(`INSERT INTO audit_events(
        actor_type,actor_id,action,entity_type,entity_id,details_json)
        SELECT 'integration',?,'viewer.processing.event.received','viewer_processing_attempt',?,?
        WHERE changes()=1`).bind(authenticated.keyId, event.attemptId, JSON.stringify({
        eventId: event.eventId, type: event.type, projectId: event.projectId, taskId: event.taskId,
      })),
    ]);
    const created = Boolean(results[1]?.meta.changes);
    if (!created) {
      const raced = await c.env.OPS_DB.prepare(
        "SELECT request_fingerprint FROM viewer_processing_events WHERE event_id=?",
      ).bind(event.eventId).first<string>("request_fingerprint");
      if (raced && raced !== authenticated.bodyHash)
        throw new HTTPException(409, { message: "Viewer event id was already used for a different event" });
      if (!raced)
        throw new HTTPException(409, { message: "Viewer event nonce was already used" });
    }
    return c.json({ accepted: true, replayed: !created }, created ? 202 : 200);
  });

  app.get("/api/viewer/processing", async c => {
    const principal = c.get("principal");
    const permissions = await viewerAdminPermissions(c.env, principal);
    if (!permissions.includes("viewer.projects.read"))
      throw new HTTPException(403, { message: "Global viewer.view permission required" });
    const units = await resolveViewerUnits(c.env, principal.id);
    const events = viewerProcessingEnabled(c.env)
      ? await c.env.OPS_DB.prepare(`SELECT event_id,event_type,occurred_at,project_id,task_id,attempt_id,
          status,error_code,error_message,review_url,acknowledged_at,received_at
          FROM viewer_processing_events ORDER BY received_at DESC LIMIT 50`).all()
      : { results: [] };
    return c.json({
      enabled: viewerProcessingEnabled(c.env),
      viewerBaseUrl: c.env.VIEWER_BASE_URL || null,
      permissions,
      units: { default: defaultViewerUnits(c.env), resolved: units },
      events: events.results,
    });
  });

  app.post("/api/viewer/admin-grant", async c => {
    if (!viewerProcessingEnabled(c.env)) throw new HTTPException(404, { message: "Not found" });
    const principal = c.get("principal");
    const key = idempotencyKey.safeParse(c.req.header("Idempotency-Key"));
    if (!key.success) throw new HTTPException(400, { message: "A valid Idempotency-Key is required" });
    const permissions = await viewerAdminPermissions(c.env, principal);
    if (!permissions.includes("viewer.projects.read"))
      throw new HTTPException(403, { message: "Global viewer.view permission required" });
    const units = await resolveViewerUnits(c.env, principal.id);
    try {
      const grant = await viewerServiceClient(c.env).createAdminGrant({
        subject: `ops:${principal.id}`.slice(0, 200), permissions,
        authorizationExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        displayUnits: units,
        idempotencyKey: key.data,
      });
      return c.json({ ...grant, units: { default: defaultViewerUnits(c.env), resolved: units } }, 201);
    } catch (error) { return viewerError(error); }
  });

  app.get("/api/viewer/preferences", async c => {
    const principal = c.get("principal");
    const scope = await sqlScope(c.env, principal, "viewer.view");
    if (!scope.global || scope.deniedGlobal)
      throw new HTTPException(403, { message: "Global viewer.view permission required" });
    return c.json({ default: defaultViewerUnits(c.env), resolved: await resolveViewerUnits(c.env, principal.id) });
  });

  app.patch("/api/viewer/preferences", async c => {
    const principal = c.get("principal");
    const scope = await sqlScope(c.env, principal, "viewer.view");
    if (!scope.global || scope.deniedGlobal)
      throw new HTTPException(403, { message: "Global viewer.view permission required" });
    const value = unitsSchema.safeParse(await c.req.json().catch(() => null));
    if (!value.success) throw new HTTPException(400, { message: "Display units are invalid" });
    await c.env.OPS_DB.prepare(`INSERT INTO viewer_staff_preferences(staff_id,display_units,updated_at)
      VALUES(?,?,datetime('now')) ON CONFLICT(staff_id) DO UPDATE SET
      display_units=excluded.display_units,updated_at=excluded.updated_at`)
      .bind(principal.id, value.data.displayUnits).run();
    return c.json({ default: defaultViewerUnits(c.env), resolved: value.data.displayUnits });
  });

  app.post("/api/viewer/events/:eventId/acknowledge", async c => {
    const principal = c.get("principal");
    const scope = await sqlScope(c.env, principal, "viewer.view");
    const eventId = opaqueId.safeParse(c.req.param("eventId"));
    if (!scope.global || scope.deniedGlobal)
      throw new HTTPException(403, { message: "Global viewer.view permission required" });
    if (!eventId.success) throw new HTTPException(400, { message: "Viewer event is invalid" });
    const result = await c.env.OPS_DB.prepare(`UPDATE viewer_processing_events SET
      acknowledged_at=COALESCE(acknowledged_at,datetime('now')),
      acknowledged_by_staff_id=COALESCE(acknowledged_by_staff_id,?) WHERE event_id=?`)
      .bind(principal.id, eventId.data).run();
    if (!result.meta.changes) throw new HTTPException(404, { message: "Viewer event not found" });
    return c.json({ acknowledged: true });
  });
}
