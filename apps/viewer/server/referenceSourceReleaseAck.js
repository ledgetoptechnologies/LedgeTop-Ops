'use strict';
// Candidate wire validation only. This does not prove custody, finality,
// cleanup, identity, replay protection or authority to release anything.
const p=require('./referenceProtocol');
const {validateSourceRetention,decodeReceipt}=require('./referenceSourceRetention');
const MAX_ACK_BYTES=16384;
const FIELDS=['schemaVersion','receiptType','validationVersion','ackId','sourceRetentionReceiptId','sourceStorageReceiptId','jobId','generation','environment','inputManifestSha256','pipelineDigest','pipelineClosureSha256','localCleanupClosureSha256','acknowledgedAt'];
function fail(path){throw new p.ReferenceProtocolError('INVALID_SOURCE_RELEASE_ACK',path)}
function validText(s){return typeof s==='string'&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s)}
const slug=s=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s);
const hash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
function validateSourceReleaseAck(payload,expected){
 if(typeof payload==='string'||Buffer.isBuffer(payload)){if(typeof payload==='string'&&!validText(payload))fail('wire.utf8');if(Buffer.byteLength(payload)>MAX_ACK_BYTES)fail('wire.limit');payload=decodeReceipt(payload)}
 if(!payload||Object.getPrototypeOf(payload)!==Object.prototype||Object.keys(payload).length!==FIELDS.length||FIELDS.some(k=>!Object.hasOwn(payload,k)))fail('fields');
 if(p.canonicalBytes(payload).length>MAX_ACK_BYTES)fail('limit');
 if(payload.schemaVersion!==1||payload.receiptType!=='source_release_ack'||payload.validationVersion!=='ltds-source-release-ack-v1')fail('version');
 if(!expected||!hash(expected.pipelineClosureSha256)||!hash(expected.localCleanupClosureSha256))fail('expected');
 const source=validateSourceRetention(expected.sourceReceipt,expected);
 for(const k of ['ackId','sourceRetentionReceiptId','sourceStorageReceiptId','jobId'])if(!slug(payload[k]))fail(k);
 if(new Set([payload.ackId,payload.sourceRetentionReceiptId,payload.sourceStorageReceiptId]).size!==3)fail('roles');
 if(!Number.isSafeInteger(payload.generation)||payload.generation<1||!['staging','production'].includes(payload.environment))fail('identity');
 for(const k of ['inputManifestSha256','pipelineDigest','pipelineClosureSha256','localCleanupClosureSha256'])if(!hash(payload[k]))fail(k);
 const binding={sourceRetentionReceiptId:source.receiptId,sourceStorageReceiptId:source.storageReceiptId,jobId:source.jobId,generation:source.generation,environment:source.environment,inputManifestSha256:source.inputManifestSha256,pipelineDigest:source.pipelineDigest,pipelineClosureSha256:expected.pipelineClosureSha256,localCleanupClosureSha256:expected.localCleanupClosureSha256};
 for(const [k,v] of Object.entries(binding))if(payload[k]!==v)fail('binding.'+k);
 const timestamp=payload.acknowledgedAt;if(typeof timestamp!=='string'||!/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp)||!Number.isFinite(Date.parse(timestamp))||new Date(timestamp).toISOString()!==timestamp)fail('acknowledgedAt');
 return structuredClone(payload);
}
module.exports={MAX_ACK_BYTES,validateSourceReleaseAck};
