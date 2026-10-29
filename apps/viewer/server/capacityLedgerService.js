'use strict';

// Preparatory service only. No routes, workers, or storage writers call this.
// Caller-supplied samples are not verified here. Do not activate until trusted
// domain sampling, actual writer fencing and quiescence are implemented.
const {evaluateCapacityBudget}=require('./capacityBudget');
function failure(code){return Object.assign(new Error(code),{code});}
function text(value,max){if(typeof value!=='string'||!value.length||value.length>max)throw failure('capacity_request_invalid');return value;}
function amount(value){if(!Number.isSafeInteger(value)||value<0)throw failure('capacity_request_invalid');return value;}
function transaction(db,fn){
  db.exec('BEGIN IMMEDIATE');
  try{const result=fn();db.exec('COMMIT');return result;}
  catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
}
function enabled(db){
  const control=db.prepare('SELECT mode,legacy_state FROM viewer_capacity_control WHERE singleton=1').get();
  if(!control||control.mode!=='cooperative'||control.legacy_state!=='verified')throw failure('capacity_unavailable');
}
function reserve(db,input){
  const request={id:text(input.id,128),domainId:text(input.domainId,128),domainRevision:text(input.domainRevision,128),writerKind:text(input.writerKind,64),writerId:text(input.writerId,128),writerNamespace:text(input.writerNamespace,256),ownerId:text(input.ownerId,128),fenceToken:text(input.fenceToken,128),generation:amount(input.generation),peakBytes:amount(input.peakBytes),peakInodes:amount(input.peakInodes)};
  if(!request.generation)throw failure('capacity_request_invalid');
  return transaction(db,()=>{
    enabled(db);
    // Even retries must supply valid, matching domain evidence; this still does
    // not attest freshness or the caller's identity.
    const baseline=evaluateCapacityBudget({domainId:request.domainId,domainRevision:request.domainRevision,samples:input.samples,commitments:[],requestBytes:0,requestInodes:0});
    if(!baseline.allowed)throw failure('capacity_insufficient');
    const existing=db.prepare('SELECT * FROM viewer_capacity_reservations WHERE id=? OR (domain_id=? AND writer_kind=? AND writer_id=?)').all(request.id,request.domainId,request.writerKind,request.writerId);
    if(existing.length){
      const r=existing[0];
      if(existing.length!==1||r.id!==request.id||r.domain_id!==request.domainId||r.domain_revision!==request.domainRevision||r.writer_kind!==request.writerKind||r.writer_id!==request.writerId||r.writer_namespace!==request.writerNamespace||r.owner_id!==request.ownerId||r.fence_token!==request.fenceToken||r.owner_generation!==request.generation||r.peak_bytes!==request.peakBytes||r.peak_inodes!==request.peakInodes)throw failure('capacity_identity_conflict');
      // This receipt is not authorization to start or resume a writer.
      if(r.state!=='held')throw failure('capacity_state_invalid');
      return {id:r.id,state:r.state,idempotent:true};
    }
    // All existing rows remain commitments, including terminal/retained rows:
    // there is deliberately no release until quiescence is independently proven.
    const rows=db.prepare('SELECT id,domain_id,domain_revision,remaining_bytes,remaining_inodes FROM viewer_capacity_reservations WHERE domain_id=?').all(request.domainId);
    const commitments=rows.map(r=>({id:r.id,domainId:r.domain_id,domainRevision:r.domain_revision,remainingBytes:r.remaining_bytes,remainingInodes:r.remaining_inodes}));
    const budget=evaluateCapacityBudget({domainId:request.domainId,domainRevision:request.domainRevision,samples:input.samples,commitments,requestBytes:request.peakBytes,requestInodes:request.peakInodes});
    if(!budget.allowed)throw failure('capacity_insufficient');
    const now=new Date().toISOString();
    db.prepare(`INSERT INTO viewer_capacity_reservations(id,domain_id,domain_revision,writer_kind,writer_id,writer_namespace,owner_id,fence_token,owner_generation,peak_bytes,materialized_bytes,remaining_bytes,peak_inodes,materialized_inodes,remaining_inodes,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,0,?,'held',?,?)`).run(request.id,request.domainId,request.domainRevision,request.writerKind,request.writerId,request.writerNamespace,request.ownerId,request.fenceToken,request.generation,request.peakBytes,request.peakBytes,request.peakInodes,request.peakInodes,now,now);
    return {id:request.id,state:'held',idempotent:false};
  });
}
function quiesce(db,{id,ownerId,fenceToken,generation}){
  text(id,128);text(ownerId,128);text(fenceToken,128);amount(generation);
  return transaction(db,()=>{
    enabled(db);
    const row=db.prepare('SELECT * FROM viewer_capacity_reservations WHERE id=?').get(id);
    if(!row||row.owner_id!==ownerId||row.fence_token!==fenceToken||row.owner_generation!==generation)throw failure('capacity_owner_mismatch');
    if(row.state==='quiescing')return {id,state:'quiescing',idempotent:true};
    if(!['held','writing'].includes(row.state))throw failure('capacity_state_invalid');
    db.prepare("UPDATE viewer_capacity_reservations SET state='quiescing',updated_at=? WHERE id=?").run(new Date().toISOString(),id);
    return {id,state:'quiescing',idempotent:false};
  });
}
module.exports={reserve,quiesce};
