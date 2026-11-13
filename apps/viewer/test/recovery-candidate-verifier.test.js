'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const test = require('node:test');
const { stable } = require('../lod-converter-policy.cjs');
const { createRecoveryCandidateVerifier,validateRecoveryCandidateEvidence,RECOVERY_PROOF_ENGINE_COMMIT,
  RECOVERY_TEXTURE_POLICY,RECOVERY_BASIS_PINS } = require('../server/recoveryCandidateVerifier');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const BINARY = '3f62b4d9c954ceffc955c7e1f08bc2412827405d02644df0ab2ea2457b009459';
function fixture() {
  // Metadata join fixture only, not measured geometry or an authorized runtime.
  const runtime = {schemaVersion:1,sourceCommit:RECOVERY_PROOF_ENGINE_COMMIT,imageId:'sha256:'+'a'.repeat(64),
    converterBinarySha256:BINARY,basisJavascriptSha256:RECOVERY_BASIS_PINS.javascript,basisWasmSha256:RECOVERY_BASIS_PINS.wasm};
  const request = {schemaVersion:1,mode:'verify',sourceObj:path.resolve('fixture/model.obj'),sourceGlb:path.resolve('fixture/model.glb'),
    sourceObjSha256:'b'.repeat(64),sourceGlbSha256:'c'.repeat(64),converterBinarySha256:BINARY};
  const artifacts = ['tileset.json','root.b3dm','LOD-0/leaf.b3dm'].map((uri,index)=>({uri,sha256:String(index+1).repeat(64),byteLength:100+index}));
  const renderFiles = artifacts.map(value=>({role:'render',relativePath:value.uri,sha256:value.sha256,byteSize:value.byteLength}));
  const proof = {schemaVersion:1,scope:'recovery-candidate-independent-evidence-v1',mode:'verify',ready:false,calibrationRequired:true,
    sourceObjSha256:request.sourceObjSha256,sourceGlbSha256:request.sourceGlbSha256,converterBinarySha256:BINARY,
    checks:{geometry:true,sourceUvCoverage:true,atlasPixels:true,finalTextureCandidate:true},
    textures:{policy:{...RECOVERY_TEXTURE_POLICY},basisPins:{...RECOVERY_BASIS_PINS},tilesetSha256:artifacts[0].sha256,
      expectedLod0InventorySha256:'d'.repeat(64),orderedImageMetricsSha256:'e'.repeat(64),renderContents:2,lod0Contents:1,
      images:2,mips:2,declaredTriangles:3,comparedPixels:1},
    rawProof:{schemaVersion:1,scope:'recovery-lod0-raw-atlas-and-source-uv-association-v1',sourceObjSha256:request.sourceObjSha256,
      expectedLod0InventorySha256:'d'.repeat(64),lod0Tiles:1,rawFaceRecords:3,rawAtlasReferences:1,
      rawAtlasPixelEqualityVerified:true,sourceUvAssociationVerified:true,reachableLod0ProofInventoryVerified:true,
      retainedInputsFinalCheckCompleted:true,receiptSha256:'f'.repeat(64),sourceUv:{sourceObjSha256:request.sourceObjSha256,
        declaredFaces:3,tiles:1,retainedProofInputsFinalCheckCompleted:true,sourceUvAssociationVerified:true}},
    rawProofStdoutSha256:'9'.repeat(64),provenance:{schemaVersion:4,sourceAsset:'model.glb',sourceSha256:request.sourceGlbSha256,
      converter:{inputAsset:'model.obj',inputSha256:request.sourceObjSha256,binarySha256:BINARY},
      audit:{algorithm:'ltds-obj2tiles-surface-equivalence-v4',artifacts}}};
  const execution = {sourceCommit:RECOVERY_PROOF_ENGINE_COMMIT,exitCode:0,childClosed:true,processGroupGone:true,
    runtimeBinding:structuredClone(runtime),requestSha256:hash(JSON.stringify(request))};
  const calibration = {schemaVersion:1,status:'qualified',engineSourceCommit:RECOVERY_PROOF_ENGINE_COMMIT,
    runtimeBindingSha256:hash(stable(runtime)),policy:{...RECOVERY_TEXTURE_POLICY},basisPins:{...RECOVERY_BASIS_PINS},
    converterBinarySha256:BINARY,receiptSha256:'7'.repeat(64),independentReviewSha256:'8'.repeat(64)};
  return {runtime,request,proof,execution,renderFiles,calibration};
}
test('metadata joins bind a reaped execution, source, all-LOD0 counts and the complete render inventory',()=>{
  const value=fixture();
  const checked=validateRecoveryCandidateEvidence({...value,runtimeBinding:value.runtime});
  assert.deepEqual(checked.renderArtifacts,value.proof.provenance.audit.artifacts);
  assert.equal(checked.provenance.sourceSha256,value.request.sourceGlbSha256);
});
test('stale runtime/request/exit/reap data cannot join an otherwise positive proof',()=>{
  for (const mutate of [
    value=>{value.execution.processGroupGone=false;},value=>{value.execution.childClosed=false;},
    value=>{value.execution.exitCode=1;},value=>{value.execution.sourceCommit='0'.repeat(40);},
    value=>{value.execution.runtimeBinding.imageId='sha256:'+'0'.repeat(64);},
    value=>{value.execution.requestSha256='0'.repeat(64);},
  ]) {const value=fixture();mutate(value);assert.throws(()=>validateRecoveryCandidateEvidence({...value,runtimeBinding:value.runtime}),
    {code:'supplement_proof_execution_unbound'});}
});
test('model metadata cannot claim readiness/calibration or substitute another source',()=>{
  for (const mutate of [value=>{value.proof.ready=true;},value=>{value.proof.calibrationRequired=false;},
    value=>{value.proof.mode='prepare';},value=>{value.proof.sourceObjSha256='0'.repeat(64);},
    value=>{value.proof.sourceGlbSha256='0'.repeat(64);},value=>{value.proof.converterBinarySha256='0'.repeat(64);},
  ]) {const value=fixture();mutate(value);assert.throws(()=>validateRecoveryCandidateEvidence({...value,runtimeBinding:value.runtime}),
    {code:'supplement_proof_source_unbound'});}
});
test('unfrozen gates, decoder bytes, incomplete mips, UV counts or skipped final checks reject',()=>{
  for (const mutate of [
    value=>{value.proof.textures.policy.imageRgbMae++;},value=>{value.proof.textures.basisPins.wasm='0'.repeat(64);},
    value=>{value.proof.textures.mips=1;},value=>{value.proof.rawProof.rawFaceRecords++;},
    value=>{value.proof.rawProof.sourceUv.tiles++;},value=>{value.proof.rawProof.retainedInputsFinalCheckCompleted=false;},
    value=>{value.proof.rawProof.expectedLod0InventorySha256='0'.repeat(64);},
  ]) {const value=fixture();mutate(value);assert.throws(()=>validateRecoveryCandidateEvidence({...value,runtimeBinding:value.runtime}),
    error=>['supplement_proof_texture_unbound','supplement_proof_uv_unbound'].includes(error.code));}
});
test('root/parent/leaf hashes and unique canonical render listings must match the host manifest',()=>{
  for (const mutate of [
    value=>{value.renderFiles[1].sha256='0'.repeat(64);},value=>{value.proof.provenance.audit.artifacts[1].uri='private/source.png';},
    value=>{value.proof.provenance.audit.artifacts[2].uri='LOD-0/LEAF.b3dm';},
    value=>{value.renderFiles[2]={...value.renderFiles[1]};},value=>{value.proof.textures.lod0Contents=2;},
  ]) {const value=fixture();mutate(value);assert.throws(()=>validateRecoveryCandidateEvidence({...value,runtimeBinding:value.runtime}));}
});
function options(value,read,execute=()=>assert.fail('must not execute a proof in preflight')) {
  return {environment:'STAGING',modelsRoot:path.resolve('models'),runtimeBinding:value.runtime,
    paths:{converterBinary:path.resolve('Obj2Tiles'),basisJavascript:path.resolve('basis.js'),basisWasm:path.resolve('basis.wasm')},
    executeProof:execute,getQualifiedCalibration:read,processing:{insertAudit:()=>assert.fail('preflight must not write audit/state')}};
}
test('preflight requires a separate reviewed server calibration record, not a child boolean',async()=>{
  for (const record of [null,{ready:true}, {...fixture().calibration,status:'pending'},
    {...fixture().calibration,independentReviewSha256:null},{...fixture().calibration,runtimeBindingSha256:'0'.repeat(64)}]) {
    const value=fixture(),verifier=createRecoveryCandidateVerifier(options(value,async()=>record));
    await assert.rejects(verifier.preflight(),{code:'supplement_calibration_unqualified'});
  }
});
test('preflight returns only qualified binding hashes and snapshots constructor metadata',async()=>{
  const value=fixture(),verifier=createRecoveryCandidateVerifier(options(value,async()=>value.calibration));
  const expected=hash(stable(value.runtime));value.runtime.imageId='sha256:'+'0'.repeat(64);
  const checked=await verifier.preflight();
  assert.equal(checked.runtimeBindingSha256,expected);assert.equal(checked.calibrationReceiptSha256,value.calibration.receiptSha256);
  assert.equal(checked.ready,undefined);
});
test('abort or lost lease during calibration lookup prevents preflight success',async()=>{
  for(const kind of ['abort','lease']) {
    const value=fixture(),abort=new AbortController();let finish,lost=false;
    const verifier=createRecoveryCandidateVerifier(options(value,()=>new Promise(resolve=>{finish=resolve;})));
    const pending=verifier.preflight({signal:abort.signal,assertCurrent:()=>{if(lost)throw Error('lease lost');}});
    if(kind==='abort')abort.abort(new Error('cancelled'));else lost=true;
    finish(value.calibration);await assert.rejects(pending,kind==='abort'?/cancelled/:/lease lost/);
  }
});
test('async or false lease guards fail closed before registry lookup',async()=>{
  const value=fixture(),verifier=createRecoveryCandidateVerifier(options(value,()=>assert.fail('must not look up calibration')));
  await assert.rejects(verifier.preflight({assertCurrent:async()=>{}}),{code:'supplement_proof_guard_must_be_synchronous'});
  await assert.rejects(verifier.preflight({assertCurrent:()=>false}),{code:'supplement_proof_guard_failed'});
});
test('production or caller paths cannot turn this staging factory into an unqualified adapter',()=>{
  const value=fixture();
  assert.throws(()=>createRecoveryCandidateVerifier({...options(value,async()=>value.calibration),environment:'PRODUCTION'}),{code:'supplement_candidate_verifier_unqualified'});
  assert.throws(()=>createRecoveryCandidateVerifier({...options(value,async()=>value.calibration),paths:{converterBinary:'relative'}}),{code:'supplement_candidate_verifier_unqualified'});
});
