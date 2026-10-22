// Read-only offline comparison. No server jobs, source changes, unit override,
// database writes or implicit download. Caller supplies the original DSM path.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createUtmProjection } from '../utm-conversion.mjs';
import { calculateNativeRaster } from '../server/measurementRasterCalculation.mjs';

export const countyReference = JSON.parse(fs.readFileSync(new URL('../test/fixtures/county-road-d-webodm-reference.json', import.meta.url), 'utf8'));
export function countyReferenceRequest(collection = 'map') {
  if (!['map', 'spatial3d'].includes(collection)) throw new Error('Unknown collection');
  const projection = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
  return {
    modelId: countyReference.modelId,
    modelVersionId: countyReference.modelVersionId,
    collection,
    coordinateReference: { crs: countyReference.crs },
    source: { ...countyReference.source },
    // Height comes from the bound DSM, never these placeholder view heights.
    vertices: countyReference.ringLonLat.slice(0, -1).map(([lon, lat]) => [...projection.latLonToUtm(lat, lon), 0]),
    reference: { type: 'boundary-triangulated' },
  };
}
export function compareCountyResult(result, toleranceM3 = null) {
  if (!Number.isFinite(result.netM3)) throw new Error('Result has no finite net volume');
  if (toleranceM3 !== null && (!Number.isFinite(toleranceM3) || toleranceM3 < 0)) throw new Error('Tolerance must be a nonnegative finite number');
  const volume = Math.abs(result.netM3), expected = countyReference.expectedAbsoluteNetVolumeM3;
  const differenceM3 = volume - expected;
  return {
    referenceVolumeM3: expected,
    actualAbsoluteNetM3: volume,
    differenceM3,
    differencePercent: differenceM3 / expected * 100,
    toleranceM3,
    numericalAgreement: toleranceM3 === null ? 'not-evaluated-no-tolerance-specified' : Math.abs(differenceM3) <= toleranceM3 ? 'within-tolerance' : 'outside-tolerance',
    note: 'WebODM returns absolute signed net volume; do not compare its scalar to gross cut alone. Agreement is not independent field accuracy validation.',
  };
}
async function main() {
  const [file, toleranceText, collection = 'map'] = process.argv.slice(2);
  if (!file) throw new Error('Usage: node scripts/validate-county-stockpile-reference.mjs <original-dsm.tif> [tolerance-m3] [map|spatial3d]');
  const tolerance = toleranceText === undefined ? null : Number(toleranceText);
  if (tolerance !== null && (!Number.isFinite(tolerance) || tolerance < 0)) throw new Error('Invalid tolerance');
  const started = Date.now();
  const result = await calculateNativeRaster(path.resolve(file), countyReferenceRequest(collection));
  const comparison = compareCountyResult(result, tolerance);
  const { preview, ...summary } = result;
  console.log(JSON.stringify({ collection, elapsedMs: Date.now() - started, comparison, result: summary,
    preview: { sampleCount: preview?.samples?.length || 0, referencePatchCount: preview?.referencePatches?.length || 0 } }, null, 2));
  if (comparison.numericalAgreement === 'outside-tolerance') process.exitCode = 1;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(JSON.stringify({ error: error.code || error.message })); process.exitCode = 1; });
}
