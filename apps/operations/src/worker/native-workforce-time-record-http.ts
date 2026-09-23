import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { readBoundedJson } from "./bounded-json";
import { authenticateNativeStaffWithAdmissionVersion,
  type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { NativeWorkforceTimeRecordConflict, NativeWorkforceTimeRecordDenied,
  NativeWorkforceTimeRecordOutcomeUnknown, recordNativeWorkforceTime } from "./native-workforce-time-record";
import { reviewNativeWorkforceTime, submitNativeWorkforceTime } from "./native-workforce-time-transitions";
import { listNativeWorkforceTimeReviewQueue } from "./native-workforce-time-review-queue";

export const NATIVE_WORKFORCE_TIME_RECORD_ROUTE = "/api/native-workforce/time-record";
export type NativeWorkforceTimeRecordHttpDependencies = Readonly<{
  configuration: NativeStaffAccessConfiguration & Readonly<{ origin: string; csrfSecret: string }>;
  database: D1Database;
  consumeRateLimit: (key: string, limit: number, periodSeconds: number) => Promise<boolean>;
}>;

const encoder = new TextEncoder();
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY" };
const HEX = /^[0-9a-f]{64}$/;
const BODY_LIMIT = 8_192;

class HttpFailure extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function response(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { ...HEADERS, "Content-Type": "application/json; charset=utf-8" } });
}

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return Buffer.from(await crypto.subtle.sign("HMAC", key, encoder.encode(message))).toString("hex");
}

function safeEqual(candidate: string, expected: string): boolean {
  return HEX.test(candidate) && candidate.length === expected.length
    && timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(expected, "hex"));
}

function configuration(dependencies: NativeWorkforceTimeRecordHttpDependencies) {
  try {
    const value = dependencies.configuration;
    const origin = new URL(value.origin);
    if (value.enabled !== true || origin.protocol !== "https:" || origin.origin !== value.origin
      || origin.pathname !== "/" || origin.search || origin.hash
      || typeof value.csrfSecret !== "string" || encoder.encode(value.csrfSecret).byteLength < 32
      || !dependencies.database || typeof dependencies.consumeRateLimit !== "function") throw Error();
    return { access: { enabled: true, issuer: value.issuer, staffAudience: value.staffAudience },
      origin: value.origin, csrfSecret: value.csrfSecret, database: dependencies.database,
      consumeRateLimit: dependencies.consumeRateLimit };
  } catch { throw new HttpFailure(404, "not_found"); }
}

export function nativeWorkforceTimeRecordHttpRequest(method: string, path: string): "session" | "queue" | "record" | "submit" | "review" | null {
  if (method === "GET" && path === `${NATIVE_WORKFORCE_TIME_RECORD_ROUTE}/session`) return "session";
  if (method === "GET" && path === `${NATIVE_WORKFORCE_TIME_RECORD_ROUTE}/review-queue`) return "queue";
  if (method === "POST" && path === NATIVE_WORKFORCE_TIME_RECORD_ROUTE) return "record";
  if (method === "POST" && path === `${NATIVE_WORKFORCE_TIME_RECORD_ROUTE}/submit`) return "submit";
  if (method === "POST" && path === `${NATIVE_WORKFORCE_TIME_RECORD_ROUTE}/review`) return "review";
  return null;
}

export async function handleNativeWorkforceTimeRecordHttp(request: Request,
  dependencies: NativeWorkforceTimeRecordHttpDependencies): Promise<Response> {
  try {
    const route = nativeWorkforceTimeRecordHttpRequest(request.method, new URL(request.url).pathname);
    if (!route) throw new HttpFailure(404, "not_found");
    const authority = configuration(dependencies);
    const url = new URL(request.url);
    if (url.origin !== authority.origin || (route !== "queue" && url.search) || url.hash) throw new HttpFailure(403, "denied");
    const origin = request.headers.get("Origin");
    if (request.headers.get("Sec-Fetch-Site") !== null
      && request.headers.get("Sec-Fetch-Site") !== "same-origin") throw new HttpFailure(403, "denied");
    if (route === "session" || route === "queue") {
      if (request.headers.get("X-Native-Workforce-Request") !== "1"
        || (origin !== null && origin !== authority.origin)) throw new HttpFailure(403, "denied");
    } else if (origin !== authority.origin) throw new HttpFailure(403, "denied");
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const ipKey = await hmac(authority.csrfSecret, `native-workforce-time-rate-ip-v1:${ip.slice(0, 64)}`);
    if (await authority.consumeRateLimit(`ip:${ipKey}`, 60, 60) !== true)
      throw new HttpFailure(429, "rate_limited");
    let auth;
    try { auth = await authenticateNativeStaffWithAdmissionVersion(request, authority.database, authority.access); }
    catch { throw new HttpFailure(403, "denied"); }
    if (Date.parse(auth.verifiedUntil) <= Date.now()) throw new HttpFailure(403, "denied");
    const subjectKey = await hmac(authority.csrfSecret,
      `native-workforce-time-rate-subject-v1:${auth.identity.verifiedAccessSubject}`);
    if (await authority.consumeRateLimit(`subject:${subjectKey}`, 30, 60) !== true)
      throw new HttpFailure(429, "rate_limited");
    const bucket = Math.floor(Date.now() / 600_000);
    const csrfMessage = (value: number) => JSON.stringify(["native-workforce-time-record-csrf-v1",
      authority.origin, auth.identity.staffId, auth.identity.verifiedAccessSubject,
      auth.admissionVersion, value]);
    if (route === "session") return response(200, { csrfToken: await hmac(authority.csrfSecret,
      csrfMessage(bucket)), staffId: auth.identity.staffId, verifiedUntil: auth.verifiedUntil });
    if (route === "queue") {
      if ([...url.searchParams.keys()].some(key => key !== "limit" && key !== "cursor")
        || url.searchParams.getAll("limit").length > 1 || url.searchParams.getAll("cursor").length > 1)
        throw new HttpFailure(400, "invalid_request");
      const rawLimit = url.searchParams.get("limit");
      const limit = rawLimit === null ? undefined : Number(rawLimit);
      const cursor = url.searchParams.get("cursor") ?? undefined;
      if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 25)
        || cursor !== undefined && (cursor.length < 1 || cursor.length > 1024))
        throw new HttpFailure(400, "invalid_request");
      try { return response(200, await listNativeWorkforceTimeReviewQueue(authority.database, auth,
        authority.csrfSecret, { limit, cursor })); }
      catch (error) {
        if (error instanceof NativeWorkforceTimeRecordDenied) throw new HttpFailure(403, "denied");
        throw new HttpFailure(503, "outcome_unknown");
      }
    }
    const supplied = request.headers.get("X-CSRF-Token") ?? "";
    const current = await hmac(authority.csrfSecret, csrfMessage(bucket));
    const prior = await hmac(authority.csrfSecret, csrfMessage(bucket - 1));
    if (!(Number(safeEqual(supplied, current)) | Number(safeEqual(supplied, prior))))
      throw new HttpFailure(403, "denied");
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") ?? ""))
      throw new HttpFailure(400, "invalid_request");
    let body: unknown;
    try { body = await readBoundedJson(request, BODY_LIMIT, "Native workforce time record"); }
    catch (error) {
      if (error && typeof error === "object" && "status" in error && error.status === 413)
        throw new HttpFailure(413, "request_too_large");
      throw new HttpFailure(400, "invalid_request");
    }
    try {
      const receipt = route === "record"
        ? await recordNativeWorkforceTime(authority.database, auth, body as never)
        : route === "submit"
          ? await submitNativeWorkforceTime(authority.database, auth, body)
          : await reviewNativeWorkforceTime(authority.database, auth, body);
      return response(200, receipt);
    } catch (error) {
      if (error instanceof NativeWorkforceTimeRecordDenied) throw new HttpFailure(403, "denied");
      if (error instanceof NativeWorkforceTimeRecordConflict) throw new HttpFailure(409, "conflict");
      if (error instanceof NativeWorkforceTimeRecordOutcomeUnknown)
        throw new HttpFailure(503, "outcome_unknown");
      throw new HttpFailure(503, "outcome_unknown");
    }
  } catch (error) {
    const failure = error instanceof HttpFailure ? error : new HttpFailure(503, "unavailable");
    return response(failure.status, { error: failure.code });
  }
}
