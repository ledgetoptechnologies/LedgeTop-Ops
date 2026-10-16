import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from 'hono';
import type { Env, StaffPrincipal } from '../src/worker/types';
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  writeNativeDirectorySharedProfiles,
  writeNativeDirectoryProfile,
  type NativeDirectoryCreateWrite,
  type NativeDirectoryDestinationAuthority,
  type NativeDirectoryProfileWrite,
  type NativeDirectoryProfileWriteOutcome,
} from "../src/worker/native-directory-profile-writer";
import { nativeDirectorySharedProfileDelivery, sharedProfileCreationFence, registerNativeDirectorySharedProfileRoutes } from "../src/worker/native-directory-shared-profile-routes";
const httpMocks=vi.hoisted(()=>({authenticate:vi.fn(),inventory:vi.fn(),contactProbe:vi.fn()}));
vi.mock('../src/worker/project-alpha-directory-profile-api-v2',async importOriginal=>({...await importOriginal<typeof import('../src/worker/project-alpha-directory-profile-api-v2')>(),
  probeConfiguredProjectAlphaDirectoryClientContactProfile:httpMocks.contactProbe}));
vi.mock('../src/worker/native-staff-auth',()=>({authenticateNativeStaffWithAdmissionVersion:httpMocks.authenticate}));
vi.mock('../src/worker/project-alpha-api-v2-connections',()=>({listEnabledProjectAlphaApiV2SourceIds:()=>['project-alpha:primary','project-alpha:secondary'],
  resolveProjectAlphaApiV2Connection:()=>({enabled:true,connection:{expectedSourceInstanceId:'11111111-1111-4111-8111-111111111111',
    expectedApplicationId:'22222222-2222-4222-8222-222222222222',expectedHistoryEpoch:'33333333-3333-4333-8333-333333333333',baseUrl:'https://pa.example.test'}})}));
vi.mock('../src/worker/project-alpha-directory-inventory-api-v2',()=>({readConfiguredProjectAlphaDirectoryInventory:httpMocks.inventory}));
vi.mock('../src/worker/project-alpha-v2-sync',()=>({persistProjectAlphaDirectoryInventoryPage:async()=>({status:'persisted',continuationIdentity:{authorizationGeneration:'1'}})}));
vi.mock('../src/worker/project-alpha-directory-read-api-v2',()=>({readConfiguredProjectAlphaDirectoryBindingStatus:async()=>({status:'observed',observation:{authorizationGeneration:'1',resource:{revision:'1'}}})}));

let runtime: Miniflare;
let db: D1Database;
let deliveryDb: D1Database;
let sequence = 1;
let sourceId = "project-alpha:primary";
const sourceInstanceUUID = "11111111-1111-4111-8111-111111111111";
const applicationUUID = "22222222-2222-4222-8222-222222222222";
const historyEpoch = "33333333-3333-4333-8333-333333333333";
const origin = "https://pa.example.test";
const organizationProfile = { name: "Example Organization", generalEmail: "org@example.test", generalPhone: "512-555-0100",
  addressLine1: "1 Main Street", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" } as const;
const clientProfile = { name: "Standalone Client", email: "client@example.test", phone: "512-555-0101", clientType: "business" as const,
  addressLine1: "2 Main Street", addressLine2: "Suite 2", city: "Austin", state: "TX", postalCode: "78702", country: "US" } as const;

function uuid(): string { return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`; }
function publicId(): string { return (sequence++).toString(16).padStart(32, "0"); }
function destination(recordId: string, expectedAuthorizationGeneration = "0"): NativeDirectoryDestinationAuthority {
  return { sourceId, sourceInstanceUUID, applicationUUID, historyEpoch, origin, externalCanonicalId: recordId, expectedAuthorizationGeneration };
}
async function seedActor(scope: "global" | "business_area" = "global") {
  const id = `actor-${sequence++}`, accessSubject = `access|${id}`, grantId = `grant-${id}`, identityGrantId = `identity-${id}`, loginEmail = `${id}@example.test`;
  await db.batch([
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')`).bind(id, loginEmail, id, accessSubject),
    db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,'owner')`).bind(id, accessSubject),
    db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)`).bind(id, loginEmail, id),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by)
      VALUES(?,?,'directory.profile.edit','allow',?,?,'owner')`).bind(grantId, id, scope, scope === "business_area" ? "area" : null),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,granted_by)
      VALUES(?,?,'directory.identity.link','allow',?,?,'owner')`).bind(identityGrantId, id, scope, scope === "business_area" ? "area" : null),
    db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,'directory.profile.view','allow','global','owner')`).bind(`view-${id}`,id),
  ]);
  return { staffId: id, accessSubject, admissionVersion: 1, selectedGrantId: grantId,
    loginEmail, profileVersion: 1, selectedIdentityGrantId: identityGrantId } as const;
}
async function create(kind: "organization" | "client", actor?: Awaited<ReturnType<typeof seedActor>>, requestedRecordId?: string,
  organizationRecordId: string | null = null, admittedOrganizationRecordId: string | null = organizationRecordId) {
  actor ??= await seedActor();
  const recordId = requestedRecordId ?? (kind === "client" ? uuid() : `ops/${kind}/${sequence++}`), mutationId = uuid();
  const createAdmissionId = `admission-${mutationId}`;
  const input = { operation: "create", mutationId, recordId, expectedLocalVersion: 0, kind, createAdmissionId,
    profile: kind === "organization" ? organizationProfile : clientProfile, scopes: [{ businessAreaId: "area", divisionId: "division" }],
    destinations: [destination(recordId)], actor,
    ...(kind === "client" ? { relationship: { organizationRecordId, expectedRelationshipVersion: 0 } } : {}) } as NativeDirectoryCreateWrite;
  const admission = db.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(createAdmissionId, actor.staffId, actor.accessSubject, recordId, kind,
      JSON.stringify(input.scopes), JSON.stringify(input.profile), JSON.stringify(input.destinations.map(({ expectedAuthorizationGeneration: _, ...value }) => value)), actor.staffId);
  if (kind === "client") {
    const admittedVersion = admittedOrganizationRecordId === null ? null : await db.prepare(`SELECT current_version
      FROM operations_directory_records WHERE record_id=? AND record_kind='organization'`).bind(admittedOrganizationRecordId).first<number>("current_version");
    await db.batch([admission, db.prepare(`INSERT INTO native_directory_create_admission_relationships
      (create_admission_id,client_record_id,organization_record_id,organization_record_version) VALUES(?,?,?,?)`)
      .bind(createAdmissionId, recordId, admittedOrganizationRecordId, admittedVersion)]);
  } else await admission.run();
  const outcome = await writeNativeDirectoryProfile(db, input);
  return { input, outcome, actor };
}
function written(outcome: NativeDirectoryProfileWriteOutcome) {
  expect(outcome.status).toBe("written");
  if (outcome.status !== "written") throw new Error(`write failed: ${outcome.reason}`);
  return outcome;
}
async function acknowledgeCreate(input: NativeDirectoryProfileWrite, outcome: NativeDirectoryProfileWriteOutcome, generation = "1", acknowledgeIntent = true) {
  const result = written(outcome), id = publicId();
  for (const commandId of result.commandIds) {
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='lease',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'`).bind(commandId).run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,
      source_instance_id,application_id,history_epoch_id,command_id) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(sourceId, input.kind, input.recordId, id, sourceInstanceUUID, applicationUUID, historyEpoch, commandId).run();
    const response = { status: "acknowledged", response: { requestId: commandId, replayed: false,
      sourceInstanceId: sourceInstanceUUID, applicationId: applicationUUID,
      historyEpoch, result: { resource: { type: input.kind, id: input.recordId, publicId: id, revision: "1" },
        data: { publicId: id }, authorizationGeneration: generation } } };
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'`)
      .bind(JSON.stringify(response), commandId).run();
  }
  if (acknowledgeIntent) await db.prepare(`UPDATE operations_directory_intents SET state='acknowledged' WHERE mutation_id=? AND state='materialized'`).bind(input.mutationId).run();
  return id;
}
beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB", "DELIVERY_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  deliveryDb = await runtime.getD1Database("DELIVERY_DB") as D1Database;
  await deliveryDb.batch(deliveryFixtureSchema.map(sql=>deliveryDb.prepare(sql)));
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0206").sort();
  for (const migration of migrations) await db.batch(splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8")).map(sql => db.prepare(sql)));
  await db.batch([
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')`),
    db.prepare(`INSERT INTO native_business_areas(id,name,active) VALUES('area','Area',1)`),
    db.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division','area','Division',1)`),
    db.prepare(`CREATE TABLE delivery_rows(id TEXT PRIMARY KEY,payload BLOB NOT NULL)`),
    db.prepare(`CREATE TABLE delivery_public_links(id TEXT PRIMARY KEY,url TEXT NOT NULL,payload BLOB NOT NULL)`),
    db.prepare(`INSERT INTO delivery_rows VALUES('delivery',x'ff0080')`),
    db.prepare(`INSERT INTO delivery_public_links VALUES('link','https://public.example.test/keep',x'00ff80')`),
  ]);
}, 240_000);
beforeAll(async()=>{await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0207_shared_directory_profiles.sql",import.meta.url),"utf8")).map(sql=>db.prepare(sql)));});
beforeAll(async()=>{await db.batch(splitD1MigrationStatements(readFileSync(new URL("../migrations/0208_shared_profile_portal_authority.sql",import.meta.url),"utf8")).map(sql=>db.prepare(sql)));});
afterAll(async () => { await runtime.dispose(); });

async function reviewedCreation(groupId:string,records:Awaited<ReturnType<typeof create>>[],actor:Awaited<ReturnType<typeof seedActor>>,
  kind:'organization'|'client',profile:Record<string,string>,mode:'pair'|'single'='pair') {
  const members=await Promise.all(records.map(async r=>{
    const relation=kind==='client'?await db.prepare('SELECT organization_record_id,relationship_version FROM operations_directory_client_organizations WHERE client_record_id=?')
      .bind(r.input.recordId).first<{organization_record_id:string|null;relationship_version:number}>():null;
    const parentRecordId=relation?.organization_record_id??null;
    const parentVersion=parentRecordId?await db.prepare('SELECT current_version FROM operations_directory_records WHERE record_id=?').bind(parentRecordId).first<number>('current_version'):null;
    return {recordId:r.input.recordId,kind,version:1,profile,sourceIds:r.input.destinations.map(d=>d.sourceId),parentRecordId,
      relationshipVersion:relation?.relationship_version??null,parentVersion};
  }));
  const previewToken=mode==='pair'?uuid():null;
  if(previewToken)await db.prepare('INSERT INTO native_directory_shared_profile_previews(token,actor_id,proof_json,expires_at) VALUES(?,?,?,?)')
    .bind(previewToken,actor.staffId,JSON.stringify({members,profile,kind,differences:[],actor}),new Date(Date.now()+600_000).toISOString()).run();
  return {members,previewToken,statement:sharedProfileCreationFence(db,{groupId,mutationId:uuid(),mode,requestSha256:'a'.repeat(64),actor,kind,profile,members,previewToken})};
}

async function sharedPair() {
  const actor=await seedActor();
  sourceId='project-alpha:primary';const first=await create('organization',actor);await acknowledgeCreate(first.input,first.outcome);
  sourceId='project-alpha:secondary';const second=await create('organization',actor);await acknowledgeCreate(second.input,second.outcome);
  sourceId='project-alpha:primary';
  const groupId=uuid(),records=[first,second].sort((a,b)=>a.input.recordId.localeCompare(b.input.recordId));
  const creation=await reviewedCreation(groupId,records,actor,'organization',organizationProfile);
  await db.batch([
    creation.statement,
    db.prepare('INSERT INTO native_directory_shared_profiles(id,kind,profile_json,membership_json,created_by) VALUES(?,?,?,?,?)')
      .bind(groupId,'organization',JSON.stringify(organizationProfile),JSON.stringify(records.map(r=>r.input.recordId)),actor.staffId),
    ...records.map(r=>db.prepare('INSERT INTO native_directory_shared_profile_members(record_id,group_id,initial_version) VALUES(?,?,1)').bind(r.input.recordId,groupId)),
    db.prepare('INSERT INTO native_directory_shared_profile_revisions(group_id,version,profile_json) VALUES(?,1,?)').bind(groupId,JSON.stringify(organizationProfile)),
  ]);
  const profile={...organizationProfile,name:'Shared updated name'},mutationId=uuid();
  const writes=records.map(r=>({operation:'update' as const,mutationId:uuid(),recordId:r.input.recordId,expectedLocalVersion:1,
    kind:'organization' as const,profile,actor,destinations:r.input.destinations.map(d=>({...d,expectedAuthorizationGeneration:'1'}))}));
  return {groupId,actor,records,input:{groupId,mutationId,expectedVersion:1,requestSha256:'a'.repeat(64),profile,writes}};
}

function http(actor:Awaited<ReturnType<typeof seedActor>>,administrator=true,delivery?:D1Database,ops=db){
  const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();
  httpMocks.authenticate.mockResolvedValue({admissionVersion:actor.admissionVersion,identity:{staffId:actor.staffId,email:actor.loginEmail,
    verifiedAccessSubject:actor.accessSubject,profileVersion:actor.profileVersion}});
  httpMocks.inventory.mockResolvedValue({status:'observed',inventory:{sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch,authorizationGeneration:'1'}});
  httpMocks.contactProbe.mockResolvedValue({status:'verified'});
  app.use('*',async(c,next)=>{c.set('principal',{id:actor.staffId,email:actor.loginEmail,accessSubject:actor.accessSubject,displayName:'Synthetic owner',projectAlphaUserId:null});c.set('administrator',administrator);await next();});
  registerNativeDirectorySharedProfileRoutes(app);
  return (path:string,body?:unknown,id?:string,method='POST')=>app.request('/api/client-hub/shared-profiles'+path,{method:body?method:'GET',
    headers:{'Content-Type':'application/json',...(id?{'Idempotency-Key':id}:{})},...(body?{body:JSON.stringify(body)}:{})},
    {OPS_DB:ops,DELIVERY_DB:delivery,NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED:'true'} as Env);
}
async function ungroupedPair(){
  const actor=await seedActor();sourceId='project-alpha:primary';const first=await create('organization',actor);await acknowledgeCreate(first.input,first.outcome);
  sourceId='project-alpha:secondary';const second=await create('organization',actor);await acknowledgeCreate(second.input,second.outcome);sourceId='project-alpha:primary';
  return {actor,records:[first,second].sort((a,b)=>a.input.recordId.localeCompare(b.input.recordId))};
}

// A real, separate D1 database with only the current Delivery authority tables.
// Synthetic identities have no email column: candidates cannot be matched by email.
const deliveryFixtureSchema=[
  'CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,status TEXT,pa_organization_public_id TEXT)',
  'CREATE TABLE pa_portal_workspace_sources(workspace_id TEXT PRIMARY KEY,projection_source_id TEXT,source_workspace_id TEXT)',
  'CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT)',
  'CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,complete INTEGER)',
  'CREATE TABLE pa_portal_principals(workspace_id TEXT,public_id TEXT,identity_id TEXT,status TEXT,PRIMARY KEY(workspace_id,public_id))',
  'CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT,subject TEXT,status TEXT,revoked_at TEXT)',
  'CREATE TABLE portal_v2_workspace_memberships(id TEXT PRIMARY KEY,workspace_id TEXT,identity_id TEXT,status TEXT,revoked_at TEXT)',
  'CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,public_id TEXT,entity_type TEXT,parent_public_id TEXT,active INTEGER)',
  'CREATE TABLE pa_portal_entitlement_intents(workspace_id TEXT,principal_public_id TEXT,scope_type TEXT,scope_public_id TEXT,effect TEXT,capability TEXT,status TEXT,valid_from TEXT,expires_at TEXT)',
];
async function deliveryClient(targetPublicId:string,projectionSource='project-alpha:primary') {
  const workspaceId=uuid(),generationId=uuid(),principalPublicId=publicId();
  await deliveryDb.batch([
    deliveryDb.prepare("INSERT INTO portal_v2_workspaces VALUES(?,?,'active',NULL)").bind(workspaceId,projectionSource),
    deliveryDb.prepare('INSERT INTO pa_portal_workspace_sources VALUES(?,?,?)').bind(workspaceId,projectionSource,uuid()),
    deliveryDb.prepare('INSERT INTO portal_v2_directory_checkpoints VALUES(?,?)').bind(workspaceId,generationId),
    deliveryDb.prepare("INSERT INTO portal_v2_directory_generations VALUES(?,?,'active',1)").bind(generationId,workspaceId),
    deliveryDb.prepare("INSERT INTO pa_portal_principals VALUES(?,?,NULL,'active')").bind(workspaceId,principalPublicId),
    deliveryDb.prepare("INSERT INTO portal_v2_directory_entities VALUES(?,?,?,'standalone_client',NULL,1)").bind(workspaceId,generationId,targetPublicId),
    deliveryDb.prepare("INSERT INTO pa_portal_entitlement_intents VALUES(?,?,'client',?,'allow','directory.read','active',NULL,NULL)").bind(workspaceId,principalPublicId,targetPublicId),
  ]);
  return{workspaceId,generationId,principalPublicId};
}
async function reviewedPortalGrant() {
  sourceId='project-alpha:primary';
  const actor=await seedActor(),record=await create('client',actor),targetPublicId=await acknowledgeCreate(record.input,record.outcome),groupId=uuid();
  await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,'role-admin','global','global')").bind(`role-${groupId}`,actor.staffId).run();
  const request=http(actor,true,deliveryDb);
  expect((await request('/bootstrap',{recordId:record.input.recordId,mutationId:groupId},groupId)).status).toBe(201);
  const delivery=await deliveryClient(targetPublicId);
  const input={operationId:uuid(),id:uuid(),workspaceId:delivery.workspaceId,sourceId:'project-alpha:primary',recipientMode:'first_verified_identity',issuer:null,subject:null,
    principalPublicId:delivery.principalPublicId,targetType:'client',targetPublicId,recordId:record.input.recordId,groupId,expectedRevision:0,state:'active'};
  return{actor,record,request,input,delivery};
}
function beforeCommitDatabase(database:D1Database,change:()=>Promise<unknown>) {
  let fired=false;
  const session=database.withSession('first-primary');
  const wrapped=new Proxy(session,{get(target,key){
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{if(!fired){fired=true;await change();}return target.batch(statements);};
    const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
  }});
  return new Proxy(database,{get(target,key){if(key==='withSession')return()=>wrapped;const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
}

describe('shared profile creation fences and HTTP routes',()=>{
  it('requires an owner, strict reviewed grant body and exact Delivery principal before portal-grant activation',async()=>{
    const actor=await seedActor(),record=await create('client',actor),targetPublicId=await acknowledgeCreate(record.input,record.outcome),groupId=uuid();
    await db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES(?,?,'role-admin','global','global')").bind(`role-${groupId}`,actor.staffId).run();
    const deliveryReads:{sql:string;values:unknown[]}[]=[];
    let deliveryCandidates:{workspaceId:string;principalPublicId:string;targetPublicId:string}[]=[];
    const delivery={withSession(){return delivery;},prepare(sql:string){let values:unknown[]=[];const statement={bind(...bound:unknown[]){values=bound;return statement;},async first(){deliveryReads.push({sql,values});return null;},
      async all(){deliveryReads.push({sql,values});return{results:deliveryCandidates};}};return statement;}} as unknown as D1Database;
    const request=http(actor,true,delivery);expect((await request('/bootstrap',{recordId:record.input.recordId,mutationId:groupId},groupId)).status).toBe(201);deliveryReads.length=0;
    const input={operationId:uuid(),id:uuid(),workspaceId:uuid(),sourceId:'project-alpha:primary',recipientMode:'first_verified_identity',issuer:null,subject:null,
      principalPublicId:'synthetic-principal',targetType:'client',targetPublicId,recordId:record.input.recordId,groupId,expectedRevision:0,state:'active'};
    expect((await http(actor,false,delivery)('/portal-grants',input,input.operationId)).status).toBe(403);
    const ownerRequest=http(actor,true,delivery);
    expect((await ownerRequest('/portal-grants',{...input,unexpected:'field'},input.operationId)).status).toBe(400);
    expect((await ownerRequest('/portal-grants',{...input,targetType:'organization'},input.operationId)).status).toBe(400);
    expect((await ownerRequest('/portal-grants',input,uuid())).status).toBe(400);expect(deliveryReads).toHaveLength(0);
    const denied=await ownerRequest('/portal-grants',input,input.operationId);expect(denied.status).toBe(409);expect(await denied.json()).toEqual({ok:false});
    const grantRead=deliveryReads.find(read=>read.values.includes(input.principalPublicId));expect(grantRead?.sql).toContain('pa_portal_principals');
    expect(grantRead?.values).toContain(input.workspaceId);
    deliveryCandidates=[{workspaceId:input.workspaceId,principalPublicId:input.principalPublicId,targetPublicId}];
    const reviewed=await ownerRequest('/records/'+encodeURIComponent(record.input.recordId));expect(reviewed.status).toBe(200);
    expect(await reviewed.json()).toMatchObject({sharedProfile:{portalSetup:{available:true,candidates:[{...deliveryCandidates[0],recordId:record.input.recordId,sourceId:'project-alpha:primary',groupId,state:'available'}]}}});
    const count=deliveryReads.length;
    const other=await http(actor,false,delivery)('/records/'+encodeURIComponent(record.input.recordId));
    expect(await other.json()).toMatchObject({sharedProfile:{portalSetup:{available:false,candidates:[]}}});expect(deliveryReads).toHaveLength(count);
    expect(await db.prepare('SELECT count(*) n FROM shared_profile_portal_grants WHERE id=?').bind(input.id).first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM shared_profile_portal_audit WHERE operation_id=?').bind(input.operationId).first('n')).toBe(0);
  });
  it('activates a reviewed own-client template with real Delivery proof and freezes the receipt across HTTP retries',async()=>{
    const c=await reviewedPortalGrant();
    const preview=await c.request('/records/'+encodeURIComponent(c.record.input.recordId));
    expect(await preview.json()).toMatchObject({sharedProfile:{portalSetup:{available:true,candidates:[{workspaceId:c.input.workspaceId,principalPublicId:c.input.principalPublicId,targetPublicId:c.input.targetPublicId,state:'available'}]}}});
    const beforeIntents=await db.prepare('SELECT count(*) n FROM operations_directory_intents').first('n');
    const first=await c.request('/portal-grants',c.input,c.input.operationId);expect(first.status).toBe(201);expect(await first.json()).toEqual({ok:true,revision:1});
    const replay=await c.request('/portal-grants',c.input,c.input.operationId);expect(replay.status).toBe(201);expect(await replay.json()).toEqual({ok:true,revision:1});
    const changed=await c.request('/portal-grants',{...c.input,principalPublicId:publicId()},c.input.operationId);expect(changed.status).toBe(409);
    expect(await db.prepare('SELECT count(*) n FROM shared_profile_portal_grants WHERE id=?').bind(c.input.id).first('n')).toBe(1);
    const grant=await db.prepare('SELECT recipient_mode,issuer,subject,state,revision,group_id FROM shared_profile_portal_grants WHERE id=?').bind(c.input.id).first();
    expect(grant).toEqual({recipient_mode:'first_verified_identity',issuer:null,subject:null,state:'active',revision:1,group_id:c.input.groupId});
    expect(await db.prepare('SELECT state FROM shared_profile_portal_authority_heads WHERE workspace_id=?').bind(c.input.workspaceId).first('state')).toBe('blocked');
    expect(await db.prepare('SELECT count(*) n FROM shared_profile_portal_audit WHERE operation_id=?').bind(c.input.operationId).first('n')).toBe(1);
    expect(await db.prepare('SELECT count(*) n FROM operations_directory_intents').first('n')).toBe(beforeIntents);
    const enabled=await c.request('/records/'+encodeURIComponent(c.record.input.recordId));expect(await enabled.json()).toMatchObject({sharedProfile:{portalSetup:{candidates:[{state:'enabled'}]}}});
  });
  it('isolates source/workspace/principal and requires a current complete generation and live own-client entitlement',async()=>{
    const c=await reviewedPortalGrant(),foreign=await deliveryClient(c.input.targetPublicId,'project-alpha:secondary');
    for(const delta of [{sourceId:'project-alpha:secondary'},{workspaceId:foreign.workspaceId,principalPublicId:foreign.principalPublicId},{principalPublicId:publicId()},{targetPublicId:publicId()}]){
      const input={...c.input,...delta,id:uuid(),operationId:uuid()};expect((await c.request('/portal-grants',input,input.operationId)).status).toBe(409);
    }
    await deliveryDb.prepare('UPDATE portal_v2_directory_generations SET complete=0 WHERE id=?').bind(c.delivery.generationId).run();
    expect((await c.request('/portal-grants',c.input,c.input.operationId)).status).toBe(409);
    await deliveryDb.prepare('UPDATE portal_v2_directory_generations SET complete=1 WHERE id=?').bind(c.delivery.generationId).run();
    await deliveryDb.prepare("UPDATE pa_portal_entitlement_intents SET expires_at='2000-01-01T00:00:00Z' WHERE workspace_id=?").bind(c.input.workspaceId).run();
    expect((await c.request('/portal-grants',c.input,c.input.operationId)).status).toBe(409);
    expect(await db.prepare('SELECT count(*) n FROM shared_profile_portal_authority_heads WHERE workspace_id IN(?,?)').bind(c.input.workspaceId,foreign.workspaceId).first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM shared_profile_portal_audit WHERE workspace_id IN(?,?)').bind(c.input.workspaceId,foreign.workspaceId).first('n')).toBe(0);
  });
  it.each(['admission','profile','edit-grant','identity-grant'] as const)('atomically rejects owner activation when %s authority changes after preflight',async(kind)=>{
    const c=await reviewedPortalGrant();let raced=false;
    const racedDb=beforeCommitDatabase(db,async()=>{
      const change=kind==='admission'?await db.prepare('UPDATE native_staff_admissions SET version=version+1 WHERE staff_id=?').bind(c.actor.staffId).run():
        kind==='profile'?await db.prepare('UPDATE native_staff_profiles SET version=version+1 WHERE staff_id=?').bind(c.actor.staffId).run():
        await db.prepare('UPDATE native_directory_grants SET active=0 WHERE id=?').bind(kind==='edit-grant'?c.actor.selectedGrantId:c.actor.selectedIdentityGrantId).run();
      // Set only after the authority change really committed; a failed injection cannot pass.
      const committed=kind==='admission'?await db.prepare('SELECT version FROM native_staff_admissions WHERE staff_id=?').bind(c.actor.staffId).first('version'):
        kind==='profile'?await db.prepare('SELECT version FROM native_staff_profiles WHERE staff_id=?').bind(c.actor.staffId).first('version'):
        await db.prepare('SELECT active FROM native_directory_grants WHERE id=?').bind(kind==='edit-grant'?c.actor.selectedGrantId:c.actor.selectedIdentityGrantId).first('active');
      raced=change.success&&committed===(kind==='admission'||kind==='profile'?2:0);
    });
    const response=await http(c.actor,true,deliveryDb,racedDb)('/portal-grants',c.input,c.input.operationId);
    expect(raced).toBe(true);expect(response.status).toBe(409);
    expect(await db.prepare('SELECT count(*) n FROM shared_profile_portal_grants WHERE id=?').bind(c.input.id).first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM shared_profile_portal_authority_heads WHERE workspace_id=?').bind(c.input.workspaceId).first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM shared_profile_portal_audit WHERE operation_id=?').bind(c.input.operationId).first('n')).toBe(0);
  });
  it('updates a single client group through the identity-safe mode and reports pending PA delivery',async()=>{
    const actor=await seedActor(),record=await create('client',actor);await acknowledgeCreate(record.input,record.outcome);
    const request=http(actor),groupId=uuid();
    expect((await request('/bootstrap',{recordId:record.input.recordId,mutationId:groupId},groupId)).status).toBe(201);
    const mutationId=uuid(),{clientType:_,...profile}=clientProfile;
    const input={mutationId,expectedVersion:1,expectedMembers:[{recordId:record.input.recordId,version:1}],profile:{...profile,email:'contact-only@example.test'}};
    const patch=await request('/'+groupId,input,mutationId,'PATCH');expect(patch.status).toBe(200);
    expect(await patch.json()).toMatchObject({status:'written',replayed:false,version:2,sharedProfile:{version:2,emailEditing:true,delivery:{state:'pending'},members:[{recordId:record.input.recordId}]}});
    expect(await db.prepare('SELECT identity_safe_contact_profile FROM native_directory_shared_profile_commands WHERE mutation_id=?').bind(mutationId).first('identity_safe_contact_profile')).toBe(1);
    const audit=await db.prepare('SELECT command_json FROM operations_directory_audit WHERE record_id=? AND record_version=2').bind(record.input.recordId).first<string>('command_json');
    expect(audit).toContain('sharedContactProfile');expect(audit).toContain(groupId);expect(audit).toContain(mutationId);
    expect((await request('/'+groupId,input,mutationId,'PATCH')).status).toBe(200);
    httpMocks.contactProbe.mockResolvedValue({status:'unavailable'});
    const denied=await request('/records/'+encodeURIComponent(record.input.recordId));
    expect(await denied.json()).toMatchObject({sharedProfile:{emailEditing:false,editing:{available:false,reason:'identity_safe_contact_profile_unavailable'}}});
    const nextId=uuid();expect((await request('/'+groupId,{...input,mutationId:nextId,expectedVersion:2,expectedMembers:[{recordId:record.input.recordId,version:2}]},nextId,'PATCH')).status).toBe(409);
    expect(await db.prepare('SELECT count(*) n FROM native_directory_shared_profile_commands WHERE group_id=?').bind(groupId).first('n')).toBe(1);
  });
  it('bootstraps one current record idempotently without a PA/profile/access write',async()=>{
    const actor=await seedActor(),record=await create('organization',actor);await acknowledgeCreate(record.input,record.outcome);
    const request=http(actor),mutationId=uuid(),body={recordId:record.input.recordId,mutationId};
    const before=await db.prepare('SELECT count(*) n FROM operations_directory_intents').first<number>('n');
    const first=await request('/bootstrap',body,mutationId);expect(first.status).toBe(201);
    expect(await first.json()).toMatchObject({replayed:false,sharedProfile:{id:mutationId,version:1,members:[{recordId:record.input.recordId}]}});
    const replay=await request('/bootstrap',body,mutationId);expect(replay.status).toBe(200);expect(await replay.json()).toMatchObject({replayed:true});
    expect((await request('/bootstrap',{...body,recordId:'other-record'},mutationId)).status).toBe(409);
    expect(await db.prepare('SELECT count(*) n FROM operations_directory_intents').first<number>('n')).toBe(before);
    expect(await db.prepare('SELECT current_version FROM operations_directory_records WHERE record_id=?').bind(record.input.recordId).first('current_version')).toBe(1);
    expect(await db.prepare('SELECT count(*) n FROM native_directory_shared_profile_creation_fences WHERE group_id=?').bind(mutationId).first('n')).toBe(1);
  });
  it('rejects a non-owner bootstrap, mismatched mutation header and expired pair preview',async()=>{
    const c=await ungroupedPair(),id=uuid(),body={recordId:c.records[0]!.input.recordId,mutationId:id};
    expect((await http(c.actor,false)('/bootstrap',body,id)).status).toBe(403);
    const request=http(c.actor);expect((await request('/bootstrap',body,uuid())).status).toBe(400);
    const preview=await request('/preview',{recordIds:c.records.map(r=>r.input.recordId),primaryRecordId:c.records[0]!.input.recordId});
    expect(preview.status).toBe(200);const token=(await preview.json() as {previewToken:string}).previewToken;
    await db.prepare("UPDATE native_directory_shared_profile_previews SET expires_at='2000-01-01T00:00:00Z' WHERE token=?").bind(token).run();
    const mutationId=uuid();expect((await request('/confirm',{previewToken:token,mutationId},mutationId)).status).toBe(409);
    expect(await db.prepare('SELECT count(*) n FROM native_directory_shared_profile_members WHERE record_id=?').bind(c.records[0]!.input.recordId).first('n')).toBe(0);
  });
  it('keeps merge preview exactly two and reads candidates without contacting PA',async()=>{
    const c=await ungroupedPair(),request=http(c.actor);httpMocks.inventory.mockClear();
    const candidates=await request(`/candidates?kind=organization&excludeRecordId=${encodeURIComponent(c.records[0]!.input.recordId)}`);
    expect(candidates.status).toBe(200);expect(await candidates.json()).toMatchObject({candidates:expect.arrayContaining([expect.objectContaining({recordId:c.records[1]!.input.recordId})])});
    expect(httpMocks.inventory).not.toHaveBeenCalled();
    expect((await request('/preview',{recordIds:[c.records[0]!.input.recordId],primaryRecordId:c.records[0]!.input.recordId})).status).toBe(400);
  });
  it('replays an exact pair confirmation and rejects a different mutation or missing native identity',async()=>{
    const c=await ungroupedPair(),request=http(c.actor);
    httpMocks.authenticate.mockRejectedValueOnce(new Error('expired identity'));
    expect((await request('/records/'+encodeURIComponent(c.records[0]!.input.recordId))).status).toBe(403);
    const preview=await request('/preview',{recordIds:c.records.map(r=>r.input.recordId),primaryRecordId:c.records[0]!.input.recordId});
    expect(preview.status).toBe(200);const previewToken=(await preview.json() as {previewToken:string}).previewToken,mutationId=uuid();
    const first=await request('/confirm',{previewToken,mutationId},mutationId);expect(first.status).toBe(201);
    expect((await request('/confirm',{previewToken,mutationId},mutationId)).status).toBe(200);
    const different=uuid();expect((await request('/confirm',{previewToken,mutationId:different},different)).status).toBe(409);
  });
  it('rejects a parent version race after a single-client creation review',async()=>{
    const actor=await seedActor(),parent=await create('organization',actor);await acknowledgeCreate(parent.input,parent.outcome);
    const client=await create('client',actor,undefined,parent.input.recordId);await acknowledgeCreate(client.input,client.outcome);
    const groupId=uuid(),{clientType:_,...profile}=clientProfile,creation=await reviewedCreation(groupId,[client],actor,'client',profile,'single');
    expect((await writeNativeDirectoryProfile(db,{operation:'update',mutationId:uuid(),recordId:parent.input.recordId,expectedLocalVersion:1,kind:'organization',
      profile:{...organizationProfile,name:'Parent changed after review'},actor,destinations:parent.input.destinations.map(d=>({...d,expectedAuthorizationGeneration:'1'}))})).status).toBe('written');
    await expect(creation.statement.run()).rejects.toThrow('shared_creation_member_changed');
    expect(await db.prepare('SELECT count(*) n FROM native_directory_shared_profile_creation_fences WHERE group_id=?').bind(groupId).first('n')).toBe(0);
  });
  for(const race of ['admission','profile','deny','expiry'] as const)it(`atomically refuses a ${race} change after creation preflight`,async()=>{
    const c=await ungroupedPair(),groupId=uuid(),creation=await reviewedCreation(groupId,c.records,c.actor,'organization',organizationProfile);
    if(race==='admission')await db.prepare('UPDATE native_staff_admissions SET version=version+1 WHERE staff_id=?').bind(c.actor.staffId).run();
    if(race==='profile')await db.prepare('UPDATE native_staff_profiles SET version=version+1 WHERE staff_id=?').bind(c.actor.staffId).run();
    if(race==='deny')await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,granted_by) VALUES(?,?,'directory.profile.edit','deny','global','owner')").bind(`deny-${groupId}`,c.actor.staffId).run();
    if(race==='expiry')await db.prepare("UPDATE native_directory_shared_profile_previews SET expires_at='2000-01-01T00:00:00Z' WHERE token=?").bind(creation.previewToken).run();
    await expect(db.batch([creation.statement,db.prepare('INSERT INTO native_directory_shared_profiles(id,kind,profile_json,membership_json,created_by) VALUES(?,?,?,?,?)')
      .bind(groupId,'organization',JSON.stringify(organizationProfile),JSON.stringify(c.records.map(r=>r.input.recordId)),c.actor.staffId)])).rejects.toThrow();
    expect(await db.prepare('SELECT count(*) n FROM native_directory_shared_profile_creation_fences WHERE group_id=?').bind(groupId).first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM native_directory_shared_profiles WHERE id=?').bind(groupId).first('n')).toBe(0);
  });
  it('rejects unfenced raw group creation even for a currently admitted owner',async()=>{
    const c=await ungroupedPair();await expect(db.prepare('INSERT INTO native_directory_shared_profiles(id,kind,profile_json,membership_json,created_by) VALUES(?,?,?,?,?)')
      .bind(uuid(),'organization',JSON.stringify(organizationProfile),JSON.stringify(c.records.map(r=>r.input.recordId)),c.actor.staffId).run()).rejects.toThrow('shared_profile_group_authority');
  });
});
describe('shared directory profile atomic authority',()=>{
  it('updates two existing canonical identities and reserves two PA commands in one local revision',async()=>{
    const c=await sharedPair(),before=(await db.prepare('SELECT * FROM project_alpha_directory_mappings ORDER BY source_id,external_id').all()).results;
    expect(await writeNativeDirectorySharedProfiles(db,c.input)).toEqual({status:'written',replayed:false,version:2});
    expect(await db.prepare('SELECT version,profile_json FROM native_directory_shared_profiles WHERE id=?').bind(c.groupId).first()).toEqual({version:2,profile_json:JSON.stringify(c.input.profile)});
    for(const r of c.records){expect(await db.prepare('SELECT current_version FROM operations_directory_records WHERE record_id=?').bind(r.input.recordId).first('current_version')).toBe(2);
      expect(await db.prepare("SELECT count(*) total FROM operations_directory_intents WHERE record_id=? AND record_version=2").bind(r.input.recordId).first('total')).toBe(1);}
    expect((await db.prepare('SELECT * FROM project_alpha_directory_mappings ORDER BY source_id,external_id').all()).results).toEqual(before);
    expect(await nativeDirectorySharedProfileDelivery(db,c.groupId)).toMatchObject({state:'pending',destinations:[{state:'pending'},{state:'pending'}]});
    const commands=(await db.prepare(`SELECT outbox.command_id,outbox.source_id,intent.record_id FROM project_alpha_directory_outbox outbox
      JOIN operations_directory_materializations materialization ON materialization.command_id=outbox.command_id
      JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id WHERE intent.mutation_id IN(?,?) ORDER BY outbox.source_id`)
      .bind(c.input.writes[0]!.mutationId,c.input.writes[1]!.mutationId).all<{command_id:string;source_id:string;record_id:string}>()).results;
    for(const command of commands)await db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='shared-test',lease_expires_at=9999999999999 WHERE command_id=?`).bind(command.command_id).run();
    const first=commands[0]!;
    const ack={status:'acknowledged',response:{requestId:first.command_id,replayed:false,sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,
      historyEpoch,result:{resource:{type:'organization',publicId:before.find((m:any)=>m.source_id===first.source_id&&m.external_id===first.record_id)?.project_alpha_public_id,revision:'2'},authorizationGeneration:'1'}}};
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=?`).bind(JSON.stringify(ack),first.command_id).run();
    expect((await nativeDirectorySharedProfileDelivery(db,c.groupId)).state).toBe('pending');
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='terminal',outcome_json='{"status":"conflict","httpStatus":409}',lease_token=NULL,lease_expires_at=NULL WHERE command_id=?`).bind(commands[1]!.command_id).run();
    expect((await nativeDirectorySharedProfileDelivery(db,c.groupId)).state).toBe('conflict');
    expect(await writeNativeDirectorySharedProfiles(db,c.input)).toEqual({status:'written',replayed:true,version:2});
    expect(await writeNativeDirectorySharedProfiles(db,{...c.input,requestSha256:'b'.repeat(64)})).toMatchObject({status:'conflict',reason:'idempotency_body_conflict'});
  });
  it('rolls back group, first member and all intents when the second member batch fails',async()=>{
    const c=await sharedPair();
    await db.prepare(`CREATE TRIGGER shared_test_abort BEFORE INSERT ON operations_directory_revisions WHEN NEW.record_id='${c.records[1]!.input.recordId}' AND NEW.version=2 BEGIN SELECT RAISE(ABORT,'injected_second_member_failure'); END`).run();
    expect(await writeNativeDirectorySharedProfiles(db,c.input)).toMatchObject({status:'blocked',reason:'shared_authority_or_atomic_write'});
    await db.prepare('DROP TRIGGER shared_test_abort').run();
    expect(await db.prepare('SELECT version FROM native_directory_shared_profiles WHERE id=?').bind(c.groupId).first('version')).toBe(1);
    expect(await db.prepare('SELECT count(*) total FROM native_directory_shared_profile_commands WHERE group_id=?').bind(c.groupId).first('total')).toBe(0);
    for(const r of c.records)expect(await db.prepare('SELECT current_version FROM operations_directory_records WHERE record_id=?').bind(r.input.recordId).first('current_version')).toBe(1);
  });
  it('rejects a denied second member without accepting either profile',async()=>{
    const c=await sharedPair();await db.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,resource_id,granted_by)
      VALUES(?,?,'directory.profile.edit','deny','resource',?,'owner')`).bind(uuid(),c.actor.staffId,c.records[1]!.input.recordId).run();
    expect(await writeNativeDirectorySharedProfiles(db,c.input)).toMatchObject({status:'blocked'});
    expect(await db.prepare('SELECT version FROM native_directory_shared_profiles WHERE id=?').bind(c.groupId).first('version')).toBe(1);
  });
  it('blocks the old single-record writer on a shared member',async()=>{
    const c=await sharedPair();expect(await writeNativeDirectoryProfile(db,c.input.writes[0]!)).toMatchObject({status:'blocked'});
    expect(await db.prepare('SELECT version FROM native_directory_shared_profiles WHERE id=?').bind(c.groupId).first('version')).toBe(1);
  });
  it('rejects stale member versions and foreign membership without partial changes',async()=>{
    const c=await sharedPair();expect(await writeNativeDirectorySharedProfiles(db,{...c.input,writes:c.input.writes.map((w,i)=>i?{...w,expectedLocalVersion:2}:w)})).toMatchObject({status:'conflict'});
    expect(await writeNativeDirectorySharedProfiles(db,{...c.input,writes:c.input.writes.map((w,i)=>i?{...w,recordId:'foreign-record'}:w)})).toMatchObject({status:'conflict',reason:'shared_profile_changed'});
  });
  it('shares client fields while preserving both distinct organization relationships and client types',async()=>{
    const parents=await sharedPair(),clients=[] as Awaited<ReturnType<typeof create>>[];
    for(const parent of parents.records){sourceId=parent.input.destinations[0]!.sourceId;const client=await create('client',parents.actor,undefined,parent.input.recordId);
      await acknowledgeCreate(client.input,client.outcome);clients.push(client);}sourceId='project-alpha:primary';
    clients.sort((a,b)=>a.input.recordId.localeCompare(b.input.recordId));
    const groupId=uuid(),{clientType:_,...profile}=clientProfile;
    const creation=await reviewedCreation(groupId,clients,parents.actor,'client',profile);
    const statements=[creation.statement,db.prepare('INSERT INTO native_directory_shared_profiles(id,kind,profile_json,membership_json,created_by) VALUES(?,?,?,?,?)')
      .bind(groupId,'client',JSON.stringify(profile),JSON.stringify(clients.map(c=>c.input.recordId)),parents.actor.staffId),
      ...clients.map(c=>db.prepare(`INSERT INTO native_directory_shared_profile_members(record_id,group_id,initial_version,initial_parent_record_id,initial_relationship_version)
        VALUES(?,?,1,?,1)`).bind(c.input.recordId,groupId,(c.input as Extract<NativeDirectoryCreateWrite,{kind:'client'}>).relationship.organizationRecordId)),
      db.prepare('INSERT INTO native_directory_shared_profile_revisions(group_id,version,profile_json) VALUES(?,1,?)').bind(groupId,JSON.stringify(profile))];
    await db.batch(statements);
    const relationships=(await db.prepare('SELECT * FROM operations_directory_client_organizations ORDER BY client_record_id').all()).results;
    const next={...profile,phone:'512-555-0199'};
    const writes=clients.map(c=>({operation:'update' as const,mutationId:uuid(),recordId:c.input.recordId,expectedLocalVersion:1,kind:'client' as const,
      profile:next,actor:parents.actor,destinations:c.input.destinations.map(d=>({...d,expectedAuthorizationGeneration:'1'})),
      relationship:{...(c.input as Extract<NativeDirectoryCreateWrite,{kind:'client'}>).relationship,expectedRelationshipVersion:1}}));
    const changedEmail={...next,email:'new-login-must-not-be-created@example.test'};
    expect(await writeNativeDirectorySharedProfiles(db,{groupId,mutationId:uuid(),expectedVersion:1,requestSha256:'d'.repeat(64),profile:changedEmail,
      writes:writes.map(w=>({...w,profile:changedEmail}))})).toMatchObject({status:'blocked',reason:'client_contact_email_change_requires_identity_safe_pa'});
    await expect(db.prepare(`INSERT INTO native_directory_shared_profile_commands(mutation_id,group_id,expected_version,request_sha256,profile_json,members_json,actor_id)
      VALUES(?,?,1,?,?,?,?)`).bind(uuid(),groupId,'e'.repeat(64),JSON.stringify(changedEmail),JSON.stringify(writes.map(w=>({recordId:w.recordId,version:1,mutationId:w.mutationId}))),parents.actor.staffId).run()).rejects.toThrow('shared_profile_command_guard');
    expect(await writeNativeDirectorySharedProfiles(db,{groupId,mutationId:uuid(),expectedVersion:1,requestSha256:'c'.repeat(64),profile:next,writes})).toMatchObject({status:'written'});
    expect((await db.prepare('SELECT * FROM operations_directory_client_organizations ORDER BY client_record_id').all()).results).toEqual(relationships);
    for(const c of clients){const initial=JSON.parse((await db.prepare('SELECT profile_json FROM operations_directory_revisions WHERE record_id=? AND version=1').bind(c.input.recordId).first<string>('profile_json'))!);
      expect(initial.clientType).toBe('business');}
  });
});
