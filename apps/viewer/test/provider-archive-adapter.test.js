'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {NodeOdmProvider}=require('../server/nodeOdmProvider');

async function origin(t,handler){const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});return `http://127.0.0.1:${server.address().port}`;}

test('archive uses native transport even with a custom control fetch, preserving task path and token',async t=>{
  let seen,controls=0;
  const endpoint=await origin(t,(req,res)=>{seen=new URL(req.url,'http://synthetic');res.end('archive bytes');});
  const provider=new NodeOdmProvider({endpoint,token:'synthetic token',fetchImpl:async()=>{controls++;return new Response('{"success":true}',{headers:{'content-type':'application/json'}});}});
  assert.equal(await (await provider.downloadAll('synthetic/task')).text(),'archive bytes');
  assert.equal(seen.pathname,'/task/synthetic%2Ftask/download/all.zip');assert.equal(seen.searchParams.get('token'),'synthetic token');assert.equal(controls,0);
  await provider.commit('synthetic/task');assert.equal(controls,1);
});

test('native truncated archive is a delivery wait, while caller abort remains authoritative',async t=>{
  const endpoint=await origin(t,(_req,res)=>{res.writeHead(200,{'content-length':'100'});res.end('short');});
  const provider=new NodeOdmProvider({endpoint});
  const response=await provider.downloadAll('synthetic');await assert.rejects(response.arrayBuffer(),{code:'provider_result_transfer_unavailable'});
  const controller=new AbortController(),reason=Object.assign(new Error('synthetic lease lost'),{code:'lease_lost'});controller.abort(reason);
  await assert.rejects(provider.downloadAll('synthetic',{signal:controller.signal}),error=>error===reason);
});

test('injected archive HTTP failures cancel the body and retain status classification',async()=>{
  for(const [status,code] of [[503,'provider_result_transfer_unavailable'],[404,'provider_task_not_found'],[403,'provider_request_failed'],[302,'provider_request_failed']]){
    let cancelled=false;
    const provider=new NodeOdmProvider({endpoint:'http://synthetic.invalid',archiveDownloadImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{status})});
    await assert.rejects(provider.downloadAll('synthetic'),{code});assert.equal(cancelled,true);
  }
});

test('archive TLS and encoding failures remain permanent instead of delivery waits',async()=>{
  for(const code of ['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','provider_archive_encoding_unsupported']){
    const failure=Object.assign(new Error('synthetic failure'),{code});
    const provider=new NodeOdmProvider({endpoint:'https://synthetic.invalid',archiveDownloadImpl:async()=>{throw failure;}});
    await assert.rejects(provider.downloadAll('synthetic'),error=>error===failure);
  }
});

test('ingest cancels oversized declared archives in both fresh and existing-source paths',async t=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const {processIngest}=require('../server/processingWorker');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'archive-size-cancel-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const existing of [false,true])for(const cancelFails of [false,true]){
    const modelRoot=path.join(root,`${existing}-${cancelFails}`);fs.mkdirSync(modelRoot);
    if(existing)fs.mkdirSync(path.join(modelRoot,'task','attempt.v2','source'),{recursive:true});
    let cancelled=false;
    const processing={database:{prepare:()=>({get:()=>null})},getAttempt:()=>({id:'attempt',taskId:'task',providerId:'provider',providerTaskId:'synthetic'}),getTask:()=>({id:'task',projectId:'project'}),getProject:()=>({id:'project'}),getProvider:()=>({id:'provider'}),getAttemptTransferProvenance:()=>null};
    const storage={space:()=>({available:2**30,reserve:0}),resolve:(_key,relative)=>path.join(modelRoot,relative)};
    const response=new Response(new ReadableStream({cancel(){cancelled=true;if(cancelFails)throw new Error('synthetic cancellation failure');}}),{headers:{'content-length':String(2**30+1)}});
    await assert.rejects(processIngest({attempt_id:'attempt'},{processing,storage,config:{},adapterFactory:()=>({downloadAll:async()=>response})}),{code:'insufficient_storage'});
    assert.equal(cancelled,true);assert.equal(fs.existsSync(path.join(modelRoot,'task','attempt.v2','source')),existing);
  }
});
