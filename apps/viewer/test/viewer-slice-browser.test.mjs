import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireBrowserHarnessLock} from './browser-lock.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const executable=()=>[process.env.CHROME_PATH,process.env.EDGE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe'].filter(Boolean).find(existsSync);
class Cdp{
  constructor(socket){this.socket=socket;this.id=0;this.pending=new Map();socket.addEventListener('message',event=>{const message=JSON.parse(event.data),entry=this.pending.get(message.id);if(entry){clearTimeout(entry.timer);this.pending.delete(message.id);message.error?entry.reject(new Error(message.error.message)):entry.resolve(message.result);}});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});return new Cdp(socket);}
  command(method,params={}){const id=++this.id;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`CDP timeout: ${method}`)),10000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const result=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result?.value;}
  close(){for(const entry of this.pending.values())clearTimeout(entry.timer);this.socket.close();}
}
function page(){const html=readFileSync(path.join(root,'index.html'),'utf8'),styles=html.match(/<style>([\s\S]*?)<\/style>/)[1],start=html.indexOf('        <div class="panel" id="panel-slice"'),end=html.indexOf('        <div class="panel" id="panel-model-report"',start),panel=html.slice(start,end).replace('id="panel-slice" style="display:none;"','id="panel" style="width:300px;flex:none;"');return `<!doctype html><meta charset="utf-8"><style>${styles}body{padding:24px;display:flex;flex-direction:row;align-items:flex-start;gap:24px;overflow:auto}canvas{border:1px solid #333}</style><script type="importmap">{"imports":{"three":"/three/build/three.module.js"}}</script>${panel}<script type="module">
import * as THREE from 'three';import {createViewerSlice} from '/viewer-slice.mjs';
const renderer=new THREE.WebGLRenderer();renderer.setSize(300,200);document.body.append(renderer.domElement);
const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-3,3,2,-2,.1,100);camera.position.z=10;camera.updateMatrixWorld();
const data=new THREE.Group();scene.add(data);let pointMode=false,available=true;
const bounds=new THREE.Box3(new THREE.Vector3(-3,-2,-2),new THREE.Vector3(3,2,2));
const controller=createViewerSlice({renderer,scene,panel:document.querySelector('#panel'),getRoots:()=>[data],getBounds:()=>bounds,supported:()=>available,describe:(plane,axis)=>axis+' '+(-plane.constant).toFixed(3)+' m'});
function populate(points){data.clear();pointMode=points;if(points){data.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([-1.5,0,0,1.5,0,0],3)),new THREE.PointsMaterial({color:0xffffff,size:15,sizeAttenuation:false})));}else for(const x of [-1.5,1.5]){const mesh=new THREE.Mesh(new THREE.BoxGeometry(.8,.8,.8),new THREE.MeshBasicMaterial({color:0xffffff}));mesh.position.x=x;data.add(mesh);}controller.register(data);}
populate(false);const target=new THREE.WebGLRenderTarget(300,200);
window.fixture={pixels(){renderer.setRenderTarget(target);renderer.render(scene,camera);const colors=[];for(const x of [75,225]){const bytes=new Uint8Array(4);renderer.readRenderTargetPixels(target,x,100,1,1,bytes);colors.push([...bytes]);}renderer.setRenderTarget(null);renderer.render(scene,camera);return colors;},points(){controller.reset();populate(true);},unsupported(){available=false;controller.refresh();},addTile(){const mesh=new THREE.Mesh(new THREE.BoxGeometry(.8,.8,.8),new THREE.MeshBasicMaterial({color:0xffffff}));mesh.position.x=-1.5;data.add(mesh);controller.register(mesh);},get active(){return controller.active;}};document.body.dataset.ready='true';
</script>`;}

test('real WebGL mesh and direct points follow slice controls, streamed arrivals, flip and reset',{timeout:45000},async t=>{
  const binary=executable();if(!binary){t.skip('Chromium is required for isolated WebGL slice test.');return;}
  const unlock=await acquireBrowserHarnessLock({root});let browser,client,server;
  try{
    server=createServer((req,res)=>{const url=new URL(req.url,'http://fixture.invalid');if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end(page());return;}const relative=url.pathname==='/viewer-slice.mjs'?'viewer-slice.mjs':url.pathname.startsWith('/three/')?'node_modules/three/'+url.pathname.slice(7):null;const file=relative&&path.resolve(root,relative);if(!file||!file.startsWith(root+path.sep)||!existsSync(file)){res.statusCode=404;res.end();return;}res.setHeader('Content-Type','application/javascript');res.end(readFileSync(file));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const profile=mkdtempSync(path.join(tmpdir(),'ltds-viewer-slice-browser-'));
    browser=spawn(binary,['--headless=new','--enable-unsafe-swiftshader','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const active=path.join(profile,'DevToolsActivePort'),until=Date.now()+10000;while(!existsSync(active)&&Date.now()<until)await delay(50);assert.ok(existsSync(active));
    const port=readFileSync(active,'utf8').split(/\r?\n/)[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();client=await Cdp.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await client.command('Page.enable');await client.command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
    const ready=Date.now()+10000;while(Date.now()<ready&&!await client.evaluate("document.body?.dataset.ready==='true'"))await delay(50);
    assert.equal(await client.evaluate("document.body?.dataset.ready==='true'"),true);
    const pixels=()=>client.evaluate('fixture.pixels().map(p=>p[0])'),click=name=>client.evaluate(`document.querySelector('[data-slice="${name}"]').click()`);
    const axis=()=>client.evaluate(`(()=>{const input=document.querySelector('[data-slice="axis"]');input.value='easting';input.dispatchEvent(new Event('change'));})()`);
    const position=value=>client.evaluate(`(()=>{const input=document.querySelector('[data-slice="position"]');input.value=${value};input.dispatchEvent(new Event('input'));})()`);
    for(const kind of ['mesh','points']){
      if(kind==='points')await client.evaluate('fixture.points()');
      assert.deepEqual(await pixels(),[255,255],`${kind}: complete before enabling`);
      await click('enabled');await axis();assert.deepEqual(await pixels(),[0,255],`${kind}: discarded left half really absent from framebuffer`);
      if(kind==='mesh'){const screenshot=await client.command('Page.captureScreenshot',{format:'png'}),output=path.join(tmpdir(),'viewer-slice-preview.png');writeFileSync(output,Buffer.from(screenshot.data,'base64'));t.diagnostic(`Slice controls screenshot: ${output}`);}
      if(kind==='mesh'){await client.evaluate('fixture.addTile()');assert.deepEqual(await pixels(),[0,255],'new streamed content honors active plane');}
      await click('flip');assert.deepEqual(await pixels(),[255,0],`${kind}: reversed retained half`);
      await position(0);assert.deepEqual(await pixels(),[0,0],`${kind}: plane moves through entire extent`);
      await click('reset');assert.deepEqual(await pixels(),[255,255],`${kind}: reset restores full geometry`);
    }
    await click('enabled');await client.evaluate('fixture.unsupported()');assert.deepEqual(await pixels(),[255,255]);assert.equal(await client.evaluate('fixture.active'),false);assert.equal(await client.evaluate("document.querySelector('[data-slice=enabled]').disabled"),true);
  }finally{client?.close();browser?.kill();if(server)await new Promise(resolve=>server.close(resolve));await unlock();}
});
