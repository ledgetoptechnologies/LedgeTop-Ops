'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const express=require('express');
const {DatabaseSync}=require('node:sqlite');
const {MIGRATIONS,applyMigrations,openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {createProcessingApi}=require('../server/processingApi');
const auth=require('../server/auth');
const contract=require('./fixtures/workspace-hierarchy.contract.json');
const hierarchy=require('../server/workspaceHierarchy');

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-hierarchy-')),db=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(db);t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});return{db,processing};}
function mutate(processing,fn){return processing.auditedMutation({actorId:'synthetic:operator',action:'test.hierarchy',entityType:'test'},fn);}
function snapshot(db,tables){return Object.fromEntries(tables.map(table=>[table,JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())]));}

test('v40 upgrade adds only metadata tables and preserves projects, tasks and grants byte for byte',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');
  for(const migration of MIGRATIONS.filter(item=>item.version<=40)){db.exec(migration.sql);migration.after?.(db);db.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(migration.version,migration.name,'2026-01-01T00:00:00Z');}
  db.exec(`INSERT INTO projects(id,display_name,created_at,updated_at,tags_json,metadata_json) VALUES ('synthetic-project','Legacy','t','t','["legacy"]','{"unchanged":true}');
    INSERT INTO datasets(id,project_id,display_name,storage_mode,root_key,relative_path,status,created_at,updated_at) VALUES ('synthetic-data','synthetic-project','Source','managed','datasets','synthetic-data','finalized','t','t');
    INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) VALUES ('synthetic-task','synthetic-project','synthetic-data','Task','draft','t','t');
    INSERT INTO models(id,provider,provider_model_id,display_name,status,created_at,updated_at) VALUES ('synthetic-model','test','synthetic-model','Model','ready','t','t');
    INSERT INTO session_grants(id,model_id,subject,audience,permissions_json,expires_at,created_at) VALUES ('synthetic-grant','synthetic-model','synthetic-user','ops','["view"]','2099-01-01T00:00:00Z','t');`);
  const tables=['projects','datasets','processing_tasks','models','session_grants'],before=snapshot(db,tables);
  applyMigrations(db);assert.deepEqual(snapshot(db,tables),before);
  const processing=new ProcessingRepository(db),project=processing.getProject('synthetic-project');
  for(const[key,value]of Object.entries(contract.projectHierarchyDefaults))assert.equal(project[key],value);
  assert.deepEqual(processing.listHierarchyPage(),{schemaVersion:1,organizations:[],groups:[],nextCursor:null});
  assert.equal(db.prepare('SELECT count(*) n FROM viewer_project_hierarchy').get().n,0);
  assert.deepEqual(processing.listProjects()[0],project);assert.equal(processing.getTask('synthetic-task').id,'synthetic-task');
});

test('a conflicting migration identity refuses before repository preset writes',t=>{
  const{db}=fixture(t);
  db.prepare('UPDATE schema_migrations SET name=? WHERE version=?').run('another_component',hierarchy.MIGRATION_VERSION);
  const tables=['projects','session_grants','viewer_sessions','public_shares','processing_presets','audit_events'];
  const before=snapshot(db,tables);
  assert.throws(()=>new ProcessingRepository(db),{code:'hierarchy_schema_conflict'});
  assert.deepEqual(snapshot(db,tables),before);
});

test('an old private hierarchy footprint is not silently adopted under the new migration',t=>{
  const{db}=fixture(t);
  db.prepare('UPDATE schema_migrations SET version=41 WHERE version=?').run(hierarchy.MIGRATION_VERSION);
  assert.throws(()=>new ProcessingRepository(db),{code:'hierarchy_schema_conflict'});
});

test('a separately applied lower migration is not skipped after hierarchy version 42',t=>{
  const{db}=fixture(t),original=MIGRATIONS.slice();
  assert.equal(hierarchy.MIGRATION_VERSION,42);
  assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE version=41').get(),undefined);
  try{
    MIGRATIONS.splice(MIGRATIONS.findIndex(item=>item.version===42),0,
      {version:41,name:'synthetic_independent_component',sql:'CREATE TABLE synthetic_component_preserved(id TEXT PRIMARY KEY)'});
    applyMigrations(db);
    assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=41').get().name,'synthetic_independent_component');
    assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=42').get().name,hierarchy.MIGRATION_NAME);
    assert.equal(hierarchy.assertDatabase(db),true);
  }finally{MIGRATIONS.splice(0,MIGRATIONS.length,...original);}
});

test('metadata CRUD and assignment CAS are atomic and never alter authorization or project rows',t=>{
  const{db,processing:p}=fixture(t),project=p.createProject({displayName:'Legacy',tags:['survey'],metadata:{keep:true}});
  const tables=['projects','session_grants','viewer_sessions','public_shares'],before=snapshot(db,tables);
  const org=mutate(p,()=>p.createHierarchyEntity('organization',{displayName:'Organization'}));
  const second=mutate(p,()=>p.createHierarchyEntity('organization',{displayName:'Other'}));
  const group=mutate(p,()=>p.createHierarchyEntity('group',{organizationId:org.id,displayName:'Group'}));
  assert.throws(()=>mutate(p,()=>p.assignProjectHierarchy(project.id,{organizationId:second.id,groupId:group.id,expectedRevision:0})),{code:'group_organization_mismatch'});
  const assigned=mutate(p,()=>p.assignProjectHierarchy(project.id,{organizationId:org.id,groupId:group.id,expectedRevision:0}));
  assert.equal(assigned.hierarchyRevision,1);assert.equal(assigned.groupId,group.id);
  const audits=db.prepare('SELECT count(*) n FROM audit_events').get().n;
  assert.throws(()=>mutate(p,()=>p.assignProjectHierarchy(project.id,{organizationId:null,groupId:null,expectedRevision:0})),{code:'hierarchy_revision_conflict'});
  assert.equal(db.prepare('SELECT count(*) n FROM audit_events').get().n,audits);
  assert.throws(()=>mutate(p,()=>p.updateHierarchyEntity('organization',org.id,{displayName:'Stale',expectedRevision:0})),{code:'hierarchy_revision_conflict'});
  const renamed=mutate(p,()=>p.updateHierarchyEntity('group',group.id,{displayName:'Renamed',expectedRevision:1}));assert.equal(renamed.revision,2);
  mutate(p,()=>p.updateHierarchyEntity('organization',org.id,{status:'archived',expectedRevision:1}));
  assert.equal(p.getProject(project.id).groupId,group.id);assert.deepEqual(snapshot(db,tables),before);
  assert.throws(()=>mutate(p,()=>p.assignProjectHierarchy(project.id,{organizationId:org.id,groupId:group.id,expectedRevision:1})),{code:'organization_archived'});
  const cleared=mutate(p,()=>p.assignProjectHierarchy(project.id,{organizationId:null,groupId:null,expectedRevision:1}));assert.equal(cleared.hierarchyRevision,2);assert.equal(cleared.organizationId,null);
  const audit=p.insertAudit;p.insertAudit=()=>{throw new Error('synthetic audit unavailable');};
  assert.throws(()=>mutate(p,()=>p.assignProjectHierarchy(project.id,{organizationId:second.id,groupId:null,expectedRevision:2})),/synthetic audit unavailable/);p.insertAudit=audit;
  assert.equal(p.getProject(project.id).hierarchyRevision,2);assert.equal(p.getProject(project.id).organizationId,null);
  assert.throws(()=>mutate(p,()=>p.assignProjectHierarchy('missing',{organizationId:null,groupId:null,expectedRevision:0})),{code:'project_not_found'});
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('hierarchy paging is bounded and returns closed metadata DTOs including archived rows',t=>{
  const{processing:p}=fixture(t);for(let i=0;i<5;i++)mutate(p,()=>p.createHierarchyEntity('organization',{displayName:`Synthetic ${i}`}));
  const first=p.listHierarchyPage({limit:2});assert.equal(first.organizations.length,2);assert.ok(first.nextCursor);
  mutate(p,()=>p.updateHierarchyEntity('organization',first.organizations[0].id,{status:'archived',expectedRevision:1}));
  const seen=new Set();let cursor=null;do{const page=p.listHierarchyPage({limit:2,cursor});for(const org of page.organizations){assert.deepEqual(Object.keys(org).sort(),['displayName','id','revision','status']);assert.ok(!seen.has(org.id));seen.add(org.id);}cursor=page.nextCursor;}while(cursor);assert.equal(seen.size,5);
  assert.throws(()=>p.listHierarchyPage({cursor:'bad-cursor'}),{code:'invalid_page'});
});

async function apiFixture(t){
  const c=fixture(t),app=express();app.use(express.json({verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer);}}));app.use(createProcessingApi({repository:new ViewerRepository(c.db),processing:c.processing,storage:{}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  c.token=permissions=>{const token=crypto.randomBytes(32).toString('base64url');c.processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'synthetic:operator',permissions,displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});return token;};
  c.admin=c.token(['viewer.projects.read','viewer.projects.write']);
  c.request=(route,{method='GET',body,token=c.admin,key=crypto.randomUUID()}={})=>fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return c;
}

test('hierarchy API enforces permission, mutate receipts, closed fields and CAS',async t=>{
  const c=await apiFixture(t),route='/api/v1/processing/organizations',body={displayName:'Synthetic Organization'};
  const read=c.token(['viewer.projects.read']),wrong=c.token(['viewer.datasets.write']);
  assert.equal((await c.request(route,{method:'POST',body,token:read})).status,403);
  assert.equal((await c.request(route,{method:'POST',body,token:''})).status,401);
  assert.equal((await c.request('/api/v1/processing/hierarchy',{token:wrong})).status,403);
  assert.equal((await c.request(route,{method:'POST',body,key:null})).status,428);
  assert.equal((await c.request(route,{method:'POST',body:{...body,clientId:'no'}})).status,400);
  const key=crypto.randomUUID(),created=await c.request(route,{method:'POST',body,key});assert.equal(created.status,201);const org=(await created.json()).organization;
  const replay=await c.request(route,{method:'POST',body,key});assert.equal(replay.status,201);assert.deepEqual((await replay.json()).organization,org);
  const list=await(await c.request('/api/v1/processing/hierarchy',{token:read})).json();assert.equal(list.capabilities.manageHierarchy,false);assert.deepEqual(list.organizations,[org]);
  const update=`${route}/${org.id}`;assert.equal((await c.request(update,{method:'PATCH',body:{expectedRevision:0,status:'archived'}})).status,409);
  const groupResponse=await c.request('/api/v1/processing/project-groups',{method:'POST',body:{displayName:'Synthetic Group',organizationId:org.id}});assert.equal(groupResponse.status,201);const group=(await groupResponse.json()).group;
  assert.equal((await c.request(`/api/v1/processing/project-groups/${group.id}`,{method:'PATCH',body:{displayName:'New group',organizationId:'wrong',expectedRevision:1}})).status,400);
  assert.equal((await c.request(`/api/v1/processing/project-groups/${group.id}`,{method:'PATCH',body:{displayName:'New group',expectedRevision:1}})).status,200);
  const otherResponse=await c.request(route,{method:'POST',body:{displayName:'Other Synthetic'}}),other=(await otherResponse.json()).organization;
  const project=c.processing.createProject({displayName:'Flat project'}),assignment=`/api/v1/projects/${project.id}/hierarchy`;
  assert.equal((await c.request(assignment,{method:'PATCH',body:{organizationId:other.id,groupId:group.id,expectedRevision:0}})).status,400);
  assert.equal((await c.request(assignment,{method:'PATCH',body:{organizationId:org.id,groupId:null,expectedRevision:0,clientId:'forbidden'}})).status,400);
  assert.equal((await c.request(assignment,{method:'PATCH',body:{organizationId:org.id,groupId:null,expectedRevision:0},token:read})).status,403);
  assert.equal((await c.request(assignment,{method:'PATCH',body:{organizationId:org.id,groupId:null,expectedRevision:0}})).status,200);
  assert.equal((await c.request(assignment,{method:'PATCH',body:{organizationId:null,groupId:null,expectedRevision:0}})).status,409);
  const listed=await(await c.request('/api/v1/projects')).json(),fetched=await(await c.request(`/api/v1/projects/${project.id}`)).json();assert.deepEqual(listed.projects,[fetched.project]);assert.equal(fetched.project.organizationId,org.id);
  assert.equal((await c.request(update,{method:'PATCH',body:{expectedRevision:1,status:'archived'}})).status,200);
  assert.equal((await c.request(`/api/v1/projects/${project.id}`)).status,200);
});
