import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {measurementValue} from '../measurement-document.mjs';
import {buildSampledCrossSection,nearestSectionSample,initialSectionOffsetPercent} from '../measurement-cross-section.mjs';
import {createServerSurfaceCalculator} from '../measurement-server-surface.mjs';

const source=readFileSync(new URL('../measurement-volume-dialog.mjs',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture(calculate,{autoCalculate=false,record={name:'Pile A'},execution='browser',openSpecialist=null,getRecord=()=>record,loadPreviousVolume=null}={}){
  const nodes=new Map(),notices=[];let disposed=0,saved=0;
  const element=()=>({dataset:{},hidden:false,disabled:false,value:'0',checked:false,textContent:'',width:850,height:380,attributes:{},append(){},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];},getContext:()=>new Proxy({},{get:()=>()=>{},set:()=>true})});
  const dialog={...element(),querySelector(s){if(!nodes.has(s)){const node=element();if(s==='[name=sectionWidth]')node.value='10';nodes.set(s,node);}return nodes.get(s);},showModal(){this.open=true;},close(){this.open=false;this.onclose?.();},remove(){this.removed=true;}};
  const scope=vm.createContext({document:{createElement:tag=>tag==='dialog'?dialog:{...element(),remove(){this.removed=true;}},body:{append(node){if(node.className==='measurement-job-notice')notices.push(node);}}},setTimeout,clearTimeout,AbortController,structuredClone,measurementValue,buildSampledCrossSection,nearestSectionSample,initialSectionOffsetPercent,mountMeasurementRegionPreview:()=>({dispose(){disposed++;}})});
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function openSurfaceDialog','function openSurfaceDialog'),scope);
  const handle=scope.openSurfaceDialog({record,units:'metric',calculate,save:async()=>{saved++;},autoCalculate,execution,openSpecialist,getRecord,loadPreviousVolume});
  if(!record.results){dialog.querySelector('[name=reference]').value='boundary-triangulated';if(execution!=='server')dialog.querySelector('[name=source]').value='dsm';}
  return{dialog,handle,notices,saved:()=>saved,disposed:()=>disposed,calculate:()=>dialog.querySelector('[data-calculate]').onclick()};
}
const result={status:'calculated',cutM3:12345.678912,fillM3:0,netM3:12345.678912,coverage:1,preview:{samples:[[0,0,2,0],[1,1,2,0]]}};
test('changed outline displays prior volume separately without current totals or automatic calculation',()=>{
  let calls=0;const previousVolume={status:'historical',unit:'m3',netM3:1234.5,cutM3:1300,fillM3:65.5,revision:3,recordedAt:'2026-09-27T12:00:00Z'},f=fixture(()=>{calls++;return result;},{record:{name:'Edited pile',results:{status:'geometry-only',volumeInvalidated:true,previousVolume}}});
  assert.equal(calls,0);assert.equal(f.saved(),0);assert.equal(f.dialog.querySelector('[data-previous-volume]').hidden,false);assert.match(f.dialog.querySelector('[data-previous-values]').textContent,/Net volume: 1,234\.500 m³.*Saved revision 3/);assert.match(f.dialog.innerHTML,/Previous outline — not current/);assert.equal(f.dialog.querySelector('[data-calculate]').hidden,false);assert.equal(f.dialog.querySelector('[data-result=net]').textContent,'');f.handle.close();
});
test('legacy historical recovery is read-only and late replies cannot replace newer calculation or closed inspector',async()=>{
  for(const action of ['show','close','calculate']){const waiting=deferred();let reads=0,calls=0;const f=fixture(()=>{calls++;return result;},{record:{name:'Edited pile',results:{status:'geometry-only',volumeInvalidated:true}},loadPreviousVolume:()=>{reads++;return waiting.promise;}});await Promise.resolve();assert.equal(reads,1);
    if(action==='close')f.handle.close();if(action==='calculate')await f.calculate();waiting.resolve({status:'historical',unit:'m3',netM3:999});for(let i=0;i<5;i++)await Promise.resolve();assert.equal(f.dialog.querySelector('[data-previous-volume]').hidden,action!=='show');assert.equal(calls,action==='calculate'?1:0);if(action!=='close')f.handle.close();
  }
});

test('client inspector has no specialist controls and keeps one native calculation action',()=>{
  const f=fixture(()=>result);
  assert.match(f.dialog.innerHTML,/<h2>Calculate volume<\/h2>/);
  assert.doesNotMatch(f.dialog.innerHTML,/surface-specialist|data-specialist-host/);
  assert.doesNotMatch(f.dialog.innerHTML,/name="metres"|I confirm source elevations/);
  assert.match(f.dialog.innerHTML,/value="boundary-triangulated">Ground from boundary/);
  assert.match(f.dialog.innerHTML,/<details class="surface-settings" hidden>/);
  assert.equal(f.dialog.querySelector('[name=source]').disabled,true);
  assert.equal(f.dialog.querySelector('[name=reference]').disabled,true);
  f.handle.close();
});

test('opening specialist methods retires native observation without starting another calculation',async()=>{
  const wait=deferred();let signal,calls=0,closed=0;
  const f=fixture((_r,o)=>{calls++;signal=o.signal;return wait.promise;},{openSpecialist:async({onOpened})=>{const handle={close(){closed++;}};onOpened(handle);return handle;}});
  const native=f.calculate(),disclosure=f.dialog.querySelector('.surface-specialist');
  disclosure.open=true;await disclosure.ontoggle();
  assert.equal(signal.aborted,true);assert.equal(calls,1);assert.equal(f.dialog.querySelector('[data-surface-content]').hidden,true);
  await f.calculate();assert.equal(calls,1,'native action cannot run behind specialist settings');
  wait.resolve(result);await native;assert.equal(f.saved(),0);
  disclosure.open=false;await disclosure.ontoggle();assert.equal(closed,1);assert.equal(f.dialog.querySelector('[data-surface-content]').hidden,false);
  f.handle.close();
});

test('late specialist access response after close or method collapse cannot revive its panel',async()=>{
  for(const closing of [true,false]){
    const wait=deferred();let closed=0,current;
    const f=fixture(()=>result,{openSpecialist:({isCurrent})=>{current=isCurrent;return wait.promise;}});
    const disclosure=f.dialog.querySelector('.surface-specialist');disclosure.open=true;const opening=disclosure.ontoggle();
    if(closing)f.handle.close();else{disclosure.open=false;await disclosure.ontoggle();}
    assert.equal(current(),false);wait.resolve({close(){closed++;}});await opening;assert.equal(closed,1);
    if(!closing)f.handle.close();
  }
});

test('returning from specialist uses the latest attached snapshot without fabricating surface results',async()=>{
  let savedRecord={name:'Pile A'},closed=0;
  const f=fixture(()=>result,{getRecord:()=>savedRecord,openSpecialist:async()=>({close(){closed++;}})});
  const disclosure=f.dialog.querySelector('.surface-specialist');disclosure.open=true;await disclosure.ontoggle();
  savedRecord={...savedRecord,revision:3,results:{method:'closed-mesh',status:'validated',volumeM3:4}};
  disclosure.open=false;await disclosure.ontoggle();assert.equal(closed,1);
  assert.match(f.dialog.querySelector('[data-status]').textContent,/Previously saved object volume: 4\.000 m³.*different calculation/);
  assert.equal(f.saved(),0);f.handle.close();
});

test('server inspector uses one explicit action and shows guarded server progress in the same preview UI',async()=>{
  const wait=deferred();let progress,calls=0;const f=fixture((_record,options)=>{calls++;progress=options.onProgress;return wait.promise;},{execution:'server'});
  assert.equal(calls,0);assert.equal(f.dialog.querySelector('[data-calculate]').textContent,'Calculate volume');
  const pending=f.calculate();progress('Queued on your server.');assert.equal(f.dialog.querySelector('[data-status]').textContent,'Queued on your server.');
  f.handle.close();progress('Private result');assert.equal(f.dialog.querySelector('[data-status]').textContent,'Queued on your server.');wait.resolve(result);await pending;assert.equal(f.saved(),0);
});

test('surface dialog explains initial empty state and centers responsively without showing a blank preview',()=>{
  const f=fixture(()=>result);assert.match(f.dialog.innerHTML,/No volume has been calculated yet/);assert.match(f.dialog.innerHTML,/data-preview-content hidden/);assert.match(f.dialog.innerHTML,/your outline and horizontal area remain available/);
  const css=readFileSync(new URL('../measurement-workspace.css',import.meta.url),'utf8');assert.match(css,/position:fixed;inset:0;margin:auto/);assert.match(css,/max-height:calc\(100dvh - 24px\)/);f.handle.close();
});

test('calculation disables duplicate submission, then shows grouped quantities and valid preview',async()=>{
  const wait=deferred(),f=fixture(()=>wait.promise),pending=f.calculate();assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'loading');assert.equal(f.dialog.querySelector('[data-calculate]').disabled,true);assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,true);
  wait.resolve(result);await pending;assert.equal(f.saved(),1);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'success');assert.match(f.dialog.querySelector('[data-status]').textContent,/12,345\.679 m³/);assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,false);assert.equal(f.dialog.querySelector('[data-calculate]').disabled,false);
  assert.equal(f.disposed(),0);const disclosure=f.dialog.querySelector('.region-disclosure');disclosure.open=true;disclosure.ontoggle();f.handle.close();assert.equal(f.disposed(),1);
});

test('source rejection clears an earlier preview and never presents a stale result as the new volume',async()=>{
  let calls=0;const f=fixture(async()=>{if(calls++)throw new Error('Source vertical units required.');return result;});await f.calculate();const disclosure=f.dialog.querySelector('.region-disclosure');disclosure.open=true;disclosure.ontoggle();await f.calculate();
  assert.equal(f.saved(),1);assert.equal(f.disposed(),1);assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,true);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'error');assert.match(f.dialog.querySelector('[data-status]').textContent,/No new volume was saved.*Source vertical units required/);assert.match(f.dialog.querySelector('[data-preview-empty]').textContent,/Preview unavailable/);f.handle.close();
});

test('standard calculation cannot declare missing elevation units and surfaces required metadata',async()=>{
  let settings;const f=fixture(async(_record,options)=>{settings=options;throw new Error('Source vertical units required.');},{autoCalculate:true});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settings.confirmMeters,false);assert.equal(f.saved(),0);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'error');assert.equal(f.dialog.querySelector('.surface-settings').open,true);f.handle.close();
});

test('new client stockpile delegates source selection even when drawn on terrain',async()=>{
  let settings;const f=fixture(async(_record,options)=>{settings=options;return result;},{record:{name:'Terrain outline',source:{kind:'dtm'}},autoCalculate:true});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(settings.sourceKind,'auto');assert.equal(settings.confirmMeters,false);f.handle.close();
});

test('server inspector delegates a consistent automatic source for every new viewing-mode outline',async()=>{
  for(const kind of ['mesh','pointCloud','ortho','dsm','dtm']){
    let settings;const f=fixture(async(_record,options)=>{settings=options;return result;},{execution:'server',record:{name:'New outline',source:{kind}}});
    await f.calculate();assert.equal(settings.sourceKind,'auto');assert.equal(settings.confirmMeters,false);f.handle.close();
  }
});

test('client recalculation preserves an explicitly saved terrain source and custom base',async()=>{
  let settings;const f=fixture(async(_record,options)=>{settings=options;return result;},{record:{name:'Saved terrain',results:{...result,sourceKind:'dtm',reference:{type:'custom',elevationM:100,offsetM:2}}}});
  assert.equal(f.dialog.querySelector('.surface-settings').open,false);assert.doesNotMatch(f.dialog.querySelector('[data-preview-empty]').textContent,/Review.*settings/);
  await f.calculate();assert.equal(settings.sourceKind,'dtm');assert.equal(settings.reference.type,'custom');assert.equal(settings.reference.elevationM,100);assert.equal(settings.reference.offsetM,2);f.handle.close();
});

test('sample corridor stays explicit and keyboard inspection reports observed sample and base',async()=>{
  const f=fixture(async()=>({...result,preview:{samples:[[0,0,2,0],[1,0,3,0],[2,0,4,0]]}}));await f.calculate();
  assert.match(f.dialog.querySelector('[data-provenance]').textContent,/Points are not joined/);const chart=f.dialog.querySelector('[data-section-chart]');chart.onkeydown({key:'Home',preventDefault(){}});assert.match(f.dialog.querySelector('[data-readout]').textContent,/Surface 2\.000 m.*Base 0\.000 m/);chart.onkeydown({key:'End',preventDefault(){}});assert.match(f.dialog.querySelector('[data-readout]').textContent,/Surface 4\.000 m/);f.handle.close();
});

test('closing during calculation aborts and cannot save or show a delayed private result',async()=>{
  const wait=deferred(),f=fixture(()=>wait.promise),pending=f.calculate();f.handle.close();wait.resolve(result);await pending;assert.equal(f.saved(),0);assert.equal(f.dialog.removed,true);
});

test('changing calculation settings aborts pending work and never displays a stale preview',async()=>{
  const wait=deferred(),f=fixture(()=>wait.promise),pending=f.calculate();f.dialog.querySelector('[name=source]').onchange();wait.resolve(result);await pending;assert.equal(f.saved(),0);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'idle');assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,true);assert.match(f.dialog.querySelector('[data-preview-empty]').textContent,/Settings changed/);f.handle.close();
});

test('auto mode starts exactly once and closing aborts the guarded attempt',async()=>{
  const wait=deferred();let calls=0,signal;const f=fixture((_record,options)=>{calls++;signal=options.signal;return wait.promise;},{autoCalculate:true});assert.equal(calls,1);f.handle.close();assert.equal(signal.aborted,true);wait.resolve(result);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal(f.saved(),0);
});

test('queued native close event cannot leave a window to save a completed calculation',async()=>{
  for(const action of ['handle','button','escape']){
    const wait=deferred(),f=fixture(()=>wait.promise);let queued;
    f.dialog.close=function(){this.open=false;queued=()=>this.onclose?.();};
    const pending=f.calculate();
    if(action==='handle')f.handle.close();
    else if(action==='button')f.dialog.querySelector('[data-close]').onclick();
    else {f.dialog.oncancel();f.dialog.close();}
    assert.equal(f.dialog.removed,undefined);
    wait.resolve(result);await pending;
    assert.equal(f.saved(),0,`${action}: no save while native close is queued`);
    queued();assert.equal(f.dialog.removed,true);queued();
  }
});

test('reopening an existing surface result shows saved totals honestly without another calculation or fake preview',()=>{
  let calculated=0;const saved={...result,preview:undefined,reference:{type:'custom',elevationM:100,offsetM:.5},sourceKind:'dtm',warnings:['Missing cells remain excluded.']};
  const f=fixture(()=>{calculated++;return result;},{record:{name:'Saved pile',results:saved}});
  assert.equal(calculated,0);assert.equal(f.saved(),0);assert.equal(f.dialog.querySelector('[data-status]').dataset.state,'saved');assert.match(f.dialog.querySelector('[data-status]').textContent,/Previously saved.*not been recalculated/);assert.match(f.dialog.querySelector('[data-status]').textContent,/Missing cells/);
  assert.equal(f.dialog.querySelector('[data-results]').hidden,false);assert.equal(f.dialog.querySelector('[data-result=cut]').textContent,'12,345.679 m³');assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,true);assert.match(f.dialog.querySelector('[data-preview-empty]').textContent,/saved calculation settings/);
  assert.equal(f.dialog.querySelector('[name=reference]').value,'custom');assert.equal(f.dialog.querySelector('[name=elevation]').value,'100');assert.equal(f.dialog.querySelector('[name=offset]').value,'0.5');assert.equal(f.dialog.querySelector('[name=source]').value,'dtm');assert.doesNotMatch(f.dialog.innerHTML,/name="metres"/);
  f.handle.close();
});

test('saved incomplete or object calculations are not presented as a new complete surface calculation',()=>{
  const partial=fixture(()=>result,{record:{name:'Incomplete',results:{cutM3:2,coverage:.5,status:'incomplete'}}});
  assert.equal(partial.dialog.querySelector('[data-result=fill]').textContent,'Unavailable');assert.equal(partial.dialog.querySelector('[data-result=coverage]').textContent,'50.000%');assert.match(partial.dialog.querySelector('[data-status]').textContent,/Previously saved incomplete/);partial.handle.close();
  const object=fixture(()=>result,{record:{name:'Object',results:{volumeM3:3,status:'estimate'}}});assert.match(object.dialog.querySelector('[data-status]').textContent,/Previously saved object volume.*different calculation/);object.handle.close();
});

test('unchanged completed volume opens in view mode while invalidated geometry asks for recalculation',()=>{
  const saved={...result,method:'surface-cut-fill',calculationJobId:'saved-job',source:{kind:'dsm',modelVersionId:'v1'}};
  const current=fixture(()=>{throw new Error('must not calculate on open');},{record:{name:'Saved pile',modelVersionId:'v1',results:saved}});
  assert.equal(current.dialog.querySelector('h2').textContent,'View volume');assert.equal(current.dialog.querySelector('[data-calculate]').hidden,true);assert.equal(current.saved(),0);
  current.dialog.querySelector('[name=offset]').oninput();assert.equal(current.dialog.querySelector('[data-calculate]').hidden,false);current.handle.close();
  const stale=fixture(()=>result,{record:{name:'Edited pile',results:{status:'geometry-only',volumeInvalidated:true}}});
  assert.equal(stale.dialog.querySelector('h2').textContent,'Calculate volume');assert.equal(stale.dialog.querySelector('[data-calculate]').hidden,false);assert.equal(stale.dialog.querySelector('[data-status]').dataset.state,'stale');assert.match(stale.dialog.querySelector('[data-status]').textContent,/outline changed.*old volume is no longer current/);stale.handle.close();
});

test('persisted server complete surface result opens as current without weakening source or job guards',()=>{
  const saved={...result,status:'complete',method:'surface-cut-fill',calculationJobId:'server-job',source:{assetId:'dsm-source',kind:'dsm',modelVersionId:'v1',boundaryElevationBasis:'native-raster'}};
  for(const patch of [null,{status:'incomplete'},{source:{...saved.source,modelVersionId:'other'}},{calculationJobId:''},{volumeInvalidated:true},{coverage:NaN}]){
    const f=fixture(()=>{throw new Error('must not calculate on open');},{execution:'server',record:{name:'Saved feed pile',modelVersionId:'v1',results:{...saved,...patch}}});
    assert.equal(f.dialog.querySelector('[data-calculate]').hidden,patch===null);assert.equal(f.saved(),0);f.handle.close();
  }
});

test('accepted volume notice is polite, contains no private measurement data and survives ordinary close',async()=>{
  const wait=deferred(),f=fixture((_record,{onJob})=>{onJob({cancel:async()=>{}});onJob({cancel:async()=>{}});return wait.promise;});
  const pending=f.calculate();assert.equal(f.notices.length,1);assert.equal(f.notices[0].attributes.role,'status');assert.match(f.notices[0].textContent,/while your access remains valid/);assert.doesNotMatch(f.notices[0].textContent,/Pile A/);f.handle.close();assert.equal(f.notices[0].removed,undefined);wait.resolve(result);await pending;assert.equal(f.saved(),0);
});

const serverRecord={id:'polygon',name:'Pile A',revision:2,kind:'polygon',modelVersionId:'version',source:{kind:'ortho'}};
const serverParameters={method:'surface-cut-fill',sourceAssetId:'dsm-source',reference:{type:'boundary-triangulated',offsetM:0},sourceVerticalUnit:null};
const serverCapabilities={capabilities:{rasterCalculations:true},calculationSources:[{assetId:'dsm-source',kind:'dsm',methods:['surface-cut-fill']}]};
const queuedJob={id:'job',measurementId:'polygon',revision:2,status:'queued',parameters:serverParameters};
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('normal inspector resumes and cancels an existing matching job without duplicate creation',async()=>{
  const wait=deferred(),calls=[];
  const calculate=createServerSurfaceCalculator({wait:()=>wait.promise,request:async(operation)=>{calls.push(operation);if(operation==='capabilities')return serverCapabilities;if(operation==='list')return{calculations:[queuedJob]};if(operation==='cancel')return{};throw new Error('Unexpected request');}});
  const f=fixture(calculate,{execution:'server',record:serverRecord}),pending=f.calculate();await flush();
  const cancel=f.dialog.querySelector('[data-cancel-job]');assert.equal(cancel.hidden,false);
  await cancel.onclick();wait.resolve();await pending;
  assert.deepEqual(calls,['capabilities','list','cancel']);assert.equal(f.saved(),0);assert.equal(cancel.hidden,true);assert.equal(f.dialog.querySelector('[data-calculate]').disabled,false);assert.match(f.dialog.querySelector('[data-status]').textContent,/Cancellation requested/);f.handle.close();
});

test('different active settings offer cancellation inside the normal inspector with no new job',async()=>{
  const calls=[],calculate=createServerSurfaceCalculator({request:async(operation)=>{calls.push(operation);if(operation==='capabilities')return serverCapabilities;if(operation==='list')return{calculations:[{...queuedJob,parameters:{...serverParameters,reference:{type:'average-boundary',offsetM:0}}}]};if(operation==='cancel')return{};throw new Error('Unexpected create');}});
  const f=fixture(calculate,{execution:'server',record:serverRecord});await f.calculate();
  assert.match(f.dialog.querySelector('[data-status]').textContent,/different settings.*cancel it here/);assert.equal(f.dialog.querySelector('[data-cancel-job]').hidden,false);
  await f.dialog.querySelector('[data-cancel-job]').onclick();assert.deepEqual(calls,['capabilities','list','cancel']);assert.equal(f.saved(),0);f.handle.close();
});

test('a cancellation request cannot race a completed poll into saving the cancelled calculation',async()=>{
  const completion=deferred(),cancellation=deferred();let options;
  const f=fixture((_record,o)=>{options=o;o.onJob({cancel:()=>cancellation.promise});return completion.promise;},{execution:'server'});
  const pending=f.calculate(),cancel=f.dialog.querySelector('[data-cancel-job]').onclick();
  completion.resolve(result);await flush();assert.equal(f.saved(),0,'requesting cancellation must fence attachment immediately, before DELETE settles');
  cancellation.resolve();await cancel;await pending;assert.equal(f.saved(),0);f.handle.close();
});

test('poll updates cannot reenable cancellation or dispatch a duplicate while cancellation is pending',async()=>{
  const completion=deferred(),cancellation=deferred();let options,calls=0;
  const active={cancel:()=>{calls++;return cancellation.promise;}};
  const f=fixture((_record,o)=>{options=o;o.onJob(active);return completion.promise;},{execution:'server'});
  const pending=f.calculate(),button=f.dialog.querySelector('[data-cancel-job]'),cancel=button.onclick();
  assert.equal(button.disabled,true);options.onJob(active);assert.equal(button.disabled,true,'an arriving queued/running poll cannot reopen the cancellation action');
  cancellation.resolve();await cancel;completion.resolve(result);await pending;assert.equal(calls,1);assert.equal(f.saved(),0);f.handle.close();
});

test('close or access retirement while cancellation is pending cannot publish late status or volume',async()=>{
  for(const retire of ['close','access']){
    const completion=deferred(),cancellation=deferred();let options;
    const f=fixture((_record,o)=>{options=o;o.onJob({cancel:()=>cancellation.promise});return completion.promise;},{execution:'server'});
    const pending=f.calculate(),cancel=f.dialog.querySelector('[data-cancel-job]').onclick();
    // Workspace retires the same dialog handle on access loss or view change.
    f.handle.close();const before=f.dialog.querySelector('[data-status]').textContent;
    cancellation.resolve();completion.resolve(result);await cancel;await pending;
    options.onProgress('Private late progress');assert.equal(f.dialog.querySelector('[data-status]').textContent,before,retire);assert.equal(f.saved(),0);assert.equal(f.dialog.removed,true);
  }
});

test('failed cancellation does not claim success or attach a result that arrived during cancellation',async()=>{
  const completion=deferred(),cancellation=deferred();
  const f=fixture((_record,o)=>{o.onJob({cancel:()=>cancellation.promise});return completion.promise;},{execution:'server'});
  const pending=f.calculate(),cancel=f.dialog.querySelector('[data-cancel-job]').onclick();
  completion.resolve(result);await pending;assert.equal(f.saved(),0);
  cancellation.reject(new Error('Access changed'));await cancel;
  assert.match(f.dialog.querySelector('[data-status]').textContent,/Could not cancel.*Access changed/);assert.equal(f.saved(),0);assert.equal(f.dialog.querySelector('[data-calculate]').disabled,false);f.handle.close();
});

test('a cancellation response for previous settings cannot replace the newer calculation UI',async()=>{
  const first=deferred(),second=deferred(),cancellation=deferred();let calls=0;
  const f=fixture((_record,o)=>{if(calls++===0){o.onJob({cancel:()=>cancellation.promise});return first.promise;}o.onProgress('New settings are calculating');return second.promise;},{execution:'server'});
  const pendingFirst=f.calculate(),cancel=f.dialog.querySelector('[data-cancel-job]').onclick();
  f.dialog.querySelector('[name=source]').onchange();const pendingSecond=f.calculate();
  cancellation.resolve();first.resolve(result);await cancel;await pendingFirst;
  assert.equal(f.dialog.querySelector('[data-status]').textContent,'New settings are calculating');assert.equal(f.dialog.querySelector('[data-calculate]').disabled,true);assert.equal(f.saved(),0);
  second.resolve(result);await pendingSecond;assert.equal(f.saved(),1);f.handle.close();
});

test('normal inspector retrieves a completed matching job with its preview without creating another job',async()=>{
  const calls=[],complete={...queuedJob,status:'complete',result:{...result,method:'surface-cut-fill',source:{assetId:'dsm-source',kind:'dsm',modelVersionId:'version',boundaryElevationBasis:'native-raster'},reference:serverParameters.reference}};
  const calculate=createServerSurfaceCalculator({request:async operation=>{calls.push(operation);if(operation==='capabilities')return serverCapabilities;if(operation==='list')return{calculations:[complete]};throw new Error('Unexpected duplicate create');}});
  const f=fixture(calculate,{execution:'server',record:serverRecord});await f.calculate();
  assert.deepEqual(calls,['capabilities','list']);assert.equal(f.saved(),1);assert.equal(f.dialog.querySelector('[data-preview-content]').hidden,false);assert.equal(f.dialog.querySelector('[data-cancel-job]').hidden,true);f.handle.close();
});
