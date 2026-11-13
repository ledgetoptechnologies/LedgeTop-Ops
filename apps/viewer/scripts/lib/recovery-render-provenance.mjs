import crypto from 'node:crypto';
import policy from '../../lod-converter-policy.cjs';

const fail = () => { throw Object.assign(new Error('render provenance mismatch'), {code:'recovery_render_provenance_mismatch'}); };
const hash = value => crypto.createHash('sha256').update(policy.stable(value)).digest('hex');
const ascii = (a,b) => a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;

// Called only with a freshly recomputed V4 audit and texture-output proof.
// Extends its existing digest to bind root/parent bytes as well as leaf bytes.
// No geometry policy, measured evidence or texture acceptance is invented here;
// calibration/source proof and the server's independent verification still apply.
export function bindRecoveryRenderArtifacts(freshAudit, textureProof) {
  if (freshAudit?.schemaVersion !== 4 || freshAudit.audit?.algorithm !== 'ltds-obj2tiles-surface-equivalence-v4'
    || policy.stable(freshAudit.audit.policy) !== policy.stable(policy.CONTROLLED_SURFACE_AUDIT_POLICY_V4)
    || textureProof?.schemaVersion !== 1 || textureProof.scope !== 'full-render-mip-decode-and-lod0-photographic-relation-v1'
    || textureProof.candidatePass !== true || textureProof.calibrationRequired !== true || textureProof.ready !== false) fail();
  const supplied = textureProof.renderArtifacts;
  if (!Array.isArray(supplied) || supplied.length < 3 || supplied.length > 8193
    || textureProof.renderContents !== supplied.length - 1) fail();
  const artifacts = [], seen = new Set(), folded = new Set();
  for (const value of supplied) {
    if (!value || Object.keys(value).sort().join('|') !== 'byteLength|sha256|uri'
      || !/^(?:tileset\.json|root\.b3dm|LOD-[0-2]\/[A-Za-z0-9_.-]+\.b3dm)$/.test(value.uri || '')
      || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || !Number.isSafeInteger(value.byteLength) || value.byteLength <= 0
      || seen.has(value.uri) || folded.has(value.uri.toLowerCase())) fail();
    seen.add(value.uri); folded.add(value.uri.toLowerCase()); artifacts.push({...value});
  }
  if (!seen.has('tileset.json') || !seen.has('root.b3dm') || !artifacts.some(value => value.uri.startsWith('LOD-0/'))
    || artifacts.find(value => value.uri === 'tileset.json').sha256 !== textureProof.tilesetSha256) fail();
  const actual = new Map(artifacts.map(value => [value.uri,value]));
  if (!Array.isArray(freshAudit.audit.artifacts) || freshAudit.audit.artifacts.length < 2) fail();
  const oldSeen = new Set();
  for (const old of freshAudit.audit.artifacts) {
    const current = actual.get(old?.uri);
    if (!current || oldSeen.has(old.uri) || current.sha256 !== old.sha256 || current.byteLength !== old.byteLength) fail();
    oldSeen.add(old.uri);
  }
  if (!oldSeen.has('tileset.json') || artifacts.some(value => value.uri.startsWith('LOD-0/') && !oldSeen.has(value.uri))
    || [...oldSeen].some(uri => uri !== 'tileset.json' && !uri.startsWith('LOD-0/'))) fail();
  const { algorithm,policy:surfacePolicy,equivalenceSha256,artifacts:oldArtifacts,...surfaceEvidence } = freshAudit.audit;
  // Refuse an internally inconsistent or stale input audit before extending it.
  if (equivalenceSha256 !== hash({sourceSha256:freshAudit.sourceSha256,converter:freshAudit.converter,
    policy:surfacePolicy,surfaceEvidence,artifacts:oldArtifacts})) fail();
  const result = structuredClone(freshAudit);
  result.audit.artifacts = artifacts.sort(ascii);
  result.audit.equivalenceSha256 = hash({sourceSha256:result.sourceSha256,converter:result.converter,
    policy:surfacePolicy,surfaceEvidence,artifacts:result.audit.artifacts});
  return result;
}
