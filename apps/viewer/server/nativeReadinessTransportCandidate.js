'use strict';
// Inactive Unix-socket client experiment; no retry or production wiring.
const net=require('node:net'),crypto=require('node:crypto'),{digest}=require('./nativeReadinessRequestDigestCandidate');
function complete({socketPath,request,token,brokerPublicKey,timeoutMs=3000}){
  if(typeof socketPath!=='string'||!socketPath.startsWith('/')||typeof token!=='string'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)throw new Error('readiness transport hold');
  let key;try{key=crypto.createPublicKey(brokerPublicKey);if(key.asymmetricKeyType!=='ed25519')throw new Error();}catch{throw new Error('readiness transport hold');}
  const nonce=crypto.randomUUID(),requestDigest=digest(request),payload=JSON.stringify({operation:'complete',request,token,nonce})+'\n';if(Buffer.byteLength(payload)>4096)throw new Error('readiness transport hold');
  return new Promise((resolve,reject)=>{
    let done=false,buffer=Buffer.alloc(0);const socket=net.createConnection(socketPath),timer=setTimeout(()=>finish(true),timeoutMs);
    const finish=(err,result)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();if(err)reject(new Error('readiness transport hold'));else resolve(result);};
    socket.on('error',()=>finish(true));socket.on('connect',()=>socket.write(payload));
    socket.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length>4096)return finish(true);const index=buffer.indexOf(10);if(index<0)return;if(index!==buffer.length-1)return finish(true);try{const json=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,index)),envelope=JSON.parse(json),result=envelope?.result,signature=envelope?.signature;if(JSON.stringify(envelope)!==json||Object.keys(envelope).sort().join('|')!=='result|signature'||!result||Object.keys(result).sort().join('|')!=='attemptId|commitId|nonce|requestDigest'||result.attemptId!==request.attemptId||result.nonce!==nonce||result.requestDigest!==requestDigest||typeof result.commitId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.commitId)||typeof signature!=='string'||!/^[A-Za-z0-9_-]+$/.test(signature))return finish(true);const sig=Buffer.from(signature,'base64url');if(sig.length!==64||sig.toString('base64url')!==signature||!crypto.verify(null,Buffer.concat([Buffer.from('viewer-readiness-response-v1\0'),Buffer.from(JSON.stringify(result))]),key,sig))return finish(true);finish(false,{attemptId:result.attemptId,commitId:result.commitId});}catch{finish(true);}});
    socket.on('end',()=>finish(true));socket.on('close',()=>finish(true));
  });
}
module.exports={complete};
