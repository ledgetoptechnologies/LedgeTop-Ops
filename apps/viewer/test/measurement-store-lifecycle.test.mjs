import test from 'node:test';
import assert from 'node:assert/strict';
import {createMeasurementStore} from '../measurement-store.mjs';
const record={id:'0e439915-bcda-4c90-852a-9e0a7f48c7ce',name:'Private',collection:'spatial3d',kind:'distance',vertices:[[0,0,0],[1,0,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const response=measurement=>({ok:true,status:200,json:async()=>({measurement})});

test('late denied response cannot invalidate same-bearer newly verified access',async()=>{
  for(const status of [401,403]){
    let access=0;const wait=deferred(),started=deferred();let delayed=false;
    const store=createMeasurementStore({token:()=> 'same-token',accessGeneration:()=>access,fetcher:async()=>{
      if(delayed){started.resolve();await wait.promise;return{ok:false,status};}return response({...record,revision:1});
    }});
    await store.save(record);delayed=true;
    const saving=store.patch(store.records.get(record.id),{name:'Edited'}),rejected=assert.rejects(saving,error=>error.code==='measurement_obsolete_access');
    await started.promise;access++;wait.resolve();await rejected;
    assert.equal(store.isInvalidated(),false);assert.equal(store.records.size,1);
  }
});

test('rapid name and units patches serialize against acknowledged revision without losing either field',async()=>{
  const wait=deferred(),started=deferred(),requests=[];
  const store=createMeasurementStore({token:()=> 'token',fetcher:async(_url,options)=>{
    const body=JSON.parse(options.body);requests.push(body);
    if(requests.length===2){started.resolve();await wait.promise;}
    return response({...body,revision:(body.revision||0)+1});
  }});
  await store.save(record);const snapshot=structuredClone(store.records.get(record.id));
  const rename=store.patch(snapshot,{name:'North side'});await started.promise;
  const units=store.patch(snapshot,{displayPreferences:{units:'m'}});wait.resolve();await Promise.all([rename,units]);
  assert.deepEqual(requests.map(r=>r.revision),[undefined,1,2]);
  assert.equal(store.records.get(record.id).name,'North side');assert.equal(store.records.get(record.id).displayPreferences.units,'m');
  await assert.rejects(store.patch(snapshot,{name:'Stale caller'}),error=>error.status===409);
});

test('serialized UI patches retain cross-tab server conflict protection',async()=>{
  let external=false;const store=createMeasurementStore({token:()=> 'token',fetcher:async()=>external?{ok:false,status:409,json:async()=>({})}:response({...record,revision:1})});
  await store.save(record);external=true;
  await assert.rejects(store.patch(store.records.get(record.id),{name:'Conflict'}),error=>error.status===409);
  assert.match(store.statuses.get(record.id),/Not saved/);assert.equal(store.records.get(record.id).revision,1);
});
test('invalidation clears data and fences an in-flight write and queued writes',async()=>{
  const wait=deferred(),started=deferred();let calls=0;
  const store=createMeasurementStore({token:()=> 'token',fetcher:async()=>{calls++;started.resolve();await wait.promise;return response({...record,revision:1});}});
  const saving=store.save(record),queued=store.save({...record,id:'other'});
  const rejected=Promise.all([assert.rejects(saving),assert.rejects(queued)]);
  await started.promise;assert.equal(store.records.size,1);store.invalidate();
  assert.equal(store.records.size,0);assert.equal(store.statuses.size,0);assert.equal(store.isInvalidated(),true);
  wait.resolve();await rejected;assert.equal(calls,1);assert.equal(store.records.size,0);assert.equal(store.statuses.size,0);
  await assert.rejects(store.save(record),/access changed/);
});
test('new explicit reload does not wait for old identity fetch and ignores late JSON',async()=>{
  const json=deferred(),started=deferred();let credential='first';
  const store=createMeasurementStore({token:()=>credential,fetcher:async(_url,options)=>{
    if(options.headers.Authorization==='Bearer first'){started.resolve();return{ok:true,status:200,json:()=>json.promise};}
    return{ok:true,status:200,json:async()=>({measurements:[],capabilities:{personalPersistence:true}})};
  }});
  const loading=store.load(),rejected=assert.rejects(loading);await started.promise;store.invalidate();credential='second';
  await store.load();assert.equal(store.isInvalidated(),false);json.resolve({measurements:[record],capabilities:{personalPersistence:true}});
  await rejected;assert.equal(store.records.size,0);
});
test('401 and 403 responses clear private data and require explicit reload',async()=>{
  for(const status of [401,403]){
    let denied=false;const store=createMeasurementStore({token:()=> 'token',fetcher:async()=>denied?{ok:false,status,json:async()=>({error:'denied'})}:response({...record,revision:1})});
    await store.save(record);denied=true;await assert.rejects(store.save({...store.records.get(record.id),name:'Other'}),/access changed/);
    assert.equal(store.records.size,0);assert.equal(store.statuses.size,0);assert.equal(store.isInvalidated(),true);
  }
});
test('only current 401 can checkpoint before clearing; 403 and obsolete access never checkpoint',async()=>{
  for(const [status,obsolete]of [[401,false],[403,false],[401,true]]){
    let denied=false,access=0,calls=0,checkpointSize=0;const store=createMeasurementStore({token:()=> 'token',accessGeneration:()=>access,beforeUnauthorized:()=>{calls++;checkpointSize=store.records.size;assert.equal(store.isInvalidated(),false);},fetcher:async()=>{if(!denied)return response({...record,revision:1});if(obsolete)access++;return{ok:false,status};}});await store.save(record);denied=true;await assert.rejects(store.patch(store.records.get(record.id),{name:'Other'}));assert.equal(calls,status===401&&!obsolete?1:0);if(calls)assert.equal(checkpointSize,1);assert.equal(store.isInvalidated(),!obsolete);
  }
});
test('lost signed-in token cannot turn persisted records into public temporary records',async()=>{
  let credential='token';const store=createMeasurementStore({token:()=>credential,fetcher:async()=>response({...record,revision:1})});
  await store.save(record);credential=null;
  await assert.rejects(store.save({...store.records.get(record.id),name:'Lost token'}),/access changed/);
  assert.equal(store.records.size,0);await assert.rejects(store.load(),/access changed/);assert.equal(store.isInvalidated(),true);
});
test('late delete completion cannot remove replacement identity record',async()=>{
  const wait=deferred(),started=deferred();let credential='first';
  const store=createMeasurementStore({token:()=>credential,fetcher:async(_url,options)=>{
    if(options.method==='DELETE'){started.resolve();await wait.promise;return{ok:true,status:204};}
    if(options.method==='GET')return{ok:true,status:200,json:async()=>({measurements:[{...record,name:'Second identity',revision:2}],capabilities:{personalPersistence:true}})};
    return response({...record,revision:1});
  }});
  await store.save(record);const removing=store.remove(record.id),rejected=assert.rejects(removing);await started.promise;
  store.invalidate();credential='second';await store.load();wait.resolve();await rejected;
  assert.equal(store.records.get(record.id).name,'Second identity');assert.equal(store.statuses.get(record.id),'Saved');
});
