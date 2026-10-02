import { ViewerServiceError, viewerServiceOrigin } from "@ltds/shared";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { authenticateBoundStaffForViewerRenewal } from "./auth";
import { hmac, timingSafeEqual } from "./crypto";
import { consumeNativeStaffOnboardingRateLimit } from "./native-staff-onboarding-rate-limit";
import { requestHostAllowed } from "./host-admission";
import { viewerAdminPermissions, viewerProcessingEnabled } from "./viewer-processing";
import { viewerServiceClient } from "./viewer-integration";
import { resolveViewerUnits } from "./viewer-units";
import type { Env } from "./types";

const PATH = "/api/viewer/workspace/session-renewal";
const CHALLENGE_PATH = `${PATH}/challenge`;
const CHALLENGE_WINDOW_SECONDS = 300;
const CHALLENGE_ACCEPTED_BUCKETS = 2;
const MAX_BODY_BYTES = 2048;
const requestSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().uuid(),
  // A correlation handle only: this is never accepted as proof of Viewer or
  // Operations identity. Echoing it lets the Viewer discard a late response
  // after its in-memory workspace session has changed.
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  subject: z.string().min(1).max(200),
}).strict();

function configuredOrigin(env: Env): string | null {
  return viewerServiceOrigin(env.VIEWER_BASE_URL || "");
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers": "Retry-After",
    "Vary": "Origin",
    "Cache-Control": "no-store",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
  });
}

function json(origin: string | null, value: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "application/json; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-store");
  responseHeaders.set("Pragma", "no-cache");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  if (origin) for (const [key, item] of corsHeaders(origin)) responseHeaders.set(key, item);
  return new Response(JSON.stringify(value), { status, headers: responseHeaders });
}

function disabled(): Response {
  return json(null, { error: "Not found" }, 404);
}

function requestOrigin(request: Request, env: Env): string | null {
  const expected = configuredOrigin(env);
  const supplied = request.headers.get("Origin");
  return expected && supplied === expected ? expected : null;
}

function challengeMessage(origin: string, subject: string, bucket: number): string {
  return `ltds-viewer-renewal-csrf:v1\n${origin}\n${subject}\n${bucket}`;
}

async function consumeRenewalQuota(request: Request, env: Env, staffId: string): Promise<boolean> {
  const address = request.headers.get("CF-Connecting-IP") || "unknown";
  const [subjectHash, addressHash] = await Promise.all([
    hmac(env.OPERATIONS_SESSION_SECRET, `viewer-workspace-renewal:subject:${staffId}`),
    hmac(env.OPERATIONS_SESSION_SECRET, `viewer-workspace-renewal:ip:${address}`),
  ]);
  try {
    const subjectAllowed = await consumeNativeStaffOnboardingRateLimit(env.OPS_DB, `subject:${subjectHash}`, 12, 60);
    if (!subjectAllowed) return false;
    return await consumeNativeStaffOnboardingRateLimit(env.OPS_DB, `ip:${addressHash}`, 30, 60);
  } catch {
    throw new HTTPException(503, { message: "Workspace renewal is temporarily unavailable" });
  }
}

function validPreflight(request: Request): boolean {
  if (request.headers.get("Access-Control-Request-Method") !== "POST") return false;
  const requested = (request.headers.get("Access-Control-Request-Headers") || "")
    .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
  const allowed = new Set(["content-type", "idempotency-key", "x-csrf-token"]);
  return requested.length > 0 && requested.every(value => allowed.has(value));
}

async function handle(request: Request, env: Env): Promise<Response> {
  if (env.ENVIRONMENT !== "staging" || env.VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED !== "true" || !viewerProcessingEnabled(env))
    return disabled();
  if (!requestHostAllowed(request.url, env)) return json(null, { error: "Request host was rejected" }, 403);
  const origin = requestOrigin(request, env);
  if (!origin) return json(null, { error: "Request origin was rejected" }, 403);

  if (request.method === "OPTIONS") {
    if (new URL(request.url).pathname !== PATH || !validPreflight(request))
      return json(origin, { error: "CORS preflight was rejected" }, 403, { Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers" });
    const headers = corsHeaders(origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key, X-CSRF-Token");
    headers.set("Access-Control-Max-Age", "60");
    headers.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
    return new Response(null, { status: 204, headers });
  }

  try {
    if (request.method !== "GET" && request.method !== "POST")
      return json(origin, { error: "Method not allowed" }, 405, { Allow: "GET, POST, OPTIONS" });
    if (request.method === "GET" && new URL(request.url).pathname !== CHALLENGE_PATH)
      return json(origin, { error: "Not found" }, 404);
    if (request.method === "POST" && new URL(request.url).pathname !== PATH)
      return json(origin, { error: "Not found" }, 404);

    const verified = await authenticateBoundStaffForViewerRenewal(request, env);
    if (await consumeRenewalQuota(request, env, verified.principal.id) === false)
      return json(origin, { error: "Workspace renewal rate limit exceeded" }, 429, { "Retry-After": "60" });

    if (request.method === "GET") {
      const bucket = Math.floor(Date.now() / (CHALLENGE_WINDOW_SECONDS * 1000));
      const challenge = await hmac(env.OPERATIONS_SESSION_SECRET,
        challengeMessage(origin, verified.principal.accessSubject, bucket));
      return json(origin, { protocolVersion: 1, challenge, expiresAt: Math.min((bucket + 1) * CHALLENGE_WINDOW_SECONDS, verified.expiresAt) });
    }

    const contentLength = request.headers.get("Content-Length");
    const length = contentLength === null ? null : Number(contentLength);
    if ((length !== null && (!Number.isSafeInteger(length) || length < 1 || length > MAX_BODY_BYTES)))
      return json(origin, { error: "Request body is too large or invalid" }, 413);
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || ""))
      return json(origin, { error: "JSON content type required" }, 415);
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES)
      return json(origin, { error: "Request body is too large" }, 413);
    let decoded: unknown;
    try { decoded = JSON.parse(rawBody); } catch { return json(origin, { error: "Invalid JSON body" }, 400); }
    const parsed = requestSchema.safeParse(decoded);
    if (!parsed.success) return json(origin, { error: "Invalid renewal request" }, 400);
    const requestId = parsed.data.requestId;
    if (request.headers.get("Idempotency-Key") !== requestId)
      return json(origin, { error: "Renewal correlation and idempotency keys must match" }, 400);
    if (parsed.data.subject !== `ops:${verified.principal.id}`)
      return json(origin, { error: "Renewal subject does not match the authenticated Operations identity" }, 403);
    const csrf = request.headers.get("X-CSRF-Token") || "";
    const bucket = Math.floor(Date.now() / (CHALLENGE_WINDOW_SECONDS * 1000));
    const candidateBuckets = Array.from({ length: CHALLENGE_ACCEPTED_BUCKETS }, (_value, index) => bucket - index);
    const challengeMatches = await Promise.all(candidateBuckets.map(async value =>
      timingSafeEqual(csrf, await hmac(env.OPERATIONS_SESSION_SECRET,
        challengeMessage(origin, verified.principal.accessSubject, value)))));
    const matchedBucketIndex = challengeMatches.findIndex(Boolean);
    if (matchedBucketIndex < 0) return json(origin, { error: "Renewal CSRF challenge is invalid or expired" }, 403);
    const challengeBucket = candidateBuckets[matchedBucketIndex]!;

    const permissions = await viewerAdminPermissions(env, verified.principal);
    if (!permissions.includes("viewer.projects.read"))
      return json(origin, { error: "Global viewer.view permission required" }, 403);
    const now = Math.floor(Date.now() / 1000);
    // Bind the downstream request fingerprint to the challenge's fixed
    // five-minute bucket. Reusing requestId + challenge for a transport retry
    // therefore yields byte-stable authority even as wall-clock time advances.
    const expiresAt = Math.min(challengeBucket * CHALLENGE_WINDOW_SECONDS + 30 * 60, verified.expiresAt);
    if (expiresAt <= now + 60)
      return json(origin, { error: "Operations authorization is too close to expiry to renew" }, 401);
    const units = await resolveViewerUnits(env, verified.principal.id);
    const grant = await viewerServiceClient(env).createAdminGrant({
      subject: `ops:${verified.principal.id}`.slice(0, 200),
      permissions,
      authorizationExpiresAt: new Date(expiresAt * 1000).toISOString(),
      displayUnits: units,
      idempotencyKey: requestId,
    });
    return json(origin, {
      protocolVersion: 1,
      requestId,
      sessionId: parsed.data.sessionId,
      grant: grant.grant,
      grantExpiresAt: grant.grantExpiresAt,
      sessionTtlSeconds: grant.sessionTtlSeconds,
      redeemUrl: grant.redeemUrl,
    }, 201);
  } catch (error) {
    if (error instanceof HTTPException) return json(origin, { error: error.message }, error.status);
    if (error instanceof ViewerServiceError) {
      const status = [404, 409, 503].includes(error.status) ? error.status : 503;
      return json(origin, { error: status === 409 ? error.message : "Workspace renewal is temporarily unavailable" }, status);
    }
    return json(origin, { error: "Workspace renewal is temporarily unavailable" }, 503);
  }
}

/** Dispatch before generic same-origin CSRF middleware; this handler has its own strict CORS, Access, CSRF, and rate-limit checks. */
export async function dispatchViewerWorkspaceRenewal(request: Request, env: Env): Promise<Response> {
  return handle(request, env);
}
