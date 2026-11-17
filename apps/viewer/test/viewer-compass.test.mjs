import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import {
  bearingDegrees, cameraBasisFromMatrixElements, cardinalFor, compassState, createCompass,
  displayHeading, gridToTrueHeading, headingFromCameraMatrix, normalizeDegrees, photoCameraBasis, photoGridHeading,
  rotateByAngleAxis, threeWorldToEnu, trueNorthGridBearing, viewCompassInput, viewHeadingFromBasis,
} from '../viewer-compass.mjs';
import * as compassModule from '../viewer-compass.mjs';
import { cameraFeatureImageUpBearing } from '../camera-runtime.mjs';
import { createUtmProjection } from '../utm-conversion.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const near = (actual, expected, tolerance = 1e-6, message = '') => {
  assert.ok(actual !== null && Number.isFinite(actual), `${message} expected a number, got ${actual}`);
  // Compare on the circle so 359.9999 and 0 are equal.
  const delta = Math.abs(((actual - expected) % 360 + 540) % 360 - 180);
  assert.ok(delta <= tolerance, `${message} expected ${expected}, got ${actual}`);
};
const rad = degrees => degrees * Math.PI / 180;
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// Build an OpenSfM shot rotation (world-to-camera angle-axis) for a camera
// facing `heading` (degrees clockwise from grid north), pitched down by
// `pitchDown` degrees, with no roll. Camera axes: +X right, +Y image-down,
// +Z forward. World: x east, y north, z up.
function shotRotation(heading, pitchDown) {
  const h = rad(heading), p = rad(pitchDown);
  const forward = [Math.sin(h) * Math.cos(p), Math.cos(h) * Math.cos(p), -Math.sin(p)];
  const right = [Math.cos(h), -Math.sin(h), 0];
  const down = cross(forward, right);
  // Camera-to-world M has columns right, down, forward; world-to-camera R = M^T.
  const R = [right, down, forward]; // rows of R are the camera axes in world coordinates
  const trace = R[0][0] + R[1][1] + R[2][2];
  const angle = Math.acos(Math.max(-1, Math.min(1, (trace - 1) / 2)));
  if (angle < 1e-9) return [0, 0, 0];
  if (Math.PI - angle < 1e-6) {
    // Half-turn: axis from the symmetric part (R + I) / 2.
    const diag = [0, 1, 2].map(i => Math.sqrt(Math.max(0, (R[i][i] + 1) / 2)));
    const i = diag.indexOf(Math.max(...diag));
    const axis = [0, 0, 0];
    axis[i] = diag[i];
    for (const j of [0, 1, 2]) if (j !== i) axis[j] = (R[i][j] + R[j][i]) / (4 * diag[i]);
    return axis.map(value => value * angle);
  }
  const s = 2 * Math.sin(angle);
  return [(R[2][1] - R[1][2]) / s, (R[0][2] - R[2][0]) / s, (R[1][0] - R[0][1]) / s].map(value => value * angle);
}

test('degrees normalize and wrap around 0/360 without returning 360 or -0', () => {
  assert.equal(normalizeDegrees(0), 0);
  assert.equal(normalizeDegrees(360), 0);
  assert.equal(normalizeDegrees(-1), 359);
  assert.equal(normalizeDegrees(720.5), 0.5);
  assert.ok(Object.is(normalizeDegrees(-0), 0));
  assert.equal(normalizeDegrees(-360), 0);
  for (const bad of [NaN, Infinity, null, undefined, '', 'north']) assert.equal(normalizeDegrees(bad), null);
  assert.equal(displayHeading(359.6), 0, 'rounds to 0, never 360');
  assert.equal(displayHeading(359.4), 359);
  assert.equal(displayHeading(-0.4), 0);
  assert.equal(displayHeading(null), null);
  assert.equal(cardinalFor(10), 'N');
  assert.equal(cardinalFor(350), 'N');
  assert.equal(cardinalFor(135), 'SE');
  assert.equal(cardinalFor(270), 'W');
  assert.equal(bearingDegrees(0, 0), null);
  near(bearingDegrees(-1, 0), 270);
});

test('grid-to-true conversion wraps around north in both directions', () => {
  near(gridToTrueHeading(0.5, 1.2), 359.3);
  near(gridToTrueHeading(359.5, -1), 0.5);
  near(gridToTrueHeading(90, 0), 90);
  assert.equal(gridToTrueHeading(null, 1), null);
  near(gridToTrueHeading(45, null), 45, 1e-9, 'missing convergence leaves the grid heading');
});

test('view heading follows forward when tilted and screen-up when looking straight down', () => {
  // Straight down: forward has no horizontal part, so screen-up decides.
  near(viewHeadingFromBasis({ forward: [0, 0, -1], up: [0, 1, 0] }), 0, 1e-9, 'down, north-up');
  near(viewHeadingFromBasis({ forward: [0, 0, -1], up: [1, 0, 0] }), 90, 1e-9, 'down, east-up');
  near(viewHeadingFromBasis({ forward: [0, 0, -1], up: [-Math.SQRT1_2, -Math.SQRT1_2, 0] }), 225, 1e-9, 'down, south-west-up');
  // Tilted down 30 degrees facing east.
  const c = Math.cos(rad(30)), s = Math.sin(rad(30));
  near(viewHeadingFromBasis({ forward: [c, 0, -s], up: [s, 0, c] }), 90);
  // Horizontal, facing north.
  near(viewHeadingFromBasis({ forward: [0, 1, 0], up: [0, 0, 1] }), 0);
  // Looking up from below a model, facing west: screen-up leans east (backwards).
  near(viewHeadingFromBasis({ forward: [-c, 0, s], up: [s, 0, c] }), 270);
  near(viewHeadingFromBasis({ forward: [-0.2, 0, 0.98], up: [0.98, 0, 0.2] }), 270, 1e-9, 'steeply up');
  // Degenerate or missing input.
  assert.equal(viewHeadingFromBasis({ forward: [0, 0, -1], up: [0, 0, 1] }), null);
  assert.equal(viewHeadingFromBasis({ forward: [0, 0, -1] }), null);
  assert.equal(viewHeadingFromBasis({ forward: [NaN, 0, 0], up: [0, 0, 1] }), null);
  assert.equal(viewHeadingFromBasis(), null);
});

test('main Viewer three.js cameras map to compass headings through the model frame (north = -z)', () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  const heading = (position, target) => {
    camera.up.set(0, 1, 0);
    camera.position.set(...position);
    camera.lookAt(...target);
    camera.updateMatrixWorld(true);
    const local = cameraBasisFromMatrixElements(camera.matrixWorld.elements);
    return viewHeadingFromBasis({ forward: threeWorldToEnu(local.forward), up: threeWorldToEnu(local.up) });
  };
  near(heading([0, 100, 50], [0, 0, 0]), 0, 1e-6, 'south of target looking north');
  near(heading([-50, 100, 0], [0, 0, 0]), 90, 1e-6, 'west of target looking east');
  near(heading([0, 100, -50], [0, 0, 0]), 180, 1e-6, 'north of target looking south');
  near(heading([50, 100, 0], [0, 0, 0]), 270, 1e-6, 'east of target looking west');
  near(heading([-1, 0, 1], [0, 0, 0]), 45, 1e-6, 'horizontal north-east');

  // Straight down with screen-up set explicitly (as EarthLikeControls keeps
  // the previous right axis near the pole): screen-up east means heading 90.
  camera.position.set(0, 100, 0);
  camera.up.set(1, 0, 0);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  const down = cameraBasisFromMatrixElements(camera.matrixWorld.elements);
  near(viewHeadingFromBasis({ forward: threeWorldToEnu(down.forward), up: threeWorldToEnu(down.up) }), 90);
  assert.deepEqual(threeWorldToEnu([1, 2, 3]), [1, -3, 2]);
  assert.equal(threeWorldToEnu([1, 2]), null);
  assert.equal(cameraBasisFromMatrixElements(null), null);
  assert.equal(cameraBasisFromMatrixElements([1, 2, 3]), null);
});

test('allocation-free matrix heading matches the basis maths in both frames', () => {
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  for (const [position, target, up] of [[[0, 100, 50], [0, 0, 0], [0, 1, 0]], [[-1, 0, 1], [0, 0, 0], [0, 1, 0]], [[3, -40, -7], [0, 0, 0], [0, 1, 0]], [[0, 100, 0], [0, 0, 0], [-1, 0, 1]]]) {
    camera.up.set(...up); camera.position.set(...position); camera.lookAt(...target); camera.updateMatrixWorld(true);
    const elements = camera.matrixWorld.elements, local = cameraBasisFromMatrixElements(elements);
    near(headingFromCameraMatrix(elements, 'three'), viewHeadingFromBasis({ forward: threeWorldToEnu(local.forward), up: threeWorldToEnu(local.up) }), 1e-9, `three ${position}`);
    near(headingFromCameraMatrix(Float64Array.from(elements), 'enu'), viewHeadingFromBasis(local), 1e-9, `enu ${position}`);
  }
  assert.equal(headingFromCameraMatrix(null), null);
  assert.equal(headingFromCameraMatrix(new Float64Array(8)), null);
  assert.equal(headingFromCameraMatrix(new Array(16).fill(NaN), 'three'), null);
});

// The real main.js updateViewCompass, evaluated with stubbed Viewer state, so a
// dropped or misapplied frame conversion or swapped convergence fails here.
function loadUpdateViewCompass(main) {
  const start = main.indexOf('function updateViewCompass() {');
  const end = main.indexOf('\nfunction ', start + 10);
  assert.ok(start > 0 && end > start);
  return new Function('env', `let { viewCompass, state, isMapMode, pcApi, camera, COMPASS_NORTH_GRID_BEARING, viewCompassInput } = env;
${main.slice(start, end)}
return updateViewCompass;`);
}

test('main.js updateViewCompass reads each surface through the right frame and convergence', () => {
  const main = readFileSync(path.join(root, 'main.js'), 'utf8');
  const factory = loadUpdateViewCompass(main);
  const run = ({ mode, cloudMode = 'potree', north = 1.5, potreeMatrix = null, threeCamera = null }) => {
    const calls = [], visibility = [];
    const viewCompass = { update: input => calls.push(input), setVisible: value => visibility.push(value) };
    const update = factory({
      viewCompass, state: { activeMode: mode, cloudMode },
      isMapMode: value => ['ortho', 'dsm', 'dtm'].includes(value),
      pcApi: () => (potreeMatrix ? { getViewMatrix: () => potreeMatrix } : null),
      camera: threeCamera, COMPASS_NORTH_GRID_BEARING: north, viewCompassInput: compassModule.viewCompassInput,
    });
    update();
    return { input: calls[0], visible: visibility.at(-1) };
  };
  const three = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  three.position.set(-1, 100, 1); three.lookAt(0, 0, 0); three.updateMatrixWorld(true); // grid north-east (45)
  const model = run({ mode: 'model', threeCamera: three });
  assert.equal(model.visible, true);
  near(model.input.heading, 43.5, 1e-6, 'model: grid 45 minus true-north grid bearing 1.5');
  near(run({ mode: 'cloud', cloudMode: 'direct', threeCamera: three }).input.heading, 43.5, 1e-6, 'direct cloud uses the three.js frame');
  // Potree is raw ENU. Yaw -90 faces east (grid 90); with north grid bearing -1.2 the true heading is 91.2.
  const potree = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  potree.rotation.order = 'ZXY'; potree.rotation.set(Math.PI / 2 - 0.5, 0, -Math.PI / 2); potree.updateMatrixWorld(true);
  near(run({ mode: 'cloud', north: -1.2, potreeMatrix: Float64Array.from(potree.matrixWorld.elements), threeCamera: three }).input.heading, 91.2, 1e-6, 'potree');
  assert.equal(run({ mode: 'cloud', threeCamera: three }).input.unknownReason, 'the view is still loading', 'potree not ready: never falls back to the hidden three.js camera');
  assert.deepEqual(run({ mode: 'dsm', north: null }).input, { heading: 0, surface: 'map' });
  assert.equal(run({ mode: 'model', north: null, threeCamera: three }).input.heading, null);
  assert.equal(run({ mode: null }).visible, false);
});

test('viewCompassInput states', () => {
  assert.equal(viewCompassInput({ mode: null }), null);
  assert.deepEqual(viewCompassInput({ mode: 'ortho', mapMode: true }), { heading: 0, surface: 'map' });
  assert.match(viewCompassInput({ mode: 'model', northGridBearing: null }).unknownReason, /no verified georeference/);
  assert.match(viewCompassInput({ mode: 'model', northGridBearing: 0, threeMatrix: null }).unknownReason, /still loading/);
});

test('Potree camera matrices are already east/north/up', () => {
  // Potree camera rotation is ZXY with rotation.x = pi/2 + pitch, rotation.z = yaw.
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.rotation.order = 'ZXY';
  const heading = (yaw, pitch) => {
    camera.rotation.set(Math.PI / 2 + pitch, 0, yaw);
    camera.updateMatrixWorld(true);
    return viewHeadingFromBasis(cameraBasisFromMatrixElements(camera.matrixWorld.elements));
  };
  near(heading(0, rad(-30)), 0, 1e-6, 'yaw 0 faces +y (north)');
  near(heading(rad(-90), rad(-30)), 90, 1e-6, 'negative yaw turns clockwise to east');
  near(heading(rad(90), rad(-89.9)), 270, 1e-6, 'nearly straight down keeps the yaw');
  near(heading(rad(180), -Math.PI / 2), 180, 1e-6, 'exactly straight down');
});

test('photo heading from OpenSfM rotation: known rotations give known headings', () => {
  // Nadir, image-up north: camera-to-world is a half-turn about east.
  near(photoGridHeading([Math.PI, 0, 0]), 0, 1e-9, 'nadir north-up');
  // Nadir, image-up east: half-turn about (east - north) / sqrt(2).
  near(photoGridHeading([Math.PI * Math.SQRT1_2, -Math.PI * Math.SQRT1_2, 0]), 90, 1e-9, 'nadir east-up');
  for (const heading of [0, 0.4, 37, 90, 179.5, 180, 263, 270, 359.4]) {
    near(photoGridHeading(shotRotation(heading, 90)), heading, 1e-6, `nadir ${heading}`);
    near(photoGridHeading(shotRotation(heading, 45)), heading, 1e-6, `oblique 45 ${heading}`);
    near(photoGridHeading(shotRotation(heading, 10)), heading, 1e-6, `near-horizontal ${heading}`);
    // Same convention as the existing map pin / marker image-up bearing.
    near(cameraFeatureImageUpBearing({ properties: { rotation: shotRotation(heading, 90) } }), heading, 1e-6, `pin ${heading}`);
  }
  const basis = photoCameraBasis(shotRotation(30, 90));
  near(basis.forward[2], -1, 1e-9, 'nadir optical axis points down');
});

test('photo heading is unknown for missing or malformed rotation', () => {
  for (const rotation of [null, undefined, [], [1, 2], [NaN, 0, 0], ['a', 0, 0], 'north']) {
    assert.equal(photoGridHeading(rotation), null, JSON.stringify(rotation));
  }
  // The zero vector is the placeholder written when shots carry no rotation
  // (identity would be a camera looking straight up): unknown, never "0 north".
  assert.equal(photoGridHeading([0, 0, 0]), null);
  assert.equal(photoGridHeading([0, 1e-12, 0]), null);
  assert.equal(compassState({ heading: photoGridHeading([0, 0, 0]), surface: 'photo', unknownReason: 'this photo has no usable camera orientation' }).state, 'unknown');
  // A camera pointing clearly above the horizon has no ground heading.
  for (const heading of [0, 90, 200]) {
    assert.equal(photoGridHeading(shotRotation(heading, -30)), null, `looking up 30 at ${heading}`);
    assert.equal(photoGridHeading(shotRotation(heading, -89)), null, `looking almost straight up at ${heading}`);
    near(photoGridHeading(shotRotation(heading, -10)), heading, 1e-6, `just above the horizon at ${heading}`);
  }
  assert.deepEqual(rotateByAngleAxis([0, 0, 0], [1, 2, 3]), [1, 2, 3]);
  const quarter = rotateByAngleAxis([0, 0, Math.PI / 2], [1, 0, 0]);
  assert.ok(Math.abs(quarter[0]) < 1e-12 && Math.abs(quarter[1] - 1) < 1e-12);
});

test('true north correction uses UTM meridian convergence with the right sign', () => {
  const north = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
  const [eCm, nCm] = north.latLonToUtm(44, -87);
  near(trueNorthGridBearing(north, eCm, nCm), 0, 1e-4, 'on the central meridian');
  // East of the central meridian in the north, true north is west of grid north.
  const [eEast, nEast] = north.latLonToUtm(40, -85);
  const east = trueNorthGridBearing(north, eEast, nEast);
  near(east, -2 * Math.sin(rad(40)), 0.02, 'north-east of CM');
  assert.ok(east < 0);
  const [eWest, nWest] = north.latLonToUtm(40, -89);
  assert.ok(trueNorthGridBearing(north, eWest, nWest) > 0, 'west of CM leans east');
  const south = createUtmProjection({ zoneLon0Deg: 147, hemisphere: 'S' });
  const [eS, nS] = south.latLonToUtm(-35, 149);
  near(trueNorthGridBearing(south, eS, nS), 2 * Math.sin(rad(35)), 0.02, 'southern hemisphere east of CM');
  // A view facing true north on the north-east site has grid heading = bearing of true north.
  near(gridToTrueHeading(normalizeDegrees(east), east), 0, 1e-9);
  assert.equal(trueNorthGridBearing(null, 1, 2), null);
  assert.equal(trueNorthGridBearing({ utmToLatLon: () => [NaN, NaN], latLonToUtm: () => [0, 0] }, 1, 2), null);
});

test('compass states: known, map, unknown and text alternatives in degrees', () => {
  const known = compassState({ heading: 123.4 });
  assert.equal(known.state, 'known');
  assert.equal(known.heading, 123);
  assert.equal(known.needleRotation, -123);
  assert.match(known.label, /view heading 123° south-east/);
  assert.match(known.label, /red needle points north/);
  const wrapped = compassState({ heading: 359.7, surface: 'photo' });
  assert.equal(wrapped.heading, 0);
  assert.equal(wrapped.needleRotation, 0);
  assert.ok(!Object.is(wrapped.needleRotation, -0));
  assert.match(wrapped.label, /photo heading 0° north/);
  const map = compassState({ heading: 0, surface: 'map' });
  assert.match(map.label, /map is north-up, heading 0°/);
  const unknown = compassState({ heading: null, unknownReason: 'this model has no verified georeference' });
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.heading, null);
  assert.equal(unknown.label, 'Compass: view heading unknown, this model has no verified georeference.');
  assert.match(compassState({ heading: NaN }).label, /heading unknown, north is not available/);
  assert.match(compassState({ heading: 5, surface: 'bogus' }).label, /view heading 5°/);
});

function fakeDocument() {
  const calls = [];
  const needle = { setAttribute(name, value) { calls.push([name, value]); this[name] = value; } };
  return {
    calls,
    needle,
    hiddenWrites: 0,
    createElement() {
      const doc = this;
      return {
        dataset: {}, attributes: {}, title: '', className: '', isHidden: false,
        set hidden(value) { doc.hiddenWrites += 1; this.isHidden = value; },
        get hidden() { return this.isHidden; },
        set innerHTML(value) { this.markup = value; },
        get innerHTML() { return this.markup; },
        setAttribute(name, value) { this.attributes[name] = value; },
        querySelector(selector) { return selector === '.viewer-compass-needle' ? needle : null; },
      };
    },
  };
}

test('compass component renders states, rotates the needle and skips redundant DOM writes', () => {
  const documentRef = fakeDocument();
  const compass = createCompass({ documentRef, className: 'viewer-compass-view' });
  const { element } = compass;
  assert.equal(element.className, 'viewer-compass viewer-compass-view');
  assert.equal(element.attributes.role, 'img');
  assert.match(element.markup, /viewer-compass-needle/);
  assert.equal(element.dataset.state, 'unknown', 'starts unknown until a heading arrives');
  assert.match(element.attributes['aria-label'], /heading unknown/);

  compass.update({ heading: 90 });
  assert.equal(element.dataset.state, 'known');
  assert.equal(documentRef.needle.transform, 'rotate(-90 24 24)');
  assert.match(element.attributes['aria-label'], /view heading 90° east/);
  assert.equal(element.title, 'view heading 90° east. The red needle points north.');
  const writes = documentRef.calls.length;
  compass.update({ heading: 90.2 });
  compass.update({ heading: 89.6 });
  assert.equal(documentRef.calls.length, writes, 'same whole degree: no DOM write');
  compass.update({ heading: 91 });
  assert.equal(documentRef.needle.transform, 'rotate(-91 24 24)');
  compass.update({ heading: null, unknownReason: 'the view is still loading' });
  assert.equal(element.dataset.state, 'unknown');
  assert.match(element.attributes['aria-label'], /still loading/);
  compass.setVisible(false);
  assert.equal(element.hidden, true);
  compass.setVisible(true);
  assert.equal(element.hidden, false);
  const hiddenWrites = documentRef.hiddenWrites;
  for (let frame = 0; frame < 5; frame += 1) compass.setVisible(true);
  assert.equal(documentRef.hiddenWrites, hiddenWrites, 'visibility is cached across frames');
  const before = compass.update({ heading: 12.2 });
  assert.equal(compass.update({ heading: 11.8 }), before, 'same whole degree returns the cached state object');
});

test('compass is wired into every Viewer surface', () => {
  const main = readFileSync(path.join(root, 'main.js'), 'utf8');
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const cloud = readFileSync(path.join(root, 'public', 'pointcloud.html'), 'utf8');
  const loop = main.slice(main.indexOf('function startLoop()'), main.indexOf('function updateStats()'));
  assert.match(loop, /updateViewCompass\(\);/, 'every frame, in every mode');
  assert.match(main, /rotationKnown \? photoGridHeading/);
  assert.match(main, /setAttribute\('aria-describedby', 'photo-compass'\)/);
  assert.match(cloud, /getViewMatrix\(\) \{[\s\S]{0,260}return viewMatrixBuffer;/, 'reuses one buffer');
  assert.match(html, /\.viewer-compass-view \{ right: 14px; bottom: 44px; \}/);
  assert.match(html, /\.viewer-compass \{[^}]*pointer-events: none;/, 'display only: never blocks the view');
  assert.match(html, /#dem-legend \{\s*position: absolute; bottom: 100px; right: 14px;/, 'legend clears the compass');
  assert.match(html, /\.viewer-compass-view \{ bottom: 64px; \}\s*#dem-legend \{ bottom: 120px; \}/, 'phone width keeps clear of wrapped attribution');
});
