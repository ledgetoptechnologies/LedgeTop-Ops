import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import policy from '../lod-converter-policy.cjs';
import { bindRecoveryRenderArtifacts } from '../scripts/lib/recovery-render-provenance.mjs';

// Digest/closure fixture only, never passed off as measured geometry evidence.
function fixture() {
  const artifacts = ['tileset.json','root.b3dm','LOD-1/parent.b3dm','LOD-0/leaf.b3dm']
    .map((uri,index)=>({uri,sha256:String(index).repeat(64),byteLength:100+index}));
  const audit = {schemaVersion:4,sourceSha256:'a'.repeat(64),converter:{inputSha256:'b'.repeat(64)},
    audit:{algorithm:'ltds-obj2tiles-surface-equivalence-v4',policy:{...policy.CONTROLLED_SURFACE_AUDIT_POLICY_V4},
      sourceTriangleCount:100,leafTriangleCount:150,artifacts:[artifacts[0],artifacts[3]]}};
  const {algorithm,policy:surfacePolicy,artifacts:leaves,...surfaceEvidence} = audit.audit;
  audit.audit.equivalenceSha256 = crypto.createHash('sha256').update(policy.stable({sourceSha256:audit.sourceSha256,
    converter:audit.converter,policy:surfacePolicy,surfaceEvidence,artifacts:leaves})).digest('hex');
  return {audit,proof:{schemaVersion:1,scope:'full-render-mip-decode-and-lod0-photographic-relation-v1',
    candidatePass:true,calibrationRequired:true,ready:false,tilesetSha256:artifacts[0].sha256,
    renderContents:3,renderArtifacts:artifacts}};
}
test('extends V4 digest with root and parent bytes without altering measured geometry or input audit',()=>{
  const {audit,proof} = fixture(), before = structuredClone(audit);
  const result = bindRecoveryRenderArtifacts(audit,proof);
  assert.deepEqual(audit,before); assert.equal(result.audit.artifacts.length,4);
  assert.equal(result.audit.sourceTriangleCount,100); assert.equal(result.audit.leafTriangleCount,150);
  assert.notEqual(result.audit.equivalenceSha256,audit.audit.equivalenceSha256);
  proof.renderArtifacts[1].sha256 = 'c'.repeat(64);
  assert.notEqual(bindRecoveryRenderArtifacts(audit,proof).audit.equivalenceSha256,result.audit.equivalenceSha256);
});
test('cannot bless a changed leaf, missing parent/root, private proof file, alias or stale measured audit',()=>{
  for (const mutate of [
    ({proof})=>{proof.renderArtifacts[3].sha256='f'.repeat(64);},
    ({proof})=>{proof.renderArtifacts.splice(1,1);},
    ({proof})=>{proof.renderArtifacts[1].uri='LOD-0/texture-proof/private.png';},
    ({proof})=>{proof.renderArtifacts[2].uri='LOD-0/LEAF.b3dm';},
    ({audit})=>{audit.audit.sourceTriangleCount++;},
    ({proof})=>{proof.ready=true;},
  ]) { const value = fixture(); mutate(value); assert.throws(()=>bindRecoveryRenderArtifacts(value.audit,value.proof),
    {code:'recovery_render_provenance_mismatch'}); }
});
