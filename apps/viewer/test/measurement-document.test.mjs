import test from 'node:test';
import assert from 'node:assert/strict';
import {measurementCollection,measurementMetrics,measurementValue,validateMeasurementGeometry,exportMeasurements} from '../measurement-document.mjs';
import {createMeasurementStore} from '../measurement-store.mjs';
const polygon={id:'0e439915-bcda-4c90-852a-9e0a7f48c7ce',name:'North face',collection:'spatial3d',kind:'polygon',coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},vertices:[[500000,4800000,2],[500010,4800000,2],[500010,4800010,2],[500000,4800010,2]],visible:true,source:{kind:'mesh'}};
test('renderer groups share coordinates without conflating map and model collections',()=>{assert.equal(measurementCollection('model'),measurementCollection('cloud'));assert.equal(measurementCollection('dsm'),measurementCollection('ortho'));assert.notEqual(measurementCollection('dtm'),measurementCollection('model'));});
test('full precision areas, vertical planes and nonplanarity are explicit',()=>{const m=validateMeasurementGeometry(polygon);assert.equal(m.horizontalAreaM2,100);assert.equal(m.planarAreaM2,100);assert.equal(m.lengthM,40);const wall={...polygon,vertices:[[0,0,0],[0,10,0],[0,10,10],[0,0,10]]};assert.equal(validateMeasurementGeometry(wall).planarAreaM2,100);assert.equal(measurementMetrics(wall).horizontalAreaM2,0);assert.equal(measurementMetrics({...polygon,vertices:[[0,0,0],[10,0,0],[10,10,1],[0,10,0]]}).planarAreaM2,null);});
test('invalid geometry rejected instead of plausible quantities',()=>{assert.throws(()=>validateMeasurementGeometry({...polygon,vertices:[[0,0,0],[1,1,0],[0,1,0],[1,0,0]]}));assert.throws(()=>validateMeasurementGeometry({...polygon,vertices:[[0,0,0],[1,0,0],[1,0,0]]}));});
test('three decimals are display only, ft3 is default and unit systems are explicit',()=>{assert.equal(measurementValue(0.3048**3,3),'1.000 ft³');assert.equal(measurementValue(0.3048**2,2),'1.000 ft²');assert.equal(measurementValue(1.234567,2,'metric'),'1.235 m²');assert.equal(measurementValue(0.9144,1,'yards'),'1.000 yd');assert.equal(measurementValue(0.3048,1),'1′ 0.000″');});
test('human quantities group thousands and millions without changing machine-readable precision',()=>{assert.equal(measurementValue(26122.202123,2,'metric'),'26,122.202 m²');assert.equal(measurementValue(1234567.890123,3,'metric'),'1,234,567.890 m³');assert.equal(measurementValue(1000*0.3048,1),'1,000′ 0.000″');const result=JSON.parse(exportMeasurements([{...polygon,results:{cutM3:26122.202123}}],'json'));assert.equal(result.measurements[0].results.cutM3,26122.202123);assert.match(exportMeasurements([{...polygon,results:{cutM3:26122.202123}}],'csv'),/26122\.202123/);});
test('exports preserve source data, neutralize formula labels, use DXF metres and geographic XY',()=>{const r={...polygon,name:'=SUM(A1)'};assert.match(exportMeasurements([r],'csv'),/'=SUM/);assert.equal(JSON.parse(exportMeasurements([r],'json')).measurements[0].vertices[0][0],500000);assert.match(exportMeasurements([r],'dxf'),/\$INSUNITS\r\n70\r\n6/);assert.throws(()=>exportMeasurements([r],'geojson'));const geo=JSON.parse(exportMeasurements([r],'geojson',{toLonLat:()=>[-87,43]}));assert.equal(geo.features[0].geometry.coordinates[0].length,5);assert.deepEqual(geo.features[0].geometry.coordinates[0][0],[-87,43]);});
test('public documents stay memory-only and new page has no documents',async()=>{let calls=0;const store=createMeasurementStore({token:()=>null,fetcher:()=>calls++});await store.load();await store.save(polygon);assert.equal(store.records.size,1);assert.equal(calls,0);assert.equal(createMeasurementStore({token:()=>null}).records.size,0);});
test('private writes use fresh credentials and accepted revisions',async()=>{let credential='first',revision=0;const requests=[];const store=createMeasurementStore({token:()=>credential,fetcher:async(url,options)=>{requests.push(options);return {ok:true,json:async()=>({measurement:{...JSON.parse(options.body),revision:++revision}})}}});await store.save(polygon);credential='renewed';await store.save({...store.records.get(polygon.id),name:'Changed'});assert.equal(requests[1].headers.Authorization,'Bearer renewed');assert.equal(JSON.parse(requests[1].body).revision,1);assert.equal(requests[1].method,'PUT');assert.equal(store.records.get(polygon.id).revision,2);});
test('conflict retains unsaved draft with explicit status, never silently overwrites',async()=>{let fail=false;const store=createMeasurementStore({token:()=> 'token',fetcher:async()=>({ok:!fail,status:fail?409:200,json:async()=>({measurement:{...polygon,revision:1}})})});await store.save(polygon);fail=true;await assert.rejects(store.save({...store.records.get(polygon.id),name:'Unsaved'}),/another tab/);assert.match(store.statuses.get(polygon.id),/Not saved/);assert.equal(store.records.get(polygon.id).name,'Unsaved');});

test('reload shares the write queue so a save during delayed reads is not erased',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});const requests=[];
  const store=createMeasurementStore({token:()=> 'token',fetcher:async(_url,options)=>{
    requests.push(options.method);
    if(options.method==='GET'){await gate;return{ok:true,json:async()=>({measurements:[],capabilities:{personalPersistence:true}})};}
    return{ok:true,json:async()=>({measurement:{...JSON.parse(options.body),revision:1}})};
  }});
  const loaded=store.load();await Promise.resolve();const saved=store.save(polygon);
  assert.deepEqual(requests,['GET','GET']);release();await Promise.all([loaded,saved]);
  assert.equal(store.records.get(polygon.id).name,polygon.name);assert.equal(store.statuses.get(polygon.id),'Saved');
  assert.deepEqual(requests,['GET','GET','POST']);
});

test('stale local revisions cannot overwrite newer edits in the same tab',async()=>{
  let revision=0,calls=0;const store=createMeasurementStore({token:()=> 'token',fetcher:async(_url,options)=>{calls++;return{ok:true,json:async()=>({measurement:{...JSON.parse(options.body),revision:++revision}})};}});
  await store.save(polygon);const snapshot=structuredClone(store.records.get(polygon.id));
  await store.save({...snapshot,name:'New name'});
  await assert.rejects(store.save({...snapshot,visible:false}),/changed or was deleted/);
  assert.equal(calls,2);assert.equal(store.records.get(polygon.id).name,'New name');assert.equal(store.records.get(polygon.id).visible,true);
});

test('DELETE 204 removes the record and status without trying to decode JSON',async()=>{
  const store=createMeasurementStore({token:()=> 'token',fetcher:async(_url,options)=>options.method==='DELETE'?{ok:true,status:204,json:()=>{throw new Error('204 has no JSON');}}:{ok:true,json:async()=>({measurement:{...JSON.parse(options.body),revision:1}})}});
  await store.save(polygon);await store.remove(polygon.id);
  assert.equal(store.records.has(polygon.id),false);assert.equal(store.statuses.has(polygon.id),false);
  await assert.rejects(store.save(polygon),/changed or was deleted/);
});

test('results attach only to unchanged geometry and revision, never resurrect deleted measurements',async()=>{
  let revision=0;const store=createMeasurementStore({token:()=> 'token',fetcher:async(_url,options)=>options.method==='DELETE'?{ok:true,status:204}:{ok:true,json:async()=>({measurement:{...JSON.parse(options.body),revision:++revision}})}});
  await store.save(polygon);const snapshot=structuredClone(store.records.get(polygon.id));
  await store.attachResults(snapshot,{cutM3:10,status:'complete'});assert.equal(store.records.get(polygon.id).results.cutM3,10);
  await assert.rejects(store.attachResults(snapshot,{cutM3:999}),/changed or was deleted/);
  const latest=structuredClone(store.records.get(polygon.id));await store.remove(polygon.id);
  await assert.rejects(store.attachResults(latest,{cutM3:999}),/changed or was deleted/);assert.equal(store.records.has(polygon.id),false);
});

test('temporary result attachment merges only results and guards changed source geometry',async()=>{
  const store=createMeasurementStore({token:()=>null});await store.save(polygon);
  const snapshot=structuredClone(store.records.get(polygon.id));await store.save({...snapshot,name:'Temporary renamed',visible:false});
  await store.attachResults(snapshot,{cutM3:10});assert.equal(store.records.get(polygon.id).name,'Temporary renamed');assert.equal(store.records.get(polygon.id).visible,false);
  const changed=structuredClone(store.records.get(polygon.id));changed.vertices[1][0]+=1;await store.save(changed);
  await assert.rejects(store.attachResults(snapshot,{cutM3:99}),/changed or was deleted/);
  const current=structuredClone(store.records.get(polygon.id));const deleting=store.remove(polygon.id);
  await assert.rejects(store.attachResults(current,{cutM3:99}),/changed or was deleted/);await deleting;assert.equal(store.records.size,0);
});
