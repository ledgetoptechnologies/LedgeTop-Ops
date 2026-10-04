import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { hasClientHubActiveDirectoryMappings, isAlphaPublicId, readClientHubSourcePublicId,
  resolveClientHubSourceRoot, resolveClientHubSourceRootByAlphaIdentity, sourcePublicIdExpression } from "../src/worker/client-hub-source";
import { applyConnectorSchema, registerVisibleTestSource } from "./helpers/project-alpha-connectors";

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

describe("explicit Alpha source public IDs", () => {
  const publicId = "00000000000000000000000000000042";
  const identity = { sourceInstanceId: "00000000-0000-4000-8000-000000000001",
    applicationId: "00000000-0000-4000-8000-000000000002", historyEpoch: "00000000-0000-4000-8000-000000000003" };
  const configuredEnv = (db: D1Database) => ({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
    "project-alpha:primary": { sourceId: "project-alpha:primary", enabled: true, baseUrl: "https://alpha.example.test/",
      apiKey: "test-key", ...identity },
  } }) });
  it("preserves the native 32-hex representation and never guesses from internal IDs", () => {
    expect(isAlphaPublicId(publicId)).toBe(true);
    expect(readClientHubSourcePublicId(JSON.stringify({ id: 42, public_id: publicId })))
      .toEqual({ pa_public_id: publicId, mapping_status: "mapped" });
    for (const value of [42, "42", "A".repeat(32), ` ${publicId}`, "00000000-0000-0000-0000-000000000042", {}, []]) {
      expect(readClientHubSourcePublicId(JSON.stringify({ public_id: value })))
        .toEqual({ pa_public_id: null, mapping_status: "invalid" });
    }
    for (const payload of ["{}", '{"public_id":null}', '{"id":"42"}'])
      expect(readClientHubSourcePublicId(payload)).toEqual({ pa_public_id: null, mapping_status: "missing" });
    for (const payload of ["{bad", "null", "[]", '"text"'])
      expect(readClientHubSourcePublicId(payload)).toEqual({ pa_public_id: null, mapping_status: "invalid" });
  });

  it("resolves only unique source mappings, including inactive collisions, without changing source records", async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default { fetch(){return new Response('ok')} }", d1Databases: { OPS_DB: "source-contract" } });
    const db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await applyConnectorSchema(db);
    await db.exec("CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT,active INTEGER,payload_json TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary'); CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT,organization_id TEXT,active INTEGER,payload_json TEXT,projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');");
    await db.exec(readFileSync(new URL("../migrations/0032_client_hub_directory.sql", import.meta.url), "utf8")
      .replace(/^\s*--.*$/gm, "").replace(/\s*\n\s*/g, " "));
    const plan = await db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM pa_organizations source
      WHERE ${sourcePublicIdExpression("source") }=?`).bind(publicId).all<{ detail: string }>();
    expect(plan.results.some(row => row.detail.includes("idx_pa_organizations_client_hub_public_id"))).toBe(true);
    await db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('42','Business',1,?)").bind(JSON.stringify({ id: 42, public_id: publicId })).run();
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "organization", "42"))
      .toEqual({ id: "42", pa_internal_id: "42", display_name: "Business", organization_id: null, active: 1, pa_public_id: publicId, mapping_status: "mapped" });
    await db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json,projection_source_id) VALUES('secondary-42','Other producer',1,?,'project-alpha:secondary')")
      .bind(JSON.stringify({ id: 42, public_id: publicId })).run();
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "organization", "42"))
      .toMatchObject({ pa_public_id: publicId, mapping_status: "mapped" });
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "organization", "secondary-42")).toBeNull();
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "organization", "secondary-42", "project-alpha:secondary")).toBeNull();
    await registerVisibleTestSource(db, "project-alpha:secondary");
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "organization", "secondary-42", "project-alpha:secondary"))
      .toMatchObject({ id: "secondary-42", pa_public_id: publicId, mapping_status: "mapped" });
    await db.prepare("INSERT INTO pa_organizations(id,name,active,payload_json) VALUES('99','Inactive collision',0,?)").bind(JSON.stringify({ id: 99, public_id: publicId })).run();
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "organization", "42"))
      .toMatchObject({ pa_public_id: null, mapping_status: "ambiguous" });
    await db.prepare("INSERT INTO pa_clients(id,name,organization_id,active,payload_json) VALUES('42','Contact','99',1,'{}'),('missing','Missing',NULL,0,'{}'),('invalid','Invalid',NULL,1,'broken-json')").run();
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "standalone_client", "42"))
      .toMatchObject({ organization_id: "99", pa_public_id: null, mapping_status: "missing" });
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "standalone_client", "missing"))
      .toMatchObject({ active: 0, pa_public_id: null, mapping_status: "missing" });
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "standalone_client", "invalid"))
      .toMatchObject({ pa_public_id: null, mapping_status: "invalid" });
    expect(await resolveClientHubSourceRoot({ OPS_DB: db }, "organization", "unknown")).toBeNull();
    expect(await db.prepare("SELECT payload_json FROM pa_clients WHERE id='invalid'").first("payload_json")).toBe("broken-json");
  }, 30_000);

  it("resolves an acquired API-v2 mapping through the real view and keeps the Ops record ID as the route key", async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default { fetch(){return new Response('ok')} }", d1Databases: { OPS_DB: "active-source-contract" } });
    const db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await applyConnectorSchema(db);
    await db.exec(`CREATE TABLE pa_organizations(id TEXT PRIMARY KEY,name TEXT,active INTEGER,payload_json TEXT,
      projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE pa_clients(id TEXT PRIMARY KEY,name TEXT,organization_id TEXT,active INTEGER,payload_json TEXT,
      projection_source_id TEXT NOT NULL DEFAULT 'project-alpha:primary');
      CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT);
      CREATE TABLE active_mapping_rows(source_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,
        project_alpha_public_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,active INTEGER);
      CREATE VIEW project_alpha_active_directory_mappings AS SELECT source_id,resource_type,record_id,external_id,
        project_alpha_public_id,source_instance_id,application_id,history_epoch_id FROM active_mapping_rows WHERE active=1;`
      .replace(/\s*\n\s*/g, " "));
    expect(await db.prepare("SELECT type FROM sqlite_master WHERE name='project_alpha_active_directory_mappings'").first("type")).toBe("view");
    expect(await hasClientHubActiveDirectoryMappings(db)).toBe(true);
    await db.batch([
      db.prepare("INSERT INTO operations_directory_records VALUES('ops-org','organization'),('ops-duplicate','organization'),('ops-inactive','organization')"),
      db.prepare("INSERT INTO pa_organizations VALUES('pa-v2-org','Acquired business',1,?,'project-alpha:primary')")
        .bind(JSON.stringify({ public_id: publicId })),
      db.prepare(`INSERT INTO active_mapping_rows VALUES
        ('project-alpha:primary','organization','ops-org','pa-v2-org',?,?,?,?,1),
        ('project-alpha:primary','organization','ops-org','pa-v2-org',?,?,?,?,1),
        ('project-alpha:primary','organization','ops-inactive','pa-inactive',?,?,?,?,0)`).bind(
          publicId, identity.sourceInstanceId, identity.applicationId, identity.historyEpoch,
          publicId, identity.sourceInstanceId, identity.applicationId, "00000000-0000-4000-8000-000000000004",
          "1".repeat(32), identity.sourceInstanceId, identity.applicationId, identity.historyEpoch),
    ]);
    const env = configuredEnv(db);
    expect(await resolveClientHubSourceRoot(env, "organization", "ops-org"))
      .toMatchObject({ id: "ops-org", pa_internal_id: "pa-v2-org", display_name: "Acquired business", pa_public_id: publicId, mapping_status: "mapped" });
    expect(await resolveClientHubSourceRootByAlphaIdentity(env, "organization", "pa-v2-org", "project-alpha:primary", publicId))
      .toMatchObject({ id: "ops-org", pa_internal_id: "pa-v2-org", pa_public_id: publicId });
    expect(await resolveClientHubSourceRootByAlphaIdentity(env, "organization", "pa-v2-org", "project-alpha:primary", "1".repeat(32)))
      .toBeNull();
    expect(await resolveClientHubSourceRoot(env, "organization", "pa-v2-org")).toBeNull();
    await db.prepare(`INSERT INTO active_mapping_rows VALUES
      ('project-alpha:primary','organization','ops-duplicate','pa-v2-org',?,?,?,?,1)`)
      .bind(publicId, identity.sourceInstanceId, identity.applicationId, identity.historyEpoch).run();
    expect(await resolveClientHubSourceRoot(env, "organization", "ops-org")).toBeNull();
    expect(await resolveClientHubSourceRootByAlphaIdentity(env, "organization", "pa-v2-org", "project-alpha:primary", publicId))
      .toBeNull();
  }, 30_000);
});
