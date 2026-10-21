import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireBrowserHarnessLock} from './browser-lock.mjs';

// Fresh hidden browser/profile and loopback synthetic source only. Never attach
// to the user's browser. The real workspace emits SVG using shipped projection.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const record={id:'11111111-1111-4111-8111-111111111111',name:'Close-zoom boundary',revision:7,modelId:'fixture-model',modelVersionId:'fixture-version',collection:'spatial3d',kind:'polygon',vertices:[[-.5,-.5,-4],[.5,-.5,-4],[.5,-.5,2],[-.5,-.5,2]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},visible:true};
const token='synthetic_closezoom_viewer_token_1234567890';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const browserPath=()=>[process.env.CHROME_PATH,process.env.EDGE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
class Cdp{
  constructor(socket){this.socket=socket;this.sequence=0;this.pending=new Map();this.errors=[];socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')this.errors.push(m.params.exceptionDetails);const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});return new Cdp(socket);}
  command(method,params={}){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},10000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const value=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result?.value;}
  close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Fixture closed'));}this.pending.clear();this.socket.close();}
}
async function waitFor(client,expression){const until=Date.now()+8000;while(Date.now()<until){if(await client.evaluate(expression))return;await delay(30);}throw new Error(`Overlay fixture not ready: ${JSON.stringify(client.errors)}`);}
function page(){return `<!doctype html><html><head><style>body{background:#121820;color:white;font:14px system-ui}#panel{position:absolute;left:830px;top:0;width:290px}#view{position:relative;width:800px;height:600px;background:#1a2634;overflow:hidden}.fixture-actions{margin-top:12px}</style><script type="importmap">{"imports":{"three":"/vendor/build/three.module.js","three/addons/":"/vendor/examples/jsm/"}}</script></head><body><div id="view"></div><div class="fixture-actions"><button data-camera="8">Zoom out</button><button data-camera="0">Behind-camera corners</button><button data-camera="2.05">Near-plane corners</button><button data-camera="-5">All behind</button></div><aside id="panel"></aside><script type="module">
import * as THREE from 'three';
import {createMeasurementWorkspace} from '/measurement-workspace.mjs';
import {projectMeasurementBoundary} from '/measurement-projection.mjs';
const view=document.querySelector('#view'),camera=new THREE.PerspectiveCamera(60,800/600,.1,100),vp=new THREE.Matrix4();
const clip=point=>new THREE.Vector4(...point,1).applyMatrix4(vp).toArray();
const context={mode:'model',element:view,host:view,pick:()=>null,project:(point,viewport)=>projectMeasurementBoundary([clip(point)],viewport).positions[0],projectBoundary:(points,viewport,options)=>projectMeasurementBoundary(points.map(clip),viewport,options),viewSignature:()=>String(camera.position.z)};
const workspace=createMeasurementWorkspace({panel:document.querySelector('#panel'),context:()=>context,token:()=>${JSON.stringify(token)},permitted:()=>true,toolChanged:()=>{},coordinateReference:()=>(${JSON.stringify(record.coordinateReference)}),toLonLat:p=>p});
function cameraAt(z){camera.position.z=z;camera.updateMatrixWorld(true);vp.multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);workspace.tick({force:true});document.body.dataset.camera=String(z);}
for(const button of document.querySelectorAll('[data-camera]'))button.onclick=()=>cameraAt(Number(button.dataset.camera));
// Read-only test oracle over the real store, not the immutable fixture constant.
window.fixtureSnapshot=()=>JSON.stringify([...workspace.store.records.values()]);
cameraAt(8);document.body.dataset.ready='true';
</script></body></html>`;}
async function fixture(){
  const requests=[];
  const server=createServer(async(req,res)=>{try{
    const url=new URL(req.url,'http://fixture.invalid');
    if(url.pathname.startsWith('/api/')){requests.push({method:req.method,path:url.pathname});res.setHeader('Content-Type','application/json');if(req.method!=='GET'||req.headers.authorization!==`Bearer ${token}`){res.statusCode=403;return res.end('{}');}return res.end(JSON.stringify({measurements:url.searchParams.get('collection')==='spatial3d'?[record]:[],capabilities:{personalPersistence:true}}));}
    if(url.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(url.searchParams.has('rendered')?renderedPage():url.searchParams.has('sidebar')?sidebarPage():url.searchParams.has('editor')?editorPage():page());}
    let file;if(/^\/[a-z0-9-]+\.(mjs|css)$/.test(url.pathname))file=path.join(root,url.pathname.slice(1));
    if(url.pathname.startsWith('/vendor/')&&/^\/[a-zA-Z0-9_./-]+$/.test(url.pathname)){const base=path.join(root,'node_modules','three'),candidate=path.resolve(base,url.pathname.slice(8));if(candidate.startsWith(base+path.sep))file=candidate;}
    if(!file||!existsSync(file)){res.statusCode=404;return res.end();}
    if(file.endsWith('.css')&&req.headers['sec-fetch-dest']==='script'){res.setHeader('Content-Type','application/javascript');return res.end(`const style=document.createElement('style');style.textContent=${JSON.stringify(readFileSync(file,'utf8'))};document.head.append(style);`);}
    res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(readFileSync(file));
  }catch(error){res.statusCode=500;res.end(String(error));}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));return{server,requests,origin:`http://127.0.0.1:${server.address().port}/`};
}
const overlay=client=>client.evaluate(`(()=>{const svg=document.querySelector('#view .measurement-overlay');return{markup:svg?.innerHTML||'',lines:[...svg.querySelectorAll('line')].map(line=>['x1','y1','x2','y2'].map(a=>Number(line.getAttribute(a)))),circles:[...svg.querySelectorAll('circle')].map(c=>['cx','cy','r'].map(a=>Number(c.getAttribute(a)))),fills:[...svg.querySelectorAll('polygon')].map(p=>({stroke:p.getAttribute('stroke'),points:p.getAttribute('points')}))};})()`);
function renderedPage(){return `<!doctype html><html><head><style>body{margin:0}#view{position:relative;width:800px;height:600px}#panel{position:absolute;left:820px;top:0;width:300px;height:600px;overflow:auto}</style><script type="importmap">{"imports":{"three":"/vendor/build/three.module.js","three/addons/":"/vendor/examples/jsm/"}}</script></head><body><div id="view"></div><aside id="panel"></aside><script type="module">
import * as THREE from 'three';
import {createMeasurementWorkspace} from '/measurement-workspace.mjs';
import {resolveRenderedMeshBoundary,resolveRenderedPointBoundary} from '/measurement-rendered-surface.mjs';
const view=document.querySelector('#view'),crs={crs:'EPSG:32616',verticalUnit:'m'},vertices=[[100,100,0],[300,100,0],[300,300,0],[100,300,0]];
const mesh=new THREE.Mesh(new THREE.PlaneGeometry(400,400),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));mesh.rotation.x=-Math.PI/2;mesh.position.set(200,20,-200);mesh.updateMatrixWorld(true);
const points=[];for(let e=0;e<=400;e+=10)for(let n=0;n<=400;n+=10)points.push(e,n,30);
const positions=new THREE.Float32BufferAttribute(points,3),matrixWorld=new THREE.Matrix4(),bounds=new THREE.Box3(new THREE.Vector3(0,0,30),new THREE.Vector3(400,400,30));
let mode='model',permission=true;
const project=p=>[p[0],p[1]-(mode==='model'||mode==='cloud'?p[2]:0)];
function pick(event){const r=view.getBoundingClientRect(),x=event.clientX-r.left,y=event.clientY-r.top;if(mode==='model'){const ray=new THREE.Raycaster(new THREE.Vector3(x,100,-y-100),new THREE.Vector3(0,-1,1).normalize());const hit=ray.intersectObject(mesh)[0];return hit?[hit.point.x,-hit.point.z,hit.point.y]:null;}if(mode==='cloud'){let best=null,distance=Infinity;for(let i=0;i<positions.count;i++){const p=[positions.getX(i),positions.getY(i),positions.getZ(i)],screen=project(p),d=Math.hypot(screen[0]-x,screen[1]-y);if(d<distance){best=p;distance=d;}}return distance<=8?best:null;}return [x,y,0];}
const context={get mode(){return mode;},element:view,host:view,pick,project,viewSignature:()=>mode,getDisplaySurfaceRevision:()=>mode,
resolveRenderedDisplayVertices:(record,{signal})=>mode==='cloud'?resolveRenderedPointBoundary({record,expectedCrs:crs.crs,nodes:[{positions,matrixWorld,spacing:10,bounds}],signal,surfaceRevision:mode}):resolveRenderedMeshBoundary({record,expectedCrs:crs.crs,roots:[mesh],worldBounds:new THREE.Box3().setFromObject(mesh),toWorld:(e,n,z)=>new THREE.Vector3(e,z,-n),fromWorld:p=>[p.x,-p.z,p.y],signal,surfaceRevision:mode})};
const workspace=createMeasurementWorkspace({panel:document.querySelector('#panel'),context:()=>context,token:()=>null,permitted:()=>permission,toolChanged:()=>{},coordinateReference:()=>crs,toLonLat:p=>p,resolveDisplayVertices:async()=>{throw new Error('Raster height units are absent.');}});
await workspace.store.save({id:'33333333-3333-4333-8333-333333333333',name:'Map outline',collection:'map',kind:'polygon',vertices,coordinateReference:crs,source:{kind:'dsm'},results:{method:'surface-cut-fill',status:'complete',cutM3:15,fillM3:3,netM3:12},visible:true});
const tick=()=>{workspace.tick();requestAnimationFrame(tick);};tick();
window.renderedFixture={saved:()=>JSON.stringify([...workspace.store.records.values()]),draft:()=>workspace.getDraft(),pick:(x,y)=>{const r=view.getBoundingClientRect();return pick({clientX:x+r.left,clientY:y+r.top});},mode:value=>{workspace.modeChanged();mode=value;workspace.tick({force:true});},deny:()=>{permission=false;workspace.tick();}};document.body.dataset.ready='true';
</script></body></html>`;}

test('map outline renders on actual mesh and point geometry across all views without rewriting saved heights',{timeout:60000},async t=>{
  const binary=browserPath();if(!binary){t.skip('Chromium-family browser required.');return;}
  const unlock=await acquireBrowserHarnessLock({root});let browser,client,profile,server;
  try{
    const f=await fixture();server=f.server;profile=mkdtempSync(path.join(tmpdir(),'ltds-crossview-rendered-browser-'));
    browser=spawn(binary,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const active=path.join(profile,'DevToolsActivePort'),until=Date.now()+10000;while(!existsSync(active)&&Date.now()<until)await delay(50);assert.ok(existsSync(active));
    const port=readFileSync(active,'utf8').split(/\r?\n/)[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();client=await Cdp.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await client.command('Runtime.enable');await client.command('Page.enable');await client.command('Emulation.setDeviceMetricsOverride',{width:1150,height:750,deviceScaleFactor:1,mobile:false});await client.command('Page.navigate',{url:`${f.origin}?rendered=1`});
    await waitFor(client,"document.body?.dataset.ready==='true'&&document.querySelectorAll('#view .measurement-overlay circle').length===4");
    const original=await client.evaluate('renderedFixture.saved()');assert.ok(JSON.parse(original)[0].vertices.every(p=>p[2]===0));
    for(const [mode,y]of [['model',80],['cloud',70],['ortho',100],['dsm',100],['dtm',100],['model',80]]){
      await client.evaluate(`renderedFixture.mode(${JSON.stringify(mode)})`);
      try{await waitFor(client,`Math.abs(Number(document.querySelector('#view .measurement-overlay circle')?.getAttribute('cy'))-${y})<1e-6`);}catch(error){throw new Error(`${mode} placement: ${await client.evaluate('document.body.innerText')} ${JSON.stringify(await overlay(client))}`,{cause:error});}
      const geometry=await overlay(client);assert.equal(geometry.fills.length,1);assert.equal(geometry.fills[0].points.trim().split(/\s+/).length,4);assert.equal(geometry.circles.length,4);assert.doesNotMatch(geometry.markup,/NaN|Infinity/);
      assert.equal(await client.evaluate('renderedFixture.saved()'),original,`${mode} does not persist display heights`);
    }
    const mouse=(type,x,y,extra={})=>client.command('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1,...extra});
    const click=async(x,y)=>{await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);};
    const button=async selector=>{const p=await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];})()`);await click(...p);};
    for(const [mode,height]of [['model',20],['cloud',30]]){
      await client.command('Page.navigate',{url:`${f.origin}?rendered=1`});await waitFor(client,"document.body?.dataset.ready==='true'");
      await client.evaluate(`renderedFixture.mode(${JSON.stringify(mode)})`);
      await waitFor(client,`Math.abs(Number(document.querySelector('#view .measurement-overlay circle')?.getAttribute('cy'))-${100-height})<1e-6`);
      const before=JSON.parse(await client.evaluate('renderedFixture.saved()'))[0];
      await button('[data-m=edit-record]');await waitFor(client,'renderedFixture.draft()!==null');
      const handles=await overlay(client);assert.ok(handles.circles.some(c=>Math.abs(c[0]-100)<1e-6&&Math.abs(c[1]-(100-height))<1e-6),`${mode}: edit handles retain actual displayed surface height`);
      assert.ok((await client.evaluate('renderedFixture.draft().vertices')).every(p=>p[2]===0),'display placement is not canonical edit geometry');
      await button('[data-m=finish]');await waitFor(client,'renderedFixture.draft()===null');
      const unchanged=JSON.parse(await client.evaluate('renderedFixture.saved()'))[0];assert.deepEqual(unchanged.results,before.results,'unchanged finish retains saved volume');assert.deepEqual(unchanged.vertices,before.vertices);
      await button('[data-m=edit-record]');await waitFor(client,"document.querySelectorAll('[data-measurement-insert]').length===4");
      const offset=await client.evaluate("(()=>{const r=document.querySelector('#view').getBoundingClientRect();return [r.left,r.top];})()");
      const at=(x,y)=>[x+offset[0],y+offset[1]];
      await click(...at(200,100-height));await waitFor(client,'renderedFixture.draft().vertices.length===5');
      assert.deepEqual((await client.evaluate('renderedFixture.draft().vertices'))[1],[200,100,0],'midpoint insertion preserves map convention');
      const picked=await client.evaluate(`renderedFixture.pick(220,${80-height})`);assert.ok(picked&&Math.abs(picked[1]-80)<1e-6,`${mode} fixture surface pick ${JSON.stringify(picked)}`);
      await mouse('mousePressed',...at(200,100-height));await mouse('mouseMoved',...at(220,80-height),{buttons:1});await mouse('mouseReleased',...at(220,80-height));
      try{await waitFor(client,'Math.abs(renderedFixture.draft().vertices[1][0]-220)<1e-6&&Math.abs(renderedFixture.draft().vertices[1][1]-80)<1e-6');}catch(error){throw new Error(`${mode} drag: ${await client.evaluate('JSON.stringify(renderedFixture.draft())')} ${await client.evaluate('document.body.innerText')}`,{cause:error});}
      const moved=(await client.evaluate('renderedFixture.draft().vertices'))[1];assert.ok(Math.abs(moved[0]-220)<1e-6&&Math.abs(moved[1]-80)<1e-6);assert.equal(moved[2],0,'3D surface pick updates XY but never persists picked Z');
      assert.deepEqual(JSON.parse(await client.evaluate('renderedFixture.saved()'))[0],unchanged,'draft operations do not mutate saved source');
      await client.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace'});await waitFor(client,'renderedFixture.draft().vertices.length===4');
      await mouse('mousePressed',...at(100,100-height));await mouse('mouseMoved',...at(120,100-height),{buttons:1});await mouse('mouseReleased',...at(120,100-height));await waitFor(client,'renderedFixture.draft().vertices[0][0]===120');
      await button('[data-m=finish]');await waitFor(client,'renderedFixture.draft()===null');
      const changed=JSON.parse(await client.evaluate('renderedFixture.saved()'))[0];assert.equal(changed.collection,'map');assert.ok(changed.vertices.every(p=>p[2]===0));assert.ok(Math.abs(changed.vertices[0][0]-120)<1e-6&&Math.abs(changed.vertices[0][1]-100)<1e-6);assert.equal(changed.results.volumeInvalidated,true);assert.equal(changed.results.cutM3,undefined);
    }
    await client.evaluate('renderedFixture.deny()');assert.equal(await client.evaluate("document.querySelector('#view .measurement-overlay').innerHTML"),'');
    assert.deepEqual(f.requests,[],'display placement creates no server jobs');assert.deepEqual(client.errors,[]);
  }finally{
    client?.close();if(browser){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,delay(3000)]);}if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}unlock();
    if(profile){const absolute=path.resolve(profile);assert.ok(absolute.startsWith(path.resolve(tmpdir(),'ltds-crossview-rendered-browser-')));try{rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))throw error;t.diagnostic(`Isolated profile retained: ${absolute}`);}}
  }
});
const assertFinite=geometry=>{assert.doesNotMatch(geometry.markup,/NaN|Infinity|undefined/);for(const line of geometry.lines){assert.ok(line.every(Number.isFinite));for(let i=0;i<4;i++)assert.ok(line[i]>=-.001&&line[i]<=(i%2?600:800)+.001,`clipped SVG coordinate ${line[i]} is bounded`);}for(const circle of geometry.circles)assert.ok(circle.every(Number.isFinite));};
test('real measurement overlay preserves original visible edges across close zoom without a false closing edge',{timeout:60000},async t=>{
  const binary=browserPath();if(!binary){t.skip('Chromium-family browser required for isolated overlay regression.');return;}
  const unlock=await acquireBrowserHarnessLock({root});let browser,client,profile,server;
  try{
    const f=await fixture();server=f.server;profile=mkdtempSync(path.join(tmpdir(),'ltds-measurement-closezoom-browser-'));
    browser=spawn(binary,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const active=path.join(profile,'DevToolsActivePort'),until=Date.now()+10000;while(!existsSync(active)&&Date.now()<until)await delay(50);assert.ok(existsSync(active));
    const port=readFileSync(active,'utf8').split(/\r?\n/)[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();client=await Cdp.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await client.command('Runtime.enable');await client.command('Page.enable');await client.command('Emulation.setDeviceMetricsOverride',{width:1150,height:750,deviceScaleFactor:1,mobile:false});await client.command('Page.navigate',{url:f.origin});
    await waitFor(client,`location.href===${JSON.stringify(f.origin)}&&document.body?.dataset.ready==='true'&&document.querySelectorAll('#view .measurement-overlay line').length===4`);
    const original=await client.evaluate('fixtureSnapshot()');assert.deepEqual(JSON.parse(original),[record]);
    let geometry=await overlay(client);assertFinite(geometry);assert.equal(geometry.lines.length,4);assert.equal(geometry.circles.length,4);
    for(const z of [0,2.05]){
      await client.evaluate(`document.querySelector('[data-camera="${z}"]').click()`);
      await waitFor(client,`document.body?.dataset.camera==='${z}'&&document.querySelectorAll('#view .measurement-overlay line').length===3`);
      geometry=await overlay(client);assertFinite(geometry);assert.equal(geometry.lines.length,3,'only three original boundary edges intersect the viewport');assert.equal(geometry.circles.length,2,'clipped endpoints are not fabricated original handles');
      assert.ok(geometry.fills.every(fill=>fill.stroke==='none'),'clipped fill does not stroke an artificial boundary cap');
      assert.ok(!geometry.lines.some(line=>Math.abs(line[1]-600)<.001&&Math.abs(line[3]-600)<.001),'no false bottom viewport closing edge');
      // Analytic pinhole projection independent of the shipped clipping helper:
      // front edge endpoints are x=400±f*.5/depth, y=300+f*.5/depth.
      const projected=600/(2*Math.tan(Math.PI/6))*.5/(z+4),front=[400-projected,300+projected,400+projected,300+projected];
      assert.ok(geometry.lines.some(line=>line.every((value,index)=>Math.abs(value-front[index])<.01)||line.every((value,index)=>Math.abs(value-front[(index+2)%4])<.01)),'visible original front edge remains at its projected location');
      assert.equal(await client.evaluate('fixtureSnapshot()'),original,'camera-only navigation preserves canonical records');
      if(process.env.LTDS_CLOSEZOOM_BROWSER_SCREENSHOT&&z===0){const shot=await client.command('Page.captureScreenshot',{format:'png'});writeFileSync(process.env.LTDS_CLOSEZOOM_BROWSER_SCREENSHOT,Buffer.from(shot.data,'base64'));}
    }
    await client.evaluate("document.querySelector('[data-camera=\"-5\"]').click()");await waitFor(client,"document.body?.dataset.camera==='-5'&&document.querySelectorAll('#view .measurement-overlay line').length===0");assertFinite(await overlay(client));
    await client.evaluate("document.querySelector('[data-camera=\"8\"]').click()");await waitFor(client,"document.querySelectorAll('#view .measurement-overlay line').length===4");assert.equal(await client.evaluate('fixtureSnapshot()'),original);
    assert.ok(f.requests.every(request=>request.method==='GET'),'zoom never mutates source records');assert.deepEqual(client.errors,[]);
  }finally{
    client?.close();if(browser){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,delay(3000)]);}if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}unlock();
    if(profile){const absolute=path.resolve(profile);assert.ok(absolute.startsWith(path.resolve(tmpdir(),'ltds-measurement-closezoom-browser-')));try{rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))throw error;t.diagnostic(`Browser retained an isolated temporary profile lock: ${absolute}`);}}
  }
});

function editorPage(){return `<!doctype html><html><head><style>body{margin:0;background:#121820;color:white;font:14px system-ui}#panel{position:absolute;left:810px;top:0;width:300px}#view{position:relative;width:800px;height:600px;background:#1a2634;overflow:hidden}</style><script type="importmap">{"imports":{"three":"/vendor/build/three.module.js","three/addons/":"/vendor/examples/jsm/"}}</script></head><body><div id="view"></div><button id="fixture-capture">Capture current view</button><button id="fixture-report">Open report</button><aside id="panel"></aside><script type="module">
import {createMeasurementWorkspace} from '/measurement-workspace.mjs';
const mode=new URL(location.href).searchParams.get('editor'),map=['ortho','dsm','dtm'].includes(mode),view=document.querySelector('#view');let permission=true;
const record={id:'11111111-1111-4111-8111-111111111111',name:'Editable pile',kind:'polygon',collection:map?'map':'spatial3d',vertices:[[100,100,1],[300,100,1],[300,300,1],[100,300,1]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},results:{method:'surface-cut-fill',status:'complete',cutM3:15,fillM3:3,netM3:12},visible:true};
if(map)record.vertices=record.vertices.map(([x,y])=>[x,y,0]);
let captureCount=0,frameColor='rgb(20,40,60)';
const context={mode,element:view,host:view,pick:event=>{const r=view.getBoundingClientRect();return [event.clientX-r.left,event.clientY-r.top,map?0:1];},project:p=>p.slice(0,2),viewSignature:()=>mode,capture:async()=>{captureCount++;const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;const ctx=canvas.getContext('2d');ctx.fillStyle=frameColor;ctx.fillRect(0,0,800,600);return canvas;}};
const workspace=createMeasurementWorkspace({panel:document.querySelector('#panel'),context:()=>context,token:()=>null,permitted:()=>permission,toolChanged:()=>{},coordinateReference:()=>record.coordinateReference,toLonLat:p=>p});
await workspace.store.save(record);workspace.tick({force:true});
document.querySelector('#fixture-capture').onclick=()=>workspace.captureView();document.querySelector('#fixture-report').onclick=()=>workspace.openReport();
window.editorFixture={draft:()=>workspace.getDraft(),saved:()=>[...workspace.store.records.values()][0],captures:()=>captureCount,nextFrame:()=>{frameColor='rgb(70,80,90)';},deny(){permission=false;workspace.tick();}};document.body.dataset.ready='true';
</script></body></html>`;}

function sidebarPage(){const styles=readFileSync(path.join(root,'index.html'),'utf8').match(/<style>([\s\S]*?)<\/style>/)[1];return `<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>${styles}</style></head><body><div id="app"><div id="main"><aside id="sidebar"><div id="sidebar-resize" role="separator" tabindex="0" aria-label="Resize navigation sidebar" aria-orientation="vertical" aria-valuemin="240"></div><div id="sidebar-custom">Synthetic sidebar</div></aside><div id="test-view" style="flex:1;min-width:0"></div></div></div><script type="module">
import {installSidebarResize} from '/viewer-sidebar-resize.mjs';
const sidebar=document.querySelector('#sidebar'),handle=document.querySelector('#sidebar-resize');let calls=0;
const dispose=installSidebarResize({sidebar,handle,onResize:()=>calls++});
window.sidebarFixture={dispose,collapse:()=>sidebar.classList.toggle('collapsed'),state:()=>({width:sidebar.getBoundingClientRect().width,view:document.querySelector('#test-view').getBoundingClientRect().width,scroll:document.documentElement.scrollWidth,handle:getComputedStyle(handle).display,calls,resizing:sidebar.classList.contains('resizing')})};document.body.dataset.ready='true';
</script></body></html>`;}

test('real sidebar CSS supports desktop drag, keyboard and mobile collapsed layout',{timeout:60000},async t=>{
  const binary=browserPath();if(!binary){t.skip('Chromium-family browser required');return;}
  const unlock=await acquireBrowserHarnessLock({root});let browser,client,profile,server;
  try{
    const f=await fixture();server=f.server;profile=mkdtempSync(path.join(tmpdir(),'ltds-sidebar-layout-browser-'));
    browser=spawn(binary,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const active=path.join(profile,'DevToolsActivePort'),until=Date.now()+10000;while(!existsSync(active)&&Date.now()<until)await delay(30);assert.ok(existsSync(active));
    const port=readFileSync(active,'utf8').split(/\r?\n/)[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();client=await Cdp.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await client.command('Runtime.enable');await client.command('Page.enable');await client.command('Emulation.setDeviceMetricsOverride',{width:1200,height:800,deviceScaleFactor:1,mobile:false});await client.command('Page.navigate',{url:`${f.origin}?sidebar=1`});await waitFor(client,"document.body?.dataset.ready==='true'");
    assert.equal((await client.evaluate('sidebarFixture.state()')).width,300);
    await client.command('Input.dispatchMouseEvent',{type:'mousePressed',x:297,y:100,button:'left',clickCount:1});await client.command('Input.dispatchMouseEvent',{type:'mouseMoved',x:497,y:100,button:'left',buttons:1});await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:497,y:100,button:'left',clickCount:1});await waitFor(client,'sidebarFixture.state().width===500');
    let state=await client.evaluate('sidebarFixture.state()');assert.equal(state.view,700);assert.equal(state.resizing,false);assert.ok(state.calls>0);
    await client.evaluate("document.querySelector('#sidebar-resize').focus()");await client.command('Input.dispatchKeyEvent',{type:'keyDown',key:'End'});await waitFor(client,'sidebarFixture.state().width===720');
    await client.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Home'});await waitFor(client,'sidebarFixture.state().width===240');
    await client.evaluate('sidebarFixture.collapse()');await waitFor(client,"sidebarFixture.state().width<=1&&sidebarFixture.state().handle==='none'");assert.ok((await client.evaluate('sidebarFixture.state()')).view>=1199);
    await client.command('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:true});await client.evaluate('sidebarFixture.collapse()');await waitFor(client,'sidebarFixture.state().width===240');state=await client.evaluate('sidebarFixture.state()');assert.equal(state.view,390);assert.ok(state.scroll<=390);
    await client.evaluate('sidebarFixture.collapse()');await waitFor(client,'sidebarFixture.state().width<=1');assert.equal((await client.evaluate('sidebarFixture.state()')).view,390);
    await client.evaluate('sidebarFixture.dispose()');assert.deepEqual(client.errors,[]);
  }finally{
    client?.close();if(browser){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,delay(3000)]);}if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}unlock();
    if(profile){const absolute=path.resolve(profile);assert.ok(absolute.startsWith(path.resolve(tmpdir(),'ltds-sidebar-layout-browser-')));try{rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))throw error;t.diagnostic(`Isolated sidebar profile retained: ${absolute}`);}}
  }
});

test('real editor inserts midpoint, moves/deletes selected vertices and retains lifecycle across all view adapters',{timeout:60000},async t=>{
  const binary=browserPath();if(!binary){t.skip('Chromium-family browser required');return;}
  const unlock=await acquireBrowserHarnessLock({root});let browser,client,profile,server;
  try{
    const f=await fixture();server=f.server;profile=mkdtempSync(path.join(tmpdir(),'ltds-measurement-editor-browser-'));const downloads=path.join(profile,'downloads');mkdirSync(downloads);
    browser=spawn(binary,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const active=path.join(profile,'DevToolsActivePort'),until=Date.now()+10000;while(!existsSync(active)&&Date.now()<until)await delay(30);assert.ok(existsSync(active));
    const port=readFileSync(active,'utf8').split(/\r?\n/)[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();client=await Cdp.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await client.command('Runtime.enable');await client.command('Page.enable');await client.command('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});await client.command('Emulation.setDeviceMetricsOverride',{width:1150,height:850,deviceScaleFactor:1,mobile:false});
    const mouse=async(type,x,y,extra={})=>client.command('Input.dispatchMouseEvent',{type,x,y,button:'left',clickCount:1,...extra});
    const click=async(x,y)=>{await mouse('mousePressed',x,y);await mouse('mouseReleased',x,y);};
    const button=async selector=>{const p=await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2];})()`);await click(...p);};
    for(const mode of ['model','cloud','ortho','dsm','dtm']){
      await client.command('Page.navigate',{url:`${f.origin}?editor=${mode}`});await waitFor(client,"document.body?.dataset.ready==='true'&&document.querySelector('[data-m=edit-record]')");
      assert.match(await client.evaluate("document.querySelector('.measurement-overlay').textContent"),/Editable pile.*Volume/s);
      if(mode==='model'){
        const original=await client.evaluate('JSON.stringify(editorFixture.saved())');
        await button('#fixture-capture');const imageFile=path.join(downloads,'measured-view.png'),deadline=Date.now()+8000;while(!existsSync(imageFile)&&Date.now()<deadline)await delay(30);assert.ok(existsSync(imageFile),await client.evaluate('document.body.innerText'));
        const bytes=readFileSync(imageFile);assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);assert.ok(bytes.length>5000);assert.equal(bytes.readUInt32BE(16),800);assert.equal(bytes.readUInt32BE(20),600);
        const pixel=await client.evaluate(`(async()=>{const image=new Image();image.src=${JSON.stringify('data:image/png;base64,')}+${JSON.stringify(bytes.toString('base64'))};await image.decode();const canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(500,500,1,1).data];})()`);assert.deepEqual(pixel,[20,40,60,255]);assert.equal(await client.evaluate('editorFixture.captures()'),1);
        await client.evaluate('editorFixture.nextFrame()');await button('#fixture-report');await waitFor(client,"document.querySelector('dialog.measurement-report img')?.complete&&document.querySelector('dialog.measurement-report img')?.naturalWidth===800");
        assert.match(await client.evaluate("document.querySelector('dialog.measurement-report table').textContent"),/Editable pile/);assert.match(await client.evaluate("document.querySelector('dialog.measurement-report table').textContent"),/Net|Cut|Volume/i);
        const reportPixel=await client.evaluate("(()=>{const image=document.querySelector('dialog.measurement-report img'),canvas=document.createElement('canvas');canvas.width=800;canvas.height=600;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(500,500,1,1).data];})()");assert.deepEqual(reportPixel,[70,80,90,255]);assert.equal(await client.evaluate('editorFixture.captures()'),2);assert.equal(await client.evaluate('JSON.stringify(editorFixture.saved())'),original);
        // Exercise the real browser print renderer, not an overridden print()
        // function. This proves printable content/CSS, not native dialog support
        // in an embedding application's webview.
        await client.command('Emulation.setEmulatedMedia',{media:'print'});
        assert.equal(await client.evaluate("getComputedStyle(document.querySelector('#view')).display"),'none');
        assert.equal(await client.evaluate("getComputedStyle(document.querySelector('dialog.measurement-report .measurement-actions')).display"),'none');
        assert.equal(await client.evaluate("getComputedStyle(document.querySelector('dialog.measurement-report')).display"),'block');
        const printed=await client.command('Page.printToPDF',{printBackground:true,preferCSSPageSize:true}),pdf=Buffer.from(printed.data,'base64');
        assert.equal(pdf.subarray(0,5).toString(),'%PDF-');assert.ok(pdf.length>10000);assert.match(pdf.toString('latin1'),/\/Type\s*\/Page\b/);
        if(process.env.MEASUREMENT_REPORT_QA_DIR){
          const artifacts=path.resolve(process.env.MEASUREMENT_REPORT_QA_DIR);mkdirSync(artifacts,{recursive:true});
          writeFileSync(path.join(artifacts,'measurement-report-browser.pdf'),pdf);
          writeFileSync(path.join(artifacts,'measured-view-browser.png'),bytes);
          const screenshot=await client.command('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
          writeFileSync(path.join(artifacts,'measurement-report-print-preview.png'),Buffer.from(screenshot.data,'base64'));
          t.diagnostic(`Report QA artifacts preserved in ${artifacts}`);
        }
        await client.command('Emulation.setEmulatedMedia',{media:''});
        t.diagnostic(`Browser print backend produced ${pdf.length}-byte PDF; native host print UI is not asserted.`);
        await button('dialog.measurement-report [data-close]');await waitFor(client,"!document.querySelector('dialog.measurement-report')");t.diagnostic(`captureView downloaded actual ${bytes.length}-byte 800x600 PNG; openReport rendered measurement table and a freshly captured current frame.`);
      }
      await button('[data-m=edit-record]');await waitFor(client,"document.querySelectorAll('[data-measurement-insert]').length===4");
      // Capture must leave ordinary viewer gestures untouched away from handles.
      await client.evaluate("window.navigationEvents=[];for(const name of ['pointerdown','pointermove','pointerup','contextmenu'])document.querySelector('#view').addEventListener(name,e=>navigationEvents.push(name));");
      const geometryBeforeNavigation=await client.evaluate('JSON.stringify(editorFixture.draft().vertices)');
      await mouse('mouseMoved',600,450,{button:'none',buttons:0});assert.notEqual(await client.evaluate("getComputedStyle(document.querySelector('#view')).cursor"),'move');
      await mouse('mousePressed',600,450);await mouse('mouseMoved',650,460,{buttons:1});await mouse('mouseReleased',650,460);
      assert.ok((await client.evaluate('navigationEvents')).includes('pointerdown'));assert.ok((await client.evaluate('navigationEvents')).includes('pointerup'));assert.equal(await client.evaluate('JSON.stringify(editorFixture.draft().vertices)'),geometryBeforeNavigation);
      await mouse('mouseMoved',100,100,{button:'none',buttons:0});assert.equal(await client.evaluate("getComputedStyle(document.querySelector('#view')).cursor"),'move',await client.evaluate("JSON.stringify({view:document.querySelector('#view').getBoundingClientRect(),target:document.elementFromPoint(100,100)?.tagName,classes:document.querySelector('#view').className})"));
      await click(200,100);await waitFor(client,'editorFixture.draft().vertices.length===5');
      // Selected midpoint can move; original source is unchanged until Finish.
      await mouse('mousePressed',200,100);await mouse('mouseMoved',200,70,{buttons:1});await mouse('mouseReleased',200,70);await waitFor(client,'editorFixture.draft().vertices[1][1]===70');
      assert.equal((await client.evaluate('editorFixture.saved().vertices')).length,4);
      await client.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace'});await waitFor(client,'editorFixture.draft().vertices.length===4');
      // Contextual delete is offset from the selected vertex, not on top of it.
      await click(300,100);await waitFor(client,"Number(document.querySelector('[data-measurement-delete] rect')?.getAttribute('x'))===320");
      const box=await client.evaluate("(()=>{const r=document.querySelector('[data-measurement-delete] rect').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()");assert.ok(box.x>300&&box.y+box.height<100);
      await click(box.x+box.width/2,box.y+box.height/2);await waitFor(client,'editorFixture.draft().vertices.length===3');
      await client.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace'});assert.equal((await client.evaluate('editorFixture.draft().vertices')).length,3,'minimum polygon vertices retained');
      // Shift lets navigation through and does not place/move a measurement.
      const before=await client.evaluate('JSON.stringify(editorFixture.draft().vertices)');await mouse('mousePressed',150,150,{modifiers:8});await mouse('mouseReleased',180,160,{modifiers:8});assert.equal(await client.evaluate('JSON.stringify(editorFixture.draft().vertices)'),before);
      await button('[data-m=finish]');await waitFor(client,'editorFixture.draft()===null');const saved=await client.evaluate('editorFixture.saved()');assert.equal(saved.vertices.length,3);assert.equal(saved.results.volumeInvalidated,true);assert.equal(saved.results.cutM3,undefined);
      await button('[data-m=edit-record]');await waitFor(client,'editorFixture.draft()!==null');await client.evaluate('editorFixture.deny()');assert.equal(await client.evaluate('editorFixture.draft()'),null);assert.equal(await client.evaluate("document.querySelector('.measurement-overlay').innerHTML"),'');
    }
    assert.deepEqual(client.errors,[]);
  }finally{
    client?.close();if(browser){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,delay(3000)]);}if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}unlock();
    if(profile){const absolute=path.resolve(profile);assert.ok(absolute.startsWith(path.resolve(tmpdir(),'ltds-measurement-editor-browser-')));try{rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))throw error;t.diagnostic(`Isolated editor profile retained: ${absolute}`);}}
  }
});
