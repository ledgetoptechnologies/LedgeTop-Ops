'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {openDatabase}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository');
const {createHeldSourceSnapshot}=require('../server/heldSourceSnapshot'),{prepareSelectedGeneration}=require('../server/selectedSourceGenerationCandidate'),{copySelectedSource}=require('../server/selectedSourceCopyCandidate');
const linux={skip:process.platform!=='linux'};
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'selected-copy-')),source=path.join(root,'source'),spool=path.join(root,'spool');fs.mkdirSync(source);fs.mkdirSync(spool);fs.mkdirSync(path.join(source,'data'));
 const body=Buffer.from('synthetic photo'),sha=crypto.createHash('sha256').update(body).digest('hex');fs.writeFileSync(path.join(source,'data','a.jpg'),body);
 const db=openDatabase(path.join(root,'db'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});const p=new ProcessingRepository(db);
 const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'data'});
 p.finalizeDataset(dataset.id,[{id:'photo',relativePath:'a.jpg',byteSize:body.length,sha256:sha,contentType:'image/jpeg'}],'b'.repeat(64));
 const task=p.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Synthetic'}),provider=p.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint:'http://127.0.0.1:3000',enabled:true}),attempt=p.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
 const keys=crypto.generateKeyPairSync('ed25519'),snapshot=createHeldSourceSnapshot(p,{datasetId:dataset.id,taskId:task.id,attemptId:attempt.id,signer:{issuerId:'issuer',keyId:'key',sign:v=>crypto.sign(null,v,keys.privateKey)}});
 const binding={attemptId:attempt.id,generation:1,snapshotId:snapshot.snapshotId,snapshotSha256:snapshot.intentSha256,publicKey:keys.publicKey,rootRef:'operator-root',selected:[{id:'photo',relativePath:'a.jpg',byteSize:body.length,sha256:sha}]};
 prepareSelectedGeneration(p,binding);const pin=v=>{const s=fs.statSync(v,{bigint:true});return {device:String(s.dev),inode:String(s.ino)};};
 return {root,source,spool,body,p,binding,options:{binding,sourceRoot:source,sourcePin:pin(source),spoolRoot:spool,spoolPin:pin(spool)}};
}
test('selected copy seals exact generation and never reuses a copy',linux,t=>{
 const f=fixture(t),result=copySelectedSource(f.p,f.options),dir=path.join(f.spool,`${f.binding.attemptId}-g1`),seal=JSON.parse(fs.readFileSync(path.join(dir,'sealed.json')));
 assert.deepEqual(fs.readFileSync(path.join(dir,'photo')),f.body);assert.equal(seal.snapshotSha256,f.binding.snapshotSha256);assert.equal(seal.generation,1);assert.equal(seal.rootRef,'operator-root');assert.equal(result.admissionAvailable,false);
 const reopened=openDatabase(path.join(f.root,'db'));try{assert.equal(reopened.prepare('SELECT state FROM candidate_selected_source_generations WHERE attempt_id=? AND generation=1').get(f.binding.attemptId).state,'held');}finally{reopened.close();}
 assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'sealed.json'))).digest('hex'),result.sealSha256);
 fs.writeFileSync(path.join(f.source,'data','a.jpg'),'changed');assert.deepEqual(fs.readFileSync(path.join(dir,'photo')),f.body);
 assert.throws(()=>copySelectedSource(f.p,f.options),{code:'SELECTED_COPY_HELD'});
});
test('mutated source holds partial data and never publishes a seal',linux,t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.source,'data','a.jpg'),Buffer.alloc(f.body.length,42));
 assert.throws(()=>copySelectedSource(f.p,f.options),{code:'SELECTED_COPY_HELD'});
 const dir=path.join(f.spool,`${f.binding.attemptId}-g1`);assert.ok(fs.existsSync(path.join(dir,'intent.json')));assert.equal(fs.existsSync(path.join(dir,'sealed.json')),false);
 assert.throws(()=>copySelectedSource(f.p,f.options),{code:'SELECTED_COPY_HELD'});
});
test('operator root identity mismatch fails before creating a generation',linux,t=>{
 const f=fixture(t);assert.throws(()=>copySelectedSource(f.p,{...f.options,spoolPin:{...f.options.spoolPin,inode:'1'}}),{code:'SELECTED_COPY_HELD'});assert.deepEqual(fs.readdirSync(f.spool),[]);
 assert.throws(()=>copySelectedSource(f.p,{...f.options,spoolRoot:f.source,spoolPin:f.options.sourcePin}),{code:'SELECTED_COPY_HELD'});
 assert.equal(fs.existsSync(path.join(f.source,`${f.binding.attemptId}-g1`)),false);
});
test('insufficient or invalid free-space observation holds before creating a directory',linux,async t=>{
 for(const bad of [{bavail:14n,bsize:1n},{bavail:-1n,bsize:1n},{bavail:100n,bsize:0n}])await t.test(String(bad.bavail)+':'+String(bad.bsize),t=>{
  const f=fixture(t),original=fs.statfsSync;fs.statfsSync=()=>bad;
  try{assert.throws(()=>copySelectedSource(f.p,{...f.options,minFreeBytes:1}),{code:'SELECTED_COPY_HELD'});}finally{fs.statfsSync=original;}
  assert.deepEqual(fs.readdirSync(f.spool),[]);
 });
});
test('space pressure after a short write preserves partial bytes without a seal',linux,t=>{
 const f=fixture(t),statfs=fs.statfsSync,write=fs.writeSync;let pressure=false;
 fs.statfsSync=(...args)=>pressure?{bavail:0n,bsize:1n}:statfs(...args);
 fs.writeSync=(fd,buffer,offset,length,position)=>{let target='';try{target=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}if(target.endsWith('/photo')&&!pressure){const count=write(fd,buffer,offset,Math.min(3,length),position);pressure=true;return count;}return write(fd,buffer,offset,length,position);};
 try{assert.throws(()=>copySelectedSource(f.p,f.options),{code:'SELECTED_COPY_HELD'});}finally{fs.statfsSync=statfs;fs.writeSync=write;}
 const dir=path.join(f.spool,`${f.binding.attemptId}-g1`);assert.equal(fs.statSync(path.join(dir,'photo')).size,3);assert.equal(fs.existsSync(path.join(dir,'sealed.json')),false);
});
test('already written bytes are not counted twice against later free space',linux,t=>{
 const f=fixture(t),statfs=fs.statfsSync,write=fs.writeSync;let written=0;
 fs.statfsSync=()=>({bavail:BigInt(1+f.body.length-written),bsize:1n});
 fs.writeSync=(fd,buffer,offset,length,position)=>{let target='';try{target=fs.readlinkSync(`/proc/self/fd/${fd}`);}catch{}if(target.endsWith('/photo')){const n=write(fd,buffer,offset,Math.min(3,length),position);written+=n;return n;}return write(fd,buffer,offset,length,position);};
 try{assert.equal(copySelectedSource(f.p,{...f.options,minFreeBytes:1}).admissionAvailable,false);}finally{fs.statfsSync=statfs;fs.writeSync=write;}
 assert.equal(written,f.body.length);
});
test('process death after generation directory creation leaves it held and never retries',linux,t=>{
 const f=fixture(t),options={...f.options,binding:{...f.binding,publicKey:f.binding.publicKey.export({type:'spki',format:'pem'})}};
 const script=`const fs=require('node:fs');const {openDatabase}=require('./apps/viewer/server/database');const {ProcessingRepository}=require('./apps/viewer/server/processingRepository');const {copySelectedSource}=require('./apps/viewer/server/selectedSourceCopyCandidate');const o=JSON.parse(process.argv[1]);const db=openDatabase(process.argv[2]);const original=fs.fsyncSync;let n=0;fs.fsyncSync=(fd)=>{original(fd);if(++n===1)process.kill(process.pid,'SIGKILL');};copySelectedSource(new ProcessingRepository(db),o);`;
 const child=spawnSync(process.execPath,['-e',script,JSON.stringify(options),path.join(f.root,'db')],{cwd:path.join(__dirname,'../../..'),timeout:15000,encoding:'utf8'});
 assert.equal(child.signal,'SIGKILL');const dir=path.join(f.spool,`${f.binding.attemptId}-g1`);assert.ok(fs.existsSync(dir));assert.equal(fs.existsSync(path.join(dir,'sealed.json')),false);
 assert.throws(()=>copySelectedSource(f.p,f.options),{code:'SELECTED_COPY_HELD'});assert.ok(fs.existsSync(dir));
});
