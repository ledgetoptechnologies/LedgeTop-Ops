import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import policy from '../lod-converter-policy.cjs';
import {validateRecoveryProofRequest,proveRecoveryCandidate} from '../scripts/lib/recovery-candidate-proof.mjs';
function request() {
  return {schemaVersion:1,mode:'verify',output:path.resolve('nonexistent-output'),sourceObj:path.resolve('actual.obj'),
    sourceGlb:path.resolve('actual.glb'),converterBinary:path.resolve('Obj2Tiles'),basisJavascript:path.resolve('basis.js'),
    basisWasm:path.resolve('basis.wasm'),sourceObjSha256:'a'.repeat(64),sourceGlbSha256:'b'.repeat(64),
    converterBinarySha256:policy.CURRENT_CONTROLLED_CONVERTER_BINARY_SHA256[0]
      || '3f62b4d9c954ceffc955c7e1f08bc2412827405d02644df0ab2ea2457b009459',converterSerialRetry:false};
}
test('host request requires the installed generation policy; no local fixture hash can authorize a binary',()=>{
  if (!policy.CURRENT_CONTROLLED_CONVERTER_BINARY_SHA256.length) {
    for (const mode of ['prepare','verify']) assert.throws(()=>validateRecoveryProofRequest({...request(),mode}),
      {code:'recovery_proof_converter'});
    return;
  }
  const original = request(), admitted = validateRecoveryProofRequest(original);
  original.sourceObjSha256='c'.repeat(64);
  assert.equal(admitted.sourceObjSha256,'a'.repeat(64)); assert.equal(Object.isFrozen(admitted),true);
  assert.equal(admitted.mode,'verify');
  assert.equal(validateRecoveryProofRequest({...request(),mode:'prepare'}).mode,'prepare');
});
test('invalid requests cannot load native geometry or decoder dependencies or create scratch/processes',async()=>{
  for (const change of [{ready:true},{mode:'activate'},{sourceObj:'relative.obj'},{sourceGlbSha256:'bad'},
    {converterSerialRetry:'false'},{converterBinarySha256:'f'.repeat(64)}]) {
    await assert.rejects(proveRecoveryCandidate({...request(),...change}),error=>error.code.startsWith('recovery_proof_'));
  }
});
test('pre-aborted request fails before filesystem access or native imports',async()=>{
  const abort = new AbortController(); abort.abort(new Error('cancelled before proof'));
  await assert.rejects(proveRecoveryCandidate(request(),{signal:abort.signal}),/cancelled before proof/);
});
