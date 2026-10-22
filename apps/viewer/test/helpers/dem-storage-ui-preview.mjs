// Local-only visual QA of shipped UI/raster functions with synthetic data.
// No model sessions, credentials, live data or production services are used.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {createStorageUsageMonitor,measureStorageUsage}=require('../../server/storageUsage');
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const main=await fs.readFile(path.join(root,'main.js'),'utf8'),workspace=await fs.readFile(path.join(root,'workspace-projects.js'),'utf8'),index=await fs.readFile(path.join(root,'index.html'),'utf8');
function fn(source,name){const start=source.search(new RegExp(`(?:async )?function ${name}\\(`));if(start<0)throw new Error(`Missing shipped function ${name}`);const end=source.indexOf('\n}',start);return source.slice(start,end+2);}
function line(source,prefix){const value=source.split(/\r?\n/).find(value=>value.startsWith(prefix));if(!value)throw new Error(`Missing ${prefix}`);return value;}
const panel=index.slice(index.indexOf('<div class="panel" id="panel-dem"'),index.indexOf('<div class="panel" id="panel-pc"')).replace('style="display:none;"','');
const volume=index.slice(index.indexOf('<div id="map-volume-options"'),index.indexOf('\n          <div id="measure-output"'));
const cmapStart=main.indexOf('const COLORMAPS ='),colormaps=main.slice(cmapStart,main.indexOf('\n};',cmapStart)+3);
const bindings=main.slice(main.indexOf("  document.getElementById('dem-opacity').addEventListener"),main.indexOf('  bindPcPanel();'));
const cameraGate=main.split(/\r?\n/).find(value=>value.includes("getElementById('panel-camera-positions').style.display"));
const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-dem-storage-preview-'));
const roots=Object.fromEntries(['datasets','models','cache','trash'].map(key=>[key,path.join(scratch,key)]));for(const value of Object.values(roots))await fs.mkdir(value);
const photo=path.join(roots.models,'source-photo.jpg'),product=path.join(roots.models,'mesh.glb');
await fs.writeFile(photo,Buffer.alloc(11000));await fs.writeFile(product,Buffer.alloc(23000));await fs.writeFile(path.join(roots.cache,'staging.bin'),Buffer.alloc(7000));await fs.writeFile(path.join(roots.trash,'retired.bin'),Buffer.alloc(5000));await fs.writeFile(path.join(roots.models,'metadata.bin'),Buffer.alloc(3000));
let monitor;
const resetMonitor=()=>{monitor=createStorageUsageMonitor({storage:{roots},measure:async args=>{await new Promise(resolve=>setTimeout(resolve,1800));return measureStorageUsage({...args,categories:new Map([[photo,'sources'],[product,'products']])});}});};resetMonitor();
const page=`<!doctype html><html><head><meta charset="utf-8"><title>Candidate DEM and storage UI QA</title><style>body{font:16px system-ui;background:#101114;color:#eee;margin:24px}button,input,select{font:inherit;margin:6px;padding:6px}button{cursor:pointer}.layout{display:grid;grid-template-columns:400px 1fr;gap:24px}.slider-row{display:flex;align-items:center;gap:8px;margin:8px 0}.slider-row input{min-width:0;width:95px}.hint,small{color:#abb3be}canvas{width:480px;height:360px;image-rendering:pixelated;border:1px solid #666;background:repeating-conic-gradient(#333 0 25%,#111 0 50%) 0/20px 20px}.metric-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.metric-card{border:1px solid #555;padding:14px}.metric-card strong{display:block;font-size:25px}.metric-card small{display:block}#map-volume-options{border:1px solid #555;padding:8px}</style></head><body><h1>Candidate elevation and storage UI QA</h1><p>Actual shipped rendering/settings/card functions; synthetic raster and temporary files. Not full GeoTIFF/Leaflet or production model/session QA.</p><div><button id="mode-dsm">DSM</button><button id="mode-dtm">DTM</button><label>Units <select id="units"><option value="imperial">Feet</option><option value="metric">Meters</option></select></label><button id="tool-volume">Volume</button></div><div class="layout"><div>${panel}<section id="panel-camera-positions"><h3>Camera positions</h3><button id="layer-cameras">Show Camera Positions</button><p>Availability gate is shipped; this harness does not load Leaflet camera markers.</p></section><div id="map-volume-options"><label>Surface <select id="map-volume-surface"><option value="auto">Auto</option><option value="dsm">DSM</option><option value="dtm">DTM</option></select></label><label>Reference <select id="map-volume-reference"><option value="lowest">Lowest sampled point</option><option value="average">Average surface</option></select></label></div></div><section><canvas id="raster" width="128" height="128"></canvas><p id="render-status" role="status">Waiting for render</p><p>Left-to-right synthetic elevation 0–100 meters. Changing the color range must not erase valid pixels.</p></section></div><h2>Measured storage</h2><button id="refresh-storage">Refresh storage</button><button id="restart-measurement">Restart synthetic measurement</button><div id="storage-cards" class="metric-grid"></div><script type="module">
import {createDemUpdateQueue} from '/dem-update-queue.mjs';
import {createStorageUsagePoll} from '/storage-usage-poll.mjs';
${['const esc=','const bytes=','const available=','const dateTime=','function metric('].map(prefix=>line(workspace,prefix)).join('\n')}
${fn(workspace,'storageUsageCards')}
let DISPLAY_UNITS='imperial';const METERS_TO_FT=3.280839895013123;const normalizeUnits=value=>value==='metric'?'metric':'imperial';
const dom={demColormap:document.querySelector('#dem-colormap'),demShading:document.querySelector('#dem-shading'),demMin:document.querySelector('#dem-min'),demMax:document.querySelector('#dem-max'),demMinLabel:document.querySelector('#dem-min-label'),demMaxLabel:document.querySelector('#dem-max-label')};
${line(main,'function setDisplayUnits(')}
${line(main,'function elevationInputMeters(')}
${colormaps}
${fn(main,'sampleCmap')}
${fn(main,'hillshadeFactor')}
${fn(main,'renderDemTile')}
const demSettings={cmap:'viridis',shade:1,minFt:null,maxFt:null,steps:0};const state={activeMode:'dsm',activeTool:'none'},modeAbortController={signal:new AbortController().signal},SHOTS_URL='/synthetic-shots',SHARE_PERMISSIONS={cameras:true},DSM_URL='/synthetic-dsm',DTM_URL='/synthetic-dtm';
const raster=[Float32Array.from({length:128*128},(_,i)=>(i%128)/127*100+Math.sin(Math.floor(i/128)/10)*2)];const ds={min:0,max:102,nodata:-9999,minE:0,maxE:128,minN:0,maxN:128};const canvas=document.querySelector('#raster');let paints=0;
const overviewCanvas=async(_ds,render)=>{await new Promise(resolve=>setTimeout(resolve,140));return{canvas:render(raster,128,128,ds)}};
const setUrl=url=>{const image=new Image();image.onload=()=>{canvas.getContext('2d').drawImage(image,0,0);const pixels=canvas.getContext('2d').getImageData(0,0,128,128).data;let transparent=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i]<255)transparent++;document.querySelector('#render-status').textContent='Paint '+(++paints)+' · '+state.activeMode.toUpperCase()+' · '+demSettings.cmap+' · range '+demSettings.minFt+' to '+demSettings.maxFt+' · nonopaque valid pixels '+transparent;};image.src=url;};
const layer={ds,overlay:{setUrl,setOpacity:value=>canvas.style.opacity=String(value)},grid:{redraw(){},setOpacity(){}}};const demLayers={dsm:layer,dtm:null};
function refreshLegendFor(){}function showError(message){document.querySelector('#render-status').textContent=message;}
${fn(main,'applyDemOpacity')}
${fn(main,'applyDemSettings')}
${fn(main,'resetDemSettings')}
${fn(main,'isMapMode')}
${fn(main,'syncMapVolumeAvailability')}
const demUpdateQueue=createDemUpdateQueue(applyDemSettings,{onError:error=>showError(error.message)});
${bindings}
function setMode(mode){state.activeMode=mode;state.activeTool='none';demLayers.dsm=mode==='dsm'?layer:null;demLayers.dtm=mode==='dtm'?layer:null;const is3D=false,isPC=false;${cameraGate}syncMapVolumeAvailability();demUpdateQueue.request({immediate:true});}
document.querySelector('#mode-dsm').onclick=()=>setMode('dsm');document.querySelector('#mode-dtm').onclick=()=>setMode('dtm');document.querySelector('#tool-volume').onclick=()=>{state.activeTool=state.activeTool==='volume'?'none':'volume';syncMapVolumeAvailability();};
document.querySelector('#units').onchange=e=>{setDisplayUnits(e.target.value);demUpdateQueue.request({immediate:true});};
let usage=null;
function showUsage(data){usage=data;document.querySelector('#storage-cards').innerHTML=storageUsageCards(data);}
const storagePoll=createStorageUsagePoll({shouldPoll:()=>!document.hidden&&(usage?.status==='pending'||usage?.refreshing),read:async signal=>(await fetch('/usage',{signal})).json(),onResult:showUsage,onError:message=>document.querySelector('#storage-cards').insertAdjacentHTML('beforeend',metric('Storage refresh','Paused',message))});
async function refreshStorage(){showUsage(await(await fetch('/usage')).json());storagePoll.sync();}
document.querySelector('#refresh-storage').onclick=()=>{storagePoll.stop();refreshStorage();};document.querySelector('#restart-measurement').onclick=async()=>{storagePoll.stop();await fetch('/reset',{method:'POST'});await refreshStorage();};document.addEventListener('visibilitychange',()=>storagePoll.sync());addEventListener('pagehide',()=>storagePoll.stop());setMode('dsm');refreshStorage();
</script></body></html>`;
const server=http.createServer(async(req,res)=>{if(!['127.0.0.1','localhost'].includes(String(req.headers.host||'').split(':')[0])){res.writeHead(403).end();return;}res.setHeader('Cache-Control','no-store');if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(page);}else if(['/dem-update-queue.mjs','/storage-usage-poll.mjs'].includes(req.url)){res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(path.join(root,req.url.slice(1))));}else if(req.url==='/usage'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(monitor.read()));}else if(req.url==='/reset'&&req.method==='POST'){resetMonitor();res.end('reset');}else res.writeHead(404).end();});
server.listen(Number(process.env.PORT)||4458,'127.0.0.1',()=>console.log(`Synthetic DEM/storage QA: http://127.0.0.1:${server.address().port}`));
async function stop(){server.close();await monitor.whenIdle();await fs.rm(scratch,{recursive:true,force:true});process.exit(0);}process.on('SIGINT',stop);process.on('SIGTERM',stop);
