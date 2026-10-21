import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeArrayBuffer } from 'geotiff';
import { nativeTiffFixture } from './helpers/native-tiff-fixture.mjs';
import { inspectProcessingRasterUnits } from '../server/processingRasterUnitInspection.mjs';

function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'processing-unit-inspection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'dsm.tif');
  const bytes = extra.GDAL_METADATA ? nativeTiffFixture({ verticalUnit: extra.VerticalUnitsGeoKey ?? null, gdalMetadata: extra.GDAL_METADATA }) : Buffer.from(writeArrayBuffer(Float64Array.from([1, 2, 3, 4]), {
    width: 2, height: 2, ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, 0, 2, 0],
    ProjectedCSTypeGeoKey: 32616, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ...extra,
  }));
  fs.writeFileSync(file, bytes);
  return { file, source: { byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } };
}
test('processing inspection distinguishes absent vertical units from explicit metres and feet', async t => {
  for (const [metadata, verticalUnit] of [[{}, null], [{ VerticalUnitsGeoKey: 9001 }, 'metre'], [{ VerticalUnitsGeoKey: 9002 }, 'other'], [{ VerticalUnitsGeoKey: 9003 }, 'other']]) {
    const f = fixture(t, metadata);
    assert.deepEqual(await inspectProcessingRasterUnits(f.file, f.source), { horizontalEpsg: 32616, verticalUnit });
  }
});
test('processing inspection cannot normalize unsupported metadata or value scaling to absence', async t => {
  for (const [metadata, code] of [
    [{ VerticalUnitsGeoKey: 9999 }, 'measurement_source_vertical_units_unsupported'],
    [{ VerticalUnitsGeoKey: 9001, GDAL_METADATA: '<GDALMetadata><Item name="UNITTYPE" sample="0">ft</Item></GDALMetadata>' }, 'measurement_source_vertical_units_conflict'],
    [{ GDAL_METADATA: '<GDALMetadata><Item name="SCALE" sample="0">2</Item></GDALMetadata>' }, 'measurement_source_value_transform_unsupported'],
  ]) {
    const f = fixture(t, metadata);
    await assert.rejects(inspectProcessingRasterUnits(f.file, f.source), { code });
  }
});
test('changed bytes and aborted checks do not yield unit evidence', async t => {
  const f = fixture(t), bytes = fs.readFileSync(f.file); bytes[bytes.length - 1] ^= 1; fs.writeFileSync(f.file, bytes);
  await assert.rejects(inspectProcessingRasterUnits(f.file, f.source), { code: 'source_changed' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(inspectProcessingRasterUnits(f.file, f.source, { signal: controller.signal }), { name: 'AbortError' });
});
test('horizontal CRS alone does not authorize an unsupported producer coordinate system', async t => {
  const f = fixture(t, { ProjectedCSTypeGeoKey: 3857 });
  assert.equal(await inspectProcessingRasterUnits(f.file, f.source), null);
});
