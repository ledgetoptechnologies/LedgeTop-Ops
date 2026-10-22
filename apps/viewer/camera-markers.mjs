export const CAMERA_MARKER_COLORS = Object.freeze({
  body: 0xD8DEE6,
  face: 0xEE5007,
  cue: 0xF8CB2E,
  tab: 0xEE5007,
});

export const CAMERA_MARKER_OPACITY = Object.freeze({
  normal: 0.82,
  hover: 1,
});

export const DEFAULT_CAMERA_MARKER_SCALE = 0.5;

export const CAMERA_MARKER_STYLE = Object.freeze({
  width: Math.hypot(1.48, 1.13, 0.42),
  maxPixels: 10,
  maxVisible: Infinity,
  pickRadius: 12,
});

export function cameraMarkerScaleForView({
  baseScale = DEFAULT_CAMERA_MARKER_SCALE,
} = {}) {
  const parsed = Number(baseScale);
  const requested = Number.isFinite(parsed) ? parsed : DEFAULT_CAMERA_MARKER_SCALE;
  return Math.max(0.1, Math.min(4, requested));
}

export function selectCameraMarkerRepresentatives(candidates, {
  width,
  height,
  maxVisible = CAMERA_MARKER_STYLE.maxVisible,
  margin = CAMERA_MARKER_STYLE.maxPixels,
} = {}) {
  const viewportWidth = Number(width);
  const viewportHeight = Number(height);
  const limit = Math.max(0, Math.floor(Number(maxVisible)) || 0);
  const viewportMargin = Math.max(0, Number(margin) || 0);
  if (!Array.isArray(candidates) || !Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)
    || viewportWidth <= 0 || viewportHeight <= 0 || limit === 0) return [];

  // Do not replace overlapping cameras with a nearest-depth representative.
  // Their real capture positions and identities must remain stable during orbit.
  // The historical name is retained for callers; only viewport culling remains.
  const sources = new Set();
  for (const candidate of candidates) {
    const index = Number(candidate?.index);
    const x = Number(candidate?.x);
    const y = Number(candidate?.y);
    const depth = Number(candidate?.depth);
    if (!Number.isInteger(index) || index < 0 || !Number.isFinite(x) || !Number.isFinite(y)
      || !Number.isFinite(depth) || depth <= 0
      || x < -viewportMargin || x > viewportWidth + viewportMargin
      || y < -viewportMargin || y > viewportHeight + viewportMargin) continue;
    sources.add(index);
  }

  // A cap is opt-in, source-ordered, and never selected by camera depth.
  return [...sources].sort((left, right) => left - right).slice(0, limit);
}

function pushTriangle(target, a, b, c) {
  target.push(...a, ...b, ...c);
}

function pushQuad(target, a, b, c, d) {
  pushTriangle(target, a, b, c);
  pushTriangle(target, a, c, d);
}

function pushBox(target, minX, maxX, minY, maxY, minZ, maxZ) {
  const nnn = [minX, minY, minZ];
  const pnn = [maxX, minY, minZ];
  const ppn = [maxX, maxY, minZ];
  const npn = [minX, maxY, minZ];
  const nnp = [minX, minY, maxZ];
  const pnp = [maxX, minY, maxZ];
  const ppp = [maxX, maxY, maxZ];
  const npp = [minX, maxY, maxZ];
  pushQuad(target, nnn, npn, ppn, pnn);
  pushQuad(target, nnp, pnp, ppp, npp);
  pushQuad(target, nnn, nnp, npp, npn);
  pushQuad(target, pnn, ppn, ppp, pnp);
  pushQuad(target, npn, npp, ppp, ppn);
  pushQuad(target, nnn, pnn, pnp, nnp);
}

function pushFrustumShell(target, {
  backX, backY, backZ, frontX, frontY, frontZ, caps = false,
}) {
  const back = [
    [-backX, -backY, backZ], [backX, -backY, backZ],
    [backX, backY, backZ], [-backX, backY, backZ],
  ];
  const front = [
    [-frontX, -frontY, frontZ], [frontX, -frontY, frontZ],
    [frontX, frontY, frontZ], [-frontX, frontY, frontZ],
  ];
  for (let index = 0; index < 4; index += 1) {
    const next = (index + 1) % 4;
    pushQuad(target, back[index], back[next], front[next], front[index]);
  }
  if (caps) {
    pushQuad(target, back[0], back[3], back[2], back[1]);
    pushQuad(target, front[0], front[1], front[2], front[3]);
  }
}

function pushDisc(target, centerX, centerY, z, radius, segments = 8) {
  for (let index = 0; index < segments; index += 1) {
    const angle0 = index / segments * Math.PI * 2;
    const angle1 = (index + 1) / segments * Math.PI * 2;
    pushTriangle(target,
      [centerX, centerY, z],
      [centerX + Math.cos(angle0) * radius, centerY + Math.sin(angle0) * radius, z],
      [centerX + Math.cos(angle1) * radius, centerY + Math.sin(angle1) * radius, z]);
  }
}

export function cameraMarkerGeometryData() {
  // OpenSfM camera coordinates are +X image-right, +Y image-down, +Z forward.
  // Keep the authored pose: image-up is -Y, even for rolled/upside-down shots.
  // The orange back and amber front octagon remain distinct from either side.
  const body = [];
  pushFrustumShell(body, {
    backX: 0.74, backY: 0.48, backZ: -0.26,
    frontX: 0.58, frontY: 0.40, frontZ: 0.12,
  });
  // A light border surrounds the inset orange back panel.
  pushBox(body, -0.74, -0.64, -0.48, 0.48, -0.26, -0.20);
  pushBox(body, 0.64, 0.74, -0.48, 0.48, -0.26, -0.20);
  pushBox(body, -0.64, 0.64, -0.48, -0.38, -0.26, -0.20);
  pushBox(body, -0.64, 0.64, 0.38, 0.48, -0.26, -0.20);
  pushQuad(body,
    [-0.58, -0.40, 0.12], [0.58, -0.40, 0.12],
    [0.58, 0.40, 0.12], [-0.58, 0.40, 0.12]);

  const face = [];
  pushQuad(face,
    [-0.64, -0.38, -0.27], [-0.64, 0.38, -0.27],
    [0.64, 0.38, -0.27], [0.64, -0.38, -0.27]);

  const cue = [];
  pushDisc(cue, 0, 0, 0.15, 0.24);

  const tab = [];
  pushBox(tab, 0.40, 0.60, -0.65, -0.46, -0.25, -0.10);
  return { body, face, cue, tab };
}
