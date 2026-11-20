// Flight logs on the local (NAS) Logs host, reached from the Ops server through the Tunnel and Cloudflare Access.
// It implements the same FlightLogsBinding the Ops flight-logs routes already use, so the browser stays inside the
// Ops staff session and never talks to the NAS. Default off: only used when LOGS_BACKEND_MODE is "local".
//
// Every call carries Ops' own Access service token for the private Logs host (CF-Access-Client-Id/Secret) and the
// staff actor Ops authorised in this session (X-Ledge-Top-Actor: staff id + flight-logs permissions only). Writes
// that are not naturally idempotent must carry the browser's per-action Idempotency-Key (reused on retry). The NAS verifies the Access assertion itself and
// rechecks sensitive authority with Ops. If the NAS cannot be reached, staff get a clear "unavailable" answer and
// the rest of Ops is unaffected.
import type { FlightLogsActor, FlightLogsBinding, FlightLogsQuery, OperationOptions } from "./flight-logs-routes";

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; status: number; message: string } };

export type RemoteLogsEnv = {
  LOGS_BACKEND_MODE?: string;
  LOGS_BACKEND_URL?: string;
  LOGS_BACKEND_ACCESS_CLIENT_ID?: string;
  LOGS_BACKEND_ACCESS_CLIENT_SECRET?: string;
};

export const REMOTE_LIMITS = Object.freeze({ timeoutMs: 20_000, jsonBytes: 8 * 1024 * 1024, telemetryBytes: 32 * 1024 * 1024 + 1024 });
const KEYED = new Set(["startImport", "decideSignIn", "revokeDevice", "assignDecodedLog", "reassignFlight", "resolveConflict"]);
const UNAVAILABLE = { ok: false as const, error: { code: "logs_unavailable", status: 503, message: "Flight logs are unavailable right now. Try again in a few minutes." } };

export function remoteLogsEnabled(env: RemoteLogsEnv): boolean { return env.LOGS_BACKEND_MODE === "local"; }

function base(env: RemoteLogsEnv): URL | null {
  let url: URL;
  try { url = new URL(env.LOGS_BACKEND_URL ?? ""); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") return null;
  return url;
}

function encodeActor(actor: FlightLogsActor): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ staffId: actor.staffId, permissions: actor.permissions }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array | null> {
  if (Number(response.headers.get("Content-Length") ?? 0) > limit) { await response.body?.cancel().catch(() => {}); return null; }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

/** The request body as a view over a plain ArrayBuffer (what fetch accepts); copied only if it is backed by something else. */
function ownedBytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  return view.buffer instanceof ArrayBuffer ? new Uint8Array(view.buffer, view.byteOffset, view.byteLength) : new Uint8Array(view);
}

function isResult(value: unknown): value is Result<unknown> {
  if (!value || typeof value !== "object") return false;
  const v = value as { ok?: unknown; error?: { code?: unknown; status?: unknown; message?: unknown } };
  return v.ok === true ? "value" in v
    : v.ok === false && typeof v.error?.code === "string" && typeof v.error.status === "number" && typeof v.error.message === "string";
}

/** Throws at use (not at load) when local mode is on but its configuration is incomplete: never a silent fallback. */
export function createRemoteFlightLogs(env: RemoteLogsEnv, fetchImpl: typeof fetch = fetch, { timeoutMs = REMOTE_LIMITS.timeoutMs }: { timeoutMs?: number } = {}): FlightLogsBinding {
  const origin = base(env);
  const clientId = env.LOGS_BACKEND_ACCESS_CLIENT_ID ?? "", clientSecret = env.LOGS_BACKEND_ACCESS_CLIENT_SECRET ?? "";
  const configured = Boolean(origin && /^[A-Za-z0-9._-]{8,256}$/.test(clientId) && clientSecret.length >= 16);

  async function send(path: string, init: { method: string; actor: FlightLogsActor; body?: BodyInit; json?: boolean; key?: string }): Promise<Response | null> {
    if (!configured || !origin) return null;
    const headers: Record<string, string> = { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret,
      "X-Ledge-Top-Actor": encodeActor(init.actor), Accept: "application/json, application/octet-stream" };
    if (init.json) headers["Content-Type"] = "application/json";
    if (init.body instanceof Uint8Array) headers["Content-Type"] = "application/octet-stream";
    if (init.key) headers["Idempotency-Key"] = init.key;
    try {
      const response = await fetchImpl(new URL(path, origin), { method: init.method, headers, body: init.body, redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs) });
      return response;
    } catch { return null; }
  }

  async function rpc<T>(method: string, actor: FlightLogsActor, args: unknown[], options: OperationOptions = {}): Promise<Result<T>> {
    // Keyed writes need the browser's per-action key: without a valid one nothing is sent (never a fresh key).
    const key = KEYED.has(method) ? options.idempotencyKey : undefined;
    if (KEYED.has(method) && !(key && /^[A-Za-z0-9_-]{16,128}$/.test(key))) return { ok: false, error: { code: "idempotency_key_required", status: 400, message: "An Idempotency-Key is required." } };
    const response = await send(`/internal/v1/logs/rpc/${method}`, { method: "POST", actor, json: true, key,
      body: JSON.stringify({ args }) });
    return envelope<T>(response);
  }

  async function envelope<T>(response: Response | null): Promise<Result<T>> {
    if (!response || response.status !== 200) { await response?.body?.cancel().catch(() => {}); return UNAVAILABLE; }
    try {
      // The whole read is inside the guard: a stream that fails or times out mid-body is "unavailable" too.
      const bytes = await readBounded(response, REMOTE_LIMITS.jsonBytes);
      if (!bytes) return UNAVAILABLE;
      const value = JSON.parse(new TextDecoder().decode(bytes));
      return isResult(value) ? value as Result<T> : UNAVAILABLE;
    } catch { return UNAVAILABLE; }
  }

  const segment = (value: string) => encodeURIComponent(value);
  return {
    inventory: actor => rpc("inventory", actor, []),
    startImport: (actor, input, options) => rpc("startImport", actor, [input], options),
    importFlights: (actor, importId, batch) => rpc("importFlights", actor, [importId, batch]),
    async putTelemetry(actor, importId, flightId, body) {
      const response = await send(`/internal/v1/logs/imports/${segment(importId)}/flights/${segment(flightId)}/telemetry`,
        { method: "PUT", actor, body: ownedBytes(body) });
      return envelope(response);
    },
    completeImport: (actor, importId, input) => rpc("completeImport", actor, [importId, input]),
    listFlights: (actor, query: FlightLogsQuery) => rpc("listFlights", actor, [query]),
    facets: actor => rpc("facets", actor, []),
    overview: (actor, query) => rpc("overview", actor, [query]),
    getFlight: (actor, flightId) => rpc("getFlight", actor, [flightId]),
    async getTelemetry(actor, flightId) {
      const response = await send(`/internal/v1/logs/flights/${segment(flightId)}/telemetry`, { method: "GET", actor });
      if (!response || response.status !== 200) { await response?.body?.cancel().catch(() => {}); return UNAVAILABLE; }
      // The NAS answers bytes, or the JSON result envelope for a refusal (e.g. no stored track).
      if ((response.headers.get("Content-Type") ?? "").startsWith("application/json")) return envelope<Uint8Array>(response);
      try {
        const bytes = await readBounded(response, REMOTE_LIMITS.telemetryBytes);
        return bytes ? { ok: true, value: bytes } : UNAVAILABLE;
      } catch { await response.body?.cancel().catch(() => {}); return UNAVAILABLE; }
    },
    pendingSignIns: actor => rpc("pendingSignIns", actor, []),
    decideSignIn: (actor, input, options) => rpc("decideSignIn", actor, [input], options),
    listDevices: (actor, input) => rpc("listDevices", actor, [input]),
    revokeDevice: (actor, deviceId, options) => rpc("revokeDevice", actor, [deviceId], options),
    logsStatus: actor => rpc("logsStatus", actor, []),
    reviewQueue: (actor, input) => rpc("reviewQueue", actor, [input]),
    assignDecodedLog: (actor, input, options) => rpc("assignDecodedLog", actor, [input], options),
    reassignFlight: (actor, input, options) => rpc("reassignFlight", actor, [input], options),
    resolveConflict: (actor, input, options) => rpc("resolveConflict", actor, [input], options),
  };
}
