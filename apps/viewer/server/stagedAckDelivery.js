'use strict';
// Draft staged-byte claim delivery. Calling it requires an explicit gate and
// credentials supplied by the caller; it does not manage or delete source data.
const crypto=require('node:crypto');
const {parseFlat}=require('./stagedCommitmentClient');
const fields=['schemaVersion','taskId','generation','archiveSha256','archiveBytes','coordinatorReceiptSha256','attemptId','modelId','modelVersionId','stagingCommitId','issuer','audience','environment','namespace'];
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const hash=v=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const secret=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{43}$/.test(v)&&Buffer.from(v,'base64url').length===32&&Buffer.from(v,'base64url').toString('base64url')===v;
const invalid=()=>Object.assign(new Error('Staged acknowledgment identity is invalid'),{code:'staged_ack_invalid'});
function validate(value,binding){
 if(!value||Object.keys(value).length!==fields.length||fields.some(k=>!Object.hasOwn(value,k))||value.schemaVersion!==1||!uuid(value.taskId)||!Number.isSafeInteger(value.generation)||value.generation<1||!Number.isSafeInteger(value.archiveBytes)||value.archiveBytes<22||!hash(value.archiveSha256)||!hash(value.coordinatorReceiptSha256)||['attemptId','modelId','modelVersionId','stagingCommitId'].some(k=>!uuid(value[k]))||value.issuer!==binding.principalId||value.audience!==binding.authorityId||value.environment!==binding.environment||value.namespace!=='ledgetop-viewer-staged-byte-claim-v1')throw invalid();
 return value;
}
function transaction(db,fn){db.exec('BEGIN IMMEDIATE');try{const value=fn();db.exec('COMMIT');return value}catch(e){db.exec('ROLLBACK');throw e}}
function acquire(db,now){return transaction(db,()=>{
 const source=db.prepare(`SELECT o.attempt_id,o.assertion_json FROM processing_staged_byte_ack_outbox o LEFT JOIN processing_staged_ack_delivery d ON d.attempt_id=o.attempt_id WHERE d.attempt_id IS NULL OR (d.state IN ('pending','uncertain') AND d.next_attempt_at<=? AND (d.lease_token IS NULL OR d.lease_expires_at<=?)) ORDER BY o.created_at LIMIT 1`).get(now,now);
 if(!source)return null;
 db.prepare("INSERT OR IGNORE INTO processing_staged_ack_delivery(attempt_id,state,assertion_sha256,updated_at) VALUES(?,'pending',?,?)").run(source.attempt_id,crypto.createHash('sha256').update(source.assertion_json).digest('hex'),now);
 const token=crypto.randomUUID();const changed=db.prepare("UPDATE processing_staged_ack_delivery SET lease_token=?,lease_expires_at=?,updated_at=? WHERE attempt_id=? AND state IN ('pending','uncertain') AND (lease_token IS NULL OR lease_expires_at<=?)").run(token,now+60000,now,source.attempt_id,now);
 if(changed.changes!==1)return null;
 return {...db.prepare('SELECT o.*,d.state AS delivery_state,d.assertion_sha256,d.attempts FROM processing_staged_byte_ack_outbox o JOIN processing_staged_ack_delivery d USING(attempt_id) WHERE o.attempt_id=?').get(source.attempt_id),token};
});}
function transition(db,row,state,now,error=null){const delay=Math.min(3600000,1000*2**Math.min(row.attempts,12));return db.prepare('UPDATE processing_staged_ack_delivery SET state=?,lease_token=NULL,lease_expires_at=NULL,next_attempt_at=?,attempts=attempts+1,error_code=?,updated_at=? WHERE attempt_id=? AND lease_token=? AND lease_expires_at>?').run(state,state==='uncertain'?now+delay:0,error,now,row.attempt_id,row.token,now).changes===1}
function expectedBinding(binding,capability){
 let base;try{base=new URL(binding.origin)}catch{throw invalid()}
 if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||typeof binding.credentialRef!=='string'||!binding.credentialRef||binding.credentialRef.length>200||!secret(capability))throw invalid();
 return {origin:base.origin,credentialRef:binding.credentialRef,capabilitySha256:crypto.createHash('sha256').update(capability).digest('hex')};
}
function bindIdentity(db,row,binding,base,capability,now){const expected=expectedBinding(binding,capability),record=db.prepare('SELECT binding_version,expected_origin,credential_ref,capability_sha256 FROM processing_staged_ack_delivery WHERE attempt_id=? AND lease_token=? AND lease_expires_at>?').get(row.attempt_id,row.token,now);if(!record)return false;if(record.binding_version!==1||record.expected_origin!==expected.origin||record.credential_ref!==expected.credentialRef||record.capability_sha256!==expected.capabilitySha256)throw invalid();return true;}
function markUncertain(db,row,now){return db.prepare("UPDATE processing_staged_ack_delivery SET state='uncertain',updated_at=? WHERE attempt_id=? AND lease_token=? AND lease_expires_at>?").run(now,row.attempt_id,row.token,now).changes===1}
async function bounded(response){const length=response.headers.get('content-length'),type=response.headers.get('content-type'),encoding=response.headers.get('content-encoding');if(response.redirected||!type||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(type)||(encoding&&encoding.toLowerCase()!=='identity')||(length!==null&&(!/^(0|[1-9][0-9]*)$/.test(length)||Number(length)>4096))||!response.body)throw invalid();const reader=response.body.getReader(),chunks=[];let size=0;try{for(;;){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>4096){await reader.cancel();throw invalid()}chunks.push(Buffer.from(p.value))}}finally{reader.releaseLock()}if(length!==null&&size!==Number(length))throw invalid();try{return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))}catch{throw invalid()}}
function matchResponse(text,expected,post){const pattern=post?/^\s*\{\s*"assertion"\s*:\s*(\{[^{}]*\})\s*,\s*"created"\s*:\s*(?:true|false)\s*\}\s*$/:/^\s*\{\s*"assertion"\s*:\s*(\{[^{}]*\})\s*\}\s*$/;const match=pattern.exec(text);if(!match)throw invalid();let got;try{got=parseFlat(match[1])}catch{throw invalid()};if(Object.keys(got).length!==fields.length||fields.some(k=>!Object.hasOwn(got,k)||got[k]!==expected[k]))throw invalid();}
async function deliverOneStagedAck({db,enabled=false,bindings,resolveCredential,resolveCapability,fetchImpl=fetch,clock=Date.now}={}){
 if(enabled!==true)return false;
 const row=acquire(db,clock());if(!row)return false;
 let binding,value,base,bearer,capability;
 try{
  binding=bindings?.[row.provider_id];if(!binding||typeof resolveCredential!=='function'||typeof resolveCapability!=='function')throw invalid();
  base=new URL(binding.origin);if(base.protocol!=='https:'||base.username||base.password||base.pathname!=='/'||base.search||base.hash||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(binding.principalId)||!uuid(binding.authorityId)||!['production','staging'].includes(binding.environment))throw invalid();
  if(crypto.createHash('sha256').update(row.assertion_json).digest('hex')!==row.assertion_sha256)throw invalid();
  value=validate(parseFlat(row.assertion_json),binding);if(value.attemptId!==row.attempt_id||value.stagingCommitId!==row.staging_commit_id)throw invalid();
  bearer=await resolveCredential(binding.credentialRef);capability=await resolveCapability(row.attempt_id);if(!secret(bearer)||!secret(capability))throw invalid();if(!bindIdentity(db,row,binding,base,capability,clock()))return true;
 }catch(e){transition(db,row,e?.code==='staged_ack_invalid'?'held':'uncertain',clock(),e?.code==='staged_ack_invalid'?'staged_ack_invalid':'staged_ack_unavailable');return true}
 const headers={Authorization:`Bearer ${bearer}`,'X-LedgeTop-Capability':capability,Accept:'application/json'};
 const request=async(method,suffix,body)=>fetchImpl(new URL(`/ltds/v1/viewer-staged-acks/${value.taskId}${suffix}`,base),{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:body?{...headers,'Content-Type':'application/json'}:headers,...(body?{body}: {})});
 const lookup=async()=>{const response=await request('GET',`/generations/${value.generation}`);if(response.status===404){await response.body?.cancel();return false}if(response.status===200){matchResponse(await bounded(response),value,false);return true}await response.body?.cancel();if(response.status===401||response.status===403)throw invalid();throw Error('unavailable')};
 try{
  if(row.delivery_state==='uncertain'&&await lookup()){transition(db,row,'accepted',clock());return true}
  if(!markUncertain(db,row,clock()))return true;
  const response=await request('POST','',row.assertion_json);
  if(response.status===200){matchResponse(await bounded(response),value,true);transition(db,row,'accepted',clock());return true}
  await response.body?.cancel();
  if(response.status===409){if(await lookup())transition(db,row,'accepted',clock());else transition(db,row,'held',clock(),'staged_ack_conflict');return true}
  if([400,401,403,404,405].includes(response.status))throw invalid();
  throw Error('unavailable');
 }catch(e){transition(db,row,e?.code==='staged_ack_invalid'?'held':'uncertain',clock(),e?.code==='staged_ack_invalid'?'staged_ack_invalid':'staged_ack_unavailable');return true}
}
module.exports={deliverOneStagedAck,expectedBinding};
