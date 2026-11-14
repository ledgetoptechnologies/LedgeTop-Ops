'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createOrthophotoJpegPlan,requiredJpegScratchBytes}=require('./orthophotoJpeg');
const {POLICY_REVISION}=require('./orthophotoJpegJobs');
const {parseBaselineJpegHeader,validateJpegReceipt}=require('./orthophotoJpegValidation');
const {validateDatabaseFilesystemType}=require('./orthophotoJpegWorkerProfile');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const need=(value,code)=>{if(!value)fail(code);};
const stamp=s=>['dev','ino','size','mtimeNs','ctimeNs','uid','gid','mode','nlink'].map(key=>String(s[key]));
const dirStamp=s=>['dev','ino','uid','gid','mode'].map(key=>String(s[key]));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const local=value=>typeof value==='string'&&value.length<=4096&&value!=='/'&&value.startsWith('/')&&
  !/[\x00-\x1f\x7f\\:]/.test(value)&&path.posix.normalize(value)===value&&!value.endsWith('/');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

// Resolver observations must remain tied to the registered storage identity,
// even when the previously resolved canonical file itself still exists.
async function resolveBoundPath(storage,rootKey,relativePath,expected,context){
  context.signal?.throwIfAborted();context.assertCurrent();
  const actual=await storage.resolve(rootKey,relativePath,{mustExist:true});
  context.signal?.throwIfAborted();context.assertCurrent();
  need(local(actual)&&actual===expected,'jpeg_io_storage_binding_changed');return actual;
}

// This bounds serialization before JSON.stringify, and excludes signals/functions
// and arbitrary top-level hook context. All evidence is private, not an API DTO.
function evidenceBytes(context){
  const value={};for(const key of ['kind','jobId','evidence','baseline','closure','execution'])
    if(Object.hasOwn(context,key))value[key]=context[key];
  need(typeof value.kind==='string'&&/^[a-z0-9-]{1,80}$/.test(value.kind)&&
    typeof value.jobId==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value.jobId),'jpeg_io_evidence_identity');
  let nodes=0,budget=0;
  function inspect(item,depth){
    need(++nodes<=8192&&depth<=32,'jpeg_io_evidence_bound');
    if(item===null||typeof item==='boolean')return;
    if(typeof item==='number'){need(Number.isFinite(item),'jpeg_io_evidence_type');return;}
    if(typeof item==='string'){budget+=Buffer.byteLength(item);need(budget<=128*1024,'jpeg_io_evidence_bound');return;}
    need(item&&typeof item==='object'&&(Array.isArray(item)||Object.getPrototypeOf(item)===Object.prototype),
      'jpeg_io_evidence_type');
    const keys=Object.keys(item);need(keys.length<=8192,'jpeg_io_evidence_bound');
    for(const key of keys){budget+=Buffer.byteLength(key);need(budget<=128*1024,'jpeg_io_evidence_bound');inspect(item[key],depth+1);}
  }
  inspect(value,0);const bytes=Buffer.from(JSON.stringify(value)+'\n');
  need(bytes.length<=128*1024,'jpeg_io_evidence_bound');return bytes;
}

function createOrthophotoJpegIo({storage,jobs,stagingParent,
  scriptPath=path.resolve(__dirname,'../scripts/orthophoto-jpeg.py'),processExecutor}={}){
  const preparedStates=new WeakMap();let retainedRootIdentity=null;
  function runtime(){
    need(process.platform==='linux'&&process.getuid()===568&&
      Number.isInteger(constants.O_NOFOLLOW)&&Number.isInteger(constants.O_NONBLOCK),'jpeg_io_runtime');
    need(typeof storage?.resolve==='function'&&typeof storage?.requireSpace==='function'&&typeof jobs?.sourceMatches==='function'&&
      typeof processExecutor?.execute==='function'&&local(stagingParent)&&local(scriptPath),'jpeg_io_configuration');
  }
  function check(context){context.signal?.throwIfAborted();need(typeof context.assertCurrent==='function','jpeg_io_context');context.assertCurrent();}
  async function call(context,fn){check(context);const value=await fn();check(context);return value;}
  const flags=()=>constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
  async function ownOpen(state,name,mode=flags(),permissions){
    const fd=await fs.open(name,mode,permissions);state.handles.add(fd);return fd;
  }
  async function closeAll(state){
    const outcomes=await Promise.all([...state.handles].map(async fd=>{
      try{await fd.close();state.handles.delete(fd);return true;}catch{return false;}
    }));
    return outcomes.every(Boolean);
  }
  async function directory(state,absolute,context){
    need(local(absolute),'jpeg_io_directory_path');
    need(await call(context,()=>fs.realpath(absolute))===absolute,'jpeg_io_directory_canonical');
    const fd=await ownOpen(state,absolute,flags()|constants.O_DIRECTORY);
    const actual=await call(context,()=>fd.stat({bigint:true}));
    need(actual.isDirectory()&&(actual.mode&0o7777n)===0o700n&&actual.uid===568n,'jpeg_io_private_directory');
    const pin={fd,path:absolute,identity:dirStamp(actual)};await directoryCurrent(pin,context);
    if(absolute===stagingParent){
      need(retainedRootIdentity===null||same(retainedRootIdentity,pin.identity),'jpeg_io_root_replaced');
      retainedRootIdentity=[...pin.identity];
    }
    return pin;
  }
  async function directoryCurrent(pin,context){
    if(pin.path===stagingParent)await resolveBoundPath(storage,'cache','orthophoto-jpeg',stagingParent,context);
    need(await call(context,()=>fs.realpath(pin.path))===pin.path,'jpeg_io_directory_canonical');
    const held=await call(context,()=>pin.fd.stat({bigint:true})),named=await call(context,()=>fs.lstat(pin.path,{bigint:true}));
    need(held.isDirectory()&&named.isDirectory()&&same(pin.identity,dirStamp(held))&&same(pin.identity,dirStamp(named)),
      'jpeg_io_directory_changed');
  }
  async function file(state,absolute,maximum,context,{privateFile=false}={}){
    need(await call(context,()=>fs.realpath(absolute))===absolute,'jpeg_io_file_canonical');
    const fd=await ownOpen(state,absolute),s=await call(context,()=>fd.stat({bigint:true}));
    need(s.isFile()&&s.nlink===1n&&s.size>=0n&&s.size<=BigInt(maximum),'jpeg_io_regular_file');
    if(privateFile)need(s.uid===568n&&(s.mode&0o7777n)===0o600n,'jpeg_io_private_file');
    const pin={fd,path:absolute,identity:stamp(s),size:Number(s.size)};await fileCurrent(pin,context);return pin;
  }
  async function fileCurrent(pin,context){
    need(await call(context,()=>fs.realpath(pin.path))===pin.path,'jpeg_io_file_canonical');
    const held=await call(context,()=>pin.fd.stat({bigint:true})),named=await call(context,()=>fs.lstat(pin.path,{bigint:true}));
    need(held.isFile()&&named.isFile()&&same(pin.identity,stamp(held))&&same(pin.identity,stamp(named)),
      'jpeg_io_file_changed');
  }
  async function range(pin,at,size,context){
    need(Number.isSafeInteger(at)&&Number.isSafeInteger(size)&&at>=0&&size>=0&&at<=pin.size-size&&size<=1024*1024,
      'jpeg_io_read_bound');
    const bytes=Buffer.alloc(size);let offset=0;
    while(offset<size){const r=await call(context,()=>pin.fd.read(bytes,offset,size-offset,at+offset));
      need(r.bytesRead>0,'jpeg_io_short_read');offset+=r.bytesRead;}
    return bytes;
  }
  async function listing(state,pin,context){
    check(context);const directory=await fs.opendir(`/proc/self/fd/${pin.fd.fd}`);
    state.handles.add(directory);check(context);const names=[];
    // Keep this owned directory handle until release, including on any error.
    for(;;){const entry=await call(context,()=>directory.read());if(!entry)break;
      need(names.length<4,'jpeg_io_stage_names');names.push(entry.name);}
    return names.sort();
  }
  async function hash(pin,context){
    await fileCurrent(pin,context);const digest=crypto.createHash('sha256'),bytes=Buffer.alloc(1024*1024);
    for(let at=0;at<pin.size;at+=bytes.length){
      const size=Math.min(bytes.length,pin.size-at);let offset=0;
      while(offset<size){
        const read=await call(context,()=>pin.fd.read(bytes,offset,size-offset,at+offset));
        need(read.bytesRead>0,'jpeg_io_short_read');offset+=read.bytesRead;
      }
      digest.update(bytes.subarray(0,size));
    }
    await fileCurrent(pin,context);return digest.digest('hex');
  }
  async function scriptParents(context){
    let current=scriptPath;
    for(;;){
      need(await call(context,()=>fs.realpath(current))===current,'jpeg_io_script_canonical');
      const s=await call(context,()=>fs.lstat(current,{bigint:true}));
      need(s.uid===0n&&(s.mode&0o022n)===0n&&(current===scriptPath?s.isFile():s.isDirectory()),'jpeg_io_script_owner');
      if(current==='/')break;current=path.posix.dirname(current);
    }
  }
  async function script(state,expected,context){
    await scriptParents(context);const pin=await file(state,scriptPath,1024*1024,context);
    need(await hash(pin,context)===expected,'jpeg_io_script_hash');return pin;
  }
  async function writeExclusive(state,parent,name,bytes,context){
    await directoryCurrent(parent,context);
    const fd=await ownOpen(state,`/proc/self/fd/${parent.fd.fd}/${name}`,
      constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
    let offset=0;while(offset<bytes.length){const r=await call(context,()=>fd.write(bytes,offset,bytes.length-offset,offset));
      need(r.bytesWritten>0,'jpeg_io_short_write');offset+=r.bytesWritten;}
    await call(context,()=>fd.sync());await call(context,()=>parent.fd.sync());await directoryCurrent(parent,context);
    const held=await call(context,()=>fd.stat({bigint:true}));
    const named=await call(context,()=>fs.lstat(`${parent.path}/${name}`,{bigint:true}));
    need(held.isFile()&&held.uid===568n&&held.nlink===1n&&(held.mode&0o7777n)===0o600n&&
      held.size===BigInt(bytes.length)&&same(stamp(held),stamp(named)),'jpeg_io_written_file_changed');
    return fd;
  }
  function stateFor(context){
    const state=preparedStates.get(context.prepared);
    need(state&&!state.released&&context.job?.id===state.job.id&&context.job.lease_token===state.job.lease_token,
      'jpeg_io_prepared_identity');return state;
  }
  async function fresh(state,context){
    check(context);need(jobs.sourceMatches(state.job),'jpeg_io_source_changed');
    await resolveBoundPath(storage,state.snapshot.rootKey,state.snapshot.relativePath,state.source.path,context);
    await directoryCurrent(state.parent,context);await fileCurrent(state.source,context);
    await scriptParents(context);
    await fileCurrent(state.script,context);await fileCurrent(state.request,context);
  }
  async function prepare(context){
    runtime();check(context);const state={handles:new Set(),job:{...context.job},released:false};let success=false,firstFailure;
    try{
      need(jobs.sourceMatches(state.job),'jpeg_io_source_changed');
      const snapshot=Object.freeze(JSON.parse(state.job.source_snapshot_json));state.snapshot=snapshot;
      const absolute=await call(context,()=>storage.resolve(snapshot.rootKey,snapshot.relativePath,{mustExist:true}));
      need(local(absolute),'jpeg_io_source_path');
      state.source=await file(state,absolute,snapshot.byteSize,context);
      need(state.source.size===snapshot.byteSize&&await hash(state.source,context)===snapshot.sha256,'jpeg_io_source_hash');
      await resolveBoundPath(storage,snapshot.rootKey,snapshot.relativePath,state.source.path,context);
      state.script=await script(state,state.job.converter_sha256,context);
      state.parent=await directory(state,stagingParent,context);
      const required=requiredJpegScratchBytes(state.job.width,state.job.height);
      await call(context,()=>storage.requireSpace('cache',required));
      const space=await call(context,()=>fs.statfs(`/proc/self/fd/${state.parent.fd.fd}`,{bigint:true}));
      validateDatabaseFilesystemType(space.type);
      need(space.bavail*space.bsize>=BigInt(required),'jpeg_io_scratch_space');
      const plan=createOrthophotoJpegPlan({asset:{id:snapshot.assetId,kind:'ortho',absolutePath:absolute,
        byteSize:snapshot.byteSize,sha256:snapshot.sha256},sourceVersionId:snapshot.versionId,
      operationId:state.job.lease_token,encoderSha256:state.job.encoder_sha256,stagingParent,
      width:state.job.width,height:state.job.height});
      const planPath=`${stagingParent}/request-${plan.operationId}.json`,bytes=Buffer.from(JSON.stringify(plan)+'\n');
      await writeExclusive(state,state.parent,path.posix.basename(planPath),bytes,context);
      state.request=await file(state,planPath,128*1024,context,{privateFile:true});
      state.plan=plan;await fresh(state,context);
      Object.freeze(plan.backgroundRgb);Object.freeze(plan.jpeg);Object.freeze(plan.limits);Object.freeze(plan);
      const prepared=Object.freeze({plan,planPath,scriptFd:state.script.fd.fd});
      preparedStates.set(prepared,state);success=true;return prepared;
    }catch(error){firstFailure=error;throw error;
    }finally{
      if(!success&&!await closeAll(state))throw Object.assign(new Error('jpeg_io_prepare_close_unknown'),
        {code:'jpeg_io_prepare_close_unknown',cleanupUnknown:true,resourceCleanupUnknown:true,
          firstFailure:{code:firstFailure?.code||'jpeg_io_prepare_failed',message:String(firstFailure?.message||'').slice(0,256)}});
    }
  }
  async function execute(context){
    let state;
    try{runtime();state=stateFor(context);await fresh(state,context);
      need(!state.executionEntered,'jpeg_io_execution_already_entered');}
    catch(error){error.execution={childClosed:!state?.executionEntered,cleanupUnknown:Boolean(state?.executionEntered)};throw error;}
    state.executionEntered=true;
    return processExecutor.execute({planPath:context.prepared.planPath,scriptFd:state.script.fd.fd,
      signal:context.signal,deadlineUnixMs:context.deadlineUnixMs});
  }
  async function validateOutput(context){
    runtime();const state=stateFor(context);await fresh(state,context);
    need(state.executionEntered&&context.execution?.childClosed===true&&context.execution.cleanupUnknown===false,
      'jpeg_io_execution_not_closed');
    const stagePath=`${stagingParent}/${state.plan.stagingName}`,stage=await directory(state,stagePath,context);
    const names=await listing(state,stage,context);
    need(same(names,['cjpeg.stderr','flattened.ppm','image.jpg','receipt.json']),'jpeg_io_stage_names');
    const pixels=state.plan.width*state.plan.height*3;
    const ppmHeader=Buffer.from(`P6\n${state.plan.width} ${state.plan.height}\n255\n`),outputs={},pins={};
    for(const [name,max] of [['receipt.json',128*1024],['flattened.ppm',ppmHeader.length+pixels],
      ['image.jpg',pixels+32*1024*1024],['cjpeg.stderr',1024*1024]]){
      const pin=await file(state,`${stagePath}/${name}`,max,context,{privateFile:true});pins[name]=pin;
      outputs[name]={sha256:await hash(pin,context),byteSize:pin.size};
    }
    const raw=await range(pins['receipt.json'],0,pins['receipt.json'].size,context);
    const receipt=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));
    const receiptSha256=outputs['receipt.json'].sha256;delete outputs['receipt.json'];
    outputs['flattened.ppm'].header=await range(pins['flattened.ppm'],0,ppmHeader.length,context);
    const header=await parseBaselineJpegHeader((at,size)=>range(pins['image.jpg'],at,size,context),pins['image.jpg'].size,state.plan);
    const validated=validateJpegReceipt({plan:state.plan,receipt,outputs});
    need(await hash(state.source,context)===state.plan.sourceSha256,'jpeg_io_source_post_hash');
    await resolveBoundPath(storage,state.snapshot.rootKey,state.snapshot.relativePath,state.source.path,context);
    need(await hash(state.script,context)===state.job.converter_sha256,'jpeg_io_script_post_hash');
    for(const pin of Object.values(pins))await fileCurrent(pin,context);
    need(same(await listing(state,stage,context),names),'jpeg_io_stage_changed');
    await directoryCurrent(stage,context);await fresh(state,context);
    need(state.job.policy_revision===POLICY_REVISION,'jpeg_io_policy');
    return {result:{...validated.binding,converterSha256:state.job.converter_sha256,policyRevision:POLICY_REVISION},
      evidence:{...validated.evidence,receiptSha256,header,sourceIdentity:state.source.identity,
        scriptIdentity:state.script.identity,outputs:Object.fromEntries(Object.entries(outputs).map(([name,row])=>
          [name,{sha256:row.sha256,byteSize:row.byteSize,identity:pins[name].identity}]))}};
  }
  async function releasePrepared(context){
    const state=preparedStates.get(context.prepared);
    need(state&&context.job?.id===state.job.id&&context.job.lease_token===state.job.lease_token,'jpeg_io_prepared_identity');
    let guardError;try{check(context);}catch(error){guardError=error;}
    const closed=await closeAll(state);if(closed)state.released=true;
    if(guardError)throw guardError;check(context);return closed;
  }
  async function recordEvidence(context){
    runtime();check(context);const state={handles:new Set()};
    try{
      const bytes=evidenceBytes(context),parent=await directory(state,stagingParent,context);
      await writeExclusive(state,parent,`evidence-${crypto.randomUUID()}.json`,bytes,context);
      return {sha256:sha(bytes)};
    }finally{need(await closeAll(state),'jpeg_io_evidence_close_unknown');}
  }
  return {prepare,execute,validateOutput,releasePrepared,recordEvidence};
}
module.exports={createOrthophotoJpegIo,evidenceBytes,stamp,dirStamp,resolveBoundPath};
