'use strict';
// Unmounted logical accounting only. Never grants source or writer authority.
const {reserve}=require('./capacityLedgerService');
const {isSpoolCapacityObserver}=require('./spoolCapacityObservationCandidate');
const fail=()=>{throw Object.assign(new Error('spool accounting unavailable'),{code:'SPOOL_ACCOUNTING_UNAVAILABLE'});};
function holdGenerationCapacity(db,{attemptId,generation,domainId,domainRevision,ownerId,fenceToken,observer}={}){
 if(!db||typeof attemptId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/.test(attemptId)||!Number.isSafeInteger(generation)||generation<1||!isSpoolCapacityObserver(observer))fail();
 const target=db.prepare('SELECT * FROM viewer_source_spool_generation_holds WHERE attempt_id=? AND generation=? AND state=?').get(attemptId,generation,'held');if(!target)fail();
 // Every prior initial intent and other proposed generation must already be
 // represented as a full held ledger commitment. Missing/foreign accounting
 // is ambiguous and may never be treated as free space.
 const initial=db.prepare(`SELECT i.attempt_id,d.byte_size,d.file_count FROM viewer_source_spool_intents i JOIN viewer_source_spool_holds h ON h.attempt_id=i.attempt_id JOIN datasets d ON d.id=h.dataset_id`).all();
 const generations=db.prepare('SELECT attempt_id,generation,reserved_bytes FROM viewer_source_spool_generation_holds').all();
 if(initial.length+generations.length>10000)fail();
 const prior=[];for(const row of initial)prior.push({id:`spool-original:${row.attempt_id}`,bytes:row.byte_size,inodes:row.file_count+2});for(const row of generations)if(!(row.attempt_id===attemptId&&row.generation===generation)){const d=initial.find(x=>x.attempt_id===row.attempt_id);if(!d)fail();prior.push({id:`spool-generation:${row.attempt_id}:${row.generation}`,bytes:row.reserved_bytes,inodes:d.file_count+2});}
 const find=db.prepare('SELECT domain_id,domain_revision,peak_bytes,peak_inodes,state FROM viewer_capacity_reservations WHERE id=?');
 for(const p of prior){const saved=find.get(p.id);if(!saved||saved.domain_id!==domainId||saved.domain_revision!==domainRevision||saved.peak_bytes!==p.bytes||saved.peak_inodes!==p.inodes||!['held','writing','quiescing','retained'].includes(saved.state))fail();}
 const own=initial.find(x=>x.attempt_id===attemptId);if(!own||!Number.isSafeInteger(own.file_count)||own.file_count<1||own.file_count>10000||target.reserved_bytes!==own.byte_size)fail();
 const precondition=()=>{
   const currentTarget=db.prepare('SELECT directory_id,reserved_bytes,state FROM viewer_source_spool_generation_holds WHERE attempt_id=? AND generation=?').get(attemptId,generation);
   if(!currentTarget||currentTarget.directory_id!==target.directory_id||currentTarget.reserved_bytes!==target.reserved_bytes||currentTarget.state!=='held')fail();
   const currentInitial=db.prepare('SELECT i.attempt_id,d.byte_size,d.file_count FROM viewer_source_spool_intents i JOIN viewer_source_spool_holds h ON h.attempt_id=i.attempt_id JOIN datasets d ON d.id=h.dataset_id').all();
   const currentGenerations=db.prepare('SELECT attempt_id,generation,reserved_bytes FROM viewer_source_spool_generation_holds').all();
   if(JSON.stringify(currentInitial)!==JSON.stringify(initial)||JSON.stringify(currentGenerations)!==JSON.stringify(generations))fail();
   for(const p of prior){const saved=find.get(p.id);if(!saved||saved.domain_id!==domainId||saved.domain_revision!==domainRevision||saved.peak_bytes!==p.bytes||saved.peak_inodes!==p.inodes||!['held','writing','quiescing','retained'].includes(saved.state))fail();}
 };
 const result=reserve(db,{id:`spool-generation:${attemptId}:${generation}`,domainId,domainRevision,writerKind:'source-spool',writerId:target.directory_id,writerNamespace:'viewer-spool-candidate',ownerId,fenceToken,generation,peakBytes:target.reserved_bytes,peakInodes:own.file_count+2},observer,{precondition});
 return {...result,copyAvailable:false,physicalReservation:false};
}
module.exports={holdGenerationCapacity};
