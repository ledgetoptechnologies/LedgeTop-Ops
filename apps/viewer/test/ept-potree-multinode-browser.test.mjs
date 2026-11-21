import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env.VIEWER_EPT_IMAGE || '';
const IMAGE_ID = 'sha256:aa0599718a1dfa438409e1d7ed5d23ecceceb870e9447a3972a7efa96a70311c';
const edge = process.env.EDGE_PATH || '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8', timeout: 15000 });

test('combined clip preserves gated EPT child nodes arriving after activation', { skip: process.env.RUN_EPT_SLICE_BROWSER !== '1', timeout: 90000 }, async t => {
  assert.ok(edge && existsSync(edge), 'Set EDGE_PATH to an existing browser executable');
  assert.ok(IMAGE, 'Set VIEWER_EPT_IMAGE to the reviewed local Viewer image');
  const unlock = await acquireBrowserHarnessLock('ept-multinode-proof');
  const name = `codex-ept-slice-${process.pid}-${Date.now()}`, profile = mkdtempSync(path.join(tmpdir(), 'codex-ept-slice-'));
  let browser, socket, started = false;
  try {
    const image = docker('image', 'inspect', IMAGE, '--format', '{{.Id}}');
    assert.equal(image.status, 0, image.stderr); assert.equal(image.stdout.trim(), IMAGE_ID, 'local pinned image identity changed');
    t.diagnostic(`Local Viewer image ${image.stdout.trim()}; EPT fixture synthetic-ept-node.laz`);
    const run = docker('run','-d','--rm','--pull','never','--cpus','0.5','--memory','512m','--name',name,'-p','127.0.0.1::8095','-v',`${root}:/candidate:ro`,'--entrypoint','node',IMAGE,'/candidate/test/helpers/ept-slice-multinode-preview.mjs');
    assert.equal(run.status, 0, run.stderr); started = true;
    const portInfo = docker('port',name,'8095/tcp'); assert.equal(portInfo.status, 0, portInfo.stderr);
    const match = portInfo.stdout.match(/127\.0\.0\.1:(\d+)/); assert.ok(match, 'fixture must bind to loopback');
    browser = spawn(edge,['--headless=new','--disable-gpu-sandbox','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,`http://127.0.0.1:${match[1]}/`],{stdio:'ignore'});
    let port; for (let i=0;i<100;i++) { try { port=readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0]; break; } catch { await delay(100); } }
    assert.ok(port,'task-owned Edge did not start');
    const tabs=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    socket=new WebSocket(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
    let next=0;const pending=new Map();socket.onmessage=event=>{const msg=JSON.parse(event.data),p=pending.get(msg.id);if(p){pending.delete(msg.id);msg.error?p.reject(new Error(msg.error.message)):p.resolve(msg.result);}};
    const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
    let ready=false;for(let i=0;i<200;i++){ready=await evaluate(`(()=>{let w=document.querySelector('#pc-iframe')?.contentWindow;return !!w?.viewer?.scene?.pointclouds?.[0]?.visibleNodes?.length})()`);if(ready)break;await delay(100);}assert.ok(ready,'synthetic Potree node did not load');
    const result=await evaluate(`(async()=>{
      const w=document.querySelector('#pc-iframe').contentWindow,v=w.viewer,pc=v.scene.pointclouds[0],m=await import('/ept-potree-slice-prototype.mjs');
      v.setMinNodeSize(0);v.setPointBudget(1000000);const pre=await(await fetch('/fixture/status')).json(),nodesBefore=pc.visibleNodes.map(n=>n.geometryNode.name);
      const raw=v.scene.getBoundingBox(),bounds={min:raw.min.toArray(),max:raw.max.toArray()},adapter=m.createEptPotreeSlicePrototype(v,w.Potree),box=adapter.set(bounds,{axis:'easting',fraction:8/(bounds.max[0]-bounds.min[0])});
      await new Promise(r=>setTimeout(r,300));const beforeRelease=pc.visibleNodes.map(n=>n.geometryNode.name);await fetch('/fixture/allow-children');
      let child;for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,100));child=pc.visibleNodes.find(n=>n.geometryNode.name!=='r');if(child)break;}if(!child)throw Error('No child node became visible after release');
      const status=await(await fetch('/fixture/status')).json(),geometry=child.sceneNode.geometry.attributes.position,points=[];for(let i=0;i<geometry.count;i++)points.push(new w.THREE.Vector3().fromBufferAttribute(geometry,i).applyMatrix4(child.sceneNode.matrixWorld).toArray());
      const rect=v.renderer.domElement.getBoundingClientRect(),camera=v.scene.getActiveCamera(),hits=[];for(const coords of points){const p=new w.THREE.Vector3(...coords).project(camera),x=(p.x+1)*rect.width/2,y=(1-p.y)*rect.height/2;if(x<8||y<8||x>=rect.width-8||y>=rect.height-8)continue;const ray=new w.THREE.Raycaster();ray.setFromCamera(new w.THREE.Vector2(p.x,p.y),camera);const hit=pc.pick(v,camera,ray.ray,{x,y:rect.height-y,pickWindowSize:5,pickClipped:true});if(hit?.position)hits.push(hit.position.toArray());}
      const name=child.geometryNode.name,visible=pc.visibleNodes.map(n=>n.geometryNode.name),clipBoxes=pc.material.clipBoxes.length;adapter.dispose();return {pre,nodesBefore,beforeRelease,status,box,name,visible,points,hits,clipBoxes};
    })()`);
    assert.equal(result.pre.released,false);assert.ok(result.nodesBefore.every(name=>name==='r'));assert.ok(result.beforeRelease.every(name=>name==='r'));
    assert.ok(result.status.released&&result.status.served>0,'child was served only after activation');assert.equal(result.points.length,64);assert.equal(result.clipBoxes,1);
    assert.ok(result.points.every(p=>p[0]>=367008-1e-5&&p[0]<=367015.875+1e-5&&p[1]>=4759000-1e-5&&p[1]<=4759003.5+1e-5&&p[2]>=100-1e-5&&p[2]<=100.3+1e-5),'decoded retained child must match independent LAS-header bounds');
    assert.ok(result.points.every((p,i)=>Math.abs(p[0]-(367008+i*.125))<1e-5&&Math.abs(p[1]-(4759000+(i%8)*.5))<1e-5&&Math.abs(p[2]-(100+(i%4)*.1))<1e-5),'child coordinates must match the independently specified synthetic sequence');
    assert.ok(result.hits.length>0,'newly arrived child must have pickable points');assert.ok(result.hits.every(p=>p[0]>=result.box.cut-1e-5),'hidden-side point cannot be picked');
    assert.ok(result.hits.some(p=>Math.abs((p[0]-367008)*4-Math.round((p[0]-367008)*4))>.1),'at least one picked point must belong only to the new child, not the parent grid');
    t.diagnostic(JSON.stringify({beforeRelease:result.beforeRelease,afterRelease:result.visible,child:result.name,status:result.status,cut:result.box.cut,points:result.points.length,picks:result.hits.length}));
  } finally {
    socket?.close();
    if(browser && browser.exitCode===null && browser.signalCode===null){
      if(process.platform==='win32') spawnSync('taskkill',['/PID',String(browser.pid),'/T','/F'],{stdio:'ignore',timeout:10000}); else browser.kill('SIGTERM');
      await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),delay(5000)]);
      if(browser.exitCode===null && browser.signalCode===null){browser.kill('SIGKILL');await Promise.race([new Promise(resolve=>browser.once('exit',resolve)),delay(5000)]);}
    }
    if(started){const stop=docker('stop','--timeout','3',name);if(stop.status!==0)t.diagnostic(`Could not stop task-owned container: ${stop.stderr}`);const remaining=docker('ps','-a','--filter',`name=^/${name}$`,'--format','{{.Names}}');assert.equal(remaining.stdout.trim(),'','task-owned container must exit');}
    try {rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:250});} finally {await unlock();}
    assert.equal(existsSync(profile),false,'task-owned browser profile must be removed');
    if(browser)assert.ok(browser.exitCode!==null||browser.signalCode!==null,'task-owned browser must exit');
  }
});
