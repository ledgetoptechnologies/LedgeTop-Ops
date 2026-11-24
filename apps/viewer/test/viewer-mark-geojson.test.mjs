import assert from 'node:assert/strict';
import test from 'node:test';
import { geoJsonToMarks, marksToGeoJson, IMPORT_LIMIT } from '../viewer-mark-geojson.mjs';
import { DEFAULT_COLOR, glyphColor, glyphSvg, pinSvg } from '../viewer-mark-icons.mjs';

let next = 0;
const newId = () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;

test('export and import round-trip style, category and NAVD88 elevation', () => {
  const categories = [{ id: 'c1', name: 'Gate', color: '#1e88e5', icon: 'gate' }];
  const marks = [
    { id: 'm1', geometry: { type: 'Point', coordinates: [-87, 43] }, name: 'North gate', note: 'Locked', categoryId: 'c1',
      color: '#1e88e5', icon: 'gate', elevationNavd88M: 250.5, visibility: 'shared' },
    { id: 'm2', geometry: { type: 'Polygon', coordinates: [[[-87, 43], [-87.1, 43], [-87.1, 43.1], [-87, 43]]] }, name: 'Field',
      note: '', categoryId: null, color: '#43a047', icon: 'pin', elevationNavd88M: null, visibility: 'private' },
  ];
  const exported = marksToGeoJson(marks, categories);
  assert.equal(exported.type, 'FeatureCollection');
  assert.equal(exported.features[0].properties['marker-color'], '#1e88e5');
  assert.equal(exported.features[0].properties.category, 'Gate');
  assert.equal(exported.features[0].properties.elevation_navd88_m, 250.5);
  assert.equal(exported.features[1].properties.fill, '#43a047');

  const imported = geoJsonToMarks(JSON.parse(JSON.stringify(exported)), { categories, newId, visibility: 'shared' });
  assert.equal(imported.categories.length, 0, 'existing categories are matched by name');
  assert.equal(imported.marks[0].categoryId, 'c1');
  assert.equal(imported.marks[0].icon, 'gate');
  assert.equal(imported.marks[0].elevationNavd88M, 250.5);
  assert.equal(imported.marks[0].note, 'Locked');
  assert.notEqual(imported.marks[0].id, 'm1', 'imports never reuse ids');
  assert.equal(imported.marks[1].color, '#43a047');
});

test('import splits multi-geometries, adds unknown categories and skips what it cannot hold', () => {
  const file = { type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'MultiPoint', coordinates: [[-87, 43, 300], [-87.01, 43.01]] }, properties: { title: 'Feeder', category: 'Feeder', color: '#F80' } },
    { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-87, 43], [-87.1, 43]]] }, properties: {} },
    { type: 'Feature', geometry: null, properties: { name: 'Nothing' } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[-87, 43], [-87.1, 43.1]] }, properties: { name: 'a\u0007b', 'marker-symbol': 'not-an-icon' } },
  ] };
  const result = geoJsonToMarks(file, { categories: [], newId });
  assert.equal(result.marks.length, 3);
  assert.equal(result.skipped, 2);
  assert.equal(result.categories.length, 1);
  assert.equal(result.categories[0].name, 'Feeder');
  assert.equal(result.categories[0].color, '#ff8800');
  assert.deepEqual(result.marks[0].geometry.coordinates, [-87, 43], 'third value dropped');
  assert.equal(result.marks[0].elevationNavd88M, null);
  assert.equal(result.marks[2].name, 'a b');
  assert.equal(result.marks[2].icon, 'not-an-icon', 'an icon this build does not know is kept');
  for (const bad of ['Not An Icon', '"><script>', '', 7, null]) {
    const { marks } = geoJsonToMarks({ type: 'Feature', geometry: { type: 'Point', coordinates: [-87, 43] }, properties: { 'marker-symbol': bad } }, { newId });
    assert.equal(marks[0].icon, 'pin');
  }
  const exported = marksToGeoJson([{ id: 'x', geometry: { type: 'Point', coordinates: [-87, 43] }, name: 'x', note: '', color: '#1e88e5', icon: 'future-icon' }]);
  assert.equal(geoJsonToMarks(exported, { newId }).marks[0].icon, 'future-icon');
  assert.throws(() => geoJsonToMarks({ type: 'FeatureCollection', features: Array.from({ length: IMPORT_LIMIT + 1 },
    () => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} })) }, { newId }), /up to 500/);
  assert.throws(() => geoJsonToMarks({ hello: 1 }, { newId }), /not GeoJSON/);
});

test('icon markup only uses the fixed table and a validated colour', () => {
  for (const svg of [pinSvg('"><script>', 'red" onload="x', 32, { selected: true, draft: true }), glyphSvg('"><script>', 'red" onload="x', 22), pinSvg('__proto__', 'x', 32)]) {
    assert.doesNotMatch(svg, /script|onload|undefined/);
    assert.match(svg, new RegExp(`fill="${DEFAULT_COLOR}"`));
  }
  assert.equal(glyphColor('#ffffff'), '#111111');
  assert.equal(glyphColor('#212121'), '#ffffff');
});
