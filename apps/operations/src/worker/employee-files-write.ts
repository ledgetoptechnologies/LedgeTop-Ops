import { Hono, type Context } from "hono";
import { authenticateNativeStaffWithAdmissionVersion, type AuthenticatedNativeStaffWithAdmissionVersion, type NativeStaffAccessConfiguration } from "./native-staff-auth";
import { recheckEmployeeWriteAuthority, resolveEmployeeWriteAuthority, type EmployeeReadAuthority } from "./employee-read-authority";
import { canonicalEmployeeReadPath } from "./employee-read-transport";

/** Staff Files writes, Ops side (slice 2b, contract revision 3). Source only: mounted solely by the staging composition.
 *
 * Desktop -> Ops (human Access session) -> durable intent + audit row (D1 triggers re-check the full write authority)
 * -> Ed25519 envelope over the exact audited values -> NAS container over the NAS link (Access service token).
 * Nothing is signed unless the audit row was written. The signing input is b"ltfiles-v2\n" || the exact envelope bytes.
 *
 * Revoke (R3.6): an envelope signed before a revoke stays valid until its expiresAt (<= 25 s after signing) and the NAS
 * can still commit it if its final pre-syscall freshness check passes in that window; a syscall already entered
 * completes. There is no immediate cancellation and no completion-by-expiry promise. */

const BASE = "/api/staff/files";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HEX32 = /^[0-9a-f]{32}$/u, HEX64 = /^[0-9a-f]{64}$/u, KEY_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const AUDIENCE = /^[A-Za-z0-9_-]{16,128}$/u, CLIENT_ID = /^[A-Za-z0-9._-]{1,256}$/u;
export const CHUNK_BYTES = 32 * 1024 * 1024;
export const ENVELOPE_SECONDS = 25;
const SIGNING_CONTEXT = new TextEncoder().encode("ltfiles-v2\n");
const PKCS8_ED25519_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export type FilesGatewayTransport = Readonly<{ scheme: "ed25519-nas-link" | "hmac-v1"; origin: string; audience: string | null }>;
export type FilesWriteConfiguration = Readonly<{
  enabled: boolean; opsOrigin: string; access: NativeStaffAccessConfiguration;
  transports: Readonly<Record<string, FilesGatewayTransport>>;
  servicePrincipal: string; accessClientId: string; accessClientSecret: string;
  keyId: string; signingSeed: Uint8Array;
}>;

/** Strict gateway -> {scheme, origin, audience} mapping (R3.7). Anything malformed fails closed as a whole. */
export function parseFilesGatewayTransports(text: unknown): Readonly<Record<string, FilesGatewayTransport>> {
  if (typeof text !== "string" || text.length > 16384) throw Error("transports");
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw Error("transports");
  const result: Record<string, FilesGatewayTransport> = {};
  for (const [gatewayId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!UUID.test(gatewayId) || !entry || typeof entry !== "object" || Array.isArray(entry)) throw Error("transports");
    const e = entry as Record<string, unknown>;
    if (Object.keys(e).sort().join() !== "audience,origin,scheme" || (e.scheme !== "ed25519-nas-link" && e.scheme !== "hmac-v1")
      || typeof e.origin !== "string") throw Error("transports");
    const origin = new URL(e.origin);
    if (origin.protocol !== "https:" || origin.origin !== e.origin || origin.username || origin.password) throw Error("transports");
    if (e.scheme === "ed25519-nas-link" ? typeof e.audience !== "string" || !AUDIENCE.test(e.audience) : e.audience !== null) throw Error("transports");
    result[gatewayId] = Object.freeze({ scheme: e.scheme, origin: e.origin, audience: e.audience as string | null });
  }
  if (!Object.keys(result).length || Object.keys(result).length > 100) throw Error("transports");
  return Object.freeze(result);
}

/** Seeding gate (R3.7), static part: every gateway any root references has exactly one mapping entry. The signed live
 * probe per entry is a separate staging step; until both pass, the mapper is not enabled. */
export async function filesGatewayTransportSeeding(database: D1Database, transports: Readonly<Record<string, FilesGatewayTransport>>) {
  const rows = await database.withSession("first-primary").prepare("SELECT DISTINCT gateway_id gatewayId FROM ops_employee_read_roots ORDER BY gateway_id")
    .all<{ gatewayId: string }>();
  if (!rows.success) throw Error("seeding");
  const missing = rows.results.map(row => row.gatewayId).filter(id => !Object.hasOwn(transports, id));
  return Object.freeze({ ok: missing.length === 0, missing: Object.freeze(missing) });
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isSafeInteger(value)) throw Error("number"); return String(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value as object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  throw Error("json");
}
async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>)), b => b.toString(16).padStart(2, "0")).join("");
}
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

/** Ed25519 signature over b"ltfiles-v2\n" || envelope bytes, with the Ops-only 32-byte seed. */
export async function signFilesEnvelope(seed: Uint8Array, envelopeBytes: Uint8Array): Promise<Uint8Array> {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw Error("seed");
  const pkcs8 = new Uint8Array(PKCS8_ED25519_PREFIX.length + 32);
  pkcs8.set(PKCS8_ED25519_PREFIX); pkcs8.set(seed, PKCS8_ED25519_PREFIX.length);
  const key = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  const message = new Uint8Array(SIGNING_CONTEXT.length + envelopeBytes.length);
  message.set(SIGNING_CONTEXT); message.set(envelopeBytes, SIGNING_CONTEXT.length);
  return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key, message));
}

class Failure extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const fail = (status: number, code: string): never => { throw new Failure(status, code); };
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const path = (v: unknown) => typeof v === "string" && canonicalEmployeeReadPath(v, false);
const objectId = (v: unknown) => typeof v === "string" && HEX32.test(v);
const etag = (v: unknown) => v === null || typeof v === "string" && HEX64.test(v);

type Begin = "mkdir" | "move" | "delete" | "trash.restore" | "upload.begin";
const BEGIN_ARGS: Record<Begin, readonly string[]> = {
  "mkdir": ["path", "parentId"], "move": ["source", "sourceId", "sourceEtag", "destination", "destinationParentId"],
  "delete": ["path", "id", "etag"], "trash.restore": ["trashId"], "upload.begin": ["path", "parentId", "size", "sha256", "precondition"],
};
/** Exact args per operation; the normalized form is what is hashed, audited and signed. */
function normalizedArgs(operation: string, args: unknown): Record<string, unknown> {
  if (operation in BEGIN_ARGS) {
    if (!exact(args, BEGIN_ARGS[operation as Begin])) fail(400, "invalid-request");
    const a = args as Record<string, unknown>;
    const ok = operation === "mkdir" ? path(a.path) && objectId(a.parentId)
      : operation === "move" ? path(a.source) && objectId(a.sourceId) && etag(a.sourceEtag) && path(a.destination) && objectId(a.destinationParentId)
      : operation === "delete" ? path(a.path) && objectId(a.id) && etag(a.etag)
      : operation === "trash.restore" ? typeof a.trashId === "string" && UUID.test(a.trashId)
      : path(a.path) && objectId(a.parentId) && Number.isSafeInteger(a.size) && (a.size as number) >= 0
        && typeof a.sha256 === "string" && HEX64.test(a.sha256) && exact(a.precondition, ["kind"]) && (a.precondition as { kind: unknown }).kind === "create";
    if (!ok) fail(400, "invalid-request");
    return JSON.parse(canonicalJson(a)) as Record<string, unknown>;
  }
  if (["upload.status", "upload.commit", "op.status"].includes(operation)) {
    if (!exact(args, [])) fail(400, "invalid-request");
    return {};
  }
  return fail(400, "invalid-request");
}

type Dependencies = Readonly<{ database: D1Database; fetch?: typeof fetch; now?: () => number; nonce?: () => string; requestId?: () => string;
  authenticate?: typeof authenticateNativeStaffWithAdmissionVersion }>;
type Bindings = { Variables: { employee: AuthenticatedNativeStaffWithAdmissionVersion } };

export function createEmployeeFilesWriteRouter(configuration: FilesWriteConfiguration, dependencies: Dependencies) {
  const router = new Hono<Bindings>().basePath(BASE);
  const database = dependencies.database, fetcher = dependencies.fetch ?? fetch, authenticate = dependencies.authenticate ?? authenticateNativeStaffWithAdmissionVersion;
  const now = dependencies.now ?? (() => Date.now());
  const nonce = dependencies.nonce ?? (() => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, "0")).join(""));
  const requestId = dependencies.requestId ?? (() => crypto.randomUUID());
  let config: (FilesWriteConfiguration & { signingSeed: Uint8Array }) | null = null;
  try {
    const c = configuration, origin = new URL(c.opsOrigin);
    if (c.enabled !== true || origin.protocol !== "https:" || origin.origin !== c.opsOrigin || c.access?.enabled !== true
      || !CLIENT_ID.test(c.servicePrincipal) || c.accessClientId !== c.servicePrincipal || typeof c.accessClientSecret !== "string"
      || c.accessClientSecret.length < 16 || c.accessClientSecret.length > 512 || !KEY_ID.test(c.keyId)
      || !(c.signingSeed instanceof Uint8Array) || c.signingSeed.length !== 32 || !c.transports || typeof c.transports !== "object") throw Error();
    config = Object.freeze({ ...c, access: Object.freeze({ ...c.access }), transports: Object.freeze({ ...c.transports }), signingSeed: new Uint8Array(c.signingSeed) });
  } catch { /* fails closed at request admission */ }
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: {
    "Content-Type": "application/json", "Cache-Control": "private, no-store", "Cloudflare-CDN-Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });

  router.use("/roots/:rootId/operations", gate);
  router.use("/roots/:rootId/uploads/*", gate);
  async function gate(c: Context<Bindings>, next: () => Promise<void>) {
    if (!config) return reply(503, { error: "files-write-unavailable" });
    if (new URL(c.req.url).origin !== config.opsOrigin || new URL(c.req.url).search
      || (c.req.header("Origin") !== undefined && c.req.header("Origin") !== config.opsOrigin)
      || c.req.header("Sec-Fetch-Site")?.toLowerCase() === "cross-site") return reply(403, { error: "denied" });
    try { c.set("employee", await authenticate(c.req.raw, database, config.access)); }
    catch { return reply(401, { error: "login-required" }); }
    await next();
  }

  /** Writes the audit row (the D1 trigger re-checks the whole write authority), signs, forwards, re-checks. */
  async function forward(proof: EmployeeReadAuthority, operationId: string, step: string, nasArgs: Record<string, unknown>, body: Uint8Array, chunkIndex: number | null) {
    const fixed = config!, transport = fixed.transports[proof.gatewayId];
    if (!transport || transport.scheme !== "ed25519-nas-link" || !transport.audience) return reply(503, { error: "files-write-unavailable" });
    const issuedAt = Math.floor(now() / 1000);
    const expiresAt = Math.min(issuedAt + ENVELOPE_SECONDS, Math.floor(Date.parse(proof.verifiedUntil) / 1000));
    if (expiresAt <= issuedAt) return reply(401, { error: "login-required" });
    const bodySha256 = await sha256Hex(body), argsSha256 = await sha256Hex(canonicalJson(nasArgs));
    try {
      await database.withSession("first-primary").prepare(`INSERT INTO ops_employee_files_write_requests(request_id,operation_id,step,gateway_id,root_id,
        root_generation,root_fingerprint,staff_id,access_subject,admission_version,profile_version,grant_id,grant_generation,args_sha256,body_sha256,
        chunk_index,envelope_expires_at,verified_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(requestId(), operationId, step, proof.gatewayId, proof.rootId, proof.rootGeneration, proof.rootFingerprint, proof.staffId,
          proof.accessSubject, proof.admissionVersion, proof.profileVersion, proof.grantId, proof.grantGeneration, argsSha256, bodySha256,
          chunkIndex, expiresAt, proof.verifiedUntil).run();
    } catch { return reply(403, { error: "denied" }); }  // no audit row: nothing is signed
    if (!await recheckEmployeeWriteAuthority(database, proof)) return reply(403, { error: "denied" });  // immediately before forwarding
    const envelope = { schemaVersion: 2, scope: "files-write", keyId: fixed.keyId, nonce: nonce(), issuedAt, expiresAt,
      audience: transport.audience, servicePrincipal: fixed.servicePrincipal, method: "POST", route: "/v2/op", operationId,
      actor: { staffId: proof.staffId, accessSubject: proof.accessSubject, admissionVersion: proof.admissionVersion },
      grant: { grantId: proof.grantId, grantGeneration: proof.grantGeneration, path: "", rights: ["read", "write"] },
      root: { rootId: proof.rootId, rootGeneration: proof.rootGeneration, rootFingerprint: proof.rootFingerprint, exclusive: true },
      operation: step, args: nasArgs, bodySha256 };
    const bytes = new TextEncoder().encode(JSON.stringify(envelope));
    const signature = await signFilesEnvelope(fixed.signingSeed, bytes);
    let response: Response;
    try {
      response = await fetcher(transport.origin + "/v2/op", { method: "POST", redirect: "manual", body: body as Uint8Array<ArrayBuffer>,
        headers: { "CF-Access-Client-Id": fixed.accessClientId, "CF-Access-Client-Secret": fixed.accessClientSecret,
          "X-Ltfiles-Envelope": b64url(bytes), "X-Ltfiles-Signature": b64url(signature), "Content-Type": "application/octet-stream" } });
    } catch { return reply(502, { error: "retry-with-same-operation-id" }); }
    if (response.status >= 500 || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => {});
      return reply(502, { error: "retry-with-same-operation-id" });
    }
    let result: unknown;
    try { result = JSON.parse(new TextDecoder().decode(await response.arrayBuffer())); }
    catch { return reply(502, { error: "retry-with-same-operation-id" }); }
    // A completed write cannot be recalled; a lapsed authority only withholds the result from this caller.
    if (!await recheckEmployeeWriteAuthority(database, proof)) return reply(409, { error: "authorization-changed" });
    return reply(response.status, result);
  }

  async function writeProof(c: { get: (key: "employee") => AuthenticatedNativeStaffWithAdmissionVersion }, rootId: string) {
    if (!UUID.test(rootId)) fail(404, "not-found");
    const proof = await resolveEmployeeWriteAuthority(database, c.get("employee"), rootId);
    return proof ?? fail(403, "denied");
  }
  /** The operation's immutable intent (R3.4) and its binding to the caller's current grant generation (R3.5). */
  async function intentFor(proof: EmployeeReadAuthority, operationId: string) {
    const row = await database.withSession("first-primary").prepare(`SELECT kind,intent_sha256 intentSha256,staff_id staffId,access_subject accessSubject,
      admission_version admissionVersion,root_id rootId,grant_id grantId,grant_generation grantGeneration FROM ops_employee_files_write_intents WHERE operation_id=?`)
      .bind(operationId).first<{ kind: string; intentSha256: string; staffId: string; accessSubject: string; admissionVersion: number; rootId: string; grantId: string; grantGeneration: number }>();
    if (!row) return null;
    if (row.staffId !== proof.staffId || row.accessSubject !== proof.accessSubject || row.admissionVersion !== proof.admissionVersion || row.rootId !== proof.rootId)
      fail(409, "operation-conflict");
    if (row.grantId !== proof.grantId || row.grantGeneration !== proof.grantGeneration) fail(409, "operation-grant-changed");
    return row;
  }

  router.post("/roots/:rootId/operations", async c => {
    try {
      if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(c.req.header("Content-Type") ?? "")) fail(400, "invalid-request");
      const raw = await c.req.arrayBuffer();
      if (raw.byteLength > 8192) fail(413, "too-large");
      let request: unknown;
      try { request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); } catch { fail(400, "invalid-request"); }
      if (!exact(request, ["operationId", "operation", "args"]) || typeof request.operationId !== "string" || !UUID.test(request.operationId)
        || typeof request.operation !== "string") fail(400, "invalid-request");
      const { operationId, operation } = request as { operationId: string; operation: string };
      const args = normalizedArgs(operation, (request as { args: unknown }).args);
      const proof = await writeProof(c, c.req.param("rootId"));
      const empty = new Uint8Array();
      if (operation in BEGIN_ARGS) {
        const intentSha256 = await sha256Hex(canonicalJson({ kind: operation, args }));
        const existing = await intentFor(proof, operationId);
        if (existing && (existing.kind !== operation || existing.intentSha256 !== intentSha256)) fail(409, "operation-conflict");
        if (!existing) {
          try {
            await database.withSession("first-primary").prepare(`INSERT INTO ops_employee_files_write_intents(operation_id,kind,intent_sha256,staff_id,access_subject,
              admission_version,gateway_id,root_id,root_generation,root_fingerprint,grant_id,grant_generation) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
              .bind(operationId, operation, intentSha256, proof.staffId, proof.accessSubject, proof.admissionVersion, proof.gatewayId, proof.rootId,
                proof.rootGeneration, proof.rootFingerprint, proof.grantId, proof.grantGeneration).run();
          } catch {
            const raced = await intentFor(proof, operationId);  // a concurrent identical begin is the same intent
            if (!raced || raced.kind !== operation || raced.intentSha256 !== intentSha256) fail(409, "operation-conflict");
          }
        }
        return forward(proof, operationId, operation, args, empty, null);
      }
      const intent = await intentFor(proof, operationId) ?? fail(404, "operation-not-found");
      if (operation !== "op.status" && intent.kind !== "upload.begin") fail(409, "operation-conflict");
      return forward(proof, operationId, operation, operation === "op.status" ? { targetOperationId: operationId } : {}, empty, null);
    } catch (error) {
      return error instanceof Failure ? reply(error.status, { error: error.code }) : reply(503, { error: "files-write-unavailable" });
    }
  });

  router.put("/roots/:rootId/uploads/:operationId/chunks/:index", async c => {
    try {
      const operationId = c.req.param("operationId"), indexText = c.req.param("index"), chunkSha256 = c.req.header("X-Chunk-Sha256") ?? "";
      if (!UUID.test(operationId) || !/^(?:0|[1-9][0-9]{0,6})$/u.test(indexText) || !HEX64.test(chunkSha256)) fail(400, "invalid-request");
      const declared = Number(c.req.header("Content-Length") ?? "-1");
      if (!Number.isSafeInteger(declared) || declared < 1 || declared > CHUNK_BYTES) fail(413, "too-large");
      const proof = await writeProof(c, c.req.param("rootId"));
      const intent = await intentFor(proof, operationId) ?? fail(404, "operation-not-found");
      if (intent.kind !== "upload.begin") fail(409, "operation-conflict");
      const body = new Uint8Array(await c.req.arrayBuffer());
      if (body.length !== declared || body.length > CHUNK_BYTES || await sha256Hex(body) !== chunkSha256) fail(400, "invalid-chunk");
      const index = Number(indexText);
      const session = database.withSession("first-primary");
      const stored = await session.prepare("SELECT chunk_sha256 sha FROM ops_employee_files_write_chunks WHERE operation_id=? AND chunk_index=?")
        .bind(operationId, index).first<{ sha: string }>();
      if (stored && stored.sha !== chunkSha256) fail(409, "chunk-conflict");
      if (!stored) {
        try { await session.prepare("INSERT INTO ops_employee_files_write_chunks(operation_id,chunk_index,chunk_sha256) VALUES(?,?,?)").bind(operationId, index, chunkSha256).run(); }
        catch {
          const raced = await session.prepare("SELECT chunk_sha256 sha FROM ops_employee_files_write_chunks WHERE operation_id=? AND chunk_index=?")
            .bind(operationId, index).first<{ sha: string }>();
          if (!raced || raced.sha !== chunkSha256) fail(409, "chunk-conflict");
        }
      }
      return forward(proof, operationId, "upload.chunk", { index, chunkSha256, chunkSize: body.length }, body, index);
    } catch (error) {
      return error instanceof Failure ? reply(error.status, { error: error.code }) : reply(503, { error: "files-write-unavailable" });
    }
  });
  return router;
}
