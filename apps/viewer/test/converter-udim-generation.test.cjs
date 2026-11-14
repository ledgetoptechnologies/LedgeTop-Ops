'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const policy=require('../lod-converter-policy.cjs');
const oldBinary='3f62b4d9c954ceffc955c7e1f08bc2412827405d02644df0ab2ea2457b009459';
const oldPatch='98c641e28a7711708a46e8a3bcabb6ceea689b8488b09ae60a5c19868e7d9317';
const newPatch='7951fcf96132e17ae08ee31a66db37080e0f175b9e2cd9ffafb8692033ed05de';
const root=path.resolve(__dirname,'..');

function metadata(patch,binary=oldBinary){
  return {schemaVersion:2,sourceVersion:'v1.6.2',sourceSha256:policy.OBJ2TILES_SOURCE_SHA256,
    patchSha256:patch,imageSharpVersion:policy.OBJ2TILES_IMAGE_SHARP_VERSION,
    lockSetSha256:policy.OBJ2TILES_LOCKSET_SHA256,licenseNoticeSha256:policy.OBJ2TILES_LICENSE_NOTICE_SHA256,
    binarySha256:binary};
}

test('exact finalized native patch is selected by source, Docker and main-only publication',()=>{
  assert.equal(policy.OBJ2TILES_PATCH_SHA256,newPatch);
  const bytes=fs.readFileSync(path.join(root,'third_party/obj2tiles/v1.6.2-bounded-concurrency.patch'));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),newPatch);
  const docker=fs.readFileSync(path.join(root,'Dockerfile'),'utf8');
  const workflow=fs.readFileSync(path.resolve(root,'../../.github/workflows/publish-viewer.yml'),'utf8');
  assert.ok(docker.includes('ARG OBJ2TILES_PATCH_SHA256='+newPatch));
  assert.ok(workflow.includes('EXPECTED_OBJ2TILES_PATCH_SHA256: "'+newPatch+'"'));
  assert.match(workflow,/branches: \[main\]/);
  assert.match(workflow,/if: \$\{\{ github\.ref == 'refs\/heads\/main'/);
  assert.equal(policy.obj2TilesArguments('source.obj','output')[
    policy.obj2TilesArguments('source.obj','output').indexOf('--max-texture-size')+1],'0');
});

test('old 98c metadata remains readable without qualifying old 3f for current generation',t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'udim-history-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'build-info.json'),license=path.join(root,'third_party/imagesharp/3.2.0/manifest.json');
  const old=metadata(oldPatch);fs.writeFileSync(file,JSON.stringify(old));
  assert.deepEqual(policy.runtimeForkBuildInfo(file,license),old);
  assert.deepEqual(policy.currentControlledConverterBinarySha256(old),[]);
  assert.equal(policy.acceptedConverterBinaryCommand(policy.CONTROLLED_CONVERTER_COMMAND_SHA256,oldBinary),false);
  assert.equal(policy.acceptedConverterBinaryCommand(policy.SERIAL_RETRY_CONVERTER_COMMAND_SHA256,oldBinary),false);
  assert.ok(!policy.HISTORICAL_CONTROLLED_CONVERTER_BINARY_SHA256.includes(oldBinary));
  fs.writeFileSync(file,JSON.stringify({...old,lockSetSha256:'0'.repeat(64)}));
  assert.throws(()=>policy.runtimeForkBuildInfo(file,license),/does not match/);
  fs.writeFileSync(file,JSON.stringify({...old,patchSha256:'d'.repeat(64)}));
  assert.throws(()=>policy.runtimeForkBuildInfo(file,license),/does not match/);
});

test('new metadata generation eligibility is distinct from measured runtime qualification',()=>{
  const current=metadata(newPatch,'b'.repeat(64));
  assert.deepEqual(policy.currentControlledConverterBinarySha256(current),['b'.repeat(64)]);
  for(const [key,value] of [['patchSha256',oldPatch],['lockSetSha256','0'.repeat(64)],
    ['licenseNoticeSha256','0'.repeat(64)],['sourceSha256','0'.repeat(64)],['schemaVersion',1]])
    assert.deepEqual(policy.currentControlledConverterBinarySha256({...current,[key]:value}),[]);
  // Pure synthetic metadata above neither measures a binary nor grants a
  // calibration registry entry, readiness, image admission or acceptance.
  assert.notEqual(policy.CONTROLLED_CONVERTER_COMMAND_SHA256,
    crypto.createHash('sha256').update(policy.stable({...policy.CONTROLLED_CONVERTER,
      fork:{...policy.CONTROLLED_CONVERTER.fork,patchSha256:oldPatch}})).digest('hex'));
});
