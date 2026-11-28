// Checkpoint accuracy against the processed DSM. Synthetic points and rasters only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { writeArrayBuffer } from 'geotiff';
import { createUtmProjection } from '../utm-conversion.mjs';
import { checkpointReport } from '../server/gcpCheckpointReport.mjs';

const zone16 = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });

// A 6 x 6, 1 m DSM whose top-left corner sits 3 m west and 3 m north of (lat, lon).
function dsmAround(t, lat, lon, values, extra = {}) {
  const [e, n] = zone16.latLonToUtm(lat, lon);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gcp-checkpoints-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'dsm.tif');
  fs.writeFileSync(file, Buffer.from(writeArrayBuffer(new Float32Array(values), {
    width: 6, height: 6, ModelPixelScale: [1, 1, 0], ModelTiepoint: [0, 0, 0, e - 3, n + 3, 0],
    ProjectedCSTypeGeoKey: 32616, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1, ...extra,
  })));
  return file;
}

const point = (externalId, latitude, longitude, elevationM) => ({ externalId, label: externalId, latitude, longitude, elevationM, marks: [{ image: 'a.jpg', pixelX: 1, pixelY: 1 }] });

test('vertical residual is DSM minus surveyed NAVD88 elevation, with RMSE over the points inside the DSM', async (t) => {
  const file = dsmAround(t, 44.5, -89.5, new Array(36).fill(250));
  const report = await checkpointReport({ checkpoints: [point('CHK1', 44.5, -89.5, 249.97), point('CHK2', 44.50001, -89.50001, 250.05), point('FAR', 44.6, -89.5, 250)], dsmPath: file });
  const byId = Object.fromEntries(report.points.map((row) => [row.externalId, row]));
  assert.ok(Math.abs(byId.CHK1.dzM - 0.03) < 1e-4, JSON.stringify(byId.CHK1));
  assert.ok(Math.abs(byId.CHK2.dzM + 0.05) < 1e-4);
  assert.equal(byId.CHK1.status, 'measured');
  assert.equal(byId.FAR.status, 'outside_dsm');
  assert.equal(byId.FAR.dzM, null);
  assert.equal(report.summary.measuredCount, 2);
  assert.ok(Math.abs(report.summary.rmseZM - Math.sqrt((0.03 ** 2 + 0.05 ** 2) / 2)) < 1e-4);
  assert.ok(Math.abs(report.summary.meanZM - (-0.01)) < 1e-4);
  assert.ok(Math.abs(report.summary.maxAbsZM - 0.05) < 1e-4);
  assert.equal(report.summary.horizontal, 'not_measured');
  assert.equal(report.dsm.crs, 'EPSG:32616');
});

test('bilinear sampling follows a sloped DSM between pixel centres', async (t) => {
  // Each column is 0.1 m higher than the one to its west.
  const values = []; for (let row = 0; row < 6; row += 1) for (let col = 0; col < 6; col += 1) values.push(250 + col * 0.1);
  const file = dsmAround(t, 44.5, -89.5, values);
  const report = await checkpointReport({ checkpoints: [point('CHK1', 44.5, -89.5, 250.3)], dsmPath: file });
  // The point is exactly 3 m east of the west edge: between centres 2.5 (250.2) and 3.5 (250.3), halfway.
  assert.ok(Math.abs(report.points[0].dsmZM - 250.25) < 1e-3, JSON.stringify(report.points[0]));
});

test('nodata around a checkpoint is reported, not guessed', async (t) => {
  const file = dsmAround(t, 44.5, -89.5, new Array(36).fill(-9999), { GDAL_NODATA: '-9999' });
  const report = await checkpointReport({ checkpoints: [point('CHK1', 44.5, -89.5, 250)], dsmPath: file });
  assert.equal(report.points[0].status, 'no_dsm_value');
  assert.equal(report.summary.measuredCount, 0);
  assert.equal(report.summary.rmseZM, null);
});

test('DSM heights in US survey feet are converted to metres', async (t) => {
  const file = dsmAround(t, 44.5, -89.5, new Array(36).fill(820), { VerticalUnitsGeoKey: 9003 });
  const report = await checkpointReport({ checkpoints: [point('CHK1', 44.5, -89.5, 820 * 1200 / 3937)], dsmPath: file });
  assert.ok(Math.abs(report.points[0].dzM) < 1e-4);
});

test('a DSM that is not WGS84 UTM is refused', async (t) => {
  const file = dsmAround(t, 44.5, -89.5, new Array(36).fill(250), { ProjectedCSTypeGeoKey: 6610 });
  await assert.rejects(checkpointReport({ checkpoints: [point('CHK1', 44.5, -89.5, 250)], dsmPath: file }), { code: 'checkpoint_report_crs_unsupported' });
});
