'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { stable } = require('../lod-converter-policy.cjs');
const { canonicalDerivativeInput } = require('./derivativeInputSnapshot');
const { canonicalSupplement } = require('./derivativeSupplement');
const { immutableSupplementSlot } = require('./derivativeSupplementRegistration');
const { PinnedSupplementDirectory } = require('./derivativeSupplementFiles');
const { verifyLodProvenance } = require('./lodProvenance');
const {RECOVERY_RUNTIME}=require('./recoveryProofRuntimePins');

const ENGINE_COMMIT = RECOVERY_RUNTIME.sourceCommit;
const BINARY = RECOVERY_RUNTIME.converterBinarySha256;
const BASIS = Object.freeze({ javascript:'8478b5b6d6b74e7d3082b89f6417321d8d1dc0307f2b30d4484bb11b441696a1',
  wasm:'6cf17dc889352c42e9acf8897107978d127005fe3386c36a0e3845e27967630a' });
const POLICY = Object.freeze({ revision:'ltds-lossy-lod0-srgb-v1-candidate',regionEdge:512,maximumEdge:16384,
  imageRgbMae:10,imageRgbRmse:16,regionRgbMae:16,regionRgbRmse:24,alphaMaximum:20,alphaMae:2 });
const fail = code => { throw Object.assign(new Error(code),{code:`supplement_${code}`}); };
const requireValue = (value,code) => { if (!value) fail(code); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const count = (value,max) => Number.isSafeInteger(value) && value > 0 && value <= max;
const same = (a,b) => stable(a) === stable(b);
function freeze(value) { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function current(signal,assertCurrent) {
  signal?.throwIfAborted();const result = assertCurrent();
  if (result && typeof result.then === 'function') {
    Promise.resolve(result).catch(() => {});fail('proof_guard_must_be_synchronous');
  }
  requireValue(result !== false,'proof_guard_failed');signal?.throwIfAborted();
}

// Pure binding validation only. This cannot manufacture measured proof, acquire
// custody, launch a decoder or authorize readiness. The factory below uses the
// fixed trusted executor and separately verifies the real stored provenance.
function validateRecoveryCandidateEvidence({ request,proof,execution,runtimeBinding,renderFiles }) {
  requireValue(runtimeBinding&&Object.entries(RECOVERY_RUNTIME).every(([key,value])=>runtimeBinding[key]===value)
    && execution?.sourceCommit === ENGINE_COMMIT && execution.exitCode === 0 && execution.childClosed === true
    && execution.processGroupGone === true && same(execution.runtimeBinding,runtimeBinding)
    && execution.requestSha256 === sha(JSON.stringify(request)), 'proof_execution_unbound');
  requireValue(proof?.schemaVersion === 1 && proof.scope === 'recovery-candidate-independent-evidence-v1'
    && proof.mode === 'verify' && proof.ready === false && proof.calibrationRequired === true
    && proof.sourceObjSha256 === request.sourceObjSha256 && proof.sourceGlbSha256 === request.sourceGlbSha256
    && proof.converterBinarySha256 === BINARY, 'proof_source_unbound');
  const checks = proof.checks;
  requireValue(checks && Object.keys(checks).sort().join('|') === 'atlasPixels|finalTextureCandidate|geometry|sourceUvCoverage'
    && Object.values(checks).every(value => value === true), 'independent_proof_incomplete');
  const textures = proof.textures, raw = proof.rawProof;
  requireValue(textures && same(textures.policy,POLICY) && same(textures.basisPins,BASIS)
    && digest(textures.tilesetSha256) && digest(textures.expectedLod0InventorySha256)
    && digest(textures.orderedImageMetricsSha256) && count(textures.renderContents,8192)
    && count(textures.lod0Contents,4096) && textures.lod0Contents <= textures.renderContents
    && count(textures.images,100000) && textures.images >= textures.renderContents
    && count(textures.mips,1500000) && textures.mips >= textures.images && textures.mips <= textures.images * 15
    && count(textures.declaredTriangles,10000000) && count(textures.comparedPixels,100000 * 16384 ** 2), 'proof_texture_unbound');
  requireValue(raw?.schemaVersion === 1 && raw.scope === 'recovery-lod0-raw-atlas-and-source-uv-association-v1'
    && raw.sourceObjSha256 === request.sourceObjSha256 && raw.expectedLod0InventorySha256 === textures.expectedLod0InventorySha256
    && raw.lod0Tiles === textures.lod0Contents && raw.rawFaceRecords === textures.declaredTriangles
    && raw.rawAtlasPixelEqualityVerified === true && raw.sourceUvAssociationVerified === true
    && raw.reachableLod0ProofInventoryVerified === true && raw.retainedInputsFinalCheckCompleted === true
    && raw.sourceUv?.sourceObjSha256 === request.sourceObjSha256 && raw.sourceUv.declaredFaces === raw.rawFaceRecords
    && raw.sourceUv.tiles === textures.lod0Contents && count(raw.rawAtlasReferences,textures.images)
    && raw.sourceUv.retainedProofInputsFinalCheckCompleted === true && raw.sourceUv.sourceUvAssociationVerified === true
    && digest(raw.receiptSha256) && digest(proof.rawProofStdoutSha256), 'proof_uv_unbound');
  const provenance = proof.provenance, artifacts = provenance?.audit?.artifacts;
  requireValue(provenance?.schemaVersion === 4 && provenance.sourceAsset === path.basename(request.sourceGlb)
    && provenance.sourceSha256 === request.sourceGlbSha256 && provenance.converter?.inputAsset === path.basename(request.sourceObj)
    && provenance.converter.inputSha256 === request.sourceObjSha256 && provenance.converter.binarySha256 === BINARY
    && provenance.audit?.algorithm === 'ltds-obj2tiles-surface-equivalence-v4'
    && Array.isArray(artifacts) && Array.isArray(renderFiles) && artifacts.length === renderFiles.length
    && artifacts.length === textures.renderContents + 1, 'proof_render_unbound');
  const bound = new Map(), folded = new Set();
  for (const artifact of artifacts) {
    requireValue(artifact && !bound.has(artifact.uri) && !folded.has(String(artifact.uri).toLowerCase())
      && digest(artifact.sha256) && count(artifact.byteLength,512 * 1024 ** 2)
      && /^(?:tileset\.json|root\.b3dm|LOD-[0-2]\/[A-Za-z0-9_.-]+\.b3dm)$/.test(artifact.uri || ''), 'proof_render_unbound');
    bound.set(artifact.uri,artifact);
    folded.add(artifact.uri.toLowerCase());
  }
  requireValue(bound.has('tileset.json') && bound.has('root.b3dm')
    && bound.get('tileset.json').sha256 === textures.tilesetSha256
    && [...bound.keys()].filter(name => name.startsWith('LOD-0/')).length === textures.lod0Contents, 'proof_render_unbound');
  const listed = new Set();
  for (const file of renderFiles) {
    requireValue(!listed.has(file.relativePath),'proof_render_unbound');listed.add(file.relativePath);
    const artifact = bound.get(file.relativePath);
    requireValue(artifact && artifact.sha256 === file.sha256 && artifact.byteLength === file.byteSize, 'proof_render_unbound');
  }
  return { renderArtifacts:artifacts,provenance };
}

// getQualifiedCalibration is a trusted server registry/read, never model JSON or
// the child's calibrationRequired/ready fields. Qualification must bind the
// independent review to this exact engine/runtime/decoder/policy combination.
function createRecoveryCandidateVerifier({ environment,modelsRoot,runtimeBinding,paths,executeProof,getQualifiedCalibration,processing } = {}) {
  requireValue(environment === 'STAGING' && typeof modelsRoot === 'string' && path.isAbsolute(modelsRoot)
    && path.resolve(modelsRoot) === modelsRoot && !modelsRoot.includes('\0')
    && runtimeBinding?.sourceCommit === ENGINE_COMMIT && /^sha256:[a-f0-9]{64}$/.test(runtimeBinding.imageId || '')
    && Object.entries(RECOVERY_RUNTIME).every(([key,value])=>runtimeBinding[key]===value)
    && runtimeBinding.converterBinarySha256 === BINARY && runtimeBinding.basisJavascriptSha256 === BASIS.javascript
    && runtimeBinding.basisWasmSha256 === BASIS.wasm && typeof executeProof === 'function'
    && typeof getQualifiedCalibration === 'function' && typeof processing?.insertAudit === 'function', 'candidate_verifier_unqualified');
  requireValue(paths && Object.keys(paths).sort().join('|') === 'basisJavascript|basisWasm|converterBinary'
    && Object.values(paths).every(value => typeof value === 'string' && path.isAbsolute(value)
      && path.resolve(value) === value && !value.includes('\0')), 'candidate_verifier_unqualified');
  const runtime = freeze(structuredClone(runtimeBinding)), fixedPaths = freeze({...paths});
  const runtimeSha256 = sha(stable(runtime));
  async function qualified(check) {
    check();
    const value = await getQualifiedCalibration({ engineSourceCommit:ENGINE_COMMIT,runtimeBindingSha256:runtimeSha256,
      policy:POLICY,basisPins:BASIS,converterBinarySha256:BINARY });
    check();
    requireValue(value?.schemaVersion === 1 && value.status === 'qualified'
      && value.engineSourceCommit === ENGINE_COMMIT && value.runtimeBindingSha256 === runtimeSha256
      && same(value.policy,POLICY) && same(value.basisPins,BASIS) && value.converterBinarySha256 === BINARY
      && digest(value.receiptSha256) && digest(value.independentReviewSha256), 'calibration_unqualified');
    return freeze({ receiptSha256:value.receiptSha256,independentReviewSha256:value.independentReviewSha256 });
  }
  const verifier = async ({ operation,context,identity,manifest,source,output,signal = null,assertCurrent } = {}) => {
    requireValue(typeof assertCurrent === 'function', 'candidate_verifier_unqualified');
    const check = () => current(signal,assertCurrent);
    check(); const calibration = await qualified(check);
    const parsed = canonicalSupplement(manifest), input = canonicalDerivativeInput('mesh_tiles',context?.input?.files);
    requireValue(input.manifestSha256 === context.input.manifestSha256 && same(identity,parsed.manifest.identity)
      && parsed.manifest.identity.environment === 'STAGING' && parsed.supplementSha256 === operation?.supplement_sha256,
    'proof_source_unbound');
    requireValue(source instanceof PinnedSupplementDirectory && output instanceof PinnedSupplementDirectory
      && source.root === modelsRoot && source.relativeRoot === '' && output.root === modelsRoot
      && output.relativeRoot === immutableSupplementSlot(operation,context), 'proof_custody_unbound');
    source.assertAllPinned({signal,assertCurrent:check}); output.assertAllPinned({signal,assertCurrent:check});
    output.assertComplete({signal,assertCurrent:check});
    for (const file of input.files) requireValue(file.rootKey === 'models' && same(source.files.get(file.relativePath),file),'proof_source_unbound');
    requireValue(source.files.size === input.files.length && output.files.size === parsed.manifest.files.length,'proof_custody_unbound');
    for (const file of parsed.manifest.files) requireValue(same(output.files.get(file.relativePath),file),'proof_custody_unbound');
    const obj = input.files.find(file => file.role === 'mesh_obj'), glb = input.files.find(file => file.role === 'mesh_glb');
    const absolute = file => path.join(modelsRoot,...file.relativePath.split('/'));
    const directory = path.join(modelsRoot,...output.relativeRoot.split('/'));
    const command = require('../lod-converter-policy.cjs');
    const serial = parsed.manifest.converter.commandSha256 === command.SERIAL_RETRY_CONVERTER_COMMAND_SHA256;
    requireValue(parsed.manifest.converter.binarySha256 === BINARY
      && [command.CONTROLLED_CONVERTER_COMMAND_SHA256,command.SERIAL_RETRY_CONVERTER_COMMAND_SHA256].includes(parsed.manifest.converter.commandSha256)
      && command.acceptedConverterBinaryCommand(parsed.manifest.converter.commandSha256,BINARY), 'proof_converter_unbound');
    const request = freeze({schemaVersion:1,mode:'verify',output:directory,sourceObj:absolute(obj),sourceGlb:absolute(glb),
      ...fixedPaths,sourceObjSha256:obj.sha256,sourceGlbSha256:glb.sha256,converterBinarySha256:BINARY,converterSerialRetry:serial});
    const deadline = Date.parse(operation.deadline_at);requireValue(Number.isFinite(deadline) && deadline > Date.now(),'proof_deadline');
    check();
    // Keep actual OBJ/GLB descriptor pins until the executor confirms every
    // reader exited. The existing outer custody additionally fences all files.
    const result = freeze(structuredClone(await source.withFile(obj.relativePath,() => source.withFile(glb.relativePath,() => executeProof({
      request,signal,deadline,assertCurrent:check }),{signal,assertCurrent:check}),{signal,assertCurrent:check})));
    check();
    const renderFiles = parsed.manifest.files.filter(file => file.role === 'render');
    const bound = validateRecoveryCandidateEvidence({request,...result,runtimeBinding:runtime,renderFiles});
    const provenanceEntry = output.files.get('lod-provenance.json');
    requireValue(provenanceEntry?.role === 'private-proof' && provenanceEntry.byteSize <= 16 * 1024 ** 2,'proof_render_unbound');
    // The server verifier checks actual bytes, the legacy V4 acceptance policy,
    // its evidence digest and current converter trust; child data is not enough.
    await output.withFile('lod-provenance.json',async ({fd,byteSize}) => {
      const bytes = Buffer.alloc(byteSize);let at = 0;
      while (at < bytes.length) {
        check();const size = Math.min(1024 ** 2,bytes.length-at);
        const n = await new Promise((resolve,reject) => fs.read(fd,bytes,at,size,at,(error,read) => error ? reject(error) : resolve(read)));
        check();requireValue(n > 0,'proof_provenance_invalid');at += n;
      }
      let stored;try {stored=JSON.parse(bytes.toString('utf8'));} catch {fail('proof_provenance_invalid');}
      requireValue(same(stored,bound.provenance),'proof_provenance_invalid');
    },{signal,assertCurrent:check});
    check();const checked = await verifyLodProvenance(path.join(directory,'lod-provenance.json'),absolute(glb),{signal,checkpoint:check});
    check();requireValue(checked.verified && same(checked.artifacts,bound.renderArtifacts),'proof_provenance_invalid');
    requireValue(same(await qualified(check),calibration),'calibration_changed');
    check(); source.assertAllPinned({signal,assertCurrent:check}); output.assertAllPinned({signal,assertCurrent:check});
    output.assertComplete({signal,assertCurrent:check});
    const evidence = {
      schemaVersion:1,scope:'independent-verification-only-not-registration-or-readiness',
      engineSourceCommit:ENGINE_COMMIT,runtimeBindingSha256:runtimeSha256,
      sourceManifestSha256:input.manifestSha256,outputManifestSha256:parsed.manifest.outputManifestSha256,
      calibrationReceiptSha256:calibration.receiptSha256,independentCalibrationReviewSha256:calibration.independentReviewSha256,
      requestSha256:result.execution.requestSha256,rawUvReceiptSha256:result.proof.rawProof.receiptSha256,
      rawUvStdoutSha256:result.proof.rawProofStdoutSha256,imageMetricsSha256:result.proof.textures.orderedImageMetricsSha256,
      equivalenceSha256:checked.provenance.audit.equivalenceSha256,photographicPolicyRevision:POLICY.revision,
      renderContents:result.proof.textures.renderContents,lod0Contents:result.proof.textures.lod0Contents,
      images:result.proof.textures.images,mips:result.proof.textures.mips,comparedPixels:result.proof.textures.comparedPixels,
    };
    const evidenceSha256 = sha(`ltds-recovery-independent-evidence-v1\0${stable(evidence)}`);
    try {
      processing.insertAudit({actorType:'system',action:'derivative_recovery.independent_proof',entityType:'derivative_recovery',
        entityId:operation.id,details:{evidenceSha256,...evidence}});
    } catch {fail('proof_evidence_unavailable');}
    check();
    // These hashes were actually verified by pinned custody. Preserve the
    // hashTree accounting shape without rereading every private proof again.
    const files = parsed.manifest.files.map(({relativePath,byteSize,sha256}) => ({relativePath,byteSize,sha256}))
      .sort((a,b) => a.relativePath.localeCompare(b.relativePath));
    const tileset = files.find(file => file.relativePath === 'tileset.json');
    return { verified:{asset:{versionId:context.version.id,attemptId:context.attempt.id,rootKey:'models',
      relativePath:`${output.relativeRoot}/tileset.json`,format:'3dtiles',contentType:'application/json',
      byteSize:tileset.byteSize,sha256:tileset.sha256,manifestSha256:sha(JSON.stringify(files)),manifestFiles:files},
    provenance:checked.provenance,renderArtifacts:checked.artifacts},
    receipt:{schemaVersion:1,policyRevision:parsed.manifest.converter.policyRevision,identity:structuredClone(identity),
      outputManifestSha256:parsed.manifest.outputManifestSha256,
      checks:{geometry:true,sourceUvCoverage:true,atlasPixels:true,finalTextureRelation:true}} };
  };
  verifier.preflight = async ({signal = null,assertCurrent = () => {}} = {}) => {
    const check = () => current(signal,assertCurrent);
    const value = await qualified(check);
    return {engineSourceCommit:ENGINE_COMMIT,runtimeBindingSha256:runtimeSha256,
      calibrationReceiptSha256:value.receiptSha256,independentReviewSha256:value.independentReviewSha256};
  };
  return Object.freeze(verifier);
}

module.exports = { createRecoveryCandidateVerifier,validateRecoveryCandidateEvidence,
  RECOVERY_PROOF_ENGINE_COMMIT:ENGINE_COMMIT,RECOVERY_TEXTURE_POLICY:POLICY,RECOVERY_BASIS_PINS:BASIS };
