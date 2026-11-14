'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createJpegProcessExecutor}=require('../server/orthophotoJpegProcess');
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture({readIdentity,spawnError}={}){
  let now=1000;const timers=new Map(),signals=[];let timerId=0,args;
  const child=new EventEmitter();child.pid=123;
  child.stderr=new EventEmitter();child.stderr.destroy=()=>{child.stderr.destroyed=true;};
  const identity={pid:123,startTicks:'890',pgid:123,sid:123};
  const executor=createJpegProcessExecutor({spawnProcess:(...values)=>{args=values;if(spawnError)throw spawnError;return child;},
    readIdentity:readIdentity||(async()=>({...identity})),signalGroup:(...values)=>signals.push(values),
    setTimer:(fn,delay)=>{timers.set(++timerId,{fn,at:now+delay});return timerId;},clearTimer:id=>timers.delete(id)});
  async function advance(ms){now+=ms;for(const [id,row] of [...timers])if(timers.has(id)&&row.at<=now){timers.delete(id);row.fn();}await flush();}
  return {child,signals,identity,timers,advance,get args(){return args;},
    run:(signal,deadline=31000)=>executor.execute({planPath:'/private/op/plan.json',scriptFd:8,signal,deadlineUnixMs:deadline,clock:()=>now})};
}
test('fixed invocation inherits only pinned script and drains bounded stderr without retaining content',async()=>{
  const f=fixture(),promise=f.run();await flush();
  assert.equal(f.args[0],'/usr/bin/python3.11');
  assert.deepEqual(f.args[1],['/proc/self/fd/3','--convert','--plan','/private/op/plan.json']);
  assert.deepEqual(f.args[2].stdio,['ignore','ignore','pipe',8]);
  assert.equal(f.args[2].detached,true);assert.equal(f.args[2].shell,false);
  assert.equal(f.args[2].env.LD_PRELOAD,undefined);
  f.child.stderr.emit('data',Buffer.alloc(123));f.child.emit('exit',0,null);f.child.emit('close',0,null);
  const result=await promise;assert.equal(result.childClosed,true);assert.equal(result.cleanupUnknown,false);
  assert.equal(result.stderrBytes,123);assert.equal('stderr' in result,false);assert.equal(f.timers.size,0);
});
test('cancel escalates only while exact owned leader is alive and waits for close',async()=>{
  const f=fixture(),abort=new AbortController(),promise=f.run(abort.signal);const failed=assert.rejects(promise,e=>e.code==='jpeg_process_cancelled'&&e.execution.childClosed);
  await flush();abort.abort();await flush();assert.deepEqual(f.signals,[[-123,'SIGTERM']]);
  await f.advance(5000);assert.deepEqual(f.signals,[[-123,'SIGTERM'],[-123,'SIGKILL']]);
  f.child.emit('exit',null,'SIGKILL');f.child.emit('close',null,'SIGKILL');await failed;assert.equal(f.timers.size,0);
});
test('reused identity never receives group signal and cleanup remains unknown',async()=>{
  let calls=0;const f=fixture({readIdentity:async()=>({pid:123,startTicks:++calls===1?'890':'891',pgid:123,sid:123})});
  const abort=new AbortController(),promise=f.run(abort.signal);
  const failed=assert.rejects(promise,e=>e.execution.cleanupUnknown&&!e.execution.childClosed&&e.execution.firstFailure.code==='jpeg_process_cancelled');
  await flush();abort.abort();await flush();await f.advance(5000);await f.advance(5000);await failed;
  assert.deepEqual(f.signals,[]);assert.equal(f.child.stderr.destroyed,true);assert.equal(f.timers.size,0);
});
test('exited leader is never group-signalled even if inherited pipe prevents close',async()=>{
  const f=fixture(),abort=new AbortController(),promise=f.run(abort.signal);
  const failed=assert.rejects(promise,e=>e.execution.cleanupUnknown);
  await flush();f.child.emit('exit',0,null);abort.abort();await f.advance(10000);await failed;assert.deepEqual(f.signals,[]);
});

test('normal leader exit with an inherited pipe settles unknown within ten seconds',async()=>{
  const f=fixture(),promise=f.run();
  const failed=assert.rejects(promise,e=>e.code==='jpeg_child_cleanup_unknown'&&e.execution.cleanupUnknown);
  await flush();f.child.emit('exit',0,null);await f.advance(10000);await failed;
  assert.deepEqual(f.signals,[]);assert.equal(f.timers.size,0);
});
test('absolute deadline reserves cleanup and stderr overflow retains first failure',async()=>{
  const f=fixture(),promise=f.run();const failed=assert.rejects(promise,e=>e.code==='jpeg_process_deadline'&&e.execution.cleanupUnknown);
  await flush();await f.advance(20000);assert.deepEqual(f.signals,[[-123,'SIGTERM']]);
  await f.advance(5000);await f.advance(5000);await failed;
  const g=fixture(),other=g.run();const overflow=assert.rejects(other,e=>e.code==='jpeg_child_stderr_limit'&&e.execution.stderrBytes===65537);
  await flush();g.child.stderr.emit('data',Buffer.alloc(65537));await flush();g.child.emit('close',1,null);await overflow;
});
test('spawn error and unobservable identity fail with explicit lifecycle evidence',async()=>{
  const f=fixture({spawnError:new Error('spawn failed')});await assert.rejects(f.run(),e=>e.execution.childClosed&&e.execution.pid===null);
  const g=fixture({readIdentity:()=>new Promise(()=>{})}),promise=g.run();
  const failed=assert.rejects(promise,e=>e.execution.cleanupUnknown&&e.execution.identity===null);
  await g.advance(20000);await g.advance(10000);await failed;assert.deepEqual(g.signals,[]);
});
test('pre-spawn rejection creates no child and carries closed execution evidence',async()=>{
  const f=fixture();await assert.rejects(f.run(null,1001),e=>e.code==='jpeg_process_deadline'&&e.execution.childClosed&&!e.execution.cleanupUnknown);
  const abort=new AbortController();abort.abort();
  await assert.rejects(f.run(abort.signal),e=>e.code==='jpeg_process_cancelled'&&e.execution.childClosed);
  assert.equal(f.args,undefined);assert.equal(f.timers.size,0);
});
