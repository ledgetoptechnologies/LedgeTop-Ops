import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { assertProjectAlphaConnectorProof, connectorFenceStatement, listProjectAlphaConnectors,
  preflightPrimaryProjectAlphaConnector, registerProjectAlphaConnector, resolveProjectAlphaConnector, reviseProjectAlphaConnector, setProjectAlphaConnectorState,
  type ProjectAlphaConnectorEnvironment, type RegisterProjectAlphaConnectorInput } from "../src/worker/project-alpha-connectors";

const primary = "project-alpha:primary";
const author = "connector-admin";
const key = (seed: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(seed))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const signing = (seed: number, keyId = "current") => ({ keyId, algorithm: "ed25519" as const, value: key(seed) });
const credential = (seed: number) => ({ snapshotApiKey: `private-api-key-${seed}`, eventCurrent: signing(seed) });
const draftQuote = { apiKey: "secondary-draft-api-key", hmacSecret: "secondary-draft-hmac-secret-at-least-thirty-two-bytes" };
const ownerDraftQuote = { apiKey: "owner-draft-api-key", hmacSecret: "owner-draft-hmac-secret-at-least-thirty-two-bytes" };
const revision = (credentialRef: string) => ({ credentialRef, snapshotBasePath: "/", accessIssuer: "https://access.example.test",
  accessAudience: "business-receiver-audience", accessSubject: "service-token-subject" });
function input(name: string, credentialRef = "secondary"): RegisterProjectAlphaConnectorInput {
  return { sourceId: `project-alpha:${name}`, producerBindingId: `producer-${name}`, snapshotOrigin: `https://${name}.example.test`,
    applicationKey: "ltds_ops", profile: "business_data", displayName: `Source ${name}`, revision: revision(credentialRef) };
}
const primaryInput: RegisterProjectAlphaConnectorInput = { ...input("primary", "primary"), snapshotOrigin: "https://primary.example.test", profile: "primary_legacy" };
const baseSets = {
  primary: { ...credential(1), eventPrevious: signing(2, "previous") },
  secondary: credential(3), rotated: { ...credential(4), eventPrevious: signing(3, "previous"), draftQuote },
  other: credential(5), third: credential(6), fourth: credential(7), fifth: credential(8), sixth: credential(9),
  draftOwner: { ...credential(10), draftQuote: ownerDraftQuote },
  draftRollback: { ...credential(11), draftQuote: ownerDraftQuote },
  draftRaceA: { ...credential(12), draftQuote: { apiKey: "race-draft-api-key", hmacSecret: "race-draft-hmac-secret-at-least-thirty-two-bytes" } },
  draftRaceB: { ...credential(13), draftQuote: { apiKey: "race-draft-api-key", hmacSecret: "race-draft-hmac-secret-at-least-thirty-two-bytes" } },
  draftReuse: { ...credential(14), draftQuote: ownerDraftQuote },
};
const preservedTables = ["pa_clients", "staff_users", "integration_event_receipts", "integration_health", "client_hub_directory_state"] as const;
let runtime: Miniflare;
let db: D1Database;
let env: ProjectAlphaConnectorEnvironment;
let before: Record<string, Record<string, unknown>[]>;
let after: Record<string, Record<string, unknown>[]>;
let emptyRegistryCount: number | null;
async function storedTables() {
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const table of preservedTables) result[table] = (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all<Record<string, unknown>>()).results;
  return result;
}
async function currentVersion(id: string) {
  const version = await db.prepare("SELECT version FROM pa_connectors WHERE source_id=?").bind(id).first<number>("version");
  if (version === null) throw new Error("Fixture connector missing");
  return version;
}
async function activate(id: string) { return setProjectAlphaConnectorState(env, id, { expectedVersion: await currentVersion(id), state: "active" }, author); }
async function registered(name: string, credentialRef: string) {
  const value = input(name, credentialRef); await registerProjectAlphaConnector(env, value, author); return value;
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: "export default {fetch(){return new Response('registry')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(directory).filter(file => file.endsWith(".sql") && file < "0035_").sort()) {
    await db.batch(splitD1MigrationStatements(readFileSync(new URL(file, directory), "utf8")).map(sql => db.prepare(sql)));
  }
  await db.batch([
    db.prepare("INSERT INTO pa_clients(id,name,payload_json,last_sync_id) VALUES('historical-client','Historical','{ \"id\": \"007\" }','old-sync')"),
    db.prepare("INSERT INTO staff_users(id,email,display_name,status) VALUES('historical-staff','staff@example.test','Existing staff','active')"),
    db.prepare(`INSERT INTO integration_event_receipts(event_id,integration,event_type,user_id,occurred_at,payload_hash,status)
      VALUES('historical-event','project-alpha','projection.changed','historical-client','2026-01-01','unchanged-hash','completed')`),
  ]);
  before = await storedTables();
  await db.batch(splitD1MigrationStatements(readFileSync(new URL("0035_project_alpha_connectors.sql", directory), "utf8")).map(sql => db.prepare(sql)));
  await db.batch(splitD1MigrationStatements(readFileSync(new URL("0050_project_alpha_draft_quote_credentials.sql", directory), "utf8")).map(sql => db.prepare(sql)));
  after = await storedTables();
  emptyRegistryCount = await db.prepare("SELECT count(*) count FROM pa_connectors").first<number>("count");
  env = { OPS_DB: db, PROJECT_ALPHA_BASE_URL: "https://primary.example.test/", PROJECT_ALPHA_API_KEY: "original-api-key",
    APPLICATION_KEY: "ltds_ops", PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: key(1), PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY: key(2),
    PROJECT_ALPHA_WEBHOOK_HMAC_SECRET: "original-legacy-hmac-secret-32-bytes", PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets: baseSets }) };
}, 90_000);
afterAll(async () => { await runtime?.dispose(); });

describe("durable authenticated connector registry", () => {
  it("preserves populated data exactly and never enrolls or enables an inferred producer", async () => {
    expect(after).toEqual(before);
    expect(emptyRegistryCount).toBe(0);
    expect(await listProjectAlphaConnectors(env)).toEqual([]);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    for (const table of ["pa_connectors", "pa_connector_revisions", "pa_connector_signing_keys", "pa_connector_audit"]) {
      expect(await db.prepare(`PRAGMA quick_check('${table}')`).first("quick_check")).toBe("ok");
    }
    const revisionColumns = (await db.prepare("PRAGMA table_info(pa_connector_revisions)").all<{ name: string }>()).results.map(column => column.name);
    expect(revisionColumns).toEqual(expect.arrayContaining(["draft_quote_api_key_fingerprint", "draft_quote_hmac_fingerprint"]));
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='pa_connector_revision_draft_quote_pair'").first("name"))
      .toBe("pa_connector_revision_draft_quote_pair");
    expect(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pa_connector_draft_quote_credentials'").first("name"))
      .toBe("pa_connector_draft_quote_credentials");
  });

  it("rejects primary enrollment before Ops Sync has durably attested its signing identity", async () => {
    const operationsOnly = { ...env, PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: undefined,
      PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY: undefined, PROJECT_ALPHA_WEBHOOK_HMAC_SECRET: undefined };
    await expect(registerProjectAlphaConnector(operationsOnly, primaryInput, author))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
    expect(await listProjectAlphaConnectors(env)).toEqual([]);
  });

  it("preflights primary enrollment without persisting or returning sensitive identity fields", async () => {
    const beforeCounts = await Promise.all(["pa_connectors", "pa_connector_revisions", "pa_connector_signing_keys", "pa_connector_audit"]
      .map(table => db.prepare(`SELECT count(*) count FROM ${table}`).first<number>("count")));
    const ready = await preflightPrimaryProjectAlphaConnector(env, primaryInput);
    expect(ready).toEqual({ ready: true, sourceId: primary, profile: "primary_legacy", reasons: [], expected: {
      snapshotOrigin: "https://primary.example.test", snapshotBasePath: "/", applicationKey: "ltds_ops",
    } });
    const serialized = JSON.stringify(ready);
    for (const privateValue of ["original-api-key", key(1), "credentialRef", "service-token-subject"])
      expect(serialized).not.toContain(privateValue);
    expect(await Promise.all(["pa_connectors", "pa_connector_revisions", "pa_connector_signing_keys", "pa_connector_audit"]
      .map(table => db.prepare(`SELECT count(*) count FROM ${table}`).first<number>("count")))).toEqual(beforeCounts);
  });

  it("returns bounded fail-closed preflight reasons for absent credentials and unattested signing identity", async () => {
    await expect(preflightPrimaryProjectAlphaConnector({ ...env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: undefined }, primaryInput))
      .resolves.toMatchObject({ ready: false, reasons: [{ code: "connector_credentials_unavailable" }] });
    await expect(preflightPrimaryProjectAlphaConnector({ ...env, PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: undefined,
      PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY: undefined, PROJECT_ALPHA_WEBHOOK_HMAC_SECRET: undefined }, primaryInput))
      .resolves.toMatchObject({ ready: false, reasons: [{ code: "primary_signing_identity_unattested" }] });
  });

  it("allows only the primary scalar adapter when enrollment is absent, never a secondary fallback", async () => {
    const resolved = await resolveProjectAlphaConnector(env, primary, "snapshot");
    expect(resolved.proof).toMatchObject({ mode: "legacy_primary", sourceId: primary, revision: 0 });
    expect(resolved.snapshot).toEqual({ baseUrl: "https://primary.example.test/", apiKey: "original-api-key", applicationKey: "ltds_ops" });
    await expect(resolveProjectAlphaConnector(env, "project-alpha:unknown", "snapshot")).rejects.toMatchObject({ code: "unavailable" });
    const disabled = await resolveProjectAlphaConnector({ ...env, PROJECT_ALPHA_API_KEY: undefined }, primary, "snapshot");
    expect(disabled.snapshot).toBeNull();
  });

  it("will not invent or retarget the already established primary producer during enrollment", async () => {
    for (const value of [
      { ...primaryInput, snapshotOrigin: "https://different.example.test" },
      { ...primaryInput, applicationKey: "different_app" },
      { ...primaryInput, revision: { ...primaryInput.revision, snapshotBasePath: "/other-instance" } },
    ]) await expect(registerProjectAlphaConnector(env, value, author)).rejects.toMatchObject({ code: "conflict" });
    await expect(registerProjectAlphaConnector(env, { ...primaryInput, revision: revision("secondary") }, author))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
    await expect(registerProjectAlphaConnector({ ...env, PROJECT_ALPHA_BASE_URL: undefined }, primaryInput, author))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
    expect(await listProjectAlphaConnectors(env)).toEqual([]);
  });

  it("retains scalar-primary signing history even after a key rotates away before enrollment", async () => {
    const temporary = { ...env, PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY: key(24) };
    await resolveProjectAlphaConnector(temporary, primary, "events");
    const rotated = { ...env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets: { historical: credential(24) } }) };
    await expect(registerProjectAlphaConnector(rotated, input("historical-key-theft", "historical"), author)).rejects.toMatchObject({ code: "conflict" });
    expect(await db.prepare("SELECT source_id FROM pa_connectors WHERE source_id='project-alpha:historical-key-theft'").first()).toBeNull();
    expect(await listProjectAlphaConnectors(env)).toEqual([]);
  });

  it("stages primary enrollment without interrupting the established scalar adapter", async () => {
    const legacy = await resolveProjectAlphaConnector(env, primary, "events");
    const operationsOnly = { ...env, PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: undefined,
      PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY: undefined, PROJECT_ALPHA_WEBHOOK_HMAC_SECRET: undefined };
    const created = await registerProjectAlphaConnector(operationsOnly, primaryInput, author);
    expect(created).toMatchObject({ state: "pending", readVisible: true, activeRevision: 1, version: 1 });
    expect(await resolveProjectAlphaConnector(env, primary, "events")).toMatchObject({ proof: { mode: "legacy_primary" } });
    await expect(assertProjectAlphaConnectorProof(env, legacy.proof)).resolves.toBeUndefined();
    await expect(db.batch([connectorFenceStatement(db, legacy.proof), db.prepare("UPDATE pa_clients SET name='Legacy adapter active' WHERE id='historical-client'")]))
      .resolves.toBeDefined();
    expect(await db.prepare("SELECT name FROM pa_clients WHERE id='historical-client'").first("name")).toBe("Legacy adapter active");
    await expect(setProjectAlphaConnectorState(env, primary, { expectedVersion: 1, state: "pending", readVisible: false }, author))
      .rejects.toMatchObject({ code: "invalid" });
    expect(await db.prepare("SELECT count(*) count FROM pa_connector_audit WHERE source_id=?").bind(primary).first("count")).toBe(1);
    const snapshot = JSON.stringify(await listProjectAlphaConnectors(env));
    expect(snapshot).not.toContain("private-api-key"); expect(snapshot).not.toContain(key(1)); expect(snapshot).not.toContain("credential_ref");
  });

  it("requires explicitly active primary enrollment before activating or resolving secondary business ingress", async () => {
    const stagedPrimary = await resolveProjectAlphaConnector(env, primary, "events");
    const value = await registered("secondary", "secondary");
    await expect(activate(value.sourceId)).rejects.toMatchObject({ code: "conflict" });
    expect(await currentVersion(value.sourceId)).toBe(1);
    await activate(primary);
    await expect(assertProjectAlphaConnectorProof(env, stagedPrimary.proof)).rejects.toMatchObject({ code: "changed" });
    await expect(db.batch([connectorFenceStatement(db, stagedPrimary.proof), db.prepare("UPDATE pa_clients SET name='Must not apply' WHERE id='historical-client'")]))
      .rejects.toThrow(/pa_connector_active_revision_guard/);
    expect(await db.prepare("SELECT name FROM pa_clients WHERE id='historical-client'").first("name")).toBe("Legacy adapter active");
    await activate(value.sourceId);
    const resolved = await resolveProjectAlphaConnector(env, value.sourceId, "events");
    expect(resolved.source).toEqual({ sourceId: value.sourceId, staffAuthority: false });
    expect(resolved.proof).toMatchObject({ mode: "registry", revision: 1, version: 2, profile: "business_data" });
    expect(resolved.event).toMatchObject({ accessSubject: "service-token-subject", current: { keyId: "current", algorithm: "ed25519", value: key(3) } });
    expect(resolved.snapshot?.baseUrl).toBe("https://secondary.example.test");
  });

  it("keeps producer, source, origin, base path and application ownership immutable including REPLACE", async () => {
    for (const [field, value] of [["source_id", "project-alpha:stolen"], ["producer_binding_id", "stolen-producer"],
      ["snapshot_origin", "https://other.example.test"], ["snapshot_base_path", "/other"], ["application_key", "different_app"], ["profile", "business_data"]] as const) {
      await expect(db.prepare(`UPDATE pa_connectors SET ${field}=?,version=version+1 WHERE source_id=?`).bind(value, primary).run()).rejects.toThrow();
    }
    await expect(db.prepare("INSERT OR REPLACE INTO pa_connectors SELECT * FROM pa_connectors WHERE source_id=?").bind(primary).run()).rejects.toThrow();
    await expect(db.prepare("DELETE FROM pa_connectors WHERE source_id=?").bind(primary).run()).rejects.toThrow();
    await expect(reviseProjectAlphaConnector(env, primary, await currentVersion(primary), { ...revision("primary"), snapshotBasePath: "/different" }, author))
      .rejects.toMatchObject({ code: "conflict" });
  });

  it("rolls back new state and audit together on stale CAS and advances the bounded read epoch on changes", async () => {
    const previous = await currentVersion("project-alpha:secondary");
    const epoch = await db.prepare("SELECT read_revision FROM pa_connector_directory_state WHERE id='directory'").first<number>("read_revision");
    await setProjectAlphaConnectorState(env, "project-alpha:secondary", { expectedVersion: previous, state: "active", readVisible: true }, author);
    const count = await db.prepare("SELECT count(*) count FROM pa_connector_audit").first("count");
    await expect(setProjectAlphaConnectorState(env, "project-alpha:secondary", { expectedVersion: previous, state: "suspended" }, author))
      .rejects.toMatchObject({ code: "conflict" });
    expect(await db.prepare("SELECT count(*) count FROM pa_connector_audit").first("count")).toBe(count);
    expect(await db.prepare("SELECT read_revision FROM pa_connector_directory_state WHERE id='directory'").first<number>("read_revision")).toBe((epoch ?? 0) + 1);
  });

  it("fences the same write batch after suspension while retaining explicit read visibility", async () => {
    const id = "project-alpha:secondary", resolved = await resolveProjectAlphaConnector(env, id, "snapshot");
    await setProjectAlphaConnectorState(env, id, { expectedVersion: await currentVersion(id), state: "suspended" }, author);
    await expect(db.batch([connectorFenceStatement(db, resolved.proof), db.prepare("INSERT INTO pa_clients(id,name,payload_json,last_sync_id) VALUES('must-rollback','Wrong','{}','race')")]))
      .rejects.toThrow(/pa_connector_active_revision_guard/);
    expect(await db.prepare("SELECT id FROM pa_clients WHERE id='must-rollback'").first()).toBeNull();
    expect((await listProjectAlphaConnectors(env)).find(row => row.sourceId === id)).toMatchObject({ state: "suspended", readVisible: true });
    await activate(id);
  });

  it("rotates within one owner, invalidates the old proof and reserves both current and previous keys forever", async () => {
    const id = "project-alpha:secondary", old = await resolveProjectAlphaConnector(env, id, "events");
    await reviseProjectAlphaConnector(env, id, await currentVersion(id), revision("rotated"), author);
    await expect(assertProjectAlphaConnectorProof(env, old.proof)).rejects.toMatchObject({ code: "changed" });
    expect((await resolveProjectAlphaConnector(env, id, "events")).event).toMatchObject({ current: { value: key(4) }, previous: { value: key(3) } });
    expect((await resolveProjectAlphaConnector(env, id, "draft_quote")).draftQuote).toEqual({
      baseUrl: "https://secondary.example.test", applicationKey: "ltds_ops", apiKey: draftQuote.apiKey, hmacSecret: draftQuote.hmacSecret,
    });
    await expect(registerProjectAlphaConnector(env, input("steal-old", "secondary"), author)).rejects.toMatchObject({ code: "conflict" });
    await expect(registerProjectAlphaConnector(env, input("steal-current", "rotated"), author)).rejects.toMatchObject({ code: "conflict" });
    expect(await db.prepare("SELECT source_id FROM pa_connectors WHERE source_id IN ('project-alpha:steal-old','project-alpha:steal-current')").all()).toMatchObject({ results: [] });
    await expect(db.prepare("UPDATE pa_connector_signing_keys SET source_id='project-alpha:other'").run()).rejects.toThrow();
    await expect(db.prepare("INSERT OR REPLACE INTO pa_connector_signing_keys SELECT * FROM pa_connector_signing_keys LIMIT 1").run()).rejects.toThrow();
    await expect(db.prepare("DELETE FROM pa_connector_signing_keys").run()).rejects.toThrow();
  });

  it("denies scalar-primary key reuse and fails closed when the deployed keyset drifts or disappears", async () => {
    await expect(registerProjectAlphaConnector(env, input("scalar-key-theft", "primary"), author)).rejects.toMatchObject({ code: "conflict" });
    const drift = { ...env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets: { ...baseSets, rotated: credential(20) } }) };
    await expect(resolveProjectAlphaConnector(drift, "project-alpha:secondary", "events")).rejects.toMatchObject({ code: "credentials_unavailable" });
    await expect(resolveProjectAlphaConnector({ ...env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: undefined }, primary, "snapshot"))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
    await expect(resolveProjectAlphaConnector({ ...env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: '{"version":1,"sets":{}}' }, primary, "snapshot"))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
  });

  it("requires dedicated, revision-pinned draft credentials and never substitutes another connector purpose", async () => {
    const selected = baseSets.rotated;
    for (const invalid of [
      { ...selected, draftQuote: { apiKey: selected.snapshotApiKey, hmacSecret: draftQuote.hmacSecret } },
      { ...selected, draftQuote: { apiKey: draftQuote.apiKey, hmacSecret: selected.eventCurrent.value } },
      { ...selected, draftQuote: { apiKey: draftQuote.apiKey, hmacSecret: draftQuote.apiKey } },
    ]) await expect(resolveProjectAlphaConnector({ ...env,
      PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets: { ...baseSets, rotated: invalid } }) },
    "project-alpha:secondary", "draft_quote")).rejects.toMatchObject({ code: "credentials_unavailable" });
    await expect(resolveProjectAlphaConnector({ ...env, PROJECT_ALPHA_DRAFT_QUOTE_API_KEY: draftQuote.apiKey },
      "project-alpha:secondary", "draft_quote")).rejects.toMatchObject({ code: "conflict" });
    const drift = { ...selected, draftQuote: { ...draftQuote, apiKey: "unregistered-rotated-api-key" } };
    await expect(resolveProjectAlphaConnector({ ...env,
      PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets: { ...baseSets, rotated: drift } }) },
    "project-alpha:secondary", "draft_quote")).rejects.toMatchObject({ code: "credentials_unavailable" });
  });

  it("reserves draft credentials to one source across staggered registration, rotation, and rollback", async () => {
    const owner = await registered("draft-owner", "draftOwner");
    await reviseProjectAlphaConnector(env,owner.sourceId,await currentVersion(owner.sourceId),revision("draftRollback"),author);
    await reviseProjectAlphaConnector(env,owner.sourceId,await currentVersion(owner.sourceId),revision("draftOwner"),author);
    expect(await db.prepare("SELECT count(*) count FROM pa_connector_draft_quote_credentials WHERE source_id=?")
      .bind(owner.sourceId).first("count")).toBe(2);
    await expect(registerProjectAlphaConnector(env,input("draft-staggered-theft","draftReuse"),author))
      .rejects.toMatchObject({code:"conflict"});
    expect(await db.prepare("SELECT source_id FROM pa_connectors WHERE source_id='project-alpha:draft-staggered-theft'").first()).toBeNull();
    await expect(db.prepare("UPDATE pa_connector_draft_quote_credentials SET source_id='project-alpha:other'").run()).rejects.toThrow();
    await expect(db.prepare("DELETE FROM pa_connector_draft_quote_credentials").run()).rejects.toThrow();
    await expect(db.prepare(`INSERT OR REPLACE INTO pa_connector_draft_quote_credentials
      SELECT * FROM pa_connector_draft_quote_credentials LIMIT 1`).run()).rejects.toThrow();
  });

  it("converges racing cross-source draft credential reservations to one owner", async () => {
    const left=input("draft-race-left","draftRaceA"),right=input("draft-race-right","draftRaceB");
    const results=await Promise.allSettled([
      registerProjectAlphaConnector(env,left,author),registerProjectAlphaConnector(env,right,author),
    ]);
    expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);
    expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
    const owners=(await db.prepare(`SELECT DISTINCT source_id FROM pa_connector_draft_quote_credentials
      WHERE source_id IN (?,?)`).bind(left.sourceId,right.sourceId).all<{source_id:string}>()).results;
    expect(owners).toHaveLength(1);
    expect(await db.prepare(`SELECT count(*) count FROM pa_connector_draft_quote_credentials
      WHERE source_id IN (?,?)`).bind(left.sourceId,right.sourceId).first("count")).toBe(2);
  });

  it("isolates malformed unrelated credentials while strictly rejecting the selected malformed set", async () => {
    for (const malformed of [null, { snapshotApiKey: 42 }, { ...baseSets.rotated, unexpected: "not permitted" }]) {
      const partial = { ...env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1,
        sets: { ...baseSets, rotated: malformed } }) };
      const resolved = await resolveProjectAlphaConnector(partial, primary, "snapshot");
      expect(resolved.snapshot?.apiKey).toBe(baseSets.primary.snapshotApiKey);
      expect(resolved.proof).toMatchObject({ mode: "registry", sourceId: primary });
      await expect(resolveProjectAlphaConnector(partial, "project-alpha:secondary", "events"))
        .rejects.toMatchObject({ code: "credentials_unavailable" });
    }
  }, 15_000);

  it("resolves enrolled primary from its registered revision despite obsolete malformed scalar signing settings", async () => {
    for (const obsolete of [
      { PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: "invalid-obsolete-key" },
      { PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY: "invalid-obsolete-key" },
      { PROJECT_ALPHA_WEBHOOK_HMAC_SECRET: "x".repeat(8193) },
    ]) {
      const resolved = await resolveProjectAlphaConnector({ ...env, ...obsolete }, primary, "events");
      expect(resolved.proof).toMatchObject({ mode: "registry", sourceId: primary, revision: 1 });
      expect(resolved.event).toMatchObject({ current: { value: key(1) }, previous: { value: key(2) } });
    }
  });

  it("still rejects a secondary registered key that collides with currently configured scalar primary", async () => {
    await expect(resolveProjectAlphaConnector({ ...env, PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: key(4) },
      "project-alpha:secondary", "events")).rejects.toMatchObject({ code: "conflict" });
  });

  it.each([33, 64])("accepts %i bounded deployment credential references without adding connector authority", async count => {
    const sets = { ...baseSets, ...Object.fromEntries(Array.from({ length: count - Object.keys(baseSets).length },
      (_, index) => [`staged_${index}`, credential(100)])) };
    expect(Object.keys(sets)).toHaveLength(count);
    const staged = { ...env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets }) };
    const before = await db.prepare("SELECT count(*) count FROM pa_connectors").first("count");
    expect((await resolveProjectAlphaConnector(staged, primary, "snapshot")).snapshot?.apiKey).toBe(baseSets.primary.snapshotApiKey);
    expect((await resolveProjectAlphaConnector(staged, "project-alpha:secondary", "events")).event?.current.value).toBe(key(4));
    expect(await db.prepare("SELECT count(*) count FROM pa_connectors").first("count")).toBe(before);
  });

  it("still rejects more than 64 references and invalid or oversized shared credential envelopes", async () => {
    const tooMany = { primary: baseSets.primary, ...Object.fromEntries(Array.from({ length: 64 },
      (_, index) => [`staged_${index}`, credential(100)])) };
    expect(Object.keys(tooMany)).toHaveLength(65);
    for (const envelope of [
      { version: 1, sets: tooMany },
      { version: 2, sets: baseSets },
      { version: 1, sets: { ...baseSets, "invalid reference": null } },
      { version: 1, sets: baseSets, unexpected: true },
      { version: 1, sets: { ...baseSets, oversized: "x".repeat(256 * 1024) } },
    ]) await expect(resolveProjectAlphaConnector({ ...env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify(envelope) }, primary, "snapshot"))
      .rejects.toMatchObject({ code: "credentials_unavailable" });
  });

  it("keeps revisions and audits append-only and cannot bypass enrollment through a forged profile", async () => {
    await expect(db.prepare("INSERT OR REPLACE INTO pa_connector_revisions SELECT * FROM pa_connector_revisions WHERE source_id=? AND revision=1").bind(primary).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE pa_connector_revisions SET access_subject='other'").run()).rejects.toThrow();
    await expect(db.prepare("DELETE FROM pa_connector_revisions").run()).rejects.toThrow();
    await expect(db.prepare("INSERT OR REPLACE INTO pa_connector_audit SELECT * FROM pa_connector_audit LIMIT 1").run()).rejects.toThrow();
    await expect(registerProjectAlphaConnector(env, { ...input("authority", "other"), profile: "primary_legacy" }, author))
      .rejects.toMatchObject({ code: "invalid" });
  });

  it("rolls back registry and key reservations if the audit cannot commit", async () => {
    await db.prepare(`CREATE TRIGGER fixture_connector_audit_failure BEFORE INSERT ON pa_connector_audit
      WHEN NEW.source_id='project-alpha:audit-failure' BEGIN SELECT RAISE(ABORT,'fixture audit failed'); END`).run();
    try { await expect(registerProjectAlphaConnector(env, input("audit-failure", "other"), author)).rejects.toMatchObject({ code: "unavailable" }); }
    finally { await db.prepare("DROP TRIGGER fixture_connector_audit_failure").run(); }
    expect(await db.prepare("SELECT source_id FROM pa_connectors WHERE source_id='project-alpha:audit-failure'").first()).toBeNull();
    // The exact same previously unowned key remains available after rollback.
    await registerProjectAlphaConnector(env, input("after-rollback", "other"), author);
  });

  it("keeps registration/state races convergent and cannot reactivate a retired producer", async () => {
    const value = input("concurrent-registration", "third");
    const results = await Promise.allSettled([registerProjectAlphaConnector(env, value, author), registerProjectAlphaConnector(env, value, author)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(await db.prepare("SELECT count(*) count FROM pa_connector_audit WHERE source_id=?").bind(value.sourceId).first("count")).toBe(1);
    await setProjectAlphaConnectorState(env, value.sourceId, { expectedVersion: 1, state: "retired" }, author);
    await expect(activate(value.sourceId)).rejects.toMatchObject({ code: "conflict" });
  });

  it("rejects malformed source/control values and unsupported HMAC business profiles before writes", async () => {
    for (const bad of ["project-alpha:bad\0hidden", "project-alpha:bad\n", "project-alpha:UPPER", " project-alpha:space"]) {
      await expect(registerProjectAlphaConnector(env, { ...input("bad", "fourth"), sourceId: bad }, author)).rejects.toMatchObject({ code: "invalid" });
    }
    const weak = { ...env, PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets: {
      hmac: { snapshotApiKey: "private", eventCurrent: { keyId: "hmac", algorithm: "hmac-sha256", value: "long-enough-secret-but-not-a-business-signer" } },
    } }) };
    await expect(registerProjectAlphaConnector(weak, input("hmac", "hmac"), author)).rejects.toMatchObject({ code: "credentials_unavailable" });
    await expect(registerProjectAlphaConnector(env, input("prototype-ref", "toString"), author)).rejects.toMatchObject({ code: "credentials_unavailable" });
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });

  it("uses source/state indexes for bounded registry lookup and scheduling", async () => {
    const plan = (await db.prepare("EXPLAIN QUERY PLAN SELECT source_id FROM pa_connectors WHERE state='active' AND source_id>? ORDER BY source_id LIMIT 33")
      .bind("").all<{ detail: string }>()).results.map(row => row.detail).join(" ");
    expect(plan).toContain("idx_pa_connectors_schedule"); expect(plan).not.toContain("TEMP B-TREE");
  });

  it("enforces the persistent registry capacity rather than silently truncating administrative results", async () => {
    const existing = (await listProjectAlphaConnectors(env)).length;
    const statements: D1PreparedStatement[] = [];
    for (let index = existing; index < 32; index += 1) {
      const id = `project-alpha:capacity-${index}`, fingerprint = `cccc${String(index).padStart(60, "0")}`;
      statements.push(
        db.prepare("INSERT INTO pa_connector_signing_keys(fingerprint,source_id,algorithm) VALUES(?,?,'ed25519')").bind(fingerprint, id),
        db.prepare(`INSERT INTO pa_connectors(source_id,producer_binding_id,snapshot_origin,snapshot_base_path,application_key,profile,display_name,created_by)
          VALUES(?,?,?,'/','ltds_ops','business_data','Capacity fixture',?)`).bind(id, `capacity-${index}`, `https://capacity-${index}.example.test`, author),
        db.prepare(`INSERT INTO pa_connector_revisions(source_id,revision,credential_ref,snapshot_base_path,access_issuer,access_audience,access_subject,
          current_key_id,current_key_fingerprint,created_by) VALUES(?,1,'fixture','/','https://access.example.test','audience','subject','v1',?,?)`)
          .bind(id, fingerprint, author),
      );
    }
    await db.batch(statements);
    expect(await listProjectAlphaConnectors(env)).toHaveLength(32);
    await expect(registerProjectAlphaConnector(env, input("over-capacity", "fourth"), author)).rejects.toMatchObject({ code: "capacity" });
    expect(await db.prepare("SELECT count(*) count FROM pa_connectors").first("count")).toBe(32);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, 30_000);
});
