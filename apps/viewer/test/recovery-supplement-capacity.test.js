'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {inventory,canonicalSupplement,MAX_FILES,MAX_BYTES,MAX_MANIFEST_BYTES}=require('../server/derivativeSupplement');
const {intakeLayout}=require('../server/derivativeSupplementIntake');
const sha='a'.repeat(64);

function files(count,longNames=false){
  return Array.from({length:count},(_,i)=>({relativePath:i===0?'tileset.json':
    `private-proof/${longNames?'x'.repeat(950):'atlas'}/${String(i).padStart(6,'0')}.png`,
  role:i===0?'render':'private-proof',byteSize:1,sha256:sha}));
}
function manifest(rows,environment='STAGING'){
  const inv=inventory(rows);
  return {schemaVersion:1,identity:{attemptId:'attempt',versionId:'version',providerId:'provider',providerTaskId:'facade',
    initializationGeneration:1,producerGeneration:1,nativeTaskId:'native',environment,
    archiveSha256:sha,sourceManifestSha256:sha},converter:{binarySha256:sha,buildInfoSha256:sha,
    commandSha256:sha,policyRevision:'candidate-v1'},coordinateFrame:{kind:'local',unit:'unknown',georeferenced:false},
  files:inv.files,outputManifestSha256:inv.manifestSha256};
}

test('staging intake retains a 15992-file closure and reserves its metadata/directory space',()=>{
  const value=manifest(files(15992)),parsed=canonicalSupplement(value);
  const operation={id:'11111111-1111-4111-8111-111111111111',lease_token:'a'.repeat(48),
    attempt_id:'attempt',version_id:'version',job_id:'job',supplement_sha256:parsed.supplementSha256};
  const context={attempt:{id:'attempt'},version:{id:'version'},job:{id:'job'},
    output:{root_key:'models',storage_mode:'managed',relative_path:'task/attempt.v2'}};
  const layout=intakeLayout(operation,context,value);
  assert.equal(layout.manifest.files.length,15992);
  assert.equal(layout.byteSize,15992);
  assert.ok(layout.body.length<MAX_MANIFEST_BYTES);
  assert.ok(layout.capacityBytes>=layout.byteSize+layout.body.length+layout.marker.length+15992*8192);
  assert.equal(layout.manifest.identity.archiveSha256,sha);
});

test('production retains its existing 10000-file envelope',()=>{
  assert.equal(canonicalSupplement(manifest(files(10000),'PRODUCTION')).manifest.files.length,10000);
  assert.throws(()=>canonicalSupplement(manifest(files(10001),'PRODUCTION')),{code:'supplement_inventory_limit'});
});

test('staging has finite file, metadata and payload caps',()=>{
  assert.equal(MAX_FILES,20000);
  assert.equal(MAX_BYTES,64*1024**3);
  assert.equal(MAX_MANIFEST_BYTES,16*1024**2);
  assert.equal(inventory(files(MAX_FILES)).files.length,MAX_FILES);
  assert.throws(()=>inventory(files(MAX_FILES+1)),{code:'supplement_inventory_limit'});
  assert.throws(()=>inventory(files(16000,true)),{code:'supplement_manifest_limit'});
  const large=files(2);large[1].byteSize=MAX_BYTES;
  assert.throws(()=>inventory(large),{code:'supplement_inventory_limit'});
});
