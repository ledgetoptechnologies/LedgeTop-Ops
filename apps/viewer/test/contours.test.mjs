import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTOUR_INTERVALS,
  METERS_PER_FOOT,
  autoContourInterval,
  buildContours,
  chaikin,
  chooseDemWindow,
  contourLevels,
  drawContours,
  formatContourLabel,
  placeLabels,
  simplifyLine,
  traceContours,
} from '../contours.mjs';
import { computeContourMessage } from '../contour-worker.mjs';
import { createUtmProjection } from '../utm-conversion.mjs';

const FT = METERS_PER_FOOT;
const grid = { minE: 500000, maxN: 4700000, cellE: 1, cellN: 1 };

// Cone: 260 ft at the centre, falling 1 ft per metre of radius.
function cone(size = 121, peakFt = 260) {
  const values = new Float32Array(size * size), c = (size - 1) / 2;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) values[y * size + x] = (peakFt - Math.hypot(x - c, y - c)) * FT;
  return { values, width: size, height: size, centre: [grid.minE + c + 0.5, grid.maxN - c - 0.5], peakFt };
}

test('levels are exact multiples of the interval in feet; every 5th is an index line with a ft label', () => {
  const { levels } = contourLevels(228.0, 246.0, 2, 'imperial');
  assert.deepEqual(levels.map(l => l.value), [750, 752, 754, 756, 758, 760, 762, 764, 766, 768, 770, 772, 774, 776, 778, 780, 782, 784, 786, 788, 790, 792, 794, 796, 798, 800, 802, 804, 806]);
  for (const l of levels) {
    assert.equal(l.isIndex, l.value % 10 === 0, `${l.value} index flag`);
    assert.ok(Math.abs(l.meters - l.value * FT) < 1e-9);
    assert.equal(l.label, `${l.value}ft`);
  }
  assert.equal(levels.find(l => l.value === 750).label, '750ft');
  assert.equal(levels.find(l => l.value === 800).isIndex, true);
  assert.equal(levels.find(l => l.value === 790).isIndex, true);
  assert.equal(levels.find(l => l.value === 792).isIndex, false);
});

test('interval switching changes spacing and index cadence; metres and decimals label cleanly', () => {
  const one = contourLevels(100, 110, 1, 'imperial').levels, five = contourLevels(100, 110, 5, 'imperial').levels;
  assert.equal(one.length, 32); assert.equal(five.length, 7);
  assert.deepEqual(five.filter(l => l.isIndex).map(l => l.value), [350]);
  assert.deepEqual(one.filter(l => l.isIndex).map(l => l.value), [330, 335, 340, 345, 350, 355, 360]);
  const half = contourLevels(100, 103, 0.5, 'metric').levels;
  assert.deepEqual(half.map(l => l.label), ['100m', '100.5m', '101m', '101.5m', '102m', '102.5m', '103m']);
  assert.deepEqual(half.filter(l => l.isIndex).map(l => l.value), [100, 102.5]);
  assert.equal(formatContourLabel(-0.0001, 'imperial', 1), '0ft');
  assert.equal(contourLevels(0, 10_000, 1, 'imperial').tooMany, true);
  assert.deepEqual(CONTOUR_INTERVALS.imperial, [1, 2, 5, 10, 20, 50]);
});

test('auto interval keeps the relief to about 40 lines', () => {
  assert.equal(autoContourInterval(200, 200 + 30 * FT, 'imperial'), 1);
  assert.equal(autoContourInterval(200, 200 + 70 * FT, 'imperial'), 2);
  assert.equal(autoContourInterval(200, 200 + 300 * FT, 'imperial'), 10);
  assert.equal(autoContourInterval(200, 260, 'metric'), 2);
});

test('cone DEM: rings sit at the right radius and elevation, every 5th ring is index', () => {
  const dem = cone();
  const { levels } = contourLevels(Math.min(...dem.values), Math.max(...dem.values), 5, 'imperial');
  const features = buildContours({ ...dem, levels, grid });
  const values = [...new Set(features.map(f => f.value))].sort((a, b) => a - b);
  // Radius stays inside the square, so rings from 260-60=200 ft upward are whole circles.
  for (const v of values.filter(v => v > 205 && v < 255)) {
    const rings = features.filter(f => f.value === v);
    assert.equal(rings.length, 1, `${v} ft is one line`);
    const ring = rings[0];
    assert.equal(ring.closed, true, `${v} ft ring is closed`);
    assert.equal(ring.isIndex, v % 25 === 0);
    assert.equal(ring.label, `${v}ft`);
    const expectedR = dem.peakFt - v;
    for (let i = 0; i < ring.coords.length; i += 2) {
      const r = Math.hypot(ring.coords[i] - dem.centre[0], ring.coords[i + 1] - dem.centre[1]);
      assert.ok(Math.abs(r - expectedR) < 0.6, `${v} ft vertex at radius ${r.toFixed(2)} (expected ${expectedR})`);
    }
  }
  assert.deepEqual(values.filter(v => v % 25 === 0), features.filter(f => f.isIndex).map(f => f.value).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b));
});

test('plane DEM: straight lines at the exact easting; nodata clips lines to the DTM extent', () => {
  const w = 60, h = 40, values = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[y * w + x] = x < 45 ? 100 + x * 0.1 : -9999;
  const { levels } = contourLevels(100, 104.4, 1, 'metric');
  const features = buildContours({ values, width: w, height: h, nodata: -9999, levels, grid, smoothPasses: 0 });
  assert.deepEqual(features.map(f => f.value), [101, 102, 103, 104]);
  for (const f of features) {
    const xExpected = grid.minE + (f.value - 100) / 0.1 + 0.5;
    for (let i = 0; i < f.coords.length; i += 2) {
      assert.ok(Math.abs(f.coords[i] - xExpected) < 1e-6, `${f.value} m line at E ${f.coords[i]}`);
      assert.ok(f.coords[i] < grid.minE + 45, 'no line inside the nodata area');
    }
    const ns = f.coords.filter((_, i) => i % 2 === 1);
    assert.ok(Math.max(...ns) - Math.min(...ns) > 37, 'line spans the data height');
  }
});

test('declared vertical units scale raw values to metres; the point cap stops dense output', () => {
  const w = 30, h = 10, values = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[y * w + x] = 998 + x; // feet
  const { levels } = contourLevels(998 * FT, 1027 * FT, 5, 'imperial');
  const features = buildContours({ values, width: w, height: h, valueScale: FT, levels, grid, smoothPasses: 0 });
  assert.deepEqual(features.map(f => f.value), [1000, 1005, 1010, 1015, 1020, 1025]);
  assert.ok(Math.abs(features[0].coords[0] - (grid.minE + 2.5)) < 1e-3, '1000 ft line at the 1000 ft column');
  assert.throws(() => buildContours({ values, width: w, height: h, valueScale: FT, levels, grid, smoothPasses: 0, maxPoints: 5 }), { code: 'contours_too_dense' });
});

test('saddle cells resolve without crossing and segments stitch into whole lines', () => {
  // Two peaks: a saddle between them.
  const w = 51, h = 41, values = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[y * w + x] = Math.max(10 - Math.hypot(x - 15, y - 20), 10 - Math.hypot(x - 35, y - 20));
  const traced = traceContours(values, w, h, [-3, 5]);
  assert.equal(traced[1].length, 2, 'two separate rings above the saddle');
  assert.ok(traced[1].every(l => l.closed));
  assert.equal(traced[0].length, 1, 'one line around both peaks below the saddle');
  assert.equal(traced[0][0].closed, true);
});

test('simplify and Chaikin keep end points and closure', () => {
  const line = Float64Array.from([0, 0, 1, 0.01, 2, 0, 3, 0.01, 4, 0]);
  assert.deepEqual(Array.from(simplifyLine(line, 0.1)), [0, 0, 4, 0]);
  const ring = Float64Array.from([0, 0, 2, 0, 2, 2, 0, 2, 0, 0]);
  const smooth = chaikin(ring, 2, true);
  assert.deepEqual([smooth[0], smooth[1]], [smooth.at(-2), smooth.at(-1)]);
  const open = chaikin(Float64Array.from([0, 0, 2, 0, 2, 2]), 2, false);
  assert.deepEqual([open[0], open[1], open.at(-2), open.at(-1)], [0, 0, 2, 2]);
});

test('DEM window: picks the coarsest overview that is fine enough and caps cells for overview zooms', () => {
  const ds = { minE: 0, maxE: 1000, minN: 0, maxN: 1000, levels: [{ width: 10000, height: 10000 }, { width: 5000, height: 5000 }, { width: 2500, height: 2500 }, { width: 1250, height: 1250 }] };
  const close = chooseDemWindow(ds, { minE: 100, maxE: 150, minN: 100, maxN: 150 }, { targetCell: 0.25 });
  assert.equal(close.level, 1); assert.equal(close.resampled, false);
  assert.deepEqual(close.window, [500, 4250, 750, 4500]);
  const far = chooseDemWindow(ds, { minE: -500, maxE: 1500, minN: -500, maxN: 1500 }, { targetCell: 0.1, maxCells: 250_000 });
  assert.equal(far.level, 0); assert.equal(far.resampled, true);
  assert.ok(far.outW * far.outH <= 250_000);
  assert.deepEqual(far.extent, { minE: 0, maxE: 1000, minN: 0, maxN: 1000 }, 'clipped to the DTM extent');
  assert.equal(chooseDemWindow(ds, { minE: 2000, maxE: 3000, minN: 0, maxN: 10 }, { targetCell: 1 }), null);
});

test('labels follow straight lines upright and skip short or sharply bent lines', () => {
  const straight = Float64Array.from([0, 100, 1000, 100]);
  const anchors = placeLabels(straight, { spacing: 300, textWidth: 40 });
  assert.equal(anchors.length, 3);
  assert.ok(anchors.every(a => a.angle === 0 && a.y === 100));
  const leftward = placeLabels(Float64Array.from([1000, 0, 0, 0]), { spacing: 300, textWidth: 40 });
  assert.ok(leftward.every(a => Math.abs(a.angle) < 1e-9), 'text is never upside down');
  assert.equal(placeLabels(Float64Array.from([0, 0, 50, 0]), { textWidth: 40 }).length, 0);
  const zigzag = [];
  for (let i = 0; i <= 40; i++) zigzag.push(i * 10, i % 2 ? 30 : 0);
  assert.equal(placeLabels(Float64Array.from(zigzag), { spacing: 100, textWidth: 40 }).length, 0);
});

test('drawing strokes minor lines thin, index lines thick, and labels index lines in ft', () => {
  const calls = [];
  const ctx = new Proxy({ measureText: t => ({ width: t.length * 7 }) }, {
    get(target, key) { if (key in target) return target[key]; return (...args) => calls.push([key, ...args]); },
    set(target, key, value) { calls.push(['set', key, value]); return true; },
  });
  const features = [
    { isIndex: false, label: '752ft', coords: Float64Array.from([0, 10, 800, 10]) },
    { isIndex: true, label: '750ft', coords: Float64Array.from([0, 50, 800, 50]) },
  ];
  const result = drawContours(ctx, features, (a, b) => [a, b], { width: 800, height: 100 });
  assert.deepEqual(result, { minor: 1, index: 1, labels: 2 });
  const widths = calls.filter(c => c[0] === 'set' && c[1] === 'lineWidth').map(c => c[2]);
  assert.deepEqual(widths.slice(0, 3).map(w => +w.toFixed(6)), [1, 3.8, 2.2]);
  assert.deepEqual(calls.filter(c => c[0] === 'fillText').map(c => c[1]), ['750ft', '750ft']);
  assert.ok(calls.some(c => c[0] === 'set' && c[1] === 'strokeStyle' && /255,248,232/.test(c[2])), 'light label halo');
});

test('worker message adds lat/lng for the map from the task UTM zone', () => {
  const dem = cone(41, 120);
  const { levels } = contourLevels(Math.min(...dem.values), Math.max(...dem.values), 10, 'imperial');
  const projection = { zoneLon0Deg: -87, hemisphere: 'N' };
  const features = computeContourMessage({ ...dem, levels, grid, projection });
  assert.ok(features.length > 0);
  const utm = createUtmProjection(projection);
  const f = features[0];
  const [lat, lng] = utm.utmToLatLon(f.coords[0], f.coords[1]);
  assert.ok(Math.abs(f.latLng[0] - lat) < 1e-12 && Math.abs(f.latLng[1] - lng) < 1e-12);
});
