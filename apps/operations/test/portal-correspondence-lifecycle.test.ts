import {beforeAll,afterAll,expect,it} from 'vitest';
import {initializeCorrespondenceComposerFixture,disposeCorrespondenceComposerFixture,portalFixture,correspondenceFixtureState,uuid} from './helpers/shared-profile-correspondence-fixture';
import {correspondenceLogicalSource as logical,correspondencePrimarySource as primary,correspondenceTuple as tuple} from './helpers/central-correspondence-independentreview-fixture';
import {readSharedProfilePortalProfiles} from '../src/worker/shared-profile-portal-authority';
import {correspondenceGrantSql,managePortalDirectoryCorrespondence,previewPortalDirectoryCorrespondence,resolveDirectoryPortalSource} from '../src/worker/portal-directory-correspondence';
import {stagePrimaryDeliveryAuthority} from '../src/worker/project-alpha-primary-delivery-authority';
import type {CorrespondenceEnv} from '../src/worker/portal-directory-correspondence';
let f:Awaited<ReturnType<typeof portalFixture>>;
let approved:{revision_id:string;proof_json:string;proof_sha256:string};
let initialConnectorVersion:number;
beforeAll(async()=>{await initializeCorrespondenceComposerFixture();f=await portalFixture(true);
 const {db}=correspondenceFixtureState();approved=(await db.prepare('SELECT id revision_id,proof_json,proof_sha256 FROM portal_directory_correspondence_revisions WHERE id=(SELECT revision_id FROM portal_directory_correspondence_heads WHERE directory_source_id=?)').bind(logical).first<typeof approved>())!;
 initialConnectorVersion=JSON.parse(approved.proof_json).connectorVersion;
},300_000);
afterAll(disposeCorrespondenceComposerFixture);
const proof=()=>({...f.proof,verifiedUntil:new Date(Date.now()+45_000).toISOString()});
async function profiles(env:CorrespondenceEnv=f.env){return readSharedProfilePortalProfiles(env,proof());}
async function expectGranted(env:CorrespondenceEnv=f.env){expect(await profiles(env)).toMatchObject({ok:true,profiles:[{grantId:f.grantId}]});}
async function expectDenied(env:CorrespondenceEnv=f.env){const result=await profiles(env);expect(result.ok&&result.profiles.some(p=>p.grantId===f.grantId)).toBe(false);}
async function transition(state:'active'|'suspended'){
 const {db,correspondence}=correspondenceFixtureState();
 const before=(await db.prepare('SELECT version,active_revision,state FROM pa_connectors WHERE source_id=?').bind(primary).first<{version:number;active_revision:number;state:'active'|'suspended'}>())!;
 const current={kind:'primary_connector' as const,sourceId:'project-alpha:primary' as const,mode:'registry' as const,connectorRevision:before.active_revision,connectorVersion:before.version};
 // The real Delivery-first transition pair, followed by the registry CAS. No
 // trigger removal or authority/grant replacement is used in these local D1s.
 await stagePrimaryDeliveryAuthority(correspondence.client,current,before.state);
 await stagePrimaryDeliveryAuthority(correspondence.client,{...current,connectorVersion:before.version+1},state);
 await db.prepare('UPDATE pa_connectors SET state=?,version=version+1 WHERE source_id=? AND version=?').bind(state,primary,before.version).run();
}
function readProjection(db:D1Database,transform:(sql:string)=>string):D1Database{
 const wrap=(target:any):any=>new Proxy(target,{get(value,key){
  if(key==='withSession')return(...args:unknown[])=>wrap(value.withSession(...args));
  if(key==='prepare')return(sql:string)=>value.prepare(transform(sql));
  const result=Reflect.get(value,key);return typeof result==='function'?result.bind(value):result;
 }});return wrap(db);
}
it('restores the original profile grant after same-identity pause/resume without replacing approval or grant',async()=>{
 const {db}=correspondenceFixtureState();const originalGrant=await db.prepare('SELECT * FROM shared_profile_portal_grants WHERE id=?').bind(f.grantId).first();
 const originalHead=await db.prepare('SELECT * FROM portal_directory_correspondence_heads WHERE directory_source_id=?').bind(logical).first();
 await expectGranted();await transition('suspended');await expectDenied();await transition('active');await expectGranted();
 expect(await db.prepare('SELECT version FROM pa_connectors WHERE source_id=?').bind(primary).first('version')).toBe(initialConnectorVersion+2);
 expect(await db.prepare('SELECT * FROM shared_profile_portal_grants WHERE id=?').bind(f.grantId).first()).toEqual(originalGrant);
 expect(await db.prepare('SELECT * FROM portal_directory_correspondence_heads WHERE directory_source_id=?').bind(logical).first()).toEqual(originalHead);
 expect(await db.prepare('SELECT id revision_id,proof_json,proof_sha256 FROM portal_directory_correspondence_revisions WHERE id=?').bind(approved.revision_id).first()).toEqual(approved);
 expect(await resolveDirectoryPortalSource(f.env,logical,tuple,approved.revision_id)).toMatchObject({portalSourceId:primary,correspondenceRevisionId:approved.revision_id});
},120_000);
it('denies changed source, app, history, origin, disabled source and ambiguous nomination with advanced counters',async()=>{
 const config=JSON.parse(f.env.PROJECT_ALPHA_API_V2_CONNECTIONS!);
 for(const delta of [{sourceInstanceId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},{applicationId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},
  {historyEpoch:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'},{baseUrl:'https://other.example.test'},{enabled:false}]){
  const changed=structuredClone(config);Object.assign(changed.instances[logical],delta);
  await expectDenied({...f.env,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify(changed)});
 }
 const changed=structuredClone(config);changed.instances['project-alpha:ambiguous']={...changed.instances[logical],sourceId:'project-alpha:ambiguous'};
 await expectDenied({...f.env,PROJECT_ALPHA_API_V2_CONNECTIONS:JSON.stringify(changed)});
 await expectGranted();
});
it('requires the exact current active registry mirror and read-visible producer before using the existing grant',async()=>{
 const {db,correspondence}=correspondenceFixtureState();
 const row=(await db.prepare('SELECT version,active_revision FROM pa_connectors WHERE source_id=?').bind(primary).first<{version:number;active_revision:number}>())!;
 const current={kind:'primary_connector' as const,sourceId:'project-alpha:primary' as const,mode:'registry' as const,connectorRevision:row.active_revision,connectorVersion:row.version};
 await stagePrimaryDeliveryAuthority(correspondence.client,current,'suspended');await expectDenied();
 await stagePrimaryDeliveryAuthority(correspondence.client,{...current,connectorVersion:row.version+1},'active');await expectDenied();
 await stagePrimaryDeliveryAuthority(correspondence.client,current,'active');await expectGranted();
 // Primary read_visible=0 is rejected by the real registry CHECK constraint.
 // Also model a hidden eligible-source observation through a real D1 SELECT,
 // rather than disabling that invariant to manufacture impossible state.
 const hidden=readProjection(db,sql=>sql.replaceAll('read_visible=1','read_visible=0'));
 await expectDenied({...f.env,OPS_DB:hidden});
 await expectGranted();
});
it('keeps immutable producer binding exact even if both lifecycle counters have advanced',async()=>{
 const {db}=correspondenceFixtureState();
 const changed=readProjection(db,sql=>sql.replace('SELECT c.producer_binding_id,c.snapshot_origin',"SELECT c.producer_binding_id||'-changed' producer_binding_id,c.snapshot_origin"));
 await expectDenied({...f.env,OPS_DB:changed});await expectGranted();
});
it('rejects observations below each approved counter floor and retains the atomic grant SQL floor',async()=>{
 const {db,correspondence}=correspondenceFixtureState();const stored=JSON.parse(approved.proof_json);
 // Read-only SQL projections model an older restored observation, without
 // bypassing immutable/monotonic update triggers in either actual D1.
 const olderAuthority=readProjection(correspondence.client,sql=>sql.replace('SELECT authority_version FROM',`SELECT ${stored.primaryAuthorityVersion-1} authority_version FROM`));
 await expectDenied({...f.env,DELIVERY_DB:olderAuthority});
 const actual=await db.prepare('SELECT version FROM pa_connectors WHERE source_id=?').bind(primary).first<number>('version');
 const olderVersion=stored.connectorVersion-1,offset=actual!-olderVersion;
 const olderConnector=readProjection(db,sql=>sql.replace('c.active_revision,c.version,r.current_key_fingerprint',`c.active_revision,${olderVersion} version,r.current_key_fingerprint`));
 const matchingOlderMirror=readProjection(correspondence.client,sql=>sql.replace('connector_version=?',`connector_version=?+${offset}`));
 await expectDenied({...f.env,OPS_DB:olderConnector,DELIVERY_DB:matchingOlderMirror});
 const guard=correspondenceGrantSql('grant_row');
 const count=async(sql:string)=>db.prepare(`SELECT count(*) n FROM shared_profile_portal_grants grant_row WHERE grant_row.id=? AND ${sql}`).bind(f.grantId).first<number>('n');
 expect(await count(guard)).toBe(1);
 expect(await count(guard.replace('connector.version>=',`${olderVersion}>=`))).toBe(0);
 await expectGranted();
});
it('still rejects approval when the preview changes during its capability probe',async()=>{
 const {db,correspondence}=correspondenceFixtureState();const before=await previewPortalDirectoryCorrespondence(f.env,logical);
 const head=await db.prepare('SELECT * FROM portal_directory_correspondence_heads WHERE directory_source_id=?').bind(logical).first();
 let called=false;const raced:typeof fetch=async(input,init)=>{called=true;await transition('active');return correspondence.send(input,init);};
 expect(await managePortalDirectoryCorrespondence(f.env,correspondence.actor,logical,{operationId:uuid(),action:'approve',expectedVersion:before.current!.version,expectedProofSha256:before.preview!.proofSha256},raced)).toMatchObject({ok:false,code:'rejected'});
 expect(called).toBe(true);expect(await db.prepare('SELECT * FROM portal_directory_correspondence_heads WHERE directory_source_id=?').bind(logical).first()).toEqual(head);
 await expectGranted();
});
it('does not revive an explicitly revoked bridge after a version-only resume',async()=>{
 const {correspondence}=correspondenceFixtureState();const status=await previewPortalDirectoryCorrespondence(f.env,logical);
 expect(await managePortalDirectoryCorrespondence(f.env,correspondence.actor,logical,{operationId:uuid(),action:'revoke',expectedVersion:status.current!.version,expectedProofSha256:status.current!.revocationProofSha256},correspondence.send)).toMatchObject({ok:true});
 await transition('active');await expectDenied();expect(await resolveDirectoryPortalSource(f.env,logical,tuple,approved.revision_id)).toBeNull();
});
