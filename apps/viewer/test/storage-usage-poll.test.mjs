import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createStorageUsagePoll } from '../storage-usage-poll.mjs';
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('pending storage auto-refresh is single-flight and stops when measured',async()=>{
  let pending=true,timer,resolve,calls=0;const results=[];
  const poll=createStorageUsagePoll({shouldPoll:()=>pending,read:()=>{calls++;return new Promise(r=>resolve=r);},onResult:value=>{results.push(value);pending=false;},onError:assert.fail,setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{timer=null;}});
  poll.sync();assert.ok(timer);const fire=timer;timer=null;fire();poll.sync();poll.sync();assert.equal(calls,1);resolve({status:'complete'});await turn();assert.equal(results.length,1);assert.equal(timer,null);
});

test('leaving diagnostics aborts storage-only request and ignores its stale result',async()=>{
  let visible=true,timer,resolve,signal;let results=0;
  const poll=createStorageUsagePoll({shouldPoll:()=>visible,read:s=>{signal=s;return new Promise(r=>resolve=r);},onResult:()=>results++,onError:assert.fail,setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{timer=null;}});
  poll.sync();const fire=timer;timer=null;fire();visible=false;poll.sync();assert.equal(signal.aborted,true);resolve({});await turn();assert.equal(results,0);assert.equal(timer,null);
});

test('repeated failures and long pending scans have bounded automatic polling',async()=>{
  let timer,reads=0;const errors=[];
  const poll=createStorageUsagePoll({shouldPoll:()=>true,read:async()=>{reads++;throw Error('offline');},onResult:assert.fail,onError:error=>errors.push(error),setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{timer=null;}});
  poll.sync();for(let i=0;i<3;i++){const next=timer;timer=null;next();await turn();}assert.equal(reads,3);assert.equal(errors.length,1);assert.equal(timer,null);
  let attempts=0;const bounded=createStorageUsagePoll({shouldPoll:()=>true,read:async()=>{attempts++;return{};},onResult:()=>{},onError:error=>errors.push(error),maxAttempts:2,setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{timer=null;}});
  bounded.sync();for(let i=0;i<2;i++){const next=timer;timer=null;next();await turn();}assert.equal(attempts,2);assert.equal(timer,null);assert.equal(errors.length,2);
});

test('workspace replaces only storage cards and preserves expanded diagnostic panels',()=>{
  const source=fs.readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  assert.match(source,/read:signal=>api\('\/api\/v1\/storage\?limit=1',\{signal\}\)/);
  assert.match(source,/getElementById\('storage-usage-cards'\)/);
  assert.match(source,/addEventListener\('pagehide',\(\)=>storageUsagePoll\.stop\(\)\)/);
  assert.match(source,/document\.addEventListener\('visibilitychange',\(\)=>storageUsagePoll\.sync\(\)\)/);
  const callback=source.slice(source.indexOf('onResult:result=>'),source.indexOf('onError:message=>'));
  assert.doesNotMatch(callback,/\brender\(/);assert.doesNotMatch(callback,/diagnosticDetails|taskDisclosures/);
});
