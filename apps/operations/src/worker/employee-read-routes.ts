import { Hono } from "hono";
import { authenticateNativeStaffWithAdmissionVersion, type AuthenticatedNativeStaffWithAdmissionVersion, type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { listEmployeeReadRoots, resolveEmployeeReadAuthority, recheckEmployeeReadAuthority } from "./employee-read-authority";
import { recordEmployeeContentStart } from "./employee-read-provisioning";
import { readEmployeeGateway, canonicalEmployeeReadPath, type EmployeeGatewayConfiguration, type EmployeeReadProof, type EmployeeReadSelection } from "./employee-read-transport";
import { employeeHandleContext, encodeEmployeeFileHandle, decodeEmployeeFileHandle, employeeFileProofMatches, employeeLogicalFileId } from "./employee-read-handles";

const BASE = "/api/staff/files", UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type ReadConfiguration = Readonly<{ enabled: boolean; opsOrigin: string; access: NativeStaffAccessConfiguration;
  gateway: EmployeeGatewayConfiguration; handleKey: Uint8Array }>;
type Bindings = { Variables: { employee: AuthenticatedNativeStaffWithAdmissionVersion } };
class Failure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const fail = (status: number, code: string): never => { throw new Failure(status, code); };
const errorResponse = (status: number, code: string) => Response.json({ error: code }, { status,
  headers: { "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
async function discard(response: Response) { try { await response.body?.cancel(); } catch { /* preserve denial */ } }
function query(url: string, allowed: readonly string[], required: readonly string[] = []): Map<string, string> {
  const raw = new URL(url).search.slice(1), result = new Map<string, string>();
  if (raw.length > 30_000) fail(400, "employee_read_query");
  if (raw) for (const part of raw.split("&")) {
    const split = part.indexOf("="); if (split < 0) fail(400, "employee_read_query");
    let key: string, value: string;
    try { key = decodeURIComponent(part.slice(0, split).replace(/\+/gu, " ")); value = decodeURIComponent(part.slice(split + 1).replace(/\+/gu, " ")); }
    catch { return fail(400, "employee_read_query"); }
    if (!allowed.includes(key) || result.has(key)) fail(400, "employee_read_query");
    result.set(key, value);
  }
  if (required.some(key => !result.has(key))) fail(400, "employee_read_query");
  return result;
}
function selection(url: string, operation: "list" | "manifest"): EmployeeReadSelection {
  const values = query(url, operation === "list" ? ["path", "cursor"] : ["path"], ["path"]), path = values.get("path")!;
  if (!canonicalEmployeeReadPath(path, operation === "list")) fail(400, "employee_read_path");
  const cursor = values.get("cursor") ?? null;
  if (cursor !== null && !/^[A-Za-z0-9._-]{1,8192}$/u.test(cursor)) fail(400, "employee_read_cursor");
  return { operation, path, cursor, snapshotId: null, expectedSha256: null, range: null };
}
export function employeeWindowsFileName(path: string): string {
  let name = (path.split("/").at(-1) ?? "").replace(/[\p{Cc}<>:"/\\|?*]/gu, "_").trim();
  const truncate = (value: string) => { let output = ""; for (const c of value) { if (output.length + c.length > 150) break; output += c; } return output; };
  name = truncate(name).trim().replace(/[. ]+$/u, "");
  if (!name || name === "." || name === "..") name = "download";
  if (/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(name) || name.toLowerCase() === ".ltds-downloads-v1") name = truncate("_" + name);
  return name;
}
function range(value: string | null, size: number): { start: number; end: number } | null {
  if (value === null) return null;
  const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)?$/u.exec(value);
  if (!match || size === 0) return fail(416, "employee_read_range");
  const start = Number(match[1]), end = match[2] === undefined ? size - 1 : Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= size) return fail(416, "employee_read_range");
  return { start, end };
}

/** Deliberately unmounted. Does not provision roots/grants or modify global Env. */
export function createEmployeeReadRouter(configuration: ReadConfiguration, dependencies: Readonly<{ database: D1Database; fetch?: typeof fetch }>) {
  const router = new Hono<Bindings>().basePath(BASE), database = dependencies.database, fetcher = dependencies.fetch ?? fetch;
  let config: ReadConfiguration | null = null;
  try {
    const value = { enabled: configuration.enabled, opsOrigin: configuration.opsOrigin, access: Object.freeze({ ...configuration.access }),
      gateway: Object.freeze({ ...configuration.gateway, key: new Uint8Array(configuration.gateway.key) }), handleKey: new Uint8Array(configuration.handleKey) };
    employeeHandleContext({ opsOrigin: value.opsOrigin, issuer: value.access.issuer, audience: value.access.staffAudience, key: value.handleKey });
    if (value.access.enabled !== true) throw Error();
    config = Object.freeze(value);
  } catch { /* Invalid deployment configuration fails closed at request admission. */ }
  const handles = () => employeeHandleContext({ opsOrigin: config!.opsOrigin, issuer: config!.access.issuer,
    audience: config!.access.staffAudience, key: config!.handleKey });
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "private, no-store"); c.header("Cloudflare-CDN-Cache-Control", "no-store"); c.header("X-Content-Type-Options", "nosniff");
    if (!config || config.enabled !== true) return errorResponse(503, "employee_read_disabled");
    if (new URL(c.req.url).origin !== config.opsOrigin || (c.req.header("Origin") !== undefined && c.req.header("Origin") !== config.opsOrigin)
      || c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site") return errorResponse(403, "employee_read_denied");
    if (c.req.method !== "GET") return errorResponse(405, "employee_read_method");
    try { c.set("employee", await authenticateNativeStaffWithAdmissionVersion(c.req.raw, database, config.access)); }
    catch { return errorResponse(401, "employee_read_login_required"); }
    return next();
  });
  async function current(auth: AuthenticatedNativeStaffWithAdmissionVersion, rootId: string, grantId?: string): Promise<EmployeeReadProof> {
    if (!UUID.test(rootId)) return fail(404, "employee_read_unavailable");
    const proof = await resolveEmployeeReadAuthority(database, auth, rootId, grantId);
    if (!proof || proof.gatewayId !== config!.gateway.gatewayId) return fail(403, "employee_read_denied");
    return proof;
  }
  const backend = (proof: EmployeeReadProof, selected: EmployeeReadSelection, signal: AbortSignal) => readEmployeeGateway(proof, selected, config!.gateway, {
    fetch: fetcher, recheck: value => recheckEmployeeReadAuthority(database, value),
    auditContentStart: (value, resource) => recordEmployeeContentStart(database, value, resource),
  }, signal);
  router.get("/roots", async c => {
    query(c.req.url, []);
    const roots = await listEmployeeReadRoots(database, c.get("employee"));
    if (roots === null) return fail(403, "employee_read_denied");
    return c.json({ schemaVersion: 1, roots: roots.filter(root => root.gatewayId === config!.gateway.gatewayId) });
  });
  router.get("/roots/:rootId/entries", async c => {
    const selected = selection(c.req.url, "list"), proof = await current(c.get("employee"), c.req.param("rootId"));
    return backend(proof, selected, c.req.raw.signal);
  });
  router.get("/roots/:rootId/manifest", async c => {
    const selected = selection(c.req.url, "manifest"), proof = await current(c.get("employee"), c.req.param("rootId"));
    const response = await backend(proof, selected, c.req.raw.signal);
    if (response.status !== 200) return response;
    const value = await response.json() as { sha256: string; size: number; snapshotId: string; snapshotExpiresAt: number };
    const expiresAt = Math.min(Math.floor(Date.now() / 1000) + 900, Math.floor(Date.parse(proof.verifiedUntil) / 1000), value.snapshotExpiresAt - 30);
    if (expiresAt <= Math.floor(Date.now() / 1000) + 5) return fail(409, "employee_read_renew_manifest");
    const handle = await encodeEmployeeFileHandle(handles(), { v: 1, proof, path: selected.path, snapshotId: value.snapshotId, sha256: value.sha256, size: value.size, expiresAt });
    const logicalFileId = await employeeLogicalFileId(handles(), proof, selected.path);
    if (!await recheckEmployeeReadAuthority(database, proof) || Date.now() >= expiresAt * 1000) return fail(403, "employee_read_denied");
    return c.json({ schemaVersion: 1, logicalFileId, remoteVersion: value.sha256, strongETag: `"${value.sha256}"`, size: value.size,
      sha256: value.sha256, name: employeeWindowsFileName(selected.path), downloadPath: `${BASE}/downloads/${handle}`, expiresAt });
  });
  router.get("/downloads/:fileHandle", async c => {
    query(c.req.url, []);
    const handle = await decodeEmployeeFileHandle(handles(), c.req.param("fileHandle"));
    if (!handle) return fail(404, "employee_read_unavailable");
    const auth = c.get("employee"), identity = auth.identity;
    if (handle.proof.staffId !== identity.staffId || handle.proof.accessSubject !== identity.verifiedAccessSubject
      || handle.proof.admissionVersion !== auth.admissionVersion || handle.proof.profileVersion !== identity.profileVersion) return fail(403, "employee_read_denied");
    const proof = await current(auth, handle.proof.rootId, handle.proof.grantId);
    if (!employeeFileProofMatches(handle, proof)) return fail(403, "employee_read_denied");
    if (c.req.header("If-Match") !== `"${handle.sha256}"`) return fail(412, "employee_read_etag");
    const requestedRange = range(c.req.header("Range") ?? null, handle.size);
    const boundedProof = { ...proof, verifiedUntil: new Date(Math.min(Date.parse(proof.verifiedUntil), handle.expiresAt * 1000)).toISOString() };
    const response = await backend(boundedProof, { operation: "content", path: handle.path, expectedSha256: handle.sha256,
      snapshotId: handle.snapshotId, range: requestedRange, cursor: null }, c.req.raw.signal);
    if (response.status !== 200 && response.status !== 206) return response;
    const expectedLength = requestedRange ? requestedRange.end - requestedRange.start + 1 : handle.size;
    if (response.headers.get("Content-Length") !== String(expectedLength)
      || (requestedRange !== null && response.headers.get("Content-Range") !== `bytes ${requestedRange.start}-${requestedRange.end}/${handle.size}`)) {
      await discard(response); return fail(503, "employee_read_unavailable");
    }
    if (!await recheckEmployeeReadAuthority(database, boundedProof) || Date.now() >= handle.expiresAt * 1000) {
      await discard(response); return fail(403, "employee_read_denied");
    }
    return response;
  });
  router.notFound(() => errorResponse(404, "employee_read_unavailable"));
  router.onError(error => error instanceof Failure ? errorResponse(error.status, error.code) : errorResponse(503, "employee_read_unavailable"));
  return router;
}
