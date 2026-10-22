import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { createEmployeeQueueRouter } from "../src/worker/employee-queue-routes";
import { createEmployeeReadRouter } from "../src/worker/employee-read-routes";

// Only replace remote key retrieval. Native JWT verification, identity resolver,
// exact-root authority and durable SQL content audit are all real source code.
const keys = vi.hoisted(() => vi.fn());
vi.mock("jose", async () => ({ ...await vi.importActual<typeof import("jose")>("jose"), createRemoteJWKSet: keys }));
const origin = "https://ops.example.test", issuer = "https://joined.cloudflareaccess.com", audience = "joined-native-staff-audience";
const gatewayId = "11111111-1111-4111-8111-111111111111", sha = "a".repeat(64), fingerprint = "b".repeat(64);
const snapshotId = "44444444-4444-4444-8444-444444444444", base = "/api/staff/files", relative = "photos/synthetic-map.raw";

describe("joined employee read source acceptance with full migrated D1 and real native auth/audit", () => {
  let runtime: Miniflare, database: D1Database, pair: Awaited<ReturnType<typeof generateKeyPair>>;
  let sequence = 0, staffId: string, subject: string, email: string, rootId: string, grantId: string, token: string;
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: 'export default { fetch() { return new Response("synthetic"); } }', d1Databases: ["OPS_DB"] });
    database = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/u.test(name) && name.slice(0, 4) <= "0223").sort())
      await database.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => database.prepare(sql)));
    pair = await generateKeyPair("RS256", { extractable: true }); const publicKey = await exportJWK(pair.publicKey);
    publicKey.kid = "joined"; publicKey.alg = "RS256"; keys.mockReturnValue(createLocalJWKSet({ keys: [publicKey] }));
  }, 120_000);
  afterAll(async () => { await runtime?.dispose(); });
  beforeEach(async () => {
    const suffix = String(++sequence).padStart(12, "0"); staffId = `joined-employee-${sequence}`; subject = `access|${staffId}`; email = `${staffId}@example.invalid`;
    rootId = `22222222-2222-4222-8222-${suffix}`; grantId = `f0000000-0000-4000-8000-${suffix}`;
    await database.batch([
      database.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')").bind(staffId, email, "Synthetic employee", subject),
      database.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)").bind(staffId, subject, staffId),
      database.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)").bind(staffId, email, "Synthetic employee"),
      database.prepare("INSERT INTO ops_employee_read_roots(root_id,gateway_id,root_fingerprint,status,display_name) VALUES(?,?,?,'active','Synthetic server files')").bind(rootId, gatewayId, fingerprint),
    ]);
    await grant(grantId);
    token = await new SignJWT({ type: "app", email }).setProtectedHeader({ alg: "RS256", kid: "joined" }).setIssuer(issuer).setAudience(audience)
      .setSubject(subject).setIssuedAt(Math.floor(Date.now() / 1000) - 1).setExpirationTime("1h").sign(pair.privateKey);
  });
  async function grant(id: string) {
    await database.prepare(`INSERT INTO ops_employee_read_grants(grant_id,root_id,root_generation,root_fingerprint,staff_id,access_subject,admission_version,effect,expires_at)
      VALUES(?,?,1,?,?,?,1,'allow',?)`).bind(id, rootId, fingerprint, staffId, subject, Math.floor(Date.now() / 1000) + 3600).run();
  }
  function harness() {
    const cancel = vi.fn(); let revokeDuringContent = false;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const value = JSON.parse(String(init?.body));
      if (value.operation === "list") return Response.json({ schemaVersion: 1, entries: [{ name: "synthetic-map.raw", kind: "file" }], nextCursor: null });
      if (value.operation === "manifest") return Response.json({ schemaVersion: 1, sha256: sha, size: 3, etag: `"${sha}"`, snapshotId, snapshotExpiresAt: Math.floor(Date.now() / 1000) + 1800 });
      if (revokeDuringContent) await database.prepare("UPDATE ops_employee_read_grants SET active=0,grant_generation=grant_generation+1 WHERE grant_id=?").bind(grantId).run();
      const selected = value.range as { start: number; end: number } | null, size = selected ? selected.end - selected.start + 1 : 3;
      let sent = false;
      return new Response(new ReadableStream({ pull(c) { if (sent) c.close(); else { sent = true; c.enqueue(new Uint8Array(size).fill(7)); } }, cancel }, { highWaterMark: 0 }),
        { status: selected ? 206 : 200, headers: { "Content-Type": "application/octet-stream", "Content-Length": String(size), ETag: `"${sha}"`, ...(selected ? { "Content-Range": `bytes ${selected.start}-${selected.end}/3` } : {}) } });
    });
    const config = { enabled: true, opsOrigin: origin, access: { enabled: true, issuer, staffAudience: audience },
      gateway: { origin: "https://gateway.example.test", gatewayId, keyId: "joined", key: new Uint8Array(32).fill(1) }, handleKey: new Uint8Array(32).fill(2), queueKey: new Uint8Array(32).fill(3) };
    const router = createEmployeeReadRouter(config, { database, fetch: fetcher as typeof fetch });
    const queue = createEmployeeQueueRouter(config, { database, fetch: fetcher as typeof fetch });
    const queueCall = (path: string) => queue.fetch(new Request(origin + base + "/queue" + path, { headers: { "Cf-Access-Jwt-Assertion": token } }));
    const call = (path: string, headers: Record<string, string> = {}) => router.fetch(new Request(origin + path, { headers: { "Cf-Access-Jwt-Assertion": token, ...headers } }));
    const manifest = async () => {
      const response = await call(`${base}/roots/${rootId}/manifest?path=${encodeURIComponent(relative)}`); expect(response.status).toBe(200);
      return await response.json() as { downloadPath: string; strongETag: string };
    };
    return { call, queueCall, manifest, fetcher, cancel, revokeOnFetch: () => { revokeDuringContent = true; } };
  }
  it("durable reference renews snapshots and detects changed content without following a revoked/regranted grant", async () => {
    const h = harness();
    const session = await h.queueCall("/session"); expect(session.status).toBe(200);
    const identity = await session.json() as { principalId: string; expiresAt: number };
    expect(identity.principalId).toMatch(/^odqp1_[a-f0-9]{64}$/u);
    const minted = await h.queueCall("/reference?rootId=" + rootId + "&path=" + encodeURIComponent(relative)); expect(minted.status).toBe(200);
    const selected = await minted.json() as { principalId: string; resourceRef: string; manifest: Record<string, unknown> };
    expect(selected.principalId).toBe(identity.principalId); expect(selected.resourceRef).toMatch(/^odqr1_/u);
    expect(JSON.stringify(selected.resourceRef)).not.toContain(relative); expect(h.fetcher).not.toHaveBeenCalled();
    expect(Object.keys(selected)).toEqual(["schemaVersion", "principalId", "resourceRef"]);
    const resolve = () => h.queueCall("/resolve?resourceRef=" + selected.resourceRef);
    let response = await resolve(); expect(response.status).toBe(200);
    let renewed = await response.json() as typeof selected; selected.manifest = renewed.manifest;
    expect(h.fetcher).toHaveBeenCalledTimes(1);
    expect(renewed.manifest.logicalFileId).toBe(selected.manifest.logicalFileId);
    response = await resolve(); expect(response.status).toBe(200); renewed = await response.json() as typeof selected;
    expect(renewed.manifest.downloadPath).not.toBe(selected.manifest.downloadPath);
    // Profile edits do not change person/admission or resource identity.
    await database.prepare("UPDATE native_staff_profiles SET version=version+1 WHERE staff_id=?").bind(staffId).run();
    response = await resolve(); expect(response.status).toBe(200);
    expect((await response.json() as typeof selected).manifest.logicalFileId).toBe(selected.manifest.logicalFileId);
    const changedSha = "d".repeat(64);
    h.fetcher.mockImplementationOnce(async () => Response.json({ schemaVersion:1,sha256:changedSha,size:4,etag:`"${changedSha}"`,snapshotId,snapshotExpiresAt:Math.floor(Date.now()/1000)+1800 }));
    response = await resolve(); expect(response.status).toBe(200); renewed = await response.json() as typeof selected;
    expect(renewed.manifest.remoteVersion).toBe(changedSha); expect(renewed.manifest.logicalFileId).toBe(selected.manifest.logicalFileId);
    await grant(`10000000-0000-4000-8000-${String(sequence).padStart(12,"0")}`);
    await database.prepare("UPDATE ops_employee_read_grants SET active=0,grant_generation=grant_generation+1 WHERE grant_id=?").bind(grantId).run();
    expect((await resolve()).status).toBe(403);
    expect((await database.prepare("SELECT count(*) count FROM ops_employee_read_content_starts WHERE staff_id=?").bind(staffId).first<{count:number}>())?.count).toBe(0);
  });
  it("admission disable/re-enable changes principal and old reference cannot be resurrected", async () => {
    const h = harness(), selected = await (await h.queueCall("/reference?rootId="+rootId+"&path="+relative)).json() as {principalId:string;resourceRef:string};
    await database.prepare("UPDATE native_staff_admissions SET active=0,version=version+1 WHERE staff_id=?").bind(staffId).run();
    expect((await h.queueCall("/session")).status).toBe(401);
    await database.prepare("UPDATE native_staff_admissions SET active=1,version=version+1 WHERE staff_id=?").bind(staffId).run();
    const session = await h.queueCall("/session"); expect(session.status).toBe(200);
    expect((await session.json() as {principalId:string}).principalId).not.toBe(selected.principalId);
    expect((await h.queueCall("/resolve?resourceRef="+selected.resourceRef)).status).toBe(409);
  });
  it("queue refuses revocation during fresh preparation and root remaps without minting a byte handle", async () => {
    const h = harness(), selected = await (await h.queueCall("/reference?rootId="+rootId+"&path="+relative)).json() as {resourceRef:string};
    h.fetcher.mockImplementationOnce(async () => {
      await database.prepare("UPDATE ops_employee_read_grants SET active=0,grant_generation=grant_generation+1 WHERE grant_id=?").bind(grantId).run();
      return Response.json({schemaVersion:1,sha256:sha,size:3,etag:`"${sha}"`,snapshotId,snapshotExpiresAt:Math.floor(Date.now()/1000)+1800});
    });
    const response = await h.queueCall("/resolve?resourceRef="+selected.resourceRef); expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("eof1_");
    await grant(`10000000-0000-4000-8000-${String(sequence).padStart(12,"0")}`);
    await database.prepare("UPDATE ops_employee_read_roots SET root_generation=root_generation+1,root_fingerprint=? WHERE root_id=?").bind("e".repeat(64),rootId).run();
    h.fetcher.mockClear();expect((await h.queueCall("/resolve?resourceRef="+selected.resourceRef)).status).toBe(403);expect(h.fetcher).not.toHaveBeenCalled();
  });
  it("joins real admission, discovery, preparation, exact old grant selection, range content and durable audit", async () => {
    const h = harness(), roots = await h.call(base + "/roots"); expect(roots.status).toBe(200);
    expect(await roots.json()).toEqual({ schemaVersion: 1, roots: [{ rootId, gatewayId, displayName: "Synthetic server files" }] });
    const entries = await h.call(`${base}/roots/${rootId}/entries?path=photos`); expect(entries.status).toBe(200);
    expect(await entries.json()).toMatchObject({ entries: [{ name: "synthetic-map.raw", kind: "file" }], nextCursor: null });
    const body = await h.manifest();
    // A new lower-sorting parallel allow does not rescue a revoked grant and
    // must not invalidate this still-active exact grant's existing selector.
    await grant(`10000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`);
    const response = await h.call(body.downloadPath, { "If-Match": body.strongETag, Range: "bytes=1-" });
    expect(response.status).toBe(206); expect(response.headers.get("Content-Range")).toBe("bytes 1-2/3");
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([7, 7]);
    const audit = await database.prepare("SELECT * FROM ops_employee_read_content_starts WHERE staff_id=?").bind(staffId).all<Record<string, unknown>>();
    expect(audit.results).toHaveLength(1); expect(audit.results[0]).toMatchObject({ staff_id: staffId, access_subject: subject, grant_id: grantId,
      root_id: rootId, root_generation: 1, snapshot_id: snapshotId, sha256: sha, range_start: 1, range_end: 2,
      path_sha256: createHash("sha256").update(relative).digest("hex") });
    expect(JSON.stringify(audit.results)).not.toContain(relative);
    await database.prepare("UPDATE ops_employee_read_grants SET active=0,grant_generation=grant_generation+1 WHERE grant_id=?").bind(grantId).run();
    h.fetcher.mockClear();
    expect((await h.call(body.downloadPath, { "If-Match": body.strongETag })).status).toBe(403); expect(h.fetcher).not.toHaveBeenCalled();
  }, 60_000);
  it("rejects a real grant revocation during gateway fetch before audit or byte handoff", async () => {
    const h = harness(), body = await h.manifest(); h.revokeOnFetch();
    const response = await h.call(body.downloadPath, { "If-Match": body.strongETag });
    expect(response.status).toBe(403); expect(h.cancel).toHaveBeenCalledOnce();
    expect(await database.prepare("SELECT COUNT(*) n FROM ops_employee_read_content_starts WHERE staff_id=?").bind(staffId).first<number>("n")).toBe(0);
  }, 60_000);
});
