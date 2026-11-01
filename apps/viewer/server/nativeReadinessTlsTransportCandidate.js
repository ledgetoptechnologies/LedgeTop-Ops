'use strict';
// Inactive experiment. The pin must be provisioned through a trusted channel.
const tls=require('node:tls'),crypto=require('node:crypto'),{digest}=require('./nativeReadinessRequestDigestCandidate');
function complete({socketPath,request,token,certificateSha256,timeoutMs=3000}){
  if(typeof socketPath!=='string'||!socketPath.startsWith('/')||typeof token!=='string'||!/^[0-9a-f]{64}$/.test(certificateSha256)||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new Error('readiness transport hold');
  const nonce=crypto.randomUUID(),requestDigest=digest(request),payload=JSON.stringify({operation:'complete',request,token,nonce})+'\n';if(Buffer.byteLength(payload)>4096)throw new Error('readiness transport hold');
  return new Promise((resolve,reject)=>{
    let done=false,buffer=Buffer.alloc(0);const socket=tls.connect({path:socketPath,rejectUnauthorized:false,minVersion:'TLSv1.3'}),timer=setTimeout(()=>finish(true),timeoutMs);
    const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();if(err)reject(new Error('readiness transport hold'));else resolve(result);};
    socket.on('error',()=>finish(true));socket.on('secureConnect',()=>{try{const raw=socket.getPeerCertificate().raw;if(!raw||crypto.createHash('sha256').update(raw).digest('hex')!==certificateSha256)return finish(true);socket.write(payload);}catch{finish(true);}});
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>4096)return finish(true);const index=buffer.indexOf(10);if(index<0)return;if(index!==buffer.length-1)return finish(true);try{const json=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,index)),result=JSON.parse(json);if(JSON.stringify(result)!==json||!result||Array.isArray(result)||Object.keys(result).sort().join('|')!=='attemptId|commitId|nonce|requestDigest'||result.attemptId!==request.attemptId||result.nonce!==nonce||result.requestDigest!==requestDigest||typeof result.commitId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.commitId))return finish(true);finish(false,{attemptId:result.attemptId,commitId:result.commitId});}catch{finish(true);}});
    socket.on('end',()=>finish(true));socket.on('close',()=>finish(true));
  });
}
module.exports={complete};
