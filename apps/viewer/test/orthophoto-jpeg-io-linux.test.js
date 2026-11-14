'use strict';
// Owner-admitted Linux/UID568 fixture only. No Python, cjpeg, GDAL, image decode,
// cgroup probe or live model. The JPEG below is a synthetic marker fixture.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const syncFs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {createOrthophotoJpegIo}=require('../server/orthophotoJpegIo');
const {POLICY_REVISION}=require('../server/orthophotoJpegJobs');
// The opt-in selects these fixtures; it does not grant host/workload admission.
const admitted=process.env.VIEWER_JPEG_IO_FILESYSTEM_TESTS==='1'&&
  process.platform==='linux'&&process.getuid()===568;
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const marker=(code,payload)=>Buffer.concat([Buffer.from([255,code,0,payload.length+2]),payload]);
const jpeg=()=>Buffer.concat([Buffer.from([255,216]),
  marker(0xc0,Buffer.from([8,0,1,0,2,3,1,0x22,0,2,0x11,1,3,0x11,1])),
  marker(0xda,Buffer.from([3,1,0,2,0x11,3,0x11,0,63,0])),Buffer.from([0,255,217])]);

async function fixture(t){
  const temporary=await fs.realpath(os.tmpdir());
  const root=await fs.mkdtemp(path.join(temporary,'viewer-jpg-io-'));
  const originalRoot=await fs.lstat(root,{bigint:true});
  t.after(async()=>{
    const current=await fs.lstat(root,{bigint:true});
    assert.equal(await fs.realpath(root),root);
    assert.equal(path.dirname(root),temporary);assert.ok(path.basename(root).startsWith('viewer-jpg-io-'));
    assert.equal(current.ino,originalRoot.ino);assert.equal(current.dev,originalRoot.dev);
    await fs.rm(root,{recursive:true,force:false}); // Only this exclusive tiny fixture.
  });
  const cache=path.join(root,'cache');await fs.mkdir(cache,{mode:0o700});
  const source=path.join(root,'source.tif'),alias=path.join(root,'registered.tif');
  const sourceBytes=Buffer.from('synthetic TIFF source bytes; never decoded');
  await fs.writeFile(source,sourceBytes,{mode:0o600,flag:'wx'});await fs.symlink(source,alias);
  const scriptPath=path.resolve(__dirname,'../scripts/orthophoto-jpeg.py');
  const job={id:crypto.randomUUID(),lease_token:crypto.randomUUID(),source_asset_id:'asset-1',
    model_version_id:'version-1',width:2,height:1,converter_sha256:sha(await fs.readFile(scriptPath)),
    encoder_sha256:'b'.repeat(64),policy_revision:POLICY_REVISION};
  job.source_snapshot_json=JSON.stringify({assetId:'asset-1',versionId:'version-1',modelId:'model-1',
    kind:'ortho',sha256:sha(sourceBytes),byteSize:sourceBytes.length,rootKey:'models',
    relativePath:'registered.tif',storageMode:'adopted'});
  let executorCalls=0,reserveCalls=0;
  const storage={resolve:async(key,name)=>{
    if(key==='cache'&&name==='orthophoto-jpeg')return fs.realpath(cache);
    if(key==='models'&&name==='registered.tif')return fs.realpath(alias);
    throw new Error('unexpected fixture resolution');
  },requireSpace:(key,bytes)=>{assert.equal(key,'cache');assert.ok(bytes>=64*1024*1024);reserveCalls++;}};
  const io=createOrthophotoJpegIo({storage,jobs:{sourceMatches:()=>true},stagingParent:cache,scriptPath,
    processExecutor:{execute:async({planPath})=>{
      executorCalls++;
      const plan=JSON.parse(await fs.readFile(planPath,'utf8'));
      const stage=path.join(cache,plan.stagingName);await fs.mkdir(stage,{mode:0o700});
      const ppm=Buffer.concat([Buffer.from('P6\n2 1\n255\n'),Buffer.alloc(6,255)]);
      const data={'flattened.ppm':ppm,'image.jpg':jpeg(),'cjpeg.stderr':Buffer.alloc(0)},outputs={};
      for(const [name,bytes] of Object.entries(data)){
        await fs.writeFile(path.join(stage,name),bytes,{mode:0o600,flag:'wx'});
        outputs[name]={sha256:sha(bytes),byteSize:bytes.length};
      }
      const receipt={schemaVersion:1,status:'JPEG_CREATED_PENDING_INDEPENDENT_REVIEW',accepted:false,
        executionAdmissionEstablished:false,sourceUnchanged:true,operationId:plan.operationId,
        sourceAssetId:plan.sourceAssetId,sourceVersionId:plan.sourceVersionId,sourceSha256:plan.sourceSha256,
        sourceByteSize:plan.sourceByteSize,encoderSha256:plan.encoderSha256,width:2,height:1,bands:3,
        quality:90,progressive:false,optimize:false,writeMetadata:false,backgroundRgb:[255,255,255],outputs,
        encoderChild:{started:true,reaped:true,exitCode:0,pid:123,cancelledSignals:[],termRequested:false,
          killRequested:false,stderrBytesObserved:0,stderrBytesRetained:0}};
      await fs.writeFile(path.join(stage,'receipt.json'),JSON.stringify(receipt),{mode:0o600,flag:'wx'});
      return {childClosed:true,cleanupUnknown:false,syntheticLifecycle:true};
    }}});
  const context={job,signal:new AbortController().signal,assertCurrent:()=>{},deadlineUnixMs:Date.now()+60000};
  return {io,context,cache,root,source,alias,sourceBytes,
    executorCalls:()=>executorCalls,reserveCalls:()=>reserveCalls};
}

test('Linux IO pins real files, validates synthetic outputs, closes resources and persists private evidence',
  {skip:!admitted,timeout:10000},async t=>{
    const f=await fixture(t),prepared=await f.io.prepare(f.context),context={...f.context,prepared};
    try{
      const execution=await f.io.execute(context),validated=await f.io.validateOutput({...context,execution});
      assert.equal(validated.result.sourceSha256,sha(f.sourceBytes));assert.equal(validated.result.width,2);
      assert.equal(validated.evidence.pixelDecodeVerified,false);assert.equal(f.reserveCalls(),1);
      assert.equal(validated.result.policyRevision,POLICY_REVISION);
      assert.equal(await f.io.releasePrepared(context),true);
      assert.throws(()=>syncFs.fstatSync(prepared.scriptFd),{code:'EBADF'});
      const record=await f.io.recordEvidence({...f.context,kind:'jpeg-validation',jobId:f.context.job.id,
        evidence:validated.evidence});
      const names=(await fs.readdir(f.cache)).filter(name=>name.startsWith('evidence-'));
      assert.equal(names.length,1);const evidence=path.join(f.cache,names[0]);
      assert.equal(sha(await fs.readFile(evidence)),record.sha256);
      assert.equal((await fs.stat(evidence)).mode&0o777,0o600);
      assert.deepEqual(await fs.readFile(f.source),f.sourceBytes);
    }finally{await f.io.releasePrepared(context);}
  });

test('Linux source alias retargeting fails before executor entry and keeps the original bytes',
  {skip:!admitted,timeout:10000},async t=>{
    const f=await fixture(t),prepared=await f.io.prepare(f.context),context={...f.context,prepared};
    try{
      const other=path.join(f.root,'other.tif');await fs.writeFile(other,'different',{mode:0o600,flag:'wx'});
      await fs.unlink(f.alias);await fs.symlink(other,f.alias);
      await assert.rejects(f.io.execute(context),error=>error.code==='jpeg_io_storage_binding_changed'&&
        error.execution.childClosed===true&&error.execution.cleanupUnknown===false);
      assert.equal(f.executorCalls(),0);assert.deepEqual(await fs.readFile(f.source),f.sourceBytes);
    }finally{assert.equal(await f.io.releasePrepared(context),true);}
  });

test('Linux source mutation after execution prevents output validation',
  {skip:!admitted,timeout:10000},async t=>{
    const f=await fixture(t),prepared=await f.io.prepare(f.context),context={...f.context,prepared};
    try{
      const execution=await f.io.execute(context);await fs.writeFile(f.source,'changed fixture');
      await assert.rejects(f.io.validateOutput({...context,execution}),{code:'jpeg_io_file_changed'});
    }finally{assert.equal(await f.io.releasePrepared(context),true);}
  });
