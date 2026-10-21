'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  ACCEPTED_CONTROLLED_CONVERTER_CONTRACTS,
  CONTROLLED_CONVERTER_BINARY_SHA256,
  CONTROLLED_SURFACE_AUDIT_POLICY_V4,
  stable,
} = require('../lod-converter-policy.cjs');

const digestCache = new Map();
const AUDIT_ALGORITHM = 'ltds-glb-leaf-equivalence-v2';
const CONTROLLED_AUDIT_ALGORITHM = 'ltds-obj2tiles-surface-equivalence-v3';
const CONTROLLED_AUDIT_ALGORITHM_V4 = 'ltds-obj2tiles-surface-equivalence-v4';
const CONTROLLED_CONVERTER_BINARY_SHA256_SET = new Set(CONTROLLED_CONVERTER_BINARY_SHA256);
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_AUDIT_ARTIFACTS = 100_000;

async function sha256File(filePath) {
  const stat = await fs.promises.stat(filePath);
  const cacheKey = `${path.resolve(filePath)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  if (digestCache.has(cacheKey)) return digestCache.get(cacheKey);

  const digest = await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
  digestCache.set(cacheKey, digest);
  return digest;
}

async function verifyLodProvenance(manifestPath, fullMeshPath) {
  const errors = [];
  let provenance;
  try {
    const stat = await fs.promises.stat(manifestPath);
    if (stat.size > MAX_MANIFEST_BYTES) throw new Error('manifest exceeds 16 MiB');
    provenance = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  } catch (error) {
    return { verified: false, errors: [`cannot read provenance: ${error.message}`], provenance: null };
  }

  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) {
    return { verified: false, errors: ['provenance must be an object'], provenance: null };
  }
  const exactV2 = provenance.schemaVersion === 2 && provenance.audit?.algorithm === AUDIT_ALGORITHM;
  const controlledV3 = provenance.schemaVersion === 3 && provenance.audit?.algorithm === CONTROLLED_AUDIT_ALGORITHM;
  const controlledV4 = provenance.schemaVersion === 4 && provenance.audit?.algorithm === CONTROLLED_AUDIT_ALGORITHM_V4;
  const controlled = controlledV3 || controlledV4;
  if (!exactV2 && !controlled) errors.push('provenance must use exact v2 or controlled Obj2Tiles v3/v4 audit evidence');
  if (!/^[a-f0-9]{64}$/i.test(String(provenance.sourceSha256 || ''))) {
    errors.push('sourceSha256 must be a SHA-256 digest');
  }
  if (provenance.sourceAsset !== path.basename(fullMeshPath || '')) {
    errors.push('sourceAsset must name the selected full-resolution mesh');
  }
  if (!/\.glb$/i.test(String(provenance.sourceAsset || ''))) {
    errors.push('audited sourceAsset must be a GLB');
  }
  const expectedGeometry = controlled ? 'controlled-bidirectional-surface-equivalence' : 'bounded-triangle-equivalence';
  const expectedTextures = controlled ? 'controlled-atlas-material-equivalence' : 'byte-identical-material-equivalence';
  if (provenance.geometry !== expectedGeometry) errors.push(`geometry must be ${expectedGeometry}`);
  if (provenance.textures !== expectedTextures) errors.push(`textures must be ${expectedTextures}`);
  if (provenance.leafGeometricError !== 0) errors.push('leafGeometricError must be 0');

  const audit = provenance.audit;
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) {
    errors.push('audit evidence is required');
  } else {
    if (exactV2) {
      if (!Number.isFinite(audit.coordinateTolerance) || audit.coordinateTolerance < 0 || audit.coordinateTolerance > 1e-3) errors.push('audit.coordinateTolerance must be between 0 and 0.001');
      if (!Number.isFinite(audit.maxNumericDelta) || audit.maxNumericDelta < 0 || audit.maxNumericDelta > audit.coordinateTolerance) errors.push('audit.maxNumericDelta must not exceed coordinateTolerance');
      if (!Number.isInteger(audit.triangleCount) || audit.triangleCount < 1) errors.push('audit.triangleCount must be a positive integer');
      const hasLeafCounts = audit.leafTriangleCount !== undefined || audit.duplicateLeafTriangleCount !== undefined;
      if (hasLeafCounts && (!Number.isInteger(audit.leafTriangleCount) || audit.leafTriangleCount < audit.triangleCount)) errors.push('audit.leafTriangleCount must be an integer no smaller than triangleCount');
      if (hasLeafCounts && (!Number.isInteger(audit.duplicateLeafTriangleCount) || audit.duplicateLeafTriangleCount < 0 || audit.duplicateLeafTriangleCount !== audit.leafTriangleCount - audit.triangleCount)) errors.push('audit.duplicateLeafTriangleCount must match the bounded leaf overlap');
    } else if (controlled) {
      const converter = provenance.converter;
      const contractMatches = ACCEPTED_CONTROLLED_CONVERTER_CONTRACTS.some((contract) => (
        converter
        && converter.name === contract.converter.name
        && converter.version === contract.converter.version
        && stable(converter.arguments) === stable(contract.converter.arguments)
        && converter.commandSha256 === contract.commandSha256
      ));
      if (!contractMatches) errors.push('converter must match the pinned Obj2Tiles command contract');
      for (const [key, value] of [['converter.inputSha256', converter?.inputSha256], ['converter.binarySha256', converter?.binarySha256]]) {
        if (!/^[a-f0-9]{64}$/i.test(String(value || ''))) errors.push(`${key} must be a SHA-256 digest`);
      }
      if (!CONTROLLED_CONVERTER_BINARY_SHA256_SET.has(String(converter?.binarySha256 || '').toLowerCase())) errors.push('converter.binarySha256 must match an approved Obj2Tiles 1.6.2 executable');
      if (!/\.obj$/i.test(String(converter?.inputAsset || '')) || path.basename(converter?.inputAsset || '') !== converter?.inputAsset) errors.push('converter.inputAsset must name the exact OBJ input');
      if (!Number.isInteger(audit.sourceTriangleCount) || audit.sourceTriangleCount < 1 || !Number.isInteger(audit.leafTriangleCount) || audit.leafTriangleCount < 1) errors.push('controlled audit triangle counts must be positive integers');
      if (!Number.isFinite(audit.surfaceTolerance) || audit.surfaceTolerance <= 0 || !Number.isFinite(audit.diagonal) || audit.diagonal <= 0 || audit.surfaceTolerance > audit.diagonal * 1e-3) errors.push('controlled audit surface tolerance is invalid');
      for (const key of ['boundsDelta', 'areaRelativeDelta', 'centroidDelta', 'normalizedSecondMomentDelta']) if (!Number.isFinite(audit[key]) || audit[key] < 0) errors.push(`controlled audit ${key} is invalid`);
      if (controlledV3 && (audit.boundsDelta > audit.surfaceTolerance || audit.centroidDelta > audit.surfaceTolerance || audit.areaRelativeDelta > 1e-5 || audit.normalizedSecondMomentDelta > 2e-5)) errors.push('controlled v3 audit aggregate surface evidence exceeds policy');
      for (const key of ['sourceToLeaves', 'leavesToSource']) {
        const direction = audit[key];
        if (!Number.isInteger(direction?.sampleCount) || direction.sampleCount < 4 || !Number.isFinite(direction.maximumDistance) || direction.maximumDistance < 0 || direction.maximumDistance > audit.surfaceTolerance || !Number.isFinite(direction.minimumNormalDot) || !Number.isInteger(direction.reversedNormalSampleCount) || direction.reversedNormalSampleCount < 0 || direction.reversedNormalSampleCount > direction.sampleCount || !Number.isFinite(direction.reversedNormalFraction) || direction.reversedNormalFraction < 0 || direction.reversedNormalFraction > CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalMaximumReversedNormalFraction || Math.abs(direction.reversedNormalFraction - direction.reversedNormalSampleCount / direction.sampleCount) > 1e-12) errors.push(`controlled audit ${key} evidence is invalid`);
      }
      for (const key of ['sourceRender', 'leafRender']) {
        const render = audit[key];
        if (!Number.isInteger(render?.triangleCount) || render.triangleCount < 1 || render.texturedTriangleCount !== render.triangleCount || render.uvTriangleCount !== render.triangleCount || !Number.isInteger(render.normalTriangleCount) || render.normalTriangleCount < 0 || render.normalTriangleCount > render.triangleCount) errors.push(`controlled audit ${key} coverage is invalid`);
      }
      if (controlledV4) {
        if (stable(audit.policy) !== stable(CONTROLLED_SURFACE_AUDIT_POLICY_V4)) errors.push('controlled v4 audit policy does not match the server policy');
        if (audit.accumulationMethod !== CONTROLLED_SURFACE_AUDIT_POLICY_V4.accumulationMethod) errors.push('controlled v4 accumulation method is invalid');
        for (const key of ['sourceDegenerateTriangleCount', 'leafDegenerateTriangleCount']) {
          if (!Number.isInteger(audit[key]) || audit[key] < 0) errors.push(`controlled v4 audit ${key} is invalid`);
        }
        for (const key of ['sourceArea', 'leafArea']) if (!Number.isFinite(audit[key]) || audit[key] <= 0) errors.push(`controlled v4 audit ${key} is invalid`);
        if (!Array.isArray(audit.coordinateOrigin) || audit.coordinateOrigin.length !== 3 || audit.coordinateOrigin.some((value) => !Number.isFinite(value))) errors.push('controlled v4 coordinate origin is invalid');
        const agreement = audit.numericalAgreement;
        for (const key of ['source', 'leaves']) {
          const item = agreement?.[key];
          if (!item || ['areaRelativeDelta', 'firstMomentRelativeDelta', 'secondMomentRelativeDelta', 'maximumRelativeDelta'].some((metric) => !Number.isFinite(item[metric]) || item[metric] < 0 || item[metric] > CONTROLLED_SURFACE_AUDIT_POLICY_V4.numericalAgreementLimit)) errors.push(`controlled v4 ${key} numerical agreement is invalid`);
        }
        if (!Number.isFinite(agreement?.maximumRelativeDelta)
          || agreement.maximumRelativeDelta < 0
          || agreement.maximumRelativeDelta > CONTROLLED_SURFACE_AUDIT_POLICY_V4.numericalAgreementLimit
          || Math.abs(agreement.maximumRelativeDelta - Math.max(agreement?.source?.maximumRelativeDelta ?? Infinity, agreement?.leaves?.maximumRelativeDelta ?? Infinity)) > Number.EPSILON) errors.push('controlled v4 aggregate numerical agreement is invalid');

        const maximumDistance = Math.max(audit.sourceToLeaves?.maximumDistance ?? Infinity, audit.leavesToSource?.maximumDistance ?? Infinity);
        const maximumReversed = Math.max(audit.sourceToLeaves?.reversedNormalFraction ?? Infinity, audit.leavesToSource?.reversedNormalFraction ?? Infinity);
        const normal = audit.areaRelativeDelta <= CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalAreaRelativeDeltaLimit;
        if (audit.acceptance !== (normal ? 'normal' : 'gray-zone')) errors.push('controlled v4 acceptance classification is invalid');
        if (normal) {
          if (audit.boundsDelta > audit.surfaceTolerance
            || audit.centroidDelta > audit.surfaceTolerance
            || audit.normalizedSecondMomentDelta > CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalNormalizedSecondMomentDeltaLimit
            || maximumDistance > audit.surfaceTolerance
            || maximumReversed > CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalMaximumReversedNormalFraction) errors.push('controlled v4 normal surface evidence exceeds policy');
        } else {
          const spatialLimit = audit.surfaceTolerance * CONTROLLED_SURFACE_AUDIT_POLICY_V4.graySpatialToleranceFraction;
          if (audit.areaRelativeDelta > CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayAreaRelativeDeltaLimit
            || audit.boundsDelta > spatialLimit
            || audit.centroidDelta > spatialLimit
            || audit.normalizedSecondMomentDelta > CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayNormalizedSecondMomentDeltaLimit
            || maximumDistance > spatialLimit
            || maximumReversed > CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayMaximumReversedNormalFraction) errors.push('controlled v4 gray-zone evidence exceeds policy');
        }
      }
    }
    if (!/^[a-f0-9]{64}$/i.test(String(audit.equivalenceSha256 || ''))) {
      errors.push('audit.equivalenceSha256 must be a SHA-256 digest');
    }
    if (!Array.isArray(audit.artifacts) || audit.artifacts.length < 2
      || audit.artifacts.length > MAX_AUDIT_ARTIFACTS) {
      errors.push(`audit.artifacts must bind the tileset and between 1 and ${MAX_AUDIT_ARTIFACTS} leaf/dependency files`);
    }
  }

  if (errors.length === 0) {
    try {
      const actualDigest = await sha256File(fullMeshPath);
      if (actualDigest !== provenance.sourceSha256.toLowerCase()) {
        errors.push('sourceSha256 does not match the selected full-resolution mesh');
      }
    } catch (error) {
      errors.push(`cannot hash full-resolution mesh: ${error.message}`);
    }
  }

  if (errors.length === 0) {
    const derivativeDir = path.resolve(path.dirname(manifestPath));
    const seen = new Set();
    for (const artifact of audit.artifacts) {
      const uri = typeof artifact?.uri === 'string' ? artifact.uri : '';
      const artifactPath = path.resolve(derivativeDir, uri);
      const relative = path.relative(derivativeDir, artifactPath);
      const canonicalUri = relative.split(path.sep).join('/');
      if (!uri || path.isAbsolute(uri) || relative.startsWith('..') || path.isAbsolute(relative)
        || uri.includes('\\') || uri !== canonicalUri) {
        errors.push(`audit artifact path is invalid (${uri || '<empty>'})`);
        continue;
      }
      if (seen.has(uri)) {
        errors.push(`audit artifact is duplicated (${uri})`);
        continue;
      }
      seen.add(uri);
      if (!/^[a-f0-9]{64}$/i.test(String(artifact.sha256 || ''))) {
        errors.push(`audit artifact digest is invalid (${uri})`);
        continue;
      }
      if (!Number.isInteger(artifact.byteLength) || artifact.byteLength < 1) {
        errors.push(`audit artifact byteLength is invalid (${uri})`);
        continue;
      }
      try {
        const stat = await fs.promises.stat(artifactPath);
        if (!stat.isFile() || stat.size !== artifact.byteLength) {
          errors.push(`audit artifact size changed (${uri})`);
          continue;
        }
        const actualDigest = await sha256File(artifactPath);
        if (actualDigest !== artifact.sha256.toLowerCase()) errors.push(`audit artifact digest changed (${uri})`);
      } catch (error) {
        errors.push(`cannot verify audit artifact ${uri}: ${error.message}`);
      }
    }
    if (!seen.has('tileset.json')) errors.push('audit.artifacts must bind tileset.json');
  }

  if (errors.length === 0 && controlledV4) {
    const {
      algorithm: _algorithm,
      policy,
      equivalenceSha256: _equivalenceSha256,
      artifacts,
      ...surfaceEvidence
    } = audit;
    const expectedEquivalenceSha256 = crypto
      .createHash('sha256')
      .update(stable({
        sourceSha256: provenance.sourceSha256,
        converter: provenance.converter,
        policy,
        surfaceEvidence,
        artifacts,
      }))
      .digest('hex');
    if (audit.equivalenceSha256.toLowerCase() !== expectedEquivalenceSha256) {
      errors.push('controlled v4 equivalence digest does not bind the supplied policy and evidence');
    }
  }

  const sanitized = errors.length === 0 ? {
    schemaVersion: provenance.schemaVersion,
    sourceAsset: provenance.sourceAsset,
    sourceSha256: provenance.sourceSha256.toLowerCase(),
    geometry: expectedGeometry,
    textures: expectedTextures,
    leafGeometricError: 0,
    audit: {
      algorithm: audit.algorithm,
      ...(exactV2 ? {
        coordinateTolerance: audit.coordinateTolerance,
        maxNumericDelta: audit.maxNumericDelta,
        triangleCount: audit.triangleCount,
        leafTriangleCount: audit.leafTriangleCount ?? audit.triangleCount,
        duplicateLeafTriangleCount: audit.duplicateLeafTriangleCount ?? 0,
      } : {
        sourceTriangleCount: audit.sourceTriangleCount,
        leafTriangleCount: audit.leafTriangleCount,
        surfaceTolerance: audit.surfaceTolerance,
        maximumSurfaceDistance: Math.max(audit.sourceToLeaves.maximumDistance, audit.leavesToSource.maximumDistance),
        minimumNormalDot: Math.min(audit.sourceToLeaves.minimumNormalDot, audit.leavesToSource.minimumNormalDot),
        maximumReversedNormalFraction: Math.max(audit.sourceToLeaves.reversedNormalFraction, audit.leavesToSource.reversedNormalFraction),
        ...(controlledV4 ? {
          acceptance: audit.acceptance,
          policyRevision: audit.policy.revision,
          policy: { ...audit.policy },
          accumulationMethod: audit.accumulationMethod,
          areaRelativeDelta: audit.areaRelativeDelta,
          boundsDelta: audit.boundsDelta,
          centroidDelta: audit.centroidDelta,
          normalizedSecondMomentDelta: audit.normalizedSecondMomentDelta,
          sourceArea: audit.sourceArea,
          leafArea: audit.leafArea,
          sourceDegenerateTriangleCount: audit.sourceDegenerateTriangleCount,
          leafDegenerateTriangleCount: audit.leafDegenerateTriangleCount,
          numericalAgreement: structuredClone(audit.numericalAgreement),
          sourceToLeaves: {
            sampleCount: audit.sourceToLeaves.sampleCount,
            maximumDistance: audit.sourceToLeaves.maximumDistance,
            minimumNormalDot: audit.sourceToLeaves.minimumNormalDot,
            reversedNormalSampleCount: audit.sourceToLeaves.reversedNormalSampleCount,
            reversedNormalFraction: audit.sourceToLeaves.reversedNormalFraction,
          },
          leavesToSource: {
            sampleCount: audit.leavesToSource.sampleCount,
            maximumDistance: audit.leavesToSource.maximumDistance,
            minimumNormalDot: audit.leavesToSource.minimumNormalDot,
            reversedNormalSampleCount: audit.leavesToSource.reversedNormalSampleCount,
            reversedNormalFraction: audit.leavesToSource.reversedNormalFraction,
          },
        } : {}),
      }),
      equivalenceSha256: audit.equivalenceSha256.toLowerCase(),
      artifactCount: audit.artifacts.length,
    },
    ...(controlled ? { converter: {
      name: provenance.converter.name,
      version: provenance.converter.version,
      commandSha256: provenance.converter.commandSha256,
      inputAsset: provenance.converter.inputAsset,
      inputSha256: provenance.converter.inputSha256.toLowerCase(),
      binarySha256: provenance.converter.binarySha256.toLowerCase(),
    } } : {}),
  } : null;
  const artifacts = errors.length === 0 ? audit.artifacts.map((artifact) => ({
    uri: artifact.uri,
    sha256: artifact.sha256.toLowerCase(),
    byteLength: artifact.byteLength,
  })) : null;
  return { verified: errors.length === 0, errors, provenance: sanitized, artifacts };
}

module.exports = { sha256File, verifyLodProvenance };
