const REVISION_PATTERN = /^[0-9a-f]{40}$/;
const SCHEMA_PATTERN = /^[1-9][0-9]*$/;

export function validateRuntimeProbeHeaders({ healthHeaders, readyHeaders, expectedSchemaVersion, bakedRevision = null }) {
  if (healthHeaders.get('cache-control') !== 'no-store' || readyHeaders.get('cache-control') !== 'no-store')
    return 'health and readiness must both return Cache-Control: no-store';
  const healthRevision = healthHeaders.get('x-ltds-viewer-revision');
  const readyRevision = readyHeaders.get('x-ltds-viewer-revision');
  if (!healthRevision || healthRevision !== readyRevision || !(REVISION_PATTERN.test(healthRevision) || healthRevision === 'unavailable'))
    return 'health and readiness do not agree on a valid Viewer revision';
  const healthSchema = healthHeaders.get('x-ltds-viewer-schema-version');
  const readySchema = readyHeaders.get('x-ltds-viewer-schema-version');
  if (!healthSchema || healthSchema !== readySchema || !SCHEMA_PATTERN.test(healthSchema))
    return 'health and readiness do not agree on a valid Viewer schema version';
  if (!Number.isSafeInteger(expectedSchemaVersion) || expectedSchemaVersion < 1 || Number(healthSchema) !== expectedSchemaVersion)
    return `served Viewer schema version ${healthSchema} does not match expected schema version ${expectedSchemaVersion}`;
  if (bakedRevision && healthRevision !== bakedRevision)
    return 'served Viewer revision does not match the immutable runtime source identity';
  return null;
}
