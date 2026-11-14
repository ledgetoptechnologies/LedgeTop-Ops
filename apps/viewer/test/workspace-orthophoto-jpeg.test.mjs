import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {jpegPreparationView,createJpegPreparationRequests,mountJpegPreparation} from '../workspace-orthophoto-jpeg.mjs';

const output=()=>({id:'version',modelId:'model',downloadProducts:[],jpegPreparation:{modelId:'model',versionId:'version',
  requestUrl:'/api/v1/models/model/orthophoto-jpeg-jobs',job:null}});
const job=(status='queued')=>({id:'job',modelId:'model',versionId:'version',format:'JPG',fullResolution:true,status});
function fixture(api){let context='session',sequence=0;const calls=[];
  const requests=createJpegPreparationRequests({api:async(...args)=>{calls.push(args);return api(...args);},
    getContext:()=>context,randomUUID:()=>`key-${++sequence}`});
  return{requests,calls,change:value=>{context=value;}};
}

test('generation is server-described, version-bound and writer-only; render never submits',()=>{
  const o=output();assert.equal(jpegPreparationView(o,false),null);
  for(const changed of [{id:'other'},{modelId:'other'},{jpegPreparation:{...o.jpegPreparation,requestUrl:'https://evil.invalid/'}}])
    assert.equal(jpegPreparationView({...o,...changed},true),null);
  assert.equal(jpegPreparationView({...o,downloadProducts:[{kind:'orthoJpg'}]},true),null);
  assert.equal(jpegPreparationView(o,true).canRequest,true);
  for(const status of ['queued','leased','failed','cleanup_required','succeeded']){
    const view=jpegPreparationView({...o,jpegPreparation:{...o.jpegPreparation,job:{id:'job',status}}},true);
    assert.equal(view.canRequest,false);assert.ok(view.message.length>10);
  }
});

test('lost or malformed responses retain identical payload and idempotency key',async()=>{
  let attempt=0;const f=fixture(async()=>{attempt++;if(attempt===1)throw new Error('lost response');
    if(attempt===2)return{job:{...job(),versionId:'wrong'}};return{job:job()};});
  await assert.rejects(f.requests.request(output(),true),/lost response/);
  await assert.rejects(f.requests.request(output(),true),/could not be confirmed/);
  assert.deepEqual(await f.requests.request(output(),true),{id:'job',status:'queued'});
  assert.equal(f.calls.length,3);
  for(const [url,options] of f.calls){assert.equal(url,'/api/v1/models/model/orthophoto-jpeg-jobs');
    assert.equal(options.method,'POST');assert.deepEqual(options.body,{versionId:'version'});
    assert.equal(options.headers['Idempotency-Key'],'key-1');assert.equal(Object.isFrozen(options.body),true);}
});

test('single-flight and changed authorization discard in-flight success',async()=>{
  let resolve;const f=fixture(()=>new Promise(done=>{resolve=done;}));
  const request=f.requests.request(output(),true);
  await assert.rejects(f.requests.request(output(),true),/already being submitted/);assert.equal(f.calls.length,1);
  f.change('other-session');resolve({job:job()});await assert.rejects(request,/session changed/);
});

test('clearing authorization prevents stale completion even when context string is reused',async()=>{
  const resolvers=[],f=fixture(()=>new Promise(resolve=>resolvers.push(resolve)));
  const first=f.requests.request(output(),true);f.requests.clear();const next=f.requests.request(output(),true);
  resolvers[0]({job:job()});await assert.rejects(first,/session changed/);
  resolvers[1]({job:job()});assert.deepEqual(await next,{id:'job',status:'queued'});
  assert.notEqual(f.calls[0][1].headers['Idempotency-Key'],f.calls[1][1].headers['Idempotency-Key']);
});

test('UI action enqueues only on explicit click, then offers explicit refresh without timers',async()=>{
  const elements=[],host={ownerDocument:{createElement:()=>({})},replaceChildren(){elements.length=0;},append:element=>elements.push(element)};
  let refreshes=0;const f=fixture(async()=>({job:job()})),o=output();
  mountJpegPreparation({host,output:o,canWrite:true,requests:f.requests,refresh:async()=>{refreshes++;},onError:assert.fail});
  assert.equal(f.calls.length,0);assert.equal(elements[1].textContent,'Prepare full-resolution JPG');
  await elements[1].onclick();assert.equal(f.calls.length,1);assert.equal(o.jpegPreparation.job.status,'queued');
  assert.equal(elements[1].textContent,'Refresh products');await elements[1].onclick();
  assert.equal(refreshes,1);assert.equal(f.calls.length,1);
});

test('failed submission keeps retry available without changing its request identity',async()=>{
  const elements=[],errors=[],host={ownerDocument:{createElement:()=>({})},replaceChildren(){elements.length=0;},append:element=>elements.push(element)};
  const f=fixture(async()=>{throw new Error('temporarily unavailable');});
  mountJpegPreparation({host,output:output(),canWrite:true,requests:f.requests,refresh:assert.fail,onError:error=>errors.push(error)});
  await elements[1].onclick();assert.equal(elements[1].disabled,false);await elements[1].onclick();
  assert.equal(errors.length,2);assert.equal(f.calls[0][1].headers['Idempotency-Key'],f.calls[1][1].headers['Idempotency-Key']);
});

test('actual workspace transport bypasses renewal replay and checks authority before dispatch',async()=>{
  const source=fs.readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  const line=source.split(/\r?\n/).find(value=>value.startsWith('async function api('));assert.ok(line);
  const sends=[],state={token:'original'};
  const context=vm.createContext({state,crypto:{randomUUID:()=>assert.fail('explicit key required')},
    workspaceFetch:()=>assert.fail('JPG mutation must not enter cross-session renewal replay'),
    fetch:async(path,init)=>{sends.push({path,init});return{ok:true,status:202,json:async()=>({job:job()})};}});
  vm.runInContext(line,context);
  const requests=createJpegPreparationRequests({api:context.api,getContext:()=>state.token,randomUUID:()=> 'one-key'});
  await requests.request(output(),true);assert.equal(sends.length,1);
  assert.equal(sends[0].init.headers.Authorization,'Bearer original');
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const delayed=createJpegPreparationRequests({api:async(...args)=>{await gate;return context.api(...args);},
    getContext:()=>state.token,randomUUID:()=> 'delayed-key'});
  const pending=delayed.request(output(),true);state.token='replacement';release();
  await assert.rejects(pending,/session changed/i);assert.equal(sends.length,1,'old action never dispatched under replacement bearer');
  let finish,clears=0;
  context.clearWorkspaceAuthorization=()=>{clears++;};
  context.fetch=()=>new Promise(resolve=>{finish=resolve;});
  const stale=requests.request(output(),true);
  state.token='third-session';
  finish({ok:false,status:401,json:async()=>({code:'authentication_required'})});
  await assert.rejects(stale,/session changed/i);
  assert.equal(clears,0,'an old in-flight 401 must not clear replacement authority');
});
