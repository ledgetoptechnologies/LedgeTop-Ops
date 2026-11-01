'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createManagedFileExperiment,MAX_BYTES}=require('../server/referenceV2ManagedFileCandidate');
const id=n=>Buffer.alloc(32,n).toString('base64url'),sha=b=>crypto.createHash('sha256').update(b).digest('hex');

test('file snapshot survives restart and original removal, with one reservation charge', {skip:process.platform!=='linux'}, t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-file-reservation-')),dbPath=path.join(dir,'ledger.sqlite'),source=path.join(dir,'source.bin');
 const bytes=Buffer.from('synthetic managed source'),{privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');fs.writeFileSync(source,bytes);
 const rootFd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY),input={intentId:id(1),idempotencyId:id(2),reservationId:id(3),receiptId:id(4),jobId:'fixture-job',generation:1,sourceId:'source',sourceRevision:'rev1',sourceSha256:sha(bytes),sourceBytes:bytes.length,byteBudget:bytes.length,keyId:'fixture-key',publicKeyDer:publicKey.export({format:'der',type:'spki'})};
 let db=new DatabaseSync(dbPath);t.after(()=>{try{db.close()}catch{}fs.closeSync(rootFd);for(const n of ['source.bin','alias','ledger.sqlite','ledger.sqlite-wal','ledger.sqlite-shm','ledger.sqlite-journal'])try{fs.unlinkSync(path.join(dir,n))}catch(e){if(e.code!=='ENOENT')throw e}fs.rmdirSync(dir)});
 const make=()=>createManagedFileExperiment({database:db,rootFd,scope:'isolated-managed-file-experiment'});let service=make();service.provisionQuota(bytes.length);
 assert.throws(()=>service.issue(),{code:'v2_reservation_not_qualified'});const receipt=service.reserveFixture('source.bin',input).receipt;
 fs.unlinkSync(source);db.close();db=new DatabaseSync(dbPath);service=make();assert.deepEqual(service.reserveFixture('source.bin',input).receipt,receipt);
 assert.deepEqual(service.signFixture(input.reservationId,m=>crypto.sign(null,m,privateKey)).receipt,receipt);
 assert.equal(db.prepare('SELECT used FROM v2s_quota').get().used,bytes.length);
 assert.deepEqual(Buffer.from(db.prepare('SELECT content FROM v2s_sources').get().content),bytes);
 assert.throws(()=>db.prepare('DELETE FROM v2s_sources WHERE id=?').run(input.sourceId),/synthetic source pinned/);
 assert.throws(()=>service.reserveFixture('source.bin',{...input,sourceSha256:sha('different')}),{code:'source_binding_conflict'});
 assert.throws(()=>service.reserveFixture('other.bin',input),{code:'source_binding_conflict'});
 assert.throws(()=>service.reserveFixture('source.bin',{...input,sourceId:'other'}),{code:'source_binding_conflict'});
 const otherDir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-other-root-')),otherFd=fs.openSync(otherDir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
 try{const other=createManagedFileExperiment({database:db,rootFd:otherFd,scope:'isolated-managed-file-experiment'});assert.throws(()=>other.reserveFixture('source.bin',input),{code:'source_binding_conflict'});}finally{fs.closeSync(otherFd);fs.rmdirSync(otherDir)}
});

test('file snapshot rejects symlinks, hardlinks, changed content and oversize', {skip:process.platform!=='linux'}, t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-file-invalid-')),source=path.join(dir,'source.bin'),databases=[],bytes=Buffer.from('abc');fs.writeFileSync(source,bytes);fs.symlinkSync('source.bin',path.join(dir,'alias'));
 const rootFd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);t.after(()=>{for(const db of databases)db.close();fs.closeSync(rootFd);fs.unlinkSync(path.join(dir,'alias'));fs.unlinkSync(source);fs.rmdirSync(dir)});
 const make=()=>{const db=new DatabaseSync(':memory:');databases.push(db);return createManagedFileExperiment({database:db,rootFd,scope:'isolated-managed-file-experiment'})},input={sourceId:'source',sourceRevision:'rev1',sourceBytes:3,sourceSha256:sha(bytes)};
 assert.throws(()=>make().reserveFixture('alias',input));assert.throws(()=>make().reserveFixture('../source.bin',input),{code:'source_invalid'});
 fs.unlinkSync(path.join(dir,'alias'));fs.linkSync(source,path.join(dir,'alias'));assert.throws(()=>make().reserveFixture('source.bin',input),{code:'source_changed'});
 fs.unlinkSync(path.join(dir,'alias'));fs.symlinkSync('source.bin',path.join(dir,'alias'));assert.throws(()=>make().reserveFixture('source.bin',{...input,sourceSha256:sha('bad')}),{code:'source_changed'});
 assert.throws(()=>make().reserveFixture('source.bin',{...input,sourceBytes:MAX_BYTES+1}),{code:'source_invalid'});
});

test('process interruption after file copy holds uncharged bytes for exact recovery', {skip:process.platform!=='linux'}, async t=>{
 const {spawn}=require('node:child_process'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-file-crash-')),dbPath=path.join(dir,'ledger.sqlite'),bytes=Buffer.from('crash fixture'),source=path.join(dir,'source.bin');fs.writeFileSync(source,bytes);
 const {publicKey}=crypto.generateKeyPairSync('ed25519'),input={intentId:id(11),idempotencyId:id(12),reservationId:id(13),receiptId:id(14),jobId:'fixture-job',generation:1,sourceId:'source',sourceRevision:'rev1',sourceSha256:sha(bytes),sourceBytes:bytes.length,byteBudget:bytes.length,keyId:'fixture-key',publicKeyDer:publicKey.export({format:'der',type:'spki'}).toString('base64')};
 const modulePath=require.resolve('../server/referenceV2ManagedFileCandidate'),rootFd=fs.openSync(dir,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);let db=new DatabaseSync(dbPath),child;
 createManagedFileExperiment({database:db,rootFd,scope:'isolated-managed-file-experiment'}).provisionQuota(bytes.length);db.close();db=null;
 t.after(()=>{if(db)db.close();fs.closeSync(rootFd);for(const n of ['source.bin','ledger.sqlite','ledger.sqlite-wal','ledger.sqlite-shm','ledger.sqlite-journal'])try{fs.unlinkSync(path.join(dir,n))}catch(e){if(e.code!=='ENOENT')throw e}fs.rmdirSync(dir)});
 const script=`const fs=require('node:fs'),{DatabaseSync}=require('node:sqlite'),{createManagedFileExperiment}=require(process.argv[1]);const db=new DatabaseSync(process.argv[2]),rootFd=fs.openSync(process.argv[3],fs.constants.O_RDONLY|fs.constants.O_DIRECTORY),i=JSON.parse(process.argv[4]);i.publicKeyDer=Buffer.from(i.publicKeyDer,'base64');createManagedFileExperiment({database:db,rootFd,scope:'isolated-managed-file-experiment',afterCopy(){process.send('copied');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000)}}).reserveFixture('source.bin',i)`;
 try{
  child=spawn(process.execPath,['-e',script,modulePath,dbPath,dir,JSON.stringify(input)],{stdio:['ignore','ignore','ignore','ipc']});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child timeout')),5000);child.once('message',m=>{clearTimeout(timer);m==='copied'?resolve():reject(Error('unexpected marker'))});child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',()=>{clearTimeout(timer);reject(Error('early child exit'))})});
  const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exit;child=null;
  db=new DatabaseSync(dbPath);assert.equal(db.prepare('SELECT used FROM v2s_quota').get().used,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM v2s_reservations').get().n,0);fs.unlinkSync(source);
  input.publicKeyDer=Buffer.from(input.publicKeyDer,'base64');const service=createManagedFileExperiment({database:db,rootFd,scope:'isolated-managed-file-experiment'});assert.equal(service.reserveFixture('source.bin',input).state,'committed');assert.equal(db.prepare('SELECT used FROM v2s_quota').get().used,bytes.length);
 }finally{if(child&&child.exitCode===null&&child.signalCode===null){const exit=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exit}}
});
