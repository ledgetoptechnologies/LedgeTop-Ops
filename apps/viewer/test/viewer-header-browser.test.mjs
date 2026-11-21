import { waitForDevToolsPort } from './devtools-port.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireBrowserHarnessLock} from './browser-lock.mjs';

// Real shipped header/CSS and navigation/workspace modules in a fresh hidden
// browser. The surface, session, recovery flag and destination spy are local
// fixtures: this does not exercise real model rendering, authentication or TLS.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(path.join(root,'index.html'),'utf8');
const css=source.match(/<style>([\s\S]*?)<\/style>/)?.[1];
const header=source.match(/<header id="topbar">[\s\S]*?<\/header>/)?.[0];
// View modes live in the left rail beside the work area (same shell as Operations and the Client Portal).
const rail=source.match(/<nav id="viewer-rail"[\s\S]*?<\/nav>/)?.[0];
assert.ok(css&&header&&rail);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const binary=()=>[process.env.CHROME_PATH,process.env.EDGE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
class Cdp{
  constructor(socket){this.socket=socket;this.sequence=0;this.pending=new Map();socket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});return new Cdp(socket);}
  command(method,params={}){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},10000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const value=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result?.value;}
  close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Fixture closed'));}this.pending.clear();this.socket.close();}
}
const project='County Road D — Stockpile Survey — A deliberately long accessible project name with the full survey date and source collection description retained for accessible text and the title tooltip';
function page(){const logo=`data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="38" height="38"><rect width="38" height="38" fill="orange"/></svg>').toString('base64')}`;return `<!doctype html><meta name="viewport" content="width=device-width"><style>${css}</style><script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script><div id="app">${header.replace(/src="[^"]+"/,`src="${logo}"`)}<div id="main">${rail}<aside id="panel-measure" style="width:300px;flex-shrink:0;overflow:auto"><h2>Measurements</h2></aside><div id="fixture-surface" style="flex:1;position:relative;min-width:0"><canvas width="850" height="600" style="width:100%;height:100%"></canvas></div></div></div><script type="module">
import {renderStaffNavigation,installStaffNavigationGuard,hasUnfinishedMeasurements} from '/viewer-staff-navigation.mjs';
import {createMeasurementWorkspace} from '/measurement-workspace.mjs';
const variant=new URL(location.href).searchParams.get('variant')||'ops';
const nodes={container:document.querySelector('#staff-navigation'),dashboard:document.querySelector('#staff-dashboard'),models:document.querySelector('#staff-models'),logo:document.querySelector('#staff-logo'),company:document.querySelector('#brand-company')};
const session={audience:variant==='client'?'client':'ops',operationsOrigin:location.origin};
const context={viewMode:variant==='admin'?'admin':variant==='public'?'view':'session',topLevel:variant!=='embed'};
window.applyNavigation=()=>renderStaffNavigation(nodes,session,context);
window.setNavigationSession=changes=>{Object.assign(session,changes);return applyNavigation();};
applyNavigation();
document.querySelector('#admin-controls').style.display=variant==='admin'?'flex':'none';
const title=document.querySelector('#brand-project');title.textContent=${JSON.stringify(project)};title.title=title.textContent;
window.clicked=[];window.navigations=[];window.recoveryPending=false;
for(const button of document.querySelectorAll('.tab-btn'))button.onclick=()=>clicked.push(button.dataset.mode);
const host=document.querySelector('#fixture-surface'),canvas=host.querySelector('canvas'),reference={crs:'EPSG:32616',verticalUnit:'m'};
const workspace=createMeasurementWorkspace({panel:document.querySelector('#panel-measure'),context:()=>({mode:'model',element:canvas,host,pick:()=>[0,0,0],project:p=>[p[0]*10,p[1]*10]}),token:()=>null,permitted:()=>true,coordinateReference:()=>reference,toLonLat:()=>[-87,43],toolChanged:()=>{}});
window.workspace=workspace;
workspace.tick();
window.hasUnfinished=()=>hasUnfinishedMeasurements(workspace,{hasPending:()=>recoveryPending});
window.removeNavigationGuard=installStaffNavigationGuard({container:nodes.container,links:[nodes.dashboard,nodes.models,nodes.logo],hasUnfinishedWork:hasUnfinished,navigate:href=>navigations.push(href)});
// A listener after the production guard records its cancel decision and then
// suppresses native navigation only for the fixture; no real destinations open.
window.activateNavigation=(id,options={})=>{const anchor=document.getElementById(id),event=new MouseEvent('click',{bubbles:true,cancelable:true,button:0,...options});let intercepted;anchor.addEventListener('click',e=>{intercepted=e.defaultPrevented;e.preventDefault();},{once:true});anchor.dispatchEvent(event);return intercepted;};
window.makeDraft=async()=>workspace.restoreDraft({draft:{id:'fixture-draft',name:'Unfinished fixture polygon',kind:'polygon',collection:'spatial3d',vertices:[[0,0,0],[10,0,0],[10,10,0]],coordinateReference:reference,visible:true,source:{kind:'mesh'}},editing:false,volumeIntent:false,displayVertices:null,mode:'model',coordinateReference:reference});
window.makeEditing=async()=>{await workspace.store.save({id:'fixture-saved',name:'Saved fixture polygon',kind:'polygon',collection:'spatial3d',vertices:[[0,0,0],[10,0,0],[10,10,0]],coordinateReference:reference,visible:true,source:{kind:'mesh'}});document.querySelector('[data-record="fixture-saved"] [data-m="edit-record"]').click();return workspace.exportDraft()?.editing===true;};
window.snapshot=()=>({draft:workspace.exportDraft(),records:[...workspace.store.records],statuses:[...workspace.store.statuses],recoveryPending});
document.body.dataset.ready='true';
</script>`;}

function serve(req,res){
  const pathname=new URL(req.url,'http://127.0.0.1').pathname;
  let file;
  if(/^\/[a-z0-9-]+\.mjs$/.test(pathname))file=path.join(root,pathname.slice(1));
  else if(/^\/three\/[a-zA-Z0-9_./-]+\.js$/.test(pathname)){
    const base=path.join(root,'node_modules','three');file=path.resolve(base,pathname.slice('/three/'.length));
    if(!file.startsWith(`${base}${path.sep}`)){res.writeHead(403).end();return;}
  }
  if(file){
    if(!existsSync(file)){res.writeHead(404).end();return;}
    // The browser receives actual production JS; only bundler-only CSS import
    // statements are removed. Header/dialog CSS above is the shipped CSS.
    res.setHeader('Content-Type','text/javascript; charset=utf-8');res.end(readFileSync(file,'utf8').replace(/^import\s+['"][^'"]+\.css['"];?\s*$/gm,''));return;
  }
  if(pathname!=='/'){res.writeHead(404).end();return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page());
}

test('shipped Viewer header and same-tab measurement leave guard in an isolated browser',{timeout:90000},async t=>{
  const executable=binary();if(!executable){t.skip('Chromium-family browser required for isolated header regression.');return;}
  const unlock=await acquireBrowserHarnessLock({root});let browser,client,profile,server;
  try{
    server=createServer(serve);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
    profile=mkdtempSync(path.join(tmpdir(),'ltds-viewer-header-'));
    browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const port=await waitForDevToolsPort(path.join(profile,'DevToolsActivePort')),tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();client=await Cdp.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await client.command('Runtime.enable');await client.command('Page.enable');
    async function open(variant='ops',width=1280){
      await client.command('Emulation.setDeviceMetricsOverride',{width,height:912,deviceScaleFactor:1,mobile:false});const url=`${origin}/?variant=${variant}&width=${width}`;await client.command('Page.navigate',{url});const until=Date.now()+8000;while(Date.now()<until){if(await client.evaluate(`location.href===${JSON.stringify(url)}&&document.body?.dataset.ready==='true'`))return;await delay(25);}throw new Error(`Fixture did not become ready: ${variant}/${width}`);
    }
    async function click(selector){const r=await client.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await client.command('Input.dispatchMouseEvent',{type:'mousePressed',...r,button:'left',clickCount:1});await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',...r,button:'left',clickCount:1});}
    for(const width of [375,768,1024,1280])for(const variant of ['ops','admin','public'])await t.test(`${width}px ${variant} header`,async()=>{
      await open(variant,width);
      const out=await client.evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width};};const staff=document.querySelector('#staff-navigation'),dashboard=document.querySelector('#staff-dashboard'),models=document.querySelector('#staff-models'),title=document.querySelector('#brand-project');return {viewport:innerWidth,doc:document.documentElement.scrollWidth,header:rect(document.querySelector('#topbar')),brand:rect(document.querySelector('#brand-info')),title:{...rect(title),scrollWidth:title.scrollWidth,clientWidth:title.clientWidth,tooltip:title.title},text:title.textContent,whiteSpace:getComputedStyle(title).whiteSpace,main:rect(document.querySelector('#main')),nav:rect(document.querySelector('#view-tabs')),staff:{...rect(staff),hidden:staff.hidden,dashboardVisible:getComputedStyle(dashboard).display!=='none',modelsLabel:models.getAttribute('aria-label'),dashboardHref:dashboard.getAttribute('href'),modelsHref:models.getAttribute('href'),logoHref:document.querySelector('#staff-logo').getAttribute('href'),companyHidden:document.querySelector('#brand-company').hidden},buttons:[...document.querySelectorAll('.tab-btn')].map(e=>({...rect(e),label:e.getAttribute('aria-label'),mode:e.dataset.mode}))};})()`);
      assert.equal(out.text,project,'full title remains in accessible text');assert.equal(out.whiteSpace,'nowrap');assert.ok(out.title.height<20);assert.ok(out.brand.height<40,JSON.stringify(out));assert.ok(out.doc<=width);assert.ok(out.main.top>=out.header.bottom-1);assert.ok(out.brand.top>=out.header.top&&out.brand.bottom<=out.header.bottom);assert.ok(out.nav.left>=0&&out.nav.right<=width);assert.ok(out.nav.top>=out.header.bottom-1,'view modes sit below the header in the rail');assert.ok(out.header.height<=110,JSON.stringify(out));
      for(const button of out.buttons){assert.ok(button.label);assert.ok(button.width>=30&&button.height>=28);assert.ok(button.left>=0&&button.right<=width);await client.command('Input.dispatchMouseEvent',{type:'mousePressed',x:(button.left+button.right)/2,y:(button.top+button.bottom)/2,button:'left',clickCount:1});await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:(button.left+button.right)/2,y:(button.top+button.bottom)/2,button:'left',clickCount:1});}
      assert.deepEqual(await client.evaluate('clicked'),['model','cloud','ortho','dsm','dtm']);if(width>1024)assert.equal(out.header.height,60,'desktop stays a single fixed-height row');
      // With the view modes in the rail, a wide desktop topbar can fit the whole title; narrower ones truncate it.
      if(width<=1024)assert.ok(out.title.scrollWidth>out.title.clientWidth,'long title truncates');assert.equal(out.title.tooltip,project);
      assert.equal(out.staff.hidden,variant!=='ops');assert.equal(out.staff.companyHidden,variant==='ops');
      if(variant==='ops'){
        assert.equal(out.staff.dashboardHref,`${origin}/`);assert.equal(out.staff.modelsHref,`${origin}/viewer`);assert.equal(out.staff.logoHref,`${origin}/`);assert.equal(out.staff.modelsLabel,'Back to Models');assert.equal(out.staff.dashboardVisible,width>640);
        assert.ok(out.staff.top>=out.header.top&&out.staff.bottom<=out.header.bottom);
        const overlap=out.staff.left<out.nav.right&&out.staff.right>out.nav.left&&out.staff.top<out.nav.bottom&&out.staff.bottom>out.nav.top;assert.equal(overlap,false,'breadcrumb does not overlap mode tabs');
        if(process.env.VIEWER_HEADER_SCREENSHOT_DIR&&[375,1280].includes(width)){
          const directory=path.resolve(process.env.VIEWER_HEADER_SCREENSHOT_DIR);mkdirSync(directory,{recursive:true});
          const screenshot=await client.command('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width,height:Math.ceil(out.header.height),scale:1}});
          const filename=path.join(directory,`viewer-header-${width}.png`);writeFileSync(filename,Buffer.from(screenshot.data,'base64'));t.diagnostic(`Synthetic header screenshot: ${filename}`);
        }
      }else{assert.equal(out.staff.dashboardHref,null);assert.equal(out.staff.modelsHref,null);assert.equal(out.staff.logoHref,null);}
    });
    for(const variant of ['client','embed'])await t.test(`${variant} session has no staff destinations`,async()=>{await open(variant);assert.deepEqual(await client.evaluate(`({hidden:document.querySelector('#staff-navigation').hidden,hrefs:['staff-dashboard','staff-models','staff-logo'].map(id=>document.getElementById(id).getAttribute('href'))})`),{hidden:true,hrefs:[null,null,null]});});
    for(const state of ['draft','editing'])await t.test(`${state}: Stay and Escape preserve actual measurement workspace state; Leave exits once`,async()=>{
      await open();assert.equal(await client.evaluate(state==='draft'?'makeDraft()':'makeEditing()'),true);const snapshot=await client.evaluate('snapshot()');assert.ok(snapshot.draft);if(state==='editing')assert.equal(snapshot.draft.editing,true);
      assert.equal(await client.evaluate(`activateNavigation('staff-models')`),true);assert.equal(await client.evaluate(`document.querySelector('dialog')?.open`),true);assert.equal(await client.evaluate(`document.activeElement?.hasAttribute('data-stay')`),true);await click('[data-stay]');assert.deepEqual(await client.evaluate('snapshot()'),snapshot);assert.equal(await client.evaluate('navigations.length'),0);
      assert.equal(await client.evaluate(`activateNavigation('staff-models')`),true);await client.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});await client.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27,nativeVirtualKeyCode:27});assert.equal(await client.evaluate(`document.querySelector('dialog')===null`),true);assert.deepEqual(await client.evaluate('snapshot()'),snapshot);
      assert.equal(await client.evaluate(`activateNavigation('staff-models')`),true);await client.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',unmodifiedText:'\r',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});await client.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,nativeVirtualKeyCode:13});assert.equal(await client.evaluate(`document.querySelector('dialog')===null`),true,'Enter activates focused Stay without finishing the measurement');assert.deepEqual(await client.evaluate('snapshot()'),snapshot);
      assert.equal(await client.evaluate(`activateNavigation('staff-models')`),true);assert.equal(await client.evaluate(`activateNavigation('staff-models')`),true);assert.equal(await client.evaluate(`document.querySelectorAll('dialog').length`),1);await click('[data-leave]');assert.deepEqual(await client.evaluate('navigations'),[`${origin}/viewer`]);assert.deepEqual(await client.evaluate('snapshot()'),snapshot,'navigation spy does not alter the draft before departure');
    });
    await t.test('clean navigation is native; modifier and middle activations do not discard this tab',async()=>{
      await open();assert.equal(await client.evaluate(`activateNavigation('staff-models')`),false);assert.equal(await client.evaluate(`document.querySelector('dialog')===null`),true);assert.equal(await client.evaluate('makeDraft()'),true);const snapshot=await client.evaluate('snapshot()');
      for(const options of [{ctrlKey:true},{metaKey:true},{shiftKey:true},{altKey:true},{button:1}])assert.equal(await client.evaluate(`activateNavigation('staff-models',${JSON.stringify(options)})`),false);
      assert.equal(await client.evaluate(`document.querySelector('dialog')===null`),true);assert.deepEqual(await client.evaluate('snapshot()'),snapshot);
    });
    for(const state of ['recovery','Saving…','Not saved: fixture rejection'])await t.test(`${state} remains protected without an active drawing`,async()=>{
      await open();await client.evaluate(state==='recovery'?`recoveryPending=true`:`workspace.store.statuses.set('fixture',${JSON.stringify(state)})`);assert.equal(await client.evaluate('workspace.isDrawing()'),false);assert.equal(await client.evaluate(`activateNavigation('staff-models')`),true);await click('[data-stay]');assert.equal(await client.evaluate('hasUnfinished()'),true);
    });
    for(const id of ['staff-dashboard','staff-logo'])await t.test(`${id} protects a real unfinished measurement`,async()=>{
      await open();await client.evaluate('makeDraft()');const snapshot=await client.evaluate('snapshot()');assert.equal(await client.evaluate(`activateNavigation(${JSON.stringify(id)})`),true);await click('[data-stay]');assert.deepEqual(await client.evaluate('snapshot()'),snapshot);assert.equal(await client.evaluate(`activateNavigation(${JSON.stringify(id)})`),true);await click('[data-leave]');assert.deepEqual(await client.evaluate('navigations'),[`${origin}/`]);
    });
    await t.test('renewal removing staff eligibility prevents a confirmed stale departure',async()=>{
      await open();await client.evaluate('makeDraft()');assert.equal(await client.evaluate(`activateNavigation('staff-models')`),true);assert.equal(await client.evaluate(`setNavigationSession({audience:'client'})`),false);await click('[data-leave]');assert.deepEqual(await client.evaluate('navigations'),[]);
    });
    await t.test('renewal changing the eligible Operations origin prevents a stale confirmed destination',async()=>{
      await open();await client.evaluate('makeDraft()');assert.equal(await client.evaluate(`activateNavigation('staff-models')`),true);assert.equal(await client.evaluate(`setNavigationSession({operationsOrigin:'http://localhost:1234'})`),true);assert.equal(await client.evaluate(`document.querySelector('#staff-models').href`),'http://localhost:1234/viewer');await click('[data-leave]');assert.deepEqual(await client.evaluate('navigations'),[]);
    });
  }finally{
    client?.close();if(browser){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,delay(3000)]);}if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}unlock();
    if(profile){const absolute=path.resolve(profile);assert.ok(absolute.startsWith(path.resolve(tmpdir(),'ltds-viewer-header-')));try{rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))throw error;t.diagnostic(`Browser retained isolated temporary profile lock: ${absolute}`);}}
  }
});
