// Acreage under the owner name: accuracy against independently known areas,
// when a number may be shown at all, and label placement. Synthetic parcels
// and generic owner names only.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createUtmProjection } from '../utm-conversion.mjs';
import { createParcelTileLoader, lonLatToTileXY, makeTile, tilesCoverBounds } from '../property-lines.mjs';
import {
  dissolveParcelsByOwner, formatParcelArea, outlineAreaM2, ownerLabelCandidates, publishedAreaM2, parcelAreaM2, parcelLabelGeometry, placeOwnerLabels,
} from '../property-lines-owners.mjs';
import { createPropertyLinesController } from '../property-lines-layer.mjs';

const require = createRequire(import.meta.url);
const FOOT = 0.3048, ACRE = 4046.8564224;
const LATITUDES = [42.6, 44.5, 46.8];
const all = () => true;

// Independent reference: shapes laid out in metres on the plane tangent to
// the ellipsoid (ECEF), so their area is known from the layout alone. Over one
// section the plane's own area error is below one part in ten million.
const A = 6378137, F = 1 / 298.257222101, E2 = F * (2 - F), RAD = Math.PI / 180;
function ecef(lon, lat) {
  const s = Math.sin(lat * RAD), c = Math.cos(lat * RAD), n = A / Math.sqrt(1 - E2 * s * s);
  return [n * c * Math.cos(lon * RAD), n * c * Math.sin(lon * RAD), n * (1 - E2) * s];
}
function geodetic([x, y, z]) {
  const p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - E2));
  for (let i = 0; i < 12; i++) { const s = Math.sin(lat), n = A / Math.sqrt(1 - E2 * s * s), h = p / Math.cos(lat) - n; lat = Math.atan2(z, p * (1 - E2 * n / (n + h))); }
  return [Math.atan2(y, x) / RAD, lat / RAD];
}
const round7 = ([lon, lat]) => [Math.round(lon * 1e7) / 1e7, Math.round(lat * 1e7) / 1e7];
// Local metres (east, north) around a point, turned by `turn` degrees, to the lon/lat the server sends.
function layout(points, { lon = -90.2, lat = 44.5, turn = 0, precise = false } = {}) {
  const o = ecef(lon, lat), sl = Math.sin(lon * RAD), cl = Math.cos(lon * RAD), sp = Math.sin(lat * RAD), cp = Math.cos(lat * RAD);
  const ct = Math.cos(turn * RAD), st = Math.sin(turn * RAD);
  return points.map(([px, py]) => {
    const e = px * ct - py * st, n = px * st + py * ct;
    const at = geodetic([o[0] - sl * e - sp * cl * n, o[1] + cl * e - sp * sl * n, o[2] + cp * n]);
    return precise ? at : round7(at);
  });
}
const box = (x, y, w, h = w) => [[x, y], [x, y + h], [x + w, y + h], [x + w, y], [x, y]];
const error = (parcel, known) => Math.abs(parcelAreaM2(parcel) / known - 1);

test('area: known 40 acres, quarter section and section within 0.05% at 42.6, 44.5 and 46.8 N', t => {
  let worst = 0;
  for (const lat of LATITUDES) for (const lon of [-92.6, -90.2, -87.2]) for (const turn of [0, 1.7, 33]) for (const [side, acres] of [[1320, 40], [2640, 160], [5280, 640]]) {
    const m = side * FOOT;
    const parcel = { id: 1, rings: [layout(box(-m / 2, -m / 2, m), { lon, lat, turn })] };
    const off = error(parcel, acres * ACRE);
    worst = Math.max(worst, off);
    assert.ok(off < 0.0005, `${acres} acres at ${lat}: ${(off * 100).toFixed(5)}%`);
    assert.equal(formatParcelArea(parcelAreaM2(parcel)), `~${acres.toFixed(1)} ac`);
  }
  t.diagnostic(`worst error, coordinates rounded as served: ${(worst * 100).toFixed(5)}%`);
  assert.ok(worst < 0.0001, `worst ${(worst * 100).toFixed(5)}%`);
  let exact = 0;
  for (const lat of LATITUDES) { const m = 1320 * FOOT; exact = Math.max(exact, error({ rings: [layout(box(-m / 2, -m / 2, m), { lat, precise: true })] }, 40 * ACRE)); }
  t.diagnostic(`worst error of the method alone (40 acres): ${(exact * 100).toFixed(6)}%`);
  assert.ok(exact < 1e-5);
});

test('area: a second reference, UTM grid squares on the central meridian (point scale 0.9996)', t => {
  let worst = 0;
  for (const lat of LATITUDES) for (const lon0 of [-93, -87]) {
    const utm = createUtmProjection({ zoneLon0Deg: lon0, hemisphere: 'N' });
    const [e, n] = utm.latLonToUtm(lat, lon0);
    const ring = box(-200, -200, 400).map(([x, y]) => { const [la, lo] = utm.utmToLatLon(e + x, n + y); return round7([lo, la]); });
    worst = Math.max(worst, error({ rings: [ring] }, (400 / 0.9996) ** 2));
  }
  t.diagnostic(`worst error against UTM: ${(worst * 100).toFixed(5)}%`);
  assert.ok(worst < 0.0001);
});

test('area: neither the Web Mercator area nor the old label frame is used', t => {
  for (const lat of LATITUDES) {
    const m = 1320 * FOOT, parcel = { rings: [layout(box(-m / 2, -m / 2, m), { lat })] };
    const frame = parcelLabelGeometry(parcel).areaM2 / (40 * ACRE);
    t.diagnostic(`label frame at ${lat}: ${(100 - frame * 100).toFixed(2)}% low`);
    assert.ok(frame < 0.996 && frame > 0.99, 'label frame: priority only');
    assert.ok(1 / Math.cos(lat * RAD) ** 2 > 1.8, 'Web Mercator would be about double');
    assert.ok(error(parcel, 40 * ACRE) < 0.0001);
  }
});

test('area: holes, islands, parts, ring direction and a hole touching its outer ring', () => {
  const outer = layout(box(0, 0, 400)), hole = layout(box(100, 100, 200)), island = layout(box(150, 150, 100)), pond = layout(box(175, 175, 50)), far = layout(box(900, 0, 100));
  const flip = ring => ring.slice().reverse();
  const near = (rings, known) => assert.ok(error({ rings }, known) < 0.0005, `${parcelAreaM2({ rings })} vs ${known}`);
  near([outer, hole], 160000 - 40000);
  near([flip(outer), hole], 120000);
  near([outer, flip(hole)], 120000);
  near([hole, outer], 120000);
  near([outer, hole, island], 130000);
  near([outer, hole, island, pond], 127500);
  near([outer, far], 170000);
  // A hole starting at a corner it shares with the outer ring.
  near([outer, layout([[0, 0], [200, 100], [100, 200], [0, 0]])], 160000 - 15000);
  // Two parts sharing an edge are both land.
  near([layout(box(0, 0, 100)), layout(box(100, 0, 100))], 20000);
  assert.equal(parcelAreaM2({ rings: [outer.slice(0, -1)] }), null, 'an open ring has no area');
  assert.equal(parcelAreaM2({ rings: [] }), null);
});

test('units: one decimal from 1 acre, two below, square feet under 0.1 acre; hectares in metric', () => {
  const ac = n => n * ACRE;
  assert.equal(formatParcelArea(ac(40.17)), '~40.2 ac');
  assert.equal(formatParcelArea(ac(1234.56)), '~1,234.6 ac');
  assert.equal(formatParcelArea(ac(1)), '~1.0 ac');
  assert.equal(formatParcelArea(ac(0.999)), '~1.0 ac');
  assert.equal(formatParcelArea(ac(0.256)), '~0.26 ac');
  assert.equal(formatParcelArea(ac(0.05)), '~2,180 sq ft');
  assert.equal(formatParcelArea(161874, 'metric'), '~16.2 ha');
  assert.equal(formatParcelArea(2560, 'metric'), '~0.26 ha');
  assert.equal(formatParcelArea(512, 'metric'), '~510 m²');
  for (const none of [null, undefined, NaN, 0, -5]) assert.equal(formatParcelArea(none), '');
});

// ── When a number may be shown ───────────────────────────────────────────

const M = 1320 * FOOT;   // 40-acre squares on a grid
const forty = (id, owner, i, j) => ({ id, ...(owner ? { owner } : {}), rings: [layout(box(i * M, j * M, M))] });
const text = m2 => formatParcelArea(m2);

test('merged: the total is the sum of the parts; not merged: each parcel its own', () => {
  const parcels = [forty(1, 'SAMPLE FARMS LLC', 0, 0), forty(2, 'Sample Farms, LLC', 1, 0), forty(3, 'SAMPLE FARMS LLC', 0, 1), forty(4, 'EXAMPLE OWNER', 1, 1), forty(5, 'SAMPLE FARMS LLC', 4, 4)];
  const merged = dissolveParcelsByOwner(parcels);
  const of = ids => merged.find(o => o.parcelIds.join() === ids);
  const total = outlineAreaM2(of('1,2,3'), { covered: all });
  assert.equal(text(total), '~120.0 ac');
  assert.ok(Math.abs(total - parcels.slice(0, 3).reduce((n, p) => n + parcelAreaM2(p), 0)) < 1e-6);
  assert.equal(text(outlineAreaM2(of('5'), { covered: all })), '~40.0 ac', 'separate tracts are separate totals');
  const raw = ownerLabelCandidates(dissolveParcelsByOwner(parcels, { merge: false }), { acreage: { merged: false } });
  assert.deepEqual(raw.map(c => text(c.acreageM2)), Array(5).fill('~40.0 ac'));
});

test('merged: no total until everything touching the land is loaded; a single parcel needs no wait', () => {
  const [outline] = dissolveParcelsByOwner([forty(1, 'SAMPLE FARMS LLC', 0, 0), forty(2, 'SAMPLE FARMS LLC', 1, 0)]);
  assert.equal(outlineAreaM2(outline), null);
  assert.equal(outlineAreaM2(outline, { covered: null }), null);
  let seen = 0;
  assert.equal(outlineAreaM2(outline, { covered: () => ++seen < 2 }), null, 'one parcel past the loaded tiles is enough');
  // A lone parcel of a named owner may continue next door too.
  const [lone] = dissolveParcelsByOwner([forty(1, 'SAMPLE FARMS LLC', 0, 0)]);
  assert.equal(outlineAreaM2(lone, { covered: () => false }), null);
  const [raw] = dissolveParcelsByOwner([forty(1, 'SAMPLE FARMS LLC', 0, 0)], { merge: false });
  assert.equal(text(outlineAreaM2(raw, { merged: false })), '~40.0 ac');
});

test('a parcel clipped by the server shows no acreage, and neither does a total that includes it', () => {
  const { clipParcels } = require('../server/propertyLines.js');
  const whole = [forty(1, 'SAMPLE FARMS LLC', 0, 0), forty(2, 'SAMPLE FARMS LLC', 1, 0), forty(3, 'EXAMPLE OWNER', 0, 1)];
  const east = layout([[1.5 * M, 0]])[0][0];
  const { parcels } = clipParcels({ status: 'ok', parcels: whole }, { west: -91, south: 44, east, north: 45 });
  assert.ok(Array.isArray(parcels.find(p => p.id === 2).lines), 'parcel 2 is cut');
  const candidates = merge => ownerLabelCandidates(dissolveParcelsByOwner(parcels, { merge }), { acreage: { merged: merge, covered: all } });
  assert.deepEqual(candidates(true).map(c => [c.text, text(c.acreageM2)]), [['SAMPLE FARMS LLC', ''], ['EXAMPLE OWNER', '~40.0 ac']]);
  assert.deepEqual(candidates(false).map(c => [c.text, text(c.acreageM2)]), [['SAMPLE FARMS LLC', '~40.0 ac'], ['SAMPLE FARMS LLC', ''], ['EXAMPLE OWNER', '~40.0 ac']]);
});

test('stacked records and shapes over the same land count once', () => {
  const base = forty(1, 'SAMPLE FARMS LLC', 0, 0), next = forty(2, 'SAMPLE FARMS LLC', 1, 0);
  const ring = base.rings[0], turned = [...ring.slice(2, -1), ...ring.slice(0, 3)];
  for (const stacked of [ring, ring.slice().reverse(), turned]) {
    const outline = { ownerKey: 'SAMPLE FARMS LLC', owner: 'SAMPLE FARMS LLC', parcels: [base, { ...base, id: 9, rings: [stacked] }, next] };
    assert.equal(text(outlineAreaM2(outline, { covered: all })), '~80.0 ac');
  }
  const unit = { id: 8, owner: 'SAMPLE FARMS LLC', rings: [layout(box(50, 50, 60))] };
  assert.equal(text(outlineAreaM2({ ownerKey: 'SAMPLE FARMS LLC', parcels: [base, next, unit] }, { covered: all })), '~80.0 ac');
  // Land inside the hole of its neighbour is not stacked.
  const ringed = { id: 7, owner: 'SAMPLE FARMS LLC', rings: [layout(box(0, 0, 400)), layout(box(100, 100, 200))] };
  const filled = { id: 6, owner: 'SAMPLE FARMS LLC', rings: [layout(box(100, 100, 200))] };
  const joined = dissolveParcelsByOwner([ringed, filled]);
  assert.equal(joined.length, 1);
  assert.ok(Math.abs(outlineAreaM2(joined[0], { covered: all }) / 160000 - 1) < 0.0005);
});

test('partial overlap: parcels joined through a third never count shared land twice', () => {
  // Two parcels over each other by 4 m x 22.62 m, each next to a third below;
  // neither one's middle lies inside the other.
  const low = layout(box(0, 0, 200, 50)), left = layout(box(0, 50, 104, 100)), right = layout(box(100, 50, 100, 22.62));
  const known = 200 * 50 + 104 * 100 + 100 * 22.62 - 4 * 22.62;
  for (const turn of [0, 1]) {
    const rings = turn ? [right, low, left] : [low, left, right];
    const outlines = dissolveParcelsByOwner(rings.map((ring, i) => ({ id: i + 1, owner: 'SAMPLE FARMS LLC', rings: [ring] })));
    assert.equal(outlines.length, 1, 'joined through the third');
    const middles = outlines[0].parcels.map(p => parcelLabelGeometry(p).lonLat), [a, b] = [left, right].map(r => middles[rings.indexOf(r)]);
    const inside = ([x, y], r) => x > Math.min(...r.map(p => p[0])) && x < Math.max(...r.map(p => p[0])) && y > Math.min(...r.map(p => p[1])) && y < Math.max(...r.map(p => p[1]));
    assert.deepEqual([inside(a, right), inside(b, left)], [false, false]);
    const total = outlineAreaM2(outlines[0], { covered: all });
    assert.ok(Math.abs(total - known) < 5, `${total} vs ${known}: 90.5 m2 of overlap`);
  }
});

test('union area matches known areas: crossing shapes, holes, nesting, duplicates, rounding slivers, dense edges', () => {
  const at = rings => outlineAreaM2({ ownerKey: 'A', parcels: rings.map((r, i) => ({ id: i, rings: Array.isArray(r[0][0]) ? r : [r] })) }, { covered: all });
  const near = (rings, known, tolerance = 0.0005) => { const got = at(rings); assert.ok(Math.abs(got / known - 1) < tolerance, `${got} vs ${known}`); };
  // A plus sign, two crossing triangles (hexagram), and a hole partly covered by another parcel.
  near([layout(box(0, 100, 300, 100)), layout(box(100, 0, 100, 300))], 30000 + 30000 - 10000);
  const R = 200, star = k => layout([0, 1, 2, 3].map(i => [R * Math.sin((i * 120 + k) * RAD), R * Math.cos((i * 120 + k) * RAD)]));
  near([star(0), star(60)], Math.sqrt(3) * R * R);   // hexagram of circumradius R
  near([[layout(box(0, 0, 400)), layout(box(100, 100, 200))], layout(box(50, 150, 100, 50))], 160000 - 40000 + 50 * 50);
  near([layout(box(0, 0, 400)), layout(box(100, 100, 50)), layout(box(0, 0, 400))], 160000);
  near([layout(box(0, 0, 400)), layout(box(390, 390, 400))], 320000 - 100);
  // Neighbours that only touch: the plain sum, at any angle, with corners on one side only.
  for (const turn of [0, 17, 45]) {
    const o = { turn }, rings = [layout([[0, 0], [0, 400], [400, 400], [400, 250], [400, 120], [400, 0], [0, 0]], o), layout(box(400, 0, 300, 120), o), layout(box(400, 120, 300, 280), o)];
    const sum = rings.reduce((n, r) => n + parcelAreaM2({ rings: [r] }), 0);
    assert.ok(Math.abs(at(rings) - sum) < 10, `turn ${turn}: ${at(rings) - sum} m2 of rounding`);
  }
  // Wavy shared boundary, 2000 corners a side.
  const wave = Array.from({ length: 2000 }, (_, i) => [i, 100 + 20 * Math.sin(i / 9)]);
  const upper = layout([...wave, [1999, 500], [0, 500], wave[0]]), lower = layout([...wave, [1999, 0], [0, 0], wave[0]]);
  const started = performance.now();
  near([upper, lower], 1999 * 500);
  assert.ok(performance.now() - started < 3000, 'bounded time');
});

test('one record with crossed, doubled or overlapping rings shows no acreage', () => {
  const alone = rings => outlineAreaM2({ ownerKey: '', parcels: [{ id: 1, rings }] }, { merged: false });
  assert.equal(text(alone([layout(box(0, 0, 400)), layout(box(500, 0, 400))])), '~79.1 ac', 'two sound parts');
  assert.equal(alone([layout([[0, 0], [400, 400], [400, 0], [0, 400], [0, 0]])]), null, 'bow tie');
  assert.equal(alone([layout([[0, 0], [500, 400], [400, 0], [0, 300], [0, 0]])]), null, 'crossed ring');
  assert.equal(alone([layout(box(0, 0, 400)), layout(box(0, 0, 400))]), null, 'ring twice');
  assert.equal(alone([layout(box(0, 0, 400)), layout(box(300, 300, 400))]), null, 'overlapping parts');
});

test('land too intricate to add up within the work budget shows no total', () => {
  const comb = (dy, n) => layout([[0, dy], ...Array.from({ length: n }, (_, i) => [i + 0.5, dy + (i % 2 ? 0 : 1000)]), [n, dy], [0, dy]]);
  assert.equal(outlineAreaM2({ ownerKey: 'A', parcels: [{ id: 1, rings: [comb(0, 4000)] }, { id: 2, rings: [comb(1, 4000)] }] }, { covered: all }), null);
});

test('tiles: bounds count as loaded only when every tile they touch is, counting split tiles', () => {
  const [x, y] = lonLatToTileXY(-90.2, 44.5, 14), tile = makeTile(14, x, y), b = tile.bounds;
  const inside = { west: b.west + 0.004, south: b.south + 0.004, east: b.west + 0.006, north: b.south + 0.006 };
  const across = { ...inside, east: b.east + 0.001 };
  assert.equal(tilesCoverBounds(new Set([tile.key]), inside), true);
  assert.equal(tilesCoverBounds(new Set(), inside), false);
  assert.equal(tilesCoverBounds(null, inside), false);
  assert.equal(tilesCoverBounds(new Set([tile.key]), across), false);
  assert.equal(tilesCoverBounds(new Set([tile.key, makeTile(14, x + 1, y).key]), across), true);
  assert.equal(tilesCoverBounds(new Set([tile.key]), { ...inside, east: b.east }), false, 'an edge on the tile boundary needs the next tile');
  const children = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dy]) => makeTile(15, 2 * x + dx, 2 * y + dy));
  const full = { west: b.west + 0.001, south: b.south + 0.001, east: b.east - 0.001, north: b.north - 0.001 };
  assert.equal(tilesCoverBounds(new Set(children.map(t => t.key)), full), true);
  assert.equal(tilesCoverBounds(new Set(children.slice(1).map(t => t.key)), full), false, 'a child that did not load');
  assert.equal(tilesCoverBounds(new Set([tile.key]), { west: b.west - 1, south: b.south - 1, east: b.east + 1, north: b.north + 1 }), false);
});

test('tile loader names the tiles answered in full: not failed, too dense or outside ones', async () => {
  const t = k => makeTile(14, 4107 + k, 5880);
  const answers = new Map([[t(0).key, { status: 'ok', parcels: [forty(1, 'EXAMPLE OWNER', 0, 0)] }], [t(1).key, { status: 'none', parcels: [] }], [t(3).key, 'outside'], [t(4).key, 'busy']]);
  const loader = createParcelTileLoader({ debounceMs: 0, maxTileZoom: 14, fetchImpl: async url => {
    const answer = answers.get(new URL(url, 'http://x').searchParams.get('tile')) || { status: 'too_many', parcels: [] };
    if (answer === 'outside') return { ok: false, status: 403, json: async () => ({ code: 'outside_model' }) };
    if (answer === 'busy') return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => answer };
  } });
  const result = await loader.load([0, 1, 2, 3, 4].map(t));
  assert.deepEqual([result.status, result.partial, result.failed], ['ok', true, true]);
  assert.deepEqual(result.loaded.sort(), [t(0).key, t(1).key].sort());
});

// ── Labels ───────────────────────────────────────────────────────────────

const projector = zoom => (lon, lat) => {
  const n = 256 * 2 ** zoom, at = (lo, la) => [(lo + 180) / 360 * n, (1 - Math.log(Math.tan(Math.PI / 4 + la * RAD / 2)) / Math.PI) / 2 * n];
  const [x, y] = at(lon, lat), [x0, y0] = at(-90.2, 44.5);
  return [x - x0 + 1000, y - y0 + 1000];
};
const measure = (line, px) => line.length * px * 0.6;
const place = (candidates, zoom, options = {}) => placeOwnerLabels(candidates, { zoom, project: projector(zoom), viewport: { width: 2000, height: 2000 }, measure, ...options });

test('labels: the acreage line is under the name, from zoom 15, in the Viewer units', () => {
  const candidates = ownerLabelCandidates(dissolveParcelsByOwner([forty(1, 'SAMPLE FARMS LLC', 0, 0), forty(2, 'SAMPLE FARMS LLC', 1, 0)]), { acreage: { merged: true, covered: all } });
  assert.deepEqual(place(candidates, 16).map(l => l.lines), [['SAMPLE FARMS LLC', '~80.0 ac']]);
  assert.deepEqual(place(candidates, 16, { units: 'metric' }).map(l => l.lines), [['SAMPLE FARMS LLC', '~32.4 ha']]);
  assert.deepEqual(place(candidates, 15).map(l => l.lines), [['SAMPLE FARMS LLC', '~80.0 ac']]);
  for (const zoom of [14, 14.9]) assert.deepEqual(place(candidates.map(c => ({ ...c, rings: undefined, radiusMeters: 2000, areaM2: 1e7 })), zoom).map(l => l.lines), [['SAMPLE FARMS LLC']], 'name only');
  assert.deepEqual(place(ownerLabelCandidates(dissolveParcelsByOwner([forty(1, 'SAMPLE FARMS LLC', 0, 0)])), 16).map(l => l.lines), [['SAMPLE FARMS LLC']], 'no acreage asked for');
  const [label] = place(candidates, 16);
  assert.equal(label.height, 2 * label.lineHeight);
  assert.equal('candidate' in label, false);
});

test('labels: the acreage line drops first when space is tight, and never costs a name its place', () => {
  const mpp16 = 40075016.686 * Math.cos(44.5 * RAD) / 2 ** 24;
  const base = { ownerKey: 'A', text: 'SAMPLE FARMS', lon: -90.2, lat: 44.5, acreageM2: 4 * ACRE, areaM2: 160000, radiusMeters: 60 * mpp16 };
  assert.deepEqual(place([base], 16).map(l => l.lines), [['SAMPLE FARMS', '~4.0 ac']]);
  // A radius of 15 px holds one 14 px line, not two (two need 16 px).
  assert.deepEqual(place([{ ...base, text: 'ABC', radiusMeters: 15 * mpp16 }], 16).map(l => l.lines), [['ABC']], 'outline too small for two lines');
  assert.deepEqual(place([{ ...base, acreageM2: 1e12, radiusMeters: 32 * mpp16 }], 16).map(l => l.lines), [['SAMPLE FARMS']], 'number too wide for the outline');
  // Cut by the top edge of the view with two lines, whole with one.
  assert.deepEqual(place([base], 16, { project: () => [500, 12] }).map(l => l.lines), [['SAMPLE FARMS']]);
  // Two neighbours one line apart: both names stay exactly where they were, without acreage.
  const pair = [base, { ...base, ownerKey: 'B', text: 'EXAMPLE OWNER', areaM2: 150000, lon: -90.1999 }];
  const spots = new Map([[-90.2, [500, 500]], [-90.1999, [500, 522]]]);
  const opts = { project: lon => spots.get(lon) };
  const names = place(pair.map(({ acreageM2, ...c }) => c), 16, opts);
  assert.deepEqual(place(pair, 16, opts), names);
  assert.deepEqual(names.map(l => l.lines), [['SAMPLE FARMS'], ['EXAMPLE OWNER']]);
});

test('labels: with many neighbours the same names are placed with and without acreage, and nothing overlaps', () => {
  const parcels = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) parcels.push({ id: i * 8 + j, owner: `OWNER ${i} ${j} FAMILY LIMITED`.slice(0, 12 + (i * j) % 14), rings: [layout(box(i * 130, j * 70, 130, 70))] });
  const outlines = dissolveParcelsByOwner(parcels, { merge: false });
  let shown = 0;
  for (const zoom of [15, 16, 16.5, 17, 18]) {
    const plain = place(ownerLabelCandidates(outlines), zoom), withAcres = place(ownerLabelCandidates(outlines, { acreage: { merged: false } }), zoom);
    assert.deepEqual(withAcres.map(l => [l.text, l.x, l.y]), plain.map(l => [l.text, l.x, l.y]), `zoom ${zoom}`);
    shown += withAcres.filter(l => l.lines.at(-1).startsWith('~')).length;
    for (const [i, a] of withAcres.entries()) for (const b of withAcres.slice(i + 1))
      assert.ok(Math.abs(a.x - b.x) * 2 >= a.width + b.width || Math.abs(a.y - b.y) * 2 >= a.height + b.height, 'no overlap');
  }
  assert.ok(shown > 10, `${shown} acreage lines`);
});

test('labels: a parcel with no usable owner name says so and keeps its acreage, merged or not', () => {
  const parcels = [forty(1, 'NOT AVAILABLE', 0, 0), forty(2, null, 1, 0), forty(3, 'EXAMPLE OWNER', 0, 1)];
  const lines = (merge, zoom = 16) => place(ownerLabelCandidates(dissolveParcelsByOwner(parcels, { merge }), { acreage: { merged: merge, covered: all } }), zoom).map(l => l.lines);
  const expected = [['EXAMPLE OWNER', '~40.0 ac'], ['Owner not listed', '~40.0 ac'], ['Owner not listed', '~40.0 ac']];
  assert.deepEqual(lines(false), expected);
  assert.deepEqual(lines(true), expected, 'merging never hides a parcel with no owner');
  assert.ok(!lines(true, 14.5).flat().some(l => l.startsWith('~')), 'no acreage below zoom 15');
});

// ── The map layer ────────────────────────────────────────────────────────

const flush = async (rounds = 40) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const reply = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
function node() {
  return { style: {}, children: [], textContent: '', className: '', appendChild(c) { this.children.push(c); }, replaceChildren(...c) { this.children = c; }, remove() {}, get childElementCount() { return this.children.length; } };
}
// The view lies across two tiles; one owner's two parcels sit in the western one.
const UTM = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
const LAT = 43.0745, [TX, TY] = lonLatToTileXY(-89.401, LAT, 14);
const EDGE = makeTile(14, TX, TY).bounds.east, MAIN = `14/${TX}/${TY}`, NEXT = `14/${TX + 1}/${TY}`;
const ringAt = (lon, w) => [[lon, LAT - 0.002], [lon, LAT + 0.002], [lon + w, LAT + 0.002], [lon + w, LAT - 0.002], [lon, LAT - 0.002]].map(round7);
const FARM = [{ id: 1, owner: 'SAMPLE FARMS LLC', rings: [ringAt(EDGE - 0.012, 0.005)] }, { id: 2, owner: 'SAMPLE FARMS LLC', rings: [ringAt(EDGE - 0.007, 0.005)] }];
// This one reaches into the next tile, so its total needs both.
const CROSSING = { id: 3, owner: 'EXAMPLE OWNER', rings: [ringAt(EDGE - 0.002, 0.005)] };
function mapPage({ parcels, owners = 'yes' }) {
  const ctx = { requests: [], zoom: 16, units: 'imperial', centre: EDGE - 0.004 };
  globalThis.document = { createElement: () => node() };
  const panes = {}, layers = new Set(), span = 0.02;
  ctx.map = {
    getBounds: () => ({ getWest: () => ctx.centre - span / 2, getEast: () => ctx.centre + span / 2, getSouth: () => LAT - 0.001, getNorth: () => LAT + 0.001 }),
    getPane: name => panes[name], createPane: name => (panes[name] = node()), on() {},
    getZoom: () => ctx.zoom, getSize: () => ({ x: 1600, y: 800 }), getCenter: () => ({ lat: LAT, lng: ctx.centre }),
    latLngToContainerPoint: ([lat, lon]) => ({ x: 800 + (lon - ctx.centre) / span * 1600, y: 400 - (lat - LAT) * 1e5 }), containerPointToLayerPoint: ([x, y]) => ({ x, y }),
    hasLayer: layer => layers.has(layer), removeLayer: layer => layers.delete(layer),
  };
  const plain = () => ({ dataset: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, textContent: '', hidden: false });
  const [e, n] = UTM.latLonToUtm(LAT, EDGE - 0.004);
  ctx.controller = createPropertyLinesController({
    L: { canvas: () => ({}), polyline: (rings, options) => ({ rings, options, addTo() { layers.add(this); return this; } }) },
    headers: () => ({}), fetcherOptions: { debounceMs: 0 }, storage: null, measureText: measure, units: () => ctx.units,
    dom: { panel: plain(), button: plain(), status: plain(), notice: plain() },
    fetchImpl: async url => {
      if (!url.startsWith('/api/v1/property-lines/parcels')) return reply({ offered: true, source: { name: 'Synthetic parcels', release: 'R1', owners } });
      const tile = new URL(url, 'http://x').searchParams.get('tile');
      ctx.requests.push(tile);
      return parcels(tile);
    },
    projectId: () => 'model-a', projectVersion: () => 'v1', getMode: () => 'ortho', getCloudMode: () => 'none', getMap: () => ctx.map, getScene: () => null, getPotreeApi: () => null,
    georefVerified: () => true, getSceneExtentUtm: () => ({ minE: e - 100, minN: n - 80, maxE: e + 100, maxN: n + 80 }), getGroundGrid: async () => null,
    utmToLatLon: UTM.utmToLatLon, latLonToUtm: UTM.latLonToUtm, utmToWorld: () => null,
  });
  ctx.labels = () => (panes.propertyLineLabels?.children[0]?.children || []).map(c => c.textContent).sort();
  return ctx;
}
const ok = parcels => reply({ status: 'ok', parcels });
const acres = parcels => formatParcelArea(parcels.reduce((sum, p) => sum + parcelAreaM2(p), 0));
const FARM_TOTAL = `SAMPLE FARMS LLC\n${acres(FARM)}`, CROSSING_TOTAL = `EXAMPLE OWNER\n${acres([CROSSING])}`;

test('map: totals appear only once every tile of the view answered, and follow the merge choice without a request', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const ctx = mapPage({ parcels: async tile => { if (tile === NEXT) { await held; return ok([CROSSING]); } return ok(tile === MAIN ? [...FARM, CROSSING] : []); } });
  void ctx.controller.loadOffer();
  await flush();
  assert.ok(ctx.requests.includes(NEXT) && ctx.requests.includes(MAIN), ctx.requests.join());
  assert.deepEqual(ctx.labels(), ['EXAMPLE OWNER', 'SAMPLE FARMS LLC'], 'names only while a tile is still loading');
  release();
  await flush();
  assert.deepEqual(ctx.labels(), [CROSSING_TOTAL, FARM_TOTAL]);
  const asked = ctx.requests.length;
  ctx.controller.setMerge(false);
  await flush();
  assert.deepEqual(ctx.labels(), [CROSSING_TOTAL, ...FARM.map(p => `SAMPLE FARMS LLC\n${acres([p])}`)].sort());
  ctx.controller.setMerge(true);
  await flush();
  assert.deepEqual(ctx.labels(), [CROSSING_TOTAL, FARM_TOTAL]);
  ctx.units = 'metric';
  await ctx.controller.refresh();
  assert.match(ctx.labels().join('|'), /SAMPLE FARMS LLC\n~[\d.]+ ha/);
  assert.equal(ctx.requests.length, asked, 'no refetch');
  ctx.zoom = 14.5;
  await ctx.controller.refresh();
  assert.ok(!ctx.labels().join().includes('~'), 'no acreage below zoom 15');
});

test('map: land reaching past the tiles of the view shows no total', async () => {
  const reaching = { id: 4, owner: 'EXAMPLE OWNER', rings: [ringAt(EDGE - 0.006, 0.007)] };
  const ctx = mapPage({ parcels: async tile => ok(tile === MAIN ? [FARM[0], reaching] : []) });
  ctx.centre = EDGE - 0.0105;   // the eastern tile is out of view
  void ctx.controller.loadOffer();
  await flush();
  assert.ok(!ctx.requests.includes(NEXT));
  assert.deepEqual(ctx.labels(), ['EXAMPLE OWNER', `SAMPLE FARMS LLC\n${acres([FARM[0]])}`]);
});

test('map: a failed or too dense tile means no totals; single parcels keep theirs', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (const bad of [() => reply({}, 502), () => reply({ status: 'too_many', parcels: [] })]) {
      const ctx = mapPage({ parcels: async tile => (tile === MAIN ? ok([...FARM, CROSSING]) : tile === NEXT || /^1[56]\//.test(tile) ? bad() : ok([])) });
      void ctx.controller.loadOffer();
      await flush();
      assert.equal(ctx.controller.state.status, 'ready');
      assert.deepEqual(ctx.labels(), ['EXAMPLE OWNER', 'SAMPLE FARMS LLC']);
      ctx.controller.setMerge(false);
      await flush();
      assert.deepEqual(ctx.labels(), [CROSSING_TOTAL, ...FARM.map(p => `SAMPLE FARMS LLC\n${acres([p])}`)].sort());
    }
  } finally { mock.timers.reset(); }
});

test('map: an uploaded boundary file (no owners, maybe open lines) shows no acreage; owner names stay text', async () => {
  const upload = mapPage({ owners: 'no', parcels: async tile => ok(tile === MAIN ? FARM.map(({ owner, ...p }) => p) : []) });
  upload.controller.setMerge(false);
  void upload.controller.loadOffer();
  await flush();
  assert.equal(upload.controller.state.status, 'ready');
  assert.deepEqual(upload.labels(), []);
  const markup = mapPage({ parcels: async tile => ok(tile === MAIN ? [{ ...FARM[0], owner: '<b>X</b>' }] : []) });
  void markup.controller.loadOffer();
  await flush();
  assert.deepEqual(markup.labels(), [`<b>X</b>\n${acres([FARM[0]])}`]);
});

test('the stated acres replace the computed area; ~ only when a parcel has none', () => {
  const stated = (id, owner, i, j, acres) => ({ ...forty(id, owner, i, j), ...(acres ? { acres } : {}) });
  const labels = (parcels, merge) => ownerLabelCandidates(dissolveParcelsByOwner(parcels, { merge }), { acreage: { merged: merge, covered: all } })
    .map(c => [c.text, formatParcelArea(c.acreageM2, 'imperial', { approx: c.acreageApprox })]);
  assert.deepEqual(labels([stated(1, 'SAMPLE FARMS LLC', 0, 0, 38.5)], false), [['SAMPLE FARMS LLC', '38.5 ac']]);
  assert.deepEqual(labels([stated(1, 'SAMPLE FARMS LLC', 0, 0)], false), [['SAMPLE FARMS LLC', '~40.0 ac']], 'missing: computed, marked');
  // Merged: the stated values summed; the same record from two tiles counts once.
  const pair = [stated(1, 'SAMPLE FARMS LLC', 0, 0, 38.5), stated(2, 'SAMPLE FARMS LLC', 1, 0, 41.25), stated(2, 'SAMPLE FARMS LLC', 1, 0, 41.25)];
  assert.deepEqual(labels(pair, true), [['SAMPLE FARMS LLC', '79.8 ac']]);
  assert.deepEqual(labels(pair, false).map(l => l[1]), ['38.5 ac', '41.3 ac'], 'a record that arrived twice is labelled once');
  assert.deepEqual(labels([pair[0], stated(2, 'SAMPLE FARMS LLC', 1, 0)], true), [['SAMPLE FARMS LLC', '~80.0 ac']], 'one missing value: computed total');
  const [outline] = dissolveParcelsByOwner(pair);
  assert.equal(publishedAreaM2(outline, { covered: () => false }), null, 'no total until all the land is loaded');
  assert.equal(formatParcelArea(publishedAreaM2(outline, { covered: all }), 'metric', { approx: false }), '32.3 ha');
});

test('two adjacent parcels: each name and size sits inside its own parcel, merged or not', () => {
  const parcels = [{ ...forty(1, 'SAMPLE FARMS LLC', 0, 0), acres: 40 }, { ...forty(2, 'EXAMPLE OWNER', 1, 0), acres: 39 }];
  const inside = ([x, y], ring) => { let hit = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit; } return hit; };
  for (const merge of [true, false]) {
    const candidates = ownerLabelCandidates(dissolveParcelsByOwner(parcels, { merge }), { acreage: { merged: merge, covered: all } });
    assert.equal(candidates.length, 2);
    for (const c of candidates) {
      const own = parcels.find(p => p.owner === c.text), other = parcels.find(p => p !== own);
      assert.ok(inside([c.lon, c.lat], own.rings[0]) && !inside([c.lon, c.lat], other.rings[0]), `${c.text} inside its own parcel`);
      // The label box, at the zoom it shows, stays inside its parcel too.
      const mppAt16 = 156543.03392 * Math.cos(c.lat * Math.PI / 180) / 2 ** 16;
      assert.ok(c.radiusMeters / mppAt16 > 14, 'room for the label within the parcel');
    }
  }
});

test('records over the same land give the same acres in any order', () => {
  const land = forty(1, 'SAMPLE FARMS LLC', 0, 0);
  const records = [{ ...land, id: 7, acres: 40.5 }, { ...land, id: 3, acres: 39.5 }, { ...land, id: 5 }, { ...land, id: 3, acres: 39.5 }];
  const seen = new Set();
  for (const order of [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]]) {
    const outline = { ownerKey: 'SAMPLE FARMS LLC', owner: 'SAMPLE FARMS LLC', parcels: order.map(i => records[i]) };
    seen.add(formatParcelArea(publishedAreaM2(outline, { covered: all }), 'imperial', { approx: false }));
  }
  assert.deepEqual([...seen], ['39.5 ac'], 'the lowest id with a stated value speaks for the land');
});

test('next to a neighbour, the whole label box stays inside its own parcel, or is made smaller or left out', () => {
  // A long name over a narrow strip beside a wide parcel: the box would run into the neighbour.
  const strip = { id: 1, owner: 'A VERY LONG OWNER NAME TRUST', acres: 2, rings: [layout(box(0, 0, 60, 400))] };
  const wide = { id: 2, owner: 'EXAMPLE OWNER', acres: 40, rings: [layout(box(60, 0, 400, 400))] };
  const ring = strip.rings[0], west = Math.min(...ring.map(p => p[0])), east = Math.max(...ring.map(p => p[0]));
  let strips = 0;
  for (const merge of [true, false]) {
    const candidates = ownerLabelCandidates(dissolveParcelsByOwner([strip, wide], { merge }), { acreage: { merged: merge, covered: all } });
    for (const zoom of [16, 17, 18, 19]) for (const perChar of [4.5, 5, 5.5, 6, 6.5, 7]) {
      const mpp = 156543.03392 * Math.cos(candidates[0].lat * Math.PI / 180) / 2 ** zoom;
      const project = (lon, lat) => [(lon - west) * 111320 * Math.cos(lat * Math.PI / 180) / mpp + 50, (44.6 - lat) * 110540 / mpp + 50];
      const placed = placeOwnerLabels(candidates, { zoom, project, measure: text => text.length * perChar });
      for (const label of placed.filter(l => l.text === strip.owner)) {
        const [left] = project(west, 0), [right] = project(east, 0);
        strips++;
        assert.ok(label.x - label.width / 2 >= left && label.x + label.width / 2 <= right, `zoom ${zoom}: box inside the strip`);
      }
      for (const label of placed.filter(l => l.text === wide.owner)) {
        const [left] = project(east, 0);
        assert.ok(label.x - label.width / 2 >= left - 1e-6, `zoom ${zoom}: the neighbour's label stays out of the strip`);
      }
    }
  }
  assert.ok(strips > 0, 'the strip is labelled once zoomed in far enough');
});

test('records over the same land of one owner, alone or beside more of its land, give one total in any order', () => {
  const land = forty(1, 'SAMPLE FARMS LLC', 0, 0), next = { ...forty(4, 'SAMPLE FARMS LLC', 1, 0), acres: 3.0 };
  for (const records of [[{ ...land, id: 1, acres: 3.9 }, { ...land, id: 2, acres: 7.1 }], [{ ...land, id: 1, acres: 3.9 }, { ...land, id: 2 }]]) {
    const seen = new Set();
    for (const [order, expected] of [[[0, 1], '3.9 ac'], [[1, 0], '3.9 ac'], [[0, 1, 2], '6.9 ac'], [[1, 0, 2], '6.9 ac'], [[2, 1, 0], '6.9 ac'], [[2, 0, 1], '6.9 ac']]) {
      const parcels = order.map(i => [...records, next][i]);
      const [c] = ownerLabelCandidates(dissolveParcelsByOwner(parcels), { acreage: { merged: true, covered: all } });
      seen.add(`${order.length}:${formatParcelArea(c?.acreageM2, 'imperial', { approx: c?.acreageApprox })}=${expected}`);
    }
    assert.deepEqual([...seen], ['2:3.9 ac=3.9 ac', '3:6.9 ac=6.9 ac'], 'the record with the lowest id and a stated value, plus the rest of the land, once');
  }
});

test('choosing one record for the acres never changes what is drawn', () => {
  const land = forty(1, 'SAMPLE FARMS LLC', 0, 0), next = forty(4, 'SAMPLE FARMS LLC', 1, 0);
  const ring = land.rings[0];
  const parcels = [{ ...land, id: 1, acres: 3.9, lines: [ring.slice(0, 3)] }, { ...land, id: 2, acres: 7.1, lines: [ring.slice(2)] }, next];
  const outlines = dissolveParcelsByOwner(parcels);
  const drawn = outlines.flatMap(o => o.parcels.map(p => p.id)).sort();
  const lines = JSON.stringify(outlines.map(o => o.lines));
  // Without acres in the picture at all, the same records and lines.
  const plain = dissolveParcelsByOwner(parcels.map(({ acres, ...p }) => p));
  assert.deepEqual(plain.flatMap(o => o.parcels.map(p => p.id)).sort(), drawn);
  assert.equal(JSON.stringify(plain.map(o => o.lines)), lines);
  assert.ok(drawn.includes(1) && drawn.includes(2), 'both clipped records keep their own strokes');
});

const orders = n => n <= 1 ? [[0]] : orders(n - 1).flatMap(o => Array.from({ length: n }, (_, i) => [...o.slice(0, i), n - 1, ...o.slice(i)]));

test('clipped and whole records of one parcel give the same estimate in every order', () => {
  const land = forty(1, 'SAMPLE FARMS LLC', 0, 0), next = forty(2, 'SAMPLE FARMS LLC', 1, 0);
  const clipped = { ...land, rings: [layout(box(0, 0, M / 2, M))], lines: [layout(box(0, 0, M / 2, M)).slice(0, 3)] };
  for (const records of [[land, clipped], [land, clipped, next]]) {
    const seen = new Set();
    for (const order of orders(records.length)) {
      // How the records group into outlines is the line drawing's own business; every label states the same size.
      for (const c of ownerLabelCandidates(dissolveParcelsByOwner(order.map(i => records[i])), { acreage: { merged: true, covered: all } }))
        seen.add(formatParcelArea(c.acreageM2, 'imperial', { approx: c.acreageApprox }));
    }
    assert.deepEqual([...seen], [records.length === 2 ? '~40.0 ac' : '~80.0 ac'], 'the whole footprint, never none');
  }
});

test('a repeated record does not use up the corner budget and split an owner total', () => {
  // B's corners split A's shared edge (a T-junction); B arrives twice.
  const a = { id: 1, owner: 'SAMPLE FARMS LLC', acres: 3.9, rings: [layout(box(0, 0, 200, 200))] };
  const b = { id: 2, owner: 'SAMPLE FARMS LLC', acres: 2.7, rings: [layout([[200, 50], [200, 150], [300, 150], [300, 50], [200, 50]])] };
  const records = [a, b, { ...b }];
  // Enough budget for A's edges against B's corners once, not twice.
  const splitBudget = 5 * 5;
  for (const order of orders(3)) {
    const outlines = dissolveParcelsByOwner(order.map(i => records[i]), { splitBudget });
    assert.equal(outlines.length, 1, `one outline (${order})`);
    const [c] = ownerLabelCandidates(outlines, { acreage: { merged: true, covered: all } });
    assert.equal(formatParcelArea(c.acreageM2, 'imperial', { approx: c.acreageApprox }), '6.6 ac', `${order}`);
  }
});

test('dense same-owner land past the corner budget is merged without running out of stack', () => {
  // Two long, finely drawn neighbours of one owner (0.5 m between corners, 300,000 corners each).
  const n = 300000, side = Array.from({ length: n }, (_, k) => [0, k * 0.5]);
  const strip = x => ({ owner: 'SAMPLE FARMS LLC', rings: [layout([...side.map(([, y]) => [x, y]), [x + 10, n * 0.5], [x + 10, 0], [x, 0]])] });
  const parcels = [{ id: 1, ...strip(0) }, { id: 2, ...strip(10) }];
  let outlines;
  assert.doesNotThrow(() => { outlines = dissolveParcelsByOwner(parcels); });
  assert.ok(outlines.length >= 1);
});
