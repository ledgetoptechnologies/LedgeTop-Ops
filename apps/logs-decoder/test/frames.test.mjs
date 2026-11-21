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
  aircraftName: 'Matrice 30T', aircraftSn: 'SECRET-SERIAL', appPlatform: 'Android', appVersion: '19.1.0' }, frames });

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

const NOW = Date.UTC(2026, 10, 20, 12);

test('the summary comes from the log itself and never carries serials or a pilot', () => {
  const frames = [0, 1, 2, 3, 4, 5].map(i => frame(i, { video: i === 1 || i === 2 || i === 5 }));
  const { summary } = toFlight({ ...output(frames), header: { startTime: '2026-11-13T05:36:14+00:00', productType: 'Matrice30T' } }, { now: NOW });
  assert.deepEqual(summary, {
    started_at: '2026-11-13T05:36:14.000Z', ended_at: '2026-11-13T05:56:53.400Z', started_at_source: 'log_header', duration_seconds: 1239.4,
    distance_m: 6.8, max_altitude_m: 61.2, max_speed_mps: 12.35, home_lat: 45, home_lon: -93, photo_count: 4, photo_count_source: 'log_header',
    video_count: 2, telemetry_points: 6, aircraft_model: 'Matrice30T', app: 'Android 19.1.0',
  });
  assert.equal(JSON.stringify(summary).includes('SECRET'), false);
});

// A synthetic flight shaped like the Matrice 4E logs that showed the bugs: 10 Hz frames; a per-frame clock that is
// right only in a few short runs and otherwise holds random years (1970 to 2099); a header totalDistance in
// kilometres; a header photo count with no per-frame photo flags. Positions fly a straight 5 m/s line east.
const START = Date.UTC(2026, 10, 20, 16, 29, 45, 700);
const GARBLED = ['1970-01-01T00:00:00Z', '2011-04-02T08:15:00Z', '2099-12-30T23:00:00Z', '2025-03-23T10:52:07Z', '2031-06-01T00:00:00Z'];
const M_PER_DEG_LON_AT_45 = 6_371_008.8 * Math.PI / 180 * Math.cos(45 * Math.PI / 180);
function m4eLike({ seconds = 600, realRuns = [[1, 40], [3000, 3040]], firstStampFrozen = false, header = {} } = {}) {
  const frames = [];
  for (let i = 0; i <= seconds * 10; i++) {
    const flyTime = i / 10, real = realRuns.some(([from, to]) => i >= from && i < to);
    // The real clock updates every 2 s and holds in between (stamps lag true time, never lead it).
    const held = Math.floor(flyTime / 2) * 2000, stamp = firstStampFrozen ? realRuns[0][0] / 10 * 1000 : held;
    frames.push({
      custom: { dateTime: real ? new Date(START + stamp).toISOString() : GARBLED[Math.floor(i / 250) % GARBLED.length] },
      osd: { flyTime, latitude: 45, longitude: -93 + (5 * flyTime) / M_PER_DEG_LON_AT_45, height: 50 },
      camera: { isPhoto: false, isVideo: false },
    });
  }
  return { version: 14, details: { totalTime: seconds, totalDistance: (5 * seconds) / 1000, maxHeight: 50, maxHorizontalSpeed: 5,
    photoNum: 800, aircraftName: 'MATRICE 4E', appPlatform: 'Android', appVersion: '19.1.0', ...header }, frames };
}

test('garbled frame clock: start and end come from agreeing real stamps plus the duration, never the min and max year', () => {
  const { summary } = toFlight(m4eLike(), { now: NOW });
  assert.equal(summary.started_at_source, 'frame_clock');
  assert.ok(Math.abs(Date.parse(summary.started_at) - START) <= 2000, `start ${summary.started_at}`);
  assert.equal(Date.parse(summary.ended_at) - Date.parse(summary.started_at), 600_000, 'end = start + duration');
  for (const at of [summary.started_at, summary.ended_at]) assert.equal(at.slice(0, 10), '2026-11-20');
});

test('the header start time wins over the frame clock, and an implausible header falls back', () => {
  const log = { ...m4eLike(), header: { startTime: '2026-11-20T16:29:45.740+00:00', productType: 'Unknown(99)' } };
  assert.deepEqual(Object.entries(toFlight(log, { now: NOW }).summary).filter(([k]) => /^(started|ended)_at/.test(k)),
    [['started_at', '2026-11-20T16:29:45.740Z'], ['ended_at', '2026-11-20T16:39:45.740Z'], ['started_at_source', 'log_header']]);
  for (const bad of ['2099-12-30T23:00:00Z', '2011-04-02T08:15:00Z', 'not a date', '2026-11-25T00:00:00Z'])
    assert.equal(toFlight({ ...log, header: { startTime: bad } }, { now: NOW }).summary.started_at_source, 'frame_clock', bad);
});

test('one held stamp alone (a garbled run looks the same) is not trusted: no date rather than a wrong one', () => {
  const { summary } = toFlight(m4eLike({ realRuns: [[3, 99]], firstStampFrozen: true }), { now: NOW });
  for (const key of ['started_at', 'ended_at', 'started_at_source']) assert.equal(key in summary, false, key);
  assert.equal(summary.duration_seconds, 600);
});

test('no plausible clock at all: no dates', () => {
  const { summary } = toFlight(m4eLike({ realRuns: [] }), { now: NOW });
  assert.equal('started_at' in summary, false);
});

test('distance is the path over the fixes (header km value ignored), within 0.5% of the flown 3,000 m', () => {
  const { summary } = toFlight(m4eLike(), { now: NOW });
  assert.ok(Math.abs(summary.distance_m - 3000) / 3000 < 0.005, `distance ${summary.distance_m}`);
});

test('a position glitch (a jump no aircraft could fly) is not added to the distance', () => {
  const log = m4eLike({ seconds: 60 });
  log.frames[300].osd.latitude = 46; // ~111 km away for one frame, then back
  const { summary } = toFlight(log, { now: NOW });
  assert.ok(Math.abs(summary.distance_m - 300) < 2, `distance ${summary.distance_m}`);
});

test('photo count: header first; the single-photo flag only as a fallback, merged within 1.5 s; the method is recorded', () => {
  const withFlags = header => {
    const log = m4eLike({ seconds: 60, header });
    for (const i of [100, 110, 400]) log.frames[i].camera.isPhoto = true; // one shot seen twice 1 s apart, then another
    return toFlight(log, { now: NOW }).summary;
  };
  assert.deepEqual([withFlags({}).photo_count, withFlags({}).photo_count_source], [800, 'log_header'], 'flags never add to the header');
  assert.deepEqual([withFlags({ photoNum: 0 }).photo_count, withFlags({ photoNum: 0 }).photo_count_source], [2, 'camera_flag']);
  const none = toFlight(m4eLike({ seconds: 60, header: { photoNum: 0 } }), { now: NOW }).summary;
  assert.deepEqual(['photo_count' in none, none.photo_count_source], [false, 'unknown'], 'zero in the header means not recorded');
  for (const bad of [-1, 2.5, 1e6, 60 * 20 + 1])
    assert.equal(withFlags({ photoNum: bad }).photo_count_source, 'camera_flag', String(bad));
});

test('aircraft model: the parser product type when known, else the name the app wrote', () => {
  assert.equal(toFlight(m4eLike({ seconds: 5 }), { now: NOW }).summary.aircraft_model, 'MATRICE 4E');
  assert.equal(toFlight({ ...m4eLike({ seconds: 5 }), header: { productType: 'Unknown(99)' } }, { now: NOW }).summary.aircraft_model, 'MATRICE 4E');
  assert.equal(toFlight({ ...m4eLike({ seconds: 5 }), header: { productType: 'Mavic3Enterprise' } }, { now: NOW }).summary.aircraft_model, 'Mavic3Enterprise');
  assert.equal(toFlight(m4eLike({ seconds: 5 }), { now: NOW }).summary.app, 'Android 19.1.0');
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
