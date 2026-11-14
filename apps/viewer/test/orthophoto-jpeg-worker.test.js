'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {OrthophotoJpegJobs}=require('../server/orthophotoJpegJobs');
const {createOrthophotoJpegWorker}=require('../server/orthophotoJpegWorker');

// No process/kernel observations or image IO: real in-memory queue transactions
// are composed with explicitly synthetic runtime and native-lifecycle hooks.
function fixture(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const at='2026-11-14T00:00:00.000Z';
  db.prepare(`INSERT INTO models(id,provider,provider_model_id,display_name,status,active_version_id,created_at,updated_at)
    VALUES ('model-1','webodm','synthetic','Synthetic','ready','version-1',?,?)`).run(at,at);
  db.prepare(`INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at)
    VALUES ('version-1','model-1','synthetic-v1','{}','ready',?,?)`).run(at,at);
  db.prepare(`INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,format,byte_size,sha256,storage_mode,created_at)
    VALUES ('asset-1','version-1','ortho','models','version-1/orthophoto.tif','geotiff',100,?,'adopted',?)`)
    .run('a'.repeat(64),at);
  let clock=1000;
  const jobs=new OrthophotoJpegJobs(db,{clock:()=>clock});
  const request={versionId:'version-1',sourceAssetId:'asset-1',converterSha256:'b'.repeat(64),
    encoderSha256:'c'.repeat(64),width:20,height:10};
  const row=jobs.request(request).job,calls=[],handles=new Map();let nextHandle=0;
  const timers={setTimeout:fn=>{const id=++nextHandle;handles.set(id,{fn,kind:'timeout'});return id;},
    setInterval:fn=>{const id=++nextHandle;handles.set(id,{fn,kind:'interval'});return id;},
    clearTimeout:id=>handles.delete(id),clearInterval:id=>handles.delete(id),
    fire:kind=>{for(const h of [...handles.values()])if(h.kind===kind)h.fn();}};
  const baseline={schemaVersion:1,kind:'dedicated-jpeg-kernel-profile',kernelProfileObserved:true,
    syntheticTestFixture:true,members:[{pid:8,startTicks:'9000'}]};
  const opts={enabled:true,dedicated:true,jobs,owner:'test-worker',clock:()=>clock,timers,
    assertRuntimeQualified:async()=>true,inspectProfile:async()=>baseline,
    observeProcessClosure:async()=>({closureObserved:true,observed:{...baseline}}),
    prepare:async()=>{calls.push('prepare');return {};},
    execute:async()=>{calls.push('execute');return {childClosed:true,cleanupUnknown:false};},
    validateOutput:async({job})=>{calls.push('validate');return {evidence:{synthetic:true},result:{
      sha256:'d'.repeat(64),byteSize:100,width:20,height:10,sourceAssetId:'asset-1',sourceVersionId:'version-1',
      sourceSha256:'a'.repeat(64),sourceByteSize:100,converterSha256:job.converter_sha256,
      encoderSha256:job.encoder_sha256,policyRevision:job.policy_revision}};},
    recordEvidence:async e=>{calls.push(e.kind);return {sha256:'e'.repeat(64)};}};
  t.after(()=>assert.equal(handles.size,0,'all task timers must be retired'));
  return {db,jobs,row,request,calls,timers,opts,time:value=>{clock=value;}};
}

test('disabled worker performs no runtime inspection or queue access',async()=>{
  const worker=createOrthophotoJpegWorker();assert.deepEqual(await worker.runOne(),{status:'disabled'});
});

test('unqualified runtime or unobserved profile cannot claim work',async t=>{
  const f=fixture(t);
  await assert.rejects(createOrthophotoJpegWorker({...f.opts,assertRuntimeQualified:async()=>false}).runOne(),
    {code:'jpeg_worker_runtime_unqualified'});
  await assert.rejects(createOrthophotoJpegWorker({...f.opts,inspectProfile:async()=>({kernelProfileObserved:false})}).runOne(),
    {code:'jpeg_worker_profile_unobserved'});
  assert.equal(f.jobs.get(f.row.id).status,'queued');assert.deepEqual(f.calls,[]);
});

test('success requires validation, matching closure and durable evidence before SQL completion',async t=>{
  const f=fixture(t),result=await createOrthophotoJpegWorker(f.opts).runOne();
  assert.equal(result.status,'succeeded');assert.equal(f.jobs.get(f.row.id).status,'succeeded');
  assert.deepEqual(f.calls,['prepare','execute','validate','jpeg-validation','jpeg-closure']);
  const stored=JSON.parse(f.jobs.get(f.row.id).result_json);
  assert.equal(stored.closureEvidenceSha256,'e'.repeat(64));
  assert.equal(stored.sourceSha256,'a'.repeat(64));
});

test('unknown child cleanup immediately fences the slot and halts subsequent claims',async t=>{
  const f=fixture(t);f.jobs.request({...f.request,encoderSha256:'f'.repeat(64)});
  const worker=createOrthophotoJpegWorker({...f.opts,execute:async()=>{
    throw Object.assign(new Error('synthetic uncertain cleanup'),{execution:{childClosed:false,cleanupUnknown:true}});
  }});
  const stopped=await worker.runOne();assert.equal(stopped.status,'halted');
  assert.equal(f.jobs.get(stopped.jobId).status,'cleanup_required');
  assert.equal(f.jobs.get(stopped.jobId).lease_owner,'test-worker');
  assert.equal((await worker.runOne()).status,'halted');
  assert.equal(f.jobs.claim({owner:'other-worker',deadlineUnixMs:5000}),null);
});

test('heartbeat failure before execution closes only the original lease after observed closure',async t=>{
  const f=fixture(t);f.jobs.heartbeat=()=>false;
  const worker=createOrthophotoJpegWorker({...f.opts,prepare:async()=>{f.timers.fire('interval');return {};}});
  const result=await worker.runOne();assert.equal(result.status,'failed');
  assert.equal(result.errorCode,'jpeg_worker_lease_lost');
  assert.equal(f.jobs.get(f.row.id).status,'failed');assert.ok(!f.calls.includes('execute'));
});

test('cancellation after a reaped execution fails safely without registering output',async t=>{
  const f=fixture(t),abort=new AbortController();
  const worker=createOrthophotoJpegWorker({...f.opts,execute:async()=>{
    abort.abort(Object.assign(new Error('cancelled'),{code:'jpeg_cancelled'}));
    return {childClosed:true,cleanupUnknown:false};
  }});
  const result=await worker.runOne({signal:abort.signal});assert.equal(result.status,'failed');
  assert.equal(result.errorCode,'jpeg_cancelled');assert.equal(f.jobs.get(f.row.id).result_json,null);
});

test('source withdrawal during output validation prevents stale completion',async t=>{
  const f=fixture(t),validate=f.opts.validateOutput;
  const worker=createOrthophotoJpegWorker({...f.opts,validateOutput:async context=>{
    const output=await validate(context);
    f.db.prepare("UPDATE models SET unregistered_at=? WHERE id='model-1'").run('2026-11-14T01:00:00Z');
    return output;
  }});
  assert.equal((await worker.runOne()).status,'failed');
  assert.equal(f.jobs.get(f.row.id).status,'failed');assert.equal(f.jobs.get(f.row.id).result_json,null);
});

test('changed closure or failed durable evidence retains the original cleanup fence',async t=>{
  for(const change of ['closure','evidence']){
    const f=fixture(t),opts={...f.opts};
    if(change==='closure')opts.observeProcessClosure=async()=>({closureObserved:false});
    else opts.recordEvidence=async()=>{throw new Error('synthetic disk failure');};
    const worker=createOrthophotoJpegWorker(opts);
    assert.equal((await worker.runOne()).status,'halted');
    assert.equal(f.jobs.get(f.row.id).status,'cleanup_required');
    assert.equal((await worker.runOne()).status,'halted');
  }
});

test('even a transient first closure or evidence failure halts without retrying the hook',async t=>{
  for(const phase of ['closure','evidence']){
    const f=fixture(t),opts={...f.opts};let attempts=0;
    if(phase==='closure')opts.observeProcessClosure=async()=>{
      if(++attempts===1)return {closureObserved:false};
      return f.opts.observeProcessClosure();
    };
    else opts.recordEvidence=async value=>{
      if(++attempts===1)throw new Error('transient write failure');
      return f.opts.recordEvidence(value);
    };
    assert.equal((await createOrthophotoJpegWorker(opts).runOne()).status,'halted');
    assert.equal(attempts,1);assert.equal(f.jobs.get(f.row.id).status,'cleanup_required');
  }
});

test('cancelled work receives separate finite cleanup context and hanging cleanup stays fenced',async t=>{
  const f=fixture(t),abort=new AbortController();let cleanupEntered;
  const entered=new Promise(resolve=>{cleanupEntered=resolve;});
  const worker=createOrthophotoJpegWorker({...f.opts,execute:async()=>{
    abort.abort();return {childClosed:true,cleanupUnknown:false};
  },observeProcessClosure:async(_baseline,context)=>{
    assert.equal(context.signal.aborted,false);assert.ok(context.deadlineUnixMs<=11000);
    assert.doesNotThrow(context.assertCurrent);cleanupEntered();return new Promise(()=>{});
  }});
  const run=worker.runOne({signal:abort.signal});await entered;f.timers.fire('timeout');
  assert.equal((await run).status,'halted');assert.equal(f.jobs.get(f.row.id).status,'cleanup_required');
});

test('prepare that ignores cancellation cannot release its fence or start native execution',async t=>{
  const f=fixture(t),abort=new AbortController();let prepareEntered,context;
  const entered=new Promise(resolve=>{prepareEntered=resolve;});
  const worker=createOrthophotoJpegWorker({...f.opts,prepare:async value=>{
    context=value;prepareEntered();return new Promise(()=>{});
  }});
  const run=worker.runOne({signal:abort.signal});await entered;
  abort.abort();assert.equal(context.signal.aborted,true);
  assert.throws(context.assertCurrent);f.timers.fire('timeout');
  assert.equal((await run).status,'halted');
  assert.equal(f.jobs.get(f.row.id).status,'cleanup_required');assert.ok(!f.calls.includes('execute'));
});

test('late cleanup settlement cannot beat an overdue timer into releasing the fence',async t=>{
  for(const exerciseGuard of [false,true]){
    const f=fixture(t),abort=new AbortController();
    const worker=createOrthophotoJpegWorker({...f.opts,execute:async()=>{
      abort.abort();return {childClosed:true,cleanupUnknown:false};
    },observeProcessClosure:async(baseline,context)=>{
      f.time(context.deadlineUnixMs+1); // Deliberately do not deliver any timer.
      if(exerciseGuard)assert.throws(context.assertCurrent,{code:'jpeg_worker_hook_deadline'});
      return {closureObserved:true,observed:baseline};
    }});
    assert.equal((await worker.runOne({signal:abort.signal})).status,'halted');
    assert.equal(f.jobs.get(f.row.id).status,'cleanup_required');
  }
});

test('late preclaim qualification is rejected even before its timer callback runs',async t=>{
  const f=fixture(t),worker=createOrthophotoJpegWorker({...f.opts,assertRuntimeQualified:async context=>{
    f.time(context.deadlineUnixMs+1);return true;
  }});
  await assert.rejects(worker.runOne(),{code:'jpeg_worker_hook_deadline'});
  assert.equal(f.jobs.get(f.row.id).status,'queued');assert.equal((await worker.runOne()).status,'halted');
});

test('one worker instance cannot overlap jobs while prepare is pending',async t=>{
  const f=fixture(t);let release,entered;
  const waiting=new Promise(resolve=>{entered=resolve;});
  const worker=createOrthophotoJpegWorker({...f.opts,prepare:async()=>{
    entered();return new Promise(resolve=>{release=resolve;});
  }});
  const first=worker.runOne();await waiting;
  assert.equal((await worker.runOne()).status,'busy');release({});
  assert.equal((await first).status,'succeeded');
});
