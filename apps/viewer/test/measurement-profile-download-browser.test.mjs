import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {inflateSync} from 'node:zlib';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireBrowserHarnessLock} from './browser-lock.mjs';

// Isolated browser/loopback fixture. No user browser, credentials or downloads.
// In particular, do NOT intercept anchors, object URLs, canvas or toBlob here.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class Cdp {
  constructor(socket){this.socket=socket;this.next=0;this.pending=new Map();this.errors=[];socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')this.errors.push(m.params.exceptionDetails);const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((r,j)=>{socket.addEventListener('open',r,{once:true});socket.addEventListener('error',j,{once:true});});return new Cdp(socket);}
  command(method,params={}){const id=++this.next;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},10000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const r=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result?.value;}
  close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Fixture closed'));}this.pending.clear();this.socket.close();}
}
const page=`<!doctype html><html><head><link rel="stylesheet" href="/measurement-workspace.css"><link rel="stylesheet" href="/measurement-volume-dialog.css"><style>body{background:#10151b;color:white;font:14px sans-serif}#host{width:1000px}</style></head><body><div id="host"></div><script type="module">
import {mountNativeProfile} from '/measurement-profile-panel.mjs';
const source={assetId:'fixture-dsm',kind:'dsm',sha256:'a'.repeat(64),modelVersionId:'fixture-version',crs:'EPSG:32616',verticalUnit:'m',verticalUnitBasis:'gdal-band-unit',resolutionM:[2.5,2.5]};
const parent='22222222-2222-4222-8222-222222222222';
const record={id:'11111111-1111-4111-8111-111111111111',name:'Download fixture pile',revision:2,collection:'map',kind:'polygon',vertices:[[0,0,0],[10,0,0],[10,10,0],[0,10,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},results:{method:'surface-cut-fill',status:'calculated',calculationJobId:parent,cutM3:12,fillM3:2,netM3:10,coverage:1,source,reference:{type:'boundary-triangulated'},warnings:[]}};
const initial=JSON.stringify(record);let handle;
handle=mountNativeProfile(document.querySelector('#host'),{record,getRecord:()=>record,units:'metric',calculate:async(_record,{line})=>{
const lengthM=Math.hypot(line.end[0]-line.start[0],line.end[1]-line.start[1]),at=t=>line.start.map((v,i)=>v+(line.end[i]-v)*t);
return {schemaVersion:1,status:'calculated',method:'surface-transect',calculationOrigin:'server-native-raster',sampling:'native-cell-step',lengthM,line,cellCount:4,parentCalculationId:parent,baseHash:'b'.repeat(64),source,segments:Array.from({length:4},(_,i)=>({startM:lengthM*i/4,endM:lengthM*(i+1)/4,start:at(i/4),end:at((i+1)/4),status:i===1?'nodata':'sample',cell:[i,2],...(i===1?{}:{surfaceM:[-2,0,4,1][i],baseStartM:-3,baseEndM:-3})}))};}});
window.fixture={unchanged:()=>initial===JSON.stringify(record),dispose:()=>handle.dispose()};document.body.dataset.ready='true';
</script></body></html>`;

async function waitUntil(condition,label){const end=Date.now()+10000;while(Date.now()<end){if(await condition())return;await delay(30);}throw new Error(`Timed out: ${label}`);}
async function click(client,selector){const {x,y}=await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);await client.command('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1});await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1});}
function verifyPng(bytes){
  assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);
  const chunks=[];let pos=8,width,height;
  while(pos+12<=bytes.length){const length=bytes.readUInt32BE(pos),type=bytes.toString('ascii',pos+4,pos+8);assert.ok(pos+12+length<=bytes.length);const payload=bytes.subarray(pos+8,pos+8+length);if(type==='IHDR'){width=payload.readUInt32BE(0);height=payload.readUInt32BE(4);assert.ok(width>500&&height>200);}if(type==='IDAT')chunks.push(payload);pos+=length+12;if(type==='IEND')break;}
  assert.equal(pos,bytes.length);assert.ok(chunks.length);assert.ok(inflateSync(Buffer.concat(chunks)).length>width*height);return {width,height};
}
test('native profile exports create real CSV and PNG files using browser downloads',{timeout:60000},async t=>{
  const binary=[process.env.CHROME_PATH,process.env.EDGE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
  if(!binary){t.skip('Chromium-family browser required');return;}
  const unlock=await acquireBrowserHarnessLock({root});let server,browser,client,temporary;
  try{
    temporary=mkdtempSync(path.join(tmpdir(),'ltds-profile-download-test-'));const downloads=path.join(temporary,'downloads'),profile=path.join(temporary,'profile');mkdirSync(downloads);mkdirSync(profile);
    server=createServer((req,res)=>{const pathname=new URL(req.url,'http://fixture.invalid').pathname;if(pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(page);}if(!/^\/[a-z0-9-]+\.(mjs|css)$/.test(pathname)){res.statusCode=404;return res.end();}const file=path.join(root,pathname.slice(1));if(!existsSync(file)){res.statusCode=404;return res.end();}res.setHeader('Content-Type',file.endsWith('.css')?'text/css':'application/javascript');res.end(readFileSync(file));});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=spawn(binary,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const active=path.join(profile,'DevToolsActivePort');await waitUntil(()=>existsSync(active),'browser startup');
    const port=readFileSync(active,'utf8').split(/\r?\n/)[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();client=await Cdp.connect(tabs.find(x=>x.type==='page').webSocketDebuggerUrl);
    await client.command('Runtime.enable');await client.command('Page.enable');await client.command('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});await client.command('Emulation.setDeviceMetricsOverride',{width:1200,height:1100,deviceScaleFactor:1,mobile:false});
    await client.command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await waitUntil(()=>client.evaluate("document.body?.dataset.ready==='true'"),'fixture mount');
    await waitUntil(()=>client.evaluate("!document.querySelector('[data-profile-csv]').disabled"),'automatic profile result');
    await click(client,'[data-profile-csv]');const csvFile=path.join(downloads,'elevation-profile.csv');await waitUntil(()=>existsSync(csvFile),'CSV actual download');
    const csv=readFileSync(csvFile,'utf8');assert.equal(csv.split('\r\n').length,5);assert.ok(csv.split('\r\n').every(row=>row.split(',').length===19));assert.match(csv,/"-2"/);assert.match(csv,/"nodata"/);assert.match(csv,/EPSG:32616/);assert.match(csv,new RegExp('a'.repeat(64)));
    await click(client,'[data-profile-png]');const pngFile=path.join(downloads,'elevation-profile.png');await waitUntil(()=>existsSync(pngFile),'PNG actual download');const png=readFileSync(pngFile),dimensions=verifyPng(png);assert.ok(png.length>5000);
    assert.deepEqual(readdirSync(downloads).sort(),['elevation-profile.csv','elevation-profile.png']);assert.equal(await client.evaluate('fixture.unchanged()'),true);await client.evaluate('fixture.dispose()');assert.equal(await client.evaluate("document.querySelectorAll('[data-profile-csv],[data-profile-png]').length"),0);assert.deepEqual(client.errors,[]);
    t.diagnostic(`Real downloaded CSV ${Buffer.byteLength(csv)} bytes; PNG ${png.length} bytes, ${dimensions.width}x${dimensions.height}; source measurement unchanged.`);
  }finally{
    client?.close();if(browser){const exited=new Promise(r=>browser.once('exit',r));browser.kill();await Promise.race([exited,delay(3000)]);}if(server){server.closeAllConnections?.();await new Promise(r=>server.close(r));}unlock();
    if(temporary){const absolute=path.resolve(temporary);assert.ok(absolute.startsWith(path.resolve(tmpdir(),'ltds-profile-download-test-')));try{rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))throw error;t.diagnostic(`Isolated browser temporary lock retained: ${absolute}`);}}
  }
});
