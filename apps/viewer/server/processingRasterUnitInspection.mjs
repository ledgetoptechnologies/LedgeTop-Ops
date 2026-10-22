import fs from 'node:fs';
import crypto from 'node:crypto';
import { fromFile } from 'geotiff';
import { validateMeasurementTiffHeader } from './measurementTiffHeader.mjs';
import { readRasterBandMetadata, resolveRasterVerticalUnits } from '../raster-vertical-units.mjs';

const changed = () => { throw Object.assign(new Error('Processing raster source changed'), { code: 'source_changed' }); };
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

// Reads physical metadata only. Absence remains null, never a metre assertion.
// Consumers still need independently verified producer evidence to fill that gap.
export async function inspectProcessingRasterUnits(absolutePath, source, { signal } = {}) {
  signal?.throwIfAborted();
  const before = await fs.promises.lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== source.byteSize) changed();
  const digest = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(absolutePath, { signal })) digest.update(bytes);
  if (digest.digest('hex') !== source.sha256) changed();
  await validateMeasurementTiffHeader(absolutePath);
  const tiff = await fromFile(absolutePath);
  let result;
  try {
    const image = await tiff.getImage(0), keys = image.getGeoKeys();
    const horizontalEpsg = Number(keys.ProjectedCSTypeGeoKey);
    // This producer contract is native UTM. Other horizontal coordinates need
    // their own contract, not inference from a display CRS.
    const utm = horizontalEpsg >= 32601 && horizontalEpsg <= 32660 || horizontalEpsg >= 32701 && horizontalEpsg <= 32760;
    if (!Number.isInteger(horizontalEpsg) || !utm ||
        keys.ProjLinearUnitsGeoKey != null && Number(keys.ProjLinearUnitsGeoKey) !== 9001 ||
        image.getSamplesPerPixel() !== 1) {
      return null;
    }
    const bandMetadata = await readRasterBandMetadata(image);
    let verticalUnit;
    try {
      const units = resolveRasterVerticalUnits(image, { bandMetadata });
      verticalUnit = units.verticalFactor === 1 ? 'metre' : 'other';
    } catch (error) {
      if (error.code !== 'measurement_source_vertical_units_required') throw error;
      verticalUnit = null;
    }
    result = { horizontalEpsg, verticalUnit };
  } finally {
    await tiff.close();
  }
  signal?.throwIfAborted();
  const after = await fs.promises.lstat(absolutePath);
  if (!after.isFile() || after.isSymbolicLink() || identity(before) !== identity(after)) changed();
  return result;
}
