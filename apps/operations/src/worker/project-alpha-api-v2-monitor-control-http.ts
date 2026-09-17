import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion,
  type AuthenticatedNativeStaffWithAdmissionVersion, type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { applyNativeProjectAlphaApiV2MonitorLifecycle, NativeMonitorControlDenied } from "./project-alpha-api-v2-monitor-native-control";
import { ProjectAlphaApiV2MonitorLifecycleConflict } from "./project-alpha-api-v2-monitor-lifecycle";
import { prepareProjectAlphaApiV2MonitorControlCommand } from "./project-alpha-api-v2-monitor-control-command";
import { readProjectAlphaApiV2MonitorControl, ProjectAlphaApiV2MonitorControlReadError } from "./project-alpha-api-v2-monitor-control-read";

/**
 * Default-off native staff boundary for the API-v2 monitor lifecycle. The only
 * accepted mutation is expectedRevision + enabled; identities are derived
 * from the server-owned connection secret before the native-authenticated
 * store is called. This module does not grant authority, seed grants, or
 * expose credentials/configuration details.
 */
export type ProjectAlphaApiV2MonitorControlRoute = "session" | "read" | "apply";
export type ProjectAlphaApiV2MonitorControlHttpDependencies = Readonly<{
  configuration: NativeStaffAccessConfiguration & Readonly<{ origin: string; csrfSecret: string }>;
  database: D1Database;
  /** Deployment-owned secret; never accepted from an HTTP body. */
  projectAlphaConnectionsJson?: string;
  consumeRateLimit: (key: string, limit: number, periodSeconds: number) => Promise<boolean>;
}>;

const BODY_LIMIT = 4_096;
const BUCKET_SECONDS = 600;
const MAX_REVISION = Number.MAX_SAFE_INTEGER - 1;
const HEX = /^[0-9a-f]{64}$/;
const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/;
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" };
const encoder = new TextEncoder();

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

export function projectAlphaApiV2MonitorControlHttpRequest(
  method: string, path: string,
): ProjectAlphaApiV2MonitorControlRoute | null {
  if (method === "GET" && path === "/api/native-integrations/monitor/session") return "session";
  if (method === "GET" && path === "/api/native-integrations/monitor/state") return "read";
  if (method === "POST" && path === "/api/native-integrations/monitor") return "apply";
  return null;
}

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
}

function snapshotDependencies(dependencies: ProjectAlphaApiV2MonitorControlHttpDependencies) {
  try {
    const configuration = dependencies.configuration;
    const enabled = configuration.enabled;
    const issuer = configuration.issuer;
    const staffAudience = configuration.staffAudience;
    const onboardingAudience = configuration.onboardingAudience;
    const origin = configuration.origin;
    const csrfSecret = configuration.csrfSecret;
    const database = dependencies.database;
    const consumeRateLimit = dependencies.consumeRateLimit;
    // Capture this string before the authentication await. The command
    // preparer will snapshot/parse it synchronously only after the body read.
    const projectAlphaConnectionsJson = dependencies.projectAlphaConnectionsJson;
    if (enabled !== true || typeof issuer !== "string" || typeof staffAudience !== "string"
      || typeof onboardingAudience !== "string" || !AUDIENCE.test(staffAudience)
      || !AUDIENCE.test(onboardingAudience) || staffAudience === onboardingAudience
      || typeof origin !== "string" || typeof csrfSecret !== "string"
      || encoder.encode(csrfSecret).byteLength < 32 || encoder.encode(csrfSecret).byteLength > 512
      || !database || typeof consumeRateLimit !== "function")
      throw new HttpFailure(503, "native_monitor_unavailable");
    const issuerUrl = new URL(issuer);
    const originUrl = new URL(origin);
    if (issuerUrl.protocol !== "https:" || !issuerUrl.hostname.endsWith(".cloudflareaccess.com")
      || issuerUrl.hostname === ".cloudflareaccess.com" || issuerUrl.port || issuerUrl.username
      || issuerUrl.password || issuerUrl.pathname !== "/" || issuerUrl.search || issuerUrl.hash
      || issuerUrl.origin !== issuer || originUrl.protocol !== "https:" || originUrl.origin !== origin
      || originUrl.username || originUrl.password || originUrl.pathname !== "/"
      || originUrl.search || originUrl.hash)
      throw new HttpFailure(503, "native_monitor_unavailable");
    return { access: { enabled, issuer, staffAudience, onboardingAudience }, origin, csrfSecret,
      database, consumeRateLimit, projectAlphaConnectionsJson };
  } catch (error) {
    if (error instanceof HttpFailure) throw error;
    throw new HttpFailure(503, "native_monitor_unavailable");
  }
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return Buffer.from(digest).toString("hex");
}

function csrfMessage(origin: string, access: NativeStaffAccessConfiguration,
  auth: AuthenticatedNativeStaffWithAdmissionVersion, bucket: number): string {
  return JSON.stringify(["native-project-alpha-monitor-control-csrf-v1", access.issuer,
    access.staffAudience, origin, auth.identity.staffId, auth.identity.verifiedAccessSubject,
    auth.identity.email, auth.admissionVersion, bucket]);
}

async function csrfToken(secret: string, origin: string, access: NativeStaffAccessConfiguration,
  auth: AuthenticatedNativeStaffWithAdmissionVersion, bucket: number): Promise<string> {
  return hmac(secret, csrfMessage(origin, access, auth, bucket));
}

function safeEqual(candidate: string, expected: string): boolean {
  return candidate.length === 64 && HEX.test(candidate)
    && timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
}

async function requireCsrf(request: Request, secret: string, origin: string,
  access: NativeStaffAccessConfiguration, auth: AuthenticatedNativeStaffWithAdmissionVersion): Promise<void> {
  const supplied = request.headers.get("X-CSRF-Token") ?? "";
  const bucket = Math.floor(Date.now() / 1000 / BUCKET_SECONDS);
  const current = await csrfToken(secret, origin, access, auth, bucket);
  const prior = await csrfToken(secret, origin, access, auth, bucket - 1);
  if (!(Number(safeEqual(supplied, current)) | Number(safeEqual(supplied, prior))))
    throw new HttpFailure(403, "native_monitor_denied");
}

function unexpired(auth: AuthenticatedNativeStaffWithAdmissionVersion): void {
  if (Date.parse(auth.verifiedUntil) <= Date.now()) throw new HttpFailure(403, "native_monitor_denied");
}

function plain(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
    return Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === "string" && descriptor?.enumerable === true && "value" in descriptor;
    });
  } catch { return false; }
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type");
  if (contentType === null || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType))
    throw new HttpFailure(400, "invalid_request");
  let body: unknown;
  try { body = await readBoundedJson(request, BODY_LIMIT, "Native monitor control"); }
  catch (error) {
    if (error !== null && typeof error === "object" && "status" in error && error.status === 413)
      throw new HttpFailure(413, "request_too_large");
    throw new HttpFailure(400, "invalid_request");
  }
  if (!plain(body) || !exact(body, ["expectedRevision", "enabled"])
    || typeof body.expectedRevision !== "number" || !Number.isSafeInteger(body.expectedRevision)
    || body.expectedRevision < 0 || body.expectedRevision > MAX_REVISION
    || typeof body.enabled !== "boolean") throw new HttpFailure(400, "invalid_request");
  return body;
}

/**
 * Authenticate the native staff session, then apply exactly the server-pinned
 * command. No PA auth, handoff keyring, grant seeding, or monitor enable flag
 * is consulted here; disabling remains possible when connection configuration
 * is malformed so an operator can stop a broken deployment.
 */
export async function handleProjectAlphaApiV2MonitorControlHttp(
  request: Request, dependencies: ProjectAlphaApiV2MonitorControlHttpDependencies,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const route = projectAlphaApiV2MonitorControlHttpRequest(request.method, url.pathname);
    if (!route) throw new HttpFailure(404, "not_found");
    const authority = snapshotDependencies(dependencies);
    if (url.origin !== authority.origin || url.search || url.hash)
      throw new HttpFailure(403, "native_monitor_denied");
    const origin = request.headers.get("Origin");
    const fetchSite = request.headers.get("Sec-Fetch-Site");
    if (fetchSite !== null && fetchSite !== "same-origin")
      throw new HttpFailure(403, "native_monitor_denied");
    if (route !== "apply") {
      if (request.headers.get("X-Native-Integration-Request") !== "1"
        || (origin !== null && origin !== authority.origin))
        throw new HttpFailure(403, "native_monitor_denied");
    } else if (origin !== authority.origin) throw new HttpFailure(403, "native_monitor_denied");

    const ip = request.headers.get("CF-Connecting-IP");
    const ipIdentity = ip && ip.length <= 64 && /^[0-9a-fA-F:.]+$/.test(ip) ? ip : "unknown";
    const ipDigest = await hmac(authority.csrfSecret,
      `native-project-alpha-monitor-control-rate-ip-v1:${ipIdentity}`);
    let allowed: boolean;
    try { allowed = await authority.consumeRateLimit(
      `ip:${Buffer.from(ipDigest, "hex").toString("base64url")}`, 60, 60); }
    catch { throw new HttpFailure(503, "native_monitor_unavailable"); }
    if (allowed !== true) throw new HttpFailure(429, "rate_limited");

    let auth: AuthenticatedNativeStaffWithAdmissionVersion;
    try { auth = await authenticateNativeStaffWithAdmissionVersion(
      request, authority.database, authority.access); }
    catch { throw new HttpFailure(403, "native_monitor_denied"); }
    unexpired(auth);
    const subjectDigest = await hmac(authority.csrfSecret,
      `native-project-alpha-monitor-control-rate-subject-v1:${auth.identity.verifiedAccessSubject}`);
    try { allowed = await authority.consumeRateLimit(
      `subject:${Buffer.from(subjectDigest, "hex").toString("base64url")}`, 30, 60); }
    catch { throw new HttpFailure(503, "native_monitor_unavailable"); }
    if (allowed !== true) throw new HttpFailure(429, "rate_limited");

    if (route === "session") {
      const csrf = await csrfToken(authority.csrfSecret, authority.origin, authority.access, auth,
        Math.floor(Date.now() / 1000 / BUCKET_SECONDS));
      unexpired(auth);
      return response(200, { csrfToken: csrf, verifiedUntil: auth.verifiedUntil });
    }
    if (route === "read") {
      try {
        const state = await readProjectAlphaApiV2MonitorControl(authority.database, auth);
        unexpired(auth);
        return response(200, { revision: state.revision, enabled: state.enabled, attributed: state.attributed });
      } catch (error) {
        if (error instanceof ProjectAlphaApiV2MonitorControlReadError || error instanceof HttpFailure)
          throw new HttpFailure(403, "native_monitor_denied");
        throw new HttpFailure(503, "native_monitor_unavailable");
      }
    }
    await requireCsrf(request, authority.csrfSecret, authority.origin, authority.access, auth);
    unexpired(auth);
    const body = await readBody(request);
    unexpired(auth);
    let command;
    try {
      command = prepareProjectAlphaApiV2MonitorControlCommand(body, authority.projectAlphaConnectionsJson);
    } catch { throw new HttpFailure(503, "native_monitor_unavailable"); }
    unexpired(auth);
    try {
      const result = await applyNativeProjectAlphaApiV2MonitorLifecycle(authority.database, {
        authenticatedNativeStaff: auth, expectedRevision: command.expectedRevision,
        enabled: command.enabled, identities: command.identities,
      });
      unexpired(auth);
      // Return only the non-secret lifecycle result needed for the next CAS.
      return response(200, { revision: result.revision, enabled: result.enabled });
    } catch (error) {
      if (error instanceof ProjectAlphaApiV2MonitorLifecycleConflict)
        throw new HttpFailure(409, "conflict");
      if (error instanceof NativeMonitorControlDenied)
        throw new HttpFailure(403, "native_monitor_denied");
      throw new HttpFailure(503, "native_monitor_outcome_unknown");
    }
  } catch (error) {
    const failure = error instanceof HttpFailure ? error
      : new HttpFailure(503, "native_monitor_unavailable");
    return response(failure.status, { error: failure.code });
  }
}
