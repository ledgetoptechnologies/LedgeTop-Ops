// Property lines: orange accent colour, owner labels, merging touching
// parcels of one owner and map-tile coverage around the model. Synthetic
// parcels and generic owner names only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND_COLORS } from '../brand-colors.mjs';
import { PROPERTY_LINE_STYLE } from '../property-lines-layer.mjs';
import {
  PROPERTY_LINES_LIMITS, childTiles, createParcelTileLoader, expandLonLatBounds, makeTile, mergeTileParcels,
  normalizeParcelResponse, parcelsToUtmPolylines, propertyLinesMessage, propertyLinesTilesForView,
} from '../property-lines.mjs';
import {
  dissolveParcelsByOwner, normalizeOwnerName, ownerLabelCandidates, ownerLabelFontPx, placeOwnerLabels, polygonLabelPoint, wrapOwnerLabel,
} from '../property-lines-owners.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// Squares on a 0.002-degree grid near a rural Wisconsin site (clockwise, closed, as Esri sends them).
const LON0 = -89.74, LAT0 = 44.81, STEP = 0.002;
const corner = (i, j) => [Math.round((LON0 + i * STEP) * 1e7) / 1e7, Math.round((LAT0 + j * STEP) * 1e7) / 1e7];
const square = (i, j, w = 1, h = 1) => [corner(i, j), corner(i, j + h), corner(i + w, j + h), corner(i + w, j), corner(i, j)];
const parcel = (id, owner, ring) => ({ id, rings: [ring], ...(owner == null ? {} : { owner }) });
const segments = outline => outline.lines.reduce((n, line) => n + line.length - 1, 0);
const close = (a, b) => Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;

test('colour: lines use the Viewer orange accent token everywhere, never the old yellow', () => {
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const accent = html.match(/--brand-orange:\s*(#[0-9a-f]{6})/i)[1].toLowerCase();
  assert.equal(BRAND_COLORS.orange.toLowerCase(), accent, 'generated token matches the CSS variable');
  assert.equal(PROPERTY_LINE_STYLE.color, BRAND_COLORS.orange, 'map and 3D lines');
  const { PARCEL_LINE_COLOR } = require('../public/pointcloud-parcels.js');
  assert.equal(`#${PARCEL_LINE_COLOR.toString(16).padStart(6, '0')}`, accent, 'point cloud lines');
  for (const file of ['property-lines-layer.mjs', 'public/pointcloud-parcels.js', 'index.html'])
    assert.doesNotMatch(readFileSync(path.join(root, file), 'utf8'), /FFD60A|255,\s*214,\s*10/i, file);
});

test('owner names: case, punctuation spacing and whitespace are normalized for matching', () => {
  assert.equal(normalizeOwnerName('  Sample   Farms\tllc '), 'SAMPLE FARMS LLC');
  assert.equal(normalizeOwnerName('SAMPLE FARMS, LLC.'), 'SAMPLE FARMS LLC');
  assert.equal(normalizeOwnerName('sample farms llc'), normalizeOwnerName('SAMPLE  FARMS LLC'));
  assert.notEqual(normalizeOwnerName('SAMPLE FARMS LLC'), normalizeOwnerName('SAMPLE FARM LLC'));
  for (const empty of [undefined, null, '', '   ', 42]) assert.equal(normalizeOwnerName(empty), '');
});

test('merge by owner: touching parcels of one owner become one outline; different owners do not', () => {
  const parcels = [
    parcel(1, 'SAMPLE FARMS LLC', square(0, 0)),
    parcel(2, '  sample farms   llc', square(1, 0)),       // same owner, other case and spacing, shares an edge
    parcel(3, 'EXAMPLE OWNER', square(2, 0)),             // touches parcel 2, different owner
    parcel(4, 'SAMPLE FARMS LLC', square(5, 0)),          // same owner, not touching
    parcel(5, null, square(0, 1)),                        // no owner
  ];
  const merged = dissolveParcelsByOwner(parcels);
  assert.equal(merged.length, 4);
  const farm = merged.find(o => o.parcelIds.includes(1));
  assert.deepEqual(farm.parcelIds.sort(), [1, 2], 'one outline for the two touching parcels');
  assert.equal(farm.owner, 'SAMPLE FARMS LLC');
  assert.equal(farm.lines.length, 1, 'one closed outline');
  assert.equal(segments(farm), 6, 'the shared edge is gone: 2 x 1 rectangle drawn as 6 unit edges');
  const loop = farm.lines[0];
  assert.ok(close(loop[0], loop[loop.length - 1]), 'outline closes');
  // The shared edge x = 1 between y = 0 and 1 is not drawn as a segment.
  const sharedEdge = [corner(1, 0), corner(1, 1)];
  for (let k = 1; k < loop.length; k++) {
    const seg = [loop[k - 1], loop[k]];
    assert.ok(!(close(seg[0], sharedEdge[0]) && close(seg[1], sharedEdge[1])) && !(close(seg[0], sharedEdge[1]) && close(seg[1], sharedEdge[0])));
  }
  assert.deepEqual(merged.find(o => o.parcelIds.includes(3)).parcelIds, [3], 'a different owner keeps its own outline');
  assert.deepEqual(merged.find(o => o.parcelIds.includes(4)).parcelIds, [4], 'same owner but not touching stays separate');
  assert.equal(merged.find(o => o.parcelIds.includes(5)).owner, '', 'no owner: never merged, no label');

  // Raw parcels stay available: merge off draws every parcel.
  const raw = dissolveParcelsByOwner(parcels, { merge: false });
  assert.equal(raw.length, 5);
  assert.ok(raw.every(o => o.parcelIds.length === 1));
});

test('merge by owner: a corner on one side only (T-junction) is reconciled within the budget, not beyond it', () => {
  // Parcel B's left edge has a midpoint vertex that parcel A's right edge lacks.
  const a = square(0, 0);
  const b = [corner(1, 0), [corner(1, 0)[0], (corner(1, 0)[1] + corner(1, 1)[1]) / 2], corner(1, 1), corner(2, 1), corner(2, 0), corner(1, 0)];
  const pair = [parcel(1, 'SAMPLE FARMS LLC', a), parcel(2, 'Sample Farms LLC', b)];
  const [outline] = dissolveParcelsByOwner(pair);
  assert.deepEqual(outline.parcelIds, [1, 2]);
  assert.equal(outline.lines.length, 1);
  assert.equal(segments(outline), 6);
  // Without reconciliation the shared stretch has no matching opposite edge:
  // it stays drawn, and these two parcels (joined by nothing else) stay apart.
  const unreconciled = dissolveParcelsByOwner(pair, { splitBudget: 0 });
  assert.equal(unreconciled.length, 2);
  assert.equal(unreconciled.reduce((n, o) => n + segments(o), 0), 4 + 5, 'every edge of both parcels still drawn');
  // Shared corners that already match need no reconciliation and still dissolve.
  assert.equal(dissolveParcelsByOwner([pair[0], parcel(3, 'SAMPLE FARMS LLC', square(1, 0))], { splitBudget: 0 }).length, 1);
});

test('merge by owner: dense same-owner land over the default budget falls back to matching corners only', () => {
  // Two parcels with 1,600-point bottom edges (edges x neighbouring corners
  // about 2.6 million, over the 2 million budget) and a T-junction between them.
  // 630 m edges, so the 1,600 corners are about 0.4 m apart (more than the 0.2 m snap).
  const dense = (i, j) => {
    const [x0, y0] = corner(i, j), [x1] = corner(i + 4, j);
    return Array.from({ length: 1600 }, (_, k) => [x0 + (x1 - x0) * k / 1600, y0]);
  };
  const a = [...dense(0, 0), corner(4, 0), corner(4, 4), corner(0, 4), corner(0, 0)];
  const b = [...dense(4, 0), corner(8, 0), corner(8, 4), corner(4, 4), [corner(4, 0)[0], (corner(4, 0)[1] + corner(4, 4)[1]) / 2], corner(4, 0)];
  const pair = [parcel(1, 'SAMPLE FARMS LLC', a), parcel(2, 'SAMPLE FARMS LLC', b)];
  const started = performance.now();
  const fallback = dissolveParcelsByOwner(pair);
  assert.ok(performance.now() - started < 2000, 'bounded work');
  assert.equal(fallback.length, 2, 'over budget: the T-junction is not reconciled, so the stretch stays drawn');
  assert.ok(fallback.every(o => o.lines.length === 1));
  assert.equal(dissolveParcelsByOwner(pair, { splitBudget: Infinity }).length, 1, 'with an unlimited budget the same pair dissolves');
});

test('merge by owner: orientation of the source rings does not matter; an L of three parcels merges into one', () => {
  const anticlockwise = ring => ring.slice().reverse();
  const outlines = dissolveParcelsByOwner([
    parcel(1, 'EXAMPLE TRUST', square(0, 0)), parcel(2, 'EXAMPLE TRUST', anticlockwise(square(1, 0))), parcel(3, 'example trust', square(0, 1)),
  ]);
  assert.equal(outlines.length, 1);
  assert.equal(outlines[0].lines.length, 1);
  assert.equal(segments(outlines[0]), 8, 'L shape of three unit squares has 8 unit edges');
});

test('labels: placed inside the shape, one per merged outline, sized by zoom, hidden when too small, never overlapping', () => {
  // An L-shaped polygon whose centroid falls outside it.
  const L = [[0, 0], [0, 100], [10, 100], [10, 10], [100, 10], [100, 0], [0, 0]];
  const point = polygonLabelPoint([L]);
  // Arms are 10 wide; the widest spot is at the inner corner (about 5.9).
  assert.ok(point.distance > 4.5 && point.distance < 7.1, `inscribed radius ${point.distance}`);
  assert.ok((point.x < 10 || point.y < 10) && point.x > 0 && point.y > 0, 'inside the L, not at its centroid');

  const parcels = [
    parcel(1, 'SAMPLE FARMS LLC', square(0, 0, 2, 2)), parcel(2, 'SAMPLE FARMS LLC', square(2, 0, 2, 2)),
    parcel(3, 'EXAMPLE OWNER', square(0, 2, 4, 1)),
    // a sliver: 3 m wide
    parcel(4, 'SLIVER OWNER', [corner(4, 0), [corner(4, 0)[0], corner(4, 3)[1]], [corner(4, 0)[0] + 0.00004, corner(4, 3)[1]], [corner(4, 0)[0] + 0.00004, corner(4, 0)[1]], corner(4, 0)]),
  ];
  const candidates = ownerLabelCandidates(dissolveParcelsByOwner(parcels));
  assert.equal(candidates.filter(c => c.text === 'SAMPLE FARMS LLC').length, 1, 'one label for the merged outline');
  const farm = candidates.find(c => c.text === 'SAMPLE FARMS LLC');
  assert.ok(farm.lon > corner(0, 0)[0] && farm.lon < corner(4, 0)[0] && farm.lat > corner(0, 0)[1] && farm.lat < corner(0, 2)[1], 'inside the merged land');
  // Web Mercator pixels at a given zoom.
  const projectAt = zoom => (lon, lat) => {
    const n = 256 * 2 ** zoom, x = (lon + 180) / 360 * n;
    const y = (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * n;
    return [x - (LON0 + 180) / 360 * n + 1000, y - (1 - Math.log(Math.tan(Math.PI / 4 + LAT0 * Math.PI / 360)) / Math.PI) / 2 * n + 1000];
  };
  const measure = (text, px) => text.length * px * 0.6;
  const at = zoom => placeOwnerLabels(candidates, { zoom, project: projectAt(zoom), viewport: { width: 2000, height: 2000 }, measure });
  assert.deepEqual(at(13), [], 'no names when zoomed out');
  const z17 = at(17);
  assert.deepEqual(z17.map(l => l.text).sort(), ['EXAMPLE OWNER', 'SAMPLE FARMS LLC'], 'the sliver gets no label');
  assert.ok(at(15).length <= z17.length);
  assert.ok(ownerLabelFontPx(18) > ownerLabelFontPx(15), 'text grows with zoom');
  assert.equal(ownerLabelFontPx(25), 15, 'and stops growing');
  for (const [i, a] of z17.entries()) for (const b of z17.slice(i + 1))
    assert.ok(Math.abs(a.x - b.x) * 2 >= a.width + b.width || Math.abs(a.y - b.y) * 2 >= a.height + b.height, 'no overlap');
  // Two candidates at the same spot: only the bigger outline keeps its label.
  const clash = placeOwnerLabels([{ ...farm, text: 'SMALL OWNER', areaM2: farm.areaM2 / 2 }, farm], { zoom: 17, project: projectAt(17), viewport: null, measure });
  assert.deepEqual(clash.map(l => l.text), ['SAMPLE FARMS LLC']);
  assert.deepEqual(wrapOwnerLabel('SAMPLE FAMILY FARMS LIMITED PARTNERSHIP'), ['SAMPLE FAMILY FARMS', 'LIMITED PARTNERSHIP']);
  assert.equal(wrapOwnerLabel('X'.repeat(60))[0].length, 40, 'very long names are cut');
});

test('viewport coverage: zoomed out, tiles cover the visible map around the model, within limits', () => {
  const model = { west: -89.742, south: 44.809, east: -89.738, north: 44.812 };
  // A view about 20 km wide: tiles stop at the coverage around the model.
  const wide = { west: -89.87, south: 44.75, east: -89.61, north: 44.87 };
  const plan = propertyLinesTilesForView({ modelBounds: model, viewBounds: wide, zoom: 13 });
  assert.equal(plan.status, 'ok');
  const coverage = expandLonLatBounds(model, PROPERTY_LINES_LIMITS.coverageMeters);
  assert.ok(plan.tiles.length > 9 && plan.tiles.length <= PROPERTY_LINES_LIMITS.maxTiles, `${plan.tiles.length} tiles`);
  for (const tile of plan.tiles) {
    assert.equal(tile.z, PROPERTY_LINES_LIMITS.tileZoom);
    assert.ok(tile.bounds.west < coverage.east && tile.bounds.east > coverage.west && tile.bounds.south < coverage.north && tile.bounds.north > coverage.south);
  }
  const covered = plan.tiles.reduce((b, t) => ({ west: Math.min(b.west, t.bounds.west), east: Math.max(b.east, t.bounds.east), south: Math.min(b.south, t.bounds.south), north: Math.max(b.north, t.bounds.north) }), { west: 180, east: -180, south: 90, north: -90 });
  assert.ok(covered.west <= coverage.west && covered.east >= coverage.east && covered.south <= coverage.south && covered.north >= coverage.north, 'the whole coverage is tiled');
  assert.ok(covered.east - covered.west > 0.1, 'kilometres beyond the model, not just its extent');
  for (let k = 1; k < plan.tiles.length; k++) assert.ok(plan.tiles[k].distance >= plan.tiles[k - 1].distance, 'nearest the centre first');
  // Zoomed in: only the tiles in view.
  const close = propertyLinesTilesForView({ modelBounds: model, viewBounds: { west: -89.742, south: 44.809, east: -89.738, north: 44.812 }, zoom: 17 });
  assert.ok(close.tiles.length >= 1 && close.tiles.length <= 4);
  // Limits.
  assert.equal(propertyLinesTilesForView({ modelBounds: model, viewBounds: wide, zoom: PROPERTY_LINES_LIMITS.minMapZoom - 1 }).status, 'zoom_in');
  assert.equal(propertyLinesMessage('zoom_in'), 'Zoom in to see property lines.');
  assert.equal(propertyLinesTilesForView({ modelBounds: model, viewBounds: { west: -88.1, south: 43.0, east: -88.0, north: 43.1 }, zoom: 15 }).status, 'out_of_view');
  assert.equal(propertyLinesTilesForView({ modelBounds: null, viewBounds: wide, zoom: 15 }).status, 'unknown');
  const capped = propertyLinesTilesForView({ modelBounds: model, viewBounds: wide, zoom: 13, limits: { ...PROPERTY_LINES_LIMITS, maxTiles: 5 } });
  assert.equal(capped.tiles.length, 5);
  assert.equal(capped.partial, true);
  assert.equal(propertyLinesMessage('ready', { count: 3, partial: true }), 'Zoom in to see more property lines.');
  assert.equal(propertyLinesMessage('ready', { count: 3 }), '', 'drawn lines need no words in the card');
});

test('tile loader: parcels once across tiles, cached tiles reused, dense tiles split, edge and access answers', async () => {
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const shared = parcel(7, 'SAMPLE FARMS LLC', square(0, 0));
  const tileA = makeTile(14, 4107, 5880), tileB = makeTile(14, 4108, 5880), tileC = makeTile(14, 4109, 5880), tileD = makeTile(14, 4110, 5880);
  const calls = [];
  const loader = createParcelTileLoader({ debounceMs: 0, model: () => 'model-1', fetchImpl: async url => {
    calls.push(url);
    const params = new URL(url, 'http://x').searchParams;
    assert.deepEqual([...params.keys()], ['tile', 'model'], 'tile key and model only, never a box');
    const box = params.get('tile');
    const is = tile => box === tile.key;
    if (is(tileA)) return reply({ status: 'ok', parcels: [shared, parcel(8, 'EXAMPLE OWNER', square(1, 0))] });
    if (is(tileB)) return reply({ status: 'ok', parcels: [shared] });
    if (is(tileC)) return reply({ status: 'too_many', parcels: [] });
    if (is(tileD)) return reply({ code: 'outside_model' }, 403);
    return reply({ status: 'ok', parcels: [parcel(Number(box.length), null, square(3, 3))] }); // tileC's children
  } });
  const first = await loader.load([tileA, tileB]);
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.parcels.map(p => p.id).sort(), [7, 8], 'the parcel on both tiles is kept once');
  assert.equal(first.parcels.find(p => p.id === 7).owner, 'SAMPLE FARMS LLC');
  assert.equal(calls.length, 2);
  await loader.load([tileB, tileA]);
  assert.equal(calls.length, 2, 'cached tiles are not fetched again');
  assert.equal(loader.cached([tileA, tileB]), true);

  const area = { ...tileC.bounds, east: (tileC.bounds.west + tileC.bounds.east) / 2 - 1e-4 };
  const split = await loader.load([tileC], { area });
  assert.equal(split.status, 'ok');
  assert.equal(calls.length, 3 + childTiles(tileC, area).length, 'only the children in view are fetched');
  assert.equal(childTiles(tileC, area).length, 2);

  assert.equal((await loader.load([tileD])).status, 'outside', 'a tile beyond the model coverage is empty, not an access error');
  const denied = createParcelTileLoader({ debounceMs: 0, fetchImpl: async () => reply({}, 403) });
  assert.equal((await denied.load([tileA])).status, 'forbidden');
  assert.equal(mergeTileParcels([{ parcels: [shared] }, { parcels: [shared] }]).length, 1);
});

test('responses keep only geometry, id and a plain owner name', () => {
  const body = normalizeParcelResponse({ status: 'ok', parcels: [
    { id: 1, rings: [square(0, 0)], owner: ' SAMPLE\u0000 FARMS\nLLC ', SITEADRESS: '1 Main St', OWNERNME2: 'x' },
    { id: 2, rings: [square(1, 0)], owner: 42 },
  ] });
  assert.deepEqual(body.parcels.map(p => Object.keys(p).sort()), [['id', 'owner', 'rings'], ['id', 'rings']]);
  assert.equal(body.parcels[0].owner, 'SAMPLE FARMS LLC');
});

test('cutoff: a parcel crossing the coverage cutoff is never stroked along the cut (raw, merged, map lines and 3D)', () => {
  const { clipParcels } = require('../server/propertyLines.js');
  // The authorized envelope ends at x = 3 (a cutoff through the middle of the parcels).
  const cutLon = corner(3, 0)[0];
  const envelope = { west: corner(-2, 0)[0], south: corner(0, -2)[1], east: cutLon, north: corner(0, 6)[1] };
  // Two same-owner parcels stacked north-south, both reaching x = 5, past the cutoff, and a third owner's parcel.
  const upstream = { status: 'ok', parcels: [
    parcel(1, 'SAMPLE FARMS LLC', square(0, 0, 5, 2)), parcel(2, 'sample farms llc', square(0, 2, 5, 2)), parcel(3, 'EXAMPLE OWNER', square(0, 4, 5, 1)),
  ] };
  const clipped = clipParcels(upstream, envelope);
  assert.ok(clipped.parcels.every(p => Array.isArray(p.cuts)), 'the server names the cut segments');
  for (const p of clipped.parcels) for (const ring of p.rings) assert.ok(ring.every(([lon]) => lon <= cutLon), 'geometry stays inside the envelope');
  const parcels = normalizeParcelResponse(JSON.parse(JSON.stringify(clipped))).parcels; // as the browser receives it
  assert.ok(parcels.every(p => p.cuts?.some(c => c.length)), 'cuts survive the browser check');
  const onCut = ([a, b]) => Math.abs(a[0] - cutLon) < 1e-9 && Math.abs(b[0] - cutLon) < 1e-9;
  const segmentsOf = lines => lines.flatMap(line => line.slice(1).map((point, k) => [line[k], point]));
  for (const merge of [true, false]) {
    const outlines = dissolveParcelsByOwner(parcels, { merge });
    assert.equal(outlines.length, merge ? 2 : 3);
    const drawn = segmentsOf(outlines.flatMap(o => o.lines));
    assert.ok(drawn.length > 0);
    assert.equal(drawn.filter(onCut).length, 0, `no stroke along the cutoff (${merge ? 'merged' : 'raw'})`);
    // The real boundary up to the cutoff is still drawn: the top and bottom edges reach it.
    assert.ok(drawn.some(([a, b]) => Math.max(a[0], b[0]) === cutLon), 'real edges run up to the cutoff');
    // 3D uses the same stroke lines.
    const projectLonLat = (lat, lon) => [lon * 1e5, lat * 1e5];
    const { lines: utm } = parcelsToUtmPolylines(outlines.map(o => ({ rings: o.lines })), projectLonLat, { densifyMeters: 0 });
    assert.equal(segmentsOf(utm).filter(([a, b]) => Math.abs(a[0] - cutLon * 1e5) < 1e-4 && Math.abs(b[0] - cutLon * 1e5) < 1e-4).length, 0, '3D');
  }
  // Labels still use the whole clipped shape.
  const candidates = ownerLabelCandidates(dissolveParcelsByOwner(parcels));
  assert.ok(candidates.every(c => c.lon < cutLon && c.lon > envelope.west));
  // The merged owner is one stroke run, open at the cutoff, without its shared internal edge.
  const farm = dissolveParcelsByOwner(parcels).find(o => o.ownerKey === 'SAMPLE FARMS LLC');
  assert.equal(farm.lines.length, 1, 'one open run');
  assert.ok(segmentsOf(farm.lines).every(([a, b]) => !(a[1] === corner(0, 2)[1] && b[1] === corner(0, 2)[1])), 'the shared edge between the two parcels is removed');
});
