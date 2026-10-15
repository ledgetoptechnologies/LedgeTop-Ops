import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { unstable_splitSqlQuery } from "wrangler";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";

// This helper applies the complete ordered Operations migration chain while
// preserving the historical fixture state required by later migrations.
// @ts-expect-error The reviewed full-schema fixture is an ESM test helper.
import { migrateProjectOrganizationFullSchema } from "../../../scripts/staging-project-organization-fullschema-migrations.mjs";
// @ts-expect-error The reviewed fixture constants are JavaScript exports.
import { RELATIONSHIP_RECOVERY_AUTHORITY_TARGET_V2 as target } from "../../../scripts/staging-relationship-generation-recovery-authority-v184.mjs";
import { resolveTrustedNativeFinancialMapping } from "../src/worker/project-alpha-financial-mapping";
import { planProjectAlphaProjectV2Command, type ProjectAlphaProjectV2CommandProducerAction } from
  "../src/worker/project-alpha-project-v2-command-producer";
import { dispatchProjectAlphaProjectV2PendingCommand } from "../src/worker/project-alpha-project-v2-pending-dispatcher";
import { settleProjectAlphaProjectV2Read } from "../src/worker/project-alpha-project-read-settlement-adapter";
import { activateProjectAlphaProjectV2Canonical } from "../src/worker/project-alpha-project-canonical-activation-adapter";

let runtime: Miniflare, db: D1Database;
const projectExternalId = "ops/project-acceptance-20261008-portal-1";
const projectPublicId = "9".repeat(32), projectHash = "8".repeat(64);
const configuration = () => JSON.stringify({ version: 1, instances: { [target.sourceId]: {
  sourceId: target.sourceId, enabled: true, baseUrl: target.destinationOrigin, apiKey: "fixture-secret",
  sourceInstanceId: target.sourceInstanceId, applicationId: target.applicationId, historyEpoch: target.historyEpochId,
} } });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: {
  "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
  "X-Request-ID": body && typeof body === "object" && "requestId" in body && typeof body.requestId === "string"
    ? body.requestId : randomUUID(),
} });

async function observeDirectory(kind: "organization" | "client", recordId: string, publicId: string, revision: string,
  generation = "60", bindingRevision = revision, hash = "b".repeat(64)) {
  const requestId = randomUUID(), externalId = recordId;
  await db.batch([
    db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,
      history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count)
      VALUES(?,?,?,?,'directory',?,?,?,1)`).bind(target.sourceId,target.sourceInstanceId,target.applicationId,target.historyEpochId,requestId,generation,"a".repeat(64)),
    db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,
      history_epoch_id,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,
      projection_sha256,binding_external_id,binding_status,binding_resource_revision)
      VALUES(?,?,?,?,?,?,?, ?,1,'upsert',?,?,'active',?)`).bind(target.sourceId,target.sourceInstanceId,target.applicationId,
        target.historyEpochId,requestId,kind,publicId,revision,hash,externalId,bindingRevision),
  ]);
  return requestId;
}

async function inventoryReceipt(kind: "directory" | "project", generation: string) {
  const requestId = randomUUID();
  await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,
    history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count)
    VALUES(?,?,?,?,?,?,?,?,0)`).bind(target.sourceId,target.sourceInstanceId,target.applicationId,target.historyEpochId,
      kind,requestId,generation,"a".repeat(64)).run();
  return requestId;
}

async function finishHistoricalMigrations() {
  const directory = new URL("../migrations/", import.meta.url);
  await db.prepare("PRAGMA foreign_keys=OFF").run();
  for (const name of readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0,4) > "0161").sort()) {
    const statements = unstable_splitSqlQuery(readFileSync(new URL(name,directory),"utf8").replace(/\r\n/g,"\n"))
      .map(sql => sql.trim()).filter(sql => sql && !/^PRAGMA\s+foreign_keys\s*=\s*ON/i.test(sql));
    await db.batch([...statements.map(sql => db.prepare(sql)),db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
  }
  await db.prepare("PRAGMA foreign_keys=ON").run();
}

async function historicalFixture(run: () => Promise<void>) {
  const previous = db;
  const isolated = new Miniflare({modules:true,compatibilityDate:"2026-08-06",
    script:"export default {fetch(){return new Response('ok')}}",d1Databases:{OPS_DB:`financial-historical-${randomUUID()}`}});
  try {
    db = await isolated.getD1Database("OPS_DB") as unknown as D1Database;
    await migrateProjectOrganizationFullSchema(db,"0161");
    await run();
  } finally { db = previous; await isolated.dispose(); }
}

async function appendDirectoryObservation(kind: "organization"|"client", publicId: string, revision: string,
  options: { present: boolean; bindingRevision?: string } ) {
  const requestId=randomUUID(), present=options.present?1:0;
  await db.batch([
    db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,
      history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count)
      VALUES(?,?,?,?,'directory',?,'62',?,1)`).bind(target.sourceId,target.sourceInstanceId,target.applicationId,
        target.historyEpochId,requestId,"d".repeat(64)),
    db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,
      history_epoch_id,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,
      projection_sha256,binding_external_id,binding_status,binding_resource_revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?, ?,?,?)`).bind(target.sourceId,target.sourceInstanceId,target.applicationId,
        target.historyEpochId,requestId,kind,publicId,revision,present,present?"upsert":"delete","e".repeat(64),
        kind==="organization"?target.organizationRecordId:target.clientRecordId,present?"active":"tombstoned",
        options.bindingRevision??revision),
  ]);
}

async function appendProjectObservation(revision:string,hash:string) {
  const requestId=randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,
      history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count)
      VALUES(?,?,?,?,'project',?,'63',?,1)`).bind(target.sourceId,target.sourceInstanceId,target.applicationId,
        target.historyEpochId,requestId,"f".repeat(64)),
    db.prepare(`INSERT INTO project_alpha_api_v2_project_observations(source_id,source_instance_id,application_id,
      history_epoch_id,request_id,external_project_id,project_alpha_public_id,resource_revision,projection_sha256,lifecycle_status,archived)
      VALUES(?,?,?,?,?,?,?,?,?,'active',0)`).bind(target.sourceId,target.sourceInstanceId,target.applicationId,
        target.historyEpochId,requestId,projectExternalId,projectPublicId,revision,hash),
  ]);
}

async function activateProject(expectedAuthorizationGeneration = "60") {
  const commandId = randomUUID(), requestId = randomUUID();
  const resultingAuthorizationGeneration = (BigInt(expectedAuthorizationGeneration) + 1n).toString();
  await db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,version,granted_by)
    VALUES(?,?,'project.shared.sync','allow','global',1,1,?)`).bind(randomUUID(),target.staffId,target.staffId).run();
  const actorRow = await db.prepare(`SELECT admission.bound_access_subject accessSubject,admission.version admissionVersion,
      profile.login_email email,profile.version profileVersion FROM native_staff_admissions admission
      JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id WHERE admission.staff_id=?`).bind(target.staffId)
    .first<{accessSubject:string;admissionVersion:number;email:string;profileVersion:number}>();
  if (!actorRow) throw new Error("missing full-schema actor");
  const command = { commandId, externalId: projectExternalId, expectedAuthorizationGeneration,
    project: { name: "Financial full-schema", description: null, estimatedStart: null, estimatedEnd: null },
    organization: { externalId: target.organizationRecordId, expectedPublicId: target.organizationPublicId,
      expectedRevision: "7", expectedProjectionSha256: "b".repeat(64) }, client: null } as const;
  const action: Extract<ProjectAlphaProjectV2CommandProducerAction,{operation:"create"}> = { sourceId: target.sourceId,
    actor: { staffId: target.staffId, accessSubject: actorRow.accessSubject, email: actorRow.email,
      admissionVersion: actorRow.admissionVersion, profileVersion: actorRow.profileVersion,
      verifiedUntil: new Date(Date.now()+3_600_000).toISOString(), scopes: [] }, operation: "create", command,
    directory: { organizationRecordId: target.organizationRecordId, clientRecordId: null },
    local: { expectedLocalVersion: 0, expectedLocalProjectionSha256: null } };
  const env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: configuration() };
  expect(await planProjectAlphaProjectV2Command(env,action)).toMatchObject({status:"queued"});
  const capabilities = (capability:string) => ({apiVersion:"2",sourceInstanceId:target.sourceInstanceId,
    applicationId:target.applicationId,historyEpoch:target.historyEpochId,requestId,
    grantedCapabilities:["api.capabilities.read",capability].map(name=>({name})),implementedEndpoints:[
      {method:"GET",path:"/api/v2/capabilities",requiredCapability:"api.capabilities.read"},
      {method:capability==="projects.create"?"POST":"GET",path:capability==="projects.create"?"/api/v2/projects/commands":"/api/v2/projects/{publicId}",requiredCapability:capability,requiresSourceInstanceId:true,requiresApplicationId:true,requiresHistoryEpoch:true}]});
  const dispatched = await dispatchProjectAlphaProjectV2PendingCommand(env,target.sourceId,commandId,vi.fn(async (_input,init) =>
    init?.method!=="POST" ? response(capabilities("projects.create")) : response({apiVersion:"2",sourceInstanceId:target.sourceInstanceId,
      applicationId:target.applicationId,historyEpoch:target.historyEpochId,requestId,replayed:false,result:{resource:{type:"project",
        id:projectExternalId,publicId:projectPublicId,revision:"1",projectionSha256:projectHash},authorizationGeneration:resultingAuthorizationGeneration,
        presentation:{portalPublished:false,publicLinkEnabled:false}}},201)));
  if (dispatched.status!=="acknowledged") throw new Error(`dispatch failed: ${JSON.stringify(dispatched)}`);
  const settled = await settleProjectAlphaProjectV2Read({OPS_DB:db},dispatched.receiptId,{baseUrl:target.destinationOrigin,
    apiKey:"fixture-secret",expectedSourceInstanceId:target.sourceInstanceId,expectedApplicationId:target.applicationId,
    expectedHistoryEpoch:target.historyEpochId},vi.fn(async input => String(input).endsWith("/capabilities")
      ? response(capabilities("projects.v2.read")) : response({apiVersion:"2",sourceInstanceId:target.sourceInstanceId,
        applicationId:target.applicationId,historyEpoch:target.historyEpochId,requestId,replayed:false,accepted:true,
        resource:{type:"project",id:projectPublicId,revision:"1",projectionSha256:projectHash},data:{name:"Financial full-schema",
          description:null,status:"active",archived:true,overdueWarning:false,completedAt:null,archivedAt:"2026-10-10T00:00:00.000Z",
          estimatedStart:null,estimatedEnd:null,clientPublicId:null,organizationPublicId:target.organizationPublicId}})));
  if (settled.status!=="settled") throw new Error(`settlement failed: ${JSON.stringify(settled)}`);
  expect(await activateProjectAlphaProjectV2Canonical({OPS_DB:db},settled.settlementId)).toMatchObject({status:"activated"});
  await db.batch([
    db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,
      inventory_kind,request_id,authorization_generation,page_sha256,item_count) VALUES(?,?,?,?,'project',?,?,?,1)`)
      .bind(target.sourceId,target.sourceInstanceId,target.applicationId,target.historyEpochId,requestId,resultingAuthorizationGeneration,"c".repeat(64)),
    db.prepare(`INSERT INTO project_alpha_api_v2_project_observations(source_id,source_instance_id,application_id,history_epoch_id,
      request_id,external_project_id,project_alpha_public_id,resource_revision,projection_sha256,lifecycle_status,archived)
      VALUES(?,?,?,?,?,?,?,'1',?,'active',1)`).bind(target.sourceId,target.sourceInstanceId,target.applicationId,target.historyEpochId,
        requestId,projectExternalId,projectPublicId,projectHash),
  ]);
}

beforeAll(async()=>{
  runtime=new Miniflare({modules:true,compatibilityDate:"2026-08-06",script:"export default {fetch(){return new Response('ok')}}",
    d1Databases:{OPS_DB:`financial-fullschema-${randomUUID()}`}});
  db=await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  await migrateProjectOrganizationFullSchema(db);
},180_000);
afterAll(()=>runtime.dispose());

describe.sequential("trusted financial mapping against the complete migrated schema",()=>{
  it("resolves canonical organization, client, and genuinely activated project rows",async()=>{
    await observeDirectory("organization",target.organizationRecordId,target.organizationPublicId,"7");
    await observeDirectory("client",target.clientRecordId,target.clientPublicId,"7");
    await activateProject();
    const env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:configuration()};
    await expect(resolveTrustedNativeFinancialMapping(env,{kind:"organization",recordId:target.organizationRecordId,sourceId:target.sourceId}))
      .resolves.toMatchObject({kind:"organization",publicId:target.organizationPublicId,authorizationGeneration:"60"});
    await expect(resolveTrustedNativeFinancialMapping(env,{kind:"client",recordId:target.clientRecordId,sourceId:target.sourceId}))
      .resolves.toMatchObject({kind:"client",publicId:target.clientPublicId,authorizationGeneration:"60"});
    await expect(resolveTrustedNativeFinancialMapping(env,{kind:"project",externalProjectId:projectExternalId,sourceId:target.sourceId}))
      .resolves.toMatchObject({kind:"project",publicId:projectPublicId,revision:"1",authorizationGeneration:"61"});
    await expect(resolveTrustedNativeFinancialMapping(env,{kind:"project",externalProjectId:"bad\u0000project",sourceId:target.sourceId}))
      .resolves.toBeNull();
  },180_000);

  it("recovers actual 0161 binding-only conflict evidence after 0190 without hiding changed projections",async()=>{
    await historicalFixture(async () => {
      await observeDirectory("organization",target.organizationRecordId,target.organizationPublicId,"7","59","6");
      await observeDirectory("organization",target.organizationRecordId,target.organizationPublicId,"7","60");
      await observeDirectory("client",target.clientRecordId,target.clientPublicId,"7");
      expect(await db.prepare("SELECT count(*) count FROM project_alpha_api_v2_inventory_conflicts WHERE conflict_kind='revision_reuse_mismatch'")
        .first<number>("count")).toBeGreaterThan(0);
      await finishHistoricalMigrations();
      await activateProject();
      const env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:configuration()};
      const evidence = await db.prepare("SELECT * FROM project_alpha_api_v2_inventory_conflicts ORDER BY conflict_id").all();
      await expect(resolveTrustedNativeFinancialMapping(env,{kind:"organization",recordId:target.organizationRecordId}))
        .resolves.toMatchObject({authorizationGeneration:"60"});
      expect((await db.prepare("SELECT * FROM project_alpha_api_v2_inventory_conflicts ORDER BY conflict_id").all()).results)
        .toEqual(evidence.results);
      expect(await db.prepare("SELECT count(*) count FROM client_hub_native_project_effective_directory_conflicts WHERE conflict_kind='revision_reuse_mismatch'")
        .first<number>("count")).toBe(0);
      await observeDirectory("organization",target.organizationRecordId,target.organizationPublicId,"7","62","7","c".repeat(64));
      await expect(resolveTrustedNativeFinancialMapping(env,{kind:"organization",recordId:target.organizationRecordId})).resolves.toBeNull();
    });
  },180_000);

  it("recovers an actual pre-0165 cross-surface generation conflict but preserves genuine project regressions",async()=>{
    await historicalFixture(async () => {
      await observeDirectory("organization",target.organizationRecordId,target.organizationPublicId,"7");
      await observeDirectory("client",target.clientRecordId,target.clientPublicId,"7");
      const directoryRequest = await inventoryReceipt("directory","90");
      const projectRequest = await inventoryReceipt("project","61");
      expect(await db.prepare(`SELECT prior_reference FROM project_alpha_api_v2_inventory_conflicts
        WHERE request_id=? AND conflict_kind='authorization_generation_regressed'`).bind(projectRequest).first<string>("prior_reference"))
        .toBe(directoryRequest);
      await finishHistoricalMigrations();
      await activateProject("90");
      const env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:configuration()};
      const evidence = await db.prepare("SELECT * FROM project_alpha_api_v2_inventory_conflicts ORDER BY conflict_id").all();
      await expect(resolveTrustedNativeFinancialMapping(env,{kind:"project",externalProjectId:projectExternalId}))
        .resolves.toMatchObject({authorizationGeneration:"91"});
      expect((await db.prepare("SELECT * FROM project_alpha_api_v2_inventory_conflicts ORDER BY conflict_id").all()).results)
        .toEqual(evidence.results);
      await inventoryReceipt("directory","100");
      await expect(resolveTrustedNativeFinancialMapping(env,{kind:"project",externalProjectId:projectExternalId}))
        .resolves.toMatchObject({authorizationGeneration:"91"});
      await inventoryReceipt("project","100");
      await inventoryReceipt("project","92");
      await expect(resolveTrustedNativeFinancialMapping(env,{kind:"project",externalProjectId:projectExternalId})).resolves.toBeNull();
    });
  },180_000);

  it.each(["missing prior", "tampered details"] as const)("does not exempt directory revision reuse with %s",async(mode)=>{
    await historicalFixture(async () => {
      const prior = await observeDirectory("organization",target.organizationRecordId,target.organizationPublicId,"7","59","6");
      const observed = await observeDirectory("organization",target.organizationRecordId,target.organizationPublicId,"7");
      await observeDirectory("client",target.clientRecordId,target.clientPublicId,"7");
      await finishHistoricalMigrations();
      await activateProject();
      const env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:configuration()};
      await expect(resolveTrustedNativeFinancialMapping(env,{kind:"organization",recordId:target.organizationRecordId}))
        .resolves.toMatchObject({authorizationGeneration:"60"});
      // Adversarial INSERT only: do not remove guards or alter immutable evidence.
      // A distinct request provides a unique malformed conflict alongside the real historical one.
      const malformedRequest = mode === "missing prior" ? observed
        : await observeDirectory("organization",target.organizationRecordId,target.organizationPublicId,"7","61");
      await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(source_id,source_instance_id,application_id,
        history_epoch_id,inventory_kind,resource_type,project_alpha_public_id,external_id,request_id,prior_reference,
        conflict_kind,observed_revision,details_json) VALUES(?,?,?,?,'directory','organization',?,?,?,?,
        'revision_reuse_mismatch','7',?)`).bind(target.sourceId,target.sourceInstanceId,target.applicationId,target.historyEpochId,
          target.organizationPublicId,target.organizationRecordId,malformedRequest,mode === "missing prior" ? randomUUID() : prior,
          JSON.stringify({observedProjectionSha256:mode === "tampered details" ? "0".repeat(64) : "b".repeat(64),
            priorProjectionSha256:"b".repeat(64)})).run();
      await expect(resolveTrustedNativeFinancialMapping(env,{kind:"organization",recordId:target.organizationRecordId})).resolves.toBeNull();
    });
  },180_000);

  it.each(["missing prior", "tampered details"] as const)("does not exempt generation evidence with %s",async(mode)=>{
    await historicalFixture(async () => {
      await observeDirectory("organization",target.organizationRecordId,target.organizationPublicId,"7");
      await observeDirectory("client",target.clientRecordId,target.clientPublicId,"7");
      await inventoryReceipt("directory","90");
      await inventoryReceipt("project","61");
      await finishHistoricalMigrations();
      await activateProject("90");
      const env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:configuration()};
      await expect(resolveTrustedNativeFinancialMapping(env,{kind:"project",externalProjectId:projectExternalId}))
        .resolves.toMatchObject({authorizationGeneration:"91"});
      const prior = await inventoryReceipt("directory","100");
      const observed = await inventoryReceipt("project","91");
      await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(source_id,source_instance_id,application_id,
        history_epoch_id,inventory_kind,resource_type,request_id,prior_reference,conflict_kind,observed_revision,details_json)
        VALUES(?,?,?,?,'project','source',?,?,'authorization_generation_regressed','91',?)`)
        .bind(target.sourceId,target.sourceInstanceId,target.applicationId,target.historyEpochId,observed,
          mode === "missing prior" ? randomUUID() : prior,
          JSON.stringify({observedAuthorizationGeneration:"91",priorAuthorizationGeneration:mode === "tampered details" ? "101" : "100"})).run();
      await expect(resolveTrustedNativeFinancialMapping(env,{kind:"project",externalProjectId:projectExternalId})).resolves.toBeNull();
    });
  },180_000);

  it("fails closed on current tombstones, revision drift, missing/ambiguous identity, and configuration drift",async()=>{
    const env={OPS_DB:db,PROJECT_ALPHA_API_V2_CONNECTIONS:configuration()};
    await expect(resolveTrustedNativeFinancialMapping(env,{kind:"client",recordId:"missing-record",sourceId:target.sourceId}))
      .resolves.toBeNull();

    const disabled={...env,PROJECT_ALPHA_API_V2_CONNECTIONS:configuration().replace('"enabled":true','"enabled":false')};
    await expect(resolveTrustedNativeFinancialMapping(disabled,{kind:"client",recordId:target.clientRecordId,sourceId:target.sourceId}))
      .resolves.toBeNull();
    const identityDrift={...env,PROJECT_ALPHA_API_V2_CONNECTIONS:configuration().replace(target.sourceInstanceId,randomUUID())};
    await expect(resolveTrustedNativeFinancialMapping(identityDrift,{kind:"client",recordId:target.clientRecordId,sourceId:target.sourceId}))
      .resolves.toBeNull();
    await expect(resolveTrustedNativeFinancialMapping(env,{kind:"client",recordId:target.clientRecordId,sourceId:"project-alpha:other"}))
      .resolves.toBeNull();

    // Production uniqueness and immutable mapping guards reject a second tuple
    // instead of permitting an ambiguous active mapping to reach the resolver.
    await expect(db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
      project_alpha_public_id,source_instance_id,application_id,command_id,history_epoch_id)
      VALUES(?,'client',?,?,?,?,?,?,?)`).bind(target.sourceId,target.clientRecordId,"7".repeat(32),
        target.sourceInstanceId,target.applicationId,"untrusted-duplicate-command",target.historyEpochId).run()).rejects.toThrow();

    await appendDirectoryObservation("organization",target.organizationPublicId,"8",{present:false});
    await expect(resolveTrustedNativeFinancialMapping(env,{kind:"organization",recordId:target.organizationRecordId,sourceId:target.sourceId}))
      .resolves.toBeNull();
    await appendDirectoryObservation("client",target.clientPublicId,"8",{present:true,bindingRevision:"7"});
    await expect(resolveTrustedNativeFinancialMapping(env,{kind:"client",recordId:target.clientRecordId,sourceId:target.sourceId}))
      .resolves.toBeNull();
    // An unarchived observation cannot supersede an archived canonical head,
    // even when its revision and projection otherwise match exactly.
    await appendProjectObservation("1",projectHash);
    await expect(resolveTrustedNativeFinancialMapping(env,{kind:"project",externalProjectId:projectExternalId,sourceId:target.sourceId}))
      .resolves.toBeNull();
  },180_000);
});
