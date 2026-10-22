'use strict';

// Increment only when a shipped validator/converter revision makes it safe and
// useful to revisit terminal LOD work created by an older release. New jobs and
// jobs first leased by this release are stamped at this revision, so ordinary
// failures do not acquire an extra automatic retry.
const LOD_DERIVATIVE_RECOVERY_REVISION = 2;

function isLodDerivativeType(type) {
  return type === 'mesh_tiles' || type === 'lod_audit';
}

function isHeavyDerivativeType(type) {
  return type === 'ept' || isLodDerivativeType(type);
}

module.exports = { LOD_DERIVATIVE_RECOVERY_REVISION, isHeavyDerivativeType, isLodDerivativeType };
