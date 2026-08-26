import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import type { Env } from "../src/worker/types";
import { getPortalSourceAuthority, portalSourceAuthorityFence, provisionPortalSourceAuthority,
  readPortalSourceAuthorityProof, resolvePortalSourceAuthority, setPortalSourceAuthorityState,
  type PortalAuthorityConnectorIdentity, type PortalAuthorityRevisionInput } from "../src/worker/project-alpha-portal-authority";
import { handleRegisteredProjectAlphaPortalRequest, portalSourceProjectionPath, verifyRegisteredPortalAccess } from "../src/worker/project-alpha-portal-ingress";
import { handleProjectAlphaPortalProjectionRequest } from "../src/worker/project-alpha-portal";

const legacySecret = "primary-portal-secret-which-is-at-least-32-bytes";
const issuer = "https://portal-test.cloudflareaccess.com";
const audience = "portal-authority-audience", subject = "explicit-producer-subject";
const applicationKey = "field_operations_portal";
const revision: PortalAuthorityRevisionInput = { credentialRef: "selected", accessIssuer: issuer, accessAudience: audience, accessSubject: subject };
const bytes = (value: string) => new TextEncoder().encode(value);
async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(value)))].map(n => n.toString(16).padStart(2, "0")).join("");
}
function firstBatch(db: D1Database, action: () => Promise<void>): D1Database {
  let done = false, proxy: D1Database;
  proxy = new Proxy(db, { get(target, key) {
    if (key === "withSession") return () => proxy;
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      if (!done) { done = true; await action(); }
      return target.batch(statements);
    };
    const value = target[key as keyof D1Database];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return proxy;
}
describe("registered secondary portal authority and authenticated projection", { timeout: 30_000 }, () => {
  let runtime: Miniflare, db: D1Database, keypair: Awaited<ReturnType<typeof generateKeyPair>>;
  let counter = 0;
  let retainedAccount: unknown, retainedIdentity: unknown;
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-07-22", modules: true,
      script: "export default {fetch(){return new Response('portal-authority')}}", d1Databases: { DELIVERY_DB: "portal-authority" } });
    db = await runtime.getD1Database("DELIVERY_DB") as D1Database;
    const names = readdirSync(new URL("../migrations/", import.meta.url)).filter(name => name.endsWith(".sql") && name < "0162_").sort();
    for (const name of names) await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8")).map(sql => db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO client_accounts(id,display_name,status) VALUES('preserved-local','Original É  owner','active')"),
      db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES('preserved-person',?,'global-person','person@example.test','active')").bind(issuer),
    ]);
    retainedAccount = await db.prepare("SELECT * FROM client_accounts WHERE id='preserved-local'").first();
    retainedIdentity = await db.prepare("SELECT * FROM portal_v2_identities WHERE id='preserved-person'").first();
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0162_portal_source_authorities.sql", import.meta.url), "utf8")).map(sql => db.prepare(sql)));
    keypair = await generateKeyPair("RS256");
  }, 90_000);
  afterAll(async () => runtime.dispose());

  function candidate() {
    const suffix = `test-${++counter}`;
    const connector: PortalAuthorityConnectorIdentity = { sourceId: `project-alpha:${suffix}`, producerBindingId: suffix,
      snapshotOrigin: `https://${suffix}.example.test`, snapshotBasePath: "/alpha", applicationKey,
      profile: "business_data", revision: 1, version: 2, state: "active" };
    const secret = `secret-for-${suffix}-`.repeat(4), keyId = `${suffix}-key`;
    const env = { DELIVERY_DB: db, PROJECT_ALPHA_PORTAL_SYNC_ENABLED: "true", PROJECT_ALPHA_PORTAL_HMAC_SECRET: legacySecret,
      PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets: { selected: { portalCurrent: { keyId, value: secret } } } }) } as Env;
    return { connector, secret, keyId, env };
  }
  type Fixture = ReturnType<typeof candidate>;
  async function configure(fixture: Fixture, activate = true) {
    const pending = await provisionPortalSourceAuthority(fixture.env, fixture.connector, revision, null, "admin");
    return activate ? setPortalSourceAuthorityState(fixture.env, fixture.connector, pending.version, "active", "admin") : pending;
  }
  function page(id = "page-one", workspaceId = "same-external-workspace") {
    return { schemaVersion: 2, applicationKey, kind: "snapshot.page", deliveryId: id, workspaceId,
      occurredAt: "2026-08-26T12:00:00.000Z", sourceGeneration: "same-generation", sourceSequence: 1,
      snapshotHash: "a".repeat(64), pageCount: 1, recordCount: 4, pageNumber: 1,
      workspace: { publicId: workspaceId, rootType: "organization", rootPublicId: "same-organization", displayName: "Same customer", sourceVersion: "root-v1", active: true },
      entities: [{ type: "organization", publicId: "same-organization", parentPublicId: null, displayName: "Same customer", sourceVersion: "root-v1", active: true, primaryContact: false }],
      principals: [{ publicId: "same-principal", emailHint: "person@example.test", displayName: "Existing person", sourceVersion: "person-v1", active: true }],
      entitlements: ["workspace.view", "directory.read"].map((capability, index) => ({ publicId: `intent-${index}`, principalPublicId: "same-principal",
        capability, effect: "allow", scopeType: "workspace", scopePublicId: workspaceId, sourceVersion: "intent-v1", active: true, validFrom: "2026-08-25T00:00:00.000Z", expiresAt: null })) };
  }
  function activation(id = "activate-one", workspaceId = "same-external-workspace") {
    return { schemaVersion: 2, applicationKey, kind: "snapshot.activate", deliveryId: id, workspaceId,
      occurredAt: "2026-08-26T12:00:00.000Z", sourceGeneration: "same-generation", sourceSequence: 1,
      snapshotHash: "a".repeat(64), pageCount: 1, recordCount: 4 };
  }
  async function request(f: Fixture, payload: { deliveryId: string }, options: { sourceId?: string; secret?: string; keyId?: string; tokenSubject?: string; tokenAudience?: string; tokenIssuer?: string; signedPath?: string } = {}) {
    const source = options.sourceId ?? f.connector.sourceId, body = JSON.stringify(payload), timestamp = new Date().toISOString(), signingId = options.keyId ?? f.keyId;
    const path = portalSourceProjectionPath(source), signedPath = options.signedPath ?? path;
    const key = await crypto.subtle.importKey("raw", bytes(options.secret ?? f.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = await crypto.subtle.sign("HMAC", key, bytes(`${timestamp}\nPOST\n${signedPath}\n${signingId}\n${payload.deliveryId}\n${body}`));
    const signature = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, "0")).join("");
    const token = await new SignJWT({}).setProtectedHeader({ alg: "RS256" }).setIssuer(options.tokenIssuer ?? issuer)
      .setAudience(options.tokenAudience ?? audience).setSubject(options.tokenSubject ?? subject).setIssuedAt().setExpirationTime("5m").sign(keypair.privateKey);
    return new Request(`https://portal.example.test${path}`, { method: "POST", body, headers: {
      "Content-Type": "application/json", "Cf-Access-Jwt-Assertion": token, "X-Portal-Integration-Timestamp": timestamp,
      "X-Portal-Integration-Application-Key": applicationKey, "X-Portal-Integration-Body-SHA256": await hash(body),
      "X-Portal-Integration-Key-Id": signingId, "X-Portal-Integration-Delivery-Id": payload.deliveryId,
      "X-Portal-Integration-Signature": `sha256=${signature}` } });
  }
  async function receive(f: Fixture, payload = page(), options: Parameters<typeof request>[2] = {}) {
    return handleRegisteredProjectAlphaPortalRequest(await request(f, payload, options), f.env, options.sourceId ?? f.connector.sourceId,
      (req, authority) => verifyRegisteredPortalAccess(req, authority, async () => keypair.publicKey));
  }
  async function activate(f: Fixture) {
    return handleRegisteredProjectAlphaPortalRequest(await request(f, activation()), f.env, f.connector.sourceId,
      (req, authority) => verifyRegisteredPortalAccess(req, authority, async () => keypair.publicKey));
  }

  it("adds no authority and preserves populated identities/local account bytes", async () => {
    expect(await db.prepare("SELECT * FROM client_accounts WHERE id='preserved-local'").first()).toEqual(retainedAccount);
    expect(await db.prepare("SELECT * FROM portal_v2_identities WHERE id='preserved-person'").first()).toEqual(retainedIdentity);
    expect((await db.prepare("SELECT count(*) n FROM pa_portal_source_authorities").first<number>("n"))).toBe(0);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect(await db.prepare("PRAGMA quick_check('pa_portal_source_authorities')").first("quick_check")).toBe("ok");
  });
  it("business configuration alone and a prepared pending purpose cannot ingest", async () => {
    const f = candidate();
    expect((await receive(f)).status).toBe(404);
    const pending = await configure(f, false);
    expect(pending.state).toBe("pending");
    expect((await receive(f)).status).toBe(404);
    expect(await readPortalSourceAuthorityProof(db, f.connector.sourceId)).toBeNull();
    expect(await db.prepare("SELECT count(*) n FROM pa_portal_workspace_sources WHERE projection_source_id=?").bind(f.connector.sourceId).first("n")).toBe(0);
  });
  it("projects two real authenticated same-ID producers independently and replays once", async () => {
    const a = candidate(), b = candidate(); await configure(a); await configure(b);
    for (const f of [a, b]) {
      expect((await receive(f)).status).toBe(200);
      expect((await activate(f)).status).toBe(200);
      expect(await (await receive(f)).json()).toMatchObject({ status: "duplicate" });
    }
    const rows = (await db.prepare(`SELECT workspace.id,workspace.project_alpha_source_id,workspace.legacy_account_id
      FROM portal_v2_workspaces workspace WHERE project_alpha_source_id IN (?,?)`).bind(a.connector.sourceId, b.connector.sourceId).all<{ id: string; legacy_account_id: string | null }>()).results;
    expect(rows).toHaveLength(2); expect(rows[0]!.id).not.toBe(rows[1]!.id);
    expect(rows.every(row => row.legacy_account_id === null)).toBe(true);
    expect(await db.prepare("SELECT count(*) n FROM pa_portal_entitlement_intents WHERE workspace_id IN (?,?)").bind(rows[0]!.id, rows[1]!.id).first("n")).toBe(4);
    expect(await db.prepare("SELECT count(*) n FROM client_accounts").first("n")).toBe(1);
  });
  it.each(["subject", "audience", "issuer", "signature", "path"])("rejects wrong %s with no workspace reservation", async fault => {
    const f = candidate(); await configure(f);
    const options = fault === "subject" ? { tokenSubject: "other" } : fault === "audience" ? { tokenAudience: "other" }
      : fault === "issuer" ? { tokenIssuer: "https://other.example.test" } : fault === "signature" ? { secret: "wrong" }
      : { signedPath: "/api/internal/project-alpha/portal-v2" };
    expect((await receive(f, page(), options)).status).toBe(401);
    expect(await db.prepare("SELECT count(*) n FROM pa_portal_workspace_sources WHERE projection_source_id=?").bind(f.connector.sourceId).first("n")).toBe(0);
  });
  it("does not authenticate a different source with the same application ID or copied URL", async () => {
    const a = candidate(), b = candidate(); await configure(a); await configure(b);
    // The target server has B's deployed credentials. The request is still
    // signed by A; using A's isolated fixture env would instead exercise a
    // missing/mismatched deployment credential (503), not authentication.
    expect((await receive({ ...a, env: b.env }, page(), { sourceId: b.connector.sourceId })).status).toBe(401);
    expect((await receive(a, page(), { sourceId: "project-alpha:primary" })).status).toBe(400);
  });
  it("suspension fences the very first map reservation atomically", async () => {
    const f = candidate(), active = await configure(f);
    const wrapped = { ...f, env: { ...f.env, DELIVERY_DB: firstBatch(db, async () => {
      await setPortalSourceAuthorityState(f.env, f.connector, active.version, "suspended", "admin");
    }) } };
    expect((await receive(wrapped)).status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM pa_portal_workspace_sources WHERE projection_source_id=?").bind(f.connector.sourceId).first("n")).toBe(0);
  });
  it("suspension during activation rolls back workspace/receipt/intents while retaining staged pages", async () => {
    const f = candidate(), active = await configure(f); expect((await receive(f)).status).toBe(200);
    const wrapped = { ...f, env: { ...f.env, DELIVERY_DB: firstBatch(db, async () => {
      await setPortalSourceAuthorityState(f.env, f.connector, active.version, "suspended", "admin");
    }) } };
    expect((await activate(wrapped)).status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM portal_v2_workspaces WHERE project_alpha_source_id=?").bind(f.connector.sourceId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM pa_portal_projection_receipts WHERE projection_source_id=?").bind(f.connector.sourceId).first("n")).toBe(1);
    expect((await receive(f)).status).toBe(404);
  });
  it("CAS races cannot create two configuration revisions or audit versions", async () => {
    const f = candidate(); await configure(f, false);
    const results = await Promise.allSettled([1, 2].map(() => provisionPortalSourceAuthority(f.env, f.connector, revision, 1, "admin")));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.prepare("SELECT count(*) n FROM pa_portal_source_authority_revisions WHERE source_id=?").bind(f.connector.sourceId).first("n")).toBe(2);
    expect(await db.prepare("SELECT count(*) n FROM pa_portal_source_authority_audit WHERE source_id=?").bind(f.connector.sourceId).first("n")).toBe(2);
  });
  it("rotation requires explicit revision, preserves previous keys, and invalidates stale write proofs", async () => {
    const f = candidate(), active = await configure(f), oldProof = await readPortalSourceAuthorityProof(db, f.connector.sourceId);
    const rotated = { ...f, secret: `${f.secret}-rotated`, keyId: `${f.keyId}-v2` };
    rotated.env = { ...f.env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets: { selected: {
      portalCurrent: { keyId: rotated.keyId, value: rotated.secret }, portalPrevious: { keyId: f.keyId, value: f.secret } } } }) };
    await expect(resolvePortalSourceAuthority(rotated.env, f.connector.sourceId)).rejects.toMatchObject({ code: "credentials_unavailable" });
    const pending = await provisionPortalSourceAuthority(rotated.env, f.connector, revision, active.version, "admin");
    await setPortalSourceAuthorityState(rotated.env, f.connector, pending.version, "active", "admin");
    await expect(db.batch([portalSourceAuthorityFence(db, oldProof!), db.prepare("INSERT INTO client_accounts(id,display_name) VALUES('should-rollback','No')")])).rejects.toThrow();
    expect(await db.prepare("SELECT id FROM client_accounts WHERE id='should-rollback'").first()).toBeNull();
    expect((await receive(rotated, page(), { keyId: f.keyId, secret: f.secret })).status).toBe(200);
  });
  it("retired and historical signing keys can never move to another producer or primary scalar key", async () => {
    const f = candidate(), active = await configure(f);
    await setPortalSourceAuthorityState(f.env, f.connector, active.version, "retired", "admin");
    const other = candidate(); other.env = { ...other.env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: f.env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS };
    await expect(configure(other)).rejects.toMatchObject({ code: "conflict" });
    other.env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS = JSON.stringify({ version: 1, sets: { selected: { portalCurrent: { keyId: "primary", value: legacySecret } } } });
    await expect(configure(other)).rejects.toMatchObject({ code: "conflict" });
    await expect(setPortalSourceAuthorityState(f.env, f.connector, active.version + 1, "active", "admin")).rejects.toMatchObject({ code: "conflict" });
  });
  it("valid selected credentials ignore malformed unrelated sets; selected malformed keys fail closed", async () => {
    const f = candidate(); const parsed = JSON.parse(f.env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS!);
    parsed.sets.other = "malformed unrelated purpose"; f.env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS = JSON.stringify(parsed);
    await configure(f);
    parsed.sets.selected.portalCurrent.value = 1; f.env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS = JSON.stringify(parsed);
    expect((await receive(f)).status).toBe(503);
  });
  it("requires reconfiguration after the business credential revision changes", async () => {
    const f = candidate(), active = await configure(f);
    const next = { ...f.connector, revision: 2, version: 3 };
    const suspended = await setPortalSourceAuthorityState(f.env, next, active.version, "suspended", "admin");
    expect(suspended.connectorRevision).toBe(1);
    await expect(setPortalSourceAuthorityState(f.env, next, suspended.version, "active", "admin")).rejects.toMatchObject({ code: "conflict" });
    const configured = await provisionPortalSourceAuthority(f.env, next, revision, suspended.version, "admin");
    expect((await setPortalSourceAuthorityState(f.env, next, configured.version, "active", "admin")).connectorRevision).toBe(2);
  });
  it("immutable identities/revisions survive REPLACE and malformed sources are rejected", async () => {
    const f = candidate(); await configure(f);
    await expect(db.prepare("UPDATE pa_portal_source_authorities SET snapshot_origin='https://other.example.test',version=version+1 WHERE source_id=?").bind(f.connector.sourceId).run()).rejects.toThrow();
    await expect(db.prepare("INSERT OR REPLACE INTO pa_portal_source_authorities SELECT * FROM pa_portal_source_authorities WHERE source_id=?").bind(f.connector.sourceId).run()).rejects.toThrow();
    await expect(db.prepare("DELETE FROM pa_portal_source_authority_revisions WHERE source_id=?").bind(f.connector.sourceId).run()).rejects.toThrow();
    await expect(provisionPortalSourceAuthority(f.env, { ...f.connector, sourceId: "project-alpha:bad\0suffix" }, revision, null, "admin")).rejects.toMatchObject({ code: "invalid" });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await getPortalSourceAuthority(db, f.connector.sourceId))?.version).toBe(2);
  });
  it("preserves the existing primary protocol without a primary authority entry", async () => {
    const f = candidate(); f.secret = legacySecret; f.keyId = "legacy-primary";
    f.env = { ...f.env, PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey, PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: f.keyId,
      PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: issuer, PROJECT_ALPHA_PORTAL_ACCESS_AUD: audience };
    const req = await request(f, page("legacy-page", "legacy-primary-workspace"), { signedPath: "/api/internal/project-alpha/portal-v2" });
    const response = await handleProjectAlphaPortalProjectionRequest(req, f.env, async () => undefined);
    expect(response.status).toBe(200);
    expect(await getPortalSourceAuthority(db, "project-alpha:primary")).toBeNull();
    expect(await db.prepare("SELECT workspace_id FROM pa_portal_workspace_sources WHERE projection_source_id='project-alpha:primary'").first("workspace_id")).toBe("legacy-primary-workspace");
  });
  it("rejects forged primary scalar rotation onto an enrolled secondary key before projection", async () => {
    const f = candidate(); await configure(f);
    const primaryEnv = { ...f.env, PROJECT_ALPHA_PORTAL_APPLICATION_KEY: applicationKey,
      PROJECT_ALPHA_PORTAL_HMAC_KEY_ID: f.keyId, PROJECT_ALPHA_PORTAL_HMAC_SECRET: f.secret,
      PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN: issuer, PROJECT_ALPHA_PORTAL_ACCESS_AUD: audience };
    const payload = page("forged-primary-rotation", "must-not-reserve-primary");
    const req = await request(f, payload, { signedPath: "/api/internal/project-alpha/portal-v2" });
    const response = await handleProjectAlphaPortalProjectionRequest(req, primaryEnv, async () => undefined);
    expect(response.status).toBe(409);
    expect(await db.prepare("SELECT workspace_id FROM pa_portal_workspace_sources WHERE workspace_id='must-not-reserve-primary'").first()).toBeNull();
    expect(await db.prepare("SELECT count(*) n FROM pa_portal_projection_receipts WHERE delivery_id=?").bind(payload.deliveryId).first("n")).toBe(0);
  });
});
