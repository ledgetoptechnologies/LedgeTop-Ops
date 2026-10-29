'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const service=require('../server/capacityLedgerService');
const {quiesce}=service;
const {createCapacityObserver}=require('../server/capacityObservation');
const reserve=(db,input)=>service.reserve(db,input,createCapacityObserver({attestor:{observe:()=>({domainId:input.domainId,domainRevision:input.domainRevision,samples:input.samples,sampledAt:performance.now()})}}));
const sample={domainId:'domain',domainRevision:'v1',availableBytes:1000,reserveBytes:100,availableInodes:100,reserveInodes:10};
const request=(id,bytes=500)=>({id,domainId:'domain',domainRevision:'v1',writerKind:'upload',writerId:id,writerNamespace:'bounded',ownerId:'worker',fenceToken:'token-'+id,generation:1,peakBytes:bytes,peakInodes:10,samples:[sample]});
function database(t){const db=new DatabaseSync(':memory:');applyMigrations(db);t.after(()=>db.close());return db;}
function enableForTest(db){db.exec("UPDATE viewer_capacity_control SET mode='cooperative',legacy_state='verified'");}
test('disabled and unassessed control fail closed and change no rows',t=>{const db=database(t);assert.throws(()=>reserve(db,request('one')),{code:'capacity_unavailable'});db.exec("UPDATE viewer_capacity_control SET mode='cooperative'");assert.throws(()=>reserve(db,request('one')),{code:'capacity_unavailable'});assert.equal(db.prepare('SELECT count(*) n FROM viewer_capacity_reservations').get().n,0);});
test('idempotence, identity conflict, domain revision and capacity accounting are transactional',t=>{const db=database(t);enableForTest(db);assert.equal(reserve(db,request('one')).idempotent,false);assert.equal(reserve(db,request('one')).idempotent,true);assert.throws(()=>reserve(db,{...request('one'),samples:[]}),{code:'capacity_observation_unavailable'});assert.throws(()=>reserve(db,{...request('one'),peakBytes:400}),{code:'capacity_identity_conflict'});assert.throws(()=>reserve(db,request('two')),{code:'capacity_insufficient'});assert.throws(()=>reserve(db,{...request('two'),domainRevision:'v2',samples:[{...sample,domainRevision:'v2'}]}),{code:'capacity_budget_invalid'});assert.equal(db.prepare('SELECT count(*) n FROM viewer_capacity_reservations').get().n,1);});
test('no timeout, stale owner, quiescing or deletion can release an interrupted reservation',t=>{const db=database(t);enableForTest(db);reserve(db,request('one'));assert.throws(()=>quiesce(db,{id:'one',ownerId:'worker',fenceToken:'stale',generation:1}),{code:'capacity_owner_mismatch'});assert.equal(quiesce(db,{id:'one',ownerId:'worker',fenceToken:'token-one',generation:1}).state,'quiescing');assert.throws(()=>reserve(db,request('one')),{code:'capacity_state_invalid'});assert.equal(quiesce(db,{id:'one',ownerId:'worker',fenceToken:'token-one',generation:1}).idempotent,true);assert.throws(()=>db.exec("DELETE FROM viewer_capacity_reservations WHERE id='one'"),/deletion is forbidden/);assert.throws(()=>reserve(db,request('two')),{code:'capacity_insufficient'});assert.equal(db.prepare("SELECT remaining_bytes FROM viewer_capacity_reservations WHERE id='one'").get().remaining_bytes,500);});
test('independent processes serialize competing reservations',async t=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capacity-race-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'ledger.sqlite'),db=new DatabaseSync(file);applyMigrations(db);enableForTest(db);db.close();
  const service=path.resolve(__dirname,'../server/capacityLedgerService.js'),observation=path.resolve(__dirname,'../server/capacityObservation.js');
  const code=`const {DatabaseSync}=require('node:sqlite');const {reserve}=require(process.argv[1]);const {createCapacityObserver}=require(process.argv[4]);const db=new DatabaseSync(process.argv[2]);const req=JSON.parse(process.argv[3]);const obs=createCapacityObserver({attestor:{observe:()=>({domainId:req.domainId,domainRevision:req.domainRevision,samples:req.samples,sampledAt:performance.now()})}});db.exec('PRAGMA busy_timeout=5000');try{reserve(db,req,obs);process.stdout.write('held')}catch(e){process.stdout.write(e.code||'unknown')}finally{db.close()}`;
  const run=id=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',code,service,file,JSON.stringify(request(id)),observation]);let out='';child.stdout.on('data',d=>out+=d);child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(new Error('child failed')));});
  assert.deepEqual((await Promise.all([run('first'),run('second')])).sort(),['capacity_insufficient','held']);const check=new DatabaseSync(file);try{assert.equal(check.prepare('SELECT count(*) n FROM viewer_capacity_reservations').get().n,1);}finally{check.close();}
});

test('large retained ledgers fail closed at the accounting ceiling',t=>{
 const db=database(t);enableForTest(db);
 const add=db.prepare(`INSERT INTO viewer_capacity_reservations(id,domain_id,domain_revision,writer_kind,writer_id,writer_namespace,owner_id,fence_token,owner_generation,peak_bytes,materialized_bytes,remaining_bytes,peak_inodes,materialized_inodes,remaining_inodes,state,created_at,updated_at) VALUES(?,'domain','v1','upload',?,'scope','owner','token',1,0,0,0,0,0,0,?,'t','t')`);
 db.exec('BEGIN');for(let i=0;i<10000;i++)add.run('r'+i,'w'+i,i===0?'held':'retained');db.exec('COMMIT');
 assert.throws(()=>reserve(db,request('new',0)),{code:'capacity_ledger_too_large'});assert.equal(db.prepare('SELECT count(*) n FROM viewer_capacity_reservations').get().n,10000);
 assert.equal(reserve(db,{...request('r0',0),writerId:'w0',writerNamespace:'scope',ownerId:'owner',fenceToken:'token',peakInodes:0}).idempotent,true);
 add.run('overflow','overflow-writer','retained');assert.throws(()=>reserve(db,request('new',0)),{code:'capacity_ledger_too_large'});
});
test('held retries after capacity falls cannot succeed as a new permission',t=>{
 const db=database(t);enableForTest(db);reserve(db,request('one'));
 assert.throws(()=>reserve(db,{...request('one'),samples:[{...sample,availableBytes:599}]}),{code:'capacity_insufficient'});
});


test('unissued observer and same ID across domains are rejected',t=>{
 const db=database(t);enableForTest(db);
 assert.throws(()=>service.reserve(db,request('one'),{observe:()=>({}),validate:()=>[sample]}),{code:'capacity_observation_unavailable'});
 reserve(db,request('one'));const other={...request('one'),domainId:'different',samples:[{...sample,domainId:'different'}]};
 assert.throws(()=>reserve(db,other),{code:'capacity_identity_conflict'});assert.equal(db.prepare('SELECT count(*) n FROM viewer_capacity_reservations').get().n,1);
});

test('competing processes cannot reuse one reservation ID across domains',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'capacity-id-race-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'ledger.sqlite'),db=new DatabaseSync(file);applyMigrations(db);enableForTest(db);db.close();
 const svc=path.resolve(__dirname,'../server/capacityLedgerService.js'),obsPath=path.resolve(__dirname,'../server/capacityObservation.js');
 const code=`const {DatabaseSync}=require('node:sqlite');const {reserve}=require(process.argv[1]);const {createCapacityObserver}=require(process.argv[4]);const db=new DatabaseSync(process.argv[2]);const req=JSON.parse(process.argv[3]);const observer=createCapacityObserver({attestor:{observe:()=>({domainId:req.domainId,domainRevision:req.domainRevision,samples:req.samples,sampledAt:performance.now()})}});db.exec('PRAGMA busy_timeout=5000');try{reserve(db,req,observer);process.stdout.write('held')}catch(e){process.stdout.write(e.code||'unknown')}finally{db.close()}`;
 const run=req=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',code,svc,file,JSON.stringify(req),obsPath]);let out='';child.stdout.on('data',d=>out+=d);child.on('error',reject);child.on('close',code=>code===0?resolve(out):reject(new Error('child failed')));});
 const first=request('shared'),second={...request('shared'),domainId:'different',samples:[{...sample,domainId:'different'}]};
 assert.deepEqual((await Promise.all([run(first),run(second)])).sort(),['capacity_identity_conflict','held']);const check=new DatabaseSync(file);try{assert.equal(check.prepare('SELECT count(*) n FROM viewer_capacity_reservations').get().n,1);}finally{check.close();}
});
