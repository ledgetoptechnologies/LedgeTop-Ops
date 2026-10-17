import {execFileSync} from 'node:child_process';
import {Miniflare} from 'miniflare';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createIndependentCorrespondenceFixture} from './helpers/central-correspondence-independentreview-fixture';
import {createIndependentPrimaryClientProjection} from './helpers/central-correspondence-client-projection-fixture';
import {bindNativePortalEligibility} from '../../client/src/worker/client-portal/native-portal-eligibility';
import {listClientExternalAccess} from '../src/worker/client-external-access';
import type {ClientHubCollectionContext} from '../src/worker/client-hub-collections';

let f:Awaited<ReturnType<typeof createIndependentCorrespondenceFixture>>;
beforeAll(async()=>{f=await createIndependentCorrespondenceFixture();},300_000);
afterAll(async()=>{await f?.dispose();});
it('reports a real reenrolled NULL-identity membership only with its unique current eligibility witness',async()=>{
 const db=f.client,p=await createIndependentPrimaryClientProjection(db,'a'.repeat(32));
 const env={...p.env,CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED:'true',CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED:'true',CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED:'true'};
 const actor={issuer:'https://team.test',subject:'roster-reenrollment',email:'independent-client@example.test'};
 await bindNativePortalEligibility(env,actor,actor.email);
 const identity=await db.prepare('SELECT identity_id FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(p.workspaceId,p.principalPublicId).first<string>('identity_id');expect(identity).toBeTruthy();
 await p.ingest({...p.common,sourceSequence:2,kind:'event',deliveryId:crypto.randomUUID(),event:{resource:'principal',action:'tombstone',publicId:p.principalPublicId,sourceVersion:'old-revoked-v2'}});
 const history=await db.prepare('SELECT * FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(p.workspaceId,p.principalPublicId).first();
 const oldEligibility=(await db.prepare('SELECT * FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(p.workspaceId,p.principalPublicId).all()).results;
 const current='b'.repeat(32);
 await p.ingest({...p.common,sourceSequence:3,kind:'event',deliveryId:crypto.randomUUID(),event:{resource:'principal',action:'upsert',principal:{publicId:current,emailHint:actor.email,displayName:'Current person',sourceVersion:'replacement-v1',active:true}}});
 for(const [index,grant] of p.entitlements.entries())await p.ingest({...p.common,sourceSequence:4+index,kind:'event',deliveryId:crypto.randomUUID(),event:{resource:'entitlement',action:'upsert',entitlement:{...grant,principalPublicId:current,sourceVersion:'replacement-grant-v1'}}});
 await bindNativePortalEligibility(env,actor,actor.email);
 expect(await db.prepare('SELECT identity_id FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(p.workspaceId,current).first('identity_id')).toBeNull();
 const membership=await db.prepare("SELECT id FROM portal_v2_workspace_memberships WHERE workspace_id=? AND identity_id=? AND status='active'").bind(p.workspaceId,identity).first<string>('id');expect(membership).toBeTruthy();
 const context={root:{workspace_id:p.workspaceId},canonicalRoot:{sourceId:'project-alpha:primary',rootNamespace:'business',kind:'standalone_client',publicId:p.rootPublicId},contextVersion:'roster-reenrollment'} as ClientHubCollectionContext;
 const read=(status='current')=>listClientExternalAccess({DELIVERY_DB:db},context,{status});
 const active=async()=>expect((await read()).items).toEqual([expect.objectContaining({row_key:JSON.stringify(['membership',membership]),access_status:'active',source_type:'project_alpha',assigned_access_count:2})]);
 const excluded=async()=>{expect((await read()).items).toEqual([]);expect((await read('all')).items).toEqual([expect.objectContaining({access_status:'needs_review'})]);};
 await active();
 await db.prepare("UPDATE portal_v2_identity_eligibility_bindings SET principal_source_version='stale' WHERE workspace_id=? AND principal_public_id=?").bind(p.workspaceId,current).run();await excluded();
 await db.prepare("UPDATE portal_v2_identity_eligibility_bindings SET principal_source_version='replacement-v1',verified_email='wrong@example.test' WHERE workspace_id=? AND principal_public_id=?").bind(p.workspaceId,current).run();await excluded();
 await db.prepare('DELETE FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(p.workspaceId,current).run();await excluded();
 const insert=(id:string)=>db.prepare('INSERT INTO portal_v2_identity_eligibility_bindings(identity_id,workspace_id,principal_public_id,principal_source_version,verified_email) VALUES(?,?,?,?,?)').bind(id,p.workspaceId,current,'replacement-v1',actor.email).run();
 const other=crypto.randomUUID();await db.prepare("INSERT INTO portal_v2_identities(id,issuer,subject,verified_email,status) VALUES(?,'https://team.test','different-person',?,'active')").bind(other,actor.email).run();
 await insert(other);await excluded();await insert(identity!);await excluded(); // Same email alone cannot select authority; two exact candidates are ambiguous.
 await db.prepare('DELETE FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=? AND identity_id=?').bind(p.workspaceId,current,other).run();await active();
 await db.prepare("UPDATE portal_v2_workspace_memberships SET status='revoked',revoked_at=datetime('now') WHERE id=?").bind(membership).run();
 expect((await read()).items).toEqual([]);expect((await read('all')).items).toEqual([expect.objectContaining({access_status:'revoked'})]);
 expect(await db.prepare('SELECT * FROM pa_portal_principals WHERE workspace_id=? AND public_id=?').bind(p.workspaceId,p.principalPublicId).first()).toEqual(history);
 expect((await db.prepare('SELECT * FROM portal_v2_identity_eligibility_bindings WHERE workspace_id=? AND principal_public_id=?').bind(p.workspaceId,p.principalPublicId).all()).results).toEqual(oldEligibility);
 expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},180_000);

it('compiles actual old/new schema current/all roster SELECTs at the canonical D1 expression-depth bound',async()=>{
 const old=new Miniflare({modules:true,compatibilityDate:'2026-08-06',script:'export default {}',d1Databases:{DELIVERY_DB:crypto.randomUUID()}});
 try{
  const legacy=await old.getD1Database('DELIVERY_DB') as unknown as D1Database;
  // The same genuine pre-eligibility schema used by the existing roster suite.
  await legacy.exec(`CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY,status TEXT NOT NULL,display_name TEXT);
    CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY,issuer TEXT NOT NULL,subject TEXT NOT NULL,verified_email TEXT,status TEXT NOT NULL,revoked_at TEXT);
    CREATE TABLE portal_v2_workspace_memberships(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,source_type TEXT NOT NULL,
      status TEXT NOT NULL,source_version TEXT,expires_at TEXT,revoked_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE pa_portal_principals(workspace_id TEXT NOT NULL,public_id TEXT NOT NULL,identity_id TEXT,display_name TEXT NOT NULL,status TEXT NOT NULL,source_version TEXT NOT NULL);
    CREATE TABLE portal_v2_entitlements(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,identity_id TEXT NOT NULL,effect TEXT NOT NULL,status TEXT NOT NULL,
      valid_from TEXT NOT NULL,expires_at TEXT,revoked_at TEXT);
    CREATE TABLE portal_v2_identity_eligibility_blocks(id TEXT PRIMARY KEY,match_type TEXT NOT NULL,normalized_email TEXT,issuer TEXT,subject TEXT,
      status TEXT NOT NULL,valid_from TEXT NOT NULL,expires_at TEXT);
    CREATE TABLE portal_v2_invitations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,token_hash TEXT NOT NULL,invited_email TEXT NOT NULL,
      accepted_by_identity_id TEXT,status TEXT NOT NULL,expires_at TEXT,revoked_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE portal_v2_invitation_entitlements(invitation_id TEXT NOT NULL,capability TEXT NOT NULL);`.replace(/\s*\n\s*/g,' '));
  const queries:{sql:string;params:unknown[]}[]=[];
  const capture=(db:D1Database)=>({withSession:()=>({prepare(sql:string){
   const query={sql,params:[] as unknown[]};if(sql.startsWith('WITH membership_rows'))queries.push(query);
   const prepared=db.prepare(sql);
   return new Proxy(prepared,{get(target,key){if(key==='bind')return(...params:unknown[])=>{query.params=params;return target.bind(...params);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  }})}) as unknown as D1Database;
  const context={root:{workspace_id:'not-present'},canonicalRoot:{sourceId:'project-alpha:primary',rootNamespace:'business',kind:'organization',publicId:'not-present'},contextVersion:'depth-check'} as ClientHubCollectionContext;
  for(const db of [legacy,f.client])for(const status of ['current','all'])expect((await listClientExternalAccess({DELIVERY_DB:capture(db)},context,{status})).items).toEqual([]);
  expect(queries).toHaveLength(4);
  const schema=(await f.client.prepare("SELECT sql FROM sqlite_master WHERE type IN('table','view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all<{sql:string}>()).results;
  const compiled=execFileSync(process.platform==='win32'?'python':'python3',['-c',`
import json,sqlite3,sys
packet=json.load(sys.stdin);db=sqlite3.connect(':memory:')
for row in packet['schema']:db.execute(row['sql'])
db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100)
for query in packet['queries']:db.execute('EXPLAIN '+query['sql'],query['params']).fetchall()
print(len(packet['queries']))
`],{input:JSON.stringify({schema,queries}),encoding:'utf8',maxBuffer:20_000_000});
  expect(Number(compiled.trim())).toBe(4);
 }finally{await old.dispose();}
},60_000);
