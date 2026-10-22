'use strict';

// These helpers validate a server-owned record of a conversion. Hashes identify
// bytes; they do not prove that a converter ran. Only the worker that observed a
// successful controlled invocation may create/persist this record, after byte
// verification, under its lease. Imported assertions must never use this API.
const crypto = require('node:crypto');
const { canonicalDerivativeInput, registeredPointDerivativeInput } = require('./derivativeInputSnapshot');
const { matchedSourceUnitEvidence } = require('./measurementSourceUnitEvidence');
const { safeRelativePath } = require('./processingSecurity');

const EPT_CONVERSION_CONTRACT = 'server-entwine-ept-preserve-coordinates-v1';
const EPT_CONVERTER_COMMAND = Object.freeze(['build', '-i', '$INPUT', '-o', '$OUTPUT']);
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const EPT_CONVERTER_COMMAND_SHA256 = digest(JSON.stringify(EPT_CONVERTER_COMMAND));
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const pathIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9-]{1,200}$/.test(value);
const factors = Object.freeze({ m: 1, ft: .3048, 'us-ft': 1200 / 3937, cm: .01, mm: .001, km: 1000 });
function invalid() { throw Object.assign(new Error('EPT conversion receipt is invalid'), { code: 'ept_conversion_receipt_invalid' }); }

function canonicalJson(value) {
  const normalize = item => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, normalize(item[key])]));
    }
    return invalid();
  };
  return JSON.stringify(normalize(value));
}
function unitProofSha256(proof) { return digest(canonicalJson(proof)); }

function acceptedInputProof({ modelId, modelVersionId, inputAsset, inputUnitEvidence }) {
  const source = { id: inputAsset.id, kind: 'pointCloud', sha256: inputAsset.sha256,
    byteSize: inputAsset.byte_size, manifestSha256: inputAsset.manifest_sha256 || '' };
  const request = { modelId, modelVersionId, source, coordinateReference: { crs: inputUnitEvidence?.crs } };
  const proof = matchedSourceUnitEvidence(request, inputUnitEvidence);
  if (!proof || !identifier(proof.id)
    || !['server-inspected-explicit-metadata', 'verified-odm-source'].includes(proof.basis)) invalid();
  const verticalFactor = proof.basis === 'verified-odm-source' ? 1 : proof.verticalFactor;
  if (proof.basis === 'verified-odm-source' && Object.hasOwn(proof, 'verticalFactor') && proof.verticalFactor !== 1) invalid();
  if (!Object.hasOwn(factors, proof.verticalUnit) || verticalFactor !== factors[proof.verticalUnit]) invalid();
  return { id: proof.id, sha256: unitProofSha256(proof), basis: proof.basis,
    crs: proof.crs, verticalUnit: proof.verticalUnit, verticalFactor, verticalDatum: 'unknown' };
}

function outputBinding(asset, { taskId, attemptId, jobId, modelVersionId }) {
  if (!asset || asset.versionId !== modelVersionId || asset.attemptId !== attemptId
    || asset.rootKey !== 'models' || asset.relativePath !== `${taskId}/${attemptId}/ept-${jobId}/ept.json`
    || safeRelativePath(asset.relativePath) !== asset.relativePath || !hash(asset.sha256) || !hash(asset.manifestSha256)
    || !Number.isSafeInteger(asset.byteSize) || asset.byteSize < 1
    || !Array.isArray(asset.manifestFiles) || !asset.manifestFiles.length) invalid();
  const files = asset.manifestFiles.map(file => ({ relativePath: file.relativePath, byteSize: file.byteSize, sha256: file.sha256 }))
    .sort((left, right) => String(left.relativePath).localeCompare(String(right.relativePath)));
  let totalByteSize = 0;
  for (const [index, file] of files.entries()) {
    if (typeof file.relativePath !== 'string' || !file.relativePath || safeRelativePath(file.relativePath) !== file.relativePath
      || !Number.isSafeInteger(file.byteSize) || file.byteSize < 0 || !hash(file.sha256)
      || (index && file.relativePath === files[index - 1].relativePath)) invalid();
    totalByteSize += file.byteSize;
    if (!Number.isSafeInteger(totalByteSize)) invalid();
  }
  // Deliberately identical to storageManager.hashTree's manifest convention.
  if (digest(JSON.stringify(files)) !== asset.manifestSha256) invalid();
  const manifest = files.find(file => file.relativePath === 'ept.json');
  if (!manifest || manifest.sha256 !== asset.sha256 || manifest.byteSize !== asset.byteSize) invalid();
  return { rootKey: asset.rootKey, relativePath: asset.relativePath, sha256: asset.sha256,
    byteSize: asset.byteSize, manifestSha256: asset.manifestSha256, fileCount: files.length, totalByteSize };
}

function converterBinding(converter) {
  if (!converter || converter.name !== 'entwine' || typeof converter.version !== 'string'
    || !converter.version.trim() || converter.version.length > 200 || /[\x00-\x1f\x7f]/.test(converter.version)
    || !hash(converter.executableSha256) || converter.commandSha256 !== EPT_CONVERTER_COMMAND_SHA256
    || canonicalJson(converter.command) !== canonicalJson(EPT_CONVERTER_COMMAND)) invalid();
  return { name: 'entwine', version: converter.version, executableSha256: converter.executableSha256,
    command: [...EPT_CONVERTER_COMMAND], commandSha256: EPT_CONVERTER_COMMAND_SHA256 };
}

function buildEptConversionReceipt(bindings) {
  const { jobId, attemptId, modelId, modelVersionId, taskId, inputAsset, inputSnapshot,
    converter, outputAsset, generationLeaseToken, createdAt } = bindings;
  if (![jobId, attemptId, modelId, modelVersionId, taskId, generationLeaseToken].every(identifier)
    || ![jobId, attemptId, taskId, generationLeaseToken].every(pathIdentifier)
    || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))
    || new Date(createdAt).toISOString() !== createdAt
    || !inputAsset || !identifier(inputAsset.id) || inputAsset.version_id !== modelVersionId
    || (inputAsset.manifest_sha256 || '') !== '' || inputSnapshot?.jobId !== jobId
    || inputSnapshot.derivativeType !== 'ept' || inputSnapshot.schemaVersion !== 1) invalid();
  const canonical = canonicalDerivativeInput('ept', inputSnapshot.files);
  if (inputSnapshot.manifestSha256 !== canonical.manifestSha256
    || inputSnapshot.fileCount !== canonical.fileCount || inputSnapshot.totalByteSize !== canonical.totalByteSize) invalid();
  registeredPointDerivativeInput(inputSnapshot, [inputAsset]);
  const inputUnitProof = acceptedInputProof(bindings);
  const input = { assetId: inputAsset.id, kind: 'pointCloud', rootKey: inputAsset.root_key,
    relativePath: inputAsset.relative_path, sha256: inputAsset.sha256,
    byteSize: inputAsset.byte_size, manifestSha256: '' };
  return { schemaVersion: 1, contract: EPT_CONVERSION_CONTRACT, jobId, attemptId, modelId, modelVersionId, taskId,
    input, inputSnapshotSha256: canonical.manifestSha256, inputUnitProof,
    converter: converterBinding(converter), output: outputBinding(outputAsset, bindings), generationLeaseToken, createdAt };
}

function createEptConversionReceipt(bindings) {
  try { return buildEptConversionReceipt(bindings); } catch { return invalid(); }
}

function validateEptConversionReceipt(receipt, bindings) {
  try {
    const expected = createEptConversionReceipt({ ...bindings,
      converter: bindings.converter || receipt.converter,
      generationLeaseToken: receipt.generationLeaseToken, createdAt: receipt.createdAt });
    return canonicalJson(receipt) === canonicalJson(expected);
  } catch { return false; }
}

// A horizontal-only EPT can inherit a separately verified conversion proof.
// Unsupported, malformed, or conflicting encoded metadata can never be ignored.
// This metadata guard does not authenticate a registered proof: creation checks
// that proof's full source binding, and the repository must load it itself.
async function inspectEptConversionOutput(ept, inputUnitEvidence) {
  const { resolveEptUtmCrs, resolveEptVerticalUnits } = await import('./measurementEptCrs.mjs');
  const factor = inputUnitEvidence?.basis === 'verified-odm-source' ? 1 : inputUnitEvidence?.verticalFactor;
  if (!inputUnitEvidence || !Object.hasOwn(factors, inputUnitEvidence.verticalUnit)
    || !['server-inspected-explicit-metadata', 'verified-odm-source'].includes(inputUnitEvidence.basis)
    || (inputUnitEvidence.basis === 'verified-odm-source' && Object.hasOwn(inputUnitEvidence, 'verticalFactor') && inputUnitEvidence.verticalFactor !== 1)
    || factor !== factors[inputUnitEvidence.verticalUnit] || inputUnitEvidence.verticalDatum !== 'unknown'
    || !/^EPSG:\d{5}$/.test(inputUnitEvidence.crs || '')) invalid();
  const expected = Number(inputUnitEvidence.crs.slice(5));
  let encodedVerticalUnits = true;
  try {
    const vertical = resolveEptVerticalUnits(ept?.srs, expected);
    if (vertical.verticalFactor !== factor) throw Object.assign(new Error('EPT output units conflict with its conversion input'), { code: 'measurement_source_vertical_units_conflict' });
  } catch (error) {
    if (error.code !== 'measurement_source_vertical_units_required') throw error;
    resolveEptUtmCrs(ept.srs, expected);
    // Defense in depth: an unvalidated vertical CRS is never absent metadata,
    // even if a future shared parser changes its missing-unit error behavior.
    if (Object.hasOwn(ept.srs, 'vertical')) throw Object.assign(new Error('EPT vertical CRS cannot be validated'), { code: 'measurement_source_vertical_units_unsupported' });
    if (['wkt', 'wkt2'].some(key => /^\s*(?:COMPD_CS|COMPOUNDCRS)\s*\[/i.test(ept.srs[key] || ''))) throw error;
    encodedVerticalUnits = false;
  }
  return { crs: inputUnitEvidence.crs, verticalUnit: inputUnitEvidence.verticalUnit,
    verticalFactor: factor, verticalDatum: 'unknown', encodedVerticalUnits };
}

module.exports = { EPT_CONVERSION_CONTRACT, EPT_CONVERTER_COMMAND, EPT_CONVERTER_COMMAND_SHA256,
  canonicalJson, unitProofSha256, createEptConversionReceipt, validateEptConversionReceipt, inspectEptConversionOutput };
