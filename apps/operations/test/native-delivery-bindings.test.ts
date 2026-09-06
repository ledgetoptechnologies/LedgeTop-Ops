import { readFileSync,readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from 'vitest';
import { Hono } from 'hono';
import { splitD1MigrationStatements } from '../../client/test/helpers/d1-migrations';
import { provisionPortalSourceAuthority,setPortalSourceAuthorityState } from '../../client/src/worker/project-alpha-portal-authority';
import { registerProjectAlphaConnector,setProjectAlphaConnectorState,type ProjectAlphaConnectorEnvironment } from '../src/worker/project-alpha-connectors';
import { createNativeDeliveryGrant,previewNativeDeliveryGrant,revokeNativeDeliveryGrant,listNativeDeliveryGrants,
  searchNativeDeliveryTargets,searchNativeDeliveryRecipients,nativeDeliveryBindingsReady,type NativeDeliveryGrantInput } from '../src/worker/native-delivery-bindings';
import { registerNativeDeliveryBindingRoutes } from '../src/worker/native-delivery-binding-routes';
import { createAuthenticatedDeliveryGrant } from '../src/worker/authenticated-delivery-grants';
import { csrfToken } from '../src/worker/request-security';
import { encodeRef } from '../src/worker/delivery';
import type { Env,StaffPrincipal } from '../src/worker/types';
import { resolveNativePortalWorkspaceReadContext } from '../../client/src/worker/client-portal/workspace-v2';
import { readNativeAuthenticatedDeliveryGrants } from '../../client/src/worker/client-portal/authenticated-delivery-grants';
vi.mock('cloudflare:workers',()=>({WorkflowEntrypoint:class{},WorkerEntrypoint:class{},DurableObject:class{}}));

const sourceId='project-alpha:producer-test',issuer='https://client.example.test';
const principal:StaffPrincipal={id:'native-staff',email:'staff@example.test',displayName:'Operator',accessSubject:'staff-subject',projectAlphaUserId:null};
const pub=(n:number)=>n.toString(16).padStart(32,'0');
const key=(n:number)=>btoa(String.fromCharCode(...new Uint8Array(32).fill(n))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
let runtime:Miniflare,ops:D1Database,delivery:D1Database,env:Env,counter=0;
interface Fixture {operation:NativeDeliveryGrantInput;project:string;root:string;identity:string;generation:string;projectPublic:string;rootPublic:string;prefix:string}
async function fixture():Promise<Fixture>{
  const n=++counter,project=`native-project-${n}`,root=`native-root-${n}`,identity=`native-person-${n}`,workspace=`native-workspace-${n}`,
    generation=`native-generation-${n}`,projectPublic=pub(1000+n),rootPublic=pub(2000+n),prefix=`delivery/native-${n}/`;
  await ops.batch([
    ops.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'organization',?,?)`).bind(sourceId,`root-${n}`,root),
    ops.prepare(`INSERT INTO pa_projection_record_ids(projection_source_id,record_kind,external_id,local_id) VALUES(?,'project',?,?)`).bind(sourceId,`project-${n}`,project),
    ops.prepare(`INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,? ,1,?,'fixture',?)`).bind(root,`Root ${n}`,JSON.stringify({public_id:rootPublic}),sourceId),
    ops.prepare(`INSERT INTO pa_projects(id,organization_id,name,active,payload_json,last_sync_id,projection_source_id) VALUES(?,?,?,1,?,'fixture',?)`)
      .bind(project,root,`Native Project ${n}`,JSON.stringify({public_id:projectPublic}),sourceId),
  ]);
  await delivery.batch([
    delivery.prepare(`INSERT INTO pa_portal_workspace_sources(workspace_id,projection_source_id,source_workspace_id) VALUES(?,?,?)`).bind(workspace,sourceId,`external-${n}`),
    delivery.prepare(`INSERT INTO portal_v2_workspaces(id,root_type,pa_organization_public_id,display_name,status,project_alpha_source_id)
      VALUES(?,'organization',?,?,'active',?)`).bind(workspace,rootPublic,`Workspace ${n}`,sourceId),
    delivery.prepare(`INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete)
      VALUES(?,?,?,1,'active',1)`).bind(generation,workspace,generation),
    delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
      VALUES(?,?,'organization',?,NULL,?,'root-v1')`).bind(workspace,generation,rootPublic,`Root ${n}`),
    delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version)
      VALUES(?,?,'project',?,?,?,'project-v1')`).bind(workspace,generation,projectPublic,rootPublic,`Native Project ${n}`),
    delivery.prepare(`INSERT INTO portal_v2_directory_checkpoints(workspace_id,active_generation_id,source_sequence) VALUES(?,?,1)`).bind(workspace,generation),
    delivery.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?, 'active')`).bind(identity,issuer,`person-${n}`,`person-${n}@example.test`),
    delivery.prepare(`INSERT INTO portal_v2_workspace_memberships(id,workspace_id,identity_id,source_type,status,source_version) VALUES(?,?,?,'project_alpha','active','person-v1')`).bind(`membership-${n}`,workspace,identity),
    delivery.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
      VALUES(?,'exact-person',?,?,?,'person-v1','active')`).bind(workspace,identity,`person-${n}@example.test`,`Person ${n}`),
    delivery.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,source_version,status,valid_from)
      VALUES(?,?,?,'delivery.view','allow','workspace',?,1,'project_alpha','intent-v1','active','2020-01-01T00:00:00Z')`).bind(`allow-${n}`,workspace,identity,workspace),
    delivery.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,source_version,status,valid_from)
      VALUES(?,?,?,'workspace.view','allow','workspace',?,1,'project_alpha','intent-v1','active','2020-01-01T00:00:00Z')`).bind(`shell-${n}`,workspace,identity,workspace),
  ]);
  return {operation:{folderRef:encodeRef(prefix.slice(0,-1)),sourceId,workspaceId:workspace,projectId:project,principalPublicId:'exact-person',reasonCode:'client_delivery',expiresAt:null},
    project,root,identity,generation,projectPublic,rootPublic,prefix};
}
async function input(f:Fixture,target=env){const preview=await previewNativeDeliveryGrant(target,principal,f.operation);return {...f.operation,expectedContextVersion:preview.contextVersion};}
async function create(f:Fixture,keyValue=`create-key-${counter}`,target=env){return createNativeDeliveryGrant(target,principal,await input(f,target),keyValue);}
async function signedLifecycle(f:Fixture,completedAt:string|null=null){
  await delivery.batch([
    delivery.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)`)
      .bind(f.generation,f.operation.workspaceId),
    delivery.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
      VALUES(?,?,'project-parent','contains','organization',?,'project',?,'relation-v1')`).bind(f.operation.workspaceId,f.generation,f.rootPublic,f.projectPublic),
    delivery.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status)
      VALUES(?,?,?,'snapshot_activate',?,1,'completed')`).bind(sourceId,`signed-terms-${f.generation}`,f.operation.workspaceId,'a'.repeat(64)),
    delivery.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,completed_at,source_version)
      VALUES(?,?,?,?,?,'lifecycle-v1')`).bind(f.operation.workspaceId,f.generation,f.projectPublic,completedAt?'completed':'active',completedAt),
  ]);
  return {...env,CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true'};
}
async function readable(f:Fixture,target=env){
  const identity=await delivery.prepare('SELECT subject,verified_email FROM portal_v2_identities WHERE id=?').bind(f.identity)
    .first<{subject:string;verified_email:string}>();
  const person={issuer,subject:identity!.subject,email:identity!.verified_email};
  const context=await resolveNativePortalWorkspaceReadContext(target,person,f.operation.workspaceId);
  expect(context).not.toBeNull();return readNativeAuthenticatedDeliveryGrants(target,person,context!);
}
function intercept(db:D1Database,predicate:(sql:string[])=>boolean,action:()=>Promise<void>,once=true):D1Database{
  const sqls=new WeakMap<object,string>();let done=false,proxy:D1Database;
  function statement(raw:D1PreparedStatement,sql:string):D1PreparedStatement{
    const result=new Proxy(raw,{get(target,key){if(key==='bind')return(...values:unknown[])=>statement(target.bind(...values),sql);
      const value=target[key as keyof D1PreparedStatement];return typeof value==='function'?value.bind(target):value;}});sqls.set(result,sql);return result;
  }
  proxy=new Proxy(db,{get(target,key){if(key==='withSession')return()=>proxy;
    if(key==='prepare')return(sql:string)=>statement(target.prepare(sql),sql);
    if(key==='batch')return async(statements:D1PreparedStatement[])=>{if((!done||!once)&&predicate(statements.map(s=>sqls.get(s)??''))){done=true;await action();}return target.batch(statements);};
    const value=target[key as keyof D1Database];return typeof value==='function'?value.bind(target):value;}});return proxy;
}
async function deny(permission='delivery.share.create',division='native-division'){
  await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
    VALUES(?,?,?,'deny','division',?,?,?)`).bind(crypto.randomUUID(),principal.id,permission,division,division,principal.id).run();
}
async function suspendSource(){await delivery.prepare(`UPDATE pa_portal_source_authorities SET state='suspended',version=version+1 WHERE source_id=?`).bind(sourceId).run();}

describe('real D1 native staff folder binding and exact principal delegation',{timeout:60_000,concurrent:false},()=>{
  beforeAll(async()=>{
    runtime=new Miniflare({modules:true,compatibilityDate:'2026-07-22',script:"export default {fetch(){return new Response('native-producer')}}",d1Databases:['OPS_DB','DELIVERY_DB','EMPTY_DB']});
    ops=await runtime.getD1Database('OPS_DB') as D1Database;delivery=await runtime.getD1Database('DELIVERY_DB') as D1Database;
    for(const [db,path,cap] of [[ops,new URL('../migrations/',import.meta.url),'0040'],[delivery,new URL('../../client/migrations/',import.meta.url),'0197']] as const)
      for(const name of readdirSync(path).filter(n=>/^\d{4}_.*\.sql$/.test(n)&&n.slice(0,4)<=cap).sort())
        await db.batch(splitD1MigrationStatements(readFileSync(new URL(name,path),'utf8')).map(sql=>db.prepare(sql)));
    const primaryCredential={snapshotApiKey:'primary-snapshot-key',eventCurrent:{keyId:'primary-key',algorithm:'ed25519',value:key(1)}},
      secondaryCredential={snapshotApiKey:'secondary-snapshot-key',eventCurrent:{keyId:'secondary-key',algorithm:'ed25519',value:key(2)},
        portalCurrent:{keyId:'portal-key',value:'secondary-portal-secret-at-least-thirty-two-bytes'}};
    const configured:Partial<Env>&ProjectAlphaConnectorEnvironment={OPS_DB:ops,DELIVERY_DB:delivery,PROJECT_ALPHA_BASE_URL:'https://primary.example.test/',PROJECT_ALPHA_API_KEY:primaryCredential.snapshotApiKey,
      APPLICATION_KEY:'ltds_ops',PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY:key(1),PROJECT_ALPHA_CONNECTOR_CREDENTIALS:JSON.stringify({version:1,sets:{primary:primaryCredential,secondary:secondaryCredential}}),
      CLIENT_PORTAL_HIERARCHY_V2_ENABLED:'true',AUTHENTICATED_DELIVERY_GRANTS_ENABLED:'true',AUTHENTICATED_DELIVERY_CREATION_ENABLED:'true',CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',
      CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED:'true',
      PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED:'true',
      PUBLIC_BASE_URL:'https://operations.example.test',OPERATIONS_SESSION_SECRET:'fixture-session-secret-at-least-32-bytes'};
    // This focused fixture supplies only bindings exercised by the producer.
    env=configured as Env;
    const revision=(ref:string)=>({credentialRef:ref,snapshotBasePath:'/',accessIssuer:'https://access.example.test',accessAudience:'audience',accessSubject:'subject'});
    await registerProjectAlphaConnector(env,{sourceId:'project-alpha:primary',producerBindingId:'primary-producer',snapshotOrigin:'https://primary.example.test',
      applicationKey:'ltds_ops',profile:'primary_legacy',displayName:'Primary',revision:revision('primary')},principal.id);
    await setProjectAlphaConnectorState(env,'project-alpha:primary',{expectedVersion:1,state:'active'},principal.id);
    await registerProjectAlphaConnector(env,{sourceId,producerBindingId:'native-producer',snapshotOrigin:'https://secondary.example.test',applicationKey:'ltds_ops',
      profile:'business_data',displayName:'Secondary Alpha',revision:revision('secondary')},principal.id);
    await setProjectAlphaConnectorState(env,sourceId,{expectedVersion:1,state:'active',readVisible:true},principal.id);
    const connector={sourceId,producerBindingId:'native-producer',snapshotOrigin:'https://secondary.example.test',snapshotBasePath:'/',applicationKey:'ltds_ops',
      profile:'business_data' as const,revision:1,version:2,state:'active' as const};
    const prepared=await provisionPortalSourceAuthority(env,connector,{credentialRef:'secondary',accessIssuer:'https://access.example.test',accessAudience:'audience',accessSubject:'subject'},null,principal.id);
    await setPortalSourceAuthorityState(env,connector,prepared.version,'active',principal.id);
    await ops.batch([
      ops.prepare(`INSERT INTO pa_connector_portal_sources(source_id,created_by) VALUES(?,?)`).bind(sourceId,principal.id),
      ops.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')`).bind(principal.id,principal.email,principal.displayName,principal.accessSubject),
      ops.prepare(`INSERT INTO divisions(id,name,code,active) VALUES('native-division','Native division','NATIVE',1)`),
      ops.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('native-admin',?,'role-admin','global','global')`).bind(principal.id),
      ops.prepare(`INSERT INTO pa_projects(id,name,payload_json,last_sync_id,active) VALUES('folder-location','Location only','{}','fixture',1)`),
      ops.prepare(`INSERT INTO project_folders(project_id,division_id,r2_prefix,match_method,confirmed_by)
        VALUES('folder-location','native-division','delivery/','manual',?)`).bind(principal.id),
    ]);
    // Explicit local allows; role/deny evaluation is real, not an ACL mock.
    for(const permission of ['projects.view','delivery.browse','delivery.share.create','delivery.share.revoke','delivery.share.audit'])
      await ops.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
        VALUES(?,?,?,'allow','global','global',?)`).bind(`allow-${permission}`,principal.id,permission,principal.id).run();
  },180_000);
  beforeEach(async()=>{
    await ops.prepare(`DELETE FROM staff_permission_overrides WHERE staff_id=? AND effect='deny'`).bind(principal.id).run();
    await ops.prepare(`UPDATE staff_users SET status='active' WHERE id=?`).bind(principal.id).run();
    await delivery.prepare(`UPDATE pa_portal_source_authorities SET state='active',version=version+1 WHERE source_id=? AND state<>'active'`).bind(sourceId).run();
  });
  afterAll(async()=>runtime.dispose());

  it('uses real explicit target/principal selections and exact preview echoes',async()=>{
    const f=await fixture(),targets=await searchNativeDeliveryTargets(env,principal,f.operation.folderRef,`Project ${counter}`);
    expect(targets.targets).toContainEqual({sourceId,sourceName:'Secondary Alpha',workspaceId:f.operation.workspaceId,workspaceName:`Workspace ${counter}`,projectId:f.project,projectName:`Native Project ${counter}`,projectEndSupported:false});
    const recipients=await searchNativeDeliveryRecipients(env,principal,{...f.operation,q:`Person ${counter}`});expect(recipients.recipients[0]?.principalPublicId).toBe('exact-person');
    const preview=await previewNativeDeliveryGrant(env,principal,f.operation);expect(preview.operation).toEqual(f.operation);expect(preview.contextVersion).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses native delivery grant issuance while the client root is revoked',async()=>{
    const f=await fixture();
    await delivery.prepare(`INSERT INTO portal_v2_root_access_policies
      (projection_source_id,root_type,root_public_id,state,reason_code,created_by_staff_id,updated_by_staff_id)
      VALUES(?,'organization',?,'revoked','security_hold',?,?)`)
      .bind(sourceId,f.rootPublic,principal.id,principal.id).run();
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
  });
  it.each([undefined,'false'] as const)('blocks native create and revoke without writes when the authority mutation flag is %s',async flag=>{
    const f=await fixture(),body=await input(f),target={...env,PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED:flag} as Env;
    if(flag===undefined)delete (target as Partial<Env>).PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED;
    const createKey=`native-gate-create-${flag??'absent'}-${counter}`;
    await expect(createNativeDeliveryGrant(target,principal,body,createKey)).rejects.toMatchObject({status:503});
    expect(await ops.prepare('SELECT count(*) n FROM native_delivery_authorizations WHERE idempotency_key=?').bind(createKey).first<number>('n')).toBe(0);
    expect(await delivery.prepare('SELECT count(*) n FROM portal_native_staff_bindings WHERE workspace_id=?').bind(f.operation.workspaceId).first<number>('n')).toBe(0);
    expect(await delivery.prepare('SELECT count(*) n FROM portal_project_access_terms WHERE workspace_id=?').bind(f.operation.workspaceId).first<number>('n')).toBe(0);

    const created=await create(f,`native-gate-seed-${flag??'absent'}-${counter}`),revokeKey=`native-gate-revoke-${flag??'absent'}-${counter}`;
    await expect(revokeNativeDeliveryGrant(target,principal,created.grant.id,
      {folderRef:f.operation.folderRef,expectedVersion:1,reasonCode:'gate_test'},revokeKey)).rejects.toMatchObject({status:503});
    expect(await ops.prepare('SELECT count(*) n FROM native_delivery_authorizations WHERE idempotency_key=?').bind(revokeKey).first<number>('n')).toBe(0);
    expect(await delivery.prepare('SELECT status FROM portal_v2_authenticated_delivery_grants WHERE id=?').bind(created.grant.id).first<string>('status')).toBe('active');
    expect(await delivery.prepare("SELECT count(*) n FROM portal_native_staff_grant_events WHERE grant_id=? AND action='revoked'").bind(created.grant.id).first<number>('n')).toBe(0);
  });
  it('pauses native creation while preserving existing grant revocation',async()=>{
    const existing=await fixture(),created=await create(existing,`native-creation-seed-${counter}`),target={...env,AUTHENTICATED_DELIVERY_CREATION_ENABLED:'false'} as Env;
    const candidate=await fixture(),body=await input(candidate,target),createKey=`native-creation-paused-${counter}`;
    await expect(createNativeDeliveryGrant(target,principal,body,createKey)).rejects.toMatchObject({status:503});
    expect(await ops.prepare('SELECT count(*) n FROM native_delivery_authorizations WHERE idempotency_key=?').bind(createKey).first<number>('n')).toBe(0);
    const revoked=await revokeNativeDeliveryGrant(target,principal,created.grant.id,
      {folderRef:existing.operation.folderRef,expectedVersion:1,reasonCode:'creation_paused'},`native-creation-revoke-${counter}`);
    expect(revoked.grant.status).toBe('revoked');
  });
  it('publishes exactly once, replays and preserves all legacy accounts',async()=>{
    const f=await fixture(),before=await delivery.prepare('SELECT count(*) n FROM client_accounts').first('n'),body=await input(f);
    const first=await createNativeDeliveryGrant(env,principal,body,'create-replay-key'),second=await createNativeDeliveryGrant(env,principal,body,'create-replay-key');
    expect(first.grant.status).toBe('active');expect(first.grant.version).toBe(1);expect(second).toEqual({...first,replayed:true});
    expect(await ops.prepare('SELECT count(*) n FROM native_delivery_authorizations WHERE idempotency_key=?').bind('create-replay-key').first('n')).toBe(1);
    expect(await delivery.prepare('SELECT count(*) n FROM portal_native_staff_grant_events WHERE grant_id=?').bind(first.grant.id).first('n')).toBe(2);
    expect(await delivery.prepare('SELECT count(*) n FROM client_accounts').first('n')).toBe(before);
  });
  it('real producer publication authorizes the exact native identity, then revoke removes its read',async()=>{
    const f=await fixture(),created=await create(f),identity=await delivery.prepare('SELECT subject,verified_email FROM portal_v2_identities WHERE id=?')
      .bind(f.identity).first<{subject:string;verified_email:string}>();
    const client={issuer,subject:identity!.subject,email:identity!.verified_email};
    const context=await resolveNativePortalWorkspaceReadContext(env,client,f.operation.workspaceId);expect(context).not.toBeNull();
    expect(await delivery.prepare(`SELECT count(*) n FROM portal_primary_staff_bindings
      WHERE binding_id=(SELECT folder_binding_id FROM portal_v2_authenticated_delivery_grants WHERE id=?)`)
      .bind(created.grant.id).first<number>('n')).toBe(0);
    const grants=await readNativeAuthenticatedDeliveryGrants(env,client,context!);expect(grants.map(g=>g.grant_id)).toEqual([created.grant.id]);
    expect(await readNativeAuthenticatedDeliveryGrants(env,{...client,subject:'different-subject'},context!)).toEqual([]);
    await revokeNativeDeliveryGrant(env,principal,created.grant.id,{folderRef:f.operation.folderRef,expectedVersion:1,reasonCode:'revoke'},'roundtrip-revoke-key');
    expect(await readNativeAuthenticatedDeliveryGrants(env,client,context!)).toEqual([]);
  });
  it('keeps old grants unclassified and requires internally consistent reviewed terms',async()=>{
    const f=await fixture(),legacy=await create(f);
    expect(legacy.grant.accessTerms).toBeNull();
    expect(await delivery.prepare('SELECT count(*) n FROM portal_project_access_terms WHERE workspace_id=?').bind(f.operation.workspaceId).first('n')).toBe(0);
    await expect(previewNativeDeliveryGrant(env,principal,{...f.operation,
      accessTerms:{kind:'customer',mode:'project_end',expiresAt:null}})).rejects.toMatchObject({status:400});
    await expect(previewNativeDeliveryGrant(env,principal,{...f.operation,
      accessTerms:{kind:'collaborator',mode:'specific_date',expiresAt:new Date(Date.now()+86400_000).toISOString()}})).rejects.toMatchObject({status:400});
  });
  it('publishes reviewed customer history beyond thirty days without reclassifying older grants',async()=>{
    const f=await fixture(),related=await signedLifecycle(f,'2020-01-01T00:00:00Z');
    await expect(previewNativeDeliveryGrant(related,principal,f.operation)).rejects.toMatchObject({status:404});
    const recipients=await searchNativeDeliveryRecipients(related,principal,{...f.operation,q:'Person'});
    expect(recipients.recipients.map(row=>row.principalPublicId)).toContain('exact-person');
    f.operation.accessTerms={kind:'customer',mode:'until_revoked',expiresAt:null};
    const preview=await previewNativeDeliveryGrant(related,principal,f.operation);
    expect(preview).toMatchObject({accessTerms:f.operation.accessTerms,effectiveAccessExpiresAt:null,projectEndSupported:true});
    const created=await create(f,`customer-history-${counter}`,related);
    expect(created.grant.accessTerms).toEqual(f.operation.accessTerms);
    expect((await readable(f,related)).map(row=>row.grant_id)).toEqual([created.grant.id]);
    await revokeNativeDeliveryGrant(related,principal,created.grant.id,{folderRef:f.operation.folderRef,expectedVersion:1,reasonCode:'customer_revoked'},`customer-revoke-${counter}`);
    expect(await readable(f,related)).toEqual([]);
  });
  it('supports an explicit collaborator date and until-revoked access without lifecycle data',async()=>{
    const f=await fixture(),expiresAt=new Date(Date.now()+86400_000).toISOString();
    f.operation.expiresAt=expiresAt;f.operation.accessTerms={kind:'collaborator',mode:'specific_date',expiresAt};
    const dated=await create(f,`dated-terms-${counter}`);
    expect(dated.grant.effectiveAccessExpiresAt).toBe(expiresAt);
    f.operation.expiresAt=null;f.operation.accessTerms={kind:'collaborator',mode:'until_revoked',expiresAt:null};
    const manual=await create(f,`manual-terms-${counter}`);
    expect(manual.grant.effectiveAccessExpiresAt).toBeNull();
    expect((await readable(f)).map(row=>row.grant_id).sort()).toEqual([dated.grant.id,manual.grant.id].sort());
    f.operation.accessTerms={kind:'collaborator',mode:'project_end',expiresAt:null};
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:409});
  });
  it('publishes customer access despite expired invitation history and still enforces a current deny',async()=>{
    const f=await fixture(),related=await signedLifecycle(f),term=`expired-proof-${f.project}`;
    await delivery.batch([
      delivery.prepare(`INSERT INTO portal_project_access_terms(id,workspace_id,source_id,project_public_id,kind,mode,created_by_actor_type,created_by_actor_id)
        VALUES(?,?,?,?,'collaborator','project_end','staff',?)`).bind(term,f.operation.workspaceId,sourceId,f.projectPublic,principal.id),
      delivery.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type,entitlement_version,access_terms_id)
        SELECT ?||'-'||value,?,?,'delivery.view','allow','project',?,'client_invitation',value+1,? FROM json_each(?)`)
        .bind(term,f.operation.workspaceId,f.identity,f.projectPublic,term,JSON.stringify(Array.from({length:202},(_,i)=>i))),
    ]);
    await delivery.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at=?,source_version='proof-completion' WHERE workspace_id=?`)
      .bind(new Date(Date.now()-40*86400_000).toISOString(),f.operation.workspaceId).run();
    f.operation.accessTerms={kind:'customer',mode:'until_revoked',expiresAt:null};
    const made=await create(f,`capacity-proof-${f.project}`,related);
    expect((await readable(f,related)).map(row=>row.grant_id)).toEqual([made.grant.id]);
    await delivery.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,source_type)
      VALUES(?,?,?,'delivery.view','deny','project',?,'operations')`).bind(`deny-${term}`,f.operation.workspaceId,f.identity,f.projectPublic).run();
    await expect(previewNativeDeliveryGrant(related,principal,f.operation)).rejects.toMatchObject({status:404});
    expect(await readable(f,related)).toEqual([]);
  });
  it('latches project-end expiry and preserves an independent customer grant after collaborator expiry',async()=>{
    const f=await fixture(),related=await signedLifecycle(f);
    f.operation.accessTerms={kind:'collaborator',mode:'project_end',expiresAt:null};
    const collaborator=await create(f,`collaborator-terms-${counter}`,related);
    expect(collaborator.grant.effectiveAccessExpiresAt).toBeNull();
    f.operation.accessTerms={kind:'customer',mode:'until_revoked',expiresAt:null};
    const customer=await create(f,`independent-customer-${counter}`,related);
    await delivery.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at='2020-01-01T00:00:00Z',source_version='completed-v2'
      WHERE workspace_id=?`).bind(f.operation.workspaceId).run();
    const history=await listNativeDeliveryGrants(related,principal,f.operation.folderRef);
    expect(history.grants.find(row=>row.id===collaborator.grant.id)).toMatchObject({status:'expired',effectiveAccessExpiresAt:'2020-01-08T00:00:00.000Z'});
    expect((await readable(f,related)).map(row=>row.grant_id)).toEqual([customer.grant.id]);
    await delivery.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='active',completed_at=NULL,source_version='reopened-v3'
      WHERE workspace_id=?`).bind(f.operation.workspaceId).run();
    expect((await readable(f,related)).map(row=>row.grant_id)).toEqual([customer.grant.id]);
    expect((await listNativeDeliveryGrants(related,principal,f.operation.folderRef)).grants.find(row=>row.id===collaborator.grant.id)?.status).toBe('expired');
  });
  it('fences completion changes between reviewed terms and publication',async()=>{
    const f=await fixture(),related=await signedLifecycle(f);
    f.operation.accessTerms={kind:'collaborator',mode:'project_end',expiresAt:null};
    const body=await input(f,related),wrapped={...related,DELIVERY_DB:intercept(delivery,sql=>sql.some(s=>s.includes("SET state='active'")),async()=>{
      await delivery.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at='2020-01-01T00:00:00Z',source_version='completion-race'
        WHERE workspace_id=?`).bind(f.operation.workspaceId).run();})};
    await expect(createNativeDeliveryGrant(wrapped,principal,body,`completion-terms-race-${counter}`)).rejects.toMatchObject({status:409});
    expect(await readable(f,related)).toEqual([]);
    expect((await listNativeDeliveryGrants(related,principal,f.operation.folderRef)).grants[0]?.publicationState).toBe('suspended');
  });
  it('binds terms to the exact project and refuses mutation after publication',async()=>{
    const f=await fixture(),other=await fixture();f.operation.accessTerms={kind:'customer',mode:'until_revoked',expiresAt:null};
    const created=await create(f,`immutable-terms-${counter}`);
    const termsId=await delivery.prepare('SELECT access_terms_id FROM portal_v2_authenticated_delivery_grants WHERE id=?').bind(created.grant.id).first<string>('access_terms_id');
    await expect(delivery.prepare(`UPDATE portal_project_access_terms SET project_public_id=? WHERE id=?`).bind(other.projectPublic,termsId).run()).rejects.toThrow();
    await expect(delivery.prepare(`UPDATE portal_v2_authenticated_delivery_grants SET access_terms_id=NULL WHERE id=?`).bind(created.grant.id).run()).rejects.toThrow();
    expect((await readable(other)).length).toBe(0);
  });
  it('rejects primary, raw internal public-ID substitution and a different workspace',async()=>{
    const f=await fixture(),other=await fixture();
    await expect(previewNativeDeliveryGrant(env,principal,{...f.operation,sourceId:'project-alpha:primary'})).rejects.toMatchObject({status:400});
    await expect(previewNativeDeliveryGrant(env,principal,{...f.operation,workspaceId:other.operation.workspaceId})).rejects.toMatchObject({status:404});
    await ops.prepare(`UPDATE pa_projects SET payload_json=? WHERE id=?`).bind(JSON.stringify({public_id:f.project}),f.project).run();
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
  });
  it('honors exact division denies even for an administrator and blocks inactive actor',async()=>{
    const f=await fixture();await deny();await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
    await ops.prepare(`DELETE FROM staff_permission_overrides WHERE effect='deny'`).run();await ops.prepare(`UPDATE staff_users SET status='inactive' WHERE id=?`).bind(principal.id).run();
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
  });
  it('rejects ambiguous public IDs and unmapped folder locations before a receipt',async()=>{
    const f=await fixture(),other=await fixture();await ops.prepare(`UPDATE pa_projects SET payload_json=? WHERE id=?`).bind(JSON.stringify({public_id:f.projectPublic}),other.project).run();
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
    await expect(previewNativeDeliveryGrant(env,principal,{...other.operation,folderRef:encodeRef('unmapped/location')})).rejects.toMatchObject({status:404});
  });
  it('a new deny inside the OPS authorization batch prevents all Delivery writes',async()=>{
    const f=await fixture(),body=await input(f),wrapped={...env,OPS_DB:intercept(ops,sql=>sql.some(s=>s.includes('INSERT INTO native_delivery_authorizations')),()=>deny())};
    await expect(createNativeDeliveryGrant(wrapped,principal,body,'receipt-deny-race')).rejects.toMatchObject({status:409});
    expect(await delivery.prepare('SELECT count(*) n FROM portal_native_staff_bindings WHERE workspace_id=?').bind(f.operation.workspaceId).first('n')).toBe(0);
  });
  it('changed explicit project ownership inside the OPS batch is fenced',async()=>{
    const f=await fixture(),other=await fixture(),body=await input(f),wrapped={...env,OPS_DB:intercept(ops,sql=>sql.some(s=>s.includes('INSERT INTO native_delivery_authorizations')),
      async()=>{await ops.prepare('UPDATE pa_projects SET organization_id=? WHERE id=?').bind(other.root,f.project).run();})};
    await expect(createNativeDeliveryGrant(wrapped,principal,body,'owner-race-key')).rejects.toMatchObject({status:409});
  });
  it('source suspension before the Delivery stage leaves only durable OPS evidence',async()=>{
    const f=await fixture();f.operation.accessTerms={kind:'customer',mode:'until_revoked',expiresAt:null};
    const body=await input(f),wrapped={...env,DELIVERY_DB:intercept(delivery,sql=>sql.some(s=>s.includes('INSERT INTO portal_v2_folder_bindings')),suspendSource)};
    await expect(createNativeDeliveryGrant(wrapped,principal,body,'source-stage-race')).rejects.toMatchObject({status:409});
    expect(await ops.prepare('SELECT count(*) n FROM native_delivery_authorizations WHERE idempotency_key=?').bind('source-stage-race').first('n')).toBe(1);
    expect(await delivery.prepare('SELECT count(*) n FROM portal_native_staff_bindings WHERE workspace_id=?').bind(f.operation.workspaceId).first('n')).toBe(0);
    // A missing materialized proof must emit a failing guard, not a zero-row
    // no-op that would allow the following term/grant inserts to commit.
    expect(await delivery.prepare('SELECT count(*) n FROM portal_project_access_terms WHERE workspace_id=?').bind(f.operation.workspaceId).first('n')).toBe(0);
  });
  it('a recipient denial at publication cannot expose the staged grant',async()=>{
    const f=await fixture(),body=await input(f);const wrapped={...env,DELIVERY_DB:intercept(delivery,sql=>sql.some(s=>s.includes("SET state='active'")),async()=>{
      await delivery.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,status,valid_from)
        VALUES(?,?,?,'delivery.view','deny','workspace',?,1,'operations','active','2020-01-01T00:00:00Z')`)
        .bind(`deny-${counter}`,f.operation.workspaceId,f.identity,f.operation.workspaceId).run();})};
    await expect(createNativeDeliveryGrant(wrapped,principal,body,'recipient-race-key')).rejects.toMatchObject({status:409});
    expect(await delivery.prepare(`SELECT state FROM portal_native_staff_grants g JOIN portal_native_staff_bindings b ON b.binding_id=g.binding_id WHERE b.workspace_id=?`)
      .bind(f.operation.workspaceId).first('state')).toBe('suspended');
  });
  it.each(['issuer_subject','email'] as const)('rejects a current %s eligibility block before granting',async match=>{
    const f=await fixture(),person=await delivery.prepare('SELECT subject,verified_email FROM portal_v2_identities WHERE id=?').bind(f.identity)
      .first<{subject:string;verified_email:string}>();
    await delivery.prepare(`INSERT INTO portal_v2_identity_eligibility_blocks(id,match_type,issuer,subject,normalized_email,reason_code,
      created_by_actor_type,created_by_actor_id) VALUES(?,?,?,?,?,'staff_block','staff',?)`)
      .bind(crypto.randomUUID(),match,match==='issuer_subject'?issuer:null,match==='issuer_subject'?person!.subject:null,
        match==='email'?person!.verified_email:null,principal.id).run();
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
    expect(await delivery.prepare('SELECT count(*) n FROM portal_native_staff_bindings WHERE workspace_id=?').bind(f.operation.workspaceId).first('n')).toBe(0);
  });
  it('requires the current PA membership version and verified email binding',async()=>{
    const f=await fixture();await delivery.prepare(`UPDATE pa_portal_principals SET source_version='stale-version' WHERE identity_id=?`).bind(f.identity).run();
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
    await delivery.prepare(`UPDATE pa_portal_principals SET source_version='person-v1' WHERE identity_id=?`).bind(f.identity).run();
    await delivery.prepare(`UPDATE portal_v2_identities SET verified_email='changed@example.test' WHERE id=?`).bind(f.identity).run();
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
  });
  it('an eligibility block added in the publication batch closes the pending gate',async()=>{
    const f=await fixture(),body=await input(f),wrapped={...env,DELIVERY_DB:intercept(delivery,sql=>sql.some(s=>s.includes("SET state='active'")),async()=>{
      await delivery.prepare(`INSERT INTO portal_v2_identity_eligibility_blocks(id,match_type,issuer,subject,reason_code,created_by_actor_type,created_by_actor_id)
        SELECT ?,'issuer_subject',issuer,subject,'race_block','staff',? FROM portal_v2_identities WHERE id=?`)
        .bind(crypto.randomUUID(),principal.id,f.identity).run();})};
    await expect(createNativeDeliveryGrant(wrapped,principal,body,'eligibility-block-race')).rejects.toMatchObject({status:409});
    expect(await delivery.prepare(`SELECT state FROM portal_native_staff_grants g JOIN portal_native_staff_bindings b ON b.binding_id=g.binding_id WHERE b.workspace_id=?`)
      .bind(f.operation.workspaceId).first('state')).toBe('suspended');
  });
  it('rejects ambiguous legacy ancestry and schema-v3 data with relations disabled',async()=>{
    const f=await fixture();
    await delivery.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,display_name,source_version)
      VALUES(?,?,'client',?,'Ambiguous parent','other-v1')`).bind(f.operation.workspaceId,f.generation,f.rootPublic).run();
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
    const v3=await fixture();await delivery.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version)
      VALUES(?,?,3)`).bind(v3.generation,v3.operation.workspaceId).run();
    await expect(previewNativeDeliveryGrant(env,principal,v3.operation)).rejects.toMatchObject({status:404});
  });
  it('uses exact relation retention and fences a lifecycle change inside publication',async()=>{
    const f=await fixture(),related={...env,CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED:'true'};
    await delivery.batch([
      delivery.prepare(`INSERT INTO portal_v2_directory_generation_contracts(generation_id,workspace_id,schema_version) VALUES(?,?,3)`)
        .bind(f.generation,f.operation.workspaceId),
      delivery.prepare(`INSERT INTO portal_v2_directory_relations(workspace_id,generation_id,public_id,relation_type,from_type,from_public_id,to_type,to_public_id,source_version)
        VALUES(?,?,'root-project','contains','organization',?,'project',?,'relation-v1')`).bind(f.operation.workspaceId,f.generation,f.rootPublic,f.projectPublic),
      delivery.prepare(`INSERT INTO portal_v2_project_lifecycle(workspace_id,generation_id,project_public_id,lifecycle_status,source_version)
        VALUES(?,?,?,'active','lifecycle-v1')`).bind(f.operation.workspaceId,f.generation,f.projectPublic),
    ]);
    const body=await input(f,related),wrapped={...related,DELIVERY_DB:intercept(delivery,sql=>sql.some(s=>s.includes("SET state='active'")),async()=>{
      await delivery.prepare(`UPDATE portal_v2_project_lifecycle SET lifecycle_status='completed',completed_at='2020-01-01T00:00:00Z'
        WHERE workspace_id=?`).bind(f.operation.workspaceId).run();})};
    await expect(createNativeDeliveryGrant(wrapped,principal,body,'retention-publication-race')).rejects.toMatchObject({status:409});
    await expect(previewNativeDeliveryGrant(related,principal,f.operation)).rejects.toMatchObject({status:404});
    expect(await delivery.prepare(`SELECT state FROM portal_native_staff_grants g JOIN portal_native_staff_bindings b ON b.binding_id=g.binding_id
      WHERE b.workspace_id=?`).bind(f.operation.workspaceId).first('state')).toBe('suspended');
  });
  it('preserves the explicit eligibility shell and rejects workspace.view deny during publication',async()=>{
    const f=await fixture();
    await delivery.batch([
      delivery.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE identity_id=? AND capability='workspace.view'`).bind(f.identity),
      delivery.prepare(`INSERT INTO portal_v2_identity_eligibility_bindings(identity_id,workspace_id,principal_public_id,principal_source_version,verified_email)
        SELECT identity_id,workspace_id,public_id,source_version,email_hint FROM pa_portal_principals WHERE workspace_id=?`).bind(f.operation.workspaceId),
    ]);
    const body=await input(f),wrapped={...env,DELIVERY_DB:intercept(delivery,sql=>sql.some(s=>s.includes("SET state='active'")),async()=>{
      await delivery.prepare(`INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,status,valid_from)
        VALUES(?,?,?,'workspace.view','deny','workspace',?,1,'operations','active','2020-01-01T00:00:00Z')`)
        .bind(crypto.randomUUID(),f.operation.workspaceId,f.identity,f.operation.workspaceId).run();})};
    await expect(createNativeDeliveryGrant(wrapped,principal,body,'shell-deny-publication-race')).rejects.toMatchObject({status:409});
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
  });
  it('does not publish into a native shell exceeding the shared entitlement capacity',async()=>{
    const f=await fixture();
    await delivery.prepare(`WITH RECURSIVE numbers(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<199)
      INSERT INTO portal_v2_entitlements(id,workspace_id,identity_id,capability,effect,scope_type,scope_public_id,entitlement_version,source_type,status,valid_from)
      SELECT ?||n,?,?,'directory.read','allow','workspace',?,n,'operations','active','2020-01-01T00:00:00Z' FROM numbers`)
      .bind(`capacity-${counter}-`,f.operation.workspaceId,f.identity,f.operation.workspaceId).run();
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
  });
  it('cannot borrow another identity shell eligibility in the same workspace',async()=>{
    const f=await fixture(),other=`other-shell-${counter}`,email=`other-shell-${counter}@example.test`;
    await delivery.batch([
      delivery.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE identity_id=? AND capability='workspace.view'`).bind(f.identity),
      delivery.prepare(`INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,?,?,?,'active')`).bind(other,issuer,other,email),
      delivery.prepare(`INSERT INTO pa_portal_principals(workspace_id,public_id,identity_id,email_hint,display_name,source_version,status)
        VALUES(?,'other-person',?,?,'Other eligible identity','other-v1','active')`).bind(f.operation.workspaceId,other,email),
      delivery.prepare(`INSERT INTO portal_v2_identity_eligibility_bindings(identity_id,workspace_id,principal_public_id,principal_source_version,verified_email)
        VALUES(?,?,'other-person','other-v1',?)`).bind(other,f.operation.workspaceId,email),
    ]);
    await expect(previewNativeDeliveryGrant(env,principal,f.operation)).rejects.toMatchObject({status:404});
  });
  it('post-publication staff change closes the gate instead of reporting success',async()=>{
    const f=await fixture(),body=await input(f);let armed=false;
    const wrapped={...env,DELIVERY_DB:intercept(delivery,sql=>sql.some(s=>s.includes("SET state='active'")),async()=>{armed=true;await deny();})};
    await expect(createNativeDeliveryGrant(wrapped,principal,body,'post-publication-race')).rejects.toMatchObject({status:409});expect(armed).toBe(true);
    expect(await delivery.prepare(`SELECT state FROM portal_native_staff_grants g JOIN portal_native_staff_bindings b ON b.binding_id=g.binding_id WHERE b.workspace_id=?`)
      .bind(f.operation.workspaceId).first('state')).toBe('suspended');
  });
  it('concurrent same-key publication converges without suspending the winner',async()=>{
    const f=await fixture(),body=await input(f);const results=await Promise.all([1,2].map(()=>createNativeDeliveryGrant(env,principal,body,'concurrent-publish-key')));
    expect(results[0]!.grant.id).toBe(results[1]!.grant.id);expect(results.every(r=>r.grant.status==='active')).toBe(true);
    expect(await delivery.prepare('SELECT state FROM portal_native_staff_grants WHERE grant_id=?').bind(results[0]!.grant.id).first('state')).toBe('active');
  });
  it('changed payload/key reuse is rejected and closed grants never replay as active',async()=>{
    const f=await fixture(),body=await input(f),created=await createNativeDeliveryGrant(env,principal,body,'payload-key-one');
    await expect(createNativeDeliveryGrant(env,principal,{...body,reasonCode:'changed'},'payload-key-one')).rejects.toMatchObject({status:409});
    await revokeNativeDeliveryGrant(env,principal,created.grant.id,{folderRef:f.operation.folderRef,expectedVersion:1,reasonCode:'client_request'},'revoke-payload-key');
    await expect(createNativeDeliveryGrant(env,principal,body,'payload-key-one')).rejects.toMatchObject({status:409});
  });
  it('keeps durable history and permits revoke when recipient eligibility and source purpose are gone',async()=>{
    const f=await fixture(),created=await create(f);await delivery.prepare(`UPDATE portal_v2_entitlements SET status='revoked',revoked_at=datetime('now') WHERE identity_id=?`).bind(f.identity).run();
    await suspendSource();const history=await listNativeDeliveryGrants(env,principal,f.operation.folderRef);expect(history.grants[0]?.id).toBe(created.grant.id);
    const body={folderRef:f.operation.folderRef,expectedVersion:1,reasonCode:'staff_revoke'};
    const first=await revokeNativeDeliveryGrant(env,principal,created.grant.id,body,'revoke-without-recipient'),again=await revokeNativeDeliveryGrant(env,principal,created.grant.id,body,'revoke-without-recipient');
    expect(first.grant.status).toBe('revoked');expect(first.grant.version).toBe(1);expect(again.replayed).toBe(true);
  });
  it('does not revoke completed delegation when the original issuer later loses their role',async()=>{
    const f=await fixture(),created=await create(f);await deny();
    expect(await delivery.prepare('SELECT state FROM portal_native_staff_grants WHERE grant_id=?').bind(created.grant.id).first('state')).toBe('active');
  });
  it('retains a crash-staged grant as not published and allows another authorized operator to cancel it',async()=>{
    const f=await fixture(),body=await input(f),wrapped={...env,DELIVERY_DB:intercept(delivery,
      sql=>sql.some(s=>s.includes("SET state='active'")||s.includes("SET state='suspended'")),async()=>{throw new Error('fixture-database-unavailable');},false)};
    await expect(createNativeDeliveryGrant(wrapped,principal,body,'crash-after-stage-key')).rejects.toThrow('fixture-database-unavailable');
    const pending=(await listNativeDeliveryGrants(env,principal,f.operation.folderRef)).grants[0]!;
    expect(pending.publicationState).toBe('pending');expect(pending.canRevoke).toBe(true);
    const operator={...principal,id:'recovery-operator',email:'recovery@example.test',accessSubject:'recovery-subject'};
    await ops.batch([
      ops.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?,'active')`).bind(operator.id,operator.email,operator.displayName,operator.accessSubject),
      ops.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('recovery-admin',?,'role-admin','global','global')`).bind(operator.id),
      ...['projects.view','delivery.browse','delivery.share.revoke','delivery.share.audit'].map(permission=>ops.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES(?,?,?,'allow','global','global',?)`).bind(`recovery-${permission}`,operator.id,permission,operator.id)),
    ]);
    const request={folderRef:f.operation.folderRef,expectedVersion:1,reasonCode:'cancel_unpublished'};
    const cancelled=await revokeNativeDeliveryGrant(env,operator,pending.id,request,'cancel-pending-key');
    expect(cancelled.grant).toMatchObject({status:'revoked',publicationState:'revoked',version:1,canRevoke:false});
    expect((await revokeNativeDeliveryGrant(env,operator,pending.id,request,'cancel-pending-key')).replayed).toBe(true);
    await expect(createNativeDeliveryGrant(env,principal,body,'crash-after-stage-key')).rejects.toMatchObject({status:409});
  });
  it('fences revoke permission inside its OPS transaction',async()=>{
    const f=await fixture(),created=await create(f),wrapped={...env,OPS_DB:intercept(ops,sql=>sql.some(s=>s.includes('INSERT INTO native_delivery_authorizations')),()=>deny('delivery.share.revoke'))};
    await expect(revokeNativeDeliveryGrant(wrapped,principal,created.grant.id,{folderRef:f.operation.folderRef,expectedVersion:1,reasonCode:'revoke'},'revoke-deny-race')).rejects.toMatchObject({status:409});
    expect(await delivery.prepare('SELECT state FROM portal_native_staff_grants WHERE grant_id=?').bind(created.grant.id).first('state')).toBe('active');
  });
  it('protects owner/prefix, authorization receipt and terminal gate from UPDATE/REPLACE',async()=>{
    const f=await fixture(),created=await create(f),id=created.grant.id;
    await expect(delivery.prepare(`UPDATE portal_v2_folder_bindings SET r2_prefix='elsewhere/' WHERE id=(SELECT binding_id FROM portal_native_staff_grants WHERE grant_id=?)`).bind(id).run()).rejects.toThrow();
    await expect(ops.prepare(`UPDATE native_delivery_authorizations SET publication_deadline='2099-01-01' WHERE grant_id=?`).bind(id).run()).rejects.toThrow();
    await expect(ops.prepare(`INSERT OR REPLACE INTO native_delivery_authorizations SELECT * FROM native_delivery_authorizations WHERE grant_id=?`).bind(id).run()).rejects.toThrow();
    await revokeNativeDeliveryGrant(env,principal,id,{folderRef:f.operation.folderRef,expectedVersion:1,reasonCode:'revoke'},'immutable-revoke-key');
    await expect(delivery.prepare(`UPDATE portal_native_staff_grants SET state='active' WHERE grant_id=?`).bind(id).run()).rejects.toThrow();
    expect((await delivery.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
  it('the legacy producer cannot mutate a native secondary binding',async()=>{
    const f=await fixture(),created=await create(f),bindingId=await delivery.prepare('SELECT binding_id FROM portal_native_staff_grants WHERE grant_id=?').bind(created.grant.id).first<string>('binding_id');
    await expect(createAuthenticatedDeliveryGrant(env,principal,{folderBindingId:bindingId!,audienceType:'principal',audiencePublicId:'exact-person',reasonCode:'legacy_attempt',expiresAt:null},'old-producer-key'))
      .rejects.toMatchObject({status:404});
  });
  it('fails unavailable on real absent migration and rejects unsafe route bodies/CSRF',async()=>{
    const empty=await runtime.getD1Database('EMPTY_DB') as D1Database;expect(await nativeDeliveryBindingsReady({...env,DELIVERY_DB:empty})).toBe(false);
    const app=new Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>();app.use('*',async(c,next)=>{c.set('principal',principal);c.set('administrator',true);await next();});registerNativeDeliveryBindingRoutes(app);
    const f=await fixture(),path='/api/delivery/native-grants/preview',absolutePath=`${env.PUBLIC_BASE_URL}${path}`;
    expect((await app.request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(f.operation)},env)).status).toBe(403);
    const headers={'Content-Type':'application/json',Origin:env.PUBLIC_BASE_URL,'X-CSRF-Token':await csrfToken(env,principal)};
    expect((await app.request(absolutePath,{method:'POST',headers,body:'x'.repeat(8193)},env)).status).toBe(413);
    const response=await app.request(absolutePath,{method:'POST',headers,body:JSON.stringify(f.operation)},env);expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toMatchObject({preview:{operation:f.operation}});
  });
});
