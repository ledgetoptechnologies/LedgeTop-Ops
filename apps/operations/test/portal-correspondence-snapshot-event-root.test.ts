import {execFileSync} from "node:child_process";
import {afterAll,beforeAll,expect,it} from 'vitest';
import {initializeCorrespondenceComposerFixture,disposeCorrespondenceComposerFixture,createReviewedCorrespondenceGroup} from './helpers/shared-profile-correspondence-fixture';
import {createIndependentPrimaryClientProjection} from './helpers/central-correspondence-client-projection-fixture';
import {aliasWorkspaceWitnessSql} from '../src/worker/portal-directory-correspondence';
import {resolveClientHubWorkspaces} from '../src/worker/client-hub-workspace';
import {findClientHubRoot} from '../src/worker/client-hub-directory';
import {reconcileClientHubIndex} from '../src/worker/client-hub-index';
import type {Env} from '../src/worker/types';

type CapturedQuery={sql:string;params:unknown[]};
function capture<T extends D1Database|D1DatabaseSession>(db:T,queries:CapturedQuery[]):T{
 return new Proxy(db,{get(target,key){
  if(key==='prepare')return(sql:string)=>{const query={sql,params:[] as unknown[]};queries.push(query);const statement=target.prepare(sql);
   return new Proxy(statement,{get(prepared,method){if(method==='bind')return(...params:unknown[])=>{query.params=params;return prepared.bind(...params);};const value=Reflect.get(prepared,method);return typeof value==='function'?value.bind(prepared):value;}});};
  if(key==='withSession'&&'withSession'in target)return(constraint?:D1SessionBookmark|D1SessionConstraint)=>capture(target.withSession(constraint),queries);
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
async function compileConsumers(ops:D1Database,client:D1Database,opsQueries:CapturedQuery[],clientQueries:CapturedQuery[]){
 const schema=async(db:D1Database)=>(await db.prepare("SELECT sql FROM sqlite_master WHERE type IN('table','view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all<{sql:string}>()).results;
 const databases=[{schema:await schema(ops),queries:opsQueries},{schema:await schema(client),queries:clientQueries}];
 const output=execFileSync(process.platform==='win32'?'python':'python3',['-c',`
import json,sqlite3,sys
packet=json.load(sys.stdin);count=0
for part in packet:
 db=sqlite3.connect(':memory:')
 for row in part['schema']:db.execute(row['sql'])
 db.setlimit(sqlite3.SQLITE_LIMIT_EXPR_DEPTH,100)
 for q in part['queries']:
  if not q['sql'].lstrip().upper().startswith(('SELECT','WITH')):continue
  db.execute('EXPLAIN '+q['sql'],q['params']).fetchall();count+=1
 db.close()
print(count)
`],{input:JSON.stringify(databases),encoding:'utf8',maxBuffer:20_000_000});
 expect(Number(output.trim())).toBeGreaterThan(10);
}

beforeAll(initializeCorrespondenceComposerFixture,300_000);
afterAll(disposeCorrespondenceComposerFixture);
async function finish(env:Env){
 await env.OPS_DB.prepare('UPDATE client_hub_directory_state SET next_run_at=NULL').run();
 for(let i=0;i<30;i++){
  const r=await reconcileClientHubIndex(env,40);if(r.status==='complete')return;expect(r.status).toBe('progress');
 }
 throw Error('Index did not complete in bounded passes');
}

it.each(['organization','standalone_client'] as const)('proves the %s root entity independently of its workspace header across genuine signed events',async rootType=>{
 const f=await createReviewedCorrespondenceGroup(true),record=f.records[0]!;
 const publicId=f.publicIds.get(record.input.recordId)!;
 const client=f.correspondence.client,opsQueries:CapturedQuery[]=[],clientQueries:CapturedQuery[]=[];
 const capturedClient=capture(client,clientQueries),capturedEnv={...f.env,OPS_DB:capture(f.env.OPS_DB,opsQueries),DELIVERY_DB:capturedClient};
 const p=await createIndependentPrimaryClientProjection(client,publicId,{rootType,workspaceVersion:'workspace-header-v1',rootEntityVersion:'root-entity-v1'});
 await f.correspondence.approve();
 const witness=async()=>await capturedClient.prepare(`SELECT ${aliasWorkspaceWitnessSql('workspace')} allowed FROM portal_v2_workspaces workspace WHERE workspace.id=?`).bind(p.workspaceId).first<number>('allowed');
 const lookup={key:'alias',source_id:'project-alpha:staging',kind:rootType,business_id:record.input.recordId,pa_public_id:publicId,workspace_id:null};
 const linked=async()=>await resolveClientHubWorkspaces(capturedEnv,[lookup,{...lookup,key:'same-id',source_id:'project-alpha:primary'}]);
 expect(await witness()).toBe(1); // Header and entity versions were never required to be equal by the wire contract.
 if(rootType==='standalone_client'){
  expect((await linked()).get('alias')).toMatchObject({status:'mapped',workspace:{id:p.workspaceId}});
  await finish(capturedEnv);
  expect(await findClientHubRoot(capturedEnv,rootType,record.input.recordId,'project-alpha:staging','business')).toMatchObject({workspace_id:p.workspaceId});
 }
 const checkpoint=()=>client.prepare('SELECT active_generation_id,source_sequence FROM portal_v2_directory_checkpoints WHERE workspace_id=?').bind(p.workspaceId).first<{active_generation_id:string;source_sequence:number}>();
 const first=(await checkpoint())!;
 await client.prepare('UPDATE portal_v2_directory_entities SET source_version=? WHERE workspace_id=? AND generation_id=? AND parent_public_id IS NULL').bind('unproven-change',p.workspaceId,first.active_generation_id).run();
 expect(await witness()).toBe(0); // Snapshot proof still requires the exact staged root entity version.
 await client.prepare('UPDATE portal_v2_directory_entities SET source_version=? WHERE workspace_id=? AND generation_id=? AND parent_public_id IS NULL').bind('root-entity-v1',p.workspaceId,first.active_generation_id).run();
 const principal={publicId:p.principalPublicId,emailHint:'independent-client@example.test',displayName:'Independent Client',sourceVersion:'principal-v2',active:true};
 const principalEventId=crypto.randomUUID();
 await p.ingest({...p.common,kind:'event',sourceSequence:2,deliveryId:principalEventId,event:{action:'upsert',resource:'principal',principal}});
 expect(await witness()).toBe(1); // Principal-only event retains the root version and selected original snapshot.
 const rootEventId=crypto.randomUUID();
 await p.ingest({...p.common,kind:'event',sourceSequence:3,deliveryId:rootEventId,event:{action:'upsert',resource:'entity',entity:{type:rootType,publicId,parentPublicId:null,displayName:'Updated root',sourceVersion:'root-entity-v2',active:true,primaryContact:false}}});
 expect(await witness()).toBe(1);
 await p.ingest({...p.common,kind:'event',sourceSequence:4,deliveryId:crypto.randomUUID(),event:{action:'upsert',resource:'principal',principal:{...principal,sourceVersion:'principal-v3'}}});
 expect(await witness()).toBe(1); // Later unrelated events carry forward the legitimately changed root.
 const cp=(await checkpoint())!;
 expect(await client.prepare('SELECT source_version FROM portal_v2_directory_entities WHERE workspace_id=? AND generation_id=? AND parent_public_id IS NULL').bind(p.workspaceId,cp.active_generation_id).first('source_version')).toBe('root-entity-v2');
 expect(await client.prepare('SELECT workspace_source_version FROM pa_portal_projection_generations WHERE id=(SELECT snapshot_generation_id FROM pa_portal_projection_checkpoints WHERE workspace_id=?)').bind(p.workspaceId).first('workspace_source_version')).toBe('workspace-header-v1');
 if(rootType==='standalone_client'){
  expect((await linked()).get('alias')).toMatchObject({status:'mapped',workspace:{id:p.workspaceId}});
  expect((await linked()).get('same-id')).toMatchObject({status:'mapped',workspace:{id:p.workspaceId}});
  await finish(capturedEnv);
  expect(await findClientHubRoot(capturedEnv,rootType,record.input.recordId,'project-alpha:staging','business')).toMatchObject({workspace_id:p.workspaceId});
 }
 // Each negative has its own receiver-created workspace. Canonical immutable
 // ownership and monotonic checkpoint guards remain installed and are never rolled back.
 for(const negative of [
  {receipt:null,audit:false,status:'active',source:null},
  {receipt:'completed',audit:false,status:'active',source:null},
  {receipt:'ignored',audit:true,status:'active',source:null},
  {receipt:'completed',audit:true,status:'staging',source:null},
  {receipt:null,audit:false,status:'active',source:'legacy-backfill'},
 ] as const){
  const q=await createIndependentPrimaryClientProjection(client,crypto.randomUUID().replaceAll('-',''),{rootType,workspaceVersion:'independent-header',rootEntityVersion:'independent-entity'});
  const before=(await client.prepare('SELECT active_generation_id FROM portal_v2_directory_checkpoints WHERE workspace_id=?').bind(q.workspaceId).first<{active_generation_id:string}>())!;
  const id=crypto.randomUUID(),deliveryId=crypto.randomUUID(),sequence=2;
  const source=negative.source??'event-'+deliveryId;
  await client.prepare("UPDATE portal_v2_directory_generations SET status='superseded' WHERE id=?").bind(before.active_generation_id).run();
  await client.prepare('INSERT INTO portal_v2_directory_generations(id,workspace_id,source_generation,source_sequence,status,complete) VALUES(?,?,?,?,?,1)').bind(id,q.workspaceId,source,sequence,negative.status).run();
  await client.prepare(`INSERT INTO portal_v2_directory_entities(workspace_id,generation_id,entity_type,public_id,parent_public_id,display_name,source_version,active,primary_contact)
    SELECT workspace_id,?,entity_type,public_id,parent_public_id,display_name,source_version,active,primary_contact FROM portal_v2_directory_entities WHERE workspace_id=? AND generation_id=?`).bind(id,q.workspaceId,before.active_generation_id).run();
  if(negative.receipt)await client.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status,write_guard) VALUES('project-alpha:primary',?,?,'event',?,?,?,1)`).bind(deliveryId,q.workspaceId,'b'.repeat(64),sequence,negative.receipt).run();
  if(negative.audit)await client.prepare(`INSERT INTO pa_portal_projection_audit(id,workspace_id,action,delivery_id,source_generation,source_sequence,details_json) VALUES(?,?,'event_upserted',?,?,?,'{}')`).bind(crypto.randomUUID(),q.workspaceId,deliveryId,q.common.sourceGeneration,sequence).run();
  const select=client.prepare('UPDATE portal_v2_directory_checkpoints SET active_generation_id=?,source_sequence=? WHERE workspace_id=?').bind(id,sequence,q.workspaceId).run();
  if(negative.status==='staging')await expect(select).rejects.toThrow(/checkpoint requires a complete active generation/);
  else await select;
  await client.prepare('UPDATE pa_portal_projection_checkpoints SET source_sequence=? WHERE workspace_id=?').bind(sequence,q.workspaceId).run();
  expect(await capturedClient.prepare(`SELECT ${aliasWorkspaceWitnessSql('workspace')} allowed FROM portal_v2_workspaces workspace WHERE workspace.id=?`).bind(q.workspaceId).first('allowed')).toBe(0);
 }
 for(const [column,bad,good] of [['parent_public_id',publicId,null],['public_id','f'.repeat(32),publicId],['active',0,1],['entity_type',rootType==='organization'?'standalone_client':'organization',rootType]] as const){
  await client.prepare(`UPDATE portal_v2_directory_entities SET ${column}=? WHERE workspace_id=? AND generation_id=? AND public_id=?`).bind(bad,p.workspaceId,cp.active_generation_id,publicId).run();expect(await witness()).toBe(0);
  await client.prepare(`UPDATE portal_v2_directory_entities SET ${column}=? WHERE workspace_id=? AND generation_id=? AND public_id=?`).bind(good,p.workspaceId,cp.active_generation_id,column==='public_id'?bad:publicId).run();expect(await witness()).toBe(1);
 }
 for(const wrong of ['stream','sequence'] as const){
  const q=await createIndependentPrimaryClientProjection(client,crypto.randomUUID().replaceAll('-',''),{rootType,workspaceVersion:'separate-header',rootEntityVersion:'separate-entity'});
  await client.prepare(wrong==='stream'?'UPDATE pa_portal_projection_checkpoints SET source_generation=? WHERE workspace_id=?':'UPDATE pa_portal_projection_checkpoints SET source_sequence=? WHERE workspace_id=?').bind(wrong==='stream'?'wrong-stream':2,q.workspaceId).run();
  expect(await capturedClient.prepare(`SELECT ${aliasWorkspaceWitnessSql('workspace')} allowed FROM portal_v2_workspaces workspace WHERE workspace.id=?`).bind(q.workspaceId).first('allowed')).toBe(0);
 }
 const wrongSource='project-alpha:wrong-producer';
 await expect(client.prepare(`INSERT INTO pa_portal_projection_receipts(projection_source_id,delivery_id,workspace_id,delivery_kind,payload_hash,source_sequence,status,write_guard) VALUES(?,?,?,'event',?,3,'completed',1)`).bind(wrongSource,crypto.randomUUID(),p.workspaceId,'a'.repeat(64)).run()).rejects.toThrow();
 const refreshed={...p.common,sourceGeneration:'refresh-'+crypto.randomUUID(),sourceSequence:5,snapshotHash:'d'.repeat(64),pageCount:1,recordCount:2+p.entitlements.length};
 await p.ingest({...refreshed,kind:'snapshot.page',deliveryId:crypto.randomUUID(),pageNumber:1,
  workspace:{publicId:p.workspaceId,rootType,rootPublicId:publicId,displayName:'Refreshed',sourceVersion:'workspace-header-v2',active:true},
  entities:[{type:rootType,publicId,parentPublicId:null,displayName:'Refreshed root',sourceVersion:'root-entity-v3',active:true,primaryContact:false}],
  principals:[{...principal,sourceVersion:'principal-v4'}],entitlements:p.entitlements});
 await p.ingest({...refreshed,kind:'snapshot.activate',deliveryId:crypto.randomUUID()});
 expect(await witness()).toBe(1);
 if(rootType==='standalone_client')expect((await linked()).get('alias')).toMatchObject({status:'mapped',workspace:{id:p.workspaceId}});
 await compileConsumers(f.env.OPS_DB,client,opsQueries,clientQueries);
 expect((await client.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
},300_000);
