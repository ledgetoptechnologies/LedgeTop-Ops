'use strict';
// Unmounted logical accounting candidate. It never reserves physical disk,
// creates a directory, fences a prior writer or authorizes a copy.
const fail=()=>{throw Object.assign(new Error('spool generation held'),{code:'SPOOL_GENERATION_HELD'});};
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(x);
function reserveSpoolGenerationInTransaction(db,{attemptId,generation,quotaBytes}={}){
 if(!db||db.isTransaction!==true||!id(attemptId)||!Number.isSafeInteger(generation)||generation<1||generation>1000000||!Number.isSafeInteger(quotaBytes)||quotaBytes<1||quotaBytes>68719476736)fail();
  const source=db.prepare(`SELECT h.manifest_sha256,d.byte_size,i.state FROM viewer_source_spool_holds h JOIN datasets d ON d.id=h.dataset_id AND d.manifest_sha256=h.manifest_sha256 JOIN viewer_source_spool_intents i ON i.attempt_id=h.attempt_id AND i.manifest_sha256=h.manifest_sha256 WHERE h.attempt_id=?`).get(attemptId);
  if(!source||!(['copying','sealed'].includes(source.state)||(source.state==='prepared'&&generation===1))||!Number.isSafeInteger(source.byte_size)||source.byte_size<1)fail();
  const existing=db.prepare('SELECT * FROM viewer_source_spool_generation_holds WHERE attempt_id=? AND generation=?').get(attemptId,generation);
  if(existing){if(existing.manifest_sha256!==source.manifest_sha256||existing.reserved_bytes!==source.byte_size)fail();return {state:'held',directoryId:existing.directory_id,replayed:true,copyAvailable:false};}
  const previous=db.prepare('SELECT COALESCE(MAX(generation),0) n FROM viewer_source_spool_generation_holds WHERE attempt_id=?').get(attemptId).n;
  if(generation!==previous+1)fail();
  const initial=db.prepare('SELECT COALESCE(SUM(d.byte_size),0) n FROM viewer_source_spool_intents i JOIN viewer_source_spool_holds h ON h.attempt_id=i.attempt_id JOIN datasets d ON d.id=h.dataset_id').get().n;
  const retained=db.prepare('SELECT COALESCE(SUM(reserved_bytes),0) n FROM viewer_source_spool_generation_holds').get().n;
  if(!Number.isSafeInteger(initial)||!Number.isSafeInteger(retained)||initial<0||retained<0||initial>quotaBytes||retained>quotaBytes-initial||source.byte_size>quotaBytes-initial-retained)fail();
  const directoryId=`${attemptId}-g${generation}`;
  db.prepare("INSERT INTO viewer_source_spool_generation_holds VALUES(?,?,?,?,?,'held')").run(attemptId,generation,directoryId,source.manifest_sha256,source.byte_size);
  return {state:'held',directoryId,replayed:false,copyAvailable:false};
}
function reserveSpoolGeneration(db,input){if(!db)fail();db.exec('BEGIN IMMEDIATE');try{const result=reserveSpoolGenerationInTransaction(db,input);db.exec('COMMIT');return result;}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}}
module.exports={reserveSpoolGeneration,reserveSpoolGenerationInTransaction};
