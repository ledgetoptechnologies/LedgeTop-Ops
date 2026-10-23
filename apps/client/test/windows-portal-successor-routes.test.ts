import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { fixture, id, principal } from "./helpers/windows-portal-successor-fixture";
import { createWindowsPortalSuccessorRouter, prepareWindowsPortalSuccessorManifest, type WindowsPortalSuccessorRouteEnv } from "../src/worker/client-portal/windows-portal-successor-routes";
import { encodeWindowsPortalSuccessorHandle } from "../src/worker/client-portal/windows-portal-successor-handles";
import { createOperationsNativeDeliveryRouter } from "../src/worker/client-portal/operations-native-delivery-routes";
import { encodeOperationsNativeDeliveryHandle } from "../src/worker/client-portal/operations-native-delivery-handles";
import type { WindowsPortalSuccessorContext } from "../src/worker/client-portal/windows-portal-successor-authorization";

const mocks = vi.hoisted(() => ({ keys: vi.fn(), audit: vi.fn() }));
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: mocks.keys }));
vi.mock("../src/worker/client-portal/windows-portal-successor-content-audit", () => ({ appendWindowsPortalSuccessorContentStart: mocks.audit }));
const origin = "https://portal-staging.ledgetopdroneservices.com", audience = "synthetic-successor-audience";
const base = "/api/client/operations/data/windows-successor", bytes = new TextEncoder().encode("synthetic successor immutable content");
const digest = await crypto.subtle.digest("SHA-256", bytes);
const sha = [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join(""), etag = '"synthetic-etag"';
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => { pair = await generateKeyPair("RS256", { extractable: true }); });
afterEach(() => vi.useRealTimers());
async function setup() {
  const f = await fixture();
  const jwk = await exportJWK(pair.publicKey); jwk.kid = "synthetic";
  mocks.keys.mockReturnValue(createLocalJWKSet({ keys: [jwk] })); mocks.audit.mockReset(); mocks.audit.mockResolvedValue({ eventId: "synthetic-audit" });
  const context: WindowsPortalSuccessorContext = { kind: "windows-portal-successor-v1", originalGrant: f.command,
    originalRequestFingerprint: f.candidate.request_fingerprint, selectedR2Prefix: f.command.resource.selectedR2Prefix, continuity: f.successor.continuity };
  const row = { r2_key: "synthetic/photos/map.tif", etag: "synthetic-etag", size: bytes.length, content_type: "image/tiff" };
  const candidate = vi.fn(async () => f.candidate as typeof f.candidate | null), index = vi.fn(async () => row as typeof row | null);
  const headValue = { etag: "synthetic-etag", httpEtag: etag, size: bytes.length, version: "provider-one", checksums: { sha256: digest } };
  const head = vi.fn(async () => ({ ...headValue }) as R2Object | null), cancel = vi.fn();
  const get = vi.fn(async (_key: string, options?: R2GetOptions) => {
    const range = options?.range as { offset: number; length: number } | undefined;
    const selected = range ? bytes.slice(range.offset, range.offset + range.length) : bytes;
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(selected); controller.close(); }, cancel });
    return { ...headValue, body } as unknown as R2ObjectBody;
  });
  const rpc = vi.fn(async () => JSON.stringify(f.reply));
  const env = { ENVIRONMENT: "staging", CLIENT_PORTAL_ORIGIN: origin, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true",
    DELIVERY_SESSION_SECRET: "synthetic-current-key-".repeat(3), CLIENT_ACCESS_TEAM_DOMAIN: principal.issuer,
    CLIENT_ACCESS_AUD: audience, CLIENT_PORTAL_ORIGINS: origin,
    DELIVERY_DB: { withSession: () => ({ prepare: (sql: string) => ({ bind: () => ({ first: () => sql.includes("FROM file_index") ? index() : candidate() }) }) }) },
    DATA_BUCKET: { head, get }, OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: {
      readWindowsDeliverySuccessorAuthorization: rpc,
      readNativeDeliveryAuthorization: async () => JSON.stringify({ ok: true, protocolVersion: 1, authorization: f.successor.authorization }),
    } } as unknown as WindowsPortalSuccessorRouteEnv;
  const jwt = (subject = principal.subject, extra: Record<string, unknown> = {}) => new SignJWT({ type: "app", email: "synthetic@example.invalid", ...extra })
    .setProtectedHeader({ alg: "RS256", kid: "synthetic" }).setIssuer(principal.issuer).setSubject(subject).setAudience(audience).setExpirationTime("1h").sign(pair.privateKey);
  const token = await jwt(), until = Date.now() + 600_000;
  const handle = await encodeWindowsPortalSuccessorHandle(env, context, principal, until, { path: "map.tif", etag, providerVersion: "provider-one", sha256: sha, size: bytes.length });
  const router = createWindowsPortalSuccessorRouter({ enabled: true, portalOrigin: origin, issuer: principal.issuer, audience });
  const call = (headers: HeadersInit = {}, method = "GET", path = `${base}/files/${handle}/download`, assertion = token) => router.fetch(new Request(origin + path,
    { method, headers: { "Cf-Access-Jwt-Assertion": assertion, ...headers } }), env);
  return { ...f, candidateRow: f.candidate, env, context, row, candidate, index, headValue, head, get, cancel, rpc, jwt, token, until, handle, router, call };
}

describe("unmounted Windows portal successor content", () => {
  it("verifies a real signed human and streams pinned bytes after distinct mandatory audit", async () => {
    const f = await setup(), response = await f.call();
    expect(response.status).toBe(200); expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream"); expect(response.headers.get("ETag")).toBe(etag);
    expect(f.get).toHaveBeenCalledExactlyOnceWith(f.row.r2_key, { onlyIf: { etagMatches: "synthetic-etag" } });
    expect(mocks.audit).toHaveBeenCalledExactlyOnceWith(f.env, expect.objectContaining({ context: expect.objectContaining({ kind: "windows-portal-successor-v1" }),
      indexedETag: f.row.etag, strongETag: etag, providerVersion: "provider-one", sha256: sha, size: bytes.length }));
    expect(f.rpc.mock.calls.length).toBeGreaterThanOrEqual(8);
  });
  it("returns exact resume ranges and refuses mismatched If-Match without source bytes", async () => {
    const f = await setup(), response = await f.call({ Range: "bytes=8-", "If-Range": etag, "If-Match": etag });
    expect(response.status).toBe(206); expect(response.headers.get("Content-Range")).toBe(`bytes 8-${bytes.length - 1}/${bytes.length}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes.slice(8));
    expect(f.get).toHaveBeenLastCalledWith(f.row.r2_key, { range: { offset: 8, length: bytes.length - 8 }, onlyIf: { etagMatches: "synthetic-etag" } });
    f.get.mockClear(); mocks.audit.mockClear(); expect((await f.call({ "If-Match": '"other"' })).status).toBe(412);
    expect(f.get).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("freshly authorizes HEAD 304 and 416 metadata with no content audit", async () => {
    const f = await setup();
    expect((await f.call({}, "HEAD")).status).toBe(200);
    expect((await f.call({ Range: "bytes=99999-" })).status).toBe(416);
    expect((await f.call({ "If-None-Match": etag })).status).toBe(304);
    expect(f.rpc.mock.calls.length).toBeGreaterThan(12); expect(f.get).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it.each(["provider", "etag", "sha", "size", "moved"])("rejects stale or moved R2 %s before bytes", async changed => {
    const f = await setup();
    f.head.mockResolvedValue({ ...f.headValue, ...(changed === "provider" ? { version: "different" } : changed === "etag" ? { etag: "different", httpEtag: '"different"' }
      : changed === "sha" ? { checksums: { sha256: new Uint8Array(32).buffer } } : changed === "size" ? { size: bytes.length + 1 }
        : { customMetadata: { ltdsMoveMarker: "ltds-moved-source-v1" } }) } as R2Object);
    expect((await f.call()).status).toBe(404); expect(f.get).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("rejects changed index and tombstoned/missing selection before R2", async () => {
    for (const row of [null, { etag: "wrong" }, { size: bytes.length + 1 }]) {
      const f = await setup(); f.index.mockResolvedValue(row === null ? null : { ...f.row, ...row });
      expect((await f.call()).status).toBe(404); expect(f.head).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
    }
  });
  it("denies concurrent publication refresh and revocation after R2 HEAD", async () => {
    for (const change of ["revoke", "publication"]) {
      const f = await setup(); f.head.mockImplementation(async () => {
        if (change === "revoke") f.candidate.mockResolvedValue(null);
        else f.candidate.mockResolvedValue({ ...f.candidateRow, snapshot_id: id(999) });
        return f.headValue as R2Object;
      });
      expect([404, 503]).toContain((await f.call()).status); expect(f.get).not.toHaveBeenCalled();
    }
  });
  it("cancels acquired bodies on audit or post-GET authorization failure", async () => {
    for (const phase of ["audit", "post-get", "after-audit", "provider-get", "provider-after-audit", "sha-after-audit"]) {
      const f = await setup(), canceled = vi.fn();
      f.get.mockImplementation(async () => {
        if (phase === "post-get") f.candidate.mockResolvedValue(null);
        return { ...f.headValue, ...(phase === "provider-get" ? { version: "wrong" } : {}), body: new ReadableStream<Uint8Array>({ cancel: canceled }) } as unknown as R2ObjectBody;
      });
      if (phase === "audit") mocks.audit.mockRejectedValue(Error("synthetic-secret-error-never-exposed"));
      if (phase === "after-audit") mocks.audit.mockImplementation(async () => { f.candidate.mockResolvedValue(null); });
      if (phase === "provider-after-audit" || phase === "sha-after-audit") mocks.audit.mockImplementation(async () => {
        f.head.mockResolvedValue({ ...f.headValue, ...(phase === "provider-after-audit" ? { version: "changed-after-audit" }
          : { checksums: { sha256: new Uint8Array(32).buffer } }) } as R2Object);
      });
      const response = await f.call(); expect([404, 503]).toContain(response.status); expect(canceled).toHaveBeenCalledOnce();
      expect(await response.text()).not.toContain("synthetic-secret-error");
    }
  });
  it("rejects other people machines foreign origin query aliases and nonread methods", async () => {
    const f = await setup();
    expect((await f.call({}, "GET", undefined, await f.jwt("other-person"))).status).toBe(404);
    expect((await f.call({}, "GET", undefined, await f.jwt(principal.subject, { service_token_id: "machine" }))).status).toBe(401);
    expect((await f.call({ Origin: "https://other.invalid" })).status).toBe(403);
    expect((await f.call({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await f.call({}, "GET", `${base}/files/${f.handle}/download?token=bad`)).status).toBe(400);
    expect((await f.call({}, "POST")).status).toBe(405);
    expect((await f.call({}, "GET", `${base}/files/ond1_wrong/download`)).status).toBe(404);
    expect(f.head).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
  it("rejects expired human proof after HEAD and disabled or missing human identity before storage", async () => {
    const f = await setup();
    expect((await f.call({}, "GET", undefined, "")).status).toBe(401);
    const disabled = createWindowsPortalSuccessorRouter({ enabled: false, portalOrigin: origin, issuer: principal.issuer, audience });
    expect((await disabled.fetch(new Request(origin + `${base}/files/${f.handle}/download`), f.env)).status).toBe(503);
    vi.useFakeTimers(); vi.setSystemTime(Date.now());
    f.head.mockImplementation(async () => { vi.setSystemTime(Date.now() + 3_601_000); return f.headValue as R2Object; });
    expect((await f.call()).status).toBe(401); expect(f.get).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
  it("a stale If-Range produces a full pinned response, never an incorrect partial", async () => {
    const f = await setup(), response = await f.call({ Range: "bytes=8-", "If-Range": '"old"' });
    expect(response.status).toBe(200); expect(response.headers.has("Content-Range")).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(f.get).toHaveBeenCalledWith(f.row.r2_key, { onlyIf: { etagMatches: "synthetic-etag" } });
  });
  it("manifest uses the exact ordinary logical identity and fresh successor-only byte path", async () => {
    const f = await setup(), manifest = await prepareWindowsPortalSuccessorManifest(f.env, f.context, principal, f.until, "map.tif");
    const value = await manifest.json() as Record<string, unknown>;
    expect(Object.keys(value)).toHaveLength(9); expect(value.downloadPath).toMatch(/^\/api\/client\/operations\/data\/windows-successor\/files\/wsp1_/u);
    const g = f.command;
    const ordinary = await encodeOperationsNativeDeliveryHandle(f.env, { v: 1, kind: "file", authorityId: g.authority.authorityId,
      authorityRevision: g.authority.resultingRevision, ...g.recipient, targetId: g.target.targetId, targetRevision: g.target.targetRevision,
      clientAuthorityId: g.target.clientAuthorityId, workspaceId: g.target.workspaceId, publicationOperationId: g.publication.operationId,
      publicationId: g.publication.publicationId, publicationRevision: g.publication.revision, publicationSourceSequence: g.publication.sourceSequence,
      snapshotId: g.publication.snapshotId, snapshotSha256: g.publication.snapshotSha256, folderReservationId: g.resource.folderReservationId,
      folderReservationRevision: g.resource.folderReservationRevision, clientFolderBindingId: g.resource.clientFolderBindingId,
      externalProjectId: g.resource.externalProjectId, projectVersion: g.resource.projectVersion, path: "map.tif", etag: f.row.etag, expires: f.until });
    const existing = await createOperationsNativeDeliveryRouter({ resolvePrincipal: async () => ({ ...principal, email: "synthetic@example.invalid" }) }).fetch(new Request(origin + `/files/${ordinary}/download-manifest`), f.env);
    expect(existing.status).toBe(200); expect(value.logicalFileId).toBe((await existing.json() as Record<string, unknown>).logicalFileId);
    expect(f.get).not.toHaveBeenCalled(); expect(mocks.audit).not.toHaveBeenCalled();
  });
});
