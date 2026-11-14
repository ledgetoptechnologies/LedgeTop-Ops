// Mapping from dji-log-parser output to the Ledge Top track and summary. Synthetic frames only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toFlight, TRACK_SCHEMA } from '../src/frames.mjs';

// Shape as written by `dji-log <file>` (dji-log-parser v0.5.7): camelCase, { version, details, frames }.
function frame(i, { video = false, noFix = false } = {}) {
  return {
    custom: { dateTime: new Date(Date.UTC(2026, 10, 13, 5, 36, 14) + i * 100).toISOString() },
    osd: { flyTime: i * 0.1, latitude: noFix ? 0 : 45 + i * 1e-5, longitude: noFix ? 0 : -93 - i * 1e-5, height: i * 0.5, vpsHeight: 0, altitude: 250 + i * 0.5,
      xSpeed: 3, ySpeed: 4, zSpeed: -0.5, pitch: 1.23, roll: -0.5, yaw: 90, gpsNum: 18, gpsLevel: 5, flycState: 'GPSAtti' },
    gimbal: { pitch: -90, roll: 0, yaw: 90 },
    camera: { isPhoto: i === 3, isVideo: video },
    battery: { chargeLevel: 100 - i, voltage: 16.123456, current: -5.5, temperature: 30.04, fullCapacity: 5000, currentCapacity: 4900 - i },
    home: { latitude: noFix ? 0 : 45, longitude: noFix ? 0 : -93, altitude: 250 },
  };
}
const output = frames => ({ version: 14, details: { totalTime: 1239.4, totalDistance: 2100.46, maxHeight: 61.24, maxHorizontalSpeed: 12.345, photoNum: 4,
  aircraftName: 'Matrice 30T', aircraftSn: 'SECRET-SERIAL' }, frames });

test('frames become a columnar track in the same names ODL imports use, with units kept', () => {
  const { track } = toFlight(output([0, 1, 2, 3, 4].map(i => frame(i))));
  assert.equal(track.schema, TRACK_SCHEMA);
  assert.equal(track.rowCount, 5);
  assert.deepEqual(track.columns.offsetMs, [0, 100, 200, 300, 400]);
  assert.equal(track.columns.latitude[1], 45.00001);
  assert.equal(track.columns.speedMetersPerSecond[0], 5, 'horizontal speed from x and y');
  assert.equal(track.columns.altitudeAbsMeters[0], 250);
  assert.equal(track.columns.heightMeters[2], 1);
  assert.equal(track.columns.batteryPercent[4], 96);
  assert.equal(track.columns.batteryVoltage[0], 16.123);
  assert.deepEqual(track.columns.isPhoto, [false, false, false, true, false]);
  assert.equal(track.columns.flightMode[0], 'GPSAtti');
  assert.equal('vpsHeightMeters' in track.columns, true, 'zero is a reading, not missing');
  for (const values of Object.values(track.columns)) assert.equal(values.length, 5, 'every column has one value per row');
});

test('the summary comes from the log itself and never carries serials, names or a pilot', () => {
  const frames = [0, 1, 2, 3, 4, 5].map(i => frame(i, { video: i === 1 || i === 2 || i === 5 }));
  const { summary } = toFlight(output(frames));
  assert.deepEqual(summary, {
    started_at: '2026-11-13T05:36:14.000Z', ended_at: '2026-11-13T05:36:14.500Z', duration_seconds: 1239.4, distance_m: 2100.5,
    max_altitude_m: 61.2, max_speed_mps: 12.35, home_lat: 45, home_lon: -93, photo_count: 4, video_count: 2, telemetry_points: 6,
  });
  assert.equal(JSON.stringify(summary).includes('SECRET'), false);
});

test('no position fix is stored as missing, not as 0,0; the home point falls back to the first real fix', () => {
  const frames = [frame(0, { noFix: true }), frame(1, { noFix: true }), { ...frame(2), home: { latitude: 0, longitude: 0 } }];
  const { track, summary } = toFlight(output(frames));
  assert.deepEqual(track.columns.latitude, [null, null, 45.00002]);
  assert.deepEqual([summary.home_lat, summary.home_lon], [45.00002, -93.00002]);
});

test('columns a log never fills are left out; odd values are dropped, not invented', () => {
  const frames = [{ osd: { flyTime: 0, latitude: 'x', longitude: null, height: Number.NaN } }, { osd: { flyTime: 0.1 } }];
  const { track, summary } = toFlight({ details: { totalTime: -5, photoNum: 2.5 }, frames });
  assert.deepEqual(Object.keys(track.columns), ['offsetMs']);
  assert.equal(summary.duration_seconds, 0.1, 'falls back to the last flight time when the total is invalid');
  assert.equal('photo_count' in summary, false);
  assert.equal('started_at' in summary, false, 'no valid clock, no start time');
});

test('output without frames is a corrupt log', () => {
  for (const bad of [null, {}, { frames: 'x' }, { frames: [] }])
    assert.throws(() => toFlight(bad), error => error.code === 'corrupt_log');
});
