import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fromFile } from 'geotiff';
import storage from './storageManager.js';
import { validateMeasurementTiffHeader } from './measurementTiffHeader.mjs';
import { readRasterBandMetadata, resolveRasterVerticalUnits } from '../raster-vertical-units.mjs';
import { inspectEptUtmCrs, resolveEptVerticalUnits } from './measurementEptCrs.mjs';

const changed = () => { throw Object.assign(new Error('Source changed during unit inspection'), { code: 'source_changed' }); };
const identity = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
const units = new Map([[1, 'm'], [0.3048, 'ft'], [1200 / 3937, 'us-ft'], [.01, 'cm'], [.001, 'mm'], [1000, 'km']]);

// Inspection reads physical metadata, never folder names, reports, display units
// or caller-provided declarations. Missing units remain unknown. This does not
// identify a vertical datum or establish accuracy.
export async function inspectExplicitSourceUnits(absolutePath, source, { signal } = {}) {
  signal = signal || undefined;
  if (!['dsm', 'dtm', 'ept'].includes(source?.kind)) return null;
  signal?.throwIfAborted();
  const before = await fs.promises.lstat(absolutePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size !== source.byteSize) changed();
  const digest = crypto.createHash('sha256');
  for await (const bytes of fs.createReadStream(absolutePath, { signal })) digest.update(bytes);
  if (digest.digest('hex') !== source.sha256) changed();
  let crs, resolved;
  try {
    if (source.kind === 'ept') {
      if (before.size > 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(source.manifestSha256 || '')) return null;
      const ept = JSON.parse(await fs.promises.readFile(absolutePath, 'utf8'));
      const epsg = inspectEptUtmCrs(ept.srs);
      resolved = resolveEptVerticalUnits(ept.srs, epsg);
      crs = `EPSG:${epsg}`;
      const tree = await storage.hashTree(path.dirname(absolutePath), { signal });
      if (tree.manifestSha256 !== source.manifestSha256) changed();
    } else {
      await validateMeasurementTiffHeader(absolutePath);
      const tiff = await fromFile(absolutePath);
      try {
        const image = await tiff.getImage(0), keys = image.getGeoKeys();
        const epsg = Number(keys.ProjectedCSTypeGeoKey);
        if (!Number.isInteger(epsg) || epsg < 1000 || epsg > 999999 || epsg === 32767 || image.getSamplesPerPixel() !== 1) return null;
        crs = `EPSG:${epsg}`;
        resolved = resolveRasterVerticalUnits(image, { bandMetadata: await readRasterBandMetadata(image) });
      } finally { await tiff.close(); }
    }
  } catch (error) {
    if (error.code === 'measurement_source_vertical_units_required') return null;
    throw error;
  }
  signal?.throwIfAborted();
  const after = await fs.promises.lstat(absolutePath);
  if (!after.isFile() || after.isSymbolicLink() || identity(before) !== identity(after)) changed();
  const originalUnit = units.get(resolved.verticalFactor);
  if (!originalUnit) return null;
  return { crs, originalUnit, verticalFactor: resolved.verticalFactor,
    metadataBasis: resolved.verticalUnitBasis, sha256: source.sha256,
    byteSize: source.byteSize, manifestSha256: source.manifestSha256 || '' };
}
