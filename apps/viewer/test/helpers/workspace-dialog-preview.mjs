// Local-only manual browser QA of the shipped dialog module. No API or real data.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Workspace dialog QA</title><link rel="stylesheet" href="/workspace-management.css"></head><body><main><h1>Local workspace dialog QA</h1><p>Synthetic task only. No service calls.</p><button id="rename" class="primary-button">Rename synthetic task</button><button id="purge" class="secondary-button">Test permanent deletion dialog</button><button id="nested" class="secondary-button">Open parent dialog</button><p id="result" role="status">No action submitted</p></main><dialog id="parent" class="workspace-modal"><h2>Parent settings</h2><button id="child" class="primary-button">Confirm inside parent</button><button id="close-parent" class="secondary-button">Close parent</button></dialog><script type="module" src="/fixture.js"></script></body></html>`;
const script = `import {createWorkspaceDialogs} from '/workspace-dialogs.mjs';
const dialogs=createWorkspaceDialogs(),result=document.querySelector('#result'),parent=document.querySelector('#parent');
document.querySelector('#rename').onclick=async()=>{const value=await dialogs.form({title:'Rename task',fields:[{name:'displayName',label:'Task name',value:'Synthetic Church',required:true,maxLength:240},{name:'description',label:'Description',multiline:true,maxLength:4000}]});result.textContent=value?'Renamed synthetic task: '+value.displayName:'Rename cancelled';};
document.querySelector('#purge').onclick=async()=>{const value=await dialogs.form({title:'Permanent deletion',message:'Synthetic test only. Type SAMPLE to confirm.',submitLabel:'Delete permanently',destructive:true,fields:[{name:'identifier',label:'Exact identifier',required:true,exact:'SAMPLE'}]});result.textContent=value?'Synthetic confirmation accepted — no files deleted':'Deletion cancelled';};
document.querySelector('#nested').onclick=()=>parent.showModal();document.querySelector('#close-parent').onclick=()=>parent.close();document.querySelector('#child').onclick=async()=>{const okay=await dialogs.confirm('Synthetic confirmation inside existing settings.');result.textContent=okay?'Nested confirmation accepted':'Nested confirmation cancelled';};`;
const server=http.createServer(async(req,res)=>{
  if(!['127.0.0.1','localhost'].includes(String(req.headers.host||'').split(':')[0])){res.writeHead(403).end();return;}
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('Cache-Control','no-store');
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(html);}
  else if(req.url==='/fixture.js'){res.setHeader('Content-Type','text/javascript');res.end(script);}
  else if(['/workspace-dialogs.mjs','/workspace-management.css'].includes(req.url)){res.setHeader('Content-Type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(path.join(root,req.url.slice(1))));}
  else res.writeHead(404).end();
});
server.listen(4462,'127.0.0.1',()=>console.log('Local dialog QA: http://127.0.0.1:4462'));
process.on('SIGINT',()=>server.close(()=>process.exit(0)));
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
