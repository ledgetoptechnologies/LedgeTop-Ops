import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import * as authority from "../../client/src/worker/project-alpha-portal-authority";
import * as connectors from "../src/worker/project-alpha-connectors";
import {
  configureConnectorPortal, changeConnectorPortal, getConnectorPortalStatus, recoverConnectorPortalCoordination,
  reviseCoordinatedProjectAlphaConnector, setCoordinatedProjectAlphaConnectorState, type ConnectorPortalEnvironment,
} from "../src/worker/project-alpha-portal-coordination";

const PRIMARY = "project-alpha:primary", actor = "portal-coordination-admin";
const publicKey = (seed: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(seed)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const credential = (seed: number) => ({ snapshotApiKey: `snapshot-key-${seed}`,
  eventCurrent: { keyId: `event-${seed}`, algorithm: "ed25519", value: publicKey(seed) },
  portalCurrent: { keyId: `portal-${seed}`, value: `portal-signing-secret-${seed}-at-least-thirty-two-characters` } });
const revision = (ref: string) => ({ credentialRef: ref, snapshotBasePath: "/", accessIssuer: "https://access.example.test",
  accessAudience: "shared-producer-audience", accessSubject: "verified-producer-subject" });
let runtime: Miniflare, db: D1Database, delivery: D1Database, env: ConnectorPortalEnvironment, sequence = 1;
const primaryCredential = credential(1);
const credentials: Record<string, ReturnType<typeof credential>> = { primary: primaryCredential };
function setCredentials() { env.PROJECT_ALPHA_CONNECTOR_CREDENTIALS = JSON.stringify({ version: 1, sets: credentials }); }
async function connector(id: string) { return (await connectors.listProjectAlphaConnectors(env)).find(row => row.sourceId === id)!; }
async function configured() {
  const id = `project-alpha:portal-${++sequence}`, ref = `source-${sequence}`;
  credentials[ref] = credential(sequence); setCredentials();
  let current = await connectors.registerProjectAlphaConnector(env, { sourceId: id, producerBindingId: `producer-${sequence}`,
    snapshotOrigin: `https://producer-${sequence}.example.test`, applicationKey: "ltds_ops", profile: "business_data",
    displayName: `Portal source ${sequence}`, revision: revision(ref) }, actor);
  current = await setCoordinatedProjectAlphaConnectorState(env, id, { expectedVersion: current.version, state: "active" }, actor);
  const staged = await configureConnectorPortal(env, id, current.version, null, actor);
  return { id, ref, connector: current, authority: staged };
}
async function active() {
  const fixture = await configured();
  const enabled = await changeConnectorPortal(env, fixture.id, fixture.connector.version, fixture.authority.version, "active", actor);
  return { ...fixture, authority: enabled };
}
async function recover() {
  const pending = (await getConnectorPortalStatus(env)).recovery;
  if (pending) await recoverConnectorPortalCoordination(env, pending.version, actor);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

// These are migrated, two-database integration fixtures, not five-second unit
// tests. A timed-out case otherwise keeps running against the next case's data.
describe("coordinated client-portal purposes on existing Alpha connections", { timeout: 60_000, concurrent: false }, () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
      script: "export default {fetch(){return new Response('fixture')}}", d1Databases: ["OPS_DB", "DELIVERY_DB", "PARTIAL_DELIVERY", "EMPTY_DELIVERY"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    delivery = await runtime.getD1Database("DELIVERY_DB") as D1Database;
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter(name => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) <= "0039").sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, migrations), "utf8")).map(sql => db.prepare(sql)));
    await delivery.batch(splitD1MigrationStatements(readFileSync(new URL("../../client/migrations/0162_portal_source_authorities.sql", import.meta.url), "utf8"))
      .map(sql => delivery.prepare(sql)));
    await delivery.batch(splitD1MigrationStatements(readFileSync(new URL("../../client/migrations/0203_primary_delivery_authority.sql", import.meta.url), "utf8"))
      .map(sql => delivery.prepare(sql)));
    env = { OPS_DB: db, DELIVERY_DB: delivery, PROJECT_ALPHA_BASE_URL: "https://primary.example.test/",
      PROJECT_ALPHA_API_KEY: primaryCredential.snapshotApiKey, APPLICATION_KEY: "ltds_ops",
      PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: publicKey(1), PROJECT_ALPHA_PORTAL_HMAC_SECRET: "scalar-primary-portal-secret-thirty-two-characters" };
    setCredentials();
    await connectors.registerProjectAlphaConnector(env, { sourceId: PRIMARY, producerBindingId: "primary-producer",
      snapshotOrigin: "https://primary.example.test", applicationKey: "ltds_ops", profile: "primary_legacy", displayName: "Primary",
      revision: revision("primary") }, actor);
    await setCoordinatedProjectAlphaConnectorState(env, PRIMARY, { expectedVersion: 1, state: "active" }, actor);
  }, 90_000);
  beforeEach(async () => {
    vi.restoreAllMocks();
    await recover();
    const primary = await connector(PRIMARY);
    if (primary.state !== "active") await setCoordinatedProjectAlphaConnectorState(env, PRIMARY, { expectedVersion: primary.version, state: "active" }, actor);
  }, 90_000);
  afterAll(async () => { vi.restoreAllMocks(); await runtime?.dispose(); }, 90_000);

  it("stages the same connection's authentication without enabling access or exposing keys", async () => {
    const fixture = await configured();
    expect(fixture.authority.state).toBe("pending");
    const stored = await delivery.prepare("SELECT credential_ref,access_issuer,access_audience,access_subject FROM pa_portal_source_authority_revisions WHERE source_id=?")
      .bind(fixture.id).first();
    expect(stored).toEqual({ credential_ref: fixture.ref, access_issuer: revision(fixture.ref).accessIssuer,
      access_audience: revision(fixture.ref).accessAudience, access_subject: revision(fixture.ref).accessSubject });
    const status = await getConnectorPortalStatus(env);
    expect(status.available).toBe(true); expect(status.recovery).toBeNull();
    expect(JSON.stringify(status)).not.toContain("signing-secret"); expect(JSON.stringify(status)).not.toContain("credential_ref");
    expect((await authority.readPortalSourceAuthorityProof(delivery, fixture.id))).toBeNull();
    expect(await db.prepare("SELECT count(*) n FROM pa_connector_portal_sources WHERE source_id=?").bind(fixture.id).first("n")).toBe(1);
  });

  it("rejects returning an active primary to pending without mutating its mirror or coordination state", async () => {
    const current = await connector(PRIMARY);
    const mirrorBefore = await delivery.prepare(`SELECT mode,connector_revision connectorRevision,connector_version connectorVersion,state
      FROM pa_primary_delivery_authority WHERE source_id=?`).bind(PRIMARY).first();
    const statusBefore = await getConnectorPortalStatus(env);
    const auditBefore = await db.prepare("SELECT count(*) n FROM pa_connector_portal_coordination_audit").first<number>("n");

    await expect(setCoordinatedProjectAlphaConnectorState(env, PRIMARY,
      { expectedVersion: current.version, state: "pending" }, actor)).rejects.toMatchObject({ code: "conflict" });

    expect(await connector(PRIMARY)).toEqual(current);
    expect(await delivery.prepare(`SELECT mode,connector_revision connectorRevision,connector_version connectorVersion,state
      FROM pa_primary_delivery_authority WHERE source_id=?`).bind(PRIMARY).first()).toEqual(mirrorBefore);
    expect(await getConnectorPortalStatus(env)).toEqual(statusBefore);
    expect(await db.prepare("SELECT count(*) n FROM pa_connector_portal_coordination_audit").first<number>("n")).toBe(auditBefore);
  });

  it("pauses delivery before source suspension and never automatically resumes it", async () => {
    const fixture = await active();
    const suspended = await setCoordinatedProjectAlphaConnectorState(env, fixture.id,
      { expectedVersion: fixture.connector.version, state: "suspended" }, actor);
    expect((await authority.getPortalSourceAuthority(delivery, fixture.id))?.state).toBe("suspended");
    await setCoordinatedProjectAlphaConnectorState(env, fixture.id, { expectedVersion: suspended.version, state: "active" }, actor);
    expect((await authority.getPortalSourceAuthority(delivery, fixture.id))?.state).toBe("suspended");
    expect(await db.prepare("SELECT count(*) n FROM pa_connector_portal_write_permits").first("n")).toBe(0);
  });

  it("keeps source labels and staff visibility independent from client permission", async () => {
    const fixture = await active();
    await setCoordinatedProjectAlphaConnectorState(env, fixture.id,
      { expectedVersion: fixture.connector.version, state: "active", displayName: "New label", readVisible: true }, actor);
    expect(await authority.getPortalSourceAuthority(delivery, fixture.id)).toEqual(fixture.authority);
  });

  it("pauses every secondary purpose before primary suspension", async () => {
    await active(); await active();
    const primary = await connector(PRIMARY);
    await setCoordinatedProjectAlphaConnectorState(env, PRIMARY, { expectedVersion: primary.version, state: "suspended" }, actor);
    expect((await getConnectorPortalStatus(env)).authorities.every(row => row.state !== "active")).toBe(true);
    const current=await connector(PRIMARY);
    expect(current.state).toBe("suspended");
    expect(await delivery.prepare(`SELECT mode,connector_revision connectorRevision,connector_version connectorVersion,state
      FROM pa_primary_delivery_authority WHERE source_id=?`).bind(PRIMARY).first()).toEqual({
        mode:"registry",connectorRevision:current.activeRevision,connectorVersion:current.version,state:"suspended",
      });
  });

  it("recovers the primary Delivery mirror after an uncertain OPS transition",async()=>{
    const primary=await connector(PRIMARY);
    vi.spyOn(connectors,"setProjectAlphaConnectorState").mockRejectedValueOnce(new Error("simulated primary Ops failure"));
    await expect(setCoordinatedProjectAlphaConnectorState(env,PRIMARY,
      {expectedVersion:primary.version,state:"suspended"},actor)).rejects.toThrow("simulated primary Ops failure");
    expect(await delivery.prepare("SELECT connector_version version,state FROM pa_primary_delivery_authority WHERE source_id=?")
      .bind(PRIMARY).first()).toEqual({version:primary.version+1,state:"suspended"});
    const pending=(await getConnectorPortalStatus(env)).recovery;
    await recoverConnectorPortalCoordination(env,pending!.version,actor);
    expect(await connector(PRIMARY)).toEqual(primary);
    expect(await delivery.prepare("SELECT connector_revision revision,connector_version version,state FROM pa_primary_delivery_authority WHERE source_id=?")
      .bind(PRIMARY).first()).toEqual({revision:primary.activeRevision,version:primary.version,state:"active"});
  });

  it("requires renewed portal configuration after a connection credential revision", async () => {
    const fixture = await active(), ref = `rotated-${++sequence}`;
    credentials[ref] = credential(sequence); setCredentials();
    const revised = await reviseCoordinatedProjectAlphaConnector(env, fixture.id, fixture.connector.version, revision(ref), actor);
    const paused = await authority.getPortalSourceAuthority(delivery, fixture.id);
    expect(paused?.state).toBe("suspended");
    await expect(changeConnectorPortal(env, fixture.id, revised.version, paused!.version, "active", actor)).rejects.toBeDefined();
    await recover();
    const current = await authority.getPortalSourceAuthority(delivery, fixture.id);
    const refreshed = await configureConnectorPortal(env, fixture.id, revised.version, current!.version, actor);
    expect((await changeConnectorPortal(env, fixture.id, revised.version, refreshed.version, "active", actor)).state).toBe("active");
  });

  it("blocks older/uncoordinated source writes after enrollment, including primary suspension", async () => {
    const fixture = await active();
    await expect(connectors.setProjectAlphaConnectorState(env, fixture.id,
      { expectedVersion: fixture.connector.version, state: "suspended" }, actor)).rejects.toBeDefined();
    const primary = await connector(PRIMARY);
    await expect(connectors.setProjectAlphaConnectorState(env, PRIMARY,
      { expectedVersion: primary.version, state: "suspended" }, actor)).rejects.toBeDefined();
    expect((await connector(fixture.id)).state).toBe("active");
    expect((await authority.getPortalSourceAuthority(delivery, fixture.id))?.state).toBe("active");
  });

  it("does not change the source when Delivery suspension fails; recovery is explicit", async () => {
    const fixture = await active();
    vi.spyOn(authority, "setPortalSourceAuthorityState").mockRejectedValueOnce(new Error("simulated Delivery failure"));
    await expect(setCoordinatedProjectAlphaConnectorState(env, fixture.id,
      { expectedVersion: fixture.connector.version, state: "suspended" }, actor)).rejects.toThrow("simulated Delivery failure");
    expect((await connector(fixture.id)).state).toBe("active");
    const pending = (await getConnectorPortalStatus(env)).recovery;
    expect(pending?.action).toBe("state");
    await recoverConnectorPortalCoordination(env, pending!.version, actor);
    expect((await getConnectorPortalStatus(env)).recovery).toBeNull();
    expect((await authority.getPortalSourceAuthority(delivery, fixture.id))?.state).toBe("suspended");
    expect((await connector(fixture.id)).state).toBe("active");
  });

  it("leaves the portal paused after an uncertain OPS write and rejects a concurrent update", async () => {
    const fixture = await active();
    vi.spyOn(connectors, "setProjectAlphaConnectorState").mockRejectedValueOnce(new Error("simulated Ops write failure"));
    await expect(setCoordinatedProjectAlphaConnectorState(env, fixture.id,
      { expectedVersion: fixture.connector.version, state: "suspended" }, actor)).rejects.toThrow("simulated Ops write failure");
    expect((await authority.getPortalSourceAuthority(delivery, fixture.id))?.state).toBe("suspended");
    await expect(changeConnectorPortal(env, fixture.id, fixture.connector.version,
      (await authority.getPortalSourceAuthority(delivery, fixture.id))!.version, "active", actor)).rejects.toMatchObject({ code: "changed" });
    await recover();
    expect((await getConnectorPortalStatus(env)).recovery).toBeNull();
  });

  it("a delayed activation cannot revive a portal after recovery", async () => {
    const fixture = await configured(), entered = deferred(), release = deferred();
    const original = authority.setPortalSourceAuthorityState;
    vi.spyOn(authority, "setPortalSourceAuthorityState").mockImplementation(async (...args) => {
      if (args[3] === "active") { entered.resolve(); await release.promise; }
      return original(...args);
    });
    const pending = changeConnectorPortal(env, fixture.id, fixture.connector.version, fixture.authority.version, "active", actor)
      .then(() => "unexpected success", () => "rejected");
    await entered.promise;
    const status = await getConnectorPortalStatus(env);
    await recoverConnectorPortalCoordination(env, status.recovery!.version, actor);
    release.resolve(); expect(await pending).toBe("rejected");
    expect((await authority.getPortalSourceAuthority(delivery, fixture.id))?.state).toBe("suspended");
    expect((await getConnectorPortalStatus(env)).recovery).toBeNull();
  });

  it("rejects stale connection versions before starting an administration attempt", async () => {
    const fixture = await configured(), before = await getConnectorPortalStatus(env);
    await expect(changeConnectorPortal(env, fixture.id, fixture.connector.version - 1, fixture.authority.version, "active", actor))
      .rejects.toMatchObject({ code: "changed" });
    expect(await getConnectorPortalStatus(env)).toEqual(before);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    expect((await delivery.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("never downgrades enrolled source mutations when the Delivery binding is missing", async () => {
    const fixture = await active(), withoutDelivery = { ...env };
    Reflect.deleteProperty(withoutDelivery, "DELIVERY_DB");
    await expect(setCoordinatedProjectAlphaConnectorState(withoutDelivery, fixture.id,
      { expectedVersion: fixture.connector.version, state: "suspended" }, actor)).rejects.toMatchObject({ code: "unavailable" });
    await expect(reviseCoordinatedProjectAlphaConnector(withoutDelivery, fixture.id,
      fixture.connector.version, revision(fixture.ref), actor)).rejects.toMatchObject({ code: "unavailable" });
    expect(await connector(fixture.id)).toEqual(fixture.connector);
    expect(await authority.getPortalSourceAuthority(delivery, fixture.id)).toEqual(fixture.authority);
    expect((await getConnectorPortalStatus(env)).recovery).toBeNull();
  });

  it("rejects stale portal revisions before creating an unfinished update", async () => {
    const fixture = await configured(), before = await getConnectorPortalStatus(env);
    await expect(changeConnectorPortal(env, fixture.id, fixture.connector.version, fixture.authority.version + 1, "active", actor))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(configureConnectorPortal(env, fixture.id, fixture.connector.version, null, actor))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await getConnectorPortalStatus(env)).toEqual(before);
  });

  it("does not fall back through an absent or partial paired Delivery schema after enrollment", async () => {
    const fixture = await active();
    const partial = await runtime.getD1Database("PARTIAL_DELIVERY") as D1Database;
    await partial.prepare("CREATE TABLE pa_portal_source_authorities(source_id TEXT PRIMARY KEY)").run();
    for (const database of [partial, await runtime.getD1Database("EMPTY_DELIVERY") as D1Database]) {
      const changed = { ...env, DELIVERY_DB: database };
      await expect(setCoordinatedProjectAlphaConnectorState(changed, fixture.id,
        { expectedVersion: fixture.connector.version, state: "suspended" }, actor)).rejects.toMatchObject({ code: "unavailable" });
      expect(await connector(fixture.id)).toEqual(fixture.connector);
    }
  });
});
