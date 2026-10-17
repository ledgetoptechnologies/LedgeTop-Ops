import {createIndependentPrimaryClientProjection} from './central-correspondence-client-projection-fixture';
import {createIndependentCorrespondenceFixture,correspondenceLogicalSource as logical,correspondencePrimarySource as primary} from './central-correspondence-independentreview-fixture';
import { expect, vi } from "vitest";
import type { Env } from '../../src/worker/types';
import type { SharedProfilePortalProof } from '../../../../packages/shared/src/shared-business-profile';
import { Miniflare } from "miniflare";
import {
  writeNativeDirectoryProfile,
  type NativeDirectoryCreateWrite,
  type NativeDirectoryDestinationAuthority,
  type NativeDirectoryProfileWrite,
  type NativeDirectoryProfileWriteOutcome,
} from "../../src/worker/native-directory-profile-writer";
import { sharedProfileCreationFence } from "../../src/worker/native-directory-shared-profile-routes";
const httpMocks=vi.hoisted(()=>({authenticate:vi.fn(),inventory:vi.fn(),contactProbe:vi.fn()}));
vi.mock('../../src/worker/project-alpha-directory-profile-api-v2',async importOriginal=>({...await importOriginal<typeof import('../../src/worker/project-alpha-directory-profile-api-v2')>(),
  probeConfiguredProjectAlphaDirectoryClientContactProfile:httpMocks.contactProbe}));
vi.mock('../../src/worker/native-staff-auth',()=>({authenticateNativeStaffWithAdmissionVersion:httpMocks.authenticate}));
vi.mock('../../src/worker/project-alpha-directory-inventory-api-v2',()=>({readConfiguredProjectAlphaDirectoryInventory:httpMocks.inventory}));
vi.mock('../../src/worker/project-alpha-v2-sync',()=>({persistProjectAlphaDirectoryInventoryPage:async()=>({status:'persisted',continuationIdentity:{authorizationGeneration:'1'}})}));
vi.mock('../../src/worker/project-alpha-directory-read-api-v2',()=>({readConfiguredProjectAlphaDirectoryBindingStatus:async()=>({status:'observed',observation:{authorizationGeneration:'1',resource:{revision:'1'}}})}));

let runtime: Miniflare;
let correspondence:Awaited<ReturnType<typeof createIndependentCorrespondenceFixture>>;
let db: D1Database;
let sequence = 1;
let sourceId = "project-alpha:primary";
const sourceInstanceUUID = "11111111-1111-4111-8111-111111111111";
const applicationUUID = "22222222-2222-4222-8222-222222222222";
const historyEpoch = "33333333-3333-4333-8333-333333333333";
let configuredOrigin="https://pa.example.test";
const organizationProfile = { name: "Example Organization", generalEmail: "org@example.test", generalPhone: "512-555-0100",
  addressLine1: "1 Main Street", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" } as const;
const clientProfile = { name: "Standalone Client", email: "client@example.test", phone: "512-555-0101", clientType: "business" as const,
  addressLine1: "2 Main Street", addressLine2: "Suite 2", city: "Austin", state: "TX", postalCode: "78702", country: "US" } as const;

export function uuid(): string { return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`; }
function publicId(): string { return "a"+(sequence++).toString(16).padStart(31, "0"); }
function destination(recordId: string, expectedAuthorizationGeneration = "0"): NativeDirectoryDestinationAuthority {
  return { sourceId, sourceInstanceUUID:sourceId==='project-alpha:secondary'?'44444444-4444-4444-8444-444444444444':sourceInstanceUUID, applicationUUID:sourceId==='project-alpha:secondary'?'55555555-5555-4555-8555-555555555555':applicationUUID, historyEpoch, origin:sourceId==='project-alpha:secondary'?'https://secondary-pa.example.test':configuredOrigin, externalCanonicalId: recordId, expectedAuthorizationGeneration };
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
  organizationRecordId: string | null = null, admittedOrganizationRecordId: string | null = organizationRecordId, bothSources=false) {
  actor ??= await seedActor();
  const recordId = requestedRecordId ?? (kind === "client" ? uuid() : `ops/${kind}/${sequence++}`), mutationId = uuid();
  const createAdmissionId = `admission-${mutationId}`;
  const input = { operation: "create", mutationId, recordId, expectedLocalVersion: 0, kind, createAdmissionId,
    profile: kind === "organization" ? organizationProfile : clientProfile, scopes: [{ businessAreaId: "area", divisionId: "division" }],
    destinations: (bothSources?[destination(recordId),{...destination(recordId),sourceId:'project-alpha:secondary',sourceInstanceUUID:'44444444-4444-4444-8444-444444444444',applicationUUID:'55555555-5555-4555-8555-555555555555',origin:'https://secondary-pa.example.test'}]:[destination(recordId)]).sort((a,b)=>a.sourceId.localeCompare(b.sourceId)), actor,
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
  expect(outcome.status,JSON.stringify(outcome)).toBe("written");
  if (outcome.status !== "written") throw new Error(`write failed: ${outcome.reason}`);
  return outcome;
}
async function acknowledgeCreate(input: NativeDirectoryProfileWrite, outcome: NativeDirectoryProfileWriteOutcome, generation = "1", acknowledgeIntent = true) {
  const result = written(outcome), id = publicId();
  for (const commandId of result.commandIds) {
    const d=input.destinations[result.commandIds.indexOf(commandId)]!;
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='leased',attempts=1,lease_token='lease',lease_expires_at=9999999999999 WHERE command_id=? AND state='pending'`).bind(commandId).run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,project_alpha_public_id,
      source_instance_id,application_id,history_epoch_id,command_id) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(d.sourceId, input.kind, input.recordId, id, d.sourceInstanceUUID, d.applicationUUID, d.historyEpoch, commandId).run();
    const response = { status: "acknowledged", response: { requestId: commandId, replayed: false,
      sourceInstanceId: d.sourceInstanceUUID, applicationId: d.applicationUUID,
      historyEpoch:d.historyEpoch, result: { resource: { type: input.kind, id: input.recordId, publicId: id, revision: "1" },
        data: { publicId: id }, authorizationGeneration: generation } } };
    await db.prepare(`UPDATE project_alpha_directory_outbox SET state='acknowledged',outcome_json=?,lease_token=NULL,lease_expires_at=NULL WHERE command_id=? AND state='leased'`)
      .bind(JSON.stringify(response), commandId).run();
  }
  if (acknowledgeIntent) await db.prepare(`UPDATE operations_directory_intents SET state='acknowledged' WHERE mutation_id=? AND state='materialized'`).bind(input.mutationId).run();
  return id;
}
export async function initializeCorrespondenceComposerFixture(){
 correspondence=await createIndependentCorrespondenceFixture();runtime=correspondence.runtime;db=correspondence.ops;
 const config=JSON.parse(correspondence.env.PROJECT_ALPHA_API_V2_CONNECTIONS!);
 const originValue=config.instances[logical].baseUrl;
 config.instances['project-alpha:secondary']={...config.instances[logical],sourceId:'project-alpha:secondary',baseUrl:'https://secondary-pa.example.test',sourceInstanceId:'44444444-4444-4444-8444-444444444444',applicationId:'55555555-5555-4555-8555-555555555555'};
 correspondence.env.PROJECT_ALPHA_API_V2_CONNECTIONS=JSON.stringify(config);
 // Destination origin is part of the real native writer authority.
 configuredOrigin=originValue;
 await db.batch([
 db.prepare("INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES('owner','owner@example.test','Owner','access|owner','active')"),
 db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('area','Area',1)"),
 db.prepare("INSERT INTO native_business_divisions(id,business_area_id,name,active) VALUES('division','area','Division',1)")]);
}
export async function disposeCorrespondenceComposerFixture(){await runtime.dispose();}

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

export async function createReviewedCorrespondenceGroup(singleton=false){
  const actor=await seedActor(),records=[] as Awaited<ReturnType<typeof create>>[],publicIds=new Map<string,string>();
  for(const source of singleton?[logical]:[logical,'project-alpha:secondary']){sourceId=source;const record=await create('client',actor,undefined,null,null,singleton);
    publicIds.set(record.input.recordId,await acknowledgeCreate(record.input,record.outcome));records.push(record);}
  sourceId=logical;records.sort((a,b)=>a.input.recordId.localeCompare(b.input.recordId));
  const groupId=uuid(),{clientType:_,...profile}=clientProfile,creation=await reviewedCreation(groupId,records,actor,'client',profile,singleton?'single':'pair');
  await db.batch([creation.statement,
    db.prepare("INSERT INTO native_directory_shared_profiles(id,kind,profile_json,membership_json,created_by) VALUES(?,'client',?,?,?)").bind(groupId,JSON.stringify(profile),JSON.stringify(records.map(r=>r.input.recordId)),actor.staffId),
    ...creation.members.map(m=>db.prepare('INSERT INTO native_directory_shared_profile_members(record_id,group_id,initial_version,initial_parent_record_id,initial_relationship_version) VALUES(?,?,1,NULL,1)').bind(m.recordId,groupId)),
    db.prepare('INSERT INTO native_directory_shared_profile_revisions(group_id,version,profile_json) VALUES(?,1,?)').bind(groupId,JSON.stringify(profile))]);
  return {actor,records,publicIds,groupId,profile,env:correspondence.env as Env,correspondence};
}
export async function portalFixture(singleton=false){
  const {actor,records,publicIds,groupId,profile,env}=await createReviewedCorrespondenceGroup(singleton);
  const grantId=uuid(),record=records.find(r=>r.input.destinations.some(d=>d.sourceId===logical))!;
  const {workspaceId,principalPublicId}=await createIndependentPrimaryClientProjection(correspondence.client,publicIds.get(record.input.recordId)!);
  const bridge=await correspondence.approve();
  await db.batch([
    db.prepare("INSERT INTO shared_profile_portal_authority_heads(workspace_id,source_id,revision,state,operation_id) VALUES(?,'project-alpha:primary',1,'active',?)").bind(workspaceId,uuid()),
    db.prepare(`INSERT INTO shared_profile_portal_grants(id,workspace_id,source_id,source_instance_id,application_id,history_epoch_id,directory_source_id,correspondence_revision_id,issuer,subject,principal_public_id,target_type,target_public_id,record_id,group_id,group_membership_json,revision,state,issued_by)
      VALUES(?,?,'project-alpha:primary',?,?,?,?,?,'https://access.example.test','portal-user',?,'client',?,?,?,?,1,'active',?)`)
      .bind(grantId,workspaceId,sourceInstanceUUID,applicationUUID,historyEpoch,logical,bridge.result.revisionId,principalPublicId,publicIds.get(record.input.recordId),record.input.recordId,groupId,JSON.stringify(records.map(r=>r.input.recordId)),actor.staffId)]);
  httpMocks.inventory.mockImplementation(async(_env:unknown,source:string)=>({status:'observed',inventory:{sourceInstanceId:source==='project-alpha:secondary'?'44444444-4444-4444-8444-444444444444':sourceInstanceUUID,applicationId:source==='project-alpha:secondary'?'55555555-5555-4555-8555-555555555555':applicationUUID,historyEpoch,authorizationGeneration:'1'}}));
  httpMocks.contactProbe.mockReset().mockResolvedValue({status:'verified'});
  const proof:SharedProfilePortalProof={protocolVersion:1,workspaceId,sourceId:'project-alpha:primary',issuer:'https://access.example.test',subject:'portal-user',
    authorityRevision:1,contextVersion:'a'.repeat(64),verifiedUntil:new Date(Date.now()+45_000).toISOString(),targets:[{principalPublicId,scopeType:'client',publicId:publicIds.get(record.input.recordId)!}]};
  return {actor,records,groupId,grantId,profile,proof,env:correspondence.env as Env};
}
export async function footprint(groupId:string){return{
  group:await db.prepare('SELECT version,profile_json FROM native_directory_shared_profiles WHERE id=?').bind(groupId).first(),
  commands:(await db.prepare('SELECT * FROM native_directory_shared_profile_commands WHERE group_id=?').bind(groupId).all()).results,
  fences:(await db.prepare('SELECT * FROM shared_profile_portal_write_fences WHERE group_id=?').bind(groupId).all()).results,
  members:(await db.prepare(`SELECT r.record_id,r.current_version FROM operations_directory_records r JOIN native_directory_shared_profile_members m ON m.record_id=r.record_id WHERE m.group_id=? ORDER BY r.record_id`).bind(groupId).all()).results};}
export function diagnosedDatabase(database:D1Database,errors:string[]):D1Database{
  const wrap=(target:any):any=>new Proxy(target,{get(value,key){
    if(key==='withSession')return (...args:unknown[])=>wrap(value.withSession(...args));
    if(key==='batch')return async(statements:unknown[])=>{try{return await value.batch(statements);}catch(error){errors.push(String(error));throw error;}};
    const member=Reflect.get(value,key);return typeof member==='function'?member.bind(value):member;
  }});
  return wrap(database);
}


export const correspondenceFixtureState=()=>({db,correspondence,httpMocks});
