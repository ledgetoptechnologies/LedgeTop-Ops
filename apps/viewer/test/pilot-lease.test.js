'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {runWithPilotLease}=require('./helpers/pilot-lease.cjs');
test('pilot lease loss aborts work and cannot be revived by its heartbeat',async()=>{
 let calls=0;const processing={database:{prepare:sql=>{assert.match(sql,/lease_expires_at>\?/);return{run:()=>({changes:++calls===1?1:0})};}}},job={id:'fixture',attempt_id:'attempt',job_type:'submit',attempt_count:1,lease_owner:'owner'};
 await assert.rejects(runWithPilotLease({processing,job,owner:'owner',verifyCompletion:()=>true,heartbeatMs:10,leaseSeconds:1,maxDurationMs:500,work:signal=>new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))}),/pilot lease lost/);assert.equal(calls,2);
});
test('pilot lease is checked before work and timers stop on completion',async()=>{
 let calls=0,started=false;const processing={database:{prepare:()=>({run:()=>({changes:++calls===1?0:1})})}},job={id:'fixture',attempt_id:'attempt',job_type:'submit',attempt_count:1,lease_owner:'owner'};
 await assert.rejects(runWithPilotLease({processing,job,owner:'owner',verifyCompletion:()=>true,heartbeatMs:10,leaseSeconds:1,maxDurationMs:500,work:()=>{started=true;}}),/pilot lease lost/);assert.equal(started,false);
 calls=0;processing.database.prepare=()=>({run:()=>({changes:(calls++,1)})});assert.equal(await runWithPilotLease({processing,job,owner:'owner',verifyCompletion:({result})=>result===42,heartbeatMs:10,leaseSeconds:1,maxDurationMs:500,work:async()=>42}),42);await new Promise(resolve=>setTimeout(resolve,35));assert.equal(calls,1);
 await assert.rejects(runWithPilotLease({processing,job,owner:'owner',verifyCompletion:()=>false,heartbeatMs:10,leaseSeconds:1,maxDurationMs:500,work:async()=>42}),/completion unverified/);
 await assert.rejects(runWithPilotLease({processing,job,owner:'owner',verifyCompletion:async()=>true,heartbeatMs:10,leaseSeconds:1,maxDurationMs:500,work:async()=>42}),/completion unverified/);
});
test('pilot lease refuses an expired SQLite claim without changing it',async t=>{
 const {DatabaseSync}=require('node:sqlite'),database=new DatabaseSync(':memory:');t.after(()=>database.close());
 database.exec('CREATE TABLE processing_jobs(id TEXT PRIMARY KEY,attempt_id TEXT,job_type TEXT,attempt_count INTEGER,status TEXT,lease_owner TEXT,lease_expires_at TEXT,heartbeat_at TEXT,updated_at TEXT)');database.prepare('INSERT INTO processing_jobs(id,attempt_id,job_type,attempt_count,status,lease_owner,lease_expires_at) VALUES(?,?,?,?,?,?,?)').run('job','attempt','submit',1,'leased','owner','2000-01-01T00:00:00.000Z');
 let started=false;const job={id:'job',attempt_id:'attempt',job_type:'submit',attempt_count:1,lease_owner:'owner'},run=change=>runWithPilotLease({processing:{database},job:{...job,...change},owner:'owner',verifyCompletion:()=>true,heartbeatMs:10,leaseSeconds:1,maxDurationMs:500,work:()=>{started=true;}});await assert.rejects(run({}),/pilot lease lost/);
 assert.equal(started,false);assert.equal(database.prepare('SELECT lease_expires_at FROM processing_jobs WHERE id=?').get('job').lease_expires_at,'2000-01-01T00:00:00.000Z');
 database.prepare('UPDATE processing_jobs SET lease_expires_at=? WHERE id=?').run('2999-01-01T00:00:00.000Z','job');await assert.rejects(run({attempt_id:'other'}),/pilot lease lost/);await assert.rejects(run({job_type:'ingest'}),/pilot lease lost/);await assert.rejects(run({attempt_count:2}),/pilot lease lost/);assert.equal(started,false);
});
test('pilot lease rejects work that blocks the event loop past its deadline',async()=>{
 const processing={database:{prepare:()=>({run:()=>({changes:1})})}},job={id:'job',attempt_id:'attempt',job_type:'submit',attempt_count:1,lease_owner:'owner'};
 await assert.rejects(runWithPilotLease({processing,job,owner:'owner',verifyCompletion:()=>true,heartbeatMs:10,leaseSeconds:1,maxDurationMs:30,work:()=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60);return 'done';}}),/pilot deadline exceeded/);
});
