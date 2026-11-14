import { timingSafeEqual } from "./crypto";
import type { Env } from "./types";

/**
 * Private machine bridge for the local DJI log decoder (apps/logs-decoder; see apps/logs/DECODER.md).
 *
 * Runs before the staff middleware, and only on its own exact host (LOGS_DECODER_MACHINE_HOST). It never serves
 * staff, never uses a staff session or cookie, and never touches the public Logs host. It forwards a fixed set of
 * calls to the parser-only Logs RPC entrypoint (LOGS_DECODER binding -> DecoderService).
 *
 * CLOSED BY DEFAULT: unless LOGS_DECODER_ENABLED is "true", LOGS_DECODER is bound, and the host, audience and a
 * token hash are configured, no request is handled here (other hosts fall through untouched; the configured host
 * answers 404). Auth: a dedicated bearer token per runner; Ops keeps only its SHA-256 (LOGS_DECODER_TOKEN_SHA256,
 * plus LOGS_DECODER_TOKEN_SHA256_NEXT during rotation), and the request must name the configured audience.
 */

type Lease = { sha256: string; attemptToken: string };
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; status: number; message?: string } };
export interface LogsDecoderBinding {
  claim(input: { requestId: string }): Promise<Result<unknown>>;
  heartbeat(lease: Lease): Promise<Result<unknown>>;
  readRaw(lease: Lease): Promise<Result<{ sha256: string; size: number; body: ReadableStream }>>;
  complete(lease: Lease, result: { contentSha256: string; summary: unknown; track: Uint8Array; decoderVersion: string }): Promise<Result<unknown>>;
  defer(lease: Lease, input: { errorCode: string; retryAfterSeconds?: number }): Promise<Result<unknown>>;
  retry(lease: Lease, input: { errorCode: string }): Promise<Result<unknown>>;
  fail(lease: Lease, input: { errorCode: string }): Promise<Result<unknown>>;
  reconcile(lease: Lease): Promise<Result<unknown>>;
}
type DecoderEnv = Env & {
  LOGS_DECODER?: LogsDecoderBinding;
  LOGS_DECODER_ENABLED?: string;
  LOGS_DECODER_MACHINE_HOST?: string;
  LOGS_DECODER_AUDIENCE?: string;
  LOGS_DECODER_TOKEN_SHA256?: string;
  LOGS_DECODER_TOKEN_SHA256_NEXT?: string;
};

export const LOGS_DECODER_PREFIX = "/api/machine/logs-decoder/";
// The same limits the Logs DecoderService enforces (apps/logs/src/worker/decoder-service.mjs).
export const LOGS_DECODER_LIMITS = Object.freeze({ trackGzipBytes: 8 * 1024 * 1024, jsonBytes: 4096, summaryHeaderChars: 6144 });
const ROUTES = new Set(["claim", "heartbeat", "raw", "complete", "defer", "retry", "fail", "reconcile"]);
const HEX64 = /^[0-9a-f]{64}$/;
const STATUSES = new Set([400, 404, 409, 413, 503]);

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    "Cache-Control": "private, no-store", "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex, nofollow" } });
}
const fail = (code: string, status: number) => json({ error: code }, status);

async function sha256Hex(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, "0")).join("");
}

function configured(env: DecoderEnv): { host: string; audience: string; hashes: string[] } | null {
  const host = (env.LOGS_DECODER_MACHINE_HOST ?? "").trim().toLowerCase();
  const audience = (env.LOGS_DECODER_AUDIENCE ?? "").trim();
  const hashes = [env.LOGS_DECODER_TOKEN_SHA256, env.LOGS_DECODER_TOKEN_SHA256_NEXT].map(value => (value ?? "").trim().toLowerCase()).filter(value => HEX64.test(value));
  if (env.LOGS_DECODER_ENABLED !== "true" || !env.LOGS_DECODER || !host || !audience || !hashes.length) return null;
  return { host, audience, hashes };
}

async function authorized(request: Request, settings: { audience: string; hashes: string[] }): Promise<boolean> {
  const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(request.headers.get("Authorization") ?? "")?.[1];
  if (!token || request.headers.get("X-Machine-Audience") !== settings.audience) return false;
  const supplied = await sha256Hex(token);
  let match = false;
  for (const hash of settings.hashes) match = timingSafeEqual(supplied, hash) || match;
  return match;
}

async function readBounded(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("Content-Length") ?? 0) > limit) { await request.body?.cancel().catch(() => {}); throw new RangeError("too_large"); }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); throw new RangeError("too_large"); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

async function smallJson(request: Request): Promise<Record<string, unknown>> {
  const bytes = await readBounded(request, LOGS_DECODER_LIMITS.jsonBytes);
  const value: unknown = bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SyntaxError("not an object");
  return value as Record<string, unknown>;
}

function leaseFrom(sha256: unknown, attemptToken: unknown): Lease | null {
  return typeof sha256 === "string" && HEX64.test(sha256) && typeof attemptToken === "string" && attemptToken.length > 0 && attemptToken.length <= 100
    ? { sha256, attemptToken } : null;
}

function summaryFrom(header: string | null): unknown {
  if (!header || header.length > LOGS_DECODER_LIMITS.summaryHeaderChars || !/^[A-Za-z0-9_-]+$/.test(header)) throw new SyntaxError("summary");
  const binary = atob(header.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (header.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0))));
}

function relay(result: Result<unknown>): Response {
  if (result.ok) return json(result.value);
  return fail(result.error.code, STATUSES.has(result.error.status) ? result.error.status : 502);
}

/** Handles the decoder's machine calls on the configured host; returns null for anything else. */
export async function dispatchLogsDecoderBridge(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(LOGS_DECODER_PREFIX)) return null;
  const decoderEnv = env as DecoderEnv;
  const host = (decoderEnv.LOGS_DECODER_MACHINE_HOST ?? "").trim().toLowerCase();
  if (!host || url.hostname.toLowerCase() !== host) return null;
  const settings = configured(decoderEnv);
  const route = url.pathname.slice(LOGS_DECODER_PREFIX.length);
  if (!settings || request.method !== "POST" || !ROUTES.has(route)) { await request.body?.cancel().catch(() => {}); return fail("not_found", 404); }
  if (!(await authorized(request, settings))) { await request.body?.cancel().catch(() => {}); return fail("unauthorized", 401); }
  const decoder = decoderEnv.LOGS_DECODER!;
  try {
    if (route === "complete") {
      const lease = leaseFrom(request.headers.get("X-Lease-Sha256"), request.headers.get("X-Attempt-Token"));
      if (!lease) return fail("lease_stale", 409);
      const summary = summaryFrom(request.headers.get("X-Decode-Summary"));
      const track = await readBounded(request, LOGS_DECODER_LIMITS.trackGzipBytes);
      return relay(await decoder.complete(lease, { contentSha256: request.headers.get("X-Content-Sha256") ?? "", summary, track,
        decoderVersion: request.headers.get("X-Decoder-Version") ?? "" }));
    }
    const body = await smallJson(request);
    if (route === "claim") return relay(await decoder.claim({ requestId: String(body.requestId ?? "") }));
    const lease = leaseFrom(body.sha256, body.attemptToken);
    if (!lease) return fail("lease_stale", 409);
    if (route === "heartbeat") return relay(await decoder.heartbeat(lease));
    if (route === "reconcile") return relay(await decoder.reconcile(lease));
    if (route === "defer") return relay(await decoder.defer(lease, { errorCode: String(body.errorCode ?? ""), retryAfterSeconds: Number(body.retryAfterSeconds) || undefined }));
    if (route === "retry") return relay(await decoder.retry(lease, { errorCode: String(body.errorCode ?? "") }));
    if (route === "fail") return relay(await decoder.fail(lease, { errorCode: String(body.errorCode ?? "") }));
    const raw = await decoder.readRaw(lease);
    if (!raw.ok) return relay(raw);
    return new Response(raw.value.body, { headers: { "Content-Type": "application/octet-stream", "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff", "X-Content-Sha256": raw.value.sha256 } });
  } catch (error) {
    if (error instanceof RangeError) return fail("too_large", 413);
    if (error instanceof SyntaxError) return fail("invalid_request", 400);
    // Fixed vocabulary only: exception text can carry bindings or keys.
    console.error(JSON.stringify({ event: "logs.decoder.bridge.error", route }));
    return fail("bridge_error", 502);
  }
}
