'use strict';
// Inactive Unix-socket client experiment; no retry or production wiring.
const net=require('node:net');
function complete({socketPath,request,token,timeoutMs=3000}){
  if(typeof socketPath!=='string'||!socketPath.startsWith('/')||typeof token!=='string'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new Error('readiness transport hold');
  const payload=JSON.stringify({operation:'complete',request,token})+'\n';if(Buffer.byteLength(payload)>4096)throw new Error('readiness transport hold');
  return new Promise((resolve,reject)=>{
    let done=false,buffer=Buffer.alloc(0);const socket=net.createConnection(socketPath),timer=setTimeout(()=>finish(true),timeoutMs);
    const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();if(err)reject(new Error('readiness transport hold'));else resolve(result);};
    socket.on('error',()=>finish(true));socket.on('connect',()=>socket.write(payload));
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>4096)return finish(true);const index=buffer.indexOf(10);if(index<0)return;if(index!==buffer.length-1)return finish(true);try{const json=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,index)),result=JSON.parse(json);if(JSON.stringify(result)!==json||!result||Array.isArray(result)||Object.keys(result).sort().join('|')!=='attemptId|commitId'||result.attemptId!==request.attemptId||typeof result.commitId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.commitId))return finish(true);finish(false,result);}catch{finish(true);}});
    socket.on('end',()=>finish(true));socket.on('close',()=>finish(true));
  });
}
module.exports={complete};
