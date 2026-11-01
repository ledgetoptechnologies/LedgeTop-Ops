'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),{complete}=require('../server/nativeReadinessTransportCandidate');
test('transport enforces an absolute deadline and rejects ambiguous replies',{skip:process.platform!=='linux'},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-readiness-transport-')),servers=[];t.after(async()=>{for(const server of servers)await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  let counter=0;async function setup(onConnection){const sock=path.join(root,`${++counter}.sock`),server=net.createServer(onConnection);servers.push(server);await new Promise((resolve,reject)=>server.once('error',reject).listen(sock,resolve));return sock;}
  const request={attemptId:'attempt'},token='synthetic';
  const slow=await setup(socket=>{const interval=setInterval(()=>socket.write(' '),10);socket.on('error',()=>clearInterval(interval));socket.on('close',()=>clearInterval(interval));});const started=Date.now();await assert.rejects(complete({socketPath:slow,request,token,timeoutMs:100}),/hold/);assert.ok(Date.now()-started<1000);
  for(const reply of [Buffer.from('{"attemptId":"attempt","attemptId":"attempt","commitId":"00000000-0000-4000-8000-000000000000"}\n'),Buffer.concat([Buffer.from('{"attemptId":"'),Buffer.from([0xff]),Buffer.from('","commitId":"00000000-0000-4000-8000-000000000000"}\n')])]){const sock=await setup(socket=>socket.on('data',()=>socket.end(reply)));await assert.rejects(complete({socketPath:sock,request,token,timeoutMs:1000}),/hold/);}
});
