'use strict';
// Experimental read-only protocol client. No outbox, sender, or custody grant.
const NAMESPACE='ledgetop-viewer-staged-byte-claim-v1';
const fields=['schemaVersion','taskId','generation','archiveSha256','archiveBytes','coordinatorReceiptSha256','issuer','audience','environment','namespace'];
const fail=()=>Object.assign(new Error('Staged archive commitment is invalid'),{code:'staged_commitment_invalid'});
const unavailable=()=>Object.assign(new Error('Staged archive commitment is unavailable'),{code:'staged_commitment_unavailable'});
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const slug=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const secret=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v)&&Buffer.from(v,'base64url').length===32&&Buffer.from(v,'base64url').toString('base64url')===v;
// Exact flat JSON grammar rejects duplicate keys, nested values, and ambiguity.
function parseFlat(text){
 let pos=0;const out=Object.create(null),ws=()=>{while(/[\x20\t\r\n]/.test(text[pos]||'')&&pos<text.length)pos++;};
 const token=()=>{const m=/^(?:"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(pos));if(!m)throw fail();pos+=m[0].length;return JSON.parse(m[0]);};
 ws();if(text[pos++]!=='{')throw fail();ws();if(text[pos]==='}')throw fail();
 for(;;){ws();const key=token();if(typeof key!=='string'||Object.hasOwn(out,key))throw fail();ws();if(text[pos++]!==':')throw fail();ws();out[key]=token();ws();const ch=text[pos++];if(ch==='}')break;if(ch!==',')throw fail();}
 ws();if(pos!==text.length)throw fail();return out;
}
async function readBounded(response){
 if(!response.body)throw fail();const reader=response.body.getReader(),chunks=[];let count=0;
 try{for(;;){const part=await reader.read();if(part.done)break;count+=part.value.byteLength;if(count>4096){await reader.cancel();throw fail();}chunks.push(Buffer.from(part.value));}}
 finally{reader.releaseLock();}return {text:new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)),byteSize:count};
}
async function getStagedCommitment({enabled=false,origin,principalId,authorityId,environment,bearer,capability,taskId,fetchImpl=fetch,signal}={}){
 if(enabled!==true)throw Object.assign(new Error('Staged archive commitment client is disabled'),{code:'staged_commitment_disabled'});
 let base;try{base=new URL(origin);}catch{throw fail();}
 if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||!slug(principalId)||!uuid(authorityId)||!['production','staging'].includes(environment)||!secret(bearer)||!secret(capability)||!uuid(taskId)||typeof fetchImpl!=='function')throw fail();
 let response;try{
  response=await fetchImpl(new URL(`/ltds/v1/viewer-staged-acks/${taskId}/commitment`,base),{method:'GET',redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15000)]):AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${bearer}`,'X-LedgeTop-Capability':capability,Accept:'application/json'}});
  if(response.status===408||response.status===429||response.status>=500)throw unavailable();
  const type=response.headers.get('content-type'),encoding=response.headers.get('content-encoding'),length=response.headers.get('content-length');
  if(response.status!==200||response.redirected||!type||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)||(encoding!==null&&encoding.toLowerCase()!=='identity')||(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>4096)))throw fail();
  const body=await readBounded(response);if(length!==null&&body.byteSize!==Number(length))throw fail();const value=parseFlat(body.text);
  if(Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k))||value.schemaVersion!==1||value.taskId!==taskId||!Number.isSafeInteger(value.generation)||value.generation<1||!Number.isSafeInteger(value.archiveBytes)||value.archiveBytes<22||!hash(value.archiveSha256)||!hash(value.coordinatorReceiptSha256)||value.issuer!==principalId||value.audience!==authorityId||value.environment!==environment||value.namespace!==NAMESPACE)throw fail();
  return Object.freeze(Object.fromEntries(fields.map(key=>[key,value[key]])));
 }catch(error){if(response?.body&&!response.body.locked)try{await response.body.cancel();}catch{}if(['staged_commitment_invalid','staged_commitment_unavailable'].includes(error?.code))throw error;throw unavailable();}
}
module.exports={getStagedCommitment};
