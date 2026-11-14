import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createGcpSourceDiscovery,existingDiscoveredSet,mountGcpSourceDiscovery} from '../workspace-gcp-source-discovery.mjs';
const candidate={sourceFileId:'file',sourceSha256:'a'.repeat(64),fileName:'Control.csv',pointCount:1,format:'emlid-all-columns-v1'};
const preview={sourceSha256:candidate.sourceSha256,pointCount:1,confirmationToken:'b'.repeat(64),
  provenance:{adapter:'emlid-all-columns-v1',coordinateSystem:'Synthetic',verticalDatum:'Declared',linearUnit:'m'}};
const page=(nextAfterId=null)=>({candidates:[candidate],ignored:0,unavailable:0,nextAfterId});
const imported={set:{id:'set',datasetId:'dataset',sourceFileId:'file',sourceSha256:candidate.sourceSha256}};
function fixture(api){let context='session',write=true,sequence=0;const calls=[];
  const controller=createGcpSourceDiscovery({api:async(...args)=>{calls.push(args);return api(...args);},
    getContext:()=>context,canWrite:()=>write,randomUUID:()=>`key-${++sequence}`});
  return{controller,calls,change:value=>{context=value;},readOnly:()=>{write=false;}};
}
test('automatic discovery is single-flight, cached and uses explicit bounded pagination',async()=>{
  let release;const f=fixture(()=>new Promise(resolve=>{release=resolve;}));
  const first=f.controller.load('dataset'),second=f.controller.load('dataset');assert.equal(f.calls.length,1);
  release(page('next'));await first;await second;await f.controller.load('dataset');assert.equal(f.calls.length,1);
  const more=f.controller.load('dataset',{more:true});assert.match(f.calls[1][0],/afterId=next$/);release(page());await more;
  assert.equal(f.calls.every(([,options])=>options.method===undefined),true,'opening discovery never imports');
});
test('preview binds source hash and point count; read-only users cannot request writes',async()=>{
  const f=fixture(async()=>({...preview,sourceSha256:'c'.repeat(64)}));
  await assert.rejects(f.controller.preview('dataset',candidate),/changed/);
  f.readOnly();await assert.rejects(f.controller.confirm('dataset',candidate,preview),/no longer valid/);
  assert.equal(f.calls.length,1);
});
test('lost and malformed import responses preserve exact payload/key until acknowledged',async()=>{
  let attempt=0;const f=fixture(async url=>{if(url.endsWith('import-preview'))return structuredClone(preview);
    attempt++;if(attempt===1)throw Error('lost response');if(attempt===2)return{set:{...imported.set,datasetId:'other'}};return imported;});
  const approved=await f.controller.preview('dataset',candidate);f.calls.length=0;
  await assert.rejects(f.controller.confirm('dataset',candidate,approved),/lost response/);
  await assert.rejects(f.controller.confirm('dataset',candidate,approved),/could not be confirmed/);
  assert.equal((await f.controller.confirm('dataset',candidate,approved)).id,'set');
  for(const [url,options] of f.calls){assert.match(url,/datasets\/dataset\/gcp-sets\/import$/);assert.equal(options.headers['Idempotency-Key'],'key-1');
    assert.equal(options.body.sourceFileId,'file');assert.equal(Object.isFrozen(options.body),true);assert.equal(options.body.content,undefined);}
});
test('authorization change discards in-flight results and fences an unresolved import under replacement authority',async()=>{
  let release;const f=fixture(url=>url.endsWith('import-preview')?Promise.resolve(structuredClone(preview)):new Promise(resolve=>{release=resolve;}));
  const approved=await f.controller.preview('dataset',candidate);
  const pending=f.controller.confirm('dataset',candidate,approved);f.change('replacement');release(imported);
  await assert.rejects(pending,/session changed/);
  const fresh=await f.controller.preview('dataset',candidate);
  await assert.rejects(f.controller.confirm('dataset',candidate,fresh),/earlier import needs review/);
  assert.equal(f.calls.filter(([url])=>url.endsWith('/import')).length,1);
});

test('an open preview confirmation cannot cross token replacement or a clear/reused-token epoch',async()=>{
  for(const change of ['token','epoch']){
    const f=fixture(async()=>structuredClone(preview)),approved=await f.controller.preview('dataset',candidate);
    if(change==='token')f.change('replacement');else f.controller.clear();
    await assert.rejects(f.controller.confirm('dataset',candidate,approved),/preview expired/);
    assert.equal(f.calls.length,1,'old dialog must not allocate a new import request');
  }
});

test('unbound or modified preview/source cannot authorize an import',async()=>{
  const f=fixture(async()=>structuredClone(preview));
  await assert.rejects(f.controller.confirm('dataset',candidate,preview),/preview expired/);
  const approved=await f.controller.preview('dataset',candidate);
  await assert.rejects(f.controller.confirm('dataset',{...candidate,fileName:'Changed.csv'},approved),/preview expired/);
  approved.provenance.verticalDatum='Changed';
  await assert.rejects(f.controller.confirm('dataset',candidate,approved),/preview expired/);assert.equal(f.calls.length,1);
});
test('malformed discovery identifiers and missing cursor do not become candidate controls',async()=>{
  for(const changed of [{nextAfterId:undefined},{candidates:[{...candidate,sourceFileId:undefined}]},{ignored:9}]){
    const f=fixture(async()=>({...page(),...changed}));await assert.rejects(f.controller.load('dataset'),/could not be confirmed/);
  }
});
test('already imported source is identified and no second import button is mounted',async()=>{
  const elements=[],host={isConnected:true,ownerDocument:{createElement:()=>({})},replaceChildren(){elements.length=0;},append:value=>elements.push(value)};
  assert.equal(existingDiscoveredSet(candidate,[imported.set]).id,'set');const f=fixture(async()=>page());
  await mountGcpSourceDiscovery({host,datasetId:'dataset',controller:f.controller,canImport:true,sets:[imported.set],
    confirmImport:assert.fail,onImported:assert.fail,onError:assert.fail});
  assert.ok(elements.some(value=>value.textContent?.includes('Already imported')));
  assert.equal(elements.some(value=>value.textContent==='Review and use these points'),false);assert.equal(f.calls.length,1);
});
test('explicit review confirms the mapping before import; render and cancellation never create a set',async()=>{
  const elements=[],host={isConnected:true,ownerDocument:{createElement:()=>({})},replaceChildren(){elements.length=0;},append:value=>elements.push(value)};
  const f=fixture(async url=>url.endsWith('import-preview')?preview:page());let confirmations=0;
  await mountGcpSourceDiscovery({host,datasetId:'dataset',controller:f.controller,canImport:true,
    confirmImport:async()=>{confirmations++;return false;},onImported:assert.fail,onError:assert.fail});
  assert.equal(f.calls.length,1);const button=elements.find(value=>value.textContent==='Review and use these points');
  await button.onclick();assert.equal(confirmations,1);assert.equal(f.calls.length,2);assert.match(f.calls[1][0],/import-preview$/);
});

test('task source or permission changes during confirmation cannot submit an old panel import',async()=>{
  for(const change of ['source','permission']){
    const elements=[],errors=[],host={isConnected:true,ownerDocument:{createElement:()=>({})},replaceChildren(){elements.length=0;},append:value=>elements.push(value)};
    let current=true,allowed=true;const f=fixture(async url=>url.endsWith('import-preview')?preview:page());
    await mountGcpSourceDiscovery({host,datasetId:'dataset',controller:f.controller,canImport:()=>allowed,isCurrent:()=>current,
      confirmImport:async()=>{if(change==='source')current=false;else allowed=false;return true;},onImported:assert.fail,onError:error=>errors.push(error)});
    await elements.find(value=>value.textContent==='Review and use these points').onclick();
    assert.equal(f.calls.length,2);assert.equal(errors.length,1);assert.match(errors[0].message,/task changed/);
  }
});
test('actual workspace transport checks guards before dispatch and before stale401 effects',async()=>{
  const source=fs.readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  const line=source.split(/\r?\n/).find(value=>value.startsWith('async function api('));
  let finish,clears=0,sends=0;const state={token:'original'},context=vm.createContext({state,
    crypto:{randomUUID:()=> 'preview-key'},clearWorkspaceAuthorization:()=>{clears++;},
    workspaceFetch:()=>assert.fail('must bypass replacement-auth replay'),fetch:url=>{
      if(url.endsWith('import-preview'))return Promise.resolve({ok:true,status:200,json:async()=>structuredClone(preview)});
      sends++;return new Promise(resolve=>{finish=resolve;});}});
  vm.runInContext(line,context);const controller=createGcpSourceDiscovery({api:context.api,getContext:()=>state.token,canWrite:()=>true,randomUUID:()=> 'write-key'});
  const approved=await controller.preview('dataset',candidate);
  const request=controller.confirm('dataset',candidate,approved);state.token='replacement';finish({ok:false,status:401,json:async()=>({})});
  await assert.rejects(request,/session changed/);assert.equal(clears,0);assert.equal(sends,1);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const delayed=createGcpSourceDiscovery({api:async(...args)=>{if(!args[0].endsWith('import-preview'))await gate;return context.api(...args);},getContext:()=>state.token,canWrite:()=>true,randomUUID:()=> 'delayed'});
  const delayedPreview=await delayed.preview('dataset',candidate);
  const pending=delayed.confirm('dataset',candidate,delayedPreview);state.token='third';release();
  await assert.rejects(pending,/session changed/);assert.equal(sends,1);
});
