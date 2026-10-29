'use strict';
// Pure source-stage parsing helper. It does not maintain an index, establish
// projection readiness or authorize cleanup, admission, or a custody receipt.
const {decodeOptionsWire}=require('./referenceOptions');
const MAX_PAYLOAD_BYTES=4*1024*1024;
const validId=x=>typeof x==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(x);
const unresolved=reason=>Object.freeze({status:'unresolved',reason});
function catalogIdentity({payloadJson,processingAttemptId}){
 if(typeof payloadJson!=='string'||Buffer.byteLength(payloadJson,'utf8')>MAX_PAYLOAD_BYTES||Buffer.from(payloadJson,'utf8').toString('utf8')!==payloadJson)return unresolved('invalid_payload');
 let payload;try{payload=decodeOptionsWire(Buffer.from(payloadJson,'utf8'));}catch{return unresolved('invalid_payload');}
 if(!payload||typeof payload!=='object'||Array.isArray(payload)||!payload.ids||typeof payload.ids!=='object'||Array.isArray(payload.ids)||!validId(payload.ids.attemptId))return unresolved('invalid_payload_identity');
 if(processingAttemptId!==null&&processingAttemptId!==undefined&&!validId(processingAttemptId))return unresolved('invalid_column_identity');
 if(processingAttemptId!=null&&processingAttemptId!==payload.ids.attemptId)return unresolved('identity_mismatch');
 return Object.freeze({status:'resolved',payloadAttemptId:payload.ids.attemptId,columnAttemptId:processingAttemptId??null});
}
module.exports={MAX_PAYLOAD_BYTES,catalogIdentity};
