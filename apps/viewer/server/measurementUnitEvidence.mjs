// Reviewed server-owned provenance, not browser assertions or a default for
// untagged imports. Worker hashing binds this evidence to the actual raster.
import registry from './measurementUnitEvidence.js';
import sourceRegistry from './measurementSourceUnitEvidence.js';

export function reviewedRasterUnitEvidence(request, image) {
  const persisted = sourceRegistry.matchedSourceUnitEvidence(request);
  if (persisted && ['dsm', 'dtm'].includes(request.source.kind)) return sourceRegistry.sourceUnitDisplayEvidence(persisted);
  const source = request?.source;
  const county = registry.reviewedAssetUnitEvidence(request?.modelId, request?.modelVersionId, source);
  if (!county || request.coordinateReference?.crs !== county.crs ||
      image.getWidth() !== county.width || image.getHeight() !== county.height) return null;
  return county;
}
