import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {acquireBrowserHarnessLock} from './browser-lock.mjs';

// Isolated headless fixture only. No production server, user profile, or live
// browser is attached. Real shipped modules call a synthetic loopback API.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const id='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222';
const token='synthetic_viewer_bearer_1234567890abcdef';
const record={id,name:'Synthetic feed pile',revision:1,modelId:'fixture-model',modelVersionId:'fixture-version',collection:'map',kind:'polygon',vertices:[[0,0,0],[10,0,0],[10,10,0],[0,10,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},source:{kind:'dsm',assetId:'fixture-dsm'}};
// UI-response fixture only: synthetic totals do not derive from the reduced
// display grid. Native integration/source validation has separate backend tests.
const completedResult=()=>({method:'surface-cut-fill',status:'calculated',cutM3:12345.6789,fillM3:2,netM3:12343.6789,coverage:1,source:{assetId:'fixture-dsm',kind:'dsm',modelVersionId:'fixture-version',boundaryElevationBasis:'native-raster'},reference:{type:'boundary-triangulated',offsetM:0},warnings:[],preview:{samples:Array.from({length:121},(_,index)=>{const x=index%11,y=Math.floor(index/11);return [x,y,Math.max(0,6-Math.hypot(x-5,y-5)),0];})}});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const executable=()=>[process.env.CHROME_PATH,process.env.EDGE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);

class Cdp {
  constructor(socket){this.socket=socket;this.sequence=0;this.pending=new Map();this.errors=[];socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')this.errors.push(m.params.exceptionDetails);const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});return new Cdp(socket);}
  command(method,params={}){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},10000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const value=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result?.value;}
  close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Browser fixture closed'));}this.pending.clear();this.socket.close();}
}
async function waitFor(client,expression,label){const until=Date.now()+8000;while(Date.now()<until){if(await client.evaluate(expression))return;await delay(30);}throw new Error(`${label}: ${await client.evaluate("document.body?.innerText??'(document body unavailable)'")} ${JSON.stringify(client.errors)}`);}
const click=(client,selector)=>client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const status=(state)=>`document.querySelector('[data-status]')?.dataset.state===${JSON.stringify(state)}`;
const readiness=Object.freeze({
  module:"document.body?.dataset.ready==='true'",
  workspace:"document.body?.dataset.capabilityChecked==='true'&&document.querySelector('[data-record]')",
  queued:"document.querySelector('[data-status]')?.textContent.includes('Waiting to calculate')",
  cancelled:"document.querySelector('[data-status]')?.textContent.includes('Cancellation requested')",
  restored:"document.querySelector('[data-surface-content]')?.hidden===false",
});
// Page.navigate can acknowledge before document commit. A ready flag from the
// previous fixture must never satisfy the next staff/client navigation.
const readinessAt=(url,expression)=>`location.href===${JSON.stringify(new URL(url).href)}&&(${expression})`;

test('browser readiness predicates tolerate a pre-DOM navigation document',()=>{
  const context={document:{body:null,querySelector:()=>null}};
  for(const [name,expression]of Object.entries({...readiness,success:status('success')}))assert.equal(Boolean(runInNewContext(expression,context)),false,`${name} waits for DOM without throwing`);
  context.document.body={dataset:{ready:'true',capabilityChecked:'true'}};context.document.querySelector=()=>({dataset:{state:'success'},textContent:'Waiting to calculate; Cancellation requested',hidden:false});
  for(const [name,expression]of Object.entries({...readiness,success:status('success')}))assert.equal(Boolean(runInNewContext(expression,context)),true,`${name} still requires its actual ready condition`);
});
test('browser polling propagates actual evaluation failures without retrying or hiding them',async()=>{
  const failure=new Error('real application evaluation failure');let calls=0;
  await assert.rejects(waitFor({evaluate:async()=>{calls++;throw failure;}},readiness.module,'readiness'),error=>error===failure);
  assert.equal(calls,1);
});
test('navigation readiness rejects the previous ready document until the requested URL commits',()=>{
  const requested='http://127.0.0.1:1234/workspace-fixture?staff=1';
  const context={location:{href:'http://127.0.0.1:1234/workspace-fixture?staff=0'},document:{body:{dataset:{ready:'true',capabilityChecked:'true'}},querySelector:()=>({})}};
  const expression=readinessAt(requested,readiness.workspace);
  assert.equal(Boolean(runInNewContext(expression,context)),false,'old client page is not the new staff page');
  context.location.href=requested;context.document.body=null;
  assert.equal(Boolean(runInNewContext(expression,context)),false,'new URL still waits for its body');
  context.document.body={dataset:{capabilityChecked:'true'}};
  assert.equal(Boolean(runInNewContext(expression,context)),true);
  assert.match(readinessAt('http://127.0.0.1:1234',readiness.module),/1234\//,'origin URL normalizes to document trailing slash');
});

function workspacePage(staff){return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{background:#10151b;color:white;font:16px system-ui}#panel{width:300px;max-width:100%;box-sizing:border-box;padding:12px}#view{position:absolute;left:320px;top:20px;width:600px;height:600px}</style><script type="importmap">{"imports":{"three":"/vendor/build/three.module.js","three/addons/":"/vendor/examples/jsm/"}}</script></head><body><aside id="panel"></aside><div id="view"></div><script type="module">
import {createMeasurementWorkspace} from '/measurement-workspace.mjs';
import {createMeasurementSurfaceClient} from '/measurement-surface-client.mjs';
const record=${JSON.stringify(record)},staff=${JSON.stringify(staff)};
const source={assetId:'fixture-dsm',kind:'dsm',format:'tif',methods:['surface-cut-fill']};
const request=createMeasurementSurfaceClient({token:()=>${JSON.stringify(token)},context:()=>({modelId:record.modelId,modelVersionId:record.modelVersionId,audience:staff?'ops':'client',subject:'fixture-person'})});
// This is a synthetic already-authorized broker response, not an authentication
// bypass in shipped code. Actual capability authorization has separate API tests.
const adminRequest=async(operation)=>{if(operation==='capabilities'){await new Promise(resolve=>setTimeout(resolve,100));document.body.dataset.capabilityChecked='true';return {capabilities:{serverCalculations:staff},calculationSources:staff?[source,{assetId:'fixture-obj',kind:'obj',format:'obj',methods:['closed-mesh']}]:[]};}if(operation==='list')return {calculations:[]};document.body.dataset.unexpectedAdminOperation=operation;throw new Error('Synthetic specialist fixture must not submit work');};
const view=document.querySelector('#view'),mapContext={mode:'dsm',element:view,host:view,project:p=>[p[0]*10,p[1]*10],pick:()=>null,viewSignature:()=>'synthetic-static-map'};
createMeasurementWorkspace({panel:document.querySelector('#panel'),context:()=>mapContext,token:()=>${JSON.stringify(token)},permitted:()=>true,toolChanged:()=>{},coordinateReference:()=>record.coordinateReference,toLonLat:p=>p,calculateSurface:()=>{document.body.dataset.browserFallback='true';throw new Error('Browser volume fallback forbidden');},surfaceRequest:request,adminRequest});
document.body.dataset.ready='true';
</script></body></html>`;}

function page(){return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/measurement-workspace.css"><style>body{background:#10151b;color:white;font:16px system-ui}</style><script type="importmap">{"imports":{"three":"/vendor/build/three.module.js","three/addons/":"/vendor/examples/jsm/"}}</script></head><body><button id="open">Open existing pile</button><output id="saved">0</output><script type="module">
import {openSurfaceDialog} from '/measurement-volume-dialog.mjs';
import {createServerSurfaceCalculator} from '/measurement-server-surface.mjs';
import {createMeasurementSurfaceClient} from '/measurement-surface-client.mjs';
const record=${JSON.stringify(record)};
const request=createMeasurementSurfaceClient({token:()=>${JSON.stringify(token)},context:()=>({modelId:record.modelId,modelVersionId:record.modelVersionId,audience:'client',subject:'fixture-person'})});
document.querySelector('#open').onclick=()=>{let current=true;openSurfaceDialog({record,units:'imperial',execution:'server',calculate:createServerSurfaceCalculator({request,isCurrent:()=>current,getRecord:()=>record,pollMs:75}),save:async saved=>{if(!current)throw new Error('stale fixture save');document.querySelector('#saved').value=String(Number(document.querySelector('#saved').value)+1);document.querySelector('#saved').dataset.job=saved.results.calculationJobId;},onClose:()=>{current=false;}});};
document.body.dataset.ready='true';
</script></body></html>`;}

async function fixture(){
  const state={requests:[],job:null,posts:0,deletes:0,mode:'hold',document:structuredClone(record)};
  const server=createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url,'http://fixture.invalid').pathname;
      if(pathname.startsWith('/api/')){
        let raw='';for await(const chunk of req)raw+=chunk;
        state.requests.push({path:pathname,method:req.method,authorization:req.headers.authorization,admin:req.headers['x-viewer-admin-authorization'],cookie:req.headers.cookie,body:raw?JSON.parse(raw):null});
        res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
        if(req.headers.authorization!==`Bearer ${token}`){res.statusCode=403;return res.end(JSON.stringify({code:'personal_measurements_unavailable'}));}
        if(pathname==='/api/v1/measurements')return res.end(JSON.stringify({measurements:new URL(req.url,'http://fixture.invalid').searchParams.get('collection')==='map'?[state.document]:[],capabilities:{personalPersistence:true}}));
        if(pathname===`/api/v1/measurements/${id}`&&req.method==='PUT'){
          const body=JSON.parse(raw);if(body.revision!==state.document.revision){res.statusCode=409;return res.end(JSON.stringify({error:'fixture_revision_conflict'}));}
          state.document={...body,modelId:record.modelId,modelVersionId:record.modelVersionId,revision:body.revision+1};
          if(state.job?.status==='complete'&&state.document.results?.calculationJobId===state.job.id)state.job.attachmentRevision=state.document.revision;
          return res.end(JSON.stringify({measurement:state.document}));
        }
        if(pathname==='/api/v1/measurements/capabilities')return res.end(JSON.stringify({capabilities:{personalPersistence:true,rasterCalculations:true,serverCalculations:false},calculationSources:[{assetId:'fixture-dsm',kind:'dsm',format:'tif',methods:['surface-cut-fill']}]}));
        const base=`/api/v1/measurements/${id}/calculations`;
        if(pathname===base&&req.method==='GET')return res.end(JSON.stringify({calculations:state.job?[state.job]:[]}));
        if(pathname===base&&req.method==='POST'){
          state.posts++;
          if(state.mode==='units'){res.statusCode=422;return res.end(JSON.stringify({code:'measurement_source_vertical_units_required'}));}
          const body=JSON.parse(raw);state.job={id:jobId,measurementId:id,revision:body.revision,method:'surface-cut-fill',status:state.mode==='complete'?'complete':'queued',parameters:{...body,sourceVerticalUnit:body.sourceVerticalUnit??null},...(state.mode==='complete'?{result:completedResult()}:{})};
          res.statusCode=202;return res.end(JSON.stringify({calculation:state.job}));
        }
        if(pathname===`${base}/${jobId}`&&req.method==='DELETE'){state.deletes++;state.job.status='cancelled';res.statusCode=204;return res.end();}
        if(pathname===`${base}/${jobId}`&&req.method==='GET')return res.end(JSON.stringify({calculation:state.job}));
        res.statusCode=404;return res.end(JSON.stringify({code:'fixture_unexpected_route'}));
      }
      if(pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(page());}
      if(pathname==='/workspace-fixture'){res.setHeader('Content-Type','text/html');return res.end(workspacePage(new URL(req.url,'http://fixture.invalid').searchParams.get('staff')==='1'));}
      let file;
      if(/^\/[a-z0-9-]+\.(mjs|css)$/.test(pathname))file=path.join(root,pathname.slice(1));
      if(pathname.startsWith('/vendor/')&&/^\/[a-zA-Z0-9_./-]+$/.test(pathname)){const base=path.join(root,'node_modules','three');const candidate=path.resolve(base,pathname.slice('/vendor/'.length));if(candidate.startsWith(base+path.sep))file=candidate;}
      if(!file||!existsSync(file)){res.statusCode=404;return res.end();}
      // Vite turns side-effect CSS imports into injected styles. Keep the real
      // stylesheet in this source-module fixture without rewriting application JS.
      if(file.endsWith('.css')&&req.headers['sec-fetch-dest']==='script'){
        res.setHeader('Content-Type','application/javascript');return res.end(`const style=document.createElement('style');style.textContent=${JSON.stringify(readFileSync(file,'utf8'))};document.head.append(style);`);
      }
      res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(readFileSync(file));
    }catch(error){res.statusCode=500;res.end(String(error));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {state,server,origin:`http://127.0.0.1:${server.address().port}`};
}

test('normal server inspector uses real browser UI for queued completion, resume, missing units and cancellation',{timeout:90000},async t=>{
  const binary=executable();if(!binary){t.skip('Chromium-family browser is required for isolated server-inspector QA.');return;}
  const unlock=await acquireBrowserHarnessLock({root});let browser,client,profile,server;
  try{
    const f=await fixture();server=f.server;const s=f.state;
    profile=mkdtempSync(path.join(tmpdir(),'ltds-measurement-server-browser-'));
    browser=spawn(binary,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const portFile=path.join(profile,'DevToolsActivePort'),until=Date.now()+10000;
    while(!existsSync(portFile)&&Date.now()<until)await delay(50);
    assert.ok(existsSync(portFile),'isolated browser startup');
    const port=readFileSync(portFile,'utf8').split(/\r?\n/)[0];
    const tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client=await Cdp.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await client.command('Runtime.enable');await client.command('Page.enable');
    await client.command('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await client.command('Page.navigate',{url:f.origin});
    await waitFor(client,readinessAt(f.origin,readiness.module),'module readiness');

    await t.test('queued work reopens without duplicate and produces inspectable native-result preview',async()=>{
      await click(client,'#open');assert.equal(s.posts,0,'opening does not submit');
      await click(client,'[data-calculate]');
      await waitFor(client,readiness.queued,'queued status');
      assert.equal(s.posts,1);assert.equal(await client.evaluate("document.querySelector('[data-calculate]').disabled"),true);
      await click(client,'[data-close]');await waitFor(client,"!document.querySelector('dialog')",'closed');
      await click(client,'#open');await click(client,'[data-calculate]');
      await waitFor(client,readiness.queued,'resumed status');
      assert.equal(s.posts,1,'resume must not create another job');
      s.job.status='complete';s.job.result=completedResult();
      await waitFor(client,status('success'),'complete UI');
      assert.equal(await client.evaluate("document.querySelector('#saved').value"),'1');
      assert.equal(await client.evaluate("document.querySelector('[data-preview-content]').hidden"),false);
      assert.match(await client.evaluate("document.querySelector('[data-result=cut]').textContent"),/,/);
      await client.evaluate("document.querySelector('[data-section-chart]').focus()");
      await client.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Home',code:'Home',windowsVirtualKeyCode:36});
      await client.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Home',code:'Home',windowsVirtualKeyCode:36});
      assert.match(await client.evaluate("document.querySelector('[data-readout]').textContent"),/Surface .*Base/);
      const box=await client.evaluate("(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})()");
      assert.ok(box.left>=0&&box.right<=1280&&box.top>=0&&box.bottom<=900,'dialog remains in viewport');
      if(process.env.LTDS_MEASUREMENT_BROWSER_SCREENSHOT){const shot=await client.command('Page.captureScreenshot',{format:'png'});writeFileSync(process.env.LTDS_MEASUREMENT_BROWSER_SCREENSHOT,Buffer.from(shot.data,'base64'));}
      await click(client,'[data-close]');await waitFor(client,"!document.querySelector('dialog')",'close completed');
      await click(client,'#open');await click(client,'[data-calculate]');await waitFor(client,status('success'),'retrieve complete');assert.equal(s.posts,1,'completed matching result reused');
      await click(client,'[data-close]');await waitFor(client,"!document.querySelector('dialog')",'close retrieved');
    });

    await t.test('missing source units fails plainly without guessing or a browser fallback',async()=>{
      s.job=null;s.mode='units';const saved=await client.evaluate("document.querySelector('#saved').value");
      await click(client,'#open');await click(client,'[data-calculate]');await waitFor(client,status('error'),'unit error');
      assert.match(await client.evaluate("document.querySelector('[data-status]').textContent"),/height units verified/);
      assert.equal(await client.evaluate("document.querySelector('[name=metres]')===null"),true);
      assert.equal(await client.evaluate("document.querySelector('.surface-settings').hidden"),true,'an error cannot expose staff settings to clients');
      assert.doesNotMatch(await client.evaluate("document.querySelector('.surface-inspector').innerText"),/\bDSM\b|\bDTM\b|Advanced settings|Specialist/);
      assert.equal(await client.evaluate("document.querySelector('#saved').value"),saved);
      assert.equal(await client.evaluate("document.querySelector('[data-preview-content]').hidden"),true);
      assert.equal(s.requests.filter(r=>r.method==='POST').at(-1).body.sourceVerticalUnit,undefined);
      await click(client,'[data-close]');await waitFor(client,"!document.querySelector('dialog')",'close unit error');
    });

    await t.test('cancel action stops owned queued work without saving a result',async()=>{
      s.job=null;s.mode='hold';const saved=await client.evaluate("document.querySelector('#saved').value");
      await click(client,'#open');await click(client,'[data-calculate]');await waitFor(client,"document.querySelector('[data-cancel-job]')?.hidden===false",'cancel available');
      await click(client,'[data-cancel-job]');await waitFor(client,readiness.cancelled,'cancel acknowledgement');
      assert.equal(s.deletes,1);assert.equal(s.job.status,'cancelled');assert.equal(await client.evaluate("document.querySelector('#saved').value"),saved);
      assert.equal(await client.evaluate("document.querySelector('[data-calculate]').disabled"),false);
    });
    assert.ok(s.requests.length>5);assert.ok(s.requests.every(r=>r.path.startsWith('/api/v1/measurements/')&&!r.admin&&!r.cookie&&r.authorization===`Bearer ${token}`),'all volume traffic uses narrow personal server API, without workspace authority/cookies');
    await t.test('client and staff polygon rows share one Calculate volume inspector with authorized inline specialist tools',async()=>{
      const postCount=s.posts;
      for(const staff of [false,true]){
        const workspaceUrl=`${f.origin}/workspace-fixture?staff=${staff?1:0}`;
        await client.command('Page.navigate',{url:workspaceUrl});
        await waitFor(client,readinessAt(workspaceUrl,readiness.workspace),'loaded personal workspace');
        assert.equal(await client.evaluate("document.querySelectorAll('[data-record] [data-m=volume]').length"),1);
        assert.equal(await client.evaluate("document.querySelector('[data-record] [data-m=volume]').textContent"),'Calculate volume');
        assert.equal(await client.evaluate("document.querySelectorAll('[data-record] [data-m=admin-volume]').length"),0,'no duplicate advanced row action');
        await click(client,'[data-record] [data-m=volume]');
        await waitFor(client,"document.querySelector('.surface-inspector')?.open===true",'common inspector');
        assert.equal(await client.evaluate("document.querySelector('.surface-inspector h2').textContent"),'Calculate volume');
        assert.equal(await client.evaluate("document.querySelectorAll('.surface-specialist').length"),staff?1:0);
        assert.equal(await client.evaluate("document.querySelector('.surface-settings').hidden"),!staff);
        assert.equal(await client.evaluate("document.querySelector('[name=source]').disabled"),!staff);
        assert.equal(await client.evaluate("document.querySelector('[name=reference]').disabled"),!staff);
        assert.match(await client.evaluate("document.querySelector('[data-area]').textContent"),/1,076\.391 ft²/);
        if(!staff)assert.doesNotMatch(await client.evaluate("document.querySelector('.surface-inspector').innerText"),/\bDSM\b|\bDTM\b|Specialist|Advanced settings|Elevation surface/);
        assert.equal(await client.evaluate("document.querySelectorAll('dialog[open]').length"),1);
        if(staff){
          assert.match(await client.evaluate("document.querySelector('.surface-specialist summary').textContent"),/Specialist methods.*staff only/);
          await click(client,'.surface-specialist summary');
          await waitFor(client,"document.querySelector('[data-specialist-host] .measurement-specialist-panel')",'inline authorized specialist panel');
          assert.equal(await client.evaluate("document.querySelectorAll('dialog[open]').length"),1,'specialist is not a second modal');
          assert.equal(await client.evaluate("document.querySelector('[data-surface-content]').hidden"),true);
          await click(client,'.surface-specialist summary');
          await waitFor(client,readiness.restored,'native surface restored');
        }
        assert.equal(await client.evaluate("document.body.dataset.unexpectedAdminOperation||null"),null,'opening does not start specialist work');
        assert.equal(await client.evaluate("document.body.dataset.browserFallback||null"),null);
        assert.equal(s.posts,postCount,'inspection alone does not submit raster work');
        if(process.env.LTDS_MEASUREMENT_BROWSER_SCREENSHOT){const shot=await client.command('Page.captureScreenshot',{format:'png'});writeFileSync(process.env.LTDS_MEASUREMENT_BROWSER_SCREENSHOT.replace(/\.png$/i,staff?'-staff.png':'-client.png'),Buffer.from(shot.data,'base64'));}
        await click(client,'[data-close]');await waitFor(client,"!document.querySelector('dialog')",'closed common inspector');
      }
    });
    await t.test('reopening through the real workspace reuses a completed job after result attachment increments revision',async()=>{
      s.job=null;s.mode='complete';s.document=structuredClone(record);const postCount=s.posts;
      const recoveryUrl=`${f.origin}/workspace-fixture?staff=0`;
      await client.command('Page.navigate',{url:recoveryUrl});
      await waitFor(client,readinessAt(recoveryUrl,readiness.workspace),'loaded recovery workspace');
      await click(client,'[data-record] [data-m=volume]');await click(client,'[data-calculate]');await waitFor(client,status('success'),'attached first result');
      assert.equal(s.document.revision,2);assert.equal(s.document.results.calculationJobId,jobId);assert.equal(s.posts,postCount+1);
      await click(client,'[data-close]');await waitFor(client,"!document.querySelector('dialog')",'close after attachment');
      await click(client,'[data-record] [data-m=volume]');await waitFor(client,status('saved'),'restored saved result');
      assert.equal(s.posts,postCount+1,'opening saved inspector never creates another job');
      await click(client,'[data-calculate]');await waitFor(client,status('success'),'retrieved attached job at later revision');
      assert.equal(s.document.revision,3);assert.equal(s.posts,postCount+1,'same attached geometry/result must be recovered without another POST');
      assert.equal(await client.evaluate("document.querySelector('[data-preview-content]').hidden"),false);
      assert.equal(await client.evaluate("document.body.dataset.browserFallback||null"),null);
    });
    assert.deepEqual(client.errors,[],'no browser module/runtime exceptions');
  }finally{
    client?.close();if(browser){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,delay(3000)]);}
    if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
    unlock();
    if(profile){const absolute=path.resolve(profile),prefix=path.resolve(tmpdir(),'ltds-measurement-server-browser-');assert.ok(absolute.startsWith(prefix));try{rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))throw error;t.diagnostic(`Browser retained a lock on isolated temporary profile ${absolute}`);}}
  }
});
