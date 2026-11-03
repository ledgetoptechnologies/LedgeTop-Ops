'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {createHeldSourceSnapshot,getHeldSourceSnapshot,verifyHeldSourceSnapshot,acceptHeldSourceSnapshot,releaseHeldSourceSnapshot,SNAPSHOT_DOMAIN}=require('../server/heldSourceSnapshot');
const {frameStream,SELECTED_VERSION,SELECTED_DOMAIN}=require('../server/viewerPagedSourceExport');
const {canonicalBytes}=require('../server/referenceProtocol');
const {prepareSelectedGeneration}=require('../server/selectedSourceGenerationCandidate');

test('held generation binds exact signed selection and survives reopen without adopting partial bytes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'generation-test-')),dbPath=path.join(root,'viewer.sqlite');let db=openDatabase(dbPath);
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 let p=new ProcessingRepository(db);const project=p.createProject({displayName:'Synthetic'});
 const dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'one',relativePath:'one.jpg',byteSize:3,sha256:'a'.repeat(64),contentType:'image/jpeg'},{id:'two',relativePath:'two.jpg',byteSize:4,sha256:'b'.repeat(64),contentType:'image/jpeg'}];
 p.finalizeDataset(dataset.id,files,'c'.repeat(64));const task=p.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Synthetic'});
 const provider=p.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint:'http://127.0.0.1:3000',enabled:true});const attempt=p.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
 const keys=crypto.generateKeyPairSync('ed25519');const snapshot=createHeldSourceSnapshot(p,{datasetId:dataset.id,taskId:task.id,attemptId:attempt.id,signer:{issuerId:'issuer',keyId:'key',sign:v=>crypto.sign(null,v,keys.privateKey)}});
 const selected=files.map(f=>({id:f.id,relativePath:f.relativePath,byteSize:f.byteSize,sha256:f.sha256}));
 const args={attemptId:attempt.id,generation:1,snapshotId:snapshot.snapshotId,snapshotSha256:snapshot.intentSha256,publicKey:keys.publicKey,rootRef:'operator-root',selected};
 // Test-only corrupt database fixture: replace the signed payload with a
 // coherently re-signed omission or duplicate, including all dependent hashes.
 db.exec('DROP TRIGGER viewer_source_snapshots_payload_immutable; DROP TRIGGER viewer_source_snapshots_lifecycle_guard');
 const put=db.prepare('UPDATE viewer_source_snapshots SET input_manifest_sha256=?,intent_json=?,intent_sha256=?,signature=?,selected_frames=?,selected_page_hashes_json=?,selected_frame_bytes=? WHERE snapshot_id=?');
 for(const ids of [['one'],['one','one']]){
  const marks=ids.map((id,ordinal)=>({type:'dataset_file',ordinal,pageObjectId:id,datasetFileId:id}));
  const frames=frameStream(marks,SELECTED_VERSION,SELECTED_DOMAIN),subset=ids.map(id=>selected.find(f=>f.id===id));
  const input=subset.map(f=>({relativePath:f.relativePath,byteSize:f.byteSize,sha256:f.sha256}));
  const intent={...snapshot.intent,selectedCount:ids.length,selectedPageHashes:frames.pageHashes,selectedFrameBytes:frames.bytes.length,inputManifestSha256:crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex')};
  const raw=canonicalBytes(intent),sha=crypto.createHash('sha256').update(raw).digest('hex'),signature=crypto.sign(null,Buffer.concat([SNAPSHOT_DOMAIN,raw]),keys.privateKey);
  put.run(intent.inputManifestSha256,raw.toString('utf8'),sha,signature,frames.bytes,JSON.stringify(frames.pageHashes),frames.bytes.length,snapshot.snapshotId);
  assert.equal(verifyHeldSourceSnapshot(getHeldSourceSnapshot(p,snapshot.snapshotId),keys.publicKey),true);
  assert.throws(()=>prepareSelectedGeneration(p,{...args,snapshotSha256:sha,selected:subset}),{code:'GENERATION_HELD'});
 }
 put.run(snapshot.inputManifestSha256,canonicalBytes(snapshot.intent).toString('utf8'),snapshot.intentSha256,snapshot.signature,snapshot.selectedFrames,JSON.stringify(snapshot.selectedPageHashes),snapshot.selectedFrameBytes,snapshot.snapshotId);
 assert.throws(()=>prepareSelectedGeneration(p,{...args,selected:[...selected].reverse()}),{code:'GENERATION_HELD'});
 assert.throws(()=>prepareSelectedGeneration(p,{...args,selected:[{...selected[0],byteSize:4},selected[1]]}),{code:'GENERATION_HELD'});
 assert.throws(()=>prepareSelectedGeneration(p,{...args,snapshotSha256:'0'.repeat(64)}),{code:'GENERATION_HELD'});
 db.prepare("UPDATE processing_attempts SET status='failed' WHERE id=?").run(attempt.id);
 assert.throws(()=>prepareSelectedGeneration(p,args),{code:'GENERATION_HELD'});
 db.prepare("UPDATE processing_attempts SET status='pending' WHERE id=?").run(attempt.id);
 assert.deepEqual(prepareSelectedGeneration(p,args),{state:'held',replay:false,admissionAvailable:false});
 assert.deepEqual(prepareSelectedGeneration(p,args),{state:'held',replay:true,admissionAvailable:false});
 assert.throws(()=>prepareSelectedGeneration(p,{...args,rootRef:'different-root'}),{code:'GENERATION_HELD'});
 assert.throws(()=>db.prepare('DELETE FROM candidate_selected_source_generations').run(),/retained/);
 assert.throws(()=>db.prepare('UPDATE candidate_selected_source_generations SET root_ref=?').run('other'),/retained/);
 assert.throws(()=>db.prepare('INSERT OR REPLACE INTO candidate_selected_source_generations SELECT * FROM candidate_selected_source_generations').run(),/unavailable/);
 const partial=path.join(root,'synthetic-partial');fs.writeFileSync(partial,'partial');db.close();db=openDatabase(dbPath);p=new ProcessingRepository(db);
 assert.deepEqual(prepareSelectedGeneration(p,args),{state:'held',replay:true,admissionAvailable:false});assert.equal(fs.readFileSync(partial,'utf8'),'partial');
 const receipt={synthetic:true};acceptHeldSourceSnapshot(p,snapshot.snapshotId,{receipt,verifyAcceptance:()=>true});
 assert.throws(()=>releaseHeldSourceSnapshot(p,snapshot.snapshotId,{verifyAcceptance:()=>true}),/candidate generation retained/);
 assert.throws(()=>prepareSelectedGeneration(p,args),{code:'GENERATION_HELD'});
});

test('review migration opens an existing database without changing prior rows',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'generation-migration-')),file=path.join(root,'db.sqlite');let db=openDatabase(file);
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Existing'});
 db.exec('DROP TRIGGER candidate_generation_snapshot_release; DROP TRIGGER candidate_generation_no_delete; DROP TRIGGER candidate_generation_no_update; DROP TRIGGER candidate_generation_insert; DROP TABLE candidate_selected_source_generations; DELETE FROM schema_migrations WHERE version=70');
 db.close();db=openDatabase(file);
 assert.equal(new ProcessingRepository(db).getProject(project.id).displayName,'Existing');
 assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='candidate_selected_source_generations'").get());
});
