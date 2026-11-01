'use strict';
// Unwired loopback-only transport for a provisional v2 experiment.
const {parse}=require('./nativeBindingStrictJson');
const hold=()=>Object.assign(new Error('native epoch transport requires review'),{code:'native_epoch_hold'});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function canonical(value){if(value===null||typeof value==='boolean'||typeof value==='string')return JSON.stringify(value);if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&!Object.is(value,-0))return String(value);if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype)return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';throw hold();}
function createTransport({endpoint,environmentToken,enabled=false}){
  let base;try{base=new URL(endpoint);}catch{throw hold();}
  if(enabled!==true||base.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(base.hostname)||!base.port||base.username||base.password||base.pathname!=='/'||base.search||base.hash||typeof environmentToken!=='string'||!environmentToken)throw hold();
  async function request(action,taskUuid,operationId,capability,body){
    if(!uuid.test(taskUuid)||!uuid.test(operationId)||typeof capability!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(capability))throw hold();
    const get=action==='status';if(!get&&!['open','manifest','intent','accept','revoke'].includes(action))throw hold();
    let bytes;if(!get){bytes=Buffer.isBuffer(body)?body:Buffer.from(canonical(body),'utf8');const max=action==='manifest'?4*1024*1024:['intent','accept'].includes(action)?65536:8192;if(!bytes.length||bytes.length>max)throw hold();}
    try{
      const url=new URL(`/task/ledgetop/plan-epoch-v2/${taskUuid}/${operationId}/1/1${get?'':'/'+action}`,base);url.searchParams.set('token',environmentToken);
      const controller=new AbortController(),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]);
      const response=await fetch(url,{method:get?'GET':'POST',headers:{'X-LedgeTop-Capability':capability,...(get?{}:{'content-type':'application/json'})},...(get?{}:{body:bytes}),redirect:'error',signal});
      if(!response.ok||!/^application\/json(?:\s*;|\s*$)/i.test(response.headers.get('content-type')||'')){controller.abort();try{response.body?.cancel().catch(()=>{});}catch{}throw hold();}
      const reader=response.body.getReader();let chunks=[],size=0;try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>65536)throw hold();chunks.push(item.value);}}finally{controller.abort();try{reader.cancel().catch(()=>{});}catch{}reader.releaseLock();}
      return parse(Buffer.concat(chunks.map(chunk=>Buffer.from(chunk))));
    }catch{throw hold();}
  }
  return{identity:base.origin,request};
}
module.exports={createTransport};
