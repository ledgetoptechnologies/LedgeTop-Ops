// Browser QA of shipped markup, CSS, bindings and hover scheduling. Synthetic
// decoded point values only; not a Potree GPU or live EPT acceptance test.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
const root = new URL('../../', import.meta.url);
const index = readFileSync(new URL('index.html', root), 'utf8');
const main = readFileSync(new URL('main.js', root), 'utf8');
const panel = index.slice(index.indexOf('<div class="panel" id="panel-pc"'), index.indexOf('    <div id="viewer-wrap">'))
  .replace('style="display:none;"', '').replace(/\s*<\/div>\s*<\/aside>\s*$/, '');
const css = index.slice(index.indexOf('<style>') + 7, index.indexOf('</style>'));
const controls = main.slice(main.indexOf('let pcElevationModelId ='), main.indexOf('// View sync between', main.indexOf('let pcElevationModelId =')));
const applyStart = main.indexOf('function applyPcPanelState()');
const apply = main.slice(applyStart, main.indexOf('function updateStatus', applyStart));
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Point display QA</title><style>${css}
html,body{overflow:auto}body{padding:20px}h1{font-size:22px;margin-bottom:10px}.qa-layout{display:flex;gap:28px;margin-top:20px}#panel-pc{display:block;width:320px}#sample{width:580px;height:330px;border:1px solid #777;position:relative;touch-action:none;background:linear-gradient(90deg,#865124 0 33%,#20a83f 33% 66%,#ee8e00 66%)}#sample p{padding:14px;color:white}#classification{position:absolute;bottom:10px;right:10px;background:#111;padding:6px;pointer-events:none}#state{white-space:pre-wrap}</style></head><body>
<h1>Point display QA — synthetic decoded classes</h1><p>Shipped panel and bindings. No real EPT, model data, sessions or GPU picking.</p>
<div class="qa-layout">${panel}<section><div id="sample"><p>Ground (left), high vegetation (middle), building (right). Select Classification and pause the cursor.</p><div id="classification" hidden>Classification: —</div></div><pre id="state"></pre></section></div>
<script src="/pointcloud-elevation.js"></script><script src="/pointcloud-display.js"></script><script>
const PROJECT={id:'synthetic-cloud'},DISPLAY_UNITS='imperial',METERS_TO_FT=3.28084;
const material={elevationRange:[0,0]},display={};
const range=LtdsPointCloudElevation.createElevationRangeController({getBounds:()=>({min:{z:200},max:{z:250}}),getMaterials:()=>[material]});range.refresh();
const readout=document.getElementById('classification'),sample=document.getElementById('sample');let picks=0,drag=false;
const hover=LtdsPointCloudDisplay.createHoverReader({canPick:()=>!readout.hidden&&!drag,show:text=>readout.textContent=text,pick:position=>{picks++;const x=(position.x-sample.getBoundingClientRect().left)/sample.clientWidth;return{classification:new Uint8Array([x<1/3?2:x<2/3?5:6])}}});
sample.addEventListener('pointermove',event=>hover.move(event));sample.addEventListener('pointerdown',()=>{drag=true;hover.clear()});addEventListener('pointerup',()=>{drag=false;hover.clear()});sample.addEventListener('pointerleave',()=>hover.clear());
const api={getElevationState:()=>range.state(),setElevationRange:(min,max)=>range.setRange(min,max),resetElevationRange:()=>range.reset(),setBudget:value=>display.budget=value,setSize:value=>display.size=value,setSizing:value=>display.sizing=value,setColor:value=>{display.color=value;readout.hidden=value!=='classification';hover.clear()},setEDL:value=>display.edl=value,fit:()=>display.fitCalls=(display.fitCalls||0)+1};
const pcApi=()=>api,elevationInputMeters=value=>value/METERS_TO_FT,formatElevation=value=>(value*METERS_TO_FT).toFixed(2)+' ft';
${controls}\n${apply}
bindPcPanel();applyPcPanelState();
setInterval(()=>document.getElementById('state').textContent=JSON.stringify({display,elevation:range.state(),picks},null,2),200);
</script></body></html>`;
const routes = new Map([
  ['/', ['text/html', () => html]],
  ['/pointcloud-elevation.js', ['text/javascript', () => readFileSync(new URL('public/pointcloud-elevation.js', root))]],
  ['/pointcloud-display.js', ['text/javascript', () => readFileSync(new URL('public/pointcloud-display.js', root))]],
]);
const server = createServer((request, response) => {
  const route = routes.get(request.url);
  if (request.method !== 'GET' || !route) { response.writeHead(404).end(); return; }
  response.writeHead(200, { 'Content-Type': route[0], 'Cache-Control': 'no-store' }); response.end(route[1]());
});
server.listen(0, '127.0.0.1', () => console.log('Point display QA: http://127.0.0.1:' + server.address().port));
