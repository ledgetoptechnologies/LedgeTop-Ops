'use strict';
// Requests the coordinator archive without saving or extracting it. This is
// not independent Processing proof; the supervisor must hold on ambiguity.
const crypto=require('node:crypto');
async function primePilotArchive({adapter,providerTaskId,maxBytes=4*1024*1024*1024,timeoutMs=240000}){
 if(!adapter||typeof adapter.status!=='function'||typeof adapter.downloadAll!=='function'||typeof providerTaskId!=='string'||!providerTaskId||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>4*1024*1024*1024||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>240000)throw Error('invalid archive prime configuration');
 const signal=AbortSignal.timeout(timeoutMs),status=await adapter.status(providerTaskId,{signal});
 if(status?.uuid!==providerTaskId||status.status!=='completed')throw Error('coordinator task not completed');
 const response=await adapter.downloadAll(providerTaskId,{signal});if(!response?.body||!response.ok)throw Error('archive prime response unavailable');
 const reader=response.body.getReader(),digest=crypto.createHash('sha256');let byteSize=0,done=false;
 try{for(;;){signal.throwIfAborted();const part=await reader.read();if(part.done){done=true;break;}byteSize+=part.value.byteLength;if(!Number.isSafeInteger(byteSize)||byteSize>maxBytes)throw Error('archive prime exceeds byte limit');digest.update(part.value);}signal.throwIfAborted();if(byteSize<1)throw Error('archive prime is empty');return{sha256:digest.digest('hex'),byteSize};}
 finally{if(!done)await reader.cancel().catch(()=>{});reader.releaseLock();}
}
module.exports={primePilotArchive};
