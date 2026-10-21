import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireBrowserHarnessLock} from './browser-lock.mjs';
import {createServer as createViteServer} from 'vite';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(promise,ms,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out after ${ms}ms`)),ms);})]);}finally{clearTimeout(timer);}}
class Cdp {
  constructor(socket){this.socket=socket;this.id=0;this.pending=new Map();this.errors=[];this.choosers=[];socket.addEventListener('message',event=>{const value=JSON.parse(event.data),p=this.pending.get(value.id);if(value.method==='Page.fileChooserOpened')this.choosers.push(value.params);if(value.method==='Runtime.exceptionThrown')this.errors.push(value.params.exceptionDetails);if(p){this.pending.delete(value.id);clearTimeout(p.timer);value.error?p.reject(new Error(value.error.message)):p.resolve(value.result);}});}
  static async connect(url){const socket=new WebSocket(url);try{await bounded(new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});}),5000,'CDP connection');return new Cdp(socket);}catch(error){socket.close();throw error;}}
  command(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout ${method}`));},12000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async eval(expression){const r=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
  close(){this.socket.close();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('CDP fixture closed'));}this.pending.clear();}
}
async function until(fn){const end=Date.now()+10000;while(Date.now()<end){if(await fn())return;await delay(30);}throw new Error('Fixture timeout');}
const html=`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/workspace-management.css"><dialog class="workspace-modal" open><header class="modal-heading"><h2>New task</h2></header><div id="host"></div></dialog><script type="module">
import {mountNewTask} from '/workspace-new-task.mjs';
import {createWorkspaceRecovery} from '/workspace-recovery.mjs';
const calls=[];let mode='pc',datasetStatus='draft',submitCount=0,complete=null,handle,releaseRead;
function jpeg(){const data=new Uint8Array(174),v=new DataView(data.buffer),base=12;data.set([255,216,255,225,0,168,69,120,105,102,0,0]);data.set([73,73],base);const u16=(o,n)=>v.setUint16(base+o,n,true),u32=(o,n)=>v.setUint32(base+o,n,true);u16(2,42);u32(4,8);u16(8,1);u16(10,0x8825);u16(12,4);u32(14,1);u32(18,26);u16(26,6);[[1,2,2,'N'],[2,5,3,104],[3,2,2,'W'],[4,5,3,128],[16,2,2,'T'],[17,5,1,152]].forEach(([tag,type,count,value],i)=>{const at=28+i*12;u16(at,tag);u16(at+2,type);u32(at+4,count);if(type===2)data[base+at+8]=value.charCodeAt(0);else u32(at+8,value);});[45,30,0,90,15,0,123].forEach((value,i)=>{u32(104+i*8,value);u32(108+i*8,1);});data.set([255,217],172);return data;}
const provider={id:'node',displayName:'Test node',type:'nodeodm',enabled:true,capabilityFingerprint:'fp',lastHealth:'healthy',lastHealthAt:new Date().toISOString(),capabilities:{options:[...['pc-ept','gltf','3d-tiles'].map(name=>({name,type:'bool',value:true})),{name:'auto-boundary',type:'bool',value:true},{name:'crop',type:'float',value:3}]}};
const basePresets=[{id:'preset',displayName:'Good preset',enabled:true,providerType:'nodeodm',capabilityFingerprint:'fp',options:{crop:2}},{id:'wrong',displayName:'Wrong preset',enabled:true,providerType:'nodeodm',capabilityFingerprint:'other'}];let currentPresets=structuredClone(basePresets);
const api=async(url,opts={})=>{if(opts.signal?.aborted)throw new DOMException('Cancelled','AbortError');calls.push({url,method:opts.method||'GET',body:opts.body,headers:opts.headers});
 if(url==='/api/v1/processing/providers/node/capabilities/refresh')return{capabilities:provider.capabilities,fingerprint:window.fixture?.changeCapabilities&&datasetStatus==='finalized'?'changed':'fp'};
 if(url.startsWith('/api/v1/processing/providers'))return{providers:[window.fixture?.changeCapabilities&&datasetStatus==='finalized'?{...provider,capabilityFingerprint:'changed'}:provider]};
 if(url==='/api/v1/processing/presets'){if(!opts.method||opts.method==='GET')return{presets:currentPresets};if(window.fixture.failPreset){window.fixture.failPreset=false;throw new Error('Preset connection interrupted');}const preset={...opts.body,id:'saved-preset',providerType:'nodeodm',capabilityFingerprint:'fp'};currentPresets=[...currentPresets.filter(item=>item.id!==preset.id),preset];return{preset};}
 if(url.startsWith('/api/v1/dataset-imports/browse')){if(window.fixture?.holdBrowse)await new Promise(resolve=>window.fixture.releaseBrowse=resolve);return{path:'raw',parentPath:'',entries:[{name:'flight',relativePath:'raw/flight',kind:'folder'}],nextOffset:null};}
 if(url==='/api/v1/dataset-imports/photo-preview'){if(window.fixture?.holdPreview){window.fixture.previewSignal=opts.signal;await new Promise(resolve=>window.fixture.releasePreview=resolve);}return{points:[{latitude:45.5,longitude:-90.25,name:'Server photo'}],missingGpsCount:0,unscannedCount:0};}
 if(url==='/api/v1/dataset-imports/copy'){datasetStatus='finalizing';return{dataset:{id:'dataset'},operation:{id:'copy',status:'queued'}};}
 if(url==='/api/v1/datasets')return{dataset:{id:'dataset'}};
 if(url.endsWith('/uploads'))return{uploadToken:'scoped',upload:{id:'upload',datasetId:'dataset',status:'open',chunkSize:2,files:opts.body.files.map(file=>({...file,chunkCount:Math.ceil(file.byteSize/2),missingChunks:Array.from({length:Math.ceil(file.byteSize/2)},(_,i)=>i)}))}};
 if(url.endsWith('/finalize')){datasetStatus='finalizing';return{operation:{id:'assemble',status:'queued'}};}
 if(url.startsWith('/api/v1/operations/')){if(window.fixture.holdOperation){window.fixture.operationSignal=opts.signal;await new Promise(resolve=>window.fixture.releaseOperation=resolve);}if(opts.signal?.aborted)throw new DOMException('Cancelled','AbortError');datasetStatus=mode==='failed'?'draft':'finalized';return{operation:{id:'operation',status:mode==='failed'?'failed':'succeeded',errorMessage:'Copy validation failed'}};}
 if(url==='/api/v1/datasets/dataset')return{dataset:{id:'dataset',projectId:'project',status:datasetStatus}};
 if(url==='/api/v1/task-submissions'){submitCount++;if(mode==='pc'&&submitCount===1)throw new Error('Temporary submission failure');return{task:{id:'task'}};}
 throw new Error('Unexpected '+url);
};
window.fetch=async(url,options)=>{calls.push({url,chunk:true,bytes:options.body.byteLength});return new Response('{}',{status:201});};
window.fixture={calls,mount(next='pc',settings={}){mode=next;currentPresets=structuredClone(basePresets);datasetStatus='draft';submitCount=0;complete=null;calls.length=0;handle?.dispose();document.querySelector('dialog')?.remove();const dialog=document.createElement('dialog');dialog.className='workspace-modal';dialog.innerHTML='<header class="modal-heading"><h2>New task</h2></header><div id="host"></div>';document.body.append(dialog);dialog.showModal();handle=mountNewTask({container:document.querySelector('#host'),dialog,project:{id:'project',displayName:'Farm'},providers:[],presets:currentPresets,api,token:()=> 'staff',onComplete:r=>complete=r,...settings});},select(gps=false,slow=false){const dt=new DataTransfer(),file=new File([gps?jpeg():'abcdef'],'photo.jpg',{type:'image/jpeg'});if(slow)file.slice=()=>({arrayBuffer:()=>new Promise(resolve=>releaseRead=()=>resolve(jpeg().buffer))});dt.items.add(file);const input=document.querySelector('[data-files]');input.files=dt.files;input.dispatchEvent(new Event('change'));},release(){releaseRead?.();},reading:()=>!!releaseRead,submit(){document.querySelector('form').requestSubmit();},done:()=>complete,active:()=>handle.active,leaveBlocked(){const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;},close(){document.querySelector('dialog').close();}};
fixture.startRecoveryUpload=()=>{
 const originalOpen=window.open;window.open=()=>({closed:false,focus(){},postMessage(){}});
 const previous={accessToken:'t'.repeat(40),controllerOrigin:'https://ops.example',session:{id:'retained-session',subject:'ops:one',expiresAt:new Date(Date.now()-1000).toISOString()}};
 let first=true,resumed=false,installed=false,relay;
 const recovery=createWorkspaceRecovery({getSession:()=>previous,install:value=>{installed=value.session.id==='retained-session';},onFatal:()=>{throw new Error('Unexpected fatal recovery');},onResumed:()=>{resumed=true;},fetchImpl:async()=>new Response(JSON.stringify({...previous,session:{...previous.session,expiresAt:new Date(Date.now()+3600000).toISOString()}}),{status:200,headers:{'Content-Type':'application/json'}})});
 fixture.mount('recovery',{allowBackground:true,fetcher:async(url,init)=>{if(first){first=false;void recovery.pause();}await recovery.wait(init.signal);return window.fetch(url,init);}});
 fixture.select();const selected=document.querySelector('[data-files]').files[0],url=location.href;
 fixture.recovery={sameFile:()=>document.querySelector('[data-files]').files[0]===selected,unchangedUrl:()=>location.href===url,resumed:()=>resumed&&installed,
 restore(){document.querySelector('.workspace-recovery button').click();const {nonce}=JSON.parse(sessionStorage.getItem('ltds-viewer-reauthorization-state'));relay=new BroadcastChannel('ltds-workspace-recovery:'+nonce);relay.postMessage({version:1,type:'ltds-viewer:workspace-recovery-grant',nonce,grant:'g'.repeat(40)});},
 dispose(){relay?.close();recovery.dispose();window.open=originalOpen;}};
};
fixture.mount();document.body.dataset.ready='true';
</script>`;

test('New task uses real form controls with isolated upload/copy APIs, retry and cancellation',{timeout:60000},async t=>{
  const executable=[process.env.CHROME_PATH,process.env.EDGE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);if(!executable)return t.skip('Chromium-family browser required');
  const unlock=await acquireBrowserHarnessLock({root});let server,browser,client,temp,vite,failure;const sockets=new Set();let browserStderr='';
  try{
    temp=mkdtempSync(path.join(tmpdir(),'ltds-new-task-test-'));
    server=createServer((req,res)=>{const pathname=new URL(req.url,'http://fixture').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}vite.middlewares(req,res);});server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
    // Vite 8 still imports its client for CSS with HMR disabled. Attach that
    // client's transport to this fixture's ephemeral server, never port24678.
    vite=await createViteServer({root,configFile:false,server:{middlewareMode:true,hmr:false,ws:{server}},appType:'custom',logLevel:'error'});
    browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${temp}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});browser.stderr.on('data',chunk=>{browserStderr=(browserStderr+chunk.toString()).slice(-8000);});let launchError;browser.on('error',error=>{launchError=error;});const active=path.join(temp,'DevToolsActivePort');await until(()=>{if(launchError)throw launchError;if(browser.exitCode!==null)throw new Error(`Browser exited (${browser.exitCode}) before CDP startup: ${browserStderr}`);return existsSync(active);}).catch(error=>{throw new Error(`${error.message}\nBrowser startup (${executable}): ${browserStderr}`);});const port=readFileSync(active,'utf8').split(/\r?\n/)[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(5000)})).json();client=await Cdp.connect(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);await client.command('Page.enable');await client.command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await until(()=>client.eval("document.body?.dataset.ready==='true'"));
    await client.command('Runtime.enable');
    const capture=async name=>{if(process.env.LTDS_NEW_TASK_SCREENSHOTS!=='1')return;const shot=await client.command('Page.captureScreenshot',{format:'png'}),dir=path.join(root,'tmp','new-task-browser-qa');mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,`${name}.png`),Buffer.from(shot.data,'base64'));};
    await t.test('Choose files and Choose folder open native selectors; cancellation preserves selection',async()=>{
      await client.command('Page.setInterceptFileChooserDialog',{enabled:true});
      const click=async selector=>{const point=await client.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);await client.command('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});};
      await click('[data-source=pc]');await until(()=>client.choosers.length===1);
      const imageNode=(await client.command('DOM.describeNode',{backendNodeId:client.choosers[0].backendNodeId})).node;
      assert.ok(imageNode.attributes.includes('data-files'));assert.equal(client.choosers[0].mode,'selectMultiple');
      await client.eval("fixture.select(true)");await until(()=>client.eval("/1 photos? located/.test(document.querySelector('[data-photo-map]').textContent)"));
      await click('[data-source=pc]');await until(()=>client.choosers.length===2);await client.eval("document.querySelector('[data-files]').dispatchEvent(new Event('cancel'))");
      assert.match(await client.eval("document.querySelector('[data-selection]').textContent"),/1 photo selected/);assert.equal(await client.eval("document.querySelector('[data-photo-map]').hidden"),false);
      await click('[data-choose-folder]');await until(()=>client.choosers.length===3);const folderNode=(await client.command('DOM.describeNode',{backendNodeId:client.choosers[2].backendNodeId})).node;assert.ok(folderNode.attributes.includes('data-folder'));assert.ok(folderNode.attributes.includes('webkitdirectory'));
      await client.eval("document.querySelector('[data-folder]').dispatchEvent(new Event('cancel'));fixture.mount()");
      assert.equal(await client.eval("document.querySelector('[data-preview-photos]')===null"),true);
    });
    await t.test('fresh node refresh, compatible preset, PC upload and succeeded finalization; failed submit retry never reuploads',async()=>{
      await until(()=>client.eval("!!document.querySelector('[aria-label=\"crop\"]')"));
      await client.eval(`{const preset=document.querySelector('[name=presetId]');preset.value='preset';preset.dispatchEvent(new Event('change'));for(const [name,value] of [['auto-boundary','false'],['crop','0']]){const control=document.querySelector('[aria-label="'+name+'"]');if(control.type==='checkbox')control.checked=value==='true';else control.value=value;control.dispatchEvent(new Event('input'));}}`);
      await until(()=>client.eval("document.querySelector('[name=providerId]').value==='node'"));assert.equal(await client.eval("!!document.querySelector('[name=presetId] option[value=wrong]')"),false);await client.eval("fixture.select();fixture.submit()");await until(()=>client.eval("document.querySelector('[data-status]').textContent.includes('Temporary submission failure')"));assert.equal(await client.eval("document.querySelector('[aria-label=\"pc-ept\"]').disabled"),true);await client.eval('fixture.submit()');await until(()=>client.eval('!!fixture.done()'));
      const calls=await client.eval('fixture.calls'),submit=calls.filter(x=>x.url==='/api/v1/task-submissions');assert.equal(calls.filter(x=>x.url.endsWith('/uploads')).length,1);assert.equal(calls.filter(x=>x.url.endsWith('/finalize')).length,1);assert.equal(calls.filter(x=>x.chunk).length,3);assert.equal(submit.length,2);assert.equal(submit[0].body.submissionId,submit[1].body.submissionId);assert.equal(submit[0].headers['Idempotency-Key'],submit[1].headers['Idempotency-Key']);assert.equal(submit[1].body.presetId,'preset');
      assert.deepEqual(submit[1].body.options,{'auto-boundary':false,crop:0});
      assert.ok(calls.filter(x=>x.url==='/api/v1/processing/providers/node/capabilities/refresh').length>=3,'Capabilities refresh on open and before submission; listing cached providers is insufficient');
    });
    await t.test('server folder selection copies recursively and waits for succeeded before submit',async()=>{
      // Native dialog close is queued; let the previous dialog's event settle
      // before mounting another controller on this deliberately reused fixture.
      await delay(80);
      await client.eval("fixture.mount('server');document.querySelector('[data-source=server]').click()");await until(()=>client.eval("!!document.querySelector('[data-pick]')"));await client.eval("document.querySelector('[data-pick]').click();fixture.submit()");await until(()=>client.eval('!!fixture.done()'));const calls=await client.eval('fixture.calls');assert.deepEqual(calls.find(x=>x.url.endsWith('/copy')).body.paths,['raw/flight']);assert.ok(calls.findIndex(x=>x.url.startsWith('/api/v1/operations/'))<calls.findIndex(x=>x.url==='/api/v1/task-submissions'));assert.equal(calls.filter(x=>x.chunk).length,0);
    });
    await t.test('provider changes during source preparation require review instead of silent submission',async()=>{
      await delay(80);await client.eval("fixture.mount('server');fixture.changeCapabilities=true;document.querySelector('[data-source=server]').click()");await until(()=>client.eval("!!document.querySelector('[data-pick]') && !!document.querySelector('[aria-label=\"crop\"]')"));
      await client.eval(`{const preset=document.querySelector('[name=presetId]');preset.value='preset';preset.dispatchEvent(new Event('change'));const crop=document.querySelector('[aria-label="crop"]');crop.value='0';crop.dispatchEvent(new Event('input'));document.querySelector('[data-pick]').click();fixture.submit();}`);
      await until(()=>client.eval("document.querySelector('[data-status]').textContent.includes('options changed while preparing photos')"));
      assert.equal(await client.eval("fixture.calls.some(x=>x.url==='/api/v1/task-submissions')"),false);
      assert.equal(await client.eval("document.querySelector('[aria-label=\"pc-ept\"]').disabled"),true);
      assert.equal(await client.eval("document.querySelector('[aria-label=\"crop\"]').value"),'0','Refreshed capabilities must not silently discard task edits');
      assert.equal(await client.eval("document.querySelector('[name=presetId]').value"),'preset','Incompatible selected preset must not become node defaults');
      assert.match(await client.eval("document.querySelector('[data-provider-note]').textContent"),/incompatible/);
      await client.eval('fixture.changeCapabilities=false');
    });
    await t.test('late browse response cannot change a source while submission is preparing it',async()=>{
      await delay(80);await client.eval("fixture.mount('server');document.querySelector('[data-source=server]').click()");await until(()=>client.eval("!!document.querySelector('[data-pick]')"));
      await client.eval("document.querySelector('[data-pick]').click();fixture.holdBrowse=true;document.querySelector('[data-open]').click();fixture.submit()");await until(()=>client.eval("fixture.calls.some(x=>x.url.endsWith('/copy'))&&!!fixture.releaseBrowse"));
      await client.eval('fixture.releaseBrowse();fixture.holdBrowse=false');await until(()=>client.eval("!!document.querySelector('[data-pick]')"));
      assert.equal(await client.eval("document.querySelector('[data-pick]').disabled"),true);
      await client.eval("const latePick=document.querySelector('[data-pick]');latePick.checked=false;latePick.dispatchEvent(new Event('change'));document.querySelector('[data-open]').click()");
      await until(()=>client.eval('!!fixture.done()'));const calls=await client.eval('fixture.calls');assert.equal(calls.filter(x=>x.url==='/api/v1/dataset-imports/copy').length,1);assert.deepEqual(calls.find(x=>x.url==='/api/v1/dataset-imports/copy').body.paths,['raw/flight']);assert.equal(calls.filter(x=>x.url.startsWith('/api/v1/dataset-imports/browse')).length,2);assert.equal(calls.filter(x=>x.url==='/api/v1/task-submissions').length,1);
    });
    await t.test('closing after accepted copy stops observation and never submits a processing job',async()=>{
      await delay(80);
      await client.eval("fixture.mount('server');document.querySelector('[data-source=server]').click()");await until(()=>client.eval("!!document.querySelector('[data-pick]')"));await client.eval("document.querySelector('[data-pick]').click();fixture.submit()");await until(()=>client.eval("fixture.calls.some(x=>x.url.endsWith('/copy'))"));await client.eval('fixture.close()');await delay(1700);assert.equal(await client.eval("fixture.calls.some(x=>x.url==='/api/v1/task-submissions')"),false);
    });
    await t.test('failed source operation stays failed without task submission or automatic duplicate copy',async()=>{
      await client.eval("fixture.mount('failed');document.querySelector('[data-source=server]').click()");await until(()=>client.eval("!!document.querySelector('[data-pick]')"));await client.eval("document.querySelector('[data-pick]').click();fixture.submit()");await until(()=>client.eval("document.querySelector('[data-status]').textContent.includes('Copy validation failed')"));await client.eval('fixture.submit()');await delay(100);assert.equal(await client.eval("fixture.calls.filter(x=>x.url==='/api/v1/dataset-imports/copy').length"),1);assert.equal(await client.eval("fixture.calls.some(x=>x.url==='/api/v1/task-submissions')"),false);
    });
    await t.test('GPS preview uses real Leaflet, fits desktop/mobile and retires stale local scans on reselect/source change/close',async()=>{
      await client.eval("fixture.mount('server');fixture.select(true)");await until(()=>client.eval("/1 photos? located/.test(document.querySelector('[data-photo-map]').textContent)"));assert.equal(await client.eval("!!document.querySelector('[data-photo-map] .leaflet-container canvas')"),true);
      for(const [width,height,name] of [[1200,1050,'desktop'],[390,844,'mobile']]){await client.command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await delay(100);assert.equal(await client.eval('document.documentElement.scrollWidth<=innerWidth'),true);assert.equal(await client.eval("document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth+1"),true);await capture(`new-task-gps-${name}`);}
      await client.eval("fixture.select(true,true)");await until(()=>client.eval('fixture.reading()'));await client.eval("fixture.select(false);fixture.release()");await delay(80);assert.equal(await client.eval("document.querySelector('[data-photo-map]').hidden"),true);assert.equal(await client.eval("document.querySelector('[data-photo-map]').children.length"),0);
      await until(()=>client.eval("document.querySelector('[data-photo-map]').textContent.includes('0 photos located')"));await client.eval("document.querySelector('[data-source=server]').click()");assert.equal(await client.eval("document.querySelector('[data-photo-map]').hidden"),true);await until(()=>client.eval("!!document.querySelector('[data-pick]')"));await client.eval("document.querySelector('[data-pick]').click()");await until(()=>client.eval("/1 photos? located/.test(document.querySelector('[data-photo-map]').textContent)"));assert.equal(await client.eval("fixture.calls.filter(x=>x.url.endsWith('/photo-preview')).length"),1);await client.eval('fixture.close()');await delay(60);assert.equal(await client.eval("document.querySelector('[data-photo-map]').children.length"),0);
    });
    await t.test('automatic server preview debounces selections and ignores a late response after source change',async()=>{
      await client.eval("fixture.mount('server');fixture.holdPreview=true;document.querySelector('[data-source=server]').click()");await until(()=>client.eval("!!document.querySelector('[data-pick]')"));
      await client.eval("const pick=document.querySelector('[data-pick]');pick.click();pick.click();pick.click()");await until(()=>client.eval('!!fixture.releasePreview'));
      assert.equal(await client.eval("fixture.calls.filter(x=>x.url.endsWith('/photo-preview')).length"),1);
      await client.eval("document.querySelector('[data-source=pc]').click();fixture.releasePreview();fixture.holdPreview=false");await delay(80);
      assert.equal(await client.eval('fixture.previewSignal.aborted'),true);assert.equal(await client.eval("document.querySelector('[data-photo-map]').hidden"),true);assert.equal(await client.eval("document.querySelector('[data-photo-map]').children.length"),0);
      await client.eval("document.querySelector('[data-source=server]').click()");await until(()=>client.eval("!!document.querySelector('[data-pick]')"));await client.eval("document.querySelector('[data-pick]').click();fixture.close()");await delay(300);
      assert.equal(await client.eval("fixture.calls.filter(x=>x.url.endsWith('/photo-preview')).length"),1,'close cancels queued scan before network');
    });
    await t.test('preset save merges inherited options with false/zero overrides and retries idempotently without submitting',async()=>{
      await client.command('Emulation.setDeviceMetricsOverride',{width:1200,height:1050,deviceScaleFactor:1,mobile:false});
      await client.eval("fixture.mount('server',{canManagePresets:true});fixture.failPreset=true");await until(()=>client.eval("!!document.querySelector('[aria-label=\"crop\"]')"));
      await client.eval(`const preset=document.querySelector('[name=presetId]');preset.value='preset';preset.dispatchEvent(new Event('change'));for(const [name,value] of [['auto-boundary','false'],['crop','0']]){const control=document.querySelector('[aria-label="'+name+'"]');if(control.type==='checkbox')control.checked=value==='true';else control.value=value;control.dispatchEvent(new Event('input'));}document.querySelector('[data-preset-open]').click();document.querySelector('[name=newPresetName]').value='Farm custom';document.querySelector('[data-preset-save-button]').click()`);
      await until(()=>client.eval("document.querySelector('[data-preset-status]').textContent.includes('Preset connection interrupted')"));assert.equal(await client.eval('fixture.leaveBlocked()'),false);
      await client.eval("document.querySelector('[data-preset-save-button]').click()");await until(()=>client.eval("document.querySelector('[data-preset-status]').textContent.includes('Preset saved and selected')"));
      await capture('new-task-preset-saved');
      const saved=await client.eval("fixture.calls.filter(x=>x.url==='/api/v1/processing/presets'&&x.method==='POST')");assert.equal(saved.length,2);assert.deepEqual(saved[1].body.options,{'auto-boundary':false,crop:0});assert.equal(saved[0].headers['Idempotency-Key'],saved[1].headers['Idempotency-Key']);assert.equal(await client.eval("document.querySelector('[name=presetId]').value"),'saved-preset');assert.equal(await client.eval("fixture.calls.some(x=>x.url==='/api/v1/task-submissions')"),false);
      await client.eval(`const control=document.querySelector('[aria-label="crop"]');control.value='5';control.dispatchEvent(new Event('input'));document.querySelector('[data-edit-options]').click();document.querySelector('[data-edit-options]').click()`);assert.equal(await client.eval("document.querySelector('[aria-label=\"crop\"]').value"),'5');
      await client.eval("document.querySelector('[name=presetId]').value='preset';document.querySelector('[name=presetId]').dispatchEvent(new Event('change'))");assert.equal(await client.eval("document.querySelector('[aria-label=\"Reset crop to preset\"]').disabled"),true);assert.equal(await client.eval("document.querySelector('[aria-label=\"crop\"]').value"),'2');await client.eval('fixture.close()');await delay(60);
    });
    await t.test('background preparation survives dialog close, reopens, completes and leaves unrelated dialog untouched',async()=>{
      await client.eval("fixture.mount('server',{allowBackground:true});fixture.holdOperation=true;document.querySelector('[data-source=server]').click()");await until(()=>client.eval("!!document.querySelector('[data-pick]')"));assert.equal(await client.eval('fixture.leaveBlocked()'),false);
      await client.eval("document.querySelector('[data-pick]').click();fixture.submit()");await until(()=>client.eval('!!fixture.releaseOperation'));assert.equal(await client.eval('fixture.leaveBlocked()'),true);await client.eval('fixture.close()');await delay(50);
      assert.equal(await client.eval('fixture.active()'),true);assert.equal(await client.eval("document.querySelector('dialog').open"),false);assert.equal(await client.eval("!!document.querySelector('.task-transfer-tray')"),true);
      await capture('new-task-background-transfer');
      await client.eval("document.querySelector('[data-show-upload]').click()");assert.equal(await client.eval("document.querySelector('dialog').open"),true);await client.eval("fixture.close();const other=document.createElement('dialog');other.id='unrelated-dialog';other.textContent='Unrelated workspace action';document.body.append(other);other.showModal();fixture.holdOperation=false;fixture.releaseOperation()");await until(()=>client.eval('!!fixture.done()'));
      assert.equal(await client.eval("document.querySelector('#unrelated-dialog').open"),true);assert.equal(await client.eval("!!document.querySelector('.task-transfer-tray')"),false);assert.equal(await client.eval('fixture.leaveBlocked()'),false);assert.equal(await client.eval('fixture.active()'),false);assert.equal(await client.eval("fixture.calls.filter(x=>x.url==='/api/v1/task-submissions').length"),1);await client.eval("document.querySelector('#unrelated-dialog').remove();fixture.releaseOperation=null");await delay(60);
    });
    await t.test('failed background preparation releases close warning and can be discarded without submission',async()=>{
      await client.eval("fixture.mount('failed',{allowBackground:true});document.querySelector('[data-source=server]').click()");await until(()=>client.eval("!!document.querySelector('[data-pick]')"));await client.eval("document.querySelector('[data-pick]').click();fixture.submit()");await until(()=>client.eval("fixture.calls.some(x=>x.url.endsWith('/copy'))"));await client.eval('fixture.close()');await until(()=>client.eval("document.querySelector('.task-transfer-tray p').textContent.includes('Copy validation failed')"));
      assert.equal(await client.eval('fixture.leaveBlocked()'),false);assert.equal(await client.eval('fixture.active()'),true);await client.eval("document.querySelector('[data-discard-upload]').click()");assert.equal(await client.eval('fixture.active()'),false);assert.equal(await client.eval("!!document.querySelector('.task-transfer-tray')"),false);assert.equal(await client.eval("fixture.calls.some(x=>x.url==='/api/v1/task-submissions')"),false);await delay(60);
    });
    await t.test('discarding active background work cancels observation and prevents late submission',async()=>{
      await client.eval("fixture.mount('server',{allowBackground:true});fixture.holdOperation=true;document.querySelector('[data-source=server]').click()");await until(()=>client.eval("!!document.querySelector('[data-pick]')"));await client.eval("document.querySelector('[data-pick]').click();fixture.submit()");await until(()=>client.eval('!!fixture.releaseOperation'));await client.eval("fixture.close();document.querySelector('[data-discard-upload]').click();fixture.holdOperation=false;fixture.releaseOperation()");await delay(80);
      assert.equal(await client.eval('fixture.operationSignal.aborted'),true);assert.equal(await client.eval('fixture.leaveBlocked()'),false);assert.equal(await client.eval('fixture.active()'),false);assert.equal(await client.eval("fixture.calls.some(x=>x.url==='/api/v1/task-submissions')"),false);await client.eval('fixture.releaseOperation=null');
    });
    await t.test('expired access stacks recovery over New task and resumes the same selected photo without navigating',async sub=>{
      sub.after(()=>client.eval('fixture.recovery?.dispose()'));
      await delay(80);await client.eval('fixture.startRecoveryUpload()');
      await until(()=>client.eval("document.querySelector('[name=providerId]').value==='node'"));await client.eval('fixture.submit()');
      await until(()=>client.eval("!!document.querySelector('.workspace-recovery[open]')"));
      assert.equal(await client.eval("document.querySelectorAll('dialog[open]').length"),2,'recovery must not close the working New task dialog');
      assert.equal(await client.eval('fixture.recovery.sameFile()&&fixture.recovery.unchangedUrl()'),true);
      assert.equal(await client.eval('fixture.leaveBlocked()'),true,'active paused upload still warns against closing tab');
      assert.equal(await client.eval('fixture.calls.filter(x=>x.chunk).length'),0,'no upload while access is paused');
      await client.eval('fixture.recovery.restore()');await until(()=>client.eval('fixture.recovery.resumed()&&!!fixture.done()'));
      assert.equal(await client.eval('fixture.recovery.sameFile()&&fixture.recovery.unchangedUrl()'),true);
      assert.equal(await client.eval("document.querySelector('.workspace-recovery')===null"),true);
      assert.equal(await client.eval('fixture.calls.filter(x=>x.chunk).length'),3);
      assert.equal(await client.eval("fixture.calls.filter(x=>x.url.endsWith('/uploads')).length"),1,'reuse the original upload');
      assert.equal(await client.eval("fixture.calls.filter(x=>x.url==='/api/v1/task-submissions').length"),1);
      assert.equal(await client.eval('fixture.leaveBlocked()'),false);await client.eval('fixture.recovery.dispose()');
    });
    await t.test('More project actions escape the selected card clip and remain hittable',async()=>{
      await client.command('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false});await client.eval("document.querySelector('dialog').open=false;const card=document.createElement('div');card.className='project-row selected';card.style.cssText='position:absolute;top:20px;left:20px;width:500px;height:70px;padding:10px';card.innerHTML='<details class=project-more-actions open style=width:44px;margin-left:auto><summary>…</summary><div class=project-more-menu><button>Import</button><button>Rename</button><button>Delete project</button></div></details>';document.body.append(card)");assert.equal(await client.eval("getComputedStyle(document.querySelector('.project-row')).overflow"),'visible');assert.equal(await client.eval("(()=>{const b=document.querySelector('.project-more-menu button:last-child'),r=b.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b;})()"),true);
    });
    await delay(80);assert.deepEqual(client.errors,[],'no late renderer errors after preview removal');
  }catch(error){failure=error;throw error;}finally{
    const cleanupErrors=[];client?.close();
    if(browser&&browser.exitCode===null&&browser.signalCode===null){const exit=new Promise(r=>browser.once('exit',r));browser.kill();try{await bounded(exit,2500,'Browser exit');}catch{browser.kill('SIGKILL');try{await bounded(exit,2500,'Forced browser exit');}catch(error){cleanupErrors.push(error);}}}
    // HTTP close does not close upgraded WebSockets. Retire Vite's transport
    // first, then force-close only connections owned by this fixture.
    try{await bounded(Promise.resolve(vite?.close()),5000,'Vite cleanup');}catch(error){cleanupErrors.push(error);}
    for(const socket of sockets)socket.destroy();
    if(server){server.closeAllConnections?.();try{await bounded(new Promise(r=>server.close(r)),3000,'HTTP fixture cleanup');}catch(error){cleanupErrors.push(error);}}
    unlock();if(temp){assert.ok(path.resolve(temp).startsWith(path.resolve(tmpdir(),'ltds-new-task-test-')));try{rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))cleanupErrors.push(error);}}
    if(cleanupErrors.length){if(failure)failure.message+=`\nCleanup also failed: ${cleanupErrors.map(error=>error.message).join('; ')}`;else throw new AggregateError(cleanupErrors,'Browser fixture cleanup failed');}
  }
});
