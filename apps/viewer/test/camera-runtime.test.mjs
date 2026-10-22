import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraFeatureImageUpBearing, cameraFeatureMapPosition, normalizeCameraFeatureCollection, normalizeCameraPhotoKey } from '../camera-runtime.mjs';
import {
  CAMERA_MARKER_COLORS,
  CAMERA_MARKER_OPACITY,
  CAMERA_MARKER_STYLE,
  DEFAULT_CAMERA_MARKER_SCALE,
  cameraMarkerGeometryData,
  cameraMarkerScaleForView,
  selectCameraMarkerRepresentatives,
} from '../camera-markers.mjs';

test('WebODM camera features accept translation or geometry coordinates and skip malformed shots independently', () => {
  const converted = [];
  const features = normalizeCameraFeatureCollection({
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { filename: 'DJI_0001.JPG', translation: [500001, 4900001, 212], rotation: [0.1, 0.2, 0.3] }, geometry: null },
      { type: 'Feature', properties: { filename: 'images/DJI_0002.JPG' }, geometry: { type: 'Point', coordinates: [-87.2, 44.1, 215] } },
      { type: 'Feature', properties: { filename: 'missing.JPG', rotation: ['bad', 0, 0] }, geometry: { type: 'Point', coordinates: [500003, 4900003, 217] } },
      { type: 'Feature', properties: { filename: 'broken.JPG' }, geometry: { type: 'Point', coordinates: [null, 44, 200] } },
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
      null,
    ],
  }, {
    latLonToProjected: (lat, lon) => { converted.push([lat, lon]); return [500002, 4900002]; },
  });

  assert.equal(features.length, 3);
  assert.deepEqual(features[0].properties.translation, [500001, 4900001, 212]);
  assert.deepEqual(features[0].properties.rotation, [0.1, 0.2, 0.3]);
  assert.deepEqual(features[1].properties.translation, [500002, 4900002, 215]);
  assert.equal(features[1].properties.photoKey, 'images/DJI_0002.JPG');
  assert.deepEqual(features[2].properties.translation, [500003, 4900003, 217]);
  assert.deepEqual(features[2].properties.rotation, [0, 0, 0]);
  assert.deepEqual(converted, [[44.1, -87.2]]);
});

test('camera photo keys allow exact nested JPEG paths without allowing traversal', () => {
  assert.equal(normalizeCameraPhotoKey('images/originals/DJI_0001.jpeg'), 'images/originals/DJI_0001.jpeg');
  for (const value of ['../DJI.JPG', 'images/../DJI.JPG', '/images/DJI.JPG', 'images\\DJI.JPG', 'images//DJI.JPG', 'DJI.png']) {
    assert.equal(normalizeCameraPhotoKey(value), null, value);
  }
});

test('camera markers use a shared WebODM-inspired body, front cue, and LTDS image-up tab', () => {
  const geometry = cameraMarkerGeometryData();
  const bounds = (positions) => {
    const axes = [[], [], []];
    positions.forEach((value, index) => axes[index % 3].push(value));
    return axes.map((axis) => ({ min: Math.min(...axis), max: Math.max(...axis) }));
  };
  for (const key of ['body', 'face', 'cue', 'tab']) {
    assert.ok(geometry[key].length >= 18 && geometry[key].length % 9 === 0, `${key} primitive is triangulated`);
  }
  const [bodyX, bodyY, bodyZ] = bounds(geometry.body);
  const [faceX, faceY, faceZ] = bounds(geometry.face);
  const [cueX, cueY, cueZ] = bounds(geometry.cue);
  const [tabX, tabY, tabZ] = bounds(geometry.tab);
  assert.ok(bodyZ.min < 0 && bodyZ.max > 0, 'shallow body contains the camera position');
  assert.ok(faceZ.max < bodyZ.min, 'orange panel faces backward along local -Z');
  assert.ok(cueZ.min > bodyZ.max, 'amber octagon sits visibly in front of the light frame');
  assert.equal(geometry.cue.length, 8 * 9, 'one eight-sided forward cue');
  assert.ok(cueX.min > faceX.min && cueX.max < faceX.max);
  assert.ok(cueY.min > faceY.min && cueY.max < faceY.max);
  assert.ok(tabY.min < bodyY.min && tabY.max < 0, 'orange tab protrudes along local -Y/image-up');
  assert.ok(tabX.min > bodyX.min && tabX.max < bodyX.max);
  assert.ok(tabZ.min >= bodyZ.min && tabZ.max <= bodyZ.max);
  assert.deepEqual(CAMERA_MARKER_COLORS, { body: 0xD8DEE6, face: 0xEE5007, cue: 0xF8CB2E, tab: 0xEE5007 });
  assert.deepEqual(CAMERA_MARKER_OPACITY, { normal: 0.82, hover: 1 });
  assert.equal(DEFAULT_CAMERA_MARKER_SCALE, 0.5);
  const componentBounds = [geometry.body, geometry.face, geometry.cue, geometry.tab].map(bounds);
  const allX = { min: Math.min(...componentBounds.map(value => value[0].min)), max: Math.max(...componentBounds.map(value => value[0].max)) };
  const allY = { min: Math.min(...componentBounds.map(value => value[1].min)), max: Math.max(...componentBounds.map(value => value[1].max)) };
  const allZ = { min: Math.min(...componentBounds.map(value => value[2].min)), max: Math.max(...componentBounds.map(value => value[2].max)) };
  const markerDiameter = Math.hypot(
    allX.max - allX.min,
    allY.max - allY.min,
    allZ.max - allZ.min,
  );
  assert.deepEqual(CAMERA_MARKER_STYLE, {
    width: markerDiameter,
    maxPixels: 10,
    maxVisible: Infinity,
    pickRadius: 12,
  });
});

test('orthophoto camera placement prefers geographic geometry and otherwise uses the active projection', () => {
  const geographic = { geometry: { type: 'Point', coordinates: [-88.25, 43.1, 220] }, properties: { translation: [500000, 4800000, 220], rotation: [0, 0, 0] } };
  assert.deepEqual(cameraFeatureMapPosition(geographic, { projectedToLatLon: () => [1, 2] }), [43.1, -88.25]);
  const projected = { geometry: { type: 'Point', coordinates: [500000, 4800000, 220] }, properties: { translation: [500000, 4800000, 220], rotation: [0, 0, Math.PI / 2] } };
  assert.deepEqual(cameraFeatureMapPosition(projected, { projectedToLatLon: (e, n) => [n / 100000, e / 100000] }), [48, 5]);
  assert.equal(cameraFeatureMapPosition({ properties: {} }, { projectedToLatLon: () => [0, 0] }), null);
  assert.equal(cameraFeatureImageUpBearing(geographic), 180);
  assert.ok(Math.abs(cameraFeatureImageUpBearing(projected) - 270) < 1e-9, 'map tab follows inverse angle-axis applied to image-up (-Y)');
});

test('image-up follows shot roll and pitch rather than being forced world-up', async () => {
  const { Vector3, Quaternion } = await import('three');
  for (const rotation of [[0, 0, 0], [0, 0, Math.PI], [Math.PI / 2, 0, 0], [0.7, -0.4, 1.2]]) {
    const angle = Math.hypot(...rotation);
    const quaternion = angle ? new Quaternion().setFromAxisAngle(new Vector3(...rotation).multiplyScalar(-1 / angle), angle) : new Quaternion();
    const up = new Vector3(0, -1, 0).applyQuaternion(quaternion);
    const forward = new Vector3(0, 0, 1).applyQuaternion(quaternion);
    assert.ok(Math.abs(up.dot(forward)) < 1e-12, 'image-up remains perpendicular to optical direction');
    const expected = Math.hypot(up.x, up.y) <= 1e-9 ? 0 : (Math.atan2(up.x, up.y) * 180 / Math.PI + 360) % 360;
    assert.ok(Math.abs(cameraFeatureImageUpBearing({ properties: { rotation } }) - expected) < 1e-9);
  }
  assert.equal(cameraFeatureImageUpBearing({ properties: { rotation: [0, 0, Math.PI] } }), 0, 'a rolled shot reverses the tab bearing');
});

test('front octagon and rear orange panel have opposite outward triangle winding', () => {
  const geometry = cameraMarkerGeometryData();
  const normalZ = (positions) => {
    const [ax, ay, , bx, by, , cx, cy] = positions;
    return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  };
  assert.ok(normalZ(geometry.face) < 0, 'rear panel is visible from behind');
  assert.ok(normalZ(geometry.cue) > 0, 'front cue is visible in the capture direction');
});

test('camera marker scale remains fixed in world space across zoom and depth', () => {
  const requested = 0.7;
  const views = [
    { depth: 0.1, fovDegrees: 60, zoom: 10, viewportHeight: 900 },
    { depth: 3, fovDegrees: 35, zoom: 2, viewportHeight: 1440 },
    { depth: 200, fovDegrees: 90, zoom: 0.1, viewportHeight: 480 },
  ];
  for (const view of views) {
    assert.equal(cameraMarkerScaleForView({ baseScale: requested, ...view }), requested);
  }
  assert.equal(cameraMarkerScaleForView({ baseScale: 0.01, depth: 10, fovDegrees: 60, zoom: 1, viewportHeight: 900 }), 0.1);
  assert.equal(cameraMarkerScaleForView({ baseScale: 10, depth: 10, fovDegrees: 60, zoom: 1, viewportHeight: 900 }), 4);
});

test('dense camera projections retain every overlapping capture in stable source order', () => {
  const candidates = [
    { index: 0, x: 5, y: 5, depth: 20 },
    { index: 1, x: 7, y: 7, depth: 10 },
    { index: 2, x: 25, y: 5, depth: 30 },
    { index: 3, x: 95, y: 95, depth: 5 },
    { index: 4, x: -20, y: 20, depth: 2 },
    { index: 5, x: 50, y: 50, depth: -1 },
    { index: 6, x: Number.NaN, y: 10, depth: 1 },
  ];
  assert.deepEqual(selectCameraMarkerRepresentatives(candidates, { width: 100, height: 100 }), [0, 1, 2, 3]);
  assert.deepEqual(
    selectCameraMarkerRepresentatives(candidates, { width: 100, height: 100, maxVisible: 2 }),
    [0, 1],
    'an explicit cap uses source identity rather than nearest-depth winners',
  );
  assert.deepEqual(selectCameraMarkerRepresentatives(candidates, { width: 0, height: 100 }), []);
  assert.deepEqual(selectCameraMarkerRepresentatives(candidates, { width: Infinity, height: 100 }), []);
});

test('tiny pans, cell-boundary crossings, and orbit depth swaps never replace in-view cameras', () => {
  const candidates = [
    { index: 7, x: 17.9, y: 18.1, depth: 5 },
    { index: 3, x: 18.1, y: 17.9, depth: 5.1 },
    { index: 8, x: 18, y: 18, depth: 6 },
  ];
  for (const pan of [-8, -4, -2, -1, 0, 1, 2, 4, 8]) {
    const moved = candidates.map((candidate, index) => ({
      ...candidate, x: candidate.x + pan, y: candidate.y - pan,
      depth: index === 0 ? 20 : 4,
    })).reverse();
    assert.deepEqual(selectCameraMarkerRepresentatives(moved, { width: 100, height: 100 }), [3, 7, 8]);
  }
});

test('default marker inclusion has no hidden 4000-camera cap and deduplicates source IDs', () => {
  const candidates = Array.from({ length: 4500 }, (_, index) => ({ index, x: 50, y: 50, depth: 1 + index }));
  assert.deepEqual(
    selectCameraMarkerRepresentatives([...candidates, candidates[0]], { width: 100, height: 100 }),
    candidates.map(candidate => candidate.index),
  );
});
