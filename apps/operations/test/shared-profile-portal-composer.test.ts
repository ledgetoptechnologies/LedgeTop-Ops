import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from '../src/worker/types';
import type { SharedProfilePortalProof } from '../../../packages/shared/src/shared-business-profile';
import { updateSharedPortalProfile,readEditableSharedPortalProfiles } from '../src/worker/shared-profile-portal-composer';
import { transitionSharedProfilePortalAuthority } from '../src/worker/shared-profile-portal-authority';
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
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  const migrations = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0209").sort();
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

async function portalFixture(){
  const actor=await seedActor(),records=[] as Awaited<ReturnType<typeof create>>[],publicIds=new Map<string,string>();
  for(const source of ['project-alpha:primary','project-alpha:secondary']){sourceId=source;const record=await create('client',actor);
    publicIds.set(record.input.recordId,await acknowledgeCreate(record.input,record.outcome));records.push(record);}
  sourceId='project-alpha:primary';records.sort((a,b)=>a.input.recordId.localeCompare(b.input.recordId));
  const groupId=uuid(),{clientType:_,...profile}=clientProfile,creation=await reviewedCreation(groupId,records,actor,'client',profile);
  await db.batch([creation.statement,
    db.prepare("INSERT INTO native_directory_shared_profiles(id,kind,profile_json,membership_json,created_by) VALUES(?,'client',?,?,?)").bind(groupId,JSON.stringify(profile),JSON.stringify(records.map(r=>r.input.recordId)),actor.staffId),
    ...creation.members.map(m=>db.prepare('INSERT INTO native_directory_shared_profile_members(record_id,group_id,initial_version,initial_parent_record_id,initial_relationship_version) VALUES(?,?,1,NULL,1)').bind(m.recordId,groupId)),
    db.prepare('INSERT INTO native_directory_shared_profile_revisions(group_id,version,profile_json) VALUES(?,1,?)').bind(groupId,JSON.stringify(profile))]);
  const workspaceId=uuid(),grantId=uuid(),record=records.find(r=>r.input.destinations[0]!.sourceId==='project-alpha:primary')!,principalPublicId=publicId();
  await db.batch([
    db.prepare("INSERT INTO shared_profile_portal_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES(?,'project-alpha:primary',1,'active',?)").bind(workspaceId,uuid()),
    db.prepare(`INSERT INTO shared_profile_portal_grants(id,workspace_id,source_id,source_instance_id,application_id,history_epoch_id,issuer,subject,principal_public_id,target_type,target_public_id,record_id,group_id,group_membership_json,revision,state,issued_by)
      VALUES(?,?,'project-alpha:primary',?,?,?,'https://access.example.test','portal-user',?,'client',?,?,?,?,1,'active',?)`)
      .bind(grantId,workspaceId,sourceInstanceUUID,applicationUUID,historyEpoch,principalPublicId,publicIds.get(record.input.recordId),record.input.recordId,groupId,JSON.stringify(records.map(r=>r.input.recordId)),actor.staffId)]);
  httpMocks.inventory.mockResolvedValue({status:'observed',inventory:{sourceInstanceId:sourceInstanceUUID,applicationId:applicationUUID,historyEpoch,authorizationGeneration:'1'}});
  httpMocks.contactProbe.mockReset().mockResolvedValue({status:'verified'});
  const proof:SharedProfilePortalProof={protocolVersion:1,workspaceId,sourceId:'project-alpha:primary',issuer:'https://access.example.test',subject:'portal-user',
    authorityRevision:1,contextVersion:'a'.repeat(64),verifiedUntil:new Date(Date.now()+45_000).toISOString(),targets:[{principalPublicId,scopeType:'client',publicId:publicIds.get(record.input.recordId)!}]};
  return {actor,records,groupId,grantId,profile,proof,env:{OPS_DB:db} as Env};
}
async function footprint(groupId:string){return{
  group:await db.prepare('SELECT version,profile_json FROM native_directory_shared_profiles WHERE id=?').bind(groupId).first(),
  commands:(await db.prepare('SELECT * FROM native_directory_shared_profile_commands WHERE group_id=?').bind(groupId).all()).results,
  fences:(await db.prepare('SELECT * FROM shared_profile_portal_write_fences WHERE group_id=?').bind(groupId).all()).results,
  members:(await db.prepare(`SELECT r.record_id,r.current_version FROM operations_directory_records r JOIN native_directory_shared_profile_members m ON m.record_id=r.record_id WHERE m.group_id=? ORDER BY r.record_id`).bind(groupId).all()).results};}
function diagnosedDatabase(database:D1Database,errors:string[]):D1Database{
  const wrap=(target:any):any=>new Proxy(target,{get(value,key){
    if(key==='withSession')return (...args:unknown[])=>wrap(value.withSession(...args));
    if(key==='batch')return async(statements:unknown[])=>{try{return await value.batch(statements);}catch(error){errors.push(String(error));throw error;}};
    const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
  }});
  return wrap(database);
}

describe('portal shared profile real canonical composer',()=>{
  it('atomically updates both clients and replays with a refreshed authority head and TTL',async()=>{
    const f=await portalFixture(),mutationId=uuid(),input={...f.proof,grantId:f.grantId,expectedVersion:1,mutationId,profile:{...f.profile,email:'contact-only@example.test'}};
    const standalonePortalActor={kind:'portal',actorId:`portal:${f.grantId}`,issuer:f.proof.issuer,subject:f.proof.subject,grantId:f.grantId,grantRevision:1,
      workspaceId:f.proof.workspaceId,sourceId:f.proof.sourceId,groupId:f.groupId,groupVersion:1,sharedMutationId:mutationId,authorityRevision:1,contextVersion:f.proof.contextVersion,verifiedUntil:f.proof.verifiedUntil};
    expect(await writeNativeDirectoryProfile(db,{operation:'update',mutationId:uuid(),recordId:f.records[0]!.input.recordId,expectedLocalVersion:1,kind:'client',
      profile:input.profile,actor:standalonePortalActor,destinations:f.records[0]!.input.destinations.map(d=>({...d,expectedAuthorizationGeneration:'1'})),
      relationship:{organizationRecordId:null,expectedRelationshipVersion:1}} as never)).toMatchObject({status:'rejected'});
    expect(await readEditableSharedPortalProfiles(f.env,f.proof)).toMatchObject({ok:true,profiles:[{editable:true,version:1}]});
    const batchErrors:string[]=[],result=await updateSharedPortalProfile({...f.env,OPS_DB:diagnosedDatabase(db,batchErrors)},input);
    expect(result,batchErrors.join('\n')).toMatchObject({ok:true,profiles:[{version:2,editable:false,profile:{email:'contact-only@example.test'}}]});
    const after=await footprint(f.groupId);expect(after.members.map((m:any)=>m.current_version)).toEqual([2,2]);expect(after.commands).toHaveLength(1);expect(after.fences).toHaveLength(1);
    expect(after.commands[0]).toMatchObject({actor_kind:'portal',identity_safe_contact_profile:1});
    expect(await transitionSharedProfilePortalAuthority(f.env,{protocolVersion:1,operationId:uuid(),workspaceId:f.proof.workspaceId,sourceId:f.proof.sourceId,expectedRevision:1,revision:2,state:'blocked'})).toMatchObject({ok:true});
    expect(await transitionSharedProfilePortalAuthority(f.env,{protocolVersion:1,operationId:uuid(),workspaceId:f.proof.workspaceId,sourceId:f.proof.sourceId,expectedRevision:2,revision:2,state:'active'})).toMatchObject({ok:true});
    const fresh={...input,authorityRevision:2,contextVersion:'b'.repeat(64),verifiedUntil:new Date(Date.now()+40_000).toISOString()};
    expect(await updateSharedPortalProfile(f.env,fresh)).toMatchObject({ok:true,profiles:[{version:2}]});expect(await footprint(f.groupId)).toEqual(after);
    expect(await updateSharedPortalProfile(f.env,{...fresh,profile:{...fresh.profile,name:'Changed retry body'}})).toEqual({ok:false,code:'conflict'});
    await db.prepare("UPDATE shared_profile_portal_grants SET state='revoked',revision=revision+1 WHERE id=?").bind(f.grantId).run();
    expect(await updateSharedPortalProfile(f.env,fresh)).toEqual({ok:false,code:'denied'});expect(await footprint(f.groupId)).toEqual(after);
  });
  it('rejects wrong principal, expired proof and one missing neutral destination without local writes',async()=>{
    const f=await portalFixture(),input={...f.proof,grantId:f.grantId,expectedVersion:1,mutationId:uuid(),profile:{...f.profile,name:'Portal updated name'}},before=await footprint(f.groupId);
    expect(await updateSharedPortalProfile(f.env,{...input,targets:[{...input.targets[0]!,principalPublicId:'foreign'}]})).toEqual({ok:false,code:'denied'});
    expect(await updateSharedPortalProfile(f.env,{...input,verifiedUntil:new Date(Date.now()-1000).toISOString()})).toEqual({ok:false,code:'denied'});
    httpMocks.contactProbe.mockImplementation(async(_env:unknown,source:string)=>({status:source==='project-alpha:primary'?'verified':'unavailable'}));
    expect(await readEditableSharedPortalProfiles(f.env,f.proof)).toMatchObject({ok:true,profiles:[{editable:false}]});
    expect(await updateSharedPortalProfile(f.env,input)).toEqual({ok:false,code:'unavailable'});
    expect(await footprint(f.groupId)).toEqual(before);
  });
  it('rolls back the portal fence, group, first member and outboxes if the second member fails',async()=>{
    const f=await portalFixture(),before=await footprint(f.groupId),intents=await db.prepare('SELECT count(*) n FROM operations_directory_intents').first('n');
    const failing=f.records[1]!.input.recordId,batchErrors:string[]=[];
    await db.prepare(`CREATE TRIGGER fail_portal_second_member BEFORE INSERT ON operations_directory_revisions WHEN NEW.record_id='${failing}' AND NEW.version=2 BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END`).run();
    try{expect(await updateSharedPortalProfile({...f.env,OPS_DB:diagnosedDatabase(db,batchErrors)},{...f.proof,grantId:f.grantId,expectedVersion:1,mutationId:uuid(),profile:{...f.profile,phone:'555-0199'}})).toEqual({ok:false,code:'unavailable'});}
    finally{await db.prepare('DROP TRIGGER fail_portal_second_member').run();}
    expect(batchErrors.join('\n')).toContain('synthetic rollback');
    expect(await footprint(f.groupId)).toEqual(before);expect(await db.prepare('SELECT count(*) n FROM operations_directory_intents').first('n')).toBe(intents);
  });
});
