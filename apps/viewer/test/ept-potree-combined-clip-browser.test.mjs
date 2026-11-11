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

test('test-only combined Potree clip keeps retained EPT points', { skip: process.env.RUN_EPT_SLICE_BROWSER !== '1', timeout: 90000 }, async t => {
  assert.ok(edge && existsSync(edge), 'Set EDGE_PATH to an existing browser executable');
  assert.ok(IMAGE, 'Set VIEWER_EPT_IMAGE to the reviewed local Viewer image');
  const unlock = await acquireBrowserHarnessLock('ept-combined-clip-proof');
  const name = `codex-ept-slice-${process.pid}-${Date.now()}`, profile = mkdtempSync(path.join(tmpdir(), 'codex-ept-slice-'));
  let browser, socket, started = false;
  try {
    const image = docker('image', 'inspect', IMAGE, '--format', '{{.Id}}');
    assert.equal(image.status, 0, image.stderr); assert.equal(image.stdout.trim(), IMAGE_ID, 'local pinned image identity changed');
    t.diagnostic(`Local Viewer image ${image.stdout.trim()}; EPT fixture synthetic-ept-node.laz`);
    const run = docker('run','-d','--rm','--pull','never','--cpus','0.5','--memory','512m','--name',name,'-p','127.0.0.1::8095','-v',`${root}:/candidate:ro`,'--entrypoint','node',IMAGE,'/candidate/test/helpers/ept-slice-combined-clip-preview.mjs');
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
      const raw=v.scene.getBoundingBox(),b={min:raw.min.toArray(),max:raw.max.toArray()},adapter=m.createEptPotreeSlicePrototype(v,w.Potree),rect=v.renderer.domElement.getBoundingClientRect(),camera=v.scene.getActiveCamera();
      const node=pc.visibleNodes[0].sceneNode,positions=node.geometry.attributes.position, targets=[];
      for(let i=0;i<positions.count;i++){const p=new w.THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(node.matrixWorld).project(camera);const x=(p.x+1)*rect.width/2,y=(1-p.y)*rect.height/2;if(p.z>=-1&&p.z<=1&&x>=8&&y>=8&&x<rect.width-8&&y<rect.height-8)targets.push({x,y});}
      function sample(){const hits=[];for(const {x,y} of targets){const ray=new w.THREE.Raycaster();ray.setFromCamera(new w.THREE.Vector2(x/rect.width*2-1,1-y/rect.height*2),camera);const hit=pc.pick(v,camera,ray.ray,{x,y:rect.height-y,pickWindowSize:5,pickClipped:true});if(hit?.position)hits.push(hit.position.toArray());}return hits;}
      const controls=w.eval('pcControls');function navigationSample(){const hits=[];for(const {x,y} of targets){const hit=controls._pointPick({x:rect.left+x,y:rect.top+y});if(hit)hits.push(hit.toArray());}return hits;}
      const before=sample(),cases=[];
      for(const edl of [false,true]){v.setEDLEnabled(edl);if(edl&&!v.getEDLEnabled())throw Error('EDL unsupported in this browser');await new Promise(r=>setTimeout(r,300));
      for(const [axis,index] of [['easting',0],['northing',1],['elevation',2]]){
        const values=before.map(p=>p[index]),lo=Math.min(...values),hi=Math.max(...values),cut=(lo+hi)/2,fraction=(cut-b.min[index])/(b.max[index]-b.min[index]);
        for(const flipped of [false,true]){const box=adapter.set(b,{axis,fraction,flipped});await new Promise(r=>setTimeout(r,300));cases.push({edl,axis,index,flipped,cut:box.cut,hits:sample(),navigation:axis==='easting'&&!edl?navigationSample():null,clipBoxes:pc.material.clipBoxes.length,task:pc.material.clipTask});}}
      }
      adapter.dispose();await new Promise(r=>setTimeout(r,300));const afterBoxes=pc.material.clipBoxes.length,afterTask=pc.material.clipTask;
      const a=new w.Potree.BoxVolume({clip:true}),other=new w.Potree.BoxVolume({clip:true});
      for(const volume of [a,other]){volume.clip=true;volume.visible=false;v.scene.addVolume(volume);}
      a.position.set(367008,4759001.75,100.15);a.scale.set(8.2,12,4);a.updateMatrixWorld(true);
      other.position.set(367008,4759001.7,100.15);other.scale.set(30,1.8,4);other.updateMatrixWorld(true);
      v.setClipTask(w.Potree.ClipTask.SHOW_INSIDE);v.setClipMethod(w.Potree.ClipMethod.INSIDE_ALL);await new Promise(r=>setTimeout(r,300));
      const multiple=sample(),multipleCount=pc.material.clipBoxes.length;
      other.position.y=4759002.2;other.updateMatrixWorld(true);await new Promise(r=>setTimeout(r,300));const moved=sample();
      v.scene.removeVolume(a);v.scene.removeVolume(other);v.setClipTask(afterTask);v.setClipMethod(w.Potree.ClipMethod.INSIDE_ANY);
      for(const volume of [a,other])volume.traverse(o=>{o.geometry?.dispose?.();for(const mat of Array.isArray(o.material)?o.material:[o.material])mat?.dispose?.();});
      await new Promise(r=>setTimeout(r,300));return {before,cases,afterBoxes,afterTask,multiple,moved,multipleCount,finalBoxes:pc.material.clipBoxes.length,nodeCount:pc.visibleNodes.length,pointCount:pc.numVisiblePoints};
    })()`);
    assert.equal(result.pointCount,64); assert.equal(result.nodeCount,1);
    for(const entry of result.cases){
      assert.ok(result.before.some(p=>p[entry.index]<entry.cut) && result.before.some(p=>p[entry.index]>entry.cut),`${entry.axis} fixture must have points on both sides`);
      assert.ok(entry.hits.length>0,`${entry.axis} ${entry.flipped} must retain pickable points`);
      assert.ok(entry.hits.every(p=>entry.flipped?p[entry.index]<=entry.cut+1e-5:p[entry.index]>=entry.cut-1e-5),`${entry.axis} ${entry.flipped} returned a clipped point`);
      const retained=result.before.filter(p=>entry.flipped?p[entry.index]<entry.cut-1e-5:p[entry.index]>entry.cut+1e-5);
      assert.ok(retained.every(p=>entry.hits.some(q=>p.every((value,i)=>Math.abs(value-q[i])<1e-5))),`${entry.axis} ${entry.flipped} dropped an interior retained point`);
      assert.equal(entry.clipBoxes,1); assert.equal(entry.task,2);
      if(entry.navigation){assert.ok(entry.navigation.length>0,'actual navigation must pick retained points');assert.ok(entry.navigation.every(p=>entry.flipped?p[entry.index]<=entry.cut+1e-5:p[entry.index]>=entry.cut-1e-5),'navigation selected a clipped point');}
    }
    assert.equal(result.afterBoxes,0); assert.equal(result.afterTask,1);
    assert.equal(result.multipleCount,2);assert.equal(result.finalBoxes,0);
    for(const [label,actual,minY,maxY] of [['multiple',result.multiple,4759000.8,4759002.6],['moved',result.moved,4759001.3,4759003.1]]){
      const expected=result.before.filter(p=>p[0]>=367003.9&&p[0]<=367012.1&&p[1]>=minY&&p[1]<=maxY);
      assert.ok(expected.length>0 && actual.length>0,label);
      assert.ok(expected.every(p=>actual.some(q=>p.every((v,i)=>Math.abs(v-q[i])<1e-5))),`${label} lost a retained point`);
      assert.ok(actual.every(p=>p[0]>=367003.9&&p[0]<=367012.1&&p[1]>=minY&&p[1]<=maxY),`${label} retained a clipped point`);
    }
    t.diagnostic(JSON.stringify({pointCount:result.pointCount,nodeCount:result.nodeCount,cases:result.cases.map(c=>({edl:c.edl,axis:c.axis,flipped:c.flipped,cut:c.cut,picks:c.hits.length}))}));
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
