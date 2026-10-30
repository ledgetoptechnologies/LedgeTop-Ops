'use strict';
// Test-only fetch replacement. It never contacts a network endpoint or an engine.
const fs=require('node:fs'),crypto=require('node:crypto'),{Readable}=require('node:stream');
const stateFile='/fixture-state/synthetic-provider.json',archive='/fixture-archive/result.zip';
function load(){return fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{uuid:null,committed:false,uploaded:[]};}
function save(state){fs.writeFileSync(stateFile,JSON.stringify(state),{mode:0o600});}
function json(value,status=200){return Response.json(value,{status});}
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input));if(url.origin!=='https://127.0.0.1:28443')throw Error('synthetic fetch refused unexpected endpoint');
 const p=url.pathname,method=init.method||'GET',state=load();
 if(p==='/info')return json({version:'2.2.3',engine:'odm',engineVersion:'3.6.2',taskQueueCount:0,maxImages:null,ledgetopReservations:{version:1,capabilityEncoding:'base64url-32',retention:'indefinite',runningCancellation:'requires_inspection',remaining:1}});
 if(p==='/options')return json([]);
 if(p==='/task/ledgetop/reserve'&&method==='POST')return json({state:'reserved'});
 if(p==='/task/new/init'&&method==='POST'){state.uuid=new Headers(init.headers).get('set-uuid');save(state);return json({uuid:state.uuid});}
 if(p===`/task/new/upload/${state.uuid}`&&method==='POST'){
  const files=init.body.getAll('images');if(!files.length)throw Error('empty synthetic upload');
  for(const file of files){const match=/^photo-(\d+)\.jpg$/.exec(file.name),bytes=Buffer.from(await file.arrayBuffer());if(!match||Number(match[1])>=40||bytes.toString()!==`synthetic-photo-${Number(match[1])}`||state.uploaded.includes(file.name))throw Error('synthetic upload does not match fixture');state.uploaded.push(file.name);}
  save(state);return json({success:true});
 }
 if(p===`/task/new/commit/${state.uuid}`&&method==='POST'){if(state.uploaded.length!==40)throw Error('synthetic upload incomplete');state.committed=true;save(state);return json({uuid:state.uuid});}
 if(p===`/task/${state.uuid}/info`)return json({uuid:state.uuid,status:{code:state.committed?40:10},imagesCount:state.uploaded.length,progress:100});
 if(p===`/task/${state.uuid}/output`)return json([]);
 if(p===`/task/${state.uuid}/download/all.zip`){const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(archive))digest.update(chunk);const hash=digest.digest('hex'),stat=fs.statSync(archive);return new Response(Readable.toWeb(fs.createReadStream(archive)),{headers:{'content-type':'application/zip','content-length':String(stat.size),'x-ledgetop-archive-sha256':hash}});}
 if(p.endsWith('/info'))return json({error:'not found'});
 throw Error(`unexpected synthetic route ${method} ${p}`);
};
