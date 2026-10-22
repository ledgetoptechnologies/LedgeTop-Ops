// Shared, renderer-independent measurement arithmetic. Coordinates and results
// are metres; display rounding must never feed back into these calculations.
const EPS = 1e-10;
function invalid(message, code = 'invalid_measurement_geometry') { throw Object.assign(new Error(message), { code }); }
const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
export function polygonArea(points) {
  if (points.length < 3) return 0;
  const origin = points[0];
  let twice = 0;
  for (let i = 1; i + 1 < points.length; i++) twice += cross(origin, points[i], points[i + 1]);
  return twice / 2;
}
function onSegment(a, b, p) {
  return Math.abs(cross(a, b, p)) < EPS && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
}
function intersects(a, b, c, d) {
  const p = cross(a, b, c), q = cross(a, b, d), r = cross(c, d, a), s = cross(c, d, b);
  return (p * q < 0 && r * s < 0) || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
export function validatePolygon(vertices) {
  if (!Array.isArray(vertices) || vertices.length < 3 || vertices.length > 256 || vertices.some(p => !Array.isArray(p) || p.length < 2 || !p.every(Number.isFinite))) invalid('Use 3–256 finite polygon vertices.');
  const points = vertices.map(p => p.slice());
  if (points.length > 3 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1]) points.pop();
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    if (Math.hypot(points[i][0] - points[j][0], points[i][1] - points[j][1]) < EPS) invalid('Polygon vertices must be distinct.');
    for (let k = i + 1; k < points.length; k++) {
      const l = (k + 1) % points.length;
      if (i === k || j === k || i === l) continue;
      if (intersects(points[i], points[j], points[k], points[l])) invalid('Polygon edges cannot cross or touch.');
    }
  }
  if (Math.abs(polygonArea(points)) < EPS) invalid('Polygon has no horizontal area.');
  if (polygonArea(points) < 0) points.reverse();
  return points;
}
function insideTriangle(p, a, b, c) { return cross(a, b, p) >= -EPS && cross(b, c, p) >= -EPS && cross(c, a, p) >= -EPS; }
export function triangulatePolygon(vertices) {
  const points = validatePolygon(vertices), pending = points.map((_, i) => i), triangles = [];
  while (pending.length > 3) {
    let found = false;
    for (let i = 0; i < pending.length; i++) {
      const ai = pending[(i + pending.length - 1) % pending.length], bi = pending[i], ci = pending[(i + 1) % pending.length];
      const a = points[ai], b = points[bi], c = points[ci];
      if (cross(a, b, c) <= EPS || pending.some(j => j !== ai && j !== bi && j !== ci && insideTriangle(points[j], a, b, c))) continue;
      triangles.push([a, b, c]); pending.splice(i, 1); found = true; break;
    }
    if (!found) invalid('Polygon cannot be triangulated; remove redundant collinear vertices.');
  }
  triangles.push(pending.map(i => points[i]));
  return triangles;
}
// Sutherland–Hodgman clipping against a half-plane. Extra components are
// interpolated, allowing exact positive/negative integration of linear heights.
export function clipHalfPlane(points, signedDistance) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], da = signedDistance(a), db = signedDistance(b);
    if (da >= -EPS) out.push(a);
    if ((da < -EPS && db >= -EPS) || (da >= -EPS && db < -EPS)) {
      const t = da / (da - db); out.push(a.map((n, j) => n + (b[j] - n) * t));
    }
  }
  return out;
}
function clipRectangle(points, minX, minY, maxX, maxY) {
  let clipped = points;
  for (const distance of [p => p[0] - minX, p => maxX - p[0], p => p[1] - minY, p => maxY - p[1]]) clipped = clipHalfPlane(clipped, distance);
  return clipped;
}
function planeThrough(a, b, c) {
  const determinant = cross(a, b, c);
  if (Math.abs(determinant) < EPS) invalid('Reference boundary is degenerate.');
  const dx = ((b[2] - a[2]) * (c[1] - a[1]) - (c[2] - a[2]) * (b[1] - a[1])) / determinant;
  const dy = ((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) / determinant;
  return (x, y) => a[2] + dx * (x - a[0]) + dy * (y - a[1]);
}
export function createReference(vertices, settings = {}) {
  const points = validatePolygon(vertices), type = settings.type || 'boundary-triangulated', offsetM = settings.offsetM ?? 0;
  if (!Number.isFinite(offsetM)) invalid('Reference offset must be finite.');
  if (type === 'custom') {
    if (!Number.isFinite(settings.elevationM)) invalid('Custom reference elevation is required.');
    return { type, offsetM, sample: () => settings.elevationM + offsetM, patches: triangulatePolygon(points).map(polygon => ({ polygon, sample: () => settings.elevationM + offsetM })) };
  }
  if (points.some(p => !Number.isFinite(p[2]))) invalid('This reference needs elevations at each boundary vertex.');
  const triangles = triangulatePolygon(points);
  if (type === 'boundary-triangulated') {
    const patches = triangles.map(polygon => { const plane = planeThrough(...polygon); return { polygon, sample: (x, y) => plane(x, y) + offsetM }; });
    return { type, offsetM, patches, sample: (x, y) => { const patch = patches.find(p => insideTriangle([x, y], ...p.polygon)); return patch ? patch.sample(x, y) : NaN; } };
  }
  let sample;
  if (['lowest-boundary', 'highest-boundary', 'average-boundary'].includes(type)) {
    const z = type === 'lowest-boundary' ? Math.min(...points.map(p => p[2])) : type === 'highest-boundary' ? Math.max(...points.map(p => p[2])) : points.reduce((sum, p) => sum + p[2], 0) / points.length;
    sample = () => z + offsetM;
  } else if (type === 'fitted-plane') {
    const center = [0, 1, 2].map(k => points.reduce((sum, p) => sum + p[k], 0) / points.length);
    let xx = 0, yy = 0, xy = 0, xz = 0, yz = 0;
    for (const p of points) { const x = p[0] - center[0], y = p[1] - center[1], z = p[2] - center[2]; xx += x * x; yy += y * y; xy += x * y; xz += x * z; yz += y * z; }
    const d = xx * yy - xy * xy;
    if (Math.abs(d) < EPS) invalid('Boundary does not define a stable plane.');
    const a = (xz * yy - yz * xy) / d, b = (yz * xx - xz * xy) / d;
    sample = (x, y) => center[2] + a * (x - center[0]) + b * (y - center[1]) + offsetM;
  } else invalid('Unknown reference definition.');
  return { type, offsetM, sample, patches: triangles.map(polygon => ({ polygon, sample })) };
}
function integralHeight(polygon) {
  let result = 0;
  for (let i = 1; i + 1 < polygon.length; i++) result += Math.abs(cross(polygon[0], polygon[i], polygon[i + 1])) / 2 * (polygon[0][2] + polygon[i][2] + polygon[i + 1][2]) / 3;
  return result;
}
function patchGridSpans(patches, {width,height,bounds}) {
  const dx=(bounds.maxE-bounds.minE)/width,dy=(bounds.maxN-bounds.minN)/height;
  return patches.map(patch=>{
    const xs=patch.polygon.map(p=>p[0]),ys=patch.polygon.map(p=>p[1]);
    // One-cell padding prevents rounded projected coordinates from culling a
    // fractional boundary. The existing exact geometric predicates still own it.
    return {patch,left:Math.max(0,Math.floor((Math.min(...xs)-bounds.minE)/dx)-1),right:Math.min(width,Math.ceil((Math.max(...xs)-bounds.minE)/dx)+1),top:Math.max(0,Math.floor((bounds.maxN-Math.max(...ys))/dy)-1),bottom:Math.min(height,Math.ceil((bounds.maxN-Math.min(...ys))/dy)+1)};
  }).filter(s=>s.right>s.left&&s.bottom>s.top);
}
export function estimateSurfacePatchWork(patches, grid) {
  return patchGridSpans(patches,grid).reduce((sum,s)=>sum+(s.right-s.left)*(s.bottom-s.top),0);
}
export function createSurfaceAccumulator({ vertices, reference = {}, referenceBase, spatialPatchCulling = false, maxCells = 16_000_000, maxWork = 30_000_000 }) {
  const polygon = validatePolygon(vertices), base = referenceBase || createReference(polygon, reference), footprintM2 = Math.abs(polygonArea(polygon));
  const patches = base.patches.map(patch => ({ ...patch,
    minX: Math.min(...patch.polygon.map(p => p[0])), maxX: Math.max(...patch.polygon.map(p => p[0])),
    minY: Math.min(...patch.polygon.map(p => p[1])), maxY: Math.max(...patch.polygon.map(p => p[1])),
    edges: patch.polygon.map((a, i) => { const b = patch.polygon[(i + 1) % patch.polygon.length]; return { x: -(b[1] - a[1]), y: b[0] - a[0], origin: a }; })
  }));
  let cutM3 = 0, fillM3 = 0, coveredAreaM2 = 0, validAreaM2 = 0, cellsVisited = 0, sampleCount = 0, workVisited = 0;
  function addGrid({ values, width, height, bounds, nodata = NaN }) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || values?.length !== width * height) invalid('Invalid native raster grid.');
    if (!bounds || !Object.values(bounds).every(Number.isFinite)) invalid('Raster bounds must be finite.');
    const dx = (bounds.maxE - bounds.minE) / width, dy = (bounds.maxN - bounds.minN) / height;
    if (!(dx > 0 && dy > 0)) invalid('Raster must have positive metric cell dimensions.');
    if (cellsVisited + width * height > maxCells) invalid('Selection exceeds the native-resolution cell limit; reduce its extent.', 'measurement_limit');
    const spans=spatialPatchCulling?patchGridSpans(patches,{width,height,bounds}):null;
    const work=spans?spans.reduce((sum,s)=>sum+(s.right-s.left)*(s.bottom-s.top),0):width*height*base.patches.length;
    if (workVisited + work > maxWork) invalid('Selection and boundary complexity exceed the calculation work limit.', 'measurement_limit');
    workVisited += work;
    cellsVisited += width * height;
    for (let row = 0; row < height; row++) {
      const events=spans?spans.filter(s=>row>=s.top&&row<s.bottom).flatMap(s=>[{col:s.left,patch:s.patch,add:true},{col:s.right,patch:s.patch,add:false}]).sort((a,b)=>a.col-b.col):null;
      const active=events?new Set():patches;let eventIndex=0;
      for (let col = 0; col < width; col++) {
      if(events){while(eventIndex<events.length&&events[eventIndex].col===col){const event=events[eventIndex++];if(event.add)active.add(event.patch);else active.delete(event.patch);}if(!active.size)continue;}
      const minX = bounds.minE + col * dx, maxY = bounds.maxN - row * dy, value = Number(values[row * width + col]);
      const valid = Number.isFinite(value) && (!Number.isFinite(nodata) || value !== nodata);
      let cellValid = false;
      for (const patch of active) {
        if (minX >= patch.maxX || minX + dx <= patch.minX || maxY <= patch.minY || maxY - dy >= patch.maxY) continue;
        const centerX = minX + dx / 2, centerY = maxY - dy / 2;
        let interior = true, outside = false;
        for (const edge of patch.edges) {
          const center = edge.x * (centerX - edge.origin[0]) + edge.y * (centerY - edge.origin[1]);
          const radius = Math.abs(edge.x) * dx / 2 + Math.abs(edge.y) * dy / 2;
          if (center + radius < -EPS) { outside = true; break; }
          if (center - radius < EPS) interior = false;
        }
        if (outside) continue;
        // A linear plane integrates exactly at a rectangle's center. Only
        // boundary cells and cells crossing zero need polygon allocation.
        if (interior) {
          const area = dx * dy;
          if (!valid) { coveredAreaM2 += area; continue; }
          const d0 = value - patch.sample(minX, maxY), d1 = value - patch.sample(minX + dx, maxY);
          const d2 = value - patch.sample(minX, maxY - dy), d3 = value - patch.sample(minX + dx, maxY - dy);
          if (Math.min(d0, d1, d2, d3) >= 0 || Math.max(d0, d1, d2, d3) <= 0) {
            coveredAreaM2 += area; validAreaM2 += area; cellValid = true;
            const volume = area * (value - patch.sample(centerX, centerY));
            if (volume >= 0) cutM3 += volume; else fillM3 -= volume;
            continue;
          }
        }
        const clipped = clipRectangle(patch.polygon, minX, maxY - dy, minX + dx, maxY);
        const area = Math.abs(polygonArea(clipped));
        if (area <= EPS) continue;
        coveredAreaM2 += area;
        if (!valid) continue;
        validAreaM2 += area; cellValid = true;
        const differences = clipped.map(p => [p[0], p[1], value - patch.sample(p[0], p[1])]);
        cutM3 += integralHeight(clipHalfPlane(differences, p => p[2]));
        fillM3 -= integralHeight(clipHalfPlane(differences, p => -p[2]));
      }
      if (cellValid) sampleCount++;
      }
    }
  }
  function result() {
    const coverage = Math.min(1, validAreaM2 / footprintM2), complete = coverage >= 1 - 1e-8;
    return { method: 'surface-cut-fill', status: complete ? 'complete' : 'incomplete', cutM3, fillM3, netM3: cutM3 - fillM3, footprintM2, validAreaM2, missingAreaM2: Math.max(0, footprintM2 - validAreaM2), coverage, sampleCount, cellsVisited, reference: { ...reference, type: base.type }, numericalModel: base.numericalModel || 'native-cell-constant surface; fractional boundary cells; piecewise-linear reference', warnings: complete ? [] : ['Missing or out-of-raster elevations are not treated as zero; totals cover valid samples only.'] };
  }
  return { addGrid, result, reference: base };
}
export function integrateSurfaceVolume(options) {
  const accumulator = createSurfaceAccumulator(options); accumulator.addGrid(options); return accumulator.result();
}
