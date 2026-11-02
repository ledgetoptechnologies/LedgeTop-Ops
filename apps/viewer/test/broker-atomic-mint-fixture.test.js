'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {ReferenceTransferBroker}=require('../server/referenceTransferBroker'),p=require('../server/referenceProtocol');
test('broker synthetic method commits grant and sealed record together',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-broker-fixture-'));t.diagnostic(`Retained synthetic fixture directory: ${root}`);
 const file=path.join(root,'image.jpg'),dbfile=path.join(root,'broker.sqlite');fs.writeFileSync(file,'abcdef');const key=Buffer.alloc(32,9);
 const manifest={id:'m',revision:1,sha256:'0'.repeat(64),totalBytes:6,objectCount:1,inputCounts:{images:1,lidarObjects:0,points:0},objects:[{id:'image',name:'image.jpg',byteSize:6,sha256:p.sha256('abcdef'),kind:'image',mediaType:'image/jpeg'}]};manifest.sha256=p.manifestSha256(manifest);
 const caps=p.createCapabilities('staging'),reservation={reservationId:'r',generation:1,expiresAt:new Date(Date.now()+60000).toISOString(),manifestSha256:manifest.sha256,byteBudget:18,nonce:'nonce'},input={jobId:'j',generation:1,manifest,reservation,reservationAvailable:true,objectFiles:{image:file},capabilities:caps,capabilityFingerprint:caps.capabilityFingerprint},binding={attemptId:'a',environment:'staging',jobId:'j',generation:1,reservationId:'r',manifestSha256:manifest.sha256,objectIds:['image']};
 let broker=new ReferenceTransferBroker({databasePath:dbfile,managedRoot:root,environment:'staging',allowCreate:true});
 const construct=()=>({issue:(operationId,binding,input)=>broker.mintGrantAndSealFixture({scope:'synthetic-only',operationId,binding,input,verifyReservation:()=>true,verifySourcePin:()=>true,keyProvider:()=>({keyId:'k',key})})});
 try{
  assert.throws(()=>broker.migrateAtomicGrantFixture('production'),{code:'TRANSFER_ACCOUNTING_UNAVAILABLE'});broker.migrateAtomicGrantFixture('synthetic-only');
  assert.throws(()=>broker.mintGrantAndSealFixture({scope:'synthetic-only',operationId:'stale',binding:{...binding,extra:true},input,verifyReservation:()=>true,verifySourcePin:()=>true,keyProvider:()=>({keyId:'k',key})}),{code:'EXTRA_FIELDS'});
  let authority=true;assert.equal(authority,true);
  assert.throws(()=>broker.mintGrantAndSealFixture({scope:'synthetic-only',operationId:'stale',binding,input,verifyReservation:()=>authority,verifySourcePin:()=>true,keyProvider:()=>{authority=false;return {keyId:'k',key}}}),{code:'TRANSFER_ACCOUNTING_UNAVAILABLE'});
  assert.equal(broker.db.prepare('SELECT count(*) n FROM reference_grants').get().n,0);assert.equal(broker.db.prepare('SELECT count(*) n FROM reference_job_usage').get().n,0);assert.equal(broker.db.prepare('SELECT count(*) n FROM fixture_atomic_grants').get().n,0);
  let owner=construct();broker.db.exec("CREATE TRIGGER fixture_abort BEFORE INSERT ON fixture_atomic_grants BEGIN SELECT RAISE(ABORT,'abort seal'); END");
  assert.throws(()=>owner.issue('op',binding,input));broker.db.exec('DROP TRIGGER fixture_abort');
  assert.equal(broker.db.prepare('SELECT count(*) n FROM reference_grants').get().n,0);assert.equal(broker.db.prepare('SELECT count(*) n FROM reference_job_usage').get().n,0);
  const first=owner.issue('op',binding,input);assert.equal(broker.db.prepare('SELECT count(*) n FROM reference_grants').get().n,1);
  broker.close();broker=new ReferenceTransferBroker({databasePath:dbfile,managedRoot:root,environment:'staging'});owner=construct();
  assert.deepEqual(owner.issue('op',binding,input),first);assert.equal(broker.db.prepare('SELECT count(*) n FROM reference_grants').get().n,1);
  const saved=JSON.parse(first.toString()),ack={reservationId:saved.reservationId,generation:saved.generation,manifestSha256:saved.manifestSha256,nonce:saved.nonce,accepted:true,grantSha256:p.sha256(first)},ackArgs={scope:'synthetic-only',operationId:'op',senderGeneration:1,ack,keyProvider:()=>({keyId:'k',key}),verifyReceiver:()=>true};
  assert.throws(()=>broker.acknowledgeAtomicDeliveryFixture(ackArgs),{code:'TRANSFER_ACCOUNTING_UNAVAILABLE'});
  broker.beginAtomicDeliveryFixture({scope:'synthetic-only',operationId:'op',senderGeneration:1});broker.markAtomicDeliveryUncertainFixture({scope:'synthetic-only',operationId:'op',senderGeneration:1});
  broker.close();broker=new ReferenceTransferBroker({databasePath:dbfile,managedRoot:root,environment:'staging'});owner=construct();
  assert.throws(()=>broker.beginAtomicDeliveryFixture({scope:'synthetic-only',operationId:'op',senderGeneration:2}),{code:'TRANSFER_ACCOUNTING_UNAVAILABLE'});
  assert.throws(()=>broker.acknowledgeAtomicDeliveryFixture({...ackArgs,senderGeneration:2}),{code:'TRANSFER_ACCOUNTING_UNAVAILABLE'});
  assert.throws(()=>broker.acknowledgeAtomicDeliveryFixture({...ackArgs,ack:{...ack,grantSha256:'f'.repeat(64)}}),{code:'TRANSFER_ACCOUNTING_UNAVAILABLE'});
  assert.throws(()=>broker.acknowledgeAtomicDeliveryFixture({...ackArgs,ack:{...ack,extra:true}}),{code:'TRANSFER_ACCOUNTING_UNAVAILABLE'});
  assert.deepEqual(owner.issue('op',binding,input),first);assert.equal(broker.acknowledgeAtomicDeliveryFixture(ackArgs),true);assert.equal(broker.acknowledgeAtomicDeliveryFixture(ackArgs),true);
  assert.throws(()=>owner.issue('op',{...binding,attemptId:'changed'},input),{code:'RESERVATION_BINDING'});
  assert.throws(()=>broker.mintGrantAndSealFixture({scope:'synthetic-only',operationId:'op',binding,input,verifyReservation:()=>true,verifySourcePin:()=>true,keyProvider:()=>({keyId:'k',key:Buffer.alloc(32,8)})}),{code:'TRANSFER_ACCOUNTING_UNAVAILABLE'});
  assert.throws(()=>broker.mintGrantAndSealFixture({scope:'synthetic-only',operationId:'op',binding,input}),{code:'TRANSFER_ACCOUNTING_UNAVAILABLE'});
  assert.throws(()=>owner.issue('different-operation',binding,input),{code:'TRANSFER_ACCOUNTING_UNAVAILABLE'});assert.equal(broker.db.prepare('SELECT count(*) n FROM reference_grants').get().n,1);
  broker.db.prepare('UPDATE fixture_atomic_grants SET ciphertext=? WHERE operation_id=?').run(Buffer.from([1,2,3]),'op');assert.throws(()=>owner.issue('op',binding,input),{code:'TRANSFER_ACCOUNTING_UNAVAILABLE'});
 }finally{broker.close();}
});
