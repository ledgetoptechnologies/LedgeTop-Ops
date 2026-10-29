'use strict';

// This is an unexposed candidate. No API, worker or startup recovery invokes
// it until the archive root authority and exclusive-writer fence are supplied.
const crypto=require('node:crypto');
const {parseRawGcpSource}=require('./gcpRawSource');

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const error=(message,code='invalid_gcp_input')=>Object.assign(new Error(message),{code});

function fullTransaction(db,fn) {
  const previous=db.prepare('PRAGMA synchronous').get().synchronous;
  if(![0,1,2,3].includes(previous))throw error('SQLite synchronous mode unavailable','gcp_journal_unavailable');
  db.exec('PRAGMA synchronous=FULL');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {const value=fn();db.exec('COMMIT');return value;}
    catch(caught){db.exec('ROLLBACK');throw caught;}
  } finally {db.exec(`PRAGMA synchronous=${previous}`);}
}

function prepareGcpRawJournal(db,{datasetId,encoded,format,declarations=null,confirmation,displayName,fileName,actorId,requestKey}) {
  if(typeof datasetId!=='string' || !uuid.test(datasetId) || datasetId!==datasetId.toLowerCase() || !['generic-csv-v1','emlid-all-columns-v1'].includes(format) ||
    typeof displayName!=='string' || !displayName.trim() || displayName.trim().length>160 ||
    typeof fileName!=='string' || !fileName.trim() || fileName.length>240 || /[\\/\x00-\x1f\x7f]/.test(fileName) ||
    typeof actorId!=='string' || !actorId || actorId.length>256 || typeof requestKey!=='string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(requestKey))throw error('invalid GCP raw source metadata');
  const raw=parseRawGcpSource({encoded,format,declarations});
  if(confirmation!==raw.confirmationToken)throw error('GCP source preview no longer matches','gcp_preview_confirmation_required');
  const declarationsJson=JSON.stringify(declarations), id=crypto.randomUUID(), name=fileName.trim(), label=displayName.trim();
  return fullTransaction(db,()=>{
    const existing=db.prepare('SELECT * FROM viewer_gcp_raw_sources WHERE created_by=? AND request_key=?').get(actorId,requestKey);
    if(existing){
      if(existing.dataset_id!==datasetId || existing.source_sha256!==raw.sha256 || !Buffer.from(existing.source_bytes).equals(raw.bytes) || existing.source_filename!==name || existing.display_name!==label || existing.source_format!==format || existing.declarations_json!==declarationsJson || existing.confirmation_token!==confirmation)throw error('retained GCP source conflicts with existing import','gcp_source_conflict');
      return {id:existing.id,status:existing.status,replayed:true};
    }
    const dataset=db.prepare('SELECT status FROM datasets WHERE id=?').get(datasetId);
    const pending=db.prepare("SELECT 1 FROM storage_mutations WHERE entity_type='dataset' AND entity_id=? AND status IN ('intent','fs_applied','failed') LIMIT 1").get(datasetId);
    if(!dataset || dataset.status!=='finalized' || pending)throw error('dataset is not available for GCP import','dataset_not_available');
    const archiveRelativePath=`.gcp-retained/${datasetId.toLowerCase()}/${raw.sha256}.csv`;
    db.prepare(`INSERT INTO viewer_gcp_raw_sources(id,dataset_id,source_sha256,source_bytes,source_filename,source_format,display_name,declarations_json,confirmation_token,created_by,request_key,archive_relative_path,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)`).run(id,datasetId,raw.sha256,raw.bytes,name,format,label,declarationsJson,confirmation,actorId,requestKey,archiveRelativePath,new Date().toISOString());
    return {id,status:'pending',replayed:false};
  });
}

// Recovery planning is read-only. It intentionally supplies no authority to
// write the archive or to mark a row ready; those require the future verified
// root and writer-fence implementation.
function inspectPendingGcpRawJournal(db,id) {
  if(typeof id!=='string' || !uuid.test(id) || id!==id.toLowerCase())throw error('invalid journal identity');
  const row=db.prepare("SELECT * FROM viewer_gcp_raw_sources WHERE id=? AND status='pending'").get(id);
  if(!row)return null;
  let declarations;
  try {declarations=JSON.parse(row.declarations_json);} catch {throw error('journal declarations are corrupt','gcp_journal_conflict');}
  if(JSON.stringify(declarations)!==row.declarations_json || typeof row.dataset_id!=='string' || !uuid.test(row.dataset_id) || row.dataset_id!==row.dataset_id.toLowerCase())throw error('journal identity is corrupt','gcp_journal_conflict');
  const bytes=Buffer.from(row.source_bytes), raw=parseRawGcpSource({encoded:bytes.toString('base64'),format:row.source_format,declarations});
  if(raw.sha256!==row.source_sha256 || raw.confirmationToken!==row.confirmation_token || row.archive_relative_path!==`.gcp-retained/${row.dataset_id}/${raw.sha256}.csv`)throw error('journal source identity is corrupt','gcp_journal_conflict');
  const set=db.prepare('SELECT id,dataset_id,display_name,created_by,source_sha256,source_content,source_byte_size,source_filename,source_format,source_file_id FROM gcp_sets WHERE id=?').get(id);
  if(set && (set.dataset_id!==row.dataset_id || set.display_name!==row.display_name || set.created_by!==row.created_by || set.source_sha256!==raw.sha256 || set.source_content!==raw.content || set.source_byte_size!==bytes.length || set.source_filename!==row.source_filename || set.source_format!==(row.source_format==='emlid-all-columns-v1'?'generic-csv-v1':row.source_format) || set.source_file_id!==null))throw error('journal GCP set conflicts','gcp_journal_conflict');
  const dataset=db.prepare('SELECT status FROM datasets WHERE id=?').get(row.dataset_id);
  const pending=db.prepare("SELECT 1 FROM storage_mutations WHERE entity_type='dataset' AND entity_id=? AND status IN ('intent','fs_applied','failed') LIMIT 1").get(row.dataset_id);
  // A matching set header is not proof of its points, provenance or mark
  // state. Block rather than suggesting it is ready for finalization until a
  // complete derived-state verifier exists.
  return {id:row.id,datasetId:row.dataset_id,status:'pending',action:!dataset || dataset.status!=='finalized' || pending?'blocked_dataset':set?'blocked_unverified_set':'archive_and_create_set',sourceSha256:raw.sha256};
}

module.exports={prepareGcpRawJournal,inspectPendingGcpRawJournal};
