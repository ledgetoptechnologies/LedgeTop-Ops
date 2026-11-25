import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { launchBrowser } from './browser-launch.mjs';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';

const root=new URL('../',import.meta.url);
const source=readFileSync(new URL('workspace-projects.js',root),'utf8');
function declaration(name){
  const start=new RegExp(`^(?:async )?function ${name}\\(`,'m').exec(source);
  assert.ok(start,`Missing shipped function ${name}`);
  const rest=source.slice(start.index),next=/\n(?:async )?function \w+\(|\nconst \w+\s*=/.exec(rest);
  return next?rest.slice(0,next.index):rest;
}
const executable=[process.env.CHROME_PATH,process.env.EDGE_PATH,'/usr/bin/chromium','/usr/bin/google-chrome'].filter(Boolean).find(existsSync);
for(const mode of ['only','except'])test(`first-share ${mode} inheritance uses real browser controls, review and dispatch`,{timeout:45_000},async t=>{
  if(!executable){t.skip('Set CHROME_PATH to run Chromium verification');return}
  const release=await acquireBrowserHarnessLock({root:new URL('../',import.meta.url).pathname});
  t.after(release);
  const script=`
import * as share from '/workspace-direct-client-share.mjs';
const {directShareForm,readDirectShareForm,syncDirectProjectSelection,directShareReviewMarkup,directClientKey,directShareErrorText,DIRECT_CLIENT_GRANTS_PATH}=share;
const assert=(condition,message)=>{if(!condition)throw new Error(message)};
try{
${['folderPath','projectShareSelectionCatalog','sameShareSelectionCatalog','bindDirectShare'].map(declaration).join('\n')}
  const mode=${JSON.stringify(mode)},selected=mode==='only',client={sourceId:'synthetic',workspaceId:'client',displayName:'Synthetic client'};
  const folders=[{id:'root',projectId:'project',parentId:null,displayName:'Root'},{id:'child',projectId:'project',parentId:'root',displayName:'Child'},{id:'leaf',projectId:'project',parentId:'child',displayName:'Leaf'}];
  const tasks=[{id:'nested-task',projectId:'project',folderId:'leaf',displayName:'Nested task'},{id:'loose-task',projectId:'project',folderId:null,displayName:'Loose task'}];
  const catalog=projectShareSelectionCatalog('project',folders,tasks);
  const context={projectId:'project',projectName:'Synthetic project',entry:'project',selectionCatalog:catalog,tasks:[]};
  const state={token:'synthetic',adminSession:{subject:'synthetic'},shareContext:{}},modal={open:true};
  let publicationAuthorityGeneration=0,moved=false,creates=0;
  const directShareContext=()=>context,publicationAuthorityLive=()=>true,can=()=>true,dateTime=value=>value;
  const bindClientPicker=(_root,options)=>{options.onSelect(client);return{dispose(){}}};
  const loadProjectShareSelectionCatalog=async()=>projectShareSelectionCatalog('project',folders,moved?tasks.map(task=>({...task,folderId:null})):tasks);
  const notices=[],toast=text=>notices.push(text),rerenderClientSharePanel=()=>{};
  const loadDirectClientAccess=async()=>({clients:[],grants:[]});
  const refreshProjectOutputs=async()=>true;
  const api=async(_path,options)=>{if(options.beforeDispatch)(await options.beforeDispatch())();creates++;return{grant:{grantId:'synthetic'}}};
  document.body.innerHTML=directShareForm(context);
  const form=document.querySelector('form');form.elements.client.value=JSON.stringify([client.sourceId,client.workspaceId]);
  bindDirectShare(form,'project',null);
  const change=element=>element.dispatchEvent(new Event('change',{bubbles:true}));
  const tick=(element,value)=>{element.checked=value;change(element)};
  const input=id=>form.querySelector('[value="'+id+'"]');
  form.elements.mode.value=mode;change(form.elements.mode);
  const root=input('root'),child=input('child'),leaf=input('leaf'),task=input('nested-task');
  tick(child,selected);tick(root,selected);
  for(const element of [child,leaf,task]){
    assert(element.checked===selected,'Contradictory inherited tick: '+element.value);
    assert(element.disabled,'Inherited control must be locked: '+element.value);
    assert(element.title.includes('Inherited from'),'Inherited control must explain its lock');
  }
  tick(root,!selected);assert(!child.disabled&&child.checked===selected,'Direct child selection must survive ancestor unlock');
  tick(child,!selected);assert(!leaf.disabled&&!task.disabled,'Descendants must unlock after ancestor deselection');
  tick(root,selected);
  form.elements.includeLater.checked=true;
  const submit=async selector=>{form.querySelector(selector).click();while(form.shareBusy)await new Promise(resolve=>setTimeout(resolve,0))};
  assert(creates===0,'Choosing scope must not POST');
  await submit('[data-direct-review-button]');assert(form.reviewing,'Review must open');
  assert(creates===0,'Review must not POST before final consent');
  const review=form.querySelector('[data-direct-review-text]').textContent;
  assert(review.includes('“Root”')&&!review.includes('“Root / Child”'),'Review must contain only explicit ancestor');
  task.checked=!selected; // A cosmetic lock is not authority.
  moved=true;await submit('[data-direct-send]');assert(creates===0,'Moved task must block create');
  assert(form.querySelector('[data-direct-summary]').textContent.includes('Close and reopen Share to review'),'Movement refusal must require reopen/review');
  moved=false;await submit('[data-direct-review-button]');assert(creates===0,'Second review must not POST');
  await submit('[data-direct-send]');assert(creates===1,'Final Share after unchanged review must create exactly once');
  const body=readDirectShareForm(form,{...context,clients:[client]}).bodies()[0];
  assert(JSON.stringify(body.selection)===JSON.stringify({version:1,mode,folderIds:['root'],taskIds:[]}),'Inherited IDs must not be serialized');
  document.body.innerHTML='<pre id="result">'+encodeURIComponent(JSON.stringify({mode,creates,movedCreates:0,passed:true}))+'</pre>';
}catch(error){document.body.innerHTML='<pre id="result">'+encodeURIComponent(JSON.stringify({error:error.stack}))+'</pre>'}
`;
  const server=createServer((request,response)=>{
    const name=request.url.slice(1);
    if(request.url==='/'){
      response.writeHead(200,{'Content-Type':'text/html'});
      return response.end('<!doctype html><body><script type="module" src="/fixture.mjs"></script>');
    }
    if(name==='fixture.mjs'){response.writeHead(200,{'Content-Type':'text/javascript'});return response.end(script)}
    if(['workspace-direct-client-share.mjs','workspace-client-picker.mjs'].includes(name)){
      response.writeHead(200,{'Content-Type':'text/javascript'});return response.end(readFileSync(new URL(name,root)));
    }
    response.writeHead(404);response.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {child,cleanup}=launchBrowser(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--no-sandbox','--dump-dom','--virtual-time-budget=10000','--timeout=15000',`http://127.0.0.1:${server.address().port}/`],{prefix:'ltds-first-share-',spawnOptions:{stdio:['ignore','pipe','pipe']}});
  t.after(cleanup);
  let output='',stderr='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve)});
  assert.equal(code,0,stderr);
  const result=/<pre id="result">([^<]+)<\/pre>/.exec(output);
  assert.ok(result,`Browser did not finish fixture: ${output} ${stderr}`);
  assert.deepEqual(JSON.parse(decodeURIComponent(result[1])),{mode,creates:1,movedCreates:0,passed:true});
});
