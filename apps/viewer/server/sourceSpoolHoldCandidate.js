'use strict';
// Unmounted candidate. This DB hold is not filesystem custody and never
// authorizes source admission, a grant, or a copy. No release is implemented.
const fail=()=>{throw Object.assign(new Error('source spool hold unavailable'),{code:'SOURCE_SPOOL_HOLD_UNAVAILABLE'});};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x);
function prepareSourceSpoolHold(db,{attemptId,now=new Date().toISOString()}={}) {
 if(!db||!id(attemptId)||typeof now!=='string'||!Number.isFinite(Date.parse(now)))fail();
 db.exec('BEGIN IMMEDIATE');
 try {
  const row=db.prepare(`SELECT a.id AS attempt_id,t.id AS task_id,d.id AS dataset_id,p.id AS project_id,d.manifest_sha256
    FROM processing_attempts a JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
    JOIN datasets d ON d.id=t.dataset_id AND d.project_id=t.project_id JOIN projects p ON p.id=t.project_id
    WHERE a.id=? AND a.status IN ('pending','admitted','initializing','uploading','committed','queued_upstream','running','ingesting')
      AND t.status NOT IN ('archived','cancelled') AND t.purged_at IS NULL AND p.status='active' AND p.purged_at IS NULL
      AND d.status='finalized' AND d.storage_mode='managed' AND d.root_key='datasets'`).get(attemptId);
  if(!row||!/^[a-f0-9]{64}$/.test(row.manifest_sha256||''))fail();
  const pending=db.prepare(`SELECT 1 FROM storage_mutations WHERE status IN ('intent','fs_applied','failed') AND
    ((entity_type='dataset' AND entity_id=?) OR (entity_type='task' AND entity_id=?) OR (entity_type='project' AND entity_id=?)) LIMIT 1`).get(row.dataset_id,row.task_id,row.project_id);
  const operations=db.prepare("SELECT 1 FROM dataset_operations WHERE dataset_id=? AND status IN ('queued','leased') LIMIT 1").get(row.dataset_id);
  const trash=db.prepare("SELECT 1 FROM storage_trash WHERE permanently_deleted_at IS NULL AND ((entity_type='dataset' AND entity_id=?) OR (entity_type='task' AND entity_id=?) OR (entity_type='project' AND entity_id=?)) LIMIT 1").get(row.dataset_id,row.task_id,row.project_id);
  if(pending||operations||trash)fail();
  const existing=db.prepare('SELECT * FROM viewer_source_spool_holds WHERE attempt_id=?').get(attemptId);
  if(existing){for(const k of ['attempt_id','task_id','dataset_id','project_id','manifest_sha256'])if(existing[k]!==row[k])fail();db.exec('COMMIT');return {state:'held',replayed:true};}
  db.prepare('INSERT INTO viewer_source_spool_holds(attempt_id,task_id,dataset_id,project_id,manifest_sha256,created_at) VALUES(?,?,?,?,?,?)').run(row.attempt_id,row.task_id,row.dataset_id,row.project_id,row.manifest_sha256,now);
  db.exec('COMMIT');return {state:'held',replayed:false};
 } catch(error) { try{db.exec('ROLLBACK');}catch{} throw error; }
}
module.exports={prepareSourceSpoolHold};
