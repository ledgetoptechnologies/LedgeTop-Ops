'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),express=require('express');
const {installJsonBodyParsers}=require('../server/jsonBodyParser');
const token='a'.repeat(40),authorization=`Bearer ${token}`;
const processing={getAdminSessionByHash:()=>({permissions:['viewer.datasets.write']}),adminSessionLive:()=>true};

test('manifest parser accepts bounded 20,000-file envelope only on its exact route',async t=>{
 const app=express(),cap=5*1024*1024;
 installJsonBodyParsers(app,{processingPlatformEnabled:true,uploadMaxManifestBytes:cap,genericJsonMaxBytes:2*1024*1024},processing);
 app.use((req,res)=>res.json({count:req.body?.files?.length||0,raw:req.rawBody?.length||0}));
 app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.type}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
 t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,files=Array.from({length:20000},(_,i)=>({id:`photo-${i}`,relativePath:`flight/photo-${i}.jpg`,byteSize:1,sha256:'a'.repeat(64),contentType:'image/jpeg',processingRole:'image'}));
 const body=JSON.stringify({files}),request=(route,data=body)=>fetch(base+route,{method:'POST',headers:{'content-type':'application/json',authorization},body:data});
 assert.ok(Buffer.byteLength(body)>2*1024*1024&&Buffer.byteLength(body)<cap);
 const accepted=await request('/api/v1/datasets/draft/uploads');assert.equal(accepted.status,200);const result=await accepted.json();assert.equal(result.count,20000);assert.equal(result.raw,Buffer.byteLength(body));
 assert.equal((await request('/api/v1/datasets/draft/uploads/extra')).status,413);
 assert.equal((await request('/api/v1/elsewhere')).status,413);
 const atLimit='{"x":"'+'a'.repeat(cap-8)+'"}';assert.equal(Buffer.byteLength(atLimit),cap);assert.equal((await request('/api/v1/datasets/draft/uploads',atLimit)).status,200);
 assert.equal((await request('/api/v1/datasets/draft/uploads',atLimit+' ')).status,413);
});

test('operator lower cap applies to the complete upload request',async t=>{
 const app=express();installJsonBodyParsers(app,{processingPlatformEnabled:true,uploadMaxManifestBytes:100,genericJsonMaxBytes:200},processing);
 app.use((_req,res)=>res.sendStatus(200));app.use((error,_req,res,_next)=>res.sendStatus(error.status||500));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/datasets/a/uploads`,{method:'POST',headers:{'content-type':'application/json',authorization},body:JSON.stringify({files:['x'.repeat(100)]})});assert.equal(response.status,413);
});

test('large manifest gate authenticates first, rejects overlap and releases after errors and disconnects',async t=>{
 const http=require('node:http'),app=express();let allowed=true;
 const localProcessing={...processing,getAdminSessionByHash:()=>({permissions:allowed?['viewer.datasets.write']:[]})};
 installJsonBodyParsers(app,{processingPlatformEnabled:true,uploadMaxManifestBytes:5*1024*1024,genericJsonMaxBytes:5*1024*1024},localProcessing);
 let release,entered;const started=new Promise(resolve=>entered=resolve);
 app.use((req,res)=>{if(req.path.includes('/held/')){entered();release=()=>res.sendStatus(200);}else res.sendStatus(200)});
 app.use((error,_req,res,_next)=>res.sendStatus(error.status||500));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>new Promise(resolve=>server.close(resolve)));
 const base=`http://127.0.0.1:${server.address().port}`,post=(path,body,auth=authorization)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:auth}:{})},body});
 assert.equal((await post('/api/v1/datasets/a/uploads','{"x":"'+'x'.repeat(3*1024*1024)+'"}',null)).status,401);
 allowed=false;assert.equal((await post('/api/v1/datasets/a/uploads','{}')).status,403);allowed=true;
 const first=post('/api/v1/datasets/held/uploads','{}');await started;
 assert.equal((await post('/API/v1/DATASETS/a/Uploads','{}')).status,429);release();assert.equal((await first).status,200);
 assert.equal((await post('/api/v1/datasets/a/uploads','{bad')).status,400);assert.equal((await post('/api/v1/datasets/a/uploads','{}')).status,200);
 const partial=http.request(base+'/api/v1/datasets/a/uploads',{method:'POST',headers:{authorization,'content-type':'application/json','content-length':'100'}});partial.on('error',()=>{});partial.write('{');
 await new Promise(resolve=>setTimeout(resolve,50));partial.destroy();await new Promise(resolve=>setTimeout(resolve,50));
 assert.equal((await post('/api/v1/datasets/a/uploads','{}')).status,200);
});
