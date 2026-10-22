// Run in an existing Viewer image with this checkout mounted read-only at
// /candidate; serves only synthetic fixtures and viewer assets on port 8095.
// Bind the Docker port to loopback, never a production data mount.
import { createServer } from 'node:http';
import { readFileSync, createReadStream } from 'node:fs';
import path from 'node:path';
const candidate = '/candidate';
const source = readFileSync(path.join(candidate, 'main.js'), 'utf8');
const html = readFileSync(path.join(candidate, 'index.html'), 'utf8');
const panelStart = html.indexOf('<div class="panel" id="panel-pc"');
const panel = html.slice(panelStart, html.indexOf('\n      </div>', panelStart)).replace('style="display:none;"', '');
const helpers = source.slice(source.indexOf('let pcElevationModelId ='), source.indexOf('// View sync between', source.indexOf('let pcElevationModelId =')));
const applyStart = source.indexOf('function applyPcPanelState()');
const apply = source.slice(applyStart, source.indexOf('function updateStatus', applyStart));
const page = `<!doctype html><html><head><meta charset="utf-8"><title>Point-cloud elevation QA</title>
<style>${html.match(/<style>([\s\S]*?)<\/style>/)?.[1] || ''}
body{display:block;padding:16px;background:#171717;color:white;font:14px sans-serif}#panel-pc{width:315px;box-sizing:border-box}#pc-iframe{position:absolute;left:370px;top:16px;width:620px;height:500px;border:0}#qa{position:absolute;left:370px;top:530px;white-space:pre-wrap}h1{font-size:20px}</style></head><body>
<h1>Point-cloud elevation QA</h1>${panel}<iframe id="pc-iframe" title="Synthetic point cloud" src="/pointcloud.html?ept=/fixture/ept.json&amp;units=metric&amp;title=Synthetic%20elevation&amp;points=64"></iframe><pre id="qa">Waiting for actual Potree material</pre>
<script>const PROJECT={id:'synthetic-elevation'}, DISPLAY_UNITS='metric', METERS_TO_FT=3.28084;
function elevationInputMeters(v){return v}function formatElevation(v){return v.toFixed(3)+' m'}
function pcApi(){return document.getElementById('pc-iframe').contentWindow.__pcApi}
${helpers}\n${apply}
bindPcPanel();
window.addEventListener('message', e=>{if(e.source===document.getElementById('pc-iframe').contentWindow&&e.data?.type==='ready')applyPcPanelState()});
function observe(){const pc=document.getElementById('pc-iframe').contentWindow.viewer?.scene.pointclouds[0];
 if(pc)document.getElementById('qa').textContent=JSON.stringify({actualPotreeMaterial:pc.material.constructor.name,color:pc.material.activeAttributeName,elevationRange:pc.material.elevationRange,visiblePoints:pc.numVisiblePoints,range:pcApi()?.getElevationState()},null,2);requestAnimationFrame(observe)}observe();</script></body></html>`;
const ept = { version: '1.0.0', dataType: 'laszip', hierarchyType: 'json', span: 128, points: 64,
  bounds: [367000,4759000,100,367016,4759016,116], boundsConforming:[367000,4759000,100,367015.75,4759003.5,100.3],
  schema: [{name:'X',type:'signed',size:4,scale:.01,offset:367000},{name:'Y',type:'signed',size:4,scale:.01,offset:4759000},
    {name:'Z',type:'signed',size:4,scale:.01,offset:100},{name:'Red',type:'unsigned',size:2},{name:'Green',type:'unsigned',size:2},{name:'Blue',type:'unsigned',size:2}],
  srs:{authority:'EPSG',horizontal:'32616'} };
const mime = {'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.laz':'application/octet-stream'};
function stream(root, relative, response) {
  const absolute=path.resolve(root,relative);
  if(!absolute.startsWith(root+path.sep)){response.writeHead(404).end();return;}
  const file=createReadStream(absolute);file.once('error',()=>{if(!response.headersSent)response.writeHead(404);response.end()});
  file.once('open',()=>{response.writeHead(200,{'Content-Type':mime[path.extname(absolute)]||'application/octet-stream','Cache-Control':'no-store'});file.pipe(response)});
}
createServer((request,response)=>{
  if(request.method!=='GET'){response.writeHead(405).end();return;}
  const url=new URL(request.url,'http://localhost');
  const send=(body,type='application/json')=>{response.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});response.end(body)};
  if(url.pathname==='/')return send(page,'text/html');
  if(url.pathname==='/fixture/ept.json')return send(JSON.stringify(ept));
  if(url.pathname==='/fixture/ept-hierarchy/0-0-0-0.json')return send('{"0-0-0-0":64}');
  if(url.pathname==='/fixture/ept-data/0-0-0-0.laz')return stream(candidate+'/test/fixtures','synthetic-ept-node.laz',response);
  if(url.pathname.startsWith('/potree/'))return stream('/app/dist/potree',url.pathname.slice('/potree/'.length),response);
  if(/^\/pointcloud(?:-[a-z]+)?\.(js|html)$/.test(url.pathname))return stream(candidate+'/public',url.pathname.slice(1),response);
  response.writeHead(404).end();
}).listen(8095,'0.0.0.0',()=>console.log('Synthetic Potree elevation QA listening on8095; publish toloopback only.'));
