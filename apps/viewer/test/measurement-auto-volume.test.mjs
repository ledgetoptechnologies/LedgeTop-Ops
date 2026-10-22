import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {measurementMetrics,validateMeasurementGeometry} from '../measurement-document.mjs';
import {createServerProfileCalculator} from '../measurement-server-profile.mjs';

const source=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
const shipped=source.slice(source.indexOf('  function showSurface('),source.indexOf('  function setTool('));
function fixture({kind='polygon',saveWait=Promise.resolve(),attachmentWait=Promise.resolve(),saveError=null,adminAllowed=false,specialistAllowed=false,serverError=null,preferServer=false}={}){
  const record={id:'auto-volume-fixture',name:'Test boundary',kind,collection:'spatial3d',vertices:kind==='polygon'?[[0,0,0],[10,0,0],[10,10,0],[0,10,0]]:[[0,0,0],[10,0,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
  const opened=[],messages=[],records=new Map(),attachments=[],serverCalls=[],specialistOpened=[];
  const scope=vm.createContext({draft:record,editing:false,editBaseline:null,selected:null,units:'metric',savedUnits:{metric:'m'},viewGeneration:0,dialogGeneration:0,disposed:false,permitted:true,mode:'model',activeDialog:null,structuredClone,
    measurementMetrics,validateMeasurementGeometry,createServerProfileCalculator,capabilitiesReady:Promise.resolve(),
    adminAllowed,specialistAllowed,surfaceRequest:undefined,preferServerSurface:()=>preferServer,adminRequest:async()=>({}),createServerSurfaceCalculator:options=>async(...args)=>{serverCalls.push({options,args,snapshot:options.getRecord()});if(serverError)throw serverError;return{cutM3:20,fillM3:0,calculationJobId:'server-job'};},
    openAdminCalculationDialog:async options=>{if(!options.isCurrent())throw new Error('Measurement access changed.');specialistOpened.push(options);return{close(){}};},
    store:{records,persistent:()=>false,async save(r){await saveWait;if(saveError)throw saveError;records.set(r.id,{...structuredClone(r),revision:1});},async attachResults(r,results){attachments.push({r,results});await attachmentWait;records.set(r.id,{...structuredClone(r),results,revision:r.revision+1});}},
    openSurfaceDialog:options=>{opened.push(options);return{close(){}};},
    calculateSurface:async()=>({cutM3:10,fillM3:0}),
    tell:text=>messages.push(text)});
  vm.runInContext('function allowed(){return permitted;} function context(){return {mode};} function draftRecord(){return structuredClone(draft);} function disarm(){draft=null;} function closeDialogs(){dialogGeneration++;activeDialog?.close();activeDialog=null;}'+shipped,scope);
  return{scope,opened,messages,records,attachments,serverCalls,specialistOpened,finish:(options={openVolume:true})=>scope.finish(options)};
}

test('one inspector exposes specialist methods only with verified staff and registered-method capability',async()=>{
  for(const [adminAllowed,specialistAllowed]of [[false,false],[false,true],[true,false],[true,true]]){
    const f=fixture({adminAllowed,specialistAllowed});await f.finish();
    assert.equal(typeof f.opened[0].openSpecialist==='function',adminAllowed&&specialistAllowed);
    assert.equal(f.specialistOpened.length,0,'auto-on-finish never opens specialist methods');
  }
  assert.doesNotMatch(source,/data-m="admin-volume"/);assert.match(source,/data-m="volume">\$\{[^\n]+\?'View volume':[^\n]+\?'Recalculate volume':'Calculate volume'\}/);
});

test('surface and specialist attachments share the freshest saved revision in either direction',async()=>{
  const f=fixture({adminAllowed:true,specialistAllowed:true});await f.finish();const inspector=f.opened[0];
  await inspector.save({...inspector.record,results:{cutM3:1}});
  await inspector.openSpecialist({host:{},isCurrent:()=>true});const specialist=f.specialistOpened[0];
  assert.equal(specialist.record.revision,2);
  await specialist.onResult({calculation:{id:'mesh-job',result:{method:'closed-mesh',volumeM3:2}}});
  await inspector.calculate(inspector.record,{});assert.equal(f.serverCalls[0].snapshot.revision,3);
  assert.equal(inspector.getRecord().results.calculationJobId,'mesh-job');
});

test('closed specialist panel or revoked view cannot attach a late specialist result',async()=>{
  for(const revoke of ['panel','view','staff']){
    const f=fixture({adminAllowed:true,specialistAllowed:true});await f.finish();let panel=true;
    await f.opened[0].openSpecialist({host:{},isCurrent:()=>panel});
    if(revoke==='panel')panel=false;else if(revoke==='view')f.scope.viewGeneration++;else f.scope.adminAllowed=false;
    await assert.rejects(f.specialistOpened[0].onResult({calculation:{id:'late',result:{volumeM3:8}}}),/access changed/);
    assert.equal(f.attachments.length,0);
  }
});

test('specialist attachment finishing after collapse updates parent revision before native calculation resumes',async()=>{
  let release;const f=fixture({adminAllowed:true,specialistAllowed:true,attachmentWait:new Promise(resolve=>{release=resolve;})});await f.finish();let panel=true;
  const inspector=f.opened[0];await inspector.openSpecialist({host:{},isCurrent:()=>panel});
  const attachment=f.specialistOpened[0].onResult({calculation:{id:'mesh-job',result:{method:'closed-mesh',volumeM3:2}}});
  const rejected=assert.rejects(attachment,/access changed/);panel=false;
  const resumed=inspector.calculate(inspector.record,{});assert.equal(f.serverCalls.length,0,'native calculation waits for outstanding attachment');
  release();await rejected;await resumed;
  assert.equal(inspector.getRecord().revision,2);assert.equal(f.serverCalls[0].snapshot.revision,2);
});

test('authorized staff use the server calculator in the normal polygon inspector',async()=>{
  const f=fixture({adminAllowed:true});await f.finish();const dialog=f.opened[0];
  assert.equal(dialog.execution,'server');assert.equal(dialog.autoCalculate,false);
  const result=await dialog.calculate(dialog.record,{});
  assert.equal(result.calculationJobId,'server-job');assert.equal(f.serverCalls.length,1);
  assert.equal(f.serverCalls[0].snapshot.id,dialog.record.id);
});

test('declared-unit point profiles select verified staff transport without elevating ordinary profiles',async()=>{
  for(const [adminAllowed,basis] of [[true,'administrator-declared'],[false,'administrator-declared'],[true,'ept-vertical-crs']]){
    const f=fixture({adminAllowed,preferServer:true}),ordinary=async()=>({}),staff=async()=>({});let options;
    f.scope.surfaceRequest=ordinary;f.scope.adminRequest=staff;
    f.scope.createServerProfileCalculator=value=>{options=value;return async()=>({profile:true});};
    await f.finish();const inspector=f.opened[0];
    await inspector.save({...inspector.record,results:{method:'point-surface-cut-fill',calculationJobId:'saved-parent',source:{verticalUnitBasis:basis}}});
    const before=JSON.stringify(inspector.getRecord());await inspector.calculateProfile(inspector.record,{});
    const elevated=adminAllowed&&basis==='administrator-declared';
    assert.equal(options.request,elevated?staff:ordinary);
    assert.equal(JSON.stringify(inspector.getRecord()),before,'viewing profile does not recalculate or mutate volume');
    assert.equal(f.serverCalls.length,0);
    assert.equal(options.isCurrent(),true);f.scope.adminAllowed=false;
    assert.equal(options.isCurrent(),!elevated,'staff transport fails closed if verified capability is lost');
  }
});

test('ordinary profile failures are never retried through staff transport',async()=>{
  const f=fixture({adminAllowed:true,preferServer:true});let staffCalls=0,ordinaryCalls=0;
  f.scope.adminRequest=async()=>{staffCalls++;return{};};
  f.scope.surfaceRequest=async()=>{ordinaryCalls++;throw Object.assign(new Error('not found'),{code:'measurement_calculation_not_found'});};
  await f.finish();const inspector=f.opened[0];
  await inspector.save({...inspector.record,results:{method:'point-surface-cut-fill',calculationJobId:'saved-parent',source:{verticalUnitBasis:'ept-vertical-crs'}}});
  await assert.rejects(inspector.calculateProfile(inspector.record,{}),/could not be accessed/);
  assert.equal(ordinaryCalls,1);assert.equal(staffCalls,0);
});
test('saved declared point profile waits for verified capability before choosing transport',async()=>{
  const f=fixture({preferServer:true});let release,chosen,calls=0;f.scope.capabilitiesReady=new Promise(resolve=>{release=resolve;});const staff=async()=>({}),ordinary=async()=>({});f.scope.adminRequest=staff;f.scope.surfaceRequest=ordinary;f.scope.createServerProfileCalculator=options=>{chosen=options.request;calls++;return async()=>({});};await f.finish();const inspector=f.opened[0];await inspector.save({...inspector.record,results:{method:'point-surface-cut-fill',calculationJobId:'saved-parent',source:{verticalUnitBasis:'administrator-declared'}}});const pending=inspector.calculateProfile(inspector.record,{});await Promise.resolve();assert.equal(calls,0);f.scope.adminAllowed=true;release();await pending;assert.equal(chosen,staff);assert.equal(calls,1);
});
test('historical recovery accepts only same-measurement version-bound complete old volume jobs',async()=>{
  const f=fixture({preferServer:true});await f.finish();const inspector=f.opened[0];inspector.getRecord().modelVersionId='version';inspector.getRecord().revision=5;const id=inspector.record.id;
  const valid={id:'old',measurementId:id,revision:2,status:'complete',method:'surface-cut-fill',result:{method:'surface-cut-fill',netM3:42,source:{modelVersionId:'version'}}};
  f.scope.surfaceRequest=async()=>({calculations:[{...valid,measurementId:'other',revision:4},{...valid,revision:99},{...valid,result:{...valid.result,source:{modelVersionId:'other'}}},valid]});
  const history=await inspector.loadPreviousVolume();assert.equal(history.netM3,42);assert.equal(history.status,'historical');assert.equal(history.calculationJobId,undefined);assert.equal(f.attachments.length,0);assert.equal(f.serverCalls.length,0);
  f.scope.viewGeneration++;await assert.rejects(inspector.loadPreviousVolume(),/access or view changed/);
});

test('isolated fixture may inject browser calculation, but a selected server never falls back',async()=>{
  const ordinary=fixture();await ordinary.finish();assert.equal(ordinary.opened[0].execution,'browser');
  await ordinary.opened[0].calculate(ordinary.opened[0].record,{});assert.equal(ordinary.serverCalls.length,0);
  const staff=fixture({adminAllowed:true,serverError:new Error('Server units unavailable')});await staff.finish();
  await assert.rejects(staff.opened[0].calculate(staff.opened[0].record,{}),/Server units unavailable/);
});

test('staff intent cannot silently fall back while capabilities are pending or failed',async()=>{
  const f=fixture({preferServer:true,adminAllowed:false,serverError:new Error('Server permission unavailable')});await f.finish();
  assert.equal(f.opened[0].execution,'server');
  await assert.rejects(f.opened[0].calculate(f.opened[0].record,{}),/Server permission unavailable/);
});

test('client personal surface transport uses server without advanced staff capability',async()=>{
  const f=fixture();f.scope.surfaceRequest=async()=>({});await f.finish();
  assert.equal(f.opened[0].execution,'server');await f.opened[0].calculate(f.opened[0].record,{});
  assert.equal(f.serverCalls[0].options.request,f.scope.surfaceRequest);
});
test('explicit inspector request saves geometry first without automatically calculating',async()=>{
  const f=fixture();await f.finish();assert.equal(f.records.size,1);assert.equal(f.opened.length,1);assert.equal(f.opened[0].autoCalculate,false);
  assert.equal(f.opened[0].record.results.status,'geometry-only');assert.equal(f.opened[0].record.results.horizontalAreaM2,100);
  await f.finish();assert.equal(f.opened.length,1);
});
test('default polygon finish saves area immediately without opening or starting volume',async()=>{
  const f=fixture();await f.scope.finish();
  assert.equal(f.records.size,1);assert.equal(f.opened.length,0);assert.equal(f.serverCalls.length,0);
  assert.equal(f.records.values().next().value.results.horizontalAreaM2,100);
  assert.equal(f.records.values().next().value.results.status,'geometry-only');
});

test('edit finish preserves unchanged volume or invalidates changed geometry without automatically calculating',async()=>{
  for(const changed of [false,true]){
    const f=fixture(),saved={status:'calculated',method:'surface-cut-fill',cutM3:12,fillM3:0,netM3:12};
    f.scope.editing=true;f.scope.editBaseline=JSON.stringify(f.scope.draft.vertices);f.scope.draft.results=structuredClone(saved);
    const original=structuredClone(f.scope.draft);f.records.set(original.id,original);
    let saves=0;const save=f.scope.store.save;f.scope.store.save=async record=>{saves++;return save(record);};
    if(changed)f.scope.draft.vertices[0][0]=1;
    await f.scope.finish();const result=f.records.values().next().value.results;
    assert.equal(saves,changed?1:0,'unchanged edit does not write a new revision');
    if(!changed)assert.equal(f.records.get(original.id),original);
    if(changed){assert.equal(result.status,'geometry-only');assert.equal(result.volumeInvalidated,true);assert.equal(result.cutM3,undefined);}else assert.deepEqual(result,saved);
    assert.equal(f.opened.length,0);assert.equal(f.serverCalls.length,0);
  }
});

test('distance and mode-switch completion never open automatic volume',async()=>{
  for(const f of [fixture({kind:'distance'}),fixture()]){await f.finish({openVolume:false});assert.equal(f.records.size,1);assert.equal(f.opened.length,0);}
  const distance=fixture({kind:'distance'});await distance.finish();assert.equal(distance.opened.length,0);
});
test('failed geometry save never calculates or claims the polygon was saved',async()=>{
  const f=fixture({saveError:new Error('Save conflict')});await f.finish();assert.equal(f.opened.length,0);assert.equal(f.records.size,0);assert.deepEqual(f.messages,['Save conflict']);
});
test('late geometry save cannot open a dialog after view, permission, intent or lifecycle changes',async()=>{
  for(const change of [s=>s.viewGeneration++,s=>s.dialogGeneration++,s=>s.permitted=false,s=>s.disposed=true,s=>s.mode='ortho',s=>s.selected='different',s=>s.draft={}]){
    let release;const f=fixture({saveWait:new Promise(resolve=>{release=resolve;})});const pending=f.finish();change(f.scope);release();await pending;assert.equal(f.opened.length,0);
  }
});
test('access loss before finish does not save geometry',async()=>{
  const f=fixture();f.scope.permitted=false;await f.finish();assert.equal(f.records.size,0);assert.equal(f.opened.length,0);
});
test('dialog callbacks are fenced against closing, view switches and revoked access',async()=>{
  for(const change of [s=>s.viewGeneration++,s=>s.dialogGeneration++,s=>s.permitted=false,s=>s.disposed=true]){
    const f=fixture();await f.finish();const dialog=f.opened[0];change(f.scope);
    await assert.rejects(dialog.calculate(dialog.record,{}),/access or view changed/);
    await assert.rejects(dialog.save({...dialog.record,results:{cutM3:1}}),/access or view changed/);
    assert.equal(f.attachments.length,0);
  }
});
