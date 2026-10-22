'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {processReconcile}=require('../server/processingWorker');
function fixture({status='running',outputError=null,appendError=null,cursorError=null,signal=null}={}){
 const calls=[],attempt={id:'attempt',providerId:'provider',providerTaskId:'upstream',providerOutputCursor:17},job={id:'job',attempt_id:'attempt',lease_owner:'owner'};
 const processing={getAttempt:()=>attempt,getProvider:()=>({id:'provider'}),appendLog:(...args)=>{if(appendError)throw appendError;calls.push(['log',...args]);},setOutputCursor:(...args)=>{if(cursorError)throw cursorError;calls.push(['cursor',...args]);},transitionAttemptForJob:(...args)=>{calls.push(['transition',...args]);return attempt;},completeAndEnqueueJob:(...args)=>{calls.push(['enqueue',...args]);return true;}};
 const adapterFactory=()=>({status:async()=>({status,progress:.64}),output:async(_id,cursor)=>{assert.equal(cursor,17);if(outputError)throw outputError;return{lines:['actual provider record'],nextLine:18};}});
 return{calls,processing,run:()=>processReconcile(job,{processing,config:{},providerCredentials:{},signal,adapterFactory})};
}
for(const status of ['running','completed'])test(`${status} status remains authoritative when output cannot be read`,async()=>{
 const f=fixture({status,outputError:new Error('provider response exceeds size limit SECRET=do-not-copy')});await f.run();
 assert.equal(f.calls.find(call=>call[0]==='transition')[3],status==='completed'?'ingesting':'running');
 assert.equal(f.calls.find(call=>call[0]==='enqueue')[4],status==='completed'?'ingest':'reconcile');
 assert.equal(f.calls.some(call=>call[0]==='cursor'),false);
 const warning=f.calls.find(call=>call[0]==='log');assert.equal(warning[2],'warn');assert.match(warning[3],/cursor has not advanced/);assert.doesNotMatch(warning[3],/SECRET|do-not-copy/);
});
test('successful output persists exact records and cursor before status advancement',async()=>{
 const f=fixture();await f.run();assert.deepEqual(f.calls.slice(0,2),[['log','attempt','provider','actual provider record'],['cursor','attempt',18]]);
});
test('abort and lease errors are not downgraded to optional output failures',async()=>{
 for(const error of [Object.assign(new Error('aborted'),{name:'AbortError'}),Object.assign(new Error('lease lost'),{code:'lease_lost'})]){const f=fixture({outputError:error});await assert.rejects(f.run(),error);assert.deepEqual(f.calls,[]);}
 const controller=new AbortController();controller.abort();const f=fixture({signal:controller.signal});await assert.rejects(f.run(),{name:'AbortError'});assert.deepEqual(f.calls,[]);
});
test('log append, warning append and cursor storage failures remain fatal',async()=>{
 for(const options of [{appendError:new Error('disk failed')},{outputError:new Error('network failed'),appendError:new Error('disk failed')},{cursorError:new Error('cursor failed')}]){
  const f=fixture(options);await assert.rejects(f.run(),options.appendError||options.cursorError);assert.equal(f.calls.some(call=>call[0]==='transition'||call[0]==='enqueue'),false);
 }
});
test('lease fencing still blocks transition after a nonfatal output read failure',async()=>{
 const f=fixture({outputError:new Error('invalid json')});f.processing.transitionAttemptForJob=()=>null;
 await assert.rejects(f.run(),{code:'lease_lost'});assert.equal(f.calls.some(call=>call[0]==='enqueue'),false);
});
