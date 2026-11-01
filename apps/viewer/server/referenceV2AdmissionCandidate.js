'use strict';

// Unmounted syntax/ledger candidate. No authentication, authority or endpoint.
// Do not wire this module to any live request: admission is hard-disabled.
const {createHash} = require('node:crypto');
const {decodeOptionsWire} = require('./referenceOptions');
const {canonicalBytes} = require('./referenceProtocol');
const {createFixtureLedger, FIXTURE_SCOPE} = require('./referenceV2FixtureLedger');
const MAX_BYTES=16384;
const DOMAIN=Buffer.from('ltds-reference-request-v2\0','ascii');
const EMPTY_SHA256=createHash('sha256').update(Buffer.alloc(0)).digest('hex');
const fail=code=>{const e=new Error(code);e.code=code;throw e};
const closed=(v,keys)=>v && Object.getPrototypeOf(v)===Object.prototype && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const id=v=>typeof v==='string' && /^[A-Za-z0-9_-]{43}$/.test(v) && Buffer.from(v,'base64url').length===32 && Buffer.from(v,'base64url').toString('base64url')===v;
const uuid=v=>typeof v==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const slug=v=>typeof v==='string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const hash=v=>typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const integer=(v,min=0)=>Number.isSafeInteger(v) && v>=min && !Object.is(v,-0);

function decodeV2Admission(raw) {
  if(!Buffer.isBuffer(raw)||raw.length===0||raw.length>MAX_BYTES)fail('invalid_admission');
  try {
    const value=decodeOptionsWire(raw);
    const keys=['attemptId','authorityId','claimLineageSha256','environment','epoch','generation','jobId','manifestSha256','objectId','objectLength','objectSha256','range','reservationId','workerInstanceId'];
    if(!closed(value,['version','requestId','deliveryId','binding']) || value.version!==2 || !id(value.requestId) || !id(value.deliveryId) || !closed(value.binding,keys))fail('invalid_admission');
    const b=value.binding;
    if(!['attemptId','authorityId','epoch','jobId'].every(k=>uuid(b[k]))
      || !['objectId','reservationId','workerInstanceId'].every(k=>slug(b[k]))
      || !['claimLineageSha256','manifestSha256','objectSha256'].every(k=>hash(b[k]))
      || !['staging','production'].includes(b.environment)||!integer(b.generation,1)||!integer(b.objectLength)
      || !closed(b.range,['kind']))fail('invalid_admission');
    if(b.range.kind==='whole') {if(b.objectLength===0)fail('invalid_admission')}
    else if(b.range.kind==='empty') {if(b.objectLength!==0||b.objectSha256!==EMPTY_SHA256)fail('invalid_admission')}
    else fail('invalid_admission'); // Partial ranges require a separate proof contract.
    if(!canonicalBytes(value).equals(raw))fail('invalid_admission');
    const logical={binding:b,requestId:value.requestId,version:2};
    return {value,requestHash:createHash('sha256').update(DOMAIN).update(canonicalBytes(logical)).digest('hex')};
  } catch {fail('invalid_admission')}
}

// This gate cannot be configured open. Authorization, durable authority,
// streams, recovery, adoption and a qualified schema are not implemented.
function admitLiveV2(){fail('v2_not_qualified')}

// Synthetic fixture seam only: not an authorization, production migration,
// actual process fence, public interface, or qualified shared-storage ledger.
function createSyntheticAdmission(db,scope){
  if(scope!==FIXTURE_SCOPE)fail('fixture_scope_required');
  const ledger=createFixtureLedger(db,scope);
  return {
    provision:ledger.provision,
    admit(raw){const {value,requestHash}=decodeV2Admission(raw);const b=value.binding;return ledger.admit({jobId:b.jobId,manifestHash:b.manifestSha256,requestId:value.requestId,requestHash,deliveryId:value.deliveryId,responseBytes:b.objectLength})},
    fixtureRead:ledger.fixtureRead,
    fixtureProveStopped:ledger.fixtureProveStopped,
  };
}
module.exports={decodeV2Admission,admitLiveV2,createSyntheticAdmission,MAX_BYTES};
