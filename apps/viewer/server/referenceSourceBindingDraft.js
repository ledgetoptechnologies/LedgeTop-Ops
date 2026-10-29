'use strict';

// Indexed-data binding experiment only. It neither attests a filesystem nor
// issues custody. The database unconditionally rejects admission. No runtime
// route invokes this function.
const crypto=require('node:crypto');
const {indexedScopeMayOverlap}=require('./referenceIndexedScope');
const {hasPendingSourceEffects}=require('./referenceSourcePendingEffects');
const validId=x=>typeof x==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(x);
const validHash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const safeRelative=x=>typeof x==='string'&&x.length>0&&x.length<=1024&&!x.includes('\\')&&!x.startsWith('/')&&!/[\x00-\x1f\x7f:]/.test(x)&&x.split('/').every(c=>c&&c!=='.'&&c!=='..');
const unavailable=()=>Object.assign(new Error('source binding dependencies unavailable'),{code:'source_binding_unavailable'});

function prepareSourceBindingDraft(processing,{id,attemptId}={}) {
  if(!validId(id)||!validId(attemptId))throw unavailable();
  return processing.transaction(()=>{
    if(processing.database.prepare('PRAGMA foreign_keys').get().foreign_keys!==1)throw unavailable();
    const attempt=processing.getAttempt(attemptId),task=attempt&&processing.getTask(attempt.taskId);
    const dataset=attempt&&processing.getDataset(attempt.datasetId,true),project=task&&processing.getProject(task.projectId);
    const potentialEffect=id=>processing.activeDatasetOperations(id)>0||Boolean(processing.database.prepare("SELECT 1 FROM dataset_operations WHERE dataset_id=? AND status IN ('awaiting_derivatives','failed','cancelled') LIMIT 1").get(id));
    if(!attempt||!task||!dataset||!project||task.status==='archived'||task.activeAttemptId!==attempt.id||attempt.status!=='pending'||task.datasetId!==dataset.id||task.projectId!==dataset.projectId||project.id!==dataset.projectId||project.status!=='active'||dataset.status!=='finalized'||dataset.storageMode!=='managed'||dataset.rootKey!=='datasets'||!safeRelative(dataset.relativePath)||!validHash(dataset.manifestSha256)||potentialEffect(dataset.id)||!Array.isArray(dataset.files)||!dataset.files.length||dataset.fileCount!==dataset.files.length)throw unavailable();
    // Existing effects on a separately indexed ancestor or descendant must
    // win over draft acquisition. This does not cover cross-root aliases or
    // unjournaled/old writers and therefore cannot authorize admission.
    const scopes=processing.database.prepare('SELECT id,root_key,relative_path FROM datasets WHERE root_key=?').all(dataset.rootKey);
    if(scopes.some(row=>row.id!==dataset.id&&indexedScopeMayOverlap(dataset,{rootKey:row.root_key,relativePath:row.relative_path})&&potentialEffect(row.id)))throw unavailable();
    if(hasPendingSourceEffects(processing,dataset))throw unavailable();
    const files=[...dataset.files].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
    if(files.some(f=>!validId(f.id)||!safeRelative(f.relativePath)||!Number.isSafeInteger(f.byteSize)||f.byteSize<0||!validHash(f.sha256))||new Set(files.map(f=>f.id)).size!==files.length)throw unavailable();
    const createdAt=new Date().toISOString();
    processing.database.prepare("INSERT INTO viewer_source_bindings(id,attempt_id,dataset_id,project_id,root_key,relative_path,dataset_manifest_sha256,object_count,state,created_at) VALUES(?,?,?,?,?,?,?,?,'building',?)").run(id,attempt.id,dataset.id,project.id,dataset.rootKey,dataset.relativePath,dataset.manifestSha256,files.length,createdAt);
    const insert=processing.database.prepare('INSERT INTO viewer_source_binding_objects(binding_id,file_id,relative_path,byte_size,sha256) VALUES(?,?,?,?,?)');
    for(const file of files)insert.run(id,file.id,file.relativePath,file.byteSize,file.sha256);
    processing.database.prepare("UPDATE viewer_source_bindings SET state='prepared' WHERE id=? AND state='building'").run(id);
    return {id,attemptId,datasetId:dataset.id,objectCount:files.length,diagnosticHash:crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')};
  });
}
module.exports={prepareSourceBindingDraft};
