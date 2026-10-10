import { Miniflare } from "miniflare";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClientInternalNote, readClientInternalNotes } from "../src/worker/client-internal-notes";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const sourceId = "project-alpha:contract" as const;
const sourceInstanceId = "11111111-1111-4111-8111-111111111111";
const applicationId = "22222222-2222-4222-8222-222222222222";
const historyEpochId = "33333333-3333-4333-8333-333333333333";
const recordId = "ops-client-contract";
const externalId = "pa-client-contract";
const publicId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const actor: StaffPrincipal = { id: "notes-contract-reader", email: "notes@example.test", displayName: "Notes reader",
  accessSubject: "access|notes-contract-reader", projectAlphaUserId: null };
const connections = JSON.stringify({ version: 1, instances: { [sourceId]: { sourceId, enabled: true,
  baseUrl: "https://pa.example.test", apiKey: "test-only", sourceInstanceId, applicationId, historyEpoch: historyEpochId } } });
let runtime: Miniflare, db: D1Database;

const schema = `
CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,display_name TEXT,access_subject TEXT,status TEXT);
CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT);
CREATE TABLE staff_role_assignments(id TEXT,staff_id TEXT,role_id TEXT,scope TEXT,scope_key TEXT);
CREATE TABLE local_staff_role_assignments(id TEXT,staff_id TEXT,role_id TEXT,scope TEXT,scope_key TEXT);
CREATE TABLE staff_permission_overrides(id TEXT PRIMARY KEY,staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,scope_key TEXT,created_by TEXT);
CREATE TABLE pa_connector_directory_state(id TEXT PRIMARY KEY,read_revision INTEGER);
CREATE TABLE pa_connectors(source_id TEXT PRIMARY KEY,display_name TEXT,read_visible INTEGER);
CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER);
CREATE TABLE operations_directory_revisions(record_id TEXT,version INTEGER,profile_json TEXT,PRIMARY KEY(record_id,version));
CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT,relationship_version INTEGER);
CREATE TABLE project_alpha_active_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
  resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,mapping_kind TEXT,provenance_id TEXT);
CREATE TABLE client_internal_notes(id TEXT PRIMARY KEY,source_id TEXT,root_namespace TEXT,root_kind TEXT,root_id TEXT,version INTEGER,
  title TEXT,body TEXT,created_by TEXT,updated_by TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,deleted_at TEXT);
CREATE TABLE client_internal_note_revisions(id TEXT PRIMARY KEY,note_id TEXT,source_id TEXT,root_namespace TEXT,root_kind TEXT,root_id TEXT,
  version INTEGER,action TEXT,title TEXT,body TEXT,actor_id TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE client_internal_note_mutations(actor_id TEXT,idempotency_key TEXT,operation_kind TEXT,request_fingerprint TEXT,source_id TEXT,
  root_namespace TEXT,root_kind TEXT,root_id TEXT,note_id TEXT,result_version INTEGER,result_json TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(actor_id,idempotency_key));`;

function env(database: D1Database = db, configured = connections): Pick<Env, "OPS_DB" | "DELIVERY_DB" | "PROJECT_ALPHA_API_V2_CONNECTIONS"> {
  return { OPS_DB: database, DELIVERY_DB: database, PROJECT_ALPHA_API_V2_CONNECTIONS: configured };
}
function context(overrides: Partial<ClientHubCollectionContext["root"]> = {}): ClientHubCollectionContext {
  const root: ClientHubCollectionContext["root"] = { source_id: sourceId, root_namespace: "business", kind: "standalone_client",
    public_id: recordId, pa_internal_id: externalId, pa_public_id: publicId, mapping_status: "mapped" as const,
    display_name: "Contract client", source_name: "Contract source", sort_name: "contract client", status: "active",
    portal_status: "mapping_unavailable", workspace_id: null, legacy_account_id: null, account_count: 0, project_count: 0,
    request_count: 0, contact_count: 0, meaningful_activity_at: null, source_version: null, indexed_at: "", scan_generation: 0,
    ...overrides };
  return { root, paRootId: root.pa_internal_id, access: { directory: true, requests: false, delivery: false, viewer: false },
    contextVersion: "c".repeat(43), canonicalRoot: { sourceId, rootNamespace: "business", kind: "standalone_client", publicId: recordId } };
}
async function resetFixture(options: { connector?: "visible" | "hidden" | "absent"; parent?: string | null; mapping?: boolean;
  active?: boolean; collision?: boolean } = {}) {
  for (const table of ["client_internal_note_mutations", "client_internal_note_revisions", "client_internal_notes",
    "project_alpha_active_directory_mappings", "operations_directory_client_organizations", "operations_directory_revisions",
    "operations_directory_records", "pa_connectors", "staff_permission_overrides", "staff_users"])
    await db.prepare(`DELETE FROM ${table}`).run();
  await db.prepare("UPDATE pa_connector_directory_state SET read_revision=1 WHERE id='directory'").run();
  await db.batch([
    db.prepare("INSERT INTO staff_users VALUES(?,?,?,?, 'active')").bind(actor.id, actor.email, actor.displayName, actor.accessSubject),
    db.prepare("INSERT INTO staff_permission_overrides VALUES(?,?,'team.view','allow','global','global',?)")
      .bind(crypto.randomUUID(), actor.id, actor.id),
    db.prepare("INSERT INTO staff_permission_overrides VALUES(?,?,'client.notes.manage','allow','global','global',?)")
      .bind(crypto.randomUUID(), actor.id, actor.id),
    db.prepare("INSERT INTO operations_directory_records VALUES(?,'client',?)").bind(recordId, options.active === false ? 0 : 1),
    db.prepare("INSERT INTO operations_directory_revisions VALUES(?,1,?)").bind(recordId, JSON.stringify({ name: "Contract client" })),
    db.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?,1)").bind(recordId, options.parent ?? null),
  ]);
  if (options.mapping !== false) await db.prepare(`INSERT INTO project_alpha_active_directory_mappings
    VALUES(?,?,?,?, 'client',?,?,?,?,?)`).bind(sourceId, sourceInstanceId, applicationId, historyEpochId, recordId, externalId,
      publicId, "acquired", "contract-proof").run();
  if (options.collision) await db.batch([
    db.prepare("INSERT INTO operations_directory_records VALUES('collision-client','client',1)"),
    db.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES(?,?,?,?, 'client','collision-client',?,?, 'acquired','collision-proof')")
      .bind(sourceId, sourceInstanceId, applicationId, historyEpochId, externalId, "b".repeat(32)),
  ]);
  if (options.connector && options.connector !== "absent") await db.prepare("INSERT INTO pa_connectors VALUES(?,?,?)")
    .bind(sourceId, "Contract source", options.connector === "visible" ? 1 : 0).run();
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: crypto.randomUUID() } });
  db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  for (const statement of schema.split(";").map(value => value.trim()).filter(Boolean)) await db.prepare(statement).run();
  await db.prepare("INSERT INTO pa_connector_directory_state VALUES('directory',1)").run();
}, 30_000);
afterEach(async () => resetFixture());
afterAll(async () => runtime?.dispose());

describe("native Client Hub internal-note materialized mapping contract", () => {
  it.each(["visible", "absent"] as const)("accepts unequal IDs with a %s connector", async connector => {
    await resetFixture({ connector });
    await expect(readClientInternalNotes(env(), actor, context())).resolves.toMatchObject({ notes: [],
      capabilities: { canManageNotes: true }, canonicalRoot: { publicId: recordId } });
  });

  it("rejects wrong context tuples and wrong configured identity", async () => {
    await resetFixture({ connector: "visible" });
    await expect(readClientInternalNotes(env(), actor, context({ pa_internal_id: recordId }))).rejects.toMatchObject({ status: 404 });
    const wrong = JSON.stringify({ version: 1, instances: { [sourceId]: { sourceId, enabled: true,
      baseUrl: "https://pa.example.test", apiKey: "test-only", sourceInstanceId, applicationId,
      historyEpoch: "44444444-4444-4444-8444-444444444444" } } });
    await expect(readClientInternalNotes(env(db, wrong), actor, context())).rejects.toMatchObject({ status: 404 });
  });

  it.each([
    ["hidden connector", { connector: "hidden" as const }], ["mapping missing", { mapping: false }],
    ["mapping collision", { collision: true }], ["inactive record", { active: false }],
    ["standalone client parent", { parent: "ops-parent" }],
  ])("rejects %s", async (_label, options) => {
    await resetFixture(options);
    await expect(readClientInternalNotes(env(), actor, context())).rejects.toMatchObject({ status: 404 });
  });

  it("preserves team.view read and client.notes.manage mutation authority", async () => {
    await resetFixture({ connector: "visible" });
    await db.prepare("DELETE FROM staff_permission_overrides WHERE permission_key='client.notes.manage'").run();
    await expect(readClientInternalNotes(env(), actor, context())).resolves.toMatchObject({ capabilities: { canManageNotes: false } });
    await expect(createClientInternalNote(env(), actor, context(), { expectedContextVersion: "c".repeat(43), title: "Denied", body: "" },
      "contract_permission_key")).rejects.toMatchObject({ status: 403 });
    await db.prepare("DELETE FROM staff_permission_overrides WHERE permission_key='team.view'").run();
    await expect(readClientInternalNotes(env(), actor, context())).rejects.toMatchObject({ status: 403 });
  });

  it("returns 409 when the native proof drifts between authority checks", async () => {
    await resetFixture({ connector: "visible" });
    let proofReads = 0;
    const session = db.withSession("first-primary");
    const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values));
        if (property === "all") return async () => {
          const result = await target.all();
          if (++proofReads === 1) await db.prepare("UPDATE operations_directory_revisions SET profile_json=? WHERE record_id=?")
            .bind(JSON.stringify({ name: "Drifted client" }), recordId).run();
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const wrapped = new Proxy(session, { get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (sql: string) => {
        const prepared = target.prepare(sql);
        if (!sql.includes("SELECT mapping.source_id,mapping.source_instance_id")) return prepared;
        return wrapStatement(prepared);
      };
    } });
    const wrappedDb = new Proxy(db, { get(target, property) {
      if (property === "withSession") return () => wrapped;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    await expect(readClientInternalNotes(env(wrappedDb), actor, context())).rejects.toMatchObject({ status: 409 });
    expect(proofReads).toBeGreaterThanOrEqual(2);
  });
});
