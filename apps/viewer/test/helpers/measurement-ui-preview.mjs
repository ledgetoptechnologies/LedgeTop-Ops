// Local-only pixel/interaction fixture. Shipped sidebar HTML/CSS, measurement
// workspace/store/dialog and native browser integration; synthetic rendering,
// source elevations and deliberately delayed mock persistence. No production API.
import {createServer} from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const index=await fs.readFile(path.join(root,'index.html'),'utf8');
const style=index.match(/<style>([\s\S]*?)<\/style>/)?.[1];
function panel(id,next){const start=index.indexOf(`<div class="panel" id="${id}"`),end=index.indexOf(`<div class="panel" id="${next}"`,start);if(start<0||end<start)throw new Error(`Missing shipped panel ${id}`);return index.slice(start,end);}
const sidebar=panel('panel-nav','panel-camera-positions')+panel('panel-camera-positions','panel-measure')+panel('panel-measure','panel-camera');
const hiddenLayers=index.match(/<div class="panel" id="panel-3d-layers"[^>]*>/)?.[0]||'<div class="panel" id="panel-3d-layers" hidden>';
const base={collection:'spatial3d',coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},visible:true,source:{kind:'mesh'},displayPreferences:{units:'m'},revision:1};
const seeds=[{...base,id:'10000000-0000-4000-8000-000000000001',name:'Synthetic feed pile — 572 m³ above zero base',kind:'polygon',vertices:[[30,20,0],[52,20,0],[52,33,0],[30,33,0]]},...Array.from({length:4},(_,i)=>({...base,id:`10000000-0000-4000-8000-00000000000${i+2}`,name:`Synthetic pad distance ${i+1}`,kind:'distance',vertices:[[12+i*3,8+i*6,0],[40+i*3,8+i*6,0]]}))];
const records=new Map(seeds.map((r,i)=>[r.id,i>=3?{...r,collection:'map',source:{kind:'ortho'}}:r]));
const port=Number(process.env.MEASUREMENT_PREVIEW_PORT||4471);
const script=`import {createMeasurementWorkspace} from '/measurement-workspace.mjs';
import {calculateBrowserSurface} from '/measurement-browser-surface.mjs';
const host=document.querySelector('#fixture-viewport'),canvas=host.querySelector('canvas'),ctx=canvas.getContext('2d');
let mode='model',moves=0,failSurface=false;
const transform=()=>{const r=canvas.getBoundingClientRect(),scale=Math.min(r.width/85,r.height/60);return{r,scale,x:(r.width-85*scale)/2,y:(r.height-60*scale)/2};};
function paint(){const {r,scale,x,y}=transform();canvas.width=Math.max(1,Math.round(r.width));canvas.height=Math.max(1,Math.round(r.height));ctx.fillStyle='#16212c';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.strokeStyle='#334a60';for(let e=0;e<=85;e+=5){ctx.beginPath();ctx.moveTo(x+e*scale,y);ctx.lineTo(x+e*scale,y+60*scale);ctx.stroke();}for(let n=0;n<=60;n+=5){ctx.beginPath();ctx.moveTo(x,y+n*scale);ctx.lineTo(x+85*scale,y+n*scale);ctx.stroke();}ctx.fillStyle='#647b88';ctx.fillRect(x+30*scale,y+27*scale,22*scale,13*scale);ctx.fillStyle='white';ctx.font='13px sans-serif';ctx.fillText('Synthetic surface: 2 m above zero. Grid spacing: 5 m.',x+10,y+20);}
new ResizeObserver(paint).observe(host);paint();
const workspace=createMeasurementWorkspace({panel:document.querySelector('#panel-measure'),context:()=>({mode,element:canvas,host,pick:e=>{const{r,scale,x,y}=transform();return[(e.clientX-r.left-x)/scale,60-(e.clientY-r.top-y)/scale,0];},project:p=>{const{scale,x,y}=transform();return[x+p[0]*scale,y+(60-p[1])*scale];},capture:async()=>{paint();const copy=document.createElement('canvas');copy.width=canvas.width;copy.height=canvas.height;copy.getContext('2d').drawImage(canvas,0,0);return copy;},focus:()=>{document.querySelector('#fixture-status').textContent='Synthetic focus: full source is already fitted.';}}),token:()=> 'synthetic-local-fixture',permitted:()=>true,coordinateReference:()=>({crs:'EPSG:32616',verticalUnit:'m'}),toLonLat:()=>[-87,43],toolChanged:tool=>{document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===tool));document.querySelector('#fixture-status').textContent=mode+' · '+tool;},resolveDisplayVertices:async(record,{signal})=>{await new Promise(r=>setTimeout(r,400));if(signal.aborted)throw new DOMException('Aborted','AbortError');if(failSurface)throw new Error('Synthetic elevation unavailable');return{vertices:record.vertices.map(([e,n])=>[e,n,2]),basis:'Synthetic 2 m elevation placement; display only'};},calculateSurface:async(record,{reference,signal})=>{await new Promise(r=>setTimeout(r,700));if(failSurface)throw new Error('Synthetic source vertical units required. No production dataset was accessed.');return calculateBrowserSurface({vertices:record.vertices,reference,values:new Float64Array(85*60).fill(2),width:85,height:60,bounds:{minE:0,maxE:85,minN:0,maxN:60}},{signal});}});
document.querySelectorAll('[data-tool]').forEach(b=>b.onclick=()=>workspace.setTool(b.dataset.tool));
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{workspace.modeChanged();mode=b.dataset.mode;document.querySelectorAll('[data-mode]').forEach(t=>t.classList.toggle('active',t===b));document.querySelector('#fixture-status').textContent=mode;workspace.tick();});
const toggle=()=>{const sidebar=document.querySelector('#sidebar'),collapsed=sidebar.classList.toggle('collapsed');document.querySelector('#sidebar-toggle').setAttribute('aria-expanded',String(!collapsed));};document.querySelector('#sidebar-toggle').onclick=toggle;document.querySelector('#fixture-collapse').onclick=toggle;
document.querySelector('#fixture-failure').onchange=e=>{failSurface=e.target.checked;};
document.querySelector('#layer-cameras').onclick=e=>{e.target.textContent=e.target.textContent==='Show'?'Hide':'Show';document.querySelector('#fixture-status').textContent='Camera button appearance only; use map-camera-overlay fixture for pin interactions.';};
canvas.addEventListener('pointermove',e=>{if(e.buttons){moves++;document.querySelector('#fixture-navigation').textContent='Navigation gestures: '+moves;}});
window.fixtureReady=true;
`;
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local measurement UI QA — synthetic only</title><style>${style}</style><style>#fixture-viewport{position:relative;flex:1;min-width:0;overflow:hidden}#fixture-viewport>canvas{width:100%;height:100%;touch-action:none}#fixture-note{padding:6px 12px;background:#202631;color:#c6d0dd;font:12px sans-serif;display:flex;flex-wrap:wrap;gap:12px}#topbar{height:auto;min-height:60px;flex-wrap:wrap;gap:8px;padding:8px 12px}#view-tabs{flex-wrap:wrap}#fixture-note button{background:#282e38;border:1px solid #777;color:white;border-radius:5px;padding:4px 8px}#fixture-navigation{position:absolute;bottom:8px;right:12px;font:12px sans-serif;color:#cad4df;pointer-events:none}#sidebar-toggle{top:14px}</style></head><body><div id="app"><header id="topbar"><strong>Local synthetic QA</strong><div id="view-tabs">${[['model','3D Model'],['cloud','Point Cloud'],['ortho','Orthophoto'],['dsm','DSM'],['dtm','DTM']].map(([mode,label])=>`<button class="tab-btn ${mode==='model'?'active':''}" data-mode="${mode}">${label}</button>`).join('')}</div></header><div id="fixture-note"><span>No production API, credentials or real files. Synthetic private records reset when this helper restarts.</span><button id="fixture-collapse">Toggle sidebar</button><label><input type="checkbox" id="fixture-failure"> Simulate source error</label><output id="fixture-status" role="status">Ready</output></div><main id="main"><aside id="sidebar"><div id="sidebar-custom">${hiddenLayers}<h3>Hidden Layers regression sentinel</h3></div>${sidebar}</div></aside><section id="fixture-viewport"><canvas tabindex="0" aria-label="Synthetic measurement surface"></canvas><output id="fixture-navigation">Navigation gestures: 0</output></section><button id="sidebar-toggle" aria-label="Toggle tools" aria-expanded="true" aria-controls="sidebar">☰</button></main></div><script type="module" src="/fixture.js"></script></body></html>`;
const server=await createServer({root,configFile:false,appType:'custom',server:{host:'127.0.0.1',port,strictPort:true},plugins:[{name:'synthetic-measurement-ui',configureServer(server){server.middlewares.use(async(req,res,next)=>{
  if(!['127.0.0.1','localhost'].includes(String(req.headers.host||'').split(':')[0]))return res.writeHead(403).end();
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end(await server.transformIndexHtml('/',html));}
  if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');return res.end(script);}
  if(req.url?.startsWith('/api/')){
    res.setHeader('Content-Type','application/json');if(!req.url.startsWith('/api/v1/measurements'))return res.writeHead(404).end('{}');
    const id=req.url.split('/')[4];if(req.method==='GET'){const collection=new URL(req.url,'http://127.0.0.1').searchParams.get('collection');return res.end(JSON.stringify({measurements:[...records.values()].filter(r=>!collection||r.collection===collection),capabilities:{personalPersistence:true},persistent:true}));}
    if(req.method==='DELETE'){records.delete(id);return res.writeHead(204).end();}
    let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>200000)return res.writeHead(413).end('{}');}
    try{const record=JSON.parse(raw),previous=records.get(id||record.id);await new Promise(r=>setTimeout(r,250));if(previous&&record.revision!==records.get(previous.id)?.revision)return res.writeHead(409).end(JSON.stringify({error:'Synthetic revision conflict'}));record.revision=(previous?.revision||0)+1;records.set(record.id,record);return res.end(JSON.stringify({measurement:record}));}catch{return res.writeHead(400).end('{}');}
  }
  next();
});}}]});
await server.listen();console.log('Synthetic shipped measurement UI: http://127.0.0.1:'+port);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await server.close();process.exit(0);});
