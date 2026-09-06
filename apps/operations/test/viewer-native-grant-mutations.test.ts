import {Miniflare} from "miniflare";
import {afterEach,describe,expect,it} from "vitest";
import {createNativeViewerClientGrant,revokeNativeViewerClientGrant} from "../src/worker/viewer-integration";
import type {Env,StaffPrincipal} from "../src/worker/types";

const active:Miniflare[]=[];
const principal:StaffPrincipal={id:"staff-one",email:"staff@example.test",displayName:"Staff One",
  accessSubject:"staff-subject",projectAlphaUserId:null};
const request=new Request("https://ops.example.test/api/viewer/native-client-grants",{headers:{"CF-Connecting-IP":"192.0.2.1"}});
const grant={sourceId:"project-alpha:primary",workspaceId:"workspace-one",projectPublicId:"pa-project-one",
  scopeType:"task" as const,associationId:"association-one",includeFuturePublished:false,expiresAt:null,
  permissions:{measure:true,cameras:true,download:false}};

async function fixture(){
  const mf=new Miniflare({compatibilityDate:"2026-08-06",modules:true,script:"export default {fetch(){return new Response('ok')}}",
    d1Databases:{DELIVERY_DB:"native-viewer-mutations"}});active.push(mf);
  const database=await mf.getD1Database("DELIVERY_DB") as unknown as D1Database;
  const statements=[
    `CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,legacy_account_id TEXT,status TEXT,display_name TEXT)`,
    `CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_source_id TEXT,project_alpha_project_id TEXT,source_updated_at TEXT,active INTEGER)`,
    `CREATE TABLE viewer_model_associations(id TEXT PRIMARY KEY,project_id TEXT,project_alpha_project_id TEXT,project_source_version TEXT,
      model_title TEXT,model_status TEXT,state TEXT,revoked_at TEXT,association_version INTEGER,updated_at TEXT)`,
    `CREATE TABLE portal_v2_directory_checkpoints(workspace_id TEXT PRIMARY KEY,active_generation_id TEXT)`,
    `CREATE TABLE portal_v2_directory_generations(id TEXT PRIMARY KEY,workspace_id TEXT,status TEXT,complete INTEGER)`,
    `CREATE TABLE portal_v2_directory_entities(workspace_id TEXT,generation_id TEXT,entity_type TEXT,public_id TEXT,source_version TEXT,active INTEGER,display_name TEXT)`,
    `CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT)`,
    `CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT)`,
    `CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT)`,
    `CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT)`,
    `CREATE TABLE audit_events(actor_type TEXT,actor_id TEXT,actor_email TEXT,actor_display_name TEXT,action TEXT,entity_type TEXT,
      entity_id TEXT,division_id TEXT,details_json TEXT,client_address_hash TEXT)`,
    `CREATE TABLE viewer_native_client_grants(id TEXT PRIMARY KEY,source_id TEXT,workspace_id TEXT,project_public_id TEXT,scope_type TEXT,
      association_id TEXT,include_future_published INTEGER,can_measure INTEGER,can_view_cameras INTEGER,can_download INTEGER,
      authorization_expires_at TEXT,grant_version INTEGER DEFAULT 1,status TEXT DEFAULT 'active',created_by_staff_id TEXT,created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),revoked_at TEXT,revoked_by_staff_id TEXT,revoke_reason TEXT)`,
    `CREATE UNIQUE INDEX idx_viewer_native_grants_unique_live ON viewer_native_client_grants
      (source_id,workspace_id,project_public_id,scope_type,COALESCE(association_id,'')) WHERE status='active' AND revoked_at IS NULL`,
    `CREATE TABLE viewer_native_client_grant_mutation_receipts(actor_staff_id TEXT,idempotency_key TEXT,action TEXT,request_fingerprint TEXT,
      grant_id TEXT,response_json TEXT,created_at TEXT DEFAULT (datetime('now')),PRIMARY KEY(actor_staff_id,idempotency_key))`,
    `CREATE UNIQUE INDEX idx_viewer_native_grant_single_revoke ON viewer_native_client_grant_mutation_receipts(grant_id) WHERE action='grant.revoke'`,
    `CREATE TABLE viewer_native_client_grant_audit(id TEXT PRIMARY KEY,grant_id TEXT,action TEXT,actor_staff_id TEXT,idempotency_key TEXT,
      details_json TEXT,created_at TEXT DEFAULT (datetime('now')))`,
    `INSERT INTO role_permissions VALUES('viewer-admin','viewer.view'),('viewer-admin','viewer.manage')`,
    `INSERT INTO staff_role_assignments VALUES('staff-one','viewer-admin','global',NULL)`,
    `INSERT INTO portal_v2_workspaces VALUES('workspace-one','project-alpha:primary',NULL,'active','Greenwood')`,
    `INSERT INTO projects VALUES('project-one','project-alpha:primary','pa-project-one','source-v1',1)`,
    `INSERT INTO viewer_model_associations VALUES('association-one','project-one','pa-project-one','source-v1','Church model','ready','active',NULL,7,datetime('now'))`,
    `INSERT INTO portal_v2_directory_checkpoints VALUES('workspace-one','generation-one')`,
    `INSERT INTO portal_v2_directory_generations VALUES('generation-one','workspace-one','active',1)`,
    `INSERT INTO portal_v2_directory_entities VALUES('workspace-one','generation-one','project','pa-project-one','source-v1',1,'Church')`,
  ];
  for(const statement of statements)await database.prepare(statement).run();
  return {database,env:{DELIVERY_DB:database,OPS_DB:database,AUDIT_IP_SECRET:"audit-secret-that-is-at-least-32-characters"} as Env};
}

afterEach(async()=>{await Promise.all(active.splice(0).map(value=>value.dispose()));});

describe("native Viewer grant mutations",()=>{
  it("replays the stored create response before mutable target revalidation",async()=>{
    const {database,env}=await fixture();
    const first=await createNativeViewerClientGrant({env,principal,grant,idempotencyKey:"native-create-replay-0001",request});
    await database.prepare("UPDATE portal_v2_workspaces SET status='inactive' WHERE id='workspace-one'").run();
    await database.prepare("UPDATE portal_v2_directory_checkpoints SET active_generation_id='generation-two' WHERE workspace_id='workspace-one'").run();
    const replay=await createNativeViewerClientGrant({env,principal,grant,idempotencyKey:"native-create-replay-0001",request});
    expect(replay).toEqual({grant:first.grant,replayed:true});
    expect(await database.prepare("SELECT COUNT(*) count FROM viewer_native_client_grant_mutation_receipts WHERE action='grant.create'").first<number>('count')).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) count FROM viewer_native_client_grant_audit WHERE action='grant.created'").first<number>('count')).toBe(1);
  });

  it("allows exactly one CAS winner for concurrent different-key revokes",async()=>{
    const {database,env}=await fixture();
    const created=await createNativeViewerClientGrant({env,principal,grant,idempotencyKey:"native-create-for-revoke-01",request});
    const outcomes=await Promise.allSettled([
      revokeNativeViewerClientGrant({env,principal,grantId:created.grant.id,reason:"Security response",
        idempotencyKey:"native-revoke-concurrent-a",request}),
      revokeNativeViewerClientGrant({env,principal,grantId:created.grant.id,reason:"Security response",
        idempotencyKey:"native-revoke-concurrent-b",request}),
    ]);
    expect(outcomes.filter(value=>value.status==='fulfilled')).toHaveLength(1);
    const rejected=outcomes.find(value=>value.status==='rejected');
    expect(rejected).toMatchObject({status:'rejected',reason:{status:409}});
    expect(await database.prepare("SELECT status,grant_version FROM viewer_native_client_grants WHERE id=?").bind(created.grant.id).first())
      .toEqual({status:"revoked",grant_version:2});
    expect(await database.prepare("SELECT COUNT(*) count FROM viewer_native_client_grant_mutation_receipts WHERE action='grant.revoke'").first<number>('count')).toBe(1);
    expect(await database.prepare("SELECT COUNT(*) count FROM viewer_native_client_grant_audit WHERE action='grant.revoked'").first<number>('count')).toBe(1);
    expect(await database.prepare("SELECT association_version FROM viewer_model_associations WHERE id='association-one'").first<number>('association_version')).toBe(7);
    const winningKey=(await database.prepare("SELECT idempotency_key FROM viewer_native_client_grant_mutation_receipts WHERE action='grant.revoke'")
      .first<string>('idempotency_key'))!;
    expect(await revokeNativeViewerClientGrant({env,principal,grantId:created.grant.id,reason:"Security response",idempotencyKey:winningKey,request}))
      .toEqual({success:true,replayed:true,existingSessionsExpireWithinSeconds:1800});
    expect(await database.prepare("SELECT COUNT(*) count FROM viewer_native_client_grant_audit WHERE action='grant.revoked'").first<number>('count')).toBe(1);
  });
});
