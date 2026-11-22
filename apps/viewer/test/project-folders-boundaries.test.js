'use strict';
// Folder boundary checks: migration 48, nesting, naming, concurrency and
// route permissions. All data is synthetic.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {Worker}=require('node:worker_threads');
const {openDatabase,MIGRATIONS}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {createProcessingApi}=require('../server/processingApi');
const auth=require('../server/auth'),express=require('express');

// Remove temporary roots only after every test has closed its databases.
const roots=[];test.after(()=>{for(const root of roots)fs.rmSync(root,{recursive:true,force:true,maxRetries:5});});
function tempRoot(t,label){const root=fs.mkdtempSync(path.join(os.tmpdir(),`viewer-folders-${label}-`));roots.push(root);return root;}
function migrateThrough(dbPath,through){
  const db=new DatabaseSync(dbPath);db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const migration of MIGRATIONS.filter(item=>item.version<=through)){db.exec('BEGIN IMMEDIATE');db.exec(migration.sql);migration.after?.(db);db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(migration.version,migration.name,new Date().toISOString());db.exec('COMMIT');}
  return db;
}
function seedTask(p,project,label='Task'){
  const source=p.createDataset({projectId:project.id,displayName:`${label} source`,storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  p.finalizeDataset(source.id,[],crypto.createHash('sha256').update('').digest('hex'));
  return p.createTask({projectId:project.id,datasetId:source.id,displayName:label});
}
const folderObjects=db=>db.prepare("SELECT type,name FROM sqlite_master WHERE name IN ('project_folders','project_folders_sibling_name_idx','processing_tasks_folder_idx','processing_task_folder_project_insert','processing_task_folder_project_update') ORDER BY name").all().map(row=>`${row.type}:${row.name}`);

test('folder migration is uniquely registered at version 48 and keeps the runner order',()=>{
  const folder=MIGRATIONS.find(item=>item.name==='project_organizational_folders');
  assert.equal(folder.version,48);
  assert.equal(MIGRATIONS.filter(item=>item.version===48).length,1);
  const versions=MIGRATIONS.map(item=>item.version);
  assert.deepEqual(versions,[...new Set(versions)].sort((a,b)=>a-b));
});

test('migration 48 builds the folder schema on an empty database and is a no-op on re-run',t=>{
  const dbPath=path.join(tempRoot(t,'empty'),'db.sqlite');
  let db=openDatabase(dbPath);
  assert.equal(folderObjects(db).length,5);
  assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v,MIGRATIONS.at(-1).version);
  const stamp=db.prepare('SELECT applied_at FROM schema_migrations WHERE version=48').get().applied_at;
  db.close();db=openDatabase(dbPath);t.after(()=>db.close());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=48').get().n,1);
  assert.equal(db.prepare('SELECT applied_at FROM schema_migrations WHERE version=48').get().applied_at,stamp,'re-run does not re-apply');
  assert.equal(folderObjects(db).length,5);
});

test('migration 48 on a populated v42 database keeps every task at project root, then re-runs cleanly with folder data present',t=>{
  const dbPath=path.join(tempRoot(t,'populated'),'db.sqlite');
  let db=migrateThrough(dbPath,42),p=new ProcessingRepository(db);
  const project=p.createProject({displayName:'Synthetic existing'}),tasks=[seedTask(p,project,'One'),seedTask(p,project,'Two')];
  const before=db.prepare('SELECT id,project_id,dataset_id,status,published_model_id FROM processing_tasks ORDER BY id').all();
  db.close();db=openDatabase(dbPath);p=new ProcessingRepository(db);
  assert.deepEqual(db.prepare('SELECT id,project_id,dataset_id,status,published_model_id FROM processing_tasks ORDER BY id').all(),before);
  for(const task of tasks)assert.equal(p.getTask(task.id).folderId,null);
  const folder=p.createProjectFolder(project.id,{displayName:'After upgrade'},'staff');p.moveTaskToFolder(tasks[0].id,folder.id,'staff');
  db.close();db=openDatabase(dbPath);t.after(()=>db.close());p=new ProcessingRepository(db);
  assert.equal(p.getTask(tasks[0].id).folderId,folder.id,'re-run keeps folder membership');
  assert.equal(p.projectFolders(project.id).length,1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('unstamped folder objects from an unmerged candidate are refused without rewriting history',t=>{
  const dbPath=path.join(tempRoot(t,'conflict'),'db.sqlite');
  let db=migrateThrough(dbPath,42);
  db.exec("CREATE TABLE project_folders (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT, display_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
  db.close();
  assert.throws(()=>openDatabase(dbPath),{code:'viewer_migration_history_conflict'});
  db=new DatabaseSync(dbPath,{readOnly:true});t.after(()=>db.close());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE version=48').get().n,0);
  assert.equal(db.prepare('PRAGMA table_info(processing_tasks)').all().some(column=>column.name==='folder_id'),false,'failed migration rolled back');
});

test('nesting depth is bounded and a corrupted parent cycle cannot hang folder creation',t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const p=new ProcessingRepository(db),project=p.createProject({displayName:'Synthetic depth'});
  let parentId=null;
  for(let level=1;level<=16;level++)parentId=p.createProjectFolder(project.id,{displayName:`Level ${level}`,parentId},'staff').id;
  assert.throws(()=>p.createProjectFolder(project.id,{displayName:'Too deep',parentId},'staff'),{code:'folder_depth_exceeded'});
  const a=p.createProjectFolder(project.id,{displayName:'A'},'staff'),b=p.createProjectFolder(project.id,{displayName:'B',parentId:a.id},'staff');
  // No route re-parents a folder; simulate a direct-SQL corruption instead.
  db.prepare('UPDATE project_folders SET parent_id=? WHERE id=?').run(b.id,a.id);
  assert.throws(()=>p.createProjectFolder(project.id,{displayName:'Inside cycle',parentId:a.id},'staff'),{code:'folder_depth_exceeded'});
  assert.equal(p.projectFolders(project.id).some(row=>row.displayName==='Inside cycle'),false);
});

test('sibling names are unique case-insensitively (ASCII) per parent, trimmed, and validated',t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const p=new ProcessingRepository(db),project=p.createProject({displayName:'Synthetic names'}),other=p.createProject({displayName:'Synthetic other'});
  const site=p.createProjectFolder(project.id,{displayName:'  Site North  '},'staff');
  assert.equal(site.displayName,'Site North');
  for(const name of ['site north','SITE NORTH',' Site North'])assert.throws(()=>p.createProjectFolder(project.id,{displayName:name},'staff'),{code:'folder_name_conflict'});
  assert.ok(p.createProjectFolder(project.id,{displayName:'Site North',parentId:site.id},'staff'),'same name under a different parent');
  assert.ok(p.createProjectFolder(other.id,{displayName:'Site North'},'staff'),'same name in another project');
  for(const name of ['','   ','x'.repeat(161),'bad\nname'])assert.throws(()=>p.createProjectFolder(project.id,{displayName:name},'staff'),{code:'invalid_folder_name'});
  // The database index enforces the rule even if the repository is bypassed.
  assert.throws(()=>db.prepare('INSERT INTO project_folders(id,project_id,parent_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),project.id,null,'SITE north','t','t'),/UNIQUE/);
  // Parent must be in the same project at the database level as well.
  assert.throws(()=>db.prepare('INSERT INTO project_folders(id,project_id,parent_id,display_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),other.id,site.id,'Cross','t','t'),/FOREIGN KEY/);
});

test('tasks cannot be moved or inserted across projects, and archived projects are read-only',t=>{
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const p=new ProcessingRepository(db),project=p.createProject({displayName:'Synthetic A'}),other=p.createProject({displayName:'Synthetic B'});
  const task=seedTask(p,project),foreign=p.createProjectFolder(other.id,{displayName:'Foreign'},'staff');
  assert.throws(()=>p.moveTaskToFolder(task.id,foreign.id,'staff'),{code:'invalid_folder'});
  assert.throws(()=>db.prepare('UPDATE processing_tasks SET folder_id=? WHERE id=?').run(foreign.id,task.id),/folder_project_mismatch/);
  const local=p.createProjectFolder(project.id,{displayName:'Local'},'staff');p.moveTaskToFolder(task.id,local.id,'staff');
  assert.throws(()=>db.prepare('UPDATE processing_tasks SET project_id=? WHERE id=?').run(other.id,task.id),/folder_project_mismatch|FOREIGN KEY|constraint/i);
  const row=db.prepare('SELECT project_id,folder_id FROM processing_tasks WHERE id=?').get(task.id);
  assert.deepEqual({...row},{project_id:project.id,folder_id:local.id});
  db.prepare("UPDATE projects SET status='archived' WHERE id=?").run(project.id);
  assert.throws(()=>p.moveTaskToFolder(task.id,null,'staff'),{code:'task_unavailable'});
  assert.throws(()=>p.createProjectFolder(project.id,{displayName:'Late'},'staff'),{code:'project_unavailable'});
});

test('a folder deleted before a concurrent move commits makes the move fail cleanly with no orphaned task',{timeout:5000},async t=>{
  const root=tempRoot(t,'race-delete'),dbPath=path.join(root,'db.sqlite'),db=openDatabase(dbPath);
  const p=new ProcessingRepository(db),project=p.createProject({displayName:'Synthetic race'}),task=seedTask(p,project);
  const home=p.createProjectFolder(project.id,{displayName:'Home'},'staff'),target=p.createProjectFolder(project.id,{displayName:'Target'},'staff');
  p.moveTaskToFolder(task.id,home.id,'staff');
  const worker=new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    const {openDatabase}=require(workerData.databaseModule),{ProcessingRepository}=require(workerData.repositoryModule);
    const db=openDatabase(workerData.dbPath),processing=new ProcessingRepository(db);
    parentPort.postMessage({type:'ready'});
    parentPort.once('message',()=>{parentPort.postMessage({type:'starting'});try{processing.moveTaskToFolder(workerData.taskId,workerData.folderId,'staff');parentPort.postMessage({type:'result',value:'moved'});}catch(error){parentPort.postMessage({type:'result',value:error.code||error.message});}finally{db.close();}});
  `,{eval:true,workerData:{databaseModule:require.resolve('../server/database'),repositoryModule:require.resolve('../server/processingRepository'),dbPath,taskId:task.id,folderId:target.id}});
  t.after(async()=>{await worker.terminate();if(db.isTransaction)db.exec('ROLLBACK');db.close();});
  const messages=[];let wake;worker.on('message',message=>{messages.push(message);wake?.();});worker.on('error',error=>{messages.push({type:'error',value:error.message});wake?.();});
  const next=async()=>{while(!messages.length)await new Promise(resolve=>{wake=resolve;});wake=null;return messages.shift();};
  assert.equal((await next()).type,'ready');
  db.exec('BEGIN IMMEDIATE');db.prepare('DELETE FROM project_folders WHERE id=?').run(target.id);
  worker.postMessage('move');assert.equal((await next()).type,'starting');
  await new Promise(resolve=>setTimeout(resolve,25));db.exec('COMMIT');
  assert.deepEqual(await next(),{type:'result',value:'invalid_folder'});
  assert.equal(p.getTask(task.id).folderId,home.id,'the loser leaves the task where it was');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM processing_tasks WHERE folder_id IS NOT NULL AND folder_id NOT IN (SELECT id FROM project_folders)').get().n,0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('every folder route refuses unauthenticated, client-share and under-privileged callers without returning folder data',async t=>{
  const root=tempRoot(t,'routes'),db=openDatabase(path.join(root,'db.sqlite'));
  const processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
  const token=n=>`folder-${n}-token-`.padEnd(40,'0');
  const sessions={full:['viewer.projects.read','viewer.projects.write','viewer.processing.write'],readOnly:['viewer.projects.read'],processingOnly:['viewer.processing.read','viewer.processing.write'],shares:['viewer.shares.read','viewer.shares.create']};
  for(const [name,permissions] of Object.entries(sessions))processing.createAdminSession({tokenHash:auth.hashToken(token(name)),subject:`staff:${name}`,permissions,displayUnits:'metric',expiresAt:new Date(Date.now()+60000).toISOString()});
  processing.createAdminSession({tokenHash:auth.hashToken(token('expired')),subject:'staff:expired',permissions:sessions.full,displayUnits:'metric',expiresAt:new Date(Date.now()-1000).toISOString()});
  const project=processing.createProject({displayName:'Synthetic routes'}),task=seedTask(processing,project),folder=processing.createProjectFolder(project.id,{displayName:'Synthetic secret folder'},'staff');
  const app=express();app.use(express.json());app.use(createProcessingApi({repository,processing,storage:{}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const call=(route,method,body,headers)=>fetch(`http://127.0.0.1:${server.address().port}${route}`,{method,headers:{'content-type':'application/json','idempotency-key':crypto.randomUUID(),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const base=`/api/v1/projects/${project.id}/folders`;
  const routes=[
    {route:base,method:'GET',permission:'viewer.projects.read'},
    {route:base,method:'POST',body:{displayName:'Intruder'},permission:'viewer.projects.write'},
    {route:`${base}/${folder.id}`,method:'PATCH',body:{displayName:'Intruder'},permission:'viewer.projects.write'},
    {route:`${base}/${folder.id}`,method:'DELETE',permission:'viewer.projects.write'},
    {route:`/api/v1/tasks/${task.id}/folder`,method:'PATCH',body:{folderId:folder.id,expectedFolderId:null,expectedFolderRevision:0},permission:'viewer.processing.write'},
  ];
  const callers={
    none:{},
    clientShareCookie:{cookie:`ltds_project_share=${'x'.repeat(40)}`},
    clientBearerGuess:{authorization:`Bearer ${'c'.repeat(40)}`},
    expiredStaff:{authorization:`Bearer ${token('expired')}`},
  };
  for(const {route,method,body,permission} of routes){
    for(const [name,headers] of Object.entries(callers)){
      const response=await call(route,method,body,headers),text=await response.text();
      assert.equal(response.status,401,`${name} ${method} ${route}`);
      assert.equal(text.includes(folder.id)||text.includes('Synthetic secret folder'),false);
    }
    for(const name of ['readOnly','processingOnly','shares']){
      if(sessions[name].includes(permission))continue;
      const response=await call(route,method,body,{authorization:`Bearer ${token(name)}`}),text=await response.text();
      assert.equal(response.status,403,`${name} ${method} ${route}`);
      assert.equal(text.includes(folder.id)||text.includes('Synthetic secret folder'),false);
    }
  }
  // Nothing above changed state.
  assert.deepEqual(processing.projectFolders(project.id).map(row=>row.displayName),['Synthetic secret folder']);
  assert.equal(processing.getTask(task.id).folderId,null);
  // Unknown or foreign identifiers return 404 rather than another project's data.
  const full={authorization:`Bearer ${token('full')}`},missing=crypto.randomUUID();
  assert.equal((await call(`/api/v1/projects/${missing}/folders`,'GET',undefined,full)).status,404);
  assert.equal((await call(`/api/v1/tasks/${missing}/folder`,'PATCH',{folderId:null,expectedFolderId:null,expectedFolderRevision:0},full)).status,404);
  assert.equal((await call(`${base}/${missing}`,'DELETE',undefined,full)).status,404);
  assert.equal((await call(`/api/v1/tasks/${task.id}/folder`,'PATCH',{folderId:folder.id,projectId:missing},full)).status,400,'extra fields are rejected');
});
