import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import { projectAlphaNativeMappingReadVisibleSql, projectAlphaReadVisibleSql,
  requireProjectAlphaReadOrNativeMappingVisibility, requireProjectAlphaReadVisibility } from "../src/worker/project-alpha-read-visibility";
import { paCalendarFilter, paProjectFilter, paResourceFilter } from "../src/worker/visibility";
import type { StaffPrincipal } from "../src/worker/types";
import { applyConnectorSchema, registerVisibleTestSource } from "./helpers/project-alpha-connectors";

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

describe("registered business read visibility", () => {
  it("applies the same primary-compatible, fail-closed source predicate to broad project, operation, task and calendar reads", async () => {
    runtime = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    const db = await runtime.getD1Database("OPS_DB") as D1Database;
    await db.exec("CREATE TABLE records(id TEXT PRIMARY KEY,active INTEGER,projection_source_id TEXT); INSERT INTO records VALUES('a',1,'project-alpha:primary'),('b',1,'project-alpha:secondary'),('c',0,'project-alpha:secondary');");
    const env = { OPS_DB: db };
    await expect(requireProjectAlphaReadVisibility(env, "project-alpha:primary")).rejects.toThrow();
    await applyConnectorSchema(db);
    await expect(requireProjectAlphaReadOrNativeMappingVisibility(env, "project-alpha:primary", "legacy", "organization"))
      .resolves.toMatchObject({ visible: 1 });
    const scope = { global: true, divisions: [], assigned: false, own: false, deniedDivisions: [], deniedGlobal: false };
    const actor = { id: "staff", projectAlphaUserId: "1" } as StaffPrincipal;
    const filters = [paProjectFilter(scope, actor, true), paProjectFilter(scope, actor, false, true),
      paResourceFilter(scope, actor, true, "p", "operation"), paResourceFilter(scope, actor, false, "p", "task", true),
      paCalendarFilter(scope, actor, true, "p"), paCalendarFilter(scope, actor, false, "p", true)];
    const selected = async (filter: typeof filters[number]) => (await db.prepare(`SELECT p.id FROM records p WHERE ${filter.sql} ORDER BY p.id`).bind(...filter.values).all<{ id: string }>()).results;
    for (const filter of filters) expect(await selected(filter)).toEqual([{ id: "a" }]);
    await expect(requireProjectAlphaReadVisibility(env, "project-alpha:secondary")).rejects.toMatchObject({ status: 404 });
    await registerVisibleTestSource(db, "project-alpha:secondary", "Business B");
    for (const filter of filters) expect(await selected(filter)).toEqual([{ id: "a" }, { id: "b" }]);
    await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE source_id='project-alpha:secondary'").run();
    for (const filter of filters) expect(await selected(filter)).toEqual([{ id: "a" }, { id: "b" }]);
    expect(await requireProjectAlphaReadVisibility(env, "project-alpha:secondary")).toMatchObject({ visible: 1, display_name: "Business B" });
    await db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id='project-alpha:secondary'").run();
    for (const filter of filters) expect(await selected(filter)).toEqual([{ id: "a" }]);
    await registerVisibleTestSource(db, "project-alpha:primary", "Primary company");
    expect(await requireProjectAlphaReadVisibility(env, "project-alpha:primary")).toMatchObject({ visible: 1, display_name: "Primary company" });
    await expect(db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id='project-alpha:primary'").run()).rejects.toThrow();
    expect(await requireProjectAlphaReadVisibility(env, "delivery:local")).toMatchObject({ visible: 1, display_name: "Local delivery" });
  }, 30_000);

  it("rejects SQL expressions instead of interpolating a caller-provided source expression", () => {
    for (const value of ["p.source_id OR 1=1", "p.source_id;DROP TABLE records", "p.source_id--", "p.source_id)", "p..source_id"])
      expect(() => projectAlphaReadVisibleSql(value)).toThrow("invalid-project-alpha-source-column");
    expect(projectAlphaReadVisibleSql("p.projection_source_id")).toContain("visible_connector.source_id=p.projection_source_id");
  });

  it("admits only an exact enabled native mapping when no connector exists and lets an explicit connector denial win", async () => {
    runtime = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    const db = await runtime.getD1Database("OPS_DB") as D1Database;
    await applyConnectorSchema(db);
    await db.batch([
      db.prepare("CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT,current_version INTEGER)"),
      db.prepare("CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT)"),
      db.prepare(`CREATE TABLE project_alpha_active_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
        resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,mapping_kind TEXT,provenance_id TEXT)`),
      db.prepare("INSERT INTO operations_directory_records VALUES('record-one','client',1)"),
      db.prepare("INSERT INTO operations_directory_client_organizations VALUES('record-one',NULL)"),
      db.prepare(`INSERT INTO project_alpha_active_directory_mappings VALUES('project-alpha:staging','11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333','client','record-one','external-one',
        '0123456789abcdef0123456789abcdef','acquired','activation-one')`),
    ]);
    const connection = (enabled: boolean, historyEpoch = "33333333-3333-4333-8333-333333333333") => JSON.stringify({ version: 1, instances: {
      "project-alpha:staging": { sourceId: "project-alpha:staging", enabled, baseUrl: "https://pa.example.test", apiKey: "a".repeat(32),
        sourceInstanceId: "11111111-1111-4111-8111-111111111111", applicationId: "22222222-2222-4222-8222-222222222222", historyEpoch },
    } });
    const env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: connection(true) };
    await expect(requireProjectAlphaReadVisibility(env, "project-alpha:staging")).rejects.toMatchObject({ status: 404 });
    await expect(requireProjectAlphaReadOrNativeMappingVisibility(env, "project-alpha:staging", "record-one", "standalone_client"))
      .resolves.toMatchObject({ visible: 1, display_name: "project-alpha:staging" });
    const firstProof = await requireProjectAlphaReadOrNativeMappingVisibility(env, "project-alpha:staging", "record-one", "standalone_client");
    await db.prepare("UPDATE operations_directory_records SET current_version=2 WHERE record_id='record-one'").run();
    const changedProof = await requireProjectAlphaReadOrNativeMappingVisibility(env, "project-alpha:staging", "record-one", "standalone_client");
    const originalNativeProof = "nativeProof" in firstProof ? firstProof.nativeProof : null;
    const updatedNativeProof = "nativeProof" in changedProof ? changedProof.nativeProof : null;
    expect(originalNativeProof).not.toEqual(updatedNativeProof);
    await db.prepare("UPDATE operations_directory_records SET current_version=1 WHERE record_id='record-one'").run();
    for (const invalid of [connection(false), connection(true, "44444444-4444-4444-8444-444444444444"),
      connection(true).replace("11111111-1111-4111-8111-111111111111", "55555555-5555-4555-8555-555555555555"),
      connection(true).replace("22222222-2222-4222-8222-222222222222", "66666666-6666-4666-8666-666666666666"), "{}", undefined])
      await expect(requireProjectAlphaReadOrNativeMappingVisibility({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: invalid },
        "project-alpha:staging", "record-one", "standalone_client")).rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE project_alpha_active_directory_mappings SET source_id='project-alpha:primary'").run();
    await expect(requireProjectAlphaReadVisibility({ OPS_DB: db }, "project-alpha:primary")).resolves.toMatchObject({ visible: 1 });
    await expect(requireProjectAlphaReadOrNativeMappingVisibility({ OPS_DB: db }, "project-alpha:primary", "record-one", "standalone_client"))
      .rejects.toMatchObject({ status: 404 });
    const primaryEnabled = connection(true).replaceAll("project-alpha:staging", "project-alpha:primary");
    await expect(requireProjectAlphaReadOrNativeMappingVisibility({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: primaryEnabled },
      "project-alpha:primary", "record-one", "standalone_client")).resolves.toMatchObject({ nativeProof: { sourceId: "project-alpha:primary" } });
    await db.prepare("UPDATE project_alpha_active_directory_mappings SET source_id='project-alpha:staging'").run();
    await db.prepare(`INSERT INTO project_alpha_active_directory_mappings SELECT source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,record_id,'duplicate-external',project_alpha_public_id,mapping_kind,'activation-two'
      FROM project_alpha_active_directory_mappings`).run();
    await expect(requireProjectAlphaReadOrNativeMappingVisibility(env, "project-alpha:staging", "record-one", "standalone_client"))
      .rejects.toMatchObject({ status: 404 });
    await db.prepare("DELETE FROM project_alpha_active_directory_mappings WHERE external_id='duplicate-external'").run();
    await db.prepare("UPDATE operations_directory_client_organizations SET organization_record_id='parent' WHERE client_record_id='record-one'").run();
    await expect(requireProjectAlphaReadOrNativeMappingVisibility(env, "project-alpha:staging", "record-one", "standalone_client"))
      .rejects.toMatchObject({ status: 404 });
    await db.prepare("UPDATE operations_directory_client_organizations SET organization_record_id=NULL WHERE client_record_id='record-one'").run();
    await expect(requireProjectAlphaReadOrNativeMappingVisibility(env, "project-alpha:staging", "record-one", "organization"))
      .rejects.toMatchObject({ status: 404 });
    const savedMapping = await db.prepare("SELECT * FROM project_alpha_active_directory_mappings WHERE record_id='record-one'").first<Record<string, unknown>>();
    await db.prepare("DELETE FROM project_alpha_active_directory_mappings").run();
    await expect(requireProjectAlphaReadOrNativeMappingVisibility(env, "project-alpha:staging", "record-one", "standalone_client"))
      .rejects.toMatchObject({ status: 404 });
    await db.prepare(`INSERT INTO project_alpha_active_directory_mappings(source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,record_id,external_id,project_alpha_public_id,mapping_kind,provenance_id) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(savedMapping!.source_id, savedMapping!.source_instance_id, savedMapping!.application_id, savedMapping!.history_epoch_id,
        savedMapping!.resource_type, savedMapping!.record_id, savedMapping!.external_id, savedMapping!.project_alpha_public_id,
        savedMapping!.mapping_kind, savedMapping!.provenance_id).run();
    await registerVisibleTestSource(db, "project-alpha:staging", "Hidden staging");
    await db.prepare("UPDATE pa_connectors SET state='suspended',version=version+1 WHERE source_id='project-alpha:staging'").run();
    await db.prepare("UPDATE pa_connectors SET read_visible=0,version=version+1 WHERE source_id='project-alpha:staging'").run();
    await expect(requireProjectAlphaReadOrNativeMappingVisibility(env, "project-alpha:staging", "record-one", "standalone_client"))
      .rejects.toMatchObject({ status: 404 });

  }, 30_000);

  it("scopes native SQL visibility behind connector absence and exact deployment identity", () => {
    const sql = projectAlphaNativeMappingReadVisibleSql("mapping.source_id", "mapping", [{ sourceId: "project-alpha:staging",
      sourceInstanceId: "11111111-1111-4111-8111-111111111111", applicationId: "22222222-2222-4222-8222-222222222222",
      historyEpochId: "33333333-3333-4333-8333-333333333333" }]);
    expect(sql).toContain("NOT EXISTS");
    expect(sql).not.toContain("project-alpha:primary') AND NOT EXISTS");
    expect(sql).toContain("native_visibility_connector.source_id=mapping.source_id");
    expect(sql).toContain("mapping.history_epoch_id='33333333-3333-4333-8333-333333333333'");
    expect(() => projectAlphaNativeMappingReadVisibleSql("mapping.source_id", "mapping", [{ sourceId: "project-alpha:bad'",
      sourceInstanceId: "11111111-1111-4111-8111-111111111111", applicationId: "22222222-2222-4222-8222-222222222222",
      historyEpochId: "33333333-3333-4333-8333-333333333333" }])).toThrow("invalid-project-alpha-native-identity");
  });

  it("fails closed when the native mapping relation exists with an incomplete schema", async () => {
    runtime = new Miniflare({ modules: true, script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    const db = await runtime.getD1Database("OPS_DB") as D1Database;
    await applyConnectorSchema(db);
    await db.prepare("CREATE TABLE project_alpha_active_directory_mappings(source_id TEXT,record_id TEXT)").run();
    await expect(requireProjectAlphaReadOrNativeMappingVisibility({ OPS_DB: db }, "project-alpha:primary", "record", "organization"))
      .rejects.toMatchObject({ status: 503 });
  });
});
