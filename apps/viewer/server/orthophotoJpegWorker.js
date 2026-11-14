'use strict';
const {inspectJpegWorkerProfile,observeClosure,sameJpegWorkerBaseline}=require('./orthophotoJpegWorkerProfile');
const HASH=/^[a-f0-9]{64}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const need=(value,code)=>{if(!value)fail(code);};
const codeOf=error=>/^[a-z0-9_]{1,80}$/.test(error?.code||'')?error.code:'jpeg_worker_failed';

// Trusted service composition only. No HTTP route or worker is started here.
// prepare/execute/validate/evidence hooks are server-owned, never request data.
// Each must honor signal/assertCurrent; the deployment owner additionally owns
// a finite service/cgroup deadline if the runtime itself becomes unresponsive.
function createOrthophotoJpegWorker({enabled=false,dedicated=false,jobs,owner,
  assertRuntimeQualified,prepare,execute,validateOutput,recordEvidence,
  inspectProfile=inspectJpegWorkerProfile,observeProcessClosure=observeClosure,
  clock=Date.now,timers={setTimeout,clearTimeout,setInterval,clearInterval}}={}){
  let busy=false,halted=false;
  function now(){const t=clock();need(Number.isSafeInteger(t)&&t>=0,'invalid_job_clock');return t;}
  async function runOne({signal=null}={}){
    if(!enabled)return {status:'disabled'};
    if(halted)return {status:'halted'};
    if(busy)return {status:'busy'};
    need(dedicated===true&&typeof owner==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(owner)&&jobs&&
      ['claim','get','heartbeat','complete','closeLease','requireCleanup'].every(k=>typeof jobs[k]==='function')&&
      [assertRuntimeQualified,prepare,execute,validateOutput,recordEvidence,inspectProfile,observeProcessClosure]
        .every(fn=>typeof fn==='function'),'jpeg_worker_composition_unqualified');
    busy=true;
    const abort=new AbortController();
    const cancel=()=>abort.abort(signal.reason);
    signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)cancel();
    let job=null,baseline=null,heartbeat=null,deadlineTimer=null,execution=null,executionStarted=false,uncertain=false;
    let cleanupDeadline=null;
    const preclaimDeadline=now()+30000;
    const stop=code=>abort.abort(Object.assign(new Error(code),{code}));
    const owned=()=>({jobId:job.id,owner,token:job.lease_token});
    const check=()=>{
      abort.signal.throwIfAborted();
      if(!job)return;
      const row=jobs.get(job.id),t=now();
      need(row?.status==='leased'&&row.lease_owner===owner&&row.lease_token===job.lease_token&&
        row.lease_expires_unix_ms>t&&row.deadline_unix_ms>t,'jpeg_worker_lease_lost');
    };
    const cleanupCheck=()=>{
      const row=jobs.get(job.id);
      need(row&&['leased','cleanup_required'].includes(row.status)&&row.lease_owner===owner&&
        row.lease_token===job.lease_token,'jpeg_worker_lease_lost');
    };
    async function boundedHook(fn,payload,{cleanup=false}={}){
      const controller=new AbortController(),guard=cleanup?cleanupCheck:check;
      const deadline=Math.min(job?.deadline_unix_ms??preclaimDeadline,cleanup?cleanupDeadline:Infinity);
      guard();need(deadline>now(),'jpeg_worker_hook_deadline');
      let settled=false,timer,onAbort;
      return new Promise((resolve,reject)=>{
        const finish=(error,value)=>{
          if(settled)return;settled=true;
          // Promise microtasks can run before an overdue timeout callback.
          // The clock, not timer delivery order, decides whether work was late.
          if(now()>=deadline){
            uncertain=true;error=Object.assign(new Error('jpeg_worker_hook_deadline'),{code:'jpeg_worker_hook_deadline'});
            controller.abort(error);
          }
          if(timer!==undefined)timers.clearTimeout(timer);
          if(onAbort)abort.signal.removeEventListener('abort',onAbort);
          if(error)reject(error);else resolve(value);
        };
        const stopHook=code=>{
          if(settled)return;
          uncertain=true;const error=Object.assign(new Error(code),{code});
          controller.abort(error);finish(error);
        };
        onAbort=()=>{
          if(settled)return;
          controller.abort(abort.signal.reason);
          // Give an owned hook a finite chance to finish its own finally block.
          // Only an unacknowledged cancellation is uncertain; never race into
          // native execution or clear a fence while that hook remains pending.
          if(timer!==undefined)timers.clearTimeout(timer);
          timer=timers.setTimeout(()=>stopHook('jpeg_worker_hook_cancelled'),
            Math.min(10000,Math.max(0,deadline-now())));
        };
        if(!cleanup)abort.signal.addEventListener('abort',onAbort,{once:true});
        timer=timers.setTimeout(()=>stopHook('jpeg_worker_hook_deadline'),Math.max(0,deadline-now()));
        const context={...payload,signal:controller.signal,deadlineUnixMs:deadline,assertCurrent:()=>{
          controller.signal.throwIfAborted();
          if(now()>=deadline){uncertain=true;fail('jpeg_worker_hook_deadline');}
          guard();
        }};
        // Attach both outcomes even if a hook ignores cancellation. A pending
        // hook is uncertain: retain the fence and stop, never retry/release it.
        Promise.resolve().then(()=>{context.assertCurrent();return fn(context);}).then(
          value=>finish(null,value),error=>finish(error));
      });
    }
    const observe=async(cleanup=false)=>{
      uncertain=true;
      const closure=await boundedHook(context=>observeProcessClosure(baseline,context),{},{cleanup});
      need(closure?.closureObserved===true&&closure.observed?.kernelProfileObserved===true&&
        sameJpegWorkerBaseline(baseline,closure.observed),'jpeg_worker_closure_unknown');
      uncertain=false;
      return closure;
    };
    const record=async(evidence,cleanup=false)=>{
      uncertain=true;
      const result=await boundedHook(recordEvidence,evidence,{cleanup});
      need(result&&HASH.test(result.sha256),'jpeg_worker_evidence_not_durable');
      uncertain=false;return result.sha256;
    };
    try{
      check();need(await boundedHook(assertRuntimeQualified,{})===true,'jpeg_worker_runtime_unqualified');
      check();baseline=await boundedHook(inspectProfile,{});
      need(baseline?.kernelProfileObserved===true,'jpeg_worker_profile_unobserved');
      check();const deadlineUnixMs=now()+900000;
      job=jobs.claim({owner,leaseMs:30000,deadlineUnixMs});
      if(!job)return {status:'idle'};
      check();
      heartbeat=timers.setInterval(()=>{
        try{if(!jobs.heartbeat({...owned(),leaseMs:30000}))stop('jpeg_worker_lease_lost');}
        catch{stop('jpeg_worker_heartbeat_failed');}
      },10000);
      deadlineTimer=timers.setTimeout(()=>stop('jpeg_worker_deadline'),Math.max(0,job.deadline_unix_ms-now()));
      const context={job,baseline,signal:abort.signal,deadlineUnixMs:job.deadline_unix_ms,assertCurrent:check};
      const prepared=await boundedHook(prepare,context);check();
      executionStarted=true;
      execution=await execute({...context,prepared});
      need(execution?.childClosed===true&&execution.cleanupUnknown===false,'jpeg_worker_child_cleanup_unknown');
      check();const validated=await boundedHook(validateOutput,{...context,prepared,execution});check();
      need(validated&&validated.result&&validated.evidence,'jpeg_worker_output_unverified');
      const closure=await observe();check();
      const validationHash=await record({kind:'jpeg-validation',jobId:job.id,evidence:validated.evidence});check();
      const closureHash=await record({kind:'jpeg-closure',jobId:job.id,baseline,closure,execution});check();
      need(jobs.complete({...owned(),result:{...validated.result,
        workerValidationEvidenceSha256:validationHash,closureEvidenceSha256:closureHash}}),
      'jpeg_worker_completion_conflict');
      return {status:'succeeded',jobId:job.id};
    }catch(error){
      if(!job){if(uncertain)halted=true;throw error;}
      execution=error.execution||execution;
      cleanupDeadline=Math.min(job.deadline_unix_ms,now()+10000);
      try{
        // A missing lifecycle receipt after entering execute is uncertain even
        // if a later process snapshot happens to look empty.
        need(!uncertain&&(!executionStarted||execution?.childClosed===true&&execution.cleanupUnknown===false),
          'jpeg_worker_child_cleanup_unknown');
        const closure=await observe(true);
        const closureHash=await record({kind:'jpeg-failed-closure',jobId:job.id,
          errorCode:codeOf(error),baseline,closure,execution},true);
        need(jobs.closeLease({...owned(),closureEvidenceSha256:closureHash,action:'fail',errorCode:codeOf(error)}),
          'jpeg_worker_closure_commit_unknown');
        return {status:'failed',jobId:job.id,errorCode:codeOf(error)};
      }catch{
        halted=true;
        // Do not clear another owner, auto-retry, steal an expired lease or
        // claim another job. Even a failed marker write must halt this service.
        try{jobs.requireCleanup({...owned(),errorCode:'worker_cleanup_unknown'});}catch{}
        return {status:'halted',jobId:job.id,errorCode:'worker_cleanup_unknown'};
      }
    }finally{
      if(heartbeat!==null)timers.clearInterval(heartbeat);
      if(deadlineTimer!==null)timers.clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort',cancel);busy=false;
    }
  }
  return {runOne};
}
module.exports={createOrthophotoJpegWorker};
