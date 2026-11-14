'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const error=code=>Object.assign(new Error(code),{code});

async function fixedProcIdentity(pid){
  if(!Number.isSafeInteger(pid)||pid<=1)throw error('jpeg_child_pid');
  const fd=await fs.open(`/proc/${pid}/stat`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const buffer=Buffer.alloc(8193),{bytesRead}=await fd.read(buffer,0,buffer.length,0);
    if(bytesRead>8192)throw error('jpeg_child_stat_bound');
    const raw=buffer.subarray(0,bytesRead).toString('utf8'),end=raw.lastIndexOf(') ');
    const fields=raw.slice(end+2).trim().split(/\s+/);
    if(end<0||Number(raw.slice(0,raw.indexOf(' (')))!==pid||!/^\d+$/.test(fields[19]||''))throw error('jpeg_child_identity');
    return {pid,startTicks:fields[19],pgid:Number(fields[2]),sid:Number(fields[3])};
  }finally{await fd.close();}
}
function validIdentity(row,pid){
  return Number.isSafeInteger(pid)&&pid>1&&row&&row.pid===pid&&typeof row.startTicks==='string'&&/^[0-9]{1,24}$/.test(row.startTicks)&&
    row.pgid===pid&&row.sid===pid;
}
function same(a,b){return a&&b&&a.pid===b.pid&&a.startTicks===b.startTicks&&a.pgid===b.pgid&&a.sid===b.sid;}

// Private lifecycle evidence only. A reaped leader is not proof of descendant or
// host closure: the caller must independently compare its dedicated cgroup/proc baseline.
function createJpegProcessExecutor(options={}){
  const keys=['spawnProcess','readIdentity','signalGroup','setTimer','clearTimer'];
  if(!options||![Object.prototype,null].includes(Object.getPrototypeOf(options)))
    throw error('jpeg_process_test_adapter_incomplete');
  // Never let an injected/fake PID fall through to the host signal adapter.
  if(keys.some(key=>Object.hasOwn(options,key))&&
    !keys.every(key=>typeof Object.getOwnPropertyDescriptor(options,key)?.value==='function'))
    throw error('jpeg_process_test_adapter_incomplete');
  const defaults={spawnProcess:spawn,readIdentity:fixedProcIdentity,
    signalGroup:process.kill,setTimer:setTimeout,clearTimer:clearTimeout};
  const {spawnProcess,readIdentity,signalGroup,setTimer,clearTimer}=Object.fromEntries(
    keys.map(key=>[key,Object.hasOwn(options,key)?Object.getOwnPropertyDescriptor(options,key).value:defaults[key]]));
  async function execute({planPath,scriptFd,signal,deadlineUnixMs,clock=Date.now}={}){
    const execution={childClosed:true,cleanupUnknown:false,pid:null,identity:null,exitCode:null,
      signal:null,stderrBytes:0,termSent:false,killSent:false,firstFailure:null};
    try{
    const now=clock();
    if(typeof planPath!=='string'||planPath.length>4096||/[\x00-\x1f\x7f\\:]/.test(planPath)||
      !path.posix.isAbsolute(planPath)||path.posix.normalize(planPath)!==planPath||planPath==='/')throw error('jpeg_plan_path');
    if(!Number.isSafeInteger(scriptFd)||scriptFd<3||!Number.isSafeInteger(now)||
      !Number.isSafeInteger(deadlineUnixMs)||deadlineUnixMs-now<=10000||deadlineUnixMs-now>900000)throw error('jpeg_process_deadline');
    if(signal?.aborted)throw error('jpeg_process_cancelled');
    }catch(failure){
      execution.firstFailure={code:failure.code||'jpeg_process_preflight',message:String(failure.message||failure).slice(0,256)};
      failure.execution={...execution};throw failure;
    }
    let child,exited=false,settled=false,stopping=false,bound=false;
    let activeTimer,killTimer,finalTimer;
    let resolveResult,rejectResult;
    const result=new Promise((resolve,reject)=>{resolveResult=resolve;rejectResult=reject;});
    const record=failure=>{if(!execution.firstFailure)execution.firstFailure={code:failure.code||'jpeg_child_error',message:String(failure.message||failure).slice(0,256)};};
    function finish(closed){
      if(settled)return;settled=true;
      execution.childClosed=closed;execution.cleanupUnknown=!closed;
      for(const timer of [activeTimer,killTimer,finalTimer])if(timer!==undefined)clearTimer(timer);
      signal?.removeEventListener('abort',cancel);
      child?.stderr?.removeListener('data',data);child?.stderr?.removeListener('error',streamError);
      child?.removeListener('exit',exit);child?.removeListener('close',close);
      child?.removeListener('error',childError);
      // Late stream/process errors must not become unhandled after an unknown cleanup.
      child?.on('error',()=>{});child?.stderr?.on('error',()=>{});
      if(!closed)child?.stderr?.destroy();
      if(!closed)record(error('jpeg_child_cleanup_unknown'));
      if(execution.firstFailure){const failure=error(execution.firstFailure.code);failure.execution={...execution};rejectResult(failure);}
      else resolveResult({...execution});
    }
    async function groupSignal(name){
      if(settled||exited||!bound)return;
      try{
        const current=await readIdentity(child.pid);
        if(settled||exited)return;
        if(!same(execution.identity,current))throw error('jpeg_child_identity_changed');
        // This synchronous signal follows the fresh identity read; kernel PID reuse
        // cannot be made atomic with killpg here. Deployment isolation remains required.
        signalGroup(-child.pid,name);
        execution[name==='SIGTERM'?'termSent':'killSent']=true;
      }catch(failure){record(failure);}
    }
    function stop(failure){
      record(failure);if(stopping||settled)return;stopping=true;
      if(finalTimer!==undefined)clearTimer(finalTimer);
      finalTimer=setTimer(()=>finish(false),Math.min(10000,Math.max(0,deadlineUnixMs-clock())));
      void groupSignal('SIGTERM');
      killTimer=setTimer(()=>{void groupSignal('SIGKILL');},Math.min(5000,Math.max(0,deadlineUnixMs-clock())));
    }
    function cancel(){stop(error('jpeg_process_cancelled'));}
    function data(chunk){
      const count=Buffer.isBuffer(chunk)?chunk.length:Buffer.byteLength(chunk);
      execution.stderrBytes=Math.min(Number.MAX_SAFE_INTEGER,execution.stderrBytes+count);
      if(execution.stderrBytes>65536)stop(error('jpeg_child_stderr_limit'));
    }
    function streamError(failure){stop(failure);}
    function childError(failure){stop(failure);}
    function exit(code,childSignal){
      exited=true;execution.exitCode=code;execution.signal=childSignal;
      // A descendant can keep stderr open after its leader exits. Do not wait
      // the whole conversion budget for that pipe or signal the retired PGID.
      if(!stopping&&!settled){
        clearTimer(finalTimer);
        finalTimer=setTimer(()=>finish(false),Math.min(10000,Math.max(0,deadlineUnixMs-clock())));
      }
    }
    function close(code,childSignal){
      exited=true;execution.exitCode=code;execution.signal=childSignal;
      if(!bound)record(error('jpeg_child_identity_unobserved'));
      if(code!==0||childSignal)record(error('jpeg_child_failed'));
      finish(true);
    }
    try{
      child=spawnProcess('/usr/bin/python3.11',['/proc/self/fd/3','--convert','--plan',planPath],{
        detached:true,shell:false,stdio:['ignore','ignore','pipe',scriptFd],
        env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8',PYTHONNOUSERSITE:'1',PYTHONDONTWRITEBYTECODE:'1',
          OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1'}});
      execution.childClosed=false;execution.cleanupUnknown=true;
      execution.pid=Number.isSafeInteger(child.pid)?child.pid:null;
      child.on('exit',exit);child.on('close',close);child.on('error',childError);
      child.stderr?.on('data',data);child.stderr?.on('error',streamError);
      signal?.addEventListener('abort',cancel,{once:true});
      activeTimer=setTimer(()=>stop(error('jpeg_process_deadline')),deadlineUnixMs-clock()-10000);
      finalTimer=setTimer(()=>finish(false),Math.max(0,deadlineUnixMs-clock()));
      if(signal?.aborted)cancel();
      // Do not block the absolute deadline on a stalled /proc read.
      void (async()=>{
        try{
          const identity=await readIdentity(child.pid);
          if(settled||exited)return;
          if(!validIdentity(identity,child.pid))throw error('jpeg_child_identity');
          execution.identity={...identity};bound=true;
          if(stopping)void groupSignal('SIGTERM');
        }catch(failure){if(!settled)stop(failure);}
      })();
    }catch(failure){record(failure);finish(!child);}
    return result;
  }
  return {execute};
}
module.exports={createJpegProcessExecutor,fixedProcIdentity};
