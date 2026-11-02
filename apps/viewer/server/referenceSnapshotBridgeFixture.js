'use strict';
// Owner-evidence contract experiment only. Caller-supplied keys, clocks and
// local directories are not an authenticated storage authority or a fence.
// No live route uses this module; issue() always refuses.
const crypto=require('node:crypto'),protocol=require('./referenceProtocol'),{createSourceSnapshotAcquirer}=require('./sourceSnapshotAcquisition');
const fail=()=>{throw Object.assign(new Error('snapshot bridge unavailable'),{code:'snapshot_bridge_unavailable'})};
const domain=Buffer.from('ltds-owner-snapshot-evidence-fixture-v1\0','ascii');
const fields=['version','environment','authorityId','authorityEpoch','keyId','volumeId','snapshotId','holdId','projectId','datasetId','manifestSha256','issuedAtMs','expiresAtMs'];
const id=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x),hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x),integer=x=>Number.isSafeInteger(x)&&x>=0&&!Object.is(x,-0);
function inspectSnapshotFixture({scope,processing,snapshotRoot,evidenceBytes,signature,registryEntry,expected,now}={}){
 if(scope!=='isolated-owner-snapshot-evidence-fixture')fail();
 try{
  if(!processing?.database||typeof snapshotRoot!=='string'||!Buffer.isBuffer(evidenceBytes)||!evidenceBytes.length||evidenceBytes.length>4096||!Buffer.isBuffer(signature)||signature.length!==64||!registryEntry||!expected||!integer(now))fail();
  if([...evidenceBytes].some(x=>x>127))fail();const evidence=JSON.parse(evidenceBytes.toString('ascii'));
  if(!evidence||Object.getPrototypeOf(evidence)!==Object.prototype||Object.keys(evidence).length!==fields.length||fields.some(k=>!Object.hasOwn(evidence,k))||!protocol.canonicalBytes(evidence).equals(evidenceBytes)||!protocol.canonicalBytes(expected).equals(evidenceBytes))fail();
  if(evidence.version!==1||evidence.environment!=='staging'||!['authorityId','authorityEpoch','keyId','volumeId','snapshotId','holdId','projectId','datasetId'].every(k=>id(evidence[k]))||!hash(evidence.manifestSha256)||!integer(evidence.issuedAtMs)||!integer(evidence.expiresAtMs)||evidence.issuedAtMs>now||now>=evidence.expiresAtMs||evidence.expiresAtMs-evidence.issuedAtMs>300000)fail();
  if(registryEntry.authorityId!==evidence.authorityId||registryEntry.authorityEpoch!==evidence.authorityEpoch||registryEntry.keyId!==evidence.keyId||registryEntry.environment!==evidence.environment||registryEntry.purpose!=='snapshot-evidence'||registryEntry.revoked!==false||!integer(registryEntry.notBeforeMs)||!integer(registryEntry.notAfterMs)||registryEntry.notBeforeMs>evidence.issuedAtMs||registryEntry.notAfterMs<evidence.expiresAtMs||!Buffer.isBuffer(registryEntry.publicKeyDer))fail();
  const key=crypto.createPublicKey({key:registryEntry.publicKeyDer,format:'der',type:'spki'});if(key.asymmetricKeyType!=='ed25519'||!crypto.verify(null,Buffer.concat([domain,evidenceBytes]),key,signature))fail();
  const observed=createSourceSnapshotAcquirer({database:processing.database,environment:'staging',projectId:evidence.projectId,holderRegistry:[{holderId:'viewer-odm',environment:'staging',projectId:evidence.projectId,registryVersion:'fixture'}],managedRoot:snapshotRoot}).acquire({datasetId:evidence.datasetId,holderId:'viewer-odm'});if(observed.datasetManifestSha256!==evidence.manifestSha256)fail();observed.verifyIdentity();
  return Object.freeze({scope:'untrusted_fixture_evidence_no_custody',datasetId:evidence.datasetId,manifestSha256:evidence.manifestSha256,objectCount:observed.files.length,storageBarrier:'unverified',authorityFreshness:'caller_supplied'});
 }catch(error){if(error?.code==='snapshot_bridge_unavailable')throw error;fail()}
}
function issue(){fail()}
module.exports={inspectSnapshotFixture,issue};
