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

test('synthetic parent and real EPT iframe reject old assets and clear on lifecycle loss', { skip: process.env.RUN_EPT_SLICE_BROWSER !== '1', timeout: 90000 }, async t => {
  assert.ok(edge && existsSync(edge), 'Set EDGE_PATH to an existing browser executable');
  assert.ok(IMAGE, 'Set VIEWER_EPT_IMAGE to the reviewed local Viewer image');
  const unlock = await acquireBrowserHarnessLock('ept-handshake-proof');
  const name = `codex-ept-slice-${process.pid}-${Date.now()}`, profile = mkdtempSync(path.join(tmpdir(), 'codex-ept-slice-'));
  let browser, socket, started = false;
  try {
    const image = docker('image', 'inspect', IMAGE, '--format', '{{.Id}}');
    assert.equal(image.status, 0, image.stderr); assert.equal(image.stdout.trim(), IMAGE_ID, 'local pinned image identity changed');
    t.diagnostic(`Local Viewer image ${image.stdout.trim()}; EPT fixture synthetic-ept-node.laz`);
    const run = docker('run','-d','--rm','--pull','never','--cpus','0.5','--memory','512m','--name',name,'-p','127.0.0.1::8095','-v',`${root}:/candidate:ro`,'--entrypoint','node',IMAGE,'/candidate/test/helpers/ept-handshake-preview.mjs');
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
      const iframe=document.querySelector('#pc-iframe'),hm=await import('/ept-slice-handshake.mjs'),cm=await import('/ept-slice-capability.mjs'),marker=cm.EPT_SLICE_CAPABILITY;
      let uiSliceOn=false,notice=null;const bridge=hm.createEptSliceHandshake({enabled:true,onUnavailable:value=>{uiSliceOn=false;notice=value;}}),disabled=hm.createEptSliceHandshake();let loads=0;
      iframe.addEventListener('load',()=>{loads++;bridge.clear();});
      async function ready(){for(let i=0;i<150;i++){const w=iframe.contentWindow;if(w?.viewer?.scene?.pointclouds?.[0]?.visibleNodes?.length)return w;await new Promise(r=>setTimeout(r,100));}throw Error('iframe point cloud did not load');}
      async function navigate(old){const query='/pointcloud.html?ept=/fixture/ept.json&units=metric&title=Synthetic&points=64'+(old?'&old=1':'');const p=new Promise(resolve=>iframe.addEventListener('load',resolve,{once:true}));iframe.src=query;await p;return iframe.contentWindow;}
      let w=await ready(),api=await w.eval("import('/ept-potree-slice-prototype.mjs')"),impl=api.createEptPotreeSlicePrototype(w.viewer,w.Potree,{onInterrupted:()=>bridge.interrupt(w)}),state={clears:0};
      w.__ltdsEptSliceAdapter={capability:marker,set(settings){const b=w.viewer.scene.getBoundingBox();impl.set({min:b.min.toArray(),max:b.max.toArray()},settings);return true;},clear(){state.clears++;impl.disable();return true;}};
      const adapter=w.__ltdsEptSliceAdapter,defaultDenied=!disabled.connect({frame:w,adapter}),connected=bridge.connect({frame:w,adapter}),activated=bridge.set(w,{axis:'easting',fraction:.65});await new Promise(r=>setTimeout(r,400));const activeBoxes=w.viewer.scene.pointclouds[0].material.clipBoxes.length;
      uiSliceOn=true;w.__pcApi.clearMeasurements();await new Promise(r=>setTimeout(r,300));const interrupted=!bridge.connected&&!uiSliceOn&&notice?.reason==='clip-ownership-lost'&&notice?.cleared===true,interruptedBoxes=w.viewer.scene.pointclouds[0].material.clipBoxes.length;
      const afterInterrupt=bridge.connect({frame:w,adapter})&&bridge.set(w,{axis:'easting',fraction:.65});
      await navigate(true);const clearedOnReload=!bridge.connected,clearsAfterReload=state.clears;w=iframe.contentWindow;const oldMarker=w.Potree?.ltdsSliceCapability||null;w.__ltdsEptSliceAdapter={capability:marker,set(){return true},clear(){return true}};const oldDenied=!bridge.connect({frame:w,adapter:w.__ltdsEptSliceAdapter});
      await navigate(false);w=await ready();api=await w.eval("import('/ept-potree-slice-prototype.mjs')");impl=api.createEptPotreeSlicePrototype(w.viewer,w.Potree);w.__ltdsEptSliceAdapter={capability:marker,set(settings){const b=w.viewer.scene.getBoundingBox();impl.set({min:b.min.toArray(),max:b.max.toArray()},settings);return true},clear(){impl.disable();return true}};
      const mixedDenied=!bridge.connect({frame:w,adapter:{...w.__ltdsEptSliceAdapter,capability:'future-version'}}),reconnected=bridge.connect({frame:w,adapter:w.__ltdsEptSliceAdapter}),reactivated=bridge.set(w,{axis:'northing',fraction:.5});await new Promise(r=>setTimeout(r,400));const disposeResult=bridge.dispose();await new Promise(r=>setTimeout(r,400));const boxesAfterDispose=w.viewer.scene.pointclouds[0].material.clipBoxes.length,closed=!bridge.connected;impl.dispose();
      return {defaultDenied,connected,activated,activeBoxes,interrupted,interruptedBoxes,afterInterrupt,clearedOnReload,clearsAfterReload,oldMarker,oldDenied,mixedDenied,reconnected,reactivated,disposeResult,boxesAfterDispose,closed,loads};
    })()`);
    assert.deepEqual(result,{defaultDenied:true,connected:true,activated:true,activeBoxes:1,interrupted:true,interruptedBoxes:0,afterInterrupt:true,clearedOnReload:true,clearsAfterReload:2,oldMarker:null,oldDenied:true,mixedDenied:true,reconnected:true,reactivated:true,disposeResult:true,boxesAfterDispose:0,closed:true,loads:2});
    t.diagnostic(JSON.stringify(result));
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
