'use strict';

const { MeasurementSourceUnitEvidence } = require('./measurementSourceUnitEvidence');

// These failures make a source unsuitable for measurements, but do not prevent
// importing it for display. Integrity, cancellation and I/O failures propagate.
const unresolvedMetadata = new Set([
  'measurement_source_vertical_units_required',
  'measurement_source_vertical_units_unsupported',
  'measurement_source_vertical_units_conflict',
  'measurement_source_vertical_metadata_invalid',
  'measurement_source_value_transform_unsupported',
  'measurement_source_crs_mismatch',
  'measurement_raster_metadata_limit',
  'native_point_metadata_invalid',
  'native_point_metadata_unsupported',
  'native_point_metadata_conflict',
  'native_point_metadata_limit',
]);

async function inspectRegisteredSourceUnits({ repository, storage, modelId, modelVersionId, signal = null }) {
  const { inspectExplicitSourceUnits } = await import('./explicitSourceUnitInspection.mjs');
  const { inspectNativePointUnits } = await import('./nativePointUnitInspection.mjs');
  const model = repository.getModelVersion(modelId, modelVersionId);
  const pending = [];
  for (const source of model?.activeVersion?.assets || []) {
    if (!['dsm', 'dtm', 'ept', 'pointCloud'].includes(source.kind)) continue;
    signal?.throwIfAborted();
    const absolutePath = storage.resolve(source.rootKey, source.relativePath, { mustExist: true });
    let inspection;
    try {
      const inspect = source.kind === 'pointCloud' ? inspectNativePointUnits : inspectExplicitSourceUnits;
      inspection = await inspect(absolutePath, source, { signal: signal || undefined });
    }
    catch (error) { if (unresolvedMetadata.has(error.code) || (source.kind === 'ept' && error instanceof SyntaxError)) continue; throw error; }
    if (inspection?.originalUnit != null && inspection.verticalFactor != null) pending.push({ request: { modelId, modelVersionId, source, coordinateReference: { crs: inspection.crs } }, inspection });
  }
  return pending;
}

async function recordImportedSourceUnits(operation, { processing, repository, storage }, modelId, versionId, { signal = null } = {}) {
  const pending = await inspectRegisteredSourceUnits({ repository, storage, modelId, modelVersionId: versionId, signal });
  // Inspection awaits file reads. Recheck authority only after those reads, and
  // hold the same database transaction across the check and all evidence writes.
  return processing.transaction(() => {
    signal?.throwIfAborted();
    const live = processing.database.prepare(`SELECT 1 FROM dataset_operations
      WHERE id=? AND operation_type='catalog_map' AND status='leased'
      AND lease_owner=? AND lease_expires_at>?`).get(operation.id, operation.lease_owner, new Date().toISOString());
    if (!live) throw Object.assign(new Error('import lease was lost before unit evidence persistence'), { code: 'operation_lease_lost' });
    const registry = new MeasurementSourceUnitEvidence(processing.database);
    return pending.map(({ request, inspection }) => registry.recordExplicitMetadata(request, inspection));
  });
}

module.exports = { inspectRegisteredSourceUnits, recordImportedSourceUnits };
