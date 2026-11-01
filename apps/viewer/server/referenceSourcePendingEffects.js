'use strict';

// Conservative, indexed admission check for the disabled source-binding draft.
// It is not an interprocess filesystem fence or proof that a writer stopped.
const {decodeOptionsWire}=require('./referenceOptions');
const {indexedScopeMayOverlap}=require('./referenceIndexedScope');
const MAX_CATALOG_ROWS=10000;
const validId=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x);

function hasPendingSourceEffects(processing,source){
 const db=processing.database;
 // The optional offline lifecycle-fence experiment may not be installed.
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='reference_lifecycle_effects'").get()&&db.prepare("SELECT 1 FROM reference_lifecycle_effects WHERE state='in_flight' LIMIT 1").get())return true;
 // Unknown physical aliases mean an unclosed durable effect blocks globally.
 if(db.prepare("SELECT 1 FROM viewer_source_effect_claims WHERE state='in_flight' LIMIT 1").get())return true;
 // Configured roots can alias physically. Until a real scope attestor exists,
 // any unresolved retained-import cleanup conservatively blocks admission.
 if(db.prepare("SELECT 1 FROM import_cleanup_jobs WHERE status<>'complete' LIMIT 1").get())return true;
 if(db.prepare("SELECT 1 FROM retained_imports WHERE state<>'ready' OR cleanup_jobs_inserted<>1 LIMIT 1").get())return true;
 const rows=db.prepare("SELECT id,operation_type,dataset_id,processing_attempt_id,payload_json,status FROM dataset_operations WHERE operation_type='catalog_map' ORDER BY id LIMIT ?").all(MAX_CATALOG_ROWS+1);
 if(rows.length>MAX_CATALOG_ROWS)return true;
 const datasetById=db.prepare('SELECT root_key,relative_path FROM datasets WHERE id=?');
 const attemptById=db.prepare('SELECT dataset_id FROM processing_attempts WHERE id=?');
 for(const row of rows){
  let payload;try{payload=decodeOptionsWire(Buffer.from(row.payload_json,'utf8'));}catch{return true;}
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||!payload.ids||typeof payload.ids!=='object'||Array.isArray(payload.ids))return true;
  // Cleanup can target an aliased physical root; no logical-key comparison
  // can prove it disjoint. Even succeeded work can have cleanup outstanding.
  if(Object.hasOwn(payload,'sourceCleanup')||Object.hasOwn(payload,'adoptionIntent'))return true;
  const payloadAttempt=payload.ids.attemptId,payloadDataset=payload.ids.datasetId;
  if(!validId(payloadAttempt)||payloadDataset!==undefined&&!validId(payloadDataset)||row.processing_attempt_id!==null&&row.processing_attempt_id!==payloadAttempt)return true;
  const attempt=attemptById.get(payloadAttempt);
  if(!attempt||!validId(attempt.dataset_id))return true;
  if(payloadDataset!==undefined&&payloadDataset!==attempt.dataset_id||row.dataset_id!==null&&row.dataset_id!==attempt.dataset_id)return true;
  const dataset=datasetById.get(attempt.dataset_id);if(!dataset)return true;
  if(row.status!=='succeeded'&&indexedScopeMayOverlap(source,{rootKey:dataset.root_key,relativePath:dataset.relative_path}))return true;
 }
 return false;
}
module.exports={hasPendingSourceEffects};
