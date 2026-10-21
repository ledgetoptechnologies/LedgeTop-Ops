'use strict';
// One server-owned registry shared by calculation and authorized display config.
const county = Object.freeze({
  id: 'county-road-d-webodm-reference-2026-09-22',
  modelId: '9322ab51-dbb3-44f8-ae6f-b170c6fbd48c',
  modelVersionId: '7400b8ba-68f2-4c8c-b19c-3572b98e86f6',
  assetId: '207914cd-bff7-426e-8535-b2e43403a1b4',
  sha256: '0265277ff9c34805e2de4aff20cf568bf36d5a205423f6b0c39631880be7f514',
  byteSize: 556007817,
  kind: 'dsm', crs: 'EPSG:32616', width: 19229, height: 21580,
  verticalUnit: 'm', verticalDatum: 'unknown',
  reportSha256: '4684491d9c720dec0c5e4d5ebb6a3498bc32b3cb168ac56ea6020626d2a656c1',
  basis: 'reviewed-source-provenance',
});
function reviewedAssetUnitEvidence(modelId, modelVersionId, source) {
  return source && modelId === county.modelId && modelVersionId === county.modelVersionId &&
    source.id === county.assetId && source.kind === county.kind && source.sha256 === county.sha256 &&
    Number(source.byteSize) === county.byteSize ? county : null;
}
module.exports = { reviewedAssetUnitEvidence };
