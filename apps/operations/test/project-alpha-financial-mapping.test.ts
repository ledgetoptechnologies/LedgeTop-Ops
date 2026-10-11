import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { resolveTrustedNativeFinancialMapping } from "../src/worker/project-alpha-financial-mapping";

const source = "project-alpha:one", source2 = "project-alpha:two";
const instance = "11111111-1111-4111-8111-111111111111", application = "22222222-2222-4222-8222-222222222222", epoch = "33333333-3333-4333-8333-333333333333";
const instance2 = "44444444-4444-4444-8444-444444444444", application2 = "55555555-5555-4555-8555-555555555555", epoch2 = "66666666-6666-4666-8666-666666666666";
const env = { PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
  [source]: { sourceId: source, enabled: true, baseUrl: "https://pa-one.example.test", apiKey: "one", sourceInstanceId: instance, applicationId: application, historyEpoch: epoch },
  [source2]: { sourceId: source2, enabled: true, baseUrl: "https://pa-two.example.test", apiKey: "two", sourceInstanceId: instance2, applicationId: application2, historyEpoch: epoch2 },
} }) };
let runtime: Miniflare, db: D1Database;
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  const schema = `
    CREATE TABLE operations_directory_records(record_id TEXT,record_kind TEXT,current_version INTEGER);
    CREATE TABLE operations_directory_revisions(record_id TEXT,version INTEGER,profile_json TEXT);
    CREATE TABLE project_alpha_active_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,mapping_kind TEXT,provenance_id TEXT);
    CREATE TABLE project_alpha_api_v2_inventory_receipts(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      inventory_kind TEXT,request_id TEXT,authorization_generation TEXT);
    CREATE TABLE project_alpha_api_v2_directory_observations_current(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      request_id TEXT,resource_type TEXT,project_alpha_public_id TEXT,resource_revision TEXT,projection_sha256 TEXT,present INTEGER,last_action TEXT,
      binding_external_id TEXT,binding_status TEXT,binding_resource_revision TEXT,has_conflict INTEGER);
    CREATE TABLE project_alpha_api_v2_project_observations_current(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      request_id TEXT,external_project_id TEXT,project_alpha_public_id TEXT,resource_revision TEXT,projection_sha256 TEXT,archived INTEGER,has_conflict INTEGER);
    CREATE TABLE project_alpha_api_v2_inventory_conflicts(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      inventory_kind TEXT,resource_type TEXT,project_alpha_public_id TEXT,external_id TEXT);
    CREATE TABLE project_alpha_project_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      external_project_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE operations_shared_projects(external_project_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      project_alpha_public_id TEXT,pa_revision TEXT,current_version INTEGER,canonical_projection_sha256 TEXT,archived INTEGER);
    CREATE TABLE operations_shared_project_revisions(external_project_id TEXT,version INTEGER,read_json TEXT,inbound_resolution_id TEXT);
    CREATE TABLE project_alpha_project_v2_canonical_activation_receipts(external_project_id TEXT,resulting_local_version INTEGER);
    CREATE TABLE project_alpha_project_inbound_resolution_receipts(resolution_id TEXT,decision TEXT,prior_local_version INTEGER,resulting_local_version INTEGER);
  `;
  await db.batch(schema.split(";").map(statement => statement.trim()).filter(Boolean).map(statement => db.prepare(statement)));
});
afterAll(() => runtime.dispose());
beforeEach(async () => {
  for (const name of ["operations_directory_records","operations_directory_revisions","project_alpha_active_directory_mappings",
    "project_alpha_api_v2_inventory_receipts","project_alpha_api_v2_directory_observations_current","project_alpha_api_v2_project_observations_current",
    "project_alpha_api_v2_inventory_conflicts","project_alpha_project_mappings","operations_shared_projects","operations_shared_project_revisions",
    "project_alpha_project_v2_canonical_activation_receipts","project_alpha_project_inbound_resolution_receipts"]) await db.prepare(`DELETE FROM ${name}`).run();
});
async function directory(kind: "organization" | "client", recordId: string, options: { sourceId?: string; acquired?: boolean; present?: number; publicId?: string } = {}) {
  const sourceId = options.sourceId ?? source, tuple = sourceId === source ? [instance, application, epoch] : [instance2, application2, epoch2];
  const publicId = options.publicId ?? (kind === "organization" ? "a" : "b").repeat(32), requestId = crypto.randomUUID(), externalId = `pa-${recordId}`;
  await db.batch([
    db.prepare("INSERT INTO operations_directory_records VALUES(?,?,1)").bind(recordId, kind),
    db.prepare("INSERT INTO operations_directory_revisions VALUES(?,1,?)").bind(recordId, JSON.stringify({ name: recordId })),
    db.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES(?,?,?,?,?,?,?,?,?,?)").bind(sourceId,...tuple,kind,recordId,externalId,publicId,options.acquired ? "acquired" : "legacy",crypto.randomUUID()),
    db.prepare("INSERT INTO project_alpha_api_v2_inventory_receipts VALUES(?,?,?,?, 'directory',?,?)").bind(sourceId,...tuple,requestId,"59"),
    db.prepare("INSERT INTO project_alpha_api_v2_directory_observations_current VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'active',?,0)")
      .bind(sourceId,...tuple,requestId,kind,publicId,"3","c".repeat(64),options.present ?? 1,"upsert",externalId,"3"),
  ]);
}
async function project(externalId = "project-1") {
  const publicId = "d".repeat(32), requestId = crypto.randomUUID(), hash = "e".repeat(64);
  await db.batch([
    db.prepare("INSERT INTO project_alpha_project_mappings VALUES(?,?,?,?,?,?)").bind(source,instance,application,epoch,externalId,publicId),
    db.prepare("INSERT INTO operations_shared_projects VALUES(?,?,?,?,?,?, '7',1,?,0)").bind(externalId,source,instance,application,epoch,publicId,hash),
    db.prepare("INSERT INTO operations_shared_project_revisions VALUES(?,1,?,NULL)").bind(externalId,JSON.stringify({ resource: { id: publicId, revision: "7", projectionSha256: hash } })),
    db.prepare("INSERT INTO project_alpha_project_v2_canonical_activation_receipts VALUES(?,1)").bind(externalId),
    db.prepare("INSERT INTO project_alpha_api_v2_inventory_receipts VALUES(?,?,?,?, 'project',?,'60')").bind(source,instance,application,epoch,requestId),
    db.prepare("INSERT INTO project_alpha_api_v2_project_observations_current VALUES(?,?,?,?,?,?,?,?,?,0,0)").bind(source,instance,application,epoch,requestId,externalId,publicId,"7",hash),
  ]);
}

describe("trusted native financial mapping resolver", () => {
  it("resolves organization, acquired client, and canonical project evidence", async () => {
    await directory("organization","org-1"); await directory("client","client-1",{ acquired:true }); await project();
    expect(await resolveTrustedNativeFinancialMapping({ OPS_DB:db,...env } as never,{kind:"organization",recordId:"org-1",sourceId:source}))
      .toMatchObject({kind:"organization",externalId:"pa-org-1",revision:"3",authorizationGeneration:"60"});
    expect(await resolveTrustedNativeFinancialMapping({ OPS_DB:db,...env } as never,{kind:"client",recordId:"client-1",sourceId:source}))
      .toMatchObject({kind:"client",externalId:"pa-client-1",revision:"3",authorizationGeneration:"60"});
    expect(await resolveTrustedNativeFinancialMapping({ OPS_DB:db,...env } as never,{kind:"project",externalProjectId:"project-1",sourceId:source}))
      .toMatchObject({kind:"project",externalId:"project-1",revision:"7",authorizationGeneration:"60"});
    await db.prepare("UPDATE project_alpha_api_v2_directory_observations_current SET binding_external_id='wrong-acquired-id' WHERE project_alpha_public_id=?")
      .bind("b".repeat(32)).run();
    expect(await resolveTrustedNativeFinancialMapping({ OPS_DB:db,...env } as never,{kind:"client",recordId:"client-1",sourceId:source})).toBeNull();
  });
  it("accepts an exact current inbound project head anchored to its prior activation", async () => {
    await project("inbound-project"); const hash = "f".repeat(64), resolution = crypto.randomUUID();
    await db.batch([
      db.prepare("UPDATE operations_shared_projects SET pa_revision='8',current_version=2,canonical_projection_sha256=? WHERE external_project_id='inbound-project'").bind(hash),
      db.prepare("INSERT INTO operations_shared_project_revisions VALUES('inbound-project',2,?,?)")
        .bind(JSON.stringify({resource:{id:"d".repeat(32),revision:"8",projectionSha256:hash}}),resolution),
      db.prepare("INSERT INTO project_alpha_project_inbound_resolution_receipts VALUES(?,'accept_project_alpha',1,2)").bind(resolution),
      db.prepare("UPDATE project_alpha_api_v2_project_observations_current SET resource_revision='8',projection_sha256=? WHERE external_project_id='inbound-project'").bind(hash),
    ]);
    expect(await resolveTrustedNativeFinancialMapping({OPS_DB:db,...env} as never,{kind:"project",externalProjectId:"inbound-project",sourceId:source}))
      .toMatchObject({kind:"project",revision:"8",projectionSha256:hash});
  });
  it("denies inactive, stale, mismatched, and ambiguous evidence", async () => {
    await directory("organization","inactive",{present:0});
    expect(await resolveTrustedNativeFinancialMapping({OPS_DB:db,...env} as never,{kind:"organization",recordId:"inactive",sourceId:source})).toBeNull();
    await directory("client","ambiguous"); await directory("client","ambiguous",{sourceId:source2,publicId:"f".repeat(32)});
    expect(await resolveTrustedNativeFinancialMapping({OPS_DB:db,...env} as never,{kind:"client",recordId:"ambiguous"})).toBeNull();
    await db.prepare("UPDATE project_alpha_api_v2_directory_observations_current SET binding_external_id='wrong' WHERE project_alpha_public_id=?").bind("b".repeat(32)).run();
    expect(await resolveTrustedNativeFinancialMapping({OPS_DB:db,...env} as never,{kind:"client",recordId:"ambiguous",sourceId:source})).toBeNull();
    await project("stale-project"); await db.prepare("UPDATE operations_shared_projects SET canonical_projection_sha256=? WHERE external_project_id='stale-project'").bind("9".repeat(64)).run();
    expect(await resolveTrustedNativeFinancialMapping({OPS_DB:db,...env} as never,{kind:"project",externalProjectId:"stale-project",sourceId:source})).toBeNull();
  });
  it("denies a disabled or identity-drifted configured source", async () => {
    await directory("organization","org-1");
    const disabled = { PROJECT_ALPHA_API_V2_CONNECTIONS: env.PROJECT_ALPHA_API_V2_CONNECTIONS.replace('"enabled":true','"enabled":false') };
    expect(await resolveTrustedNativeFinancialMapping({OPS_DB:db,...disabled} as never,{kind:"organization",recordId:"org-1",sourceId:source})).toBeNull();
    const drifted = { PROJECT_ALPHA_API_V2_CONNECTIONS: env.PROJECT_ALPHA_API_V2_CONNECTIONS.replace(instance,"77777777-7777-4777-8777-777777777777") };
    expect(await resolveTrustedNativeFinancialMapping({OPS_DB:db,...drifted} as never,{kind:"organization",recordId:"org-1",sourceId:source})).toBeNull();
  });
});
