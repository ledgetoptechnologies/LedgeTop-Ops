'use strict';

// V2 carries retained-source, derived-source, and pipeline manifests together.
// Keep its bounds separate from the smaller V1 prepared-envelope protocol.
const MAX_SOURCE_INTAKE_V2_METADATA_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_INTAKE_V2_CANONICAL_NODES = 300_000;
const MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS = 10_000;

module.exports = {
  MAX_SOURCE_INTAKE_V2_CANONICAL_NODES,
  MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
  MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS,
};
