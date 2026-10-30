'use strict';
// Test-only fetch replacement. It never contacts a network endpoint or an engine.
const fs=require('node:fs'),crypto=require('node:crypto'),{Readable}=require('node:stream');
const stateFile='/fixture-state/synthetic-provider.json',archive='/fixture-archive/result.zip';
function load(){return fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{uuid:null,committed:false};}
function save(state){fs.writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});}
function json(value,status=200){return Response.json(value,{status});}
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input));if(url.origin!=='https://127.0.0.1:28443')throw Error('synthetic fetch refused unexpected endpoint');
 const p=url.pathname,method=init.method||'GET',state=load();
 if(p==='/info')return json({version:'2.2.3',engine:'odm',engineVersion:'3.6.2',taskQueueCount:0,maxImages:null,ledgetopReservations:{version:1,capabilityEncoding:'base64url-32',retention:'indefinite',runningCancellation:'requires_inspection',remaining:1}});
 if(p==='/options')return json([]);
 if(p==='/task/ledgetop/reserve'&&method==='POST')return json({state:'reserved'});
 if(p==='/task/new/init'&&method==='POST'){state.uuid=new Headers(init.headers).get('set-uuid');save(state);return json({uuid:state.uuid});}
 if(p.startsWith('/task/new/upload/')&&method==='POST')return json({success:true});
 if(p.startsWith('/task/new/commit/')&&method==='POST'){state.committed=true;save(state);return json({uuid:state.uuid});}
 if(p===`/task/${state.uuid}/info`)return json({uuid:state.uuid,status:{code:state.committed?40:10},imagesCount:40,progress:100});
 if(p===`/task/${state.uuid}/output`)return json([]);
 if(p===`/task/${state.uuid}/download/all.zip`){const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(archive))digest.update(chunk);const hash=digest.digest('hex'),stat=fs.statSync(archive);return new Response(Readable.toWeb(fs.createReadStream(archive)),{headers:{'content-type':'application/zip','content-length':String(stat.size),'x-ledgetop-archive-sha256':hash}});}
 if(p.endsWith('/info'))return json({error:'not found'});
 throw Error(`unexpected synthetic route ${method} ${p}`);
};
