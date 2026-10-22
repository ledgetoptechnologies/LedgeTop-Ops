import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireBrowserHarnessLock} from './browser-lock.mjs';

// Real shipped header/CSS in a fresh hidden browser, no user browser or network.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(path.join(root,'index.html'),'utf8');
const css=source.match(/<style>([\s\S]*?)<\/style>/)?.[1];
const header=source.match(/<header id="topbar">[\s\S]*?<\/header>/)?.[0];
assert.ok(css&&header);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const binary=()=>[process.env.CHROME_PATH,process.env.EDGE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
class Cdp{
  constructor(socket){this.socket=socket;this.sequence=0;this.pending=new Map();socket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});return new Cdp(socket);}
  command(method,params={}){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},10000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const value=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result?.value;}
  close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Fixture closed'));}this.pending.clear();this.socket.close();}
}
const project='County Road D — Stockpile Survey — A deliberately long accessible project name';
function page(){const logo=`data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="38" height="38"><rect width="38" height="38" fill="orange"/></svg>').toString('base64')}`;return `<!doctype html><meta name="viewport" content="width=device-width"><style>${css}</style><div id="app">${header.replace(/src="[^"]+"/,`src="${logo}"`)}<div id="main">Viewer fixture</div></div><script>document.querySelector('#brand-project').textContent=${JSON.stringify(project)};window.clicked=[];for(const button of document.querySelectorAll('.tab-btn'))button.onclick=()=>clicked.push(button.dataset.mode);document.body.dataset.ready='true';</script>`;}

test('shipped Viewer header fits phone, narrow desktop and full desktop with named navigation',{timeout:60000},async t=>{
  const executable=binary();if(!executable){t.skip('Chromium-family browser required for isolated header regression.');return;}
  const unlock=await acquireBrowserHarnessLock({root});let browser,client,profile,server;
  try{
    server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(page());});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
    profile=mkdtempSync(path.join(tmpdir(),'ltds-viewer-header-'));
    browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const active=path.join(profile,'DevToolsActivePort'),until=Date.now()+10000;while(!existsSync(active)&&Date.now()<until)await delay(50);assert.ok(existsSync(active));
    const port=readFileSync(active,'utf8').split(/\r?\n/)[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();client=await Cdp.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);await client.command('Runtime.enable');await client.command('Page.enable');
    for(const width of [390,692,1440])for(const admin of [false,true])await t.test(`${width}px ${admin?'staff':'client'} header`,async()=>{
      await client.command('Emulation.setDeviceMetricsOverride',{width,height:912,deviceScaleFactor:1,mobile:false});const url=`${origin}/?width=${width}&admin=${admin}`;await client.command('Page.navigate',{url});const until=Date.now()+8000;while(Date.now()<until){if(await client.evaluate(`location.href===${JSON.stringify(url)}&&document.body?.dataset.ready==='true'`))break;await delay(25);}
      await client.evaluate(`document.querySelector('#admin-controls').style.display=${JSON.stringify(admin?'flex':'none')}`);
      const out=await client.evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,height:r.height,width:r.width};};return {viewport:innerWidth,doc:document.documentElement.scrollWidth,header:rect(document.querySelector('#topbar')),brand:rect(document.querySelector('#brand-info')),title:rect(document.querySelector('#brand-project')),text:document.querySelector('#brand-project').textContent,whiteSpace:getComputedStyle(document.querySelector('#brand-project')).whiteSpace,main:rect(document.querySelector('#main')),nav:rect(document.querySelector('#view-tabs')),buttons:[...document.querySelectorAll('.tab-btn')].map(e=>({...rect(e),label:e.getAttribute('aria-label'),mode:e.dataset.mode}))};})()`);
      assert.equal(out.text,project,'full title remains in accessible text');assert.equal(out.whiteSpace,'nowrap');assert.ok(out.title.height<20);assert.ok(out.brand.height<40,JSON.stringify(out));assert.ok(out.doc<=width);assert.ok(out.main.top>=out.header.bottom-1);assert.ok(out.brand.top>=out.header.top&&out.brand.bottom<=out.header.bottom);assert.ok(out.nav.left>=0&&out.nav.right<=width);assert.ok(out.nav.bottom<=out.header.bottom);assert.ok(out.header.height<=110,JSON.stringify(out));
      for(const button of out.buttons){assert.ok(button.label);assert.ok(button.width>=30&&button.height>=28);assert.ok(button.left>=0&&button.right<=width);await client.command('Input.dispatchMouseEvent',{type:'mousePressed',x:(button.left+button.right)/2,y:(button.top+button.bottom)/2,button:'left',clickCount:1});await client.command('Input.dispatchMouseEvent',{type:'mouseReleased',x:(button.left+button.right)/2,y:(button.top+button.bottom)/2,button:'left',clickCount:1});}
      assert.deepEqual(await client.evaluate('clicked'),['model','cloud','ortho','dsm','dtm']);if(width>1024)assert.equal(out.header.height,60,'desktop stays a single fixed-height row');
    });
  }finally{
    client?.close();if(browser){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,delay(3000)]);}if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}unlock();
    if(profile){const absolute=path.resolve(profile);assert.ok(absolute.startsWith(path.resolve(tmpdir(),'ltds-viewer-header-')));try{rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))throw error;t.diagnostic(`Browser retained isolated temporary profile lock: ${absolute}`);}}
  }
});
