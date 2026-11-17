// North compass shared by every Viewer surface (3D model, point cloud, map
// layers and the camera photo preview). The maths below is pure so it can be
// tested without a browser; the DOM component is one small element whose look
// and size come from the `.viewer-compass` rules in index.html.
//
// Frames used here:
// - ENU: [east, north, up], the projected (UTM grid) frame of the model.
// - Three.js main Viewer world: x = east, y = up, z = south (see worldToUtm in
//   main.js: n = -z, alt = y).
// - Potree iframe: raw UTM, x = east, y = north, z = up.
// - OpenSfM/ODM shots: `rotation` is the world-to-camera angle-axis vector, and
//   camera axes are +X image-right, +Y image-down, +Z forward (optical axis).

const EPSILON = 1e-9;
const CARDINALS = Object.freeze(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
const CARDINAL_WORDS = Object.freeze({
  N: 'north', NE: 'north-east', E: 'east', SE: 'south-east',
  S: 'south', SW: 'south-west', W: 'west', NW: 'north-west',
});

function finiteTriplet(value) {
  if (!Array.isArray(value) && !(ArrayBuffer.isView(value))) return null;
  if (value.length < 3) return null;
  const triplet = [Number(value[0]), Number(value[1]), Number(value[2])];
  return triplet.every(Number.isFinite) ? triplet : null;
}

// Degrees in [0, 360). Returns null for anything that is not a finite number.
export function normalizeDegrees(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const wrapped = ((number % 360) + 360) % 360;
  // Fold -0 and values that round to 360 back to 0.
  return wrapped >= 360 - 1e-9 || Object.is(wrapped, -0) ? 0 : wrapped;
}

// Compass bearing (clockwise from north) of a horizontal east/north vector.
export function bearingDegrees(east, north) {
  const e = Number(east), n = Number(north);
  if (!Number.isFinite(e) || !Number.isFinite(n) || Math.hypot(e, n) <= EPSILON) return null;
  return normalizeDegrees(Math.atan2(e, n) * 180 / Math.PI);
}

// Heading of a view given its forward (look) direction and its screen-up
// direction, both in ENU. When the view is tilted down, the horizontal part of
// screen-up points the same way as the horizontal part of forward, and it is
// the only meaningful part when looking straight down. When the view is tilted
// up (orbiting under a model), screen-up leans backwards, so it is subtracted.
// The sum keeps the heading continuous from straight down to the horizon.
export function viewHeadingFromBasis({ forward, up } = {}) {
  const f = finiteTriplet(forward), u = finiteTriplet(up);
  if (!f || !u) return null;
  const vertical = Math.abs(f[2]) <= EPSILON ? 0 : Math.sign(f[2]);
  return bearingDegrees(f[0] - vertical * u[0], f[1] - vertical * u[1]);
}

// Main Viewer three.js world vector -> ENU (east = x, north = -z, up = y).
export function threeWorldToEnu(vector) {
  const v = finiteTriplet(vector);
  return v ? [v[0], -v[2], v[1]] : null;
}

// Camera basis from a column-major three.js matrixWorld (elements array):
// column 1 is the camera's screen-up, column 2 is its +Z (backwards).
export function cameraBasisFromMatrixElements(elements) {
  if (!elements || elements.length < 16) return null;
  const up = finiteTriplet([elements[4], elements[5], elements[6]]);
  const back = finiteTriplet([elements[8], elements[9], elements[10]]);
  if (!up || !back) return null;
  return { forward: [-back[0], -back[1], -back[2]], up };
}

// Rotate a vector by an angle-axis rotation (Rodrigues).
export function rotateByAngleAxis(rotation, vector) {
  const r = finiteTriplet(rotation), v = finiteTriplet(vector);
  if (!r || !v) return null;
  const angle = Math.hypot(r[0], r[1], r[2]);
  if (angle <= 1e-12) return v;
  const k = [r[0] / angle, r[1] / angle, r[2] / angle];
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  const cross = [k[1] * v[2] - k[2] * v[1], k[2] * v[0] - k[0] * v[2], k[0] * v[1] - k[1] * v[0]];
  const dot = k[0] * v[0] + k[1] * v[1] + k[2] * v[2];
  return [0, 1, 2].map((i) => v[i] * cosine + cross[i] * sine + k[i] * dot * (1 - cosine));
}

// Photo heading convention. ODM writes OpenSfM's shot rotation to
// shots.geojson: an angle-axis vector R mapping world to camera coordinates
// (x_cam = R * x_world) in the reconstruction's projected frame (UTM grid,
// x = east, y = north, z = up). Camera-to-world is the inverse rotation (-R).
// The photo is shown with image-up at the top of the screen, so its heading is
// the bearing of the photo's image-up direction (camera -Y), combined with its
// optical axis (camera +Z) exactly like a live view: for a nadir shot this is
// the direction at the top of the photo; for an oblique shot it is the
// direction the camera faces. This is the same inverse-rotation convention the
// 3D camera markers and map pins already use (camera-runtime.mjs).
export function photoCameraBasis(rotation) {
  const r = finiteTriplet(rotation);
  if (!r) return null;
  const inverse = [-r[0], -r[1], -r[2]];
  return {
    forward: rotateByAngleAxis(inverse, [0, 0, 1]),
    up: rotateByAngleAxis(inverse, [0, -1, 0]),
  };
}

export function photoGridHeading(rotation) {
  const basis = photoCameraBasis(rotation);
  return basis ? viewHeadingFromBasis(basis) : null;
}

// Grid bearing of true north at a projected point. UTM grid north differs from
// true north by the meridian convergence (about 1-2 degrees away from the
// zone's central meridian). Returns a signed angle in degrees, or null.
export function trueNorthGridBearing(projection, easting, northing) {
  if (!projection || typeof projection.utmToLatLon !== 'function' || typeof projection.latLonToUtm !== 'function') return null;
  const [lat, lon] = projection.utmToLatLon(easting, northing) || [];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 89.5) return null;
  const step = lat > 0 ? -1e-4 : 1e-4;
  const [e0, n0] = projection.latLonToUtm(lat, lon) || [];
  const [e1, n1] = projection.latLonToUtm(lat + step, lon) || [];
  if (![e0, n0, e1, n1].every(Number.isFinite)) return null;
  // Step toward the equator for numerical safety, then flip to point north.
  const sign = step > 0 ? 1 : -1;
  const bearing = bearingDegrees((e1 - e0) * sign, (n1 - n0) * sign);
  if (bearing === null) return null;
  return bearing > 180 ? bearing - 360 : bearing;
}

// Convert a grid heading to a true heading given the grid bearing of true north.
export function gridToTrueHeading(gridHeading, northGridBearing) {
  const heading = normalizeDegrees(gridHeading);
  if (heading === null) return null;
  const offset = Number(northGridBearing);
  return normalizeDegrees(heading - (Number.isFinite(offset) ? offset : 0));
}

export function cardinalFor(heading) {
  const value = normalizeDegrees(heading);
  if (value === null) return null;
  return CARDINALS[Math.round(value / 45) % 8];
}

// Display heading: whole degrees, 0..359 (359.6 rounds to 0, not 360).
export function displayHeading(heading) {
  const value = normalizeDegrees(heading);
  return value === null ? null : Math.round(value) % 360;
}

const SURFACE_NAMES = Object.freeze({ view: 'view', map: 'map', photo: 'photo' });

// Pure description of what the compass shows. `heading` is the true heading of
// the view (the direction at the top of the screen), in degrees; null means
// unknown. The needle is rotated by -heading so it points to north on screen.
export function compassState({ heading = null, surface = 'view', unknownReason = '' } = {}) {
  const name = SURFACE_NAMES[surface] || 'view';
  const value = displayHeading(heading);
  if (value === null) {
    const reason = String(unknownReason || '').trim() || 'north is not available';
    return {
      state: 'unknown', heading: null, needleRotation: 0,
      label: `Compass: ${name} heading unknown, ${reason}.`,
      text: '?',
    };
  }
  const cardinal = cardinalFor(value);
  const facing = name === 'map'
    ? `map is north-up, heading ${value}°`
    : `${name} heading ${value}° ${CARDINAL_WORDS[cardinal]}`;
  return {
    state: 'known', heading: value, needleRotation: value === 0 ? 0 : -value,
    label: `Compass: ${facing}. The red needle points north.`,
    text: `${value}°`,
  };
}

const COMPASS_MARKUP = '<svg class="viewer-compass-dial" viewBox="0 0 48 48" aria-hidden="true" focusable="false">'
  + '<circle cx="24" cy="24" r="22" class="viewer-compass-bezel"/>'
  + '<g class="viewer-compass-needle">'
  + '<path d="M24 14 L28 24 L20 24 Z" class="viewer-compass-north"/>'
  + '<path d="M24 36 L28 24 L20 24 Z" class="viewer-compass-south"/>'
  + '<text x="24" y="9" class="viewer-compass-letter">N</text>'
  + '</g>'
  + '<text x="24" y="24.5" class="viewer-compass-unknown">?</text>'
  + '</svg>';

// One compass element. update() is cheap to call every animation frame: it
// touches the DOM only when the displayed state changes (whole degrees).
export function createCompass({ documentRef = globalThis.document, className = '' } = {}) {
  const element = documentRef.createElement('div');
  element.className = `viewer-compass${className ? ` ${className}` : ''}`;
  element.setAttribute('role', 'img');
  element.innerHTML = COMPASS_MARKUP;
  const needle = element.querySelector('.viewer-compass-needle');
  let last = null;
  function update(input = {}) {
    const next = compassState(input);
    const key = `${next.state}|${next.needleRotation}|${next.label}`;
    if (key === last) return next;
    last = key;
    element.dataset.state = next.state;
    element.setAttribute('aria-label', next.label);
    element.title = next.label.replace(/^Compass: /, '');
    needle?.setAttribute('transform', `rotate(${next.needleRotation} 24 24)`);
    return next;
  }
  function setVisible(visible) {
    element.hidden = !visible;
  }
  update({ heading: null });
  return { element, update, setVisible };
}
