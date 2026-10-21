import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {renderMeasurementReport} from '../measurement-report-document.mjs';
const source=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
const start=source.indexOf('  async function screenshot('),end=source.indexOf('  async function report()',start);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
function fixture(){
  const capture=deferred(),decode=deferred(),decodeStarted=deferred(),state={draws:0,captures:0,urls:[],revoked:[],serializations:0,text:[]};
  const ctx={drawImage(){state.draws++;},fillRect(){},fillText(text){state.text.push(text);}},canvas={width:400,height:300,getContext:()=>ctx};
  const scope=vm.createContext({bound:{element:{},mode:'model',capture:()=>{state.captures++;return capture.promise;}},viewGeneration:1,units:'imperial',disposed:false,allowed:()=>true,draw(){},records:()=>[],displayGeometry:record=>record.vertices,displayStatus:()=>'',coordinateReference:()=>({crs:'EPSG:32616'}),svg:{text:'original'},XMLSerializer:class{serializeToString(svg){state.serializations++;return svg.text;}},Image:class{decode(){decodeStarted.resolve();return decode.promise;}},Blob,URL:{createObjectURL(blob){state.urls.push(blob);return'blob:test';},revokeObjectURL(url){state.revoked.push(url);}}});
  vm.runInContext(source.slice(start,end),scope);return{scope,state,canvas,capture,decode,decodeStarted};
}
test('screenshot captures the overlay snapshot before asynchronous renderer capture',async()=>{
  const f=fixture(),pending=f.scope.screenshot();assert.equal(f.state.serializations,1);f.scope.svg.text='changed';f.capture.resolve(f.canvas);
  await Promise.resolve();f.decode.resolve();await pending;assert.equal(await f.state.urls[0].text(),'original');assert.equal(f.state.draws,1);assert.deepEqual(f.state.revoked,['blob:test']);
});

test('pending or unavailable visible overlays block capture before serializing or reading the renderer',async()=>{
  for(const status of ['Placing map measurement on the elevation surface…','3D overlay unavailable: No verified elevation surface.']){
    const f=fixture();f.scope.records=()=>[{id:'visible',visible:true}];f.scope.displayGeometry=()=>null;f.scope.displayStatus=()=>status;
    await assert.rejects(f.scope.screenshot(),error=>error.message.includes('Cannot capture all visible measurements yet')&&error.message.includes(status));
    assert.equal(f.state.captures,0);assert.equal(f.state.serializations,0);assert.equal(f.state.urls.length,0);assert.equal(f.state.draws,0);
  }
});

test('unavailable hidden overlays do not prevent an otherwise complete capture',async()=>{
  const f=fixture();f.scope.records=()=>[{id:'hidden',visible:false}];f.scope.displayGeometry=()=>null;
  const pending=f.scope.screenshot();assert.equal(f.state.captures,1);f.capture.resolve(f.canvas);await Promise.resolve();f.decode.resolve();await pending;assert.equal(f.state.draws,1);
});

test('quick capture explicitly warns about unavailable overlays instead of silently omitting them',async()=>{
  const f=fixture();f.scope.records=()=>[{id:'pending-map',visible:true}];f.scope.displayGeometry=()=>null;
  const pending=f.scope.screenshot({allowIncomplete:true});f.capture.resolve(f.canvas);await Promise.resolve();f.decode.resolve();await pending;
  assert.equal(f.state.captures,1);assert.equal(f.state.draws,1);assert.match(f.state.text[0],/^Current view only.*some measurement overlays unavailable/);
  assert.match(f.state.text[0],/imperial.*EPSG:32616/);
});
test('view mode, generation, unit and permission changes reject delayed screenshot before overlay export',async()=>{
  for(const change of [f=>{f.scope.viewGeneration++;},f=>{f.scope.bound={...f.scope.bound,mode:'ortho'};},f=>{f.scope.units='metric';},f=>{f.scope.allowed=()=>false;},f=>{f.scope.disposed=true;}]){
    const f=fixture(),pending=f.scope.screenshot(),rejected=assert.rejects(pending,/view changed/);change(f);f.capture.resolve(f.canvas);await rejected;
    assert.equal(f.state.draws,0);assert.equal(f.state.urls.length,0);
  }
});
test('late overlay decode cannot export private data after access loss and releases its URL',async()=>{
  const f=fixture(),pending=f.scope.screenshot(),rejected=assert.rejects(pending,/view changed/);f.capture.resolve(f.canvas);await f.decodeStarted.promise;
  f.scope.allowed=()=>false;f.decode.resolve();await rejected;assert.equal(f.state.draws,0);assert.deepEqual(f.state.revoked,['blob:test']);
});

test('PNG encoding cannot download after a late access or view change',async()=>{
  const action=source.slice(source.indexOf("      if(action==='screenshot')"),source.indexOf("      if(action==='report')"));
  for(const change of [s=>{s.allowed=()=>false;},s=>{s.viewGeneration++;},s=>{s.units='metric';},s=>{s.disposed=true;}]){
    let encode;const started=deferred();let downloads=0;
    const scope=vm.createContext({action:'screenshot',viewGeneration:1,units:'imperial',disposed:false,allowed:()=>true,screenshot:async()=>({toBlob(callback){encode=callback;started.resolve();}}),download(){downloads++;}});
    const pending=vm.runInContext(`(async()=>{${action}})()`,scope),rejected=assert.rejects(pending,/view changed/);
    await started.promise;change(scope);encode(new Blob(['image']));await rejected;assert.equal(downloads,0);
  }
});

test('successful PNG retry replaces an earlier capture error only after requesting download',async()=>{
  const action=source.slice(source.indexOf("      if(action==='screenshot')"),source.indexOf("      if(action==='report')"));
  let message='Cannot capture all visible measurements yet.',failure=true;
  const events=[],scope=vm.createContext({action:'screenshot',viewGeneration:1,units:'imperial',disposed:false,allowed:()=>true,
    screenshot:async()=>{if(failure)throw new Error('Placement unavailable');return{toBlob(callback){callback(new Blob(['image']));}};},
    download(_blob,name){events.push(['download',name]);},tell(value){message=value;events.push(['message',value]);}});
  await assert.rejects(vm.runInContext(`(async()=>{${action}})()`,scope),/Placement unavailable/);
  assert.equal(events.length,0);assert.match(message,/Cannot capture/);
  failure=false;await vm.runInContext(`(async()=>{${action}})()`,scope);
  assert.deepEqual(events,[['download','measured-view.png'],['message','View PNG download requested.']]);
  assert.equal(message,'View PNG download requested.');
});

function reportFixture({decode=()=>Promise.resolve(),fonts=Promise.resolve(),captureReportOrtho=null}={}){
  const reports=new Set(),body={children:[],append(node){this.children.push(node);}};let printed=0;
  const document={body,fonts:{ready:fonts},createElement(){
    const nodes=new Map();let markup='',images=[],toggles=[];
    const node=()=>({decode,following:[],after(value){this.following.push(value);},removeAttribute(key){delete this[key];},getAttribute(key){return this[key]??null;}});
    return {get innerHTML(){return markup;},set innerHTML(value){
      markup=value;if(!value)return;
      images=[...value.matchAll(/<img\b([^>]*)>/g)].map(match=>{const img=node(),src=match[1].match(/\bsrc="([^"]*)"/);if(src)img.src=src[1];img.hidden=/\bhidden\b/.test(match[1]);return img;});
      nodes.set('img',images[0]);
      toggles=[...value.matchAll(/data-report-toggle="([^"]+)"/g)].map(match=>({...node(),checked:true,dataset:{reportToggle:match[1]}}));
    },showModal(){},querySelector(selector){if(!nodes.has(selector))nodes.set(selector,node());return nodes.get(selector);},querySelectorAll(selector){return selector==='img'?images:selector==='[data-report-toggle]'?toggles:[];},remove(){body.children=body.children.filter(n=>n!==this);}};
  }};
  const scope=vm.createContext({document,reportDialogs:reports,reportCaptures:new Set(),AbortController,reportMetadata:()=>({modelName:'Private model'}),captureReportOrtho,renderMeasurementReport,tell(){},viewGeneration:1,disposed:false,allowed:()=>true,units:'imperial',structuredClone,exportRecords:()=>[],screenshot:async()=>({toDataURL:()=> 'data:image/png;base64,cHJpdmF0ZQ=='}),coordinateReference:()=>({crs:'EPSG:32616'}),summary:r=>r.name+' geometry',calculationSummary:()=> 'Volume 10',measurementMetrics:()=>({edgeLengthsM:[1,2,3]}),measurementValue:String,escape:String,window:{print(){printed++;}}});
  vm.runInContext(source.slice(source.indexOf('  async function report()'),source.indexOf("  controls.addEventListener('change'")),scope);
  vm.runInContext(source.slice(source.indexOf('  function closeReports()'),source.indexOf('  function closeDialogs()')),scope);
  return{scope,reports,body,printed:()=>printed};
}

test('open report cleanup clears private image and markup, and is idempotent',async()=>{
  const f=reportFixture();await f.scope.report();const dialog=f.body.children[0],img=dialog.querySelector('img');
  assert.match(img.src,/cHJpdmF0ZQ/);f.scope.closeReports();assert.equal(img.src,undefined);assert.equal(dialog.innerHTML,'');assert.equal(f.body.children.length,0);assert.equal(f.reports.size,0);dialog.onclose();
  const close=source.slice(source.indexOf('  function closeDialogs()'),source.indexOf('  function invalidate('));assert.match(close,/closeReports\(\)/);
  assert.match(source.slice(source.indexOf('  function invalidate('),source.indexOf('  async function finish()')),/closeDialogs\(\)/);
  assert.match(source.slice(source.indexOf('  return {setTool,store')),/dispose\(\).*closeDialogs\(\)/);
});

test('report print waits for image decode and fonts, then requires a fresh explicit click',async()=>{
  const image=deferred(),fonts=deferred(),started=deferred(),f=reportFixture({decode:()=>{started.resolve();return image.promise;},fonts:fonts.promise}),pending=f.scope.report();await started.promise;
  const dialog=f.body.children[0],button=dialog.querySelector('[data-print]');assert.equal(button.disabled,true);assert.match(button.textContent,/Preparing/);button.onclick();assert.equal(f.printed(),0);
  image.resolve();await Promise.resolve();assert.equal(button.disabled,true,'font readiness is independently required');fonts.resolve();await pending;
  assert.equal(button.disabled,false);assert.equal(f.printed(),0,'readiness never automatically opens print');button.onclick();assert.equal(f.printed(),1);
});

test('report preparation cannot revive a closed or unauthorized report after delayed decode',async()=>{
  for(const change of [f=>f.scope.closeReports(),f=>{f.scope.allowed=()=>false;},f=>{f.scope.viewGeneration++;},f=>{f.scope.units='metric';},f=>{f.scope.disposed=true;}]){
    const image=deferred(),started=deferred(),f=reportFixture({decode:()=>{started.resolve();return image.promise;}}),pending=f.scope.report();await started.promise;const button=f.body.children[0].querySelector('[data-print]');change(f);image.resolve();await pending;
    assert.equal(f.body.children.length,0);assert.equal(button.disabled,true);assert.equal(f.printed(),0);
  }
});

test('failed image decode keeps tables printable with an explicit image-unavailable warning',async()=>{
  const f=reportFixture({decode:()=>Promise.reject(new Error('decode failed'))});await f.scope.report();const dialog=f.body.children[0],img=dialog.querySelector('img');
  assert.equal(img.hidden,true);assert.equal(img.src,undefined);assert.match(dialog.querySelector('h1').following[0].textContent,/View image unavailable/);assert.equal(dialog.querySelector('[data-print]').disabled,false);assert.equal(f.printed(),0);
});

test('report print fails closed and clears the report after access or view change',async()=>{
  for(const change of [s=>{s.allowed=()=>false;},s=>{s.disposed=true;},s=>{s.viewGeneration++;}]){
    const f=reportFixture();await f.scope.report();const print=f.body.children[0].querySelector('[data-print]').onclick;change(f.scope);print();assert.equal(f.printed(),0);assert.equal(f.body.children.length,0);
  }
});

test('report keeps every measurement table when renderer or image encoding is unavailable',async()=>{
  for(const encoding of [false,true]){
    const f=reportFixture();f.scope.exportRecords=()=>[{name:'First saved measurement'},{name:'Second saved measurement',visible:false}].map(record=>({...record,kind:'distance',collection:'map',vertices:[[0,0,0],[1,1,0]]}));
    f.scope.screenshot=async()=>{if(!encoding)throw new Error('Renderer unavailable');return{toDataURL(){throw new Error('Canvas is tainted');}};};
    await f.scope.report();const dialog=f.body.children[0];assert.match(dialog.innerHTML,/First saved measurement/);assert.match(dialog.innerHTML,/Second saved measurement/);assert.equal(dialog.querySelector('img').hidden,true);assert.match(dialog.innerHTML,/View image unavailable.*saved measurement tables/);assert.equal(dialog.querySelector('h1').following.length,0);
    dialog.querySelector('[data-print]').onclick();assert.equal(f.printed(),1);f.scope.closeReports();assert.equal(f.body.children.length,0);
  }
});

test('report fallback cannot expose saved tables after access, lifecycle or view invalidation during capture',async()=>{
  for(const change of [s=>{s.allowed=()=>false;},s=>{s.disposed=true;},s=>{s.viewGeneration++;}]){
    const f=reportFixture(),wait=deferred();f.scope.exportRecords=()=>[{name:'Private saved record'}];f.scope.screenshot=async()=>{await wait.promise;throw new Error('Renderer failed');};
    const pending=f.scope.report(),rejected=assert.rejects(pending,/Access or view changed/);change(f.scope);wait.resolve();await rejected;assert.equal(f.body.children.length,0);assert.equal(f.reports.size,0);
  }
});

test('delayed orthophoto capture cannot expose a report after lifecycle, access, view or units change',async()=>{
  for(const change of [f=>f.scope.closeReports(),f=>{f.scope.allowed=()=>false;},f=>{f.scope.disposed=true;},f=>{f.scope.viewGeneration++;},f=>{f.scope.units='metric';}]){
    const started=deferred(),capture=deferred();let signal;
    const f=reportFixture({captureReportOrtho:async options=>{signal=options.signal;started.resolve();return capture.promise;}});
    const pending=f.scope.report(),rejected=assert.rejects(pending,/Access or view changed/);
    await started.promise;assert.equal(f.scope.reportCaptures.size,1);assert.equal(f.body.children.length,0);
    change(f);capture.resolve({dataUrl:'data:image/png;base64,b3J0aG8='});await rejected;
    assert.equal(f.body.children.length,0);assert.equal(f.reports.size,0);assert.equal(f.scope.reportCaptures.size,0);
    if(signal.aborted)assert.equal(signal.reason.name,'AbortError');
  }
});

test('both report images decode before print and their inclusion controls are independent',async()=>{
  const ready=deferred(),started=deferred();let decoded=0;
  const f=reportFixture({decode:()=>{if(++decoded===2)started.resolve();return ready.promise;},captureReportOrtho:async()=>({dataUrl:'data:image/png;base64,b3J0aG8='})});
  const pending=f.scope.report();await started.promise;
  const dialog=f.body.children[0],print=dialog.querySelector('[data-print]'),images=dialog.querySelectorAll('img');
  assert.equal(images.length,2);assert.equal(print.disabled,true);
  ready.resolve();await pending;
  const [current,ortho]=dialog.querySelectorAll('[data-report-toggle]');
  current.checked=false;current.onchange();assert.equal(dialog.querySelector('[data-report-figure="current"]').hidden,true);assert.equal(ortho.checked,true);
  ortho.checked=false;ortho.onchange();assert.equal(dialog.querySelector('[data-report-figure="ortho"]').hidden,true);
  assert.equal(print.disabled,false);print.onclick();assert.equal(f.printed(),1);
  f.scope.closeReports();assert.ok(images.every(img=>img.src===undefined));
});

test('orthophoto exceptions remain visible when the current view succeeds, without exposing the error',async()=>{
  const f=reportFixture({captureReportOrtho:async()=>{throw new Error('https://private.example/token');}});
  await f.scope.report();const dialog=f.body.children[0];
  assert.equal(dialog.querySelector('img').hidden,false);
  assert.equal((dialog.innerHTML.match(/Orthophoto overview unavailable/g)||[]).length,1);
  assert.doesNotMatch(dialog.innerHTML,/private\.example/);
  assert.equal(dialog.querySelector('h1').following.length,0);
  assert.equal(dialog.querySelector('[data-print]').disabled,false);
});

test('capture failures and repeated no-image warnings appear once in the report',async()=>{
  const f=reportFixture({captureReportOrtho:async()=>({warnings:['Overview unavailable.','Overview unavailable.']})});
  f.scope.screenshot=async()=>{throw new Error('Renderer unavailable');};
  await f.scope.report();const dialog=f.body.children[0];
  assert.equal((dialog.innerHTML.match(/View image unavailable/g)||[]).length,1);
  assert.equal((dialog.innerHTML.match(/Overview unavailable\./g)||[]).length,1);
  assert.equal(dialog.querySelector('h1').following.length,0);
  assert.equal(dialog.querySelector('[data-print]').disabled,false);
});
