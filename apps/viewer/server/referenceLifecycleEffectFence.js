'use strict';
// Offline/cooperative experiment. No production migration installs this table,
// and lifecycle callers do not opt in by default. Not a filesystem lock.
const crypto=require('node:crypto');
const fail=code=>{throw Object.assign(new Error(code),{code})};
const offlineFences=new WeakMap();
function installOfflineFixture(processing,scope){
 if(scope!=='isolated-lifecycle-fence-fixture')fail('fence_unavailable');
 processing.database.exec(`CREATE TABLE reference_lifecycle_effects(id TEXT PRIMARY KEY,mutation_id TEXT NOT NULL UNIQUE,identity TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('in_flight','completed')),created_at TEXT NOT NULL,completed_at TEXT);
 CREATE TRIGGER reference_lifecycle_effect_no_delete BEFORE DELETE ON reference_lifecycle_effects BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_effect_no_replace BEFORE INSERT ON reference_lifecycle_effects WHEN EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE id=NEW.id OR rowid=NEW.rowid OR mutation_id=NEW.mutation_id OR state='in_flight') BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_effect_existing_guard BEFORE INSERT ON reference_lifecycle_effects WHEN EXISTS(SELECT 1 FROM viewer_source_effect_claims WHERE state='in_flight') OR EXISTS(SELECT 1 FROM viewer_source_bindings) BEGIN SELECT RAISE(ABORT,'source effect retained'); END;
 CREATE TRIGGER reference_lifecycle_effect_immutable BEFORE UPDATE ON reference_lifecycle_effects WHEN NOT(OLD.state='in_flight' AND NEW.state='completed' AND OLD.id IS NEW.id AND OLD.rowid IS NEW.rowid AND OLD.mutation_id IS NEW.mutation_id AND OLD.identity IS NEW.identity AND OLD.created_at IS NEW.created_at AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_binding_guard BEFORE INSERT ON viewer_source_bindings WHEN EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'lifecycle effect in flight'); END;
 CREATE TRIGGER reference_lifecycle_existing_effect_guard BEFORE INSERT ON viewer_source_effect_claims WHEN EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'lifecycle effect in flight'); END;
 CREATE TRIGGER reference_lifecycle_mutation_delete BEFORE DELETE ON storage_mutations WHEN EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE mutation_id=OLD.id AND state='in_flight') BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_mutation_replace BEFORE INSERT ON storage_mutations WHEN EXISTS(SELECT 1 FROM storage_mutations m JOIN reference_lifecycle_effects e ON e.mutation_id=m.id AND e.state='in_flight' WHERE m.id=NEW.id OR m.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_mutation_update_replace BEFORE UPDATE ON storage_mutations WHEN EXISTS(SELECT 1 FROM storage_mutations m JOIN reference_lifecycle_effects e ON e.mutation_id=m.id AND e.state='in_flight' WHERE m.id<>OLD.id AND (m.id=NEW.id OR m.rowid=NEW.rowid)) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_mutation_identity BEFORE UPDATE ON storage_mutations WHEN EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE mutation_id=OLD.id AND state='in_flight') AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid OR NEW.mutation_type IS NOT OLD.mutation_type OR NEW.entity_type IS NOT OLD.entity_type OR NEW.entity_id IS NOT OLD.entity_id OR NEW.trash_id IS NOT OLD.trash_id OR NEW.source_root_key IS NOT OLD.source_root_key OR NEW.source_relative_path IS NOT OLD.source_relative_path OR NEW.destination_root_key IS NOT OLD.destination_root_key OR NEW.destination_relative_path IS NOT OLD.destination_relative_path OR NEW.allow_absent_source IS NOT OLD.allow_absent_source) BEGIN SELECT RAISE(ABORT,'effect retained'); END;`);
}
function createOfflineLifecycleFence(processing,scope){
 if(scope!=='isolated-lifecycle-fence-fixture')fail('fence_unavailable');
 function run(mutationId,callback){
  if(typeof mutationId!=='string'||typeof callback!=='function')fail('fence_unavailable');
  const claim=processing.transaction(()=>{
   const row=processing.database.prepare('SELECT * FROM storage_mutations WHERE id=?').get(mutationId);
   if(processing.database.prepare("SELECT 1 FROM reference_lifecycle_effects WHERE state='in_flight'").get())fail('lifecycle_effect_held');
   if(!row)return {terminal:true,result:null};
   if(['complete','failed'].includes(row.status))return {terminal:true,result:processing.getStorageMutation(mutationId)};
   if(!['intent','fs_applied'].includes(row.status)||processing.hasAnySourceBinding()||processing.database.prepare("SELECT 1 FROM viewer_source_effect_claims WHERE state='in_flight'").get())fail('lifecycle_effect_held');
   const identity=JSON.stringify([row.id,row.mutation_type,row.entity_type,row.entity_id,row.trash_id,row.source_root_key,row.source_relative_path,row.destination_root_key,row.destination_relative_path,row.allow_absent_source]);
   const id=crypto.randomUUID();processing.database.prepare("INSERT INTO reference_lifecycle_effects VALUES(?,?,?,'in_flight',?,NULL)").run(id,mutationId,identity,new Date().toISOString());return {id};
  });
  if(claim.terminal)return claim.result;
  const result=callback();
  // No automatic release on failure or ambiguous state. Successful completion
  // is the only cooperative settlement; a crash before this leaves a hold.
  if(result?.status==='complete')processing.transaction(()=>{
   const mutation=processing.getStorageMutation(mutationId);if(!mutation||mutation.status!=='complete')fail('lifecycle_effect_held');
   if(processing.database.prepare("UPDATE reference_lifecycle_effects SET state='completed',completed_at=? WHERE id=? AND mutation_id=? AND state='in_flight'").run(new Date().toISOString(),claim.id,mutationId).changes!==1)fail('lifecycle_effect_held');
  });
  return result;
 }
 return Object.freeze({run});
}
// Registration is per repository instance and intentionally has no production
// configuration or automatic installation. Other processes are not covered.
function registerOfflineFixtureFence(processing,scope){const fence=createOfflineLifecycleFence(processing,scope);offlineFences.set(processing,fence);return fence;}
function registeredOfflineFixtureFence(processing){return offlineFences.get(processing)||null;}
module.exports={installOfflineFixture,createOfflineLifecycleFence,registerOfflineFixtureFence,registeredOfflineFixtureFence};
