'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {trashTaskTree,trashProjectTree,purgeContainerTrash}=require('../server/containerLifecycle');
const sha=crypto.createHash('sha256').update('legacy').digest('hex');
const storage=new Proxy({}, {get(){throw new Error('unexpected filesystem operation');}});
function fixture(){const db=openDatabase(':memory:'),p=new ProcessingRepository(db);return {db,p};}
function source(p,project,name,id){const d=p.createDataset({projectId:project.id,displayName:name,storageMode:'external_reference',rootKey:'dataset_import',relativePath:name});p.database.prepare("UPDATE datasets SET status='finalized' WHERE id=?").run(d.id);const task=p.createTask({projectId:project.id,datasetId:d.id,displayName:name});if(id){const upload=p.createUpload({datasetId:d.id,files:[{id,relativePath:'source.jpg',byteSize:6,sha256:sha}],subject:'fixture',chunkSize:10,expiresAt:new Date(Date.now()+60000).toISOString()}).upload;return {d,task,upload};}return {d,task};}
for(const id of ['.','..','malformed']) test(`legacy ${id} prevents task and project tree trash`,t=>{const {db,p}=fixture();t.after(()=>db.close());const project=p.createProject({displayName:'legacy'}),bad=source(p,project,'bad',id==='malformed'?'safe':id),neighbor=source(p,project,'neighbor');if(id==='malformed')db.prepare("UPDATE upload_sessions SET expected_manifest_json='{bad' WHERE id=?").run(bad.upload.id);const before=db.prepare('SELECT expected_manifest_json FROM upload_sessions WHERE id=?').get(bad.upload.id).expected_manifest_json;assert.throws(()=>trashTaskTree(p,storage,bad.task.id,'fixture'),{code:'task_not_trashable'});assert.throws(()=>trashProjectTree(p,storage,project.id,'fixture'),{code:'project_not_trashable'});assert.equal(p.getProject(project.id).status,'active');assert.notEqual(p.getTask(neighbor.task.id).status,'archived');assert.equal(db.prepare('SELECT expected_manifest_json FROM upload_sessions WHERE id=?').get(bad.upload.id).expected_manifest_json,before);assert.ok(trashTaskTree(p,storage,neighbor.task.id,'fixture'),'valid neighbor remains independently trashable');});
test('existing container trash cannot be resumed or purged after unsafe legacy upload appears',t=>{const {db,p}=fixture();t.after(()=>db.close());const project=p.createProject({displayName:'existing'}),item=source(p,project,'existing-task');const root=trashProjectTree(p,storage,project.id,'fixture');assert.ok(root);const upload=p.createUpload({datasetId:item.d.id,files:[{id:'..',relativePath:'source.jpg',byteSize:6,sha256:sha}],subject:'fixture',chunkSize:10,expiresAt:new Date(Date.now()+60000).toISOString()});assert.ok(upload);assert.throws(()=>trashProjectTree(p,storage,project.id,'fixture'),{code:'project_not_trashable'});assert.equal(purgeContainerTrash(p,storage,root.id,'fixture'),null);assert.equal(p.getTrash(root.id).permanentlyDeletedAt,null);});

test('corrupt inventory or mismatched receipt holds expiry and tree operations without affecting neighbors',t=>{
 const {db,p}=fixture();t.after(()=>db.close());const project=p.createProject({displayName:'inventory'}),bad=source(p,project,'bad','safe'),neighbor=source(p,project,'neighbor','good');
 const manifest=JSON.parse(db.prepare('SELECT expected_manifest_json FROM upload_sessions WHERE id=?').get(bad.upload.id).expected_manifest_json);
 db.prepare("UPDATE upload_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id IN (?,?)").run(bad.upload.id,neighbor.upload.id);
 for(const corrupt of [[{id:'safe'}],[manifest[0],manifest[0]]]){
  db.prepare('UPDATE upload_sessions SET expected_manifest_json=? WHERE id=?').run(JSON.stringify(corrupt),bad.upload.id);
  assert.equal(p.uploadHasUnsafeFileIds(bad.upload.id),true);assert.equal(p.expiredUploads().includes(bad.upload.id),false);
  assert.throws(()=>trashTaskTree(p,storage,bad.task.id,'fixture'),{code:'task_not_trashable'});assert.throws(()=>trashProjectTree(p,storage,project.id,'fixture'),{code:'project_not_trashable'});
 }
 db.prepare('UPDATE upload_sessions SET expected_manifest_json=? WHERE id=?').run(JSON.stringify(manifest),bad.upload.id);
 db.prepare('INSERT INTO upload_chunks(upload_id,file_id,chunk_index,byte_size,sha256,relative_path,created_at) VALUES (?,?,0,6,?,?,?)').run(bad.upload.id,'.',sha,'source.jpg',new Date().toISOString());
 assert.equal(p.uploadHasUnsafeFileIds(bad.upload.id),true);assert.equal(p.expiredUploads().includes(bad.upload.id),false);assert.equal(p.expiredUploads().includes(neighbor.upload.id),true);
 assert.throws(()=>trashTaskTree(p,storage,bad.task.id,'fixture'),{code:'task_not_trashable'});assert.throws(()=>trashProjectTree(p,storage,project.id,'fixture'),{code:'project_not_trashable'});
 assert.equal(db.prepare('SELECT file_id FROM upload_chunks WHERE upload_id=?').get(bad.upload.id).file_id,'.');assert.ok(trashTaskTree(p,storage,neighbor.task.id,'fixture'));
});

