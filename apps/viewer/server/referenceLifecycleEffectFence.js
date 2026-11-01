'use strict';
// Offline/cooperative experiment. No production migration installs this table,
// and lifecycle callers do not opt in by default. Not a filesystem lock.
const crypto=require('node:crypto');
const fail=code=>{throw Object.assign(new Error(code),{code})};
const offlineFences=new WeakMap();
function installOfflineFixture(processing,scope){
 if(scope!=='isolated-lifecycle-fence-fixture')fail('fence_unavailable');
 return processing.transaction(()=>processing.database.exec(`CREATE TABLE reference_lifecycle_effects(id TEXT PRIMARY KEY,mutation_id TEXT NOT NULL UNIQUE,identity TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('in_flight','completed')),created_at TEXT NOT NULL,completed_at TEXT);
 CREATE TRIGGER reference_lifecycle_effect_no_delete BEFORE DELETE ON reference_lifecycle_effects BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_effect_no_replace BEFORE INSERT ON reference_lifecycle_effects WHEN EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE id=NEW.id OR rowid=NEW.rowid OR mutation_id=NEW.mutation_id OR state='in_flight') BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_effect_existing_guard BEFORE INSERT ON reference_lifecycle_effects WHEN EXISTS(SELECT 1 FROM viewer_source_effect_claims WHERE state='in_flight') OR EXISTS(SELECT 1 FROM viewer_source_bindings) BEGIN SELECT RAISE(ABORT,'source effect retained'); END;
 CREATE TRIGGER reference_lifecycle_effect_immutable BEFORE UPDATE ON reference_lifecycle_effects WHEN NOT(OLD.state='in_flight' AND NEW.state='completed' AND OLD.id IS NEW.id AND OLD.rowid IS NEW.rowid AND OLD.mutation_id IS NEW.mutation_id AND OLD.identity IS NEW.identity AND OLD.created_at IS NEW.created_at AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_binding_guard BEFORE INSERT ON viewer_source_bindings WHEN EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'lifecycle effect in flight'); END;
 CREATE TRIGGER reference_lifecycle_existing_effect_guard BEFORE INSERT ON viewer_source_effect_claims WHEN EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'lifecycle effect in flight'); END;
 CREATE TRIGGER reference_lifecycle_mutation_delete BEFORE DELETE ON storage_mutations WHEN EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE mutation_id=OLD.id AND state='in_flight') BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_mutation_replace BEFORE INSERT ON storage_mutations WHEN EXISTS(SELECT 1 FROM storage_mutations m JOIN reference_lifecycle_effects e ON e.mutation_id=m.id AND e.state='in_flight' WHERE m.id=NEW.id OR m.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_mutation_update_replace BEFORE UPDATE ON storage_mutations WHEN EXISTS(SELECT 1 FROM storage_mutations m JOIN reference_lifecycle_effects e ON e.mutation_id=m.id AND e.state='in_flight' WHERE m.id<>OLD.id AND (m.id=NEW.id OR m.rowid=NEW.rowid)) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_lifecycle_mutation_identity BEFORE UPDATE ON storage_mutations WHEN EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE mutation_id=OLD.id AND state='in_flight') AND (NEW.id IS NOT OLD.id OR NEW.rowid IS NOT OLD.rowid OR NEW.mutation_type IS NOT OLD.mutation_type OR NEW.entity_type IS NOT OLD.entity_type OR NEW.entity_id IS NOT OLD.entity_id OR NEW.trash_id IS NOT OLD.trash_id OR NEW.source_root_key IS NOT OLD.source_root_key OR NEW.source_relative_path IS NOT OLD.source_relative_path OR NEW.destination_root_key IS NOT OLD.destination_root_key OR NEW.destination_relative_path IS NOT OLD.destination_relative_path OR NEW.allow_absent_source IS NOT OLD.allow_absent_source) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TABLE reference_catalog_cleanup_effects(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('in_flight','completed')),created_at TEXT NOT NULL,completed_at TEXT);
 CREATE TRIGGER reference_catalog_claim_insert BEFORE INSERT ON reference_catalog_cleanup_effects WHEN EXISTS(SELECT 1 FROM reference_catalog_cleanup_effects WHERE id=NEW.id OR rowid=NEW.rowid OR operation_id=NEW.operation_id OR state='in_flight') OR EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE state='in_flight') OR EXISTS(SELECT 1 FROM viewer_source_effect_claims WHERE state='in_flight') OR EXISTS(SELECT 1 FROM viewer_source_bindings) BEGIN SELECT RAISE(ABORT,'source effect retained'); END;
 CREATE TRIGGER reference_catalog_claim_no_delete BEFORE DELETE ON reference_catalog_cleanup_effects BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_catalog_claim_update BEFORE UPDATE ON reference_catalog_cleanup_effects WHEN NOT(OLD.state='in_flight' AND NEW.state='completed' AND OLD.id IS NEW.id AND OLD.rowid IS NEW.rowid AND OLD.operation_id IS NEW.operation_id AND OLD.payload_json IS NEW.payload_json AND OLD.created_at IS NEW.created_at AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_catalog_bind_guard BEFORE INSERT ON viewer_source_bindings WHEN EXISTS(SELECT 1 FROM reference_catalog_cleanup_effects WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'catalog cleanup in flight'); END;
 CREATE TRIGGER reference_catalog_lifecycle_guard BEFORE INSERT ON reference_lifecycle_effects WHEN EXISTS(SELECT 1 FROM reference_catalog_cleanup_effects WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'catalog cleanup in flight'); END;
 CREATE TRIGGER reference_catalog_existing_guard BEFORE INSERT ON viewer_source_effect_claims WHEN EXISTS(SELECT 1 FROM reference_catalog_cleanup_effects WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'catalog cleanup in flight'); END;
 CREATE TRIGGER reference_catalog_operation_delete BEFORE DELETE ON dataset_operations WHEN EXISTS(SELECT 1 FROM reference_catalog_cleanup_effects WHERE operation_id=OLD.id AND state='in_flight') BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_catalog_operation_insert BEFORE INSERT ON dataset_operations WHEN EXISTS(SELECT 1 FROM dataset_operations o JOIN reference_catalog_cleanup_effects e ON e.operation_id=o.id AND e.state='in_flight' WHERE o.id=NEW.id OR o.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_catalog_operation_update BEFORE UPDATE ON dataset_operations WHEN EXISTS(SELECT 1 FROM reference_catalog_cleanup_effects WHERE operation_id=OLD.id AND state='in_flight') AND (OLD.id IS NOT NEW.id OR OLD.rowid IS NOT NEW.rowid OR OLD.operation_type IS NOT NEW.operation_type OR OLD.status IS NOT NEW.status OR OLD.payload_json IS NOT NEW.payload_json) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_catalog_operation_update_replace BEFORE UPDATE ON dataset_operations WHEN EXISTS(SELECT 1 FROM dataset_operations o JOIN reference_catalog_cleanup_effects e ON e.operation_id=o.id AND e.state='in_flight' WHERE o.id<>OLD.id AND (o.id=NEW.id OR o.rowid=NEW.rowid)) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TABLE reference_adoption_effects(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,payload_json TEXT NOT NULL,lease_owner TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('in_flight','completed')),created_at TEXT NOT NULL,completed_at TEXT);
 CREATE TRIGGER reference_adoption_insert BEFORE INSERT ON reference_adoption_effects WHEN EXISTS(SELECT 1 FROM reference_adoption_effects WHERE id=NEW.id OR rowid=NEW.rowid OR operation_id=NEW.operation_id OR state='in_flight') OR EXISTS(SELECT 1 FROM reference_catalog_cleanup_effects WHERE state='in_flight') OR EXISTS(SELECT 1 FROM reference_lifecycle_effects WHERE state='in_flight') OR EXISTS(SELECT 1 FROM viewer_source_effect_claims WHERE state='in_flight') OR EXISTS(SELECT 1 FROM viewer_source_bindings) BEGIN SELECT RAISE(ABORT,'source effect retained'); END;
 CREATE TRIGGER reference_adoption_no_delete BEFORE DELETE ON reference_adoption_effects BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_update BEFORE UPDATE ON reference_adoption_effects WHEN NOT(OLD.state='in_flight' AND NEW.state='completed' AND OLD.id IS NEW.id AND OLD.rowid IS NEW.rowid AND OLD.operation_id IS NEW.operation_id AND OLD.payload_json IS NEW.payload_json AND OLD.lease_owner IS NEW.lease_owner AND OLD.created_at IS NEW.created_at AND OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_bind_guard BEFORE INSERT ON viewer_source_bindings WHEN EXISTS(SELECT 1 FROM reference_adoption_effects WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'adoption in flight'); END;
 CREATE TRIGGER reference_adoption_lifecycle_guard BEFORE INSERT ON reference_lifecycle_effects WHEN EXISTS(SELECT 1 FROM reference_adoption_effects WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'adoption in flight'); END;
 CREATE TRIGGER reference_adoption_catalog_guard BEFORE INSERT ON reference_catalog_cleanup_effects WHEN EXISTS(SELECT 1 FROM reference_adoption_effects WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'adoption in flight'); END;
 CREATE TRIGGER reference_adoption_existing_guard BEFORE INSERT ON viewer_source_effect_claims WHEN EXISTS(SELECT 1 FROM reference_adoption_effects WHERE state='in_flight') BEGIN SELECT RAISE(ABORT,'adoption in flight'); END;
 CREATE TRIGGER reference_adoption_operation_delete BEFORE DELETE ON dataset_operations WHEN EXISTS(SELECT 1 FROM reference_adoption_effects WHERE operation_id=OLD.id AND state='in_flight') BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_operation_insert BEFORE INSERT ON dataset_operations WHEN EXISTS(SELECT 1 FROM dataset_operations o JOIN reference_adoption_effects e ON e.operation_id=o.id AND e.state='in_flight' WHERE o.id=NEW.id OR o.rowid=NEW.rowid) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_operation_update BEFORE UPDATE ON dataset_operations WHEN EXISTS(SELECT 1 FROM reference_adoption_effects WHERE operation_id=OLD.id AND state='in_flight') AND (OLD.id IS NOT NEW.id OR OLD.rowid IS NOT NEW.rowid OR OLD.operation_type IS NOT NEW.operation_type OR OLD.status IS NOT NEW.status OR OLD.payload_json IS NOT NEW.payload_json OR OLD.lease_owner IS NOT NEW.lease_owner) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_operation_update_replace BEFORE UPDATE ON dataset_operations WHEN EXISTS(SELECT 1 FROM dataset_operations o JOIN reference_adoption_effects e ON e.operation_id=o.id AND e.state='in_flight' WHERE o.id<>OLD.id AND (o.id=NEW.id OR o.rowid=NEW.rowid)) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_dataset_update BEFORE UPDATE ON datasets WHEN EXISTS(SELECT 1 FROM reference_adoption_effects e JOIN dataset_operations o ON o.id=e.operation_id WHERE e.state='in_flight' AND json_extract(o.payload_json,'$.ids.datasetId')=OLD.id) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_dataset_delete BEFORE DELETE ON datasets WHEN EXISTS(SELECT 1 FROM reference_adoption_effects e JOIN dataset_operations o ON o.id=e.operation_id WHERE e.state='in_flight' AND json_extract(o.payload_json,'$.ids.datasetId')=OLD.id) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_dataset_insert BEFORE INSERT ON datasets WHEN EXISTS(SELECT 1 FROM datasets d JOIN dataset_operations o ON json_extract(o.payload_json,'$.ids.datasetId')=d.id JOIN reference_adoption_effects e ON e.operation_id=o.id WHERE e.state='in_flight' AND (d.id=NEW.id OR d.rowid=NEW.rowid)) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_dataset_update_replace BEFORE UPDATE ON datasets WHEN EXISTS(SELECT 1 FROM datasets d JOIN dataset_operations o ON json_extract(o.payload_json,'$.ids.datasetId')=d.id JOIN reference_adoption_effects e ON e.operation_id=o.id WHERE e.state='in_flight' AND d.id<>OLD.id AND (d.id=NEW.id OR d.rowid=NEW.rowid)) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_file_insert BEFORE INSERT ON dataset_files WHEN EXISTS(SELECT 1 FROM reference_adoption_effects e JOIN dataset_operations o ON o.id=e.operation_id WHERE e.state='in_flight' AND json_extract(o.payload_json,'$.ids.datasetId')=NEW.dataset_id) OR EXISTS(SELECT 1 FROM dataset_files f JOIN dataset_operations o ON json_extract(o.payload_json,'$.ids.datasetId')=f.dataset_id JOIN reference_adoption_effects e ON e.operation_id=o.id WHERE e.state='in_flight' AND (f.id=NEW.id OR f.rowid=NEW.rowid)) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_file_update BEFORE UPDATE ON dataset_files WHEN EXISTS(SELECT 1 FROM reference_adoption_effects e JOIN dataset_operations o ON o.id=e.operation_id WHERE e.state='in_flight' AND json_extract(o.payload_json,'$.ids.datasetId') IN (OLD.dataset_id,NEW.dataset_id)) OR EXISTS(SELECT 1 FROM dataset_files f JOIN dataset_operations o ON json_extract(o.payload_json,'$.ids.datasetId')=f.dataset_id JOIN reference_adoption_effects e ON e.operation_id=o.id WHERE e.state='in_flight' AND f.id<>OLD.id AND (f.id=NEW.id OR f.rowid=NEW.rowid)) BEGIN SELECT RAISE(ABORT,'effect retained'); END;
 CREATE TRIGGER reference_adoption_file_delete BEFORE DELETE ON dataset_files WHEN EXISTS(SELECT 1 FROM reference_adoption_effects e JOIN dataset_operations o ON o.id=e.operation_id WHERE e.state='in_flight' AND json_extract(o.payload_json,'$.ids.datasetId')=OLD.dataset_id) BEGIN SELECT RAISE(ABORT,'effect retained'); END;`));
}
function createOfflineLifecycleFence(processing,scope){
 if(scope!=='isolated-lifecycle-fence-fixture')fail('fence_unavailable');
 const required=['reference_lifecycle_effects','reference_catalog_cleanup_effects','reference_lifecycle_effect_no_delete','reference_lifecycle_effect_no_replace','reference_lifecycle_effect_existing_guard','reference_lifecycle_effect_immutable','reference_lifecycle_binding_guard','reference_lifecycle_existing_effect_guard','reference_lifecycle_mutation_delete','reference_lifecycle_mutation_replace','reference_lifecycle_mutation_update_replace','reference_lifecycle_mutation_identity','reference_catalog_claim_insert','reference_catalog_claim_no_delete','reference_catalog_claim_update','reference_catalog_bind_guard','reference_catalog_lifecycle_guard','reference_catalog_existing_guard','reference_catalog_operation_delete','reference_catalog_operation_insert','reference_catalog_operation_update','reference_catalog_operation_update_replace'];
 required.push('reference_adoption_effects','reference_adoption_insert','reference_adoption_no_delete','reference_adoption_update','reference_adoption_bind_guard','reference_adoption_lifecycle_guard','reference_adoption_catalog_guard','reference_adoption_existing_guard','reference_adoption_operation_delete','reference_adoption_operation_insert','reference_adoption_operation_update','reference_adoption_operation_update_replace');
 required.push('reference_adoption_dataset_update','reference_adoption_dataset_delete','reference_adoption_dataset_insert','reference_adoption_dataset_update_replace','reference_adoption_file_insert','reference_adoption_file_update','reference_adoption_file_delete');
 const present=new Set(processing.database.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'reference_lifecycle_%' OR name LIKE 'reference_catalog_%' OR name LIKE 'reference_adoption_%'").all().map(row=>row.name));if(required.some(name=>!present.has(name)))fail('fence_unavailable');
 function run(mutationId,callback){
  if(typeof mutationId!=='string'||typeof callback!=='function')fail('fence_unavailable');
  const claim=processing.transaction(()=>{
   const row=processing.database.prepare('SELECT * FROM storage_mutations WHERE id=?').get(mutationId);
   if(processing.database.prepare("SELECT 1 FROM reference_lifecycle_effects WHERE state='in_flight'").get()||processing.database.prepare("SELECT 1 FROM reference_catalog_cleanup_effects WHERE state='in_flight'").get())fail('lifecycle_effect_held');
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
 async function runCatalogCleanup(item,callback){
  if(!item||typeof item.id!=='string'||typeof callback!=='function')fail('fence_unavailable');
  const claim=processing.transaction(()=>{
   const row=processing.database.prepare("SELECT payload_json FROM dataset_operations WHERE id=? AND operation_type='catalog_map' AND status='succeeded'").get(item.id);
   if(!row||!processing.referenceCatalogRecoveryAllowed(item.id)||processing.hasAnySourceBinding())fail('lifecycle_effect_held');
   let payload;try{payload=JSON.parse(row.payload_json)}catch{fail('lifecycle_effect_held')}
   const {id,...expected}=item;if(!payload.sourceCleanup||JSON.stringify(payload.sourceCleanup)!==JSON.stringify(expected))fail('lifecycle_effect_held');
   const idClaim=crypto.randomUUID();processing.database.prepare("INSERT INTO reference_catalog_cleanup_effects VALUES(?,?,?,'in_flight',?,NULL)").run(idClaim,id,row.payload_json,new Date().toISOString());return {id:idClaim,payload:row.payload_json};
  });
  const removed=await callback();if(removed!==true)return false;
  return processing.transaction(()=>{
   const row=processing.database.prepare("SELECT payload_json FROM dataset_operations WHERE id=? AND operation_type='catalog_map' AND status='succeeded'").get(item.id);
   if(!row||row.payload_json!==claim.payload||!processing.referenceCatalogRecoveryAllowed(item.id))fail('lifecycle_effect_held');
   const payload=JSON.parse(row.payload_json);delete payload.sourceCleanup;
   if(processing.database.prepare("UPDATE reference_catalog_cleanup_effects SET state='completed',completed_at=? WHERE id=? AND state='in_flight'").run(new Date().toISOString(),claim.id).changes!==1)fail('lifecycle_effect_held');
   if(processing.database.prepare("UPDATE dataset_operations SET payload_json=?,updated_at=? WHERE id=? AND payload_json=?").run(JSON.stringify(payload),new Date().toISOString(),item.id,claim.payload).changes!==1)fail('lifecycle_effect_held');
   return true;
  });
 }
 async function runCatalogAdoption(operation,intent,source,callback){
  if(!operation||typeof operation.id!=='string'||typeof operation.lease_owner!=='string'||!intent||!source||typeof callback!=='function')fail('fence_unavailable');
  const claim=processing.transaction(()=>{
   const row=processing.database.prepare("SELECT * FROM dataset_operations WHERE id=? AND operation_type='catalog_map' AND status='leased' AND lease_owner=? AND lease_expires_at>?").get(operation.id,operation.lease_owner,new Date().toISOString());
   if(!row||processing.hasAnySourceBinding()||!processing.referenceCatalogRecoveryAllowed(operation.id))fail('lifecycle_effect_held');
   let payload;try{payload=JSON.parse(row.payload_json)}catch{fail('lifecycle_effect_held')}
   const dataset=processing.getDataset(payload.ids?.datasetId,true);
   if(!payload.adoptionIntent||JSON.stringify(payload.adoptionIntent)!==JSON.stringify(intent)||intent.rootKey!==source.rootKey||intent.relativePath!==source.relativePath||intent.sourceFingerprint!==source.fingerprint||payload.sourceFingerprint!==source.fingerprint||payload.ids?.datasetId!==source.datasetId||intent.datasetRelative!==source.datasetId||!dataset||dataset.rootKey!=='datasets'||dataset.relativePath!==intent.datasetRelative||dataset.status!=='finalizing')fail('lifecycle_effect_held');
   const datasetIdentity=JSON.stringify([dataset.id,dataset.projectId,dataset.storageMode,dataset.rootKey,dataset.relativePath,dataset.status]);
   const id=crypto.randomUUID();processing.database.prepare("INSERT INTO reference_adoption_effects VALUES(?,?,?,?,'in_flight',?,NULL)").run(id,operation.id,row.payload_json,operation.lease_owner,new Date().toISOString());return {id,payload:row.payload_json,datasetIdentity};
  });
  const adopted=await callback();if(!adopted||!adopted.scan)fail('lifecycle_effect_held');
  return processing.transaction(()=>{
   const row=processing.database.prepare("SELECT payload_json FROM dataset_operations WHERE id=? AND operation_type='catalog_map' AND status='leased' AND lease_owner=? AND lease_expires_at>?").get(operation.id,operation.lease_owner,new Date().toISOString());
   if(!row||row.payload_json!==claim.payload||!processing.referenceCatalogRecoveryAllowed(operation.id))fail('lifecycle_effect_held');
   const current=processing.getDataset(source.datasetId,true);if(!current||JSON.stringify([current.id,current.projectId,current.storageMode,current.rootKey,current.relativePath,current.status])!==claim.datasetIdentity)fail('lifecycle_effect_held');
   const payload=JSON.parse(row.payload_json);
   if(adopted.sourceToRemove){const {rootKey,relativePath,sourceFingerprint,sourceByteSize,sourceDev,sourceIno,sourceCtimeNs,sourceMtimeNs}=intent;if(!/^[a-f0-9]{64}$/.test(sourceFingerprint)||!Number.isSafeInteger(sourceByteSize)||sourceByteSize<0||[sourceDev,sourceIno,sourceCtimeNs,sourceMtimeNs].some(x=>!/^\d+$/.test(String(x))))fail('lifecycle_effect_held');payload.sourceCleanup={rootKey,relativePath,sourceFingerprint,sourceByteSize,sourceDev,sourceIno,sourceCtimeNs,sourceMtimeNs};}
   if(processing.database.prepare("UPDATE reference_adoption_effects SET state='completed',completed_at=? WHERE id=? AND state='in_flight'").run(new Date().toISOString(),claim.id).changes!==1)fail('lifecycle_effect_held');
   if(adopted.sourceToRemove&&processing.database.prepare("UPDATE dataset_operations SET payload_json=?,updated_at=? WHERE id=? AND payload_json=? AND lease_owner=?").run(JSON.stringify(payload),new Date().toISOString(),operation.id,claim.payload,operation.lease_owner).changes!==1)fail('lifecycle_effect_held');
   return adopted;
  });
 }
 return Object.freeze({run,runCatalogCleanup,runCatalogAdoption});
}
// Registration is per repository instance and intentionally has no production
// configuration or automatic installation. Other processes are not covered.
function registerOfflineFixtureFence(processing,scope){const fence=createOfflineLifecycleFence(processing,scope);offlineFences.set(processing,fence);return fence;}
function registeredOfflineFixtureFence(processing){return offlineFences.get(processing)||null;}
function hasOfflineFixture(processing){return Boolean(processing?.database?.prepare&&processing.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('reference_lifecycle_effects','reference_catalog_cleanup_effects','reference_adoption_effects') LIMIT 1").get());}
module.exports={installOfflineFixture,createOfflineLifecycleFence,registerOfflineFixtureFence,registeredOfflineFixtureFence,hasOfflineFixture};
