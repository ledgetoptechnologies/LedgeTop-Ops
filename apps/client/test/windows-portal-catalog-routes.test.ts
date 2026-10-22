import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand as canonical, sha256OperationsPortalNativeDeliveryAuthorityCommand as fingerprint, type OperationsPortalNativeDeliveryFeature } from "@ltds/shared/operations-portal-native-delivery-authority";
import { fixture, id, principal } from "./helpers/windows-portal-successor-fixture";
import { createWindowsPortalCatalogRouter, type WindowsPortalCatalogRouteEnv } from "../src/worker/client-portal/windows-portal-catalog-routes";
import { createOperationsNativeQueueRouter } from "../src/worker/client-portal/operations-native-queue-routes";
import { createWindowsPortalSuccessorRouter } from "../src/worker/client-portal/windows-portal-successor-routes";
import { authorizeWindowsPortalCatalog } from "../src/worker/client-portal/windows-portal-catalog-authorization";
import { encodeWindowsPortalCatalogHandle, decodeWindowsPortalCatalogHandle } from "../src/worker/client-portal/windows-portal-catalog-handles";

const keys = vi.hoisted(() => vi.fn());
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: keys }));
const origin = "https://portal-staging.ledgetopdroneservices.com", audience = "synthetic-catalog-audience";
const base = "/api/client/operations/data/windows-catalog", queueBase = "/api/client/operations/data/queue";
const config = { enabled: true, portalOrigin: origin, issuer: principal.issuer, audience, queueKey: new Uint8Array(32).fill(17) };
const bytes = new TextEncoder().encode("synthetic catalog verified content"), sha = await crypto.subtle.digest("SHA-256", bytes);
let pair: Awaited<ReturnType<typeof generateKeyPair>>;
beforeAll(async () => { pair = await generateKeyPair("RS256", { extractable: true }); const key = await exportJWK(pair.publicKey); key.kid = "catalog"; keys.mockReturnValue(createLocalJWKSet({ keys: [key] })); });
afterEach(() => vi.useRealTimers());
type Entry = { entry_kind: "folder" | "file"; entry_name: string; r2_key: string | null; etag: string | null; size: number | null };
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly unknown[] ? T[K][number][] : T[K] extends object ? Mutable<T[K]> : T[K] };
async function setup(features: readonly OperationsPortalNativeDeliveryFeature[] = ["folder.list", "file.metadata", "file.download"]) {
  const f = await fixture() as Mutable<Awaited<ReturnType<typeof fixture>>>;
  f.command.features = [...features]; f.successor.authorization = { ...f.successor.authorization, features: [...features] };
  f.candidate.canonical_command_json = canonical(f.command); f.candidate.request_fingerprint = await fingerprint(f.command);
  f.successor.continuity = { ...f.successor.continuity, grantFingerprint: f.candidate.request_fingerprint };
  const candidate = vi.fn(async (..._args: unknown[]) => ({ ...f.candidate }) as typeof f.candidate | null);
  const file = { r2_key: "synthetic/photos/map.bin", etag: "synthetic-etag", size: bytes.length };
  const index = vi.fn(async () => ({ ...file }) as typeof file | null), label = vi.fn(async () => "Synthetic current project");
  const entries: Entry[] = [{ entry_kind: "folder", entry_name: "subfolder", r2_key: null, etag: null, size: null },
    { entry_kind: "file", entry_name: "map.bin", ...file }];
  const listing = vi.fn(async (...args: unknown[]) => {
    const after = String(args[3]), kind = String(args[4]);
    return { success: true, results: entries.filter(e => (args[5] === 1 || e.entry_kind === "folder") && (e.entry_name > after || e.entry_name === after && e.entry_kind > kind))
      .sort((a, b) => a.entry_name < b.entry_name ? -1 : a.entry_name > b.entry_name ? 1 : a.entry_kind < b.entry_kind ? -1 : 1).slice(0, Number(args[6])) };
  });
  const discoveries = vi.fn(async () => ({ success: true, results: features.includes("folder.list") ? [{ authority_id: id(2) }] : [] }));
  const catalogRpc = vi.fn(async (_wire: string, feature: string) => JSON.stringify({ ok: true, protocolVersion: 1, feature, catalog: f.successor }));
  const downloadRpc = vi.fn(async () => JSON.stringify({ ok: true, protocolVersion: 1, successor: f.successor }));
  const head = vi.fn(async () => ({ etag: file.etag, httpEtag: `"${file.etag}"`, size: file.size, version: "synthetic-provider", checksums: { sha256: sha } }));
  const get = vi.fn(), ordinary = vi.fn(async () => { throw new Error("ordinary authorization must not rescue catalog denial"); });
  const env = { ENVIRONMENT: "staging", CLIENT_PORTAL_ORIGIN: origin, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true",
    DELIVERY_SESSION_SECRET: "synthetic-catalog-selector-secret-".repeat(3), CLIENT_ACCESS_TEAM_DOMAIN: principal.issuer, CLIENT_ACCESS_AUD: audience,
    DELIVERY_DB: { withSession: () => ({ prepare: (sql: string) => ({ bind: (...args: unknown[]) => ({
      first: () => sql.includes("operations_portal_native_delivery_successor_candidates") ? candidate(...args) : sql.includes("FROM file_index") ? index() : label(),
      all: () => sql.includes("WITH candidates") ? listing(...args) : discoveries(),
    }) }) }) }, DATA_BUCKET: { head, get }, OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: {
      readNativeDeliveryAuthorization: ordinary, readWindowsCatalogSuccessorAuthorization: catalogRpc, readWindowsDeliverySuccessorAuthorization: downloadRpc,
    } } as unknown as WindowsPortalCatalogRouteEnv;
  const token = (subject = principal.subject, claims: Record<string, unknown> = {}) => new SignJWT({ type: "app", email: "synthetic@example.invalid", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "catalog" }).setIssuer(principal.issuer).setSubject(subject).setAudience(audience).setExpirationTime("1h").sign(pair.privateKey);
  const jwt = await token(), router = createWindowsPortalCatalogRouter(config), queue = createOperationsNativeQueueRouter(config);
  const request = (path: string, assertion = jwt, extra: HeadersInit = {}) => new Request(origin + path, { headers: { "Cf-Access-Jwt-Assertion": assertion, ...extra } });
  const call = (path: string, assertion = jwt, extra: HeadersInit = {}) => router.fetch(request(base + path, assertion, extra), env);
  async function fileHandle() {
    const proof = await authorizeWindowsPortalCatalog(env, principal, id(2), "file.metadata"); if (!proof.ok) throw new Error("missing synthetic metadata permission");
    return encodeWindowsPortalCatalogHandle(env, proof.catalogContext, principal, Date.now() + 600_000, { kind: "file", path: "map.bin", indexedETag: file.etag, size: file.size });
  }
  async function rootHandle() {
    const response = await call("/deliveries"); expect(response.status).toBe(200);
    return ((await response.json()) as { items: { id: string }[] }).items[0]!.id;
  }
  return { ...f, candidateRow: f.candidate, env, candidate, file, index, label, entries, listing, discoveries, catalogRpc, downloadRpc, head, get, ordinary,
    router, queue, request, call, token, jwt, fileHandle, rootHandle };
}
type Folder = { files: { id: string; name: string; size: number; downloadAvailable: boolean }[]; folders: { id: string; name: string }[]; cursor: string | null };

describe("continuous Windows catalog with signed human and distinct permission proofs", () => {
  it("lists directories with folder.list alone without file metadata, download proof or storage reads", async () => {
    const f = await setup(["folder.list"]), root = await f.rootHandle();
    f.entries.push(...Array.from({ length: 30 }, (_, n) => ({ entry_kind: "file" as const, entry_name: `hidden-file-${n}`, r2_key: `synthetic/photos/hidden-file-${n}`, etag: "etag", size: 1 })));
    const response = await f.call("/folders/" + root); expect(response.status).toBe(200);
    const page = await response.json() as Folder; expect(page.files).toEqual([]); expect(page.folders.map(x => x.name)).toEqual(["subfolder"]); expect(page.cursor).toBeNull();
    expect(f.catalogRpc.mock.calls.every(([, feature]) => feature === "folder.list")).toBe(true);
    expect(f.downloadRpc).not.toHaveBeenCalled(); expect(f.head).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
  it("reads metadata without discovery and refuses manifests/reference creation without download permission", async () => {
    const f = await setup(["file.metadata"]), handle = await f.fileHandle();
    expect(await (await f.call("/deliveries")).json()).toMatchObject({ items: [] });
    const response = await f.call("/files/" + handle); expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ file: { name: "map.bin", downloadAvailable: false } });
    expect((await f.call("/files/" + handle + "/download-manifest")).status).toBe(404);
    expect((await f.queue.fetch(f.request(queueBase + "/reference?fileHandle=" + handle), f.env)).status).toBe(404);
    expect(f.downloadRpc).not.toHaveBeenCalled(); expect(f.head).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
  it("does not turn combined browsing permission into byte permission", async () => {
    const f = await setup(["folder.list", "file.metadata"]), root = await f.rootHandle();
    const page = await (await f.call("/folders/" + root)).json() as Folder;
    expect(page.files[0]).toMatchObject({ name: "map.bin", downloadAvailable: false });
    expect((await f.call("/files/" + page.files[0]!.id + "/download-manifest")).status).toBe(404);
    expect(f.head).not.toHaveBeenCalled(); expect(f.ordinary).not.toHaveBeenCalled();
  });
  it("converts an authorized catalog file into an original durable reference without eager index or R2 work", async () => {
    const f = await setup(), handle = await f.fileHandle(); f.index.mockClear();
    const response = await f.queue.fetch(f.request(queueBase + "/reference?fileHandle=" + handle), f.env); expect(response.status).toBe(200);
    const selected = await response.json() as { resourceRef: string }; expect(selected.resourceRef).toMatch(/^odqr1_/u);
    expect(f.index).not.toHaveBeenCalled(); expect(f.head).not.toHaveBeenCalled();
    const manifestResponse = await f.call("/files/" + handle + "/download-manifest"); expect(manifestResponse.status).toBe(200);
    const manifest = await manifestResponse.json() as { logicalFileId: string; downloadPath: string };
    const resolved = await f.queue.fetch(f.request(queueBase + "/resolve?resourceRef=" + selected.resourceRef), f.env); expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ manifest: { logicalFileId: manifest.logicalFileId } });
    expect(manifest.downloadPath).toMatch(/^\/api\/client\/operations\/data\/windows-successor\/files\/wsp1_[A-Za-z0-9_-]+\/download$/u);
    expect(f.get).not.toHaveBeenCalled(); expect(f.ordinary).not.toHaveBeenCalled();
  });
  it("never accepts a catalog selector at the byte route", async () => {
    const f = await setup(), handle = await f.fileHandle();
    const response = await createWindowsPortalSuccessorRouter(config).fetch(f.request("/api/client/operations/data/windows-successor/files/" + handle + "/download"), f.env);
    expect(response.status).toBe(404); expect(f.head).not.toHaveBeenCalled();
  });
  it("returns no reference when permission is revoked during final reference creation", async () => {
    const f = await setup(), handle = await f.fileHandle();
    f.downloadRpc.mockResolvedValueOnce(JSON.stringify({ ok: true, protocolVersion: 1, successor: f.successor }))
      .mockResolvedValue(JSON.stringify({ ok: false, protocolVersion: 1, code: "denied" }));
    const response = await f.queue.fetch(f.request(queueBase + "/reference?fileHandle=" + handle), f.env);
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: "queue_unavailable" });
    expect(f.downloadRpc).toHaveBeenCalledTimes(2); expect(f.index).not.toHaveBeenCalled(); expect(f.head).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
  it.each([false, true])("bounds discovery RPC concurrency and drains admitted work on failure=%s", async failure => {
    const f = await setup(), records = new Map<string, { candidate: typeof f.candidateRow; successor: typeof f.successor }>();
    for (let n = 0; n < 26; n++) {
      const authorityId = id(2000 + n), operationId = id(3000 + n), folderReservationId = id(4000 + n);
      const command = { ...f.command, operationId, authority: { ...f.command.authority, authorityId }, resource: { ...f.command.resource, folderReservationId } };
      const hash = await fingerprint(command);
      records.set(authorityId, { candidate: { ...f.candidateRow, canonical_command_json: canonical(command), request_fingerprint: hash },
        successor: { ...f.successor, authorization: { ...f.successor.authorization, authorityId, folderReservationId },
          continuity: { ...f.successor.continuity, grantOperationId: operationId, grantFingerprint: hash } } });
    }
    f.discoveries.mockResolvedValue({ success: true, results: [...records.keys()].map(authority_id => ({ authority_id })) });
    f.candidate.mockImplementation(async (...args: unknown[]) => records.get(String(args[0]))?.candidate ?? null);
    let active = 0, peak = 0;
    f.catalogRpc.mockImplementation(async (wire: string, feature: string) => {
      active++; peak = Math.max(peak, active);
      try {
        await new Promise(resolve => setTimeout(resolve, 5));
        const authorityId = JSON.parse(wire).authority.authorityId as string;
        if (failure && authorityId === id(2000)) return JSON.stringify({ ok: false, protocolVersion: 1, code: "denied" });
        return JSON.stringify({ ok: true, protocolVersion: 1, feature, catalog: records.get(authorityId)!.successor });
      } finally { active--; }
    });
    const response = await f.call("/deliveries");
    expect(active).toBe(0); expect(peak).toBeGreaterThan(1); expect(peak).toBeLessThanOrEqual(4);
    if (failure) { expect(response.status).toBe(404); expect(f.catalogRpc).toHaveBeenCalledTimes(4); }
    else {
      expect(response.status).toBe(200);
      const page = await response.json() as { items: { id: string }[]; page: { nextCursor: string } };
      expect(page.items).toHaveLength(25);
      const decoded = await Promise.all(page.items.map(item => decodeWindowsPortalCatalogHandle(f.env, item.id)));
      expect(decoded.map(item => item!.authorityId)).toEqual([...records.keys()].slice(0, 25));
      const cursor = await decodeWindowsPortalCatalogHandle(f.env, page.page.nextCursor);
      expect(cursor).toMatchObject({ kind: "cursor", scope: "deliveries", after: id(2024), authorityId: id(2024) });
    }
  });
  it("provides bounded pagination and rejects stale cursors/handles instead of mixing publications", async () => {
    const f = await setup(), root = await f.rootHandle();
    f.entries.splice(0, f.entries.length, ...Array.from({ length: 26 }, (_, n) => ({ entry_kind: "file" as const, entry_name: `map-${String(n).padStart(2, "0")}.bin`, r2_key: `synthetic/photos/map-${String(n).padStart(2, "0")}.bin`, etag: "etag", size: 1 })));
    const page = await (await f.call("/folders/" + root)).json() as Folder; expect(page.files).toHaveLength(25); expect(page.cursor).toMatch(/^wpc1_/u);
    const next = await (await f.call("/folders/" + root + "?cursor=" + page.cursor)).json() as Folder; expect(next.files).toHaveLength(1); expect(next.cursor).toBeNull();
    Object.assign(f.candidateRow, { publication_operation_id: id(104), publication_id: id(204), publication_revision: 4,
      publication_source_sequence: 4, snapshot_id: id(304), snapshot_sha256: "e".repeat(64) });
    f.successor.continuity = { ...f.successor.continuity, current: { operationId: id(104), publicationId: id(204), revision: 4,
      sourceSequence: 4, snapshotId: id(304), snapshotSha256: "e".repeat(64) }, publicationCount: 4, chainSha256: "f".repeat(64) };
    expect((await f.call("/folders/" + root + "?cursor=" + page.cursor)).status).toBe(404);
    expect((await f.call("/files/" + page.files[0]!.id)).status).toBe(404);
    const refreshed = await f.rootHandle(); expect((await f.call("/folders/" + refreshed)).status).toBe(200);
    expect(f.head).not.toHaveBeenCalled();
  });
  it("denies metadata if index identity changed after the handle was minted", async () => {
    for (const change of ["etag", "size"] as const) {
      const f = await setup(), handle = await f.fileHandle(); f.index.mockResolvedValue({ ...f.file, [change]: change === "etag" ? "changed" : f.file.size + 1 });
      expect((await f.call("/files/" + handle)).status).toBe(404); expect(f.head).not.toHaveBeenCalled();
    }
  });
  it("fails closed on grant/publication changes while labels or listings are in flight", async () => {
    for (const phase of ["label", "listing"]) {
      const f = await setup(), root = await f.rootHandle();
      if (phase === "label") f.label.mockImplementation(async () => { f.candidate.mockResolvedValue(null); return "never disclosed"; });
      else f.listing.mockImplementation(async () => { f.candidate.mockResolvedValue(null); return { success: true, results: f.entries }; });
      expect([404, 503]).toContain((await f.call(phase === "label" ? "/deliveries" : "/folders/" + root)).status);
      expect(f.head).not.toHaveBeenCalled();
    }
  });
  it("refuses mismatched metadata/download continuity before storage", async () => {
    const f = await setup(), handle = await f.fileHandle();
    f.downloadRpc.mockResolvedValue(JSON.stringify({ ok: true, protocolVersion: 1, successor: { ...f.successor, continuity: { ...f.successor.continuity, chainSha256: "e".repeat(64) } } }));
    expect((await f.call("/files/" + handle + "/download-manifest")).status).toBe(404);
    expect(f.head).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled();
  });
  it("rejects wrong people, machines, cross-site requests, unknown queries and encoded aliases", async () => {
    const f = await setup(), handle = await f.fileHandle();
    expect((await f.call("/files/" + handle, await f.token("other-person"))).status).toBe(404);
    expect((await f.call("/deliveries", await f.token(principal.subject, { service_token_id: "machine" }))).status).toBe(401);
    expect((await f.call("/deliveries", f.jwt, { Origin: "https://evil.invalid" })).status).toBe(403);
    expect((await f.call("/deliveries?extra=1")).status).toBe(503);
    expect((await f.call("/deliveries?cursor=x&%63ursor=y")).status).toBe(503);
    expect((await f.call("/files/" + "%77" + handle.slice(1))).status).toBe(404);
    expect(f.head).not.toHaveBeenCalled();
  });
});
