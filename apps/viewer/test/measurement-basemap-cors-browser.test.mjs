import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {acquireBrowserHarnessLock} from './browser-lock.mjs';

// Two synthetic loopback origins, fresh hidden browser, real Leaflet and shipped
// map capture. Never attach to a user browser or weaken browser CORS enforcement.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=readFileSync(path.join(root,'main.js'),'utf8').replace(/\r\n/g,'\n');
const layer=source.match(/L\.tileLayer\('https:\/\/server\.arcgisonline\.com[^']*',\s*(\{[\s\S]*?\})\)\.addTo\(map\);/)?.[1];
const capture=source.match(/async capture\(\) \{([\s\S]*?)\n      \},\n    \};/)?.[1];
assert.ok(layer&&capture,'shipped basemap options and map capture must be found');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const binary=()=>[process.env.CHROME_PATH,process.env.EDGE_PATH,'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].filter(Boolean).find(existsSync);
class Cdp{
  constructor(socket){this.socket=socket;this.sequence=0;this.pending=new Map();socket.addEventListener('message',event=>{const m=JSON.parse(event.data),p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);}});}
  static async connect(url){const socket=new WebSocket(url);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});return new Cdp(socket);}
  command(method,params={}){const id=++this.sequence;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`CDP timeout: ${method}`));},10000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  async evaluate(expression){const value=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(value.exceptionDetails)throw new Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result?.value;}
  close(){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Fixture closed'));}this.pending.clear();this.socket.close();}
}
const listen=server=>new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`)));
const stop=async server=>{if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}};
function page(tileOrigin,mode){return `<!doctype html><link rel="stylesheet" href="/leaflet.css"><style>#map{width:300px;height:300px}</style><div id="map"></div><script src="/leaflet.js"></script><script>
const dom={leafletMap:document.querySelector('#map')};
const map=L.map(dom.leafletMap,{zoomControl:false,attributionControl:false,fadeAnimation:false}).setView([0,0],0);
const options=${layer};
${mode==='legacy'?'options.crossOrigin=false;':''}
const tiles=L.tileLayer(${JSON.stringify(`${tileOrigin}/${mode}/{z}/{y}/{x}.png`)},options);
let loaded=0,failed=0;tiles.on('tileload',()=>loaded++);tiles.on('tileerror',()=>failed++);tiles.on('load',()=>document.body.dataset.ready='true');tiles.addTo(map);
window.check=async()=>{const images=[...dom.leafletMap.querySelectorAll('img')];let exported=null,error=null;try{const c=await(async()=>{${capture}})();exported=c.toDataURL();}catch(e){error={name:e.name,message:e.message};}const blank=document.createElement('canvas');blank.width=300;blank.height=300;const ctx=blank.getContext('2d');ctx.fillStyle='#101010';ctx.fillRect(0,0,300,300);return{loaded,failed,crossOrigin:images.map(i=>i.crossOrigin),exported,onlyBlankBackground:exported===blank.toDataURL(),error};};
</script>`;}

test('shipped Leaflet basemap CORS permits approved canvas export and rejects denied images',{timeout:60000},async t=>{
  const executable=binary();if(!executable){t.skip('Chromium-family browser required for isolated CORS regression.');return;}
  const unlock=await acquireBrowserHarnessLock({root});let browser,client,profile,web,tiles;
  const requests=[];
  try{
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMZkAAAAASUVORK5CYII=','base64');
    tiles=createServer((req,res)=>{requests.push({url:req.url,origin:req.headers.origin||null,cookie:req.headers.cookie||null});if(req.url.startsWith('/approved/'))res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','image/png');res.end(png);});
    const tileOrigin=await listen(tiles);
    web=createServer((req,res)=>{const url=new URL(req.url,'http://fixture.invalid');if(['/leaflet.js','/leaflet.css'].includes(url.pathname)){res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':'text/css');return res.end(readFileSync(path.join(root,'node_modules/leaflet/dist',url.pathname.slice(1))));}res.setHeader('Content-Type','text/html');res.end(page(tileOrigin,url.searchParams.get('mode')||'approved'));});
    const origin=await listen(web);profile=mkdtempSync(path.join(tmpdir(),'ltds-basemap-cors-'));
    browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const active=path.join(profile,'DevToolsActivePort'),until=Date.now()+10000;while(!existsSync(active)&&Date.now()<until)await delay(50);assert.ok(existsSync(active));
    const port=readFileSync(active,'utf8').split(/\r?\n/)[0],tabs=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();client=await Cdp.connect(tabs.find(tab=>tab.type==='page').webSocketDebuggerUrl);
    await client.command('Runtime.enable');await client.command('Page.enable');
    const inspect=async mode=>{const url=`${origin}/?mode=${mode}`;await client.command('Page.navigate',{url});const until=Date.now()+8000;while(Date.now()<until){if(await client.evaluate(`location.href===${JSON.stringify(url)}&&document.body?.dataset.ready==='true'`))return client.evaluate('check()');await delay(25);}throw new Error(`Tiles never settled: ${mode}`);};
    await t.test('approved separate origin receives anonymous CORS and exports real loaded tiles',async()=>{const out=await inspect('approved');assert.ok(out.loaded>0);assert.equal(out.failed,0);assert.ok(out.crossOrigin.every(v=>v==='anonymous'));assert.equal(out.error,null);assert.equal(out.onlyBlankBackground,false,'approved visible basemap pixels must be included');assert.match(out.exported,/^data:image\/png;base64,/);const read=requests.filter(r=>r.url.startsWith('/approved/'));assert.ok(read.length);assert.ok(read.every(r=>r.origin===origin&&r.cookie===null));});
    // Leaflet hides denied images: the visible map and capture are both blank.
    // That is not omission of a visible layer or permission to read denied pixels.
    await t.test('denied CORS never loads or exposes remote image pixels',async()=>{const out=await inspect('denied');assert.equal(out.loaded,0);assert.ok(out.failed>0);assert.ok(out.crossOrigin.every(v=>v==='anonymous'));assert.ok(out.error||out.onlyBlankBackground,'denied images must fail or leave only the blank background, never expose remote pixels');const read=requests.filter(r=>r.url.startsWith('/denied/'));assert.ok(read.length);assert.ok(read.every(r=>r.origin===origin&&r.cookie===null));});
    await t.test('legacy no-CORS control loads but shipped capture rejects tainted canvas',async()=>{const out=await inspect('legacy');assert.ok(out.loaded>0);assert.equal(out.failed,0);assert.equal(out.exported,null);assert.match(out.error?.message||'',/basemap prevents browser image export/);});
  }finally{
    client?.close();if(browser){const exited=new Promise(resolve=>browser.once('exit',resolve));browser.kill();await Promise.race([exited,delay(3000)]);}await stop(web);await stop(tiles);unlock();
    if(profile){const absolute=path.resolve(profile);assert.ok(absolute.startsWith(path.resolve(tmpdir(),'ltds-basemap-cors-')));try{rmSync(absolute,{recursive:true,force:true,maxRetries:10,retryDelay:100});}catch(error){if(process.platform!=='win32'||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(error.code))throw error;t.diagnostic(`Browser retained isolated temporary profile lock: ${absolute}`);}}
  }
});
