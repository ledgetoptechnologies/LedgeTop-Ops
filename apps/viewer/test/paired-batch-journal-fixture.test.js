'use strict';
// Opt-in, container-local synthetic test; no app worker, network or authority.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path'),{spawnSync}=require('node:child_process'),{DatabaseSync}=require('node:sqlite');
const {createBatchIntentFixture,canonicalIntent}=require('../server/referenceBatchIntentFixture');
const {FIXTURE_SCOPE}=require('../server/referenceV2FixtureLedger');
const processing=process.env.PAIRED_PROCESSING_DIR;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const entry=(name,role,content)=>({wireNameUtf8Base64url:Buffer.from(name).toString('base64url'),role,sizeBytes:String(Buffer.byteLength(content)),sha256:crypto.createHash('sha256').update(content).digest('hex')});
test('Viewer fixture and atomic Processing journal recover an interrupted synthetic transaction',{skip:!processing||process.platform!=='linux',timeout:45000},()=>{
  assert.equal(processing,'/processing');
  const intent={attemptId:id(1),batchId:id(2),providerId:id(3),providerTaskId:id(4),initializationSha256:'22'.repeat(32),manifestSha256:'33'.repeat(32),reservationSha256:'44'.repeat(32),entries:[entry('first.jpg','photo','photo!'),entry('gcp_list.txt','gcp','points')]};
  const root=`/tmp/viewer-batch-${crypto.randomUUID()}`,helper=path.join(__dirname,'helpers','paired_batch_journal_fixture.py');
  // Reviewed helper has no child processes. Outer container also imposes a
  // hard deadline; its private /tmp is discarded with the owned container.
  const run=(mode,body)=>spawnSync('python3',['-B',helper,root,mode],{input:body,encoding:'utf8',cwd:processing,env:{...process.env,PYTHONPATH:processing,PYTHONDONTWRITEBYTECODE:'1'},timeout:10000,killSignal:'SIGKILL',maxBuffer:65536});
  const db=new DatabaseSync(':memory:');try{
    const viewer=createBatchIntentFixture(db,FIXTURE_SCOPE),saved=viewer.persist(intent),body=canonicalIntent(intent);
    const invalid=[
      {...intent,entries:[{...intent.entries[0],sizeBytes:'0'}]},
      {...intent,entries:[{...intent.entries[0],role:'gcp'}]},
      {...intent,entries:[{...intent.entries[0],sizeBytes:String(64*1024*1024+1)}]},
      {...intent,entries:Array.from({length:257},(_,i)=>entry(`photo${i}.jpg`,'photo','x'))},
    ];
    for(const candidate of invalid){const rejected=run('validate',canonicalIntent(candidate));assert.ifError(rejected.error);assert.equal(rejected.status,42,rejected.stderr);assert.deepEqual(JSON.parse(rejected.stdout),{error:'invalid_fixture_intent'});}
    const noncanonical=run('validate',Buffer.concat([body,Buffer.from(' ')]));assert.ifError(noncanonical.error);assert.equal(noncanonical.status,42);assert.deepEqual(JSON.parse(noncanonical.stdout),{error:'invalid_fixture_intent'});
    const crashed=run('crash',body);assert.ifError(crashed.error);assert.equal(crashed.status,76,crashed.stderr);
    const recovered=run('recover',body);assert.ifError(recovered.error);assert.equal(recovered.status,77,recovered.stderr);
    const changed=run('replay',canonicalIntent({...intent,entries:[...intent.entries].reverse()}));assert.ifError(changed.error);assert.equal(changed.status,42,changed.stderr);assert.deepEqual(JSON.parse(changed.stdout),{error:'fixture_binding_conflict'});
    const replay=run('replay',body);assert.ifError(replay.error);assert.equal(replay.status,0,replay.stderr);
    const result=JSON.parse(replay.stdout);assert.equal(result.digest,saved.digest);assert.equal(result.observationOnly,true);assert.equal(result.snapshots.length,2);
    // These completeness flags are synthetic caller assertions, not receipts.
    const observe=(n,files)=>viewer.observe({observationId:id(n),batchId:intent.batchId,intentSha256:saved.digest,complete:true,entries:files});
    assert.deepEqual(observe(5,result.snapshots[0]),{comparison:'subset',action:'hold',replayed:false});
    assert.deepEqual(observe(6,result.snapshots[1]),{comparison:'exact',action:'hold',replayed:false});
  }finally{db.close()}
});
