'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {fork} = require('node:child_process');
const {EventEmitter} = require('node:events');
const {childCalculation} = require('../server/measurementCalculationWorker');
const {sendCalculationMessage} = require('../server/measurementCalculationTransport');

test('real bounded process transports a multi-megabyte preview intact before disconnect', async () => {
  const result = await childCalculation('unused', {source:{kind:'dsm'}}, {
    config:{measurementTimeoutMs:15000}, isLive:()=>true,
    forkProcess:(_file,args,options)=>fork(path.join(__dirname,'helpers/measurement-ipc-child.cjs'),args,options),
  });
  assert.equal(result.preview.samples.length,120000);
  assert.deepEqual(result.preview.samples[119999],[119999+.123456789,119999*.345678901,119999*.987654321,0]);
  assert.equal(result.sentinel,'complete-last-field');
});
test('parent drains queued result after exit, but rejects a closed worker without a result', async () => {
  for (const withResult of [true,false]) {
    const promise=childCalculation('unused',{source:{kind:'dsm'}},{config:{measurementTimeoutMs:1000},isLive:()=>true,forkProcess:()=>{
      const child=new EventEmitter();child.kill=()=>{};child.send=()=>queueMicrotask(()=>{child.emit('exit',0,null);if(withResult)child.emit('message',{type:'result',result:{ok:true}});child.emit('close',0,null);});return child;
    }});
    if(withResult)assert.deepEqual(await promise,{ok:true});else await assert.rejects(promise,{code:'measurement_worker_interrupted'});
  }
});
test('transport awaits write callback and fails cleanly for disconnected channels', async () => {
  let done,settled=false;const pending=sendCalculationMessage({type:'result'},{connected:true,send:(_message,callback)=>{done=callback;return false;}}).then(()=>{settled=true;});
  await Promise.resolve();assert.equal(settled,false);done();await pending;assert.equal(settled,true);
  await assert.rejects(sendCalculationMessage({}, {connected:false}),{code:'measurement_worker_interrupted'});
  await assert.rejects(sendCalculationMessage({}, {connected:true,send:(_message,callback)=>callback(new Error('closed'))}),/closed/);
});
