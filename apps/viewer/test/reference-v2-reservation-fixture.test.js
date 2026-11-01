'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createSyntheticReservation,SCOPE}=require('../server/referenceV2ReservationFixture');
const id=n=>Buffer.alloc(32,n).toString('base64url');
const digest=b=>crypto.createHash('sha256').update(b).digest('hex');
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-reservation-')),file=path.join(dir,'fixture.sqlite');let db=new DatabaseSync(file);t.after(()=>{try{db.close()}catch{}for(const suffix of ['', '-journal','-wal','-shm']){try{fs.unlinkSync(file+suffix)}catch(e){if(e.code!=='ENOENT')throw e}}fs.rmdirSync(dir)});return{file,get db(){return db},reopen(){db.close();db=new DatabaseSync(file);return db}}}
function data(){const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519'),bytes=Buffer.from('synthetic source');return {privateKey,bytes,input:{intentId:id(1),idempotencyId:id(2),reservationId:id(3),receiptId:id(4),jobId:'fixture-job',generation:1,sourceId:'fixture-source',sourceRevision:'rev-1',sourceSha256:digest(bytes),sourceBytes:bytes.length,byteBudget:bytes.length,keyId:'test-key',publicKeyDer:publicKey.export({type:'spki',format:'der'})}}}
test('durable reservation pins bytes and rejects quota and conflicting replay',t=>{
 const f=setup(t),d=data();assert.throws(()=>createSyntheticReservation(f.db,'production'),{code:'fixture_scope_required'});let s=createSyntheticReservation(f.db,SCOPE);assert.throws(()=>s.liveReserve(),{code:'v2_reservation_not_qualified'});s.provisionQuota(d.bytes.length);s.addSource({sourceId:d.input.sourceId,revision:d.input.sourceRevision,bytes:d.bytes});
 const first=s.reserve(d.input);assert.equal(first.state,'committed');assert.deepEqual(s.reserve(d.input).receipt,first.receipt);assert.throws(()=>s.reserve({...d.input,sourceRevision:'changed'}),{code:'reservation_conflict'});
 assert.throws(()=>f.db.prepare('UPDATE v2s_sources SET content=? WHERE id=?').run(Buffer.from('bad'),d.input.sourceId),/synthetic source pinned/);
 assert.throws(()=>f.db.prepare('INSERT OR REPLACE INTO v2s_sources VALUES(?,?,?,?)').run(d.input.sourceId,'x',Buffer.from('bad'),digest(Buffer.from('bad'))),/synthetic source pinned/);
 assert.throws(()=>f.db.prepare('DELETE FROM v2s_reservations WHERE reservation_id=?').run(d.input.reservationId),/synthetic reservation immutable/);
 const another={...d.input,intentId:id(5),idempotencyId:id(6),reservationId:id(7),receiptId:id(8)};assert.throws(()=>s.reserve(another),{code:'quota_exceeded'});
 s=createSyntheticReservation(f.reopen(),SCOPE);assert.deepEqual(s.reserve(d.input).receipt,first.receipt);assert.equal(f.db.prepare('SELECT used FROM v2s_quota').get().used,d.bytes.length);
});
test('interruption after signing but before storing leaves committed replayable outbox',t=>{
 const f=setup(t),d=data();let s=createSyntheticReservation(f.db,SCOPE);s.provisionQuota(d.bytes.length);s.addSource({sourceId:d.input.sourceId,revision:d.input.sourceRevision,bytes:d.bytes});const saved=s.reserve(d.input).receipt;let firstSignature;
 assert.throws(()=>s.signCommitted(d.input.reservationId,message=>{firstSignature=crypto.sign(null,message,d.privateKey);throw Error('injected interruption')}),/injected interruption/);
 assert.equal(f.db.prepare('SELECT state FROM v2s_reservations').get().state,'committed');s=createSyntheticReservation(f.reopen(),SCOPE);
 const signed=s.signCommitted(d.input.reservationId,message=>crypto.sign(null,message,d.privateKey));assert.deepEqual(signed.receipt,saved);assert.deepEqual(signed.signature,firstSignature);assert.equal(signed.state,'signed');
 assert.deepEqual(s.signCommitted(d.input.reservationId,()=>{throw Error('must not sign again')}),signed);
 assert.equal(f.db.prepare('SELECT used FROM v2s_quota').get().used,d.bytes.length);
});
test('wrong signer cannot commit the synthetic outbox signature',t=>{
 const f=setup(t),d=data(),other=crypto.generateKeyPairSync('ed25519'),s=createSyntheticReservation(f.db,SCOPE);s.provisionQuota(d.bytes.length);s.addSource({sourceId:d.input.sourceId,revision:d.input.sourceRevision,bytes:d.bytes});s.reserve(d.input);
 assert.throws(()=>s.signCommitted(d.input.reservationId,m=>crypto.sign(null,m,other.privateKey)),{code:'synthetic_signature_invalid'});assert.equal(f.db.prepare('SELECT state FROM v2s_reservations').get().state,'committed');
 assert.throws(()=>s.signCommitted(d.input.reservationId,m=>{m[0]^=1;return crypto.sign(null,m,d.privateKey)}),{code:'synthetic_signature_invalid'});assert.equal(f.db.prepare('SELECT state FROM v2s_reservations').get().state,'committed');
});
test('tampered synthetic source holds receipt replay and signing',t=>{
 const f=setup(t),d=data(),s=createSyntheticReservation(f.db,SCOPE);s.provisionQuota(d.bytes.length);s.addSource({sourceId:d.input.sourceId,revision:d.input.sourceRevision,bytes:d.bytes});s.reserve(d.input);
 // Deliberately simulate a noncooperating writer in an isolated fixture.
 f.db.exec('DROP TRIGGER v2s_source_no_update');f.db.prepare('UPDATE v2s_sources SET content=? WHERE id=?').run(Buffer.from('tampered'),d.input.sourceId);
 assert.throws(()=>s.reserve(d.input),{code:'source_conflict'});assert.throws(()=>s.signCommitted(d.input.reservationId,m=>crypto.sign(null,m,d.privateKey)),{code:'source_conflict'});
});

test('owned process kills after reservation commit and after signing preserve one outbox',async t=>{
 const {spawn}=require('node:child_process'),f=setup(t),d=data(),modulePath=require.resolve('../server/referenceV2ReservationFixture');let child;
 let s=createSyntheticReservation(f.db,SCOPE);s.provisionQuota(d.bytes.length);s.addSource({sourceId:d.input.sourceId,revision:d.input.sourceRevision,bytes:d.bytes});
 const arg=JSON.stringify({...d.input,publicKeyDer:d.input.publicKeyDer.toString('base64')});
 const privateDer=d.privateKey.export({type:'pkcs8',format:'der'}).toString('base64');
 const script=`const {DatabaseSync}=require('node:sqlite'),c=require('node:crypto');const {createSyntheticReservation,SCOPE}=require(process.argv[1]);const db=new DatabaseSync(process.argv[2]),s=createSyntheticReservation(db,SCOPE),i=JSON.parse(process.argv[4]);i.publicKeyDer=Buffer.from(i.publicKeyDer,'base64');if(process.argv[3]==='reserve'){s.reserve(i);process.send('committed');setInterval(()=>{},1000)}else{s.signCommitted(i.reservationId,m=>{c.sign(null,m,{key:Buffer.from(process.argv[5],'base64'),format:'der',type:'pkcs8'});process.send('signed-not-stored');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);throw Error('not killed')})}`;
 async function killAt(mode,expected){child=spawn(process.execPath,['-e',script,modulePath,f.file,mode,arg,privateDer],{stdio:['ignore','ignore','ignore','ipc']});const marker=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child timeout')),8000);child.once('message',m=>{clearTimeout(timer);resolve(m)});child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',()=>{clearTimeout(timer);reject(Error('early exit'))})});assert.equal(marker,expected);const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;child=null}
 try {
  await killAt('reserve','committed');assert.equal(f.db.prepare('SELECT state FROM v2s_reservations').get().state,'committed');assert.equal(f.db.prepare('SELECT used FROM v2s_quota').get().used,d.bytes.length);
  await killAt('sign','signed-not-stored');assert.equal(f.db.prepare('SELECT state FROM v2s_reservations').get().state,'committed');
  s=createSyntheticReservation(f.reopen(),SCOPE);const signed=s.signCommitted(d.input.reservationId,m=>crypto.sign(null,m,d.privateKey));assert.equal(signed.state,'signed');assert.deepEqual(s.reserve(d.input).receipt,signed.receipt);assert.equal(f.db.prepare('SELECT used FROM v2s_quota').get().used,d.bytes.length);
 } finally {if(child&&child.exitCode===null&&child.signalCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done}}
});

test('concurrent reservations cannot overspend one synthetic quota',async t=>{
 const {Worker}=require('node:worker_threads'),f=setup(t),d=data(),s=createSyntheticReservation(f.db,SCOPE),barrier=new SharedArrayBuffer(4),state=new Int32Array(barrier);let workers=[];
 s.provisionQuota(d.bytes.length);s.addSource({sourceId:d.input.sourceId,revision:d.input.sourceRevision,bytes:d.bytes});
 const modulePath=require.resolve('../server/referenceV2ReservationFixture');const initial={...d.input,publicKeyDer:d.input.publicKeyDer.toString('base64')};
 const script=`const {parentPort,workerData}=require('node:worker_threads'),{DatabaseSync}=require('node:sqlite');const {createSyntheticReservation,SCOPE}=require(workerData.modulePath);const db=new DatabaseSync(workerData.file),s=createSyntheticReservation(db,SCOPE),i=workerData.input,id=n=>Buffer.alloc(32,n).toString('base64url');i.publicKeyDer=Buffer.from(i.publicKeyDer,'base64');i.intentId=id(workerData.n);i.idempotencyId=id(workerData.n+2);i.reservationId=id(workerData.n+4);i.receiptId=id(workerData.n+6);parentPort.postMessage('ready');Atomics.wait(new Int32Array(workerData.barrier),0,0,5000);try{s.reserve(i);parentPort.postMessage('accepted')}catch(e){parentPort.postMessage(e.code||'unexpected')}finally{db.close();parentPort.close()}`;
 workers=[10,20].map(n=>new Worker(script,{eval:true,workerData:{modulePath,file:f.file,input:initial,barrier,n}}));const exits=workers.map(w=>new Promise(resolve=>w.once('exit',resolve)));let ready=0;const answers=workers.map(w=>new Promise((resolve,reject)=>{let answered=false;w.on('message',m=>{if(m==='ready'){if(++ready===2){Atomics.store(state,0,1);Atomics.notify(state,0,2)}}else{answered=true;resolve(m)}});w.on('error',reject);w.on('exit',code=>{if(code!==0||!answered)reject(Error('worker exited without outcome '+code))})}));
 let timer;try{const bounded=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('worker timeout')),8000)});assert.deepEqual((await Promise.race([Promise.all(answers),bounded])).sort(),['accepted','quota_exceeded']);assert.deepEqual(await Promise.all(exits),[0,0]);assert.equal(f.db.prepare('SELECT used FROM v2s_quota').get().used,d.bytes.length);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM v2s_reservations').get().n,1)}finally{clearTimeout(timer);await Promise.all(workers.map(w=>w.terminate()))}
});
