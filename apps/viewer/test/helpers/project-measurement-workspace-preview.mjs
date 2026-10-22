// Local-only visual fixture: shipped workspace render functions/CSS, synthetic
// project records and product descriptors. No API, credentials or real files.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(import.meta.url),{registeredProducts}=require('../../server/productDownloads.js');
const source=await fs.readFile(path.join(root,'workspace-projects.js'),'utf8'),lines=source.split(/\r?\n/);
function declaration(name){const value=lines.find(line=>line.startsWith(`function ${name}(`)||line.startsWith(`const ${name}=`));if(!value)throw new Error(`Missing shipped declaration ${name}`);return value;}
function block(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);if(a<0||b<a)throw new Error(`Missing shipped block ${start}`);return source.slice(a,b);}
const helpers=['esc','bytes','dateTime','duration','available','empty','button','dangerButton','badge','metric','taskFact','datasetActions','activeTaskAction','taskQuickActions','taskPanel','taskDetail','orthophotoPreview','publishedOrthophoto','openModal','projectRows'];
const products=registeredProducts([
  {kind:'ortho',relativePath:'ortho.tif',byteSize:2245321538,sha256:'synthetic'},
  {kind:'dsm',relativePath:'dsm.tif',byteSize:724532153,sha256:'synthetic'},
  {kind:'dtm',relativePath:'dtm.tif',byteSize:654321987,sha256:'synthetic'},
  {kind:'pointCloud',relativePath:'cloud.laz',byteSize:4912543789,sha256:'synthetic'},
  {kind:'obj',relativePath:'mesh.obj',byteSize:8812345678,sha256:'synthetic'},
  {kind:'report',relativePath:'report.pdf',byteSize:324891,sha256:'synthetic'},
  {kind:'ept',relativePath:'ept/ept.json',byteSize:500,sha256:'synthetic'},
],{staff:true}).map(product=>({...product,grantUrl:`/synthetic-only/${product.kind}`}));
const projects=[{id:'demo',displayName:'Testing and Examples',description:'Synthetic records only — no production data',status:'active'},{id:'cadens',displayName:'Cadens LLC — Synthetic',description:'Rome survey fixture',status:'active'},{id:'greenwood',displayName:'Greenwood Project Management LLC — Synthetic',description:'Two church tasks',status:'active'}];
const task=(id,projectId,name,images)=>({id,projectId,datasetId:`source-${id}`,displayName:name,status:'ready_for_review',createdAt:'2026-09-05T15:20:00Z',metrics:{sourceImageCount:images,averageGsdM:0.01,surveyedAreaM2:45321,reconstructedPointCount:12345678,georeferencingCrs:'EPSG:32616'},latestAttempt:{id:`attempt-${id}`,status:'ready_for_review',startedAt:'2026-09-05T15:20:00Z',completedAt:'2026-09-05T15:44:44Z'}});
const tasks=[task('rome','cadens','Rome Dam — Synthetic',8526),task('holy-cross','greenwood','Holy Cross Catholic Church — Synthetic',3224),task('st-joseph','greenwood','High Resolution St Joseph Church — Synthetic',2016)];
const outputs=tasks.map(task=>({id:`output-${task.id}`,taskId:task.id,attemptId:task.latestAttempt.id,displayName:task.displayName,status:'ready',downloadProducts:products,assetKinds:['ortho','dsm','dtm','pointCloud','obj','report'],downloadUrl:'/synthetic-only',reportUrl:'/synthetic-only/report',lod:{status:'available'}}));
const fixture={projects,tasks,outputs,datasets:tasks.map(task=>({id:task.datasetId,projectId:task.projectId,status:'finalized',displayName:'Registered synthetic source'})),taskDetails:Object.fromEntries(tasks.map(task=>[task.id,{task,storage:{task:{totalBytes:33457892345}}}])),providers:[],presets:[],operations:[],derivativeJobs:[],orthophotoPreviews:{},projectQuery:'',selectedProjectId:null,expandedTaskId:null,adminSession:{displayUnits:'imperial'}};
const script=`import {formatArea,formatGsd} from '/unit-formatters.mjs';
const state=${JSON.stringify(fixture)},ACTIVE=new Set(['running','queued_upstream','derivatives']);
const can=()=>true,canShareOutput=()=>true,lodJobForOutput=()=>null,recoveryOperationForOutput=()=>null;
const groupedNumber=value=>Number(value).toLocaleString(),durationFromMs=value=>Math.round(value/1000)+' s';
const modal=document.querySelector('#workspace-modal'),modalContent=document.querySelector('#workspace-modal-content'),content=document.querySelector('#workspace-content');
const toast=message=>{document.querySelector('#fixture-status').textContent=message;};
const authenticatedDownload=async(_url,name)=>{toast('Synthetic download selected: '+name+' — no network request or file download occurred.');};
${helpers.map(declaration).join('\n')}
${block('function taskLodNotice(', 'function selectedProject(')}
${block('function selectedProject(', 'function datasetActions(')}
${block('function outputDownloadMenu(', "const TOKEN_KEY=")}
function renderFixture(){content.innerHTML='<div class="metric-grid">'+metric('Projects',3,'Viewer projects')+metric('Ready tasks',3,'Available to view and share')+metric('Processing now',0,'No actual processing')+metric('Provider nodes','0/0','Synthetic fixture')+'</div><div class="project-browser"><input id="project-filter" class="project-filter" placeholder="Search projects…" aria-label="Search projects" value="'+esc(state.projectQuery)+'"><div class="project-list">'+projectRows()+'</div></div>';document.querySelector('#project-filter').oninput=event=>{state.projectQuery=event.target.value;const focused=event.target.selectionStart;renderFixture();const next=document.querySelector('#project-filter');next.focus();next.setSelectionRange(focused,focused);};}
content.onclick=event=>{const action=event.target.closest('[data-action]');if(!action)return;const {action:kind,id}=action.dataset;if(kind==='open-project'){state.selectedProjectId=state.selectedProjectId===id?null:id;state.expandedTaskId=null;renderFixture();}else if(kind==='toggle-task'){state.expandedTaskId=state.expandedTaskId===id?null:id;renderFixture();}else if(kind==='download-output')outputDownloadMenu(state.outputs.find(output=>output.id===id));else toast('Synthetic action: '+kind+' — intentionally not connected to an API.');};
document.querySelector('#fixture-reset').onclick=()=>{state.selectedProjectId=null;state.expandedTaskId=null;state.projectQuery='';renderFixture();};
document.querySelector('#fixture-expand').onclick=()=>{state.selectedProjectId='greenwood';state.expandedTaskId=null;renderFixture();};
document.querySelector('#fixture-products').onclick=()=>outputDownloadMenu(outputsForFixture());
function outputsForFixture(){return state.outputs[0];}
renderFixture();window.fixtureReady=true;
`;
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Synthetic unified projects QA</title><link rel="stylesheet" href="/workspace.css"><link rel="stylesheet" href="/workspace-management.css"></head><body><div class="workspace-shell" id="workspace"><aside class="workspace-nav"><div class="workspace-brand"><span><strong>Ledge Top</strong><small>Local synthetic QA</small></span></div><nav><button class="nav-item active">Dashboard</button></nav></aside><main class="workspace-main"><header class="workspace-header"><div><p class="eyebrow">Local fixture — no production API</p><h1>Projects</h1></div><div class="workspace-actions"><button class="secondary-button" id="fixture-reset">Collapse all</button><button class="secondary-button" id="fixture-expand">Expand Greenwood</button><button class="primary-button" id="fixture-products">Product chooser</button></div></header><p id="fixture-status" role="status">Synthetic registered products; selection does not download files.</p><section id="workspace-content"></section></main></div><dialog class="workspace-modal" id="workspace-modal" aria-labelledby="workspace-modal-title"><div id="workspace-modal-content"></div></dialog><script type="module" src="/fixture.js"></script></body></html>`;
const allowed=new Map([['/workspace.css','text/css'],['/workspace-management.css','text/css'],['/unit-formatters.mjs','text/javascript']]);
const server=http.createServer(async(req,res)=>{
  if(!['127.0.0.1','localhost'].includes(String(req.headers.host||'').split(':')[0]))return res.writeHead(403).end();
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  try{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}else if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(script);}else if(allowed.has(req.url)){res.setHeader('Content-Type',allowed.get(req.url));res.end(await fs.readFile(path.join(root,req.url.slice(1))));}else res.writeHead(404).end();}catch(error){res.writeHead(500).end('Local fixture error');console.error(error.message);}
});
server.listen(4464,'127.0.0.1',()=>console.log('Synthetic project/product QA: http://127.0.0.1:4464'));
for(const event of ['SIGINT','SIGTERM'])process.on(event,()=>server.close(()=>process.exit(0)));
