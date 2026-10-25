import { parseDuplicateFreeJson } from "./bounded-json";
import { isNativeAccessSubject } from "./native-access-subject";
import { snapshotStaffLoginProof, type StaffLoginProof } from "./staff-login-bindings";

/** Internal only. A caller must obtain this proof from native root authority,
 * never from a request body. No HTTP route is mounted by this module. */
export type EmployeeReadProof = Readonly<{
  gatewayId: string; rootId: string; rootGeneration: number; rootFingerprint: string;
  staffId: string; accessSubject: string; admissionVersion: number; profileVersion: number;
  grantId: string; grantGeneration: number; verifiedUntil: string;
  /** Private request provenance; never included in the signed gateway body. */
  verifiedLogin?: StaffLoginProof;
}>;
export type EmployeeReadSelection = Readonly<{
  operation: "list" | "manifest" | "content"; path: string;
  expectedSha256: string | null; range: Readonly<{ start: number; end: number }> | null;
  cursor?: string | null; snapshotId?: string | null;
}>;
export type EmployeeGatewayConfiguration = Readonly<{
  origin: string; gatewayId: string; keyId: string; key: Uint8Array;
}>;
export type EmployeeGatewayDependencies = Readonly<{
  fetch: typeof fetch;
  recheck: (proof: EmployeeReadProof) => Promise<boolean>;
  auditContentStart: (proof: EmployeeReadProof, selection: EmployeeReadSelection) => Promise<void>;
}>;

const encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const MAX_BYTES = 1_099_511_627_776;
const integer = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1;
const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), x => x.toString(16).padStart(2, "0")).join("");

export function canonicalEmployeeReadPath(value: string, allowRoot: boolean): boolean {
  if (typeof value !== "string" || encoder.encode(value).length > 4096) return false;
  if (value === "") return allowRoot;
  if (/[\\%:\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) return false;
  const components = value.split("/");
  return components.length <= 64 && components.every(p => p !== "" && p !== "." && p !== ".."
    && encoder.encode(p).length <= 255);
}

function inputSnapshot(proof: EmployeeReadProof, selection: EmployeeReadSelection,
  config: EmployeeGatewayConfiguration) {
  const login = Object.hasOwn(proof, "verifiedLogin") ? snapshotStaffLoginProof(proof.verifiedLogin) : undefined;
  const p = Object.freeze({ ...proof, ...(login ? { verifiedLogin: login } : {}) }), r = selection.range;
  if (login !== undefined && (!login || login.kind !== "alternate" || login.staffId !== p.staffId
    || login.canonicalSubject !== p.accessSubject || login.expiresAt * 1000 < Date.parse(p.verifiedUntil))) throw Error();
  const s = Object.freeze({ operation: selection.operation, path: selection.path,
    expectedSha256: selection.expectedSha256, range: r === null ? null : Object.freeze({ start: r.start, end: r.end }),
    cursor: selection.cursor ?? null, snapshotId: selection.snapshotId ?? null });
  const c = { origin: config.origin, gatewayId: config.gatewayId, keyId: config.keyId, key: new Uint8Array(config.key) };
  const origin = new URL(c.origin);
  if (origin.protocol !== "https:" || origin.origin !== c.origin || origin.username || origin.password
    || origin.pathname !== "/" || origin.search || origin.hash || !UUID.test(c.gatewayId)
    || !/^[A-Za-z0-9_-]{1,64}$/.test(c.keyId) || c.key.length < 32 || c.key.length > 128
    || p.gatewayId !== c.gatewayId || !UUID.test(p.rootId) || !UUID.test(p.grantId)
    || !HEX.test(p.rootFingerprint) || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/.test(p.staffId)
    || !isNativeAccessSubject(p.accessSubject)
    || ![p.rootGeneration, p.admissionVersion, p.profileVersion, p.grantGeneration].every(integer)
    || !Number.isFinite(Date.parse(p.verifiedUntil))
    || !["list", "manifest", "content"].includes(s.operation)
    || !canonicalEmployeeReadPath(s.path, s.operation === "list")) throw Error();
  if (s.operation === "content") {
    if (typeof s.expectedSha256 !== "string" || !HEX.test(s.expectedSha256)
      || typeof s.snapshotId !== "string" || !UUID.test(s.snapshotId) || s.cursor !== null
      || (s.range !== null && (!Number.isSafeInteger(s.range.start) || !Number.isSafeInteger(s.range.end)
        || s.range.start < 0 || s.range.end < s.range.start || s.range.end >= MAX_BYTES))) throw Error();
  } else if (s.expectedSha256 !== null || s.range !== null || s.snapshotId !== null
    || (s.operation === "manifest" && s.cursor !== null)
    || (s.cursor !== null && (typeof s.cursor !== "string" || !/^[A-Za-z0-9._-]{1,8192}$/.test(s.cursor)))) throw Error();
  return { proof: p, selection: s, config: c };
}

/** Dedicated protocol key, purpose and instance audience; never signs arbitrary
 * URLs or forwards the human Access assertion. */
export async function signEmployeeReadBody(body: string, config: EmployeeGatewayConfiguration,
  timestamp: number, nonce: string): Promise<string> {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || !/^[0-9a-f]{32}$/.test(nonce)) throw Error();
  const digest = hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
  const material = ["ops-employee-read-v1", config.gatewayId, config.keyId, String(timestamp), nonce,
    "POST", "/v1/read", digest].join("\n");
  const key = await crypto.subtle.importKey("raw", new Uint8Array(config.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(material)));
}

function staticError(status: number, code: string): Response {
  return Response.json({ error: code }, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
async function discard(response: Response | null) { try { await response?.body?.cancel(); } catch { /* preserve denial */ } }
async function smallJson(response: Response, maximumBytes: number): Promise<unknown> {
  if (response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
    || response.headers.has("Content-Encoding") || !response.body) throw Error();
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let count = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      count += chunk.value.length; if (count > maximumBytes) { await reader.cancel(); throw Error(); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(count); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}
function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === keys.sort().join(",");
}
function validMetadata(value: unknown, selection: EmployeeReadSelection): boolean {
  if (selection.operation === "manifest") return exactObject(value, ["schemaVersion", "sha256", "size", "etag", "snapshotId", "snapshotExpiresAt"])
    && value.schemaVersion === 1 && typeof value.sha256 === "string" && HEX.test(value.sha256)
    && value.etag === `"${value.sha256}"` && typeof value.size === "number"
    && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= MAX_BYTES
    && typeof value.snapshotId === "string" && UUID.test(value.snapshotId)
    && typeof value.snapshotExpiresAt === "number" && Number.isSafeInteger(value.snapshotExpiresAt)
    && value.snapshotExpiresAt > Math.floor(Date.now() / 1000)
    // Match admitted gateway clock skew; the gateway separately enforces a
    // maximum 1800-second lifetime with a monotonic timer.
    && value.snapshotExpiresAt <= Math.floor(Date.now() / 1000) + 1830;
  if (!exactObject(value, ["schemaVersion", "entries", "nextCursor"]) || value.schemaVersion !== 1
    || (value.nextCursor !== null && (typeof value.nextCursor !== "string"
      || !/^[A-Za-z0-9._-]{1,8192}$/.test(value.nextCursor) || value.nextCursor === selection.cursor))
    || !Array.isArray(value.entries) || value.entries.length > 200) return false;
  if (value.entries.length === 0 && value.nextCursor !== null) return false;
  const seen = new Set<string>(); let previous: Uint8Array | null = null;
  return value.entries.every((entry: unknown) => {
    if (!exactObject(entry, ["name", "kind"]) || typeof entry.name !== "string"
      || entry.name.includes("/") || !canonicalEmployeeReadPath(entry.name, false)
      || (entry.kind !== "file" && entry.kind !== "folder") || seen.has(entry.name)) return false;
    const encoded = encoder.encode(entry.name);
    if (previous !== null) {
      let compare = 0;
      for (let i = 0; i < Math.min(previous.length, encoded.length); i++) {
        if (previous[i] !== encoded[i]) { compare = previous[i]! - encoded[i]!; break; }
      }
      if (compare > 0 || (compare === 0 && previous.length >= encoded.length)) return false;
    }
    previous = encoded; seen.add(entry.name); return true;
  });
}

/** Source-level integration boundary; deliberate absence of route mounting keeps
 * unreviewed provisioning or deployment from exposing host folders. */
export async function readEmployeeGateway(proof: EmployeeReadProof, selection: EmployeeReadSelection,
  configuration: EmployeeGatewayConfiguration, dependencies: EmployeeGatewayDependencies,
  signal?: AbortSignal): Promise<Response> {
  let upstream: Response | null = null;
  const controller = new AbortController();
  const abort = () => controller.abort(); signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let handedOff = false;
  try {
    const { proof: p, selection: s, config: c } = inputSnapshot(proof, selection, configuration);
    const recheck = dependencies.recheck, audit = dependencies.auditContentStart, fetcher = dependencies.fetch;
    const valid = async () => !controller.signal.aborted && Date.now() < Date.parse(p.verifiedUntil) && await recheck(p)
      && !controller.signal.aborted && Date.now() < Date.parse(p.verifiedUntil);
    if (signal?.aborted || !await valid()) return staticError(403, "employee_read_denied");
    const timestamp = Math.floor(Date.now() / 1000);
    const deadlineAt = Math.min(timestamp + 900, Math.floor(Date.parse(p.verifiedUntil) / 1000));
    const expiresAt = Math.min(timestamp + 30, deadlineAt);
    if (expiresAt <= timestamp) return staticError(403, "employee_read_denied");
    const body = JSON.stringify({ schemaVersion: 1, gatewayId: p.gatewayId, rootId: p.rootId,
      rootGeneration: p.rootGeneration, rootFingerprint: p.rootFingerprint, staffId: p.staffId,
      accessSubject: p.accessSubject, admissionVersion: p.admissionVersion, profileVersion: p.profileVersion,
      grantId: p.grantId, grantGeneration: p.grantGeneration, operation: s.operation, path: s.path,
      expectedSha256: s.expectedSha256, range: s.range, cursor: s.cursor, snapshotId: s.snapshotId, expiresAt, deadlineAt });
    if (encoder.encode(body).length > 16_384) throw Error();
    const nonce = hex(crypto.getRandomValues(new Uint8Array(16)).buffer);
    const signature = await signEmployeeReadBody(body, c, timestamp, nonce);
    if (!await valid()) return staticError(403, "employee_read_denied");
    timer = setTimeout(abort, Math.max(1, deadlineAt * 1000 - Date.now()));
    upstream = await fetcher(`${c.origin}/v1/read`, { method: "POST", redirect: "manual", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Ops-Read-Key-Id": c.keyId,
        "X-Ops-Read-Time": String(timestamp), "X-Ops-Read-Nonce": nonce, "X-Ops-Read-Signature": signature }, body });
    if (!await valid()) { await discard(upstream); return staticError(403, "employee_read_denied"); }
    if ([404, 408, 409, 412, 413, 416, 429, 503, 507].includes(upstream.status)) {
      const status = upstream.status; await discard(upstream); return staticError(status, "employee_read_unavailable");
    }
    if (s.operation !== "content") {
      if (upstream.status !== 200) throw Error();
      const metadata = await smallJson(upstream, s.operation === "list" ? 262_144 : 65_536);
      if (!validMetadata(metadata, s)) throw Error();
      if (!await valid()) return staticError(403, "employee_read_denied");
      return Response.json(metadata, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
    const headers = upstream.headers, declared = headers.get("Content-Length");
    if (headers.get("Content-Type") !== "application/octet-stream" || headers.has("Content-Encoding")
      || headers.get("ETag") !== `"${s.expectedSha256}"` || declared === null
      || !/^(0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(Number(declared))
      || Number(declared) > MAX_BYTES || !upstream.body) throw Error();
    const length = Number(declared), resultHeaders = new Headers({ "Content-Type": "application/octet-stream",
      "Content-Length": declared, "ETag": `"${s.expectedSha256}"`, "Accept-Ranges": "bytes",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (s.range) {
      const match = /^bytes ([0-9]+)-([0-9]+)\/([0-9]+)$/.exec(headers.get("Content-Range") ?? "");
      if (upstream.status !== 206 || !match || Number(match[1]) !== s.range.start || Number(match[2]) !== s.range.end
        || length !== s.range.end - s.range.start + 1 || !Number.isSafeInteger(Number(match[3]))
        || Number(match[3]) <= s.range.end || Number(match[3]) > MAX_BYTES) throw Error();
      resultHeaders.set("Content-Range", match[0]);
    } else if (upstream.status !== 200 || headers.has("Content-Range")) throw Error();
    await audit(p, s);
    if (!await valid()) { await discard(upstream); return staticError(403, "employee_read_denied"); }
    // A generic guarded ReadableStream loses Content-Length at the Worker boundary.
    // Native fixed framing preserves incremental backpressure and rejects short/long bodies.
    const fixed = new FixedLengthStream(length);
    const reader = upstream.body.getReader(); let delivered = 0;
    // Explicitly unblock an in-flight upstream read on caller/deadline abort;
    // Workerd pipe cancellation alone can wait for that read to settle.
    const cancelReader = () => { void reader.cancel().catch(() => { /* preserve interruption */ }); };
    controller.signal.addEventListener("abort", cancelReader, { once: true });
    const cleanup = () => { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", cancelReader); };
    const stream = new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          if (controller.signal.aborted || Date.now() >= deadlineAt * 1000) throw Error();
          const chunk = await reader.read();
          if (chunk.done) { if (delivered !== length) throw Error(); cleanup(); output.close(); return; }
          delivered += chunk.value.length;
          if (delivered > length || controller.signal.aborted || Date.now() >= deadlineAt * 1000) throw Error();
          output.enqueue(chunk.value);
        } catch { cleanup(); try { await reader.cancel(); } catch { /* stream already failed */ } output.error(Error("employee_read_interrupted")); }
      },
      async cancel() { cleanup(); controller.abort(); await reader.cancel(); },
    });
    const response = new Response(fixed.readable, { status: upstream.status, headers: resultHeaders });
    // The response owns this bounded pump. Observe every rejection. An explicit
    // caller/deadline abort also interrupts a backpressured write.
    void stream.pipeTo(fixed.writable, { signal: controller.signal })
      .catch(() => { /* the readable reports the interruption to the consumer */ })
      .finally(cleanup);
    handedOff = true;
    return response;
  } catch { await discard(upstream); return staticError(502, "employee_gateway_unavailable"); }
  finally { if (!handedOff) { if (timer) clearTimeout(timer); signal?.removeEventListener("abort", abort); } }
}
