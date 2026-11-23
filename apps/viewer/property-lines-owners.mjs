// Owner names on property lines: touching parcels of one owner become one
// outline, and each outline gets one clean label in its middle. Pure maths,
// no DOM and no network; shared by the map views, 3D views and tests.
//
// Parcels arrive as { id, rings: [[[lon, lat], ...], ...], owner?, cuts? }
// (see property-lines.mjs). `cuts` names ring segments the server closed
// along its clipping envelope: used for shape (labels, merging), never drawn. Esri rings are closed, outer rings clockwise and holes
// anticlockwise; orientation is enforced here so any source works.

const DEG = Math.PI / 180;
const SQRT2 = Math.SQRT2;
const EARTH_CIRCUMFERENCE = 40075016.686;

export const OWNER_LABEL_LIMITS = Object.freeze({
  snapMeters: 0.2,       // vertices closer than this are the same corner
  splitBudget: 2_000_000, // per parcel: edges x neighbouring corners checked for T-junctions
  minLabelZoom: 14,      // no owner names when zoomed out further
  minRadiusPx: 14,       // a circle this big must fit inside the shape
  fontMinPx: 10,
  fontMaxPx: 15,
  maxLabels: 150,
  paddingPx: 6,          // clear space between two labels
  maxLineChars: 18,      // longer names wrap onto a second line
  maxChars: 40,          // and are cut with an ellipsis beyond this
});

// The key two parcels must share to count as one owner: case, punctuation
// spacing and repeated whitespace do not matter. Empty means "no owner".
export function normalizeOwnerName(name) {
  if (typeof name !== 'string') return '';
  return name.normalize('NFKC').toUpperCase().replace(/[.,;]/g, ' ').replace(/\s+/g, ' ').trim();
}

// The text shown: the owner's name as published, with whitespace tidied.
export function ownerDisplayName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
}

// Local metres around one reference point (good to well under 0.1% over a
// few kilometres, which is all a map view's parcels span).
function localFrame(lon0, lat0) {
  const kx = 111320 * Math.cos(lat0 * DEG), ky = 110574;
  return {
    to: (lon, lat) => [(lon - lon0) * kx, (lat - lat0) * ky],
    from: (x, y) => [lon0 + x / kx, lat0 + y / ky],
  };
}

function signedArea(points) {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) sum += (points[j][0] - points[i][0]) * (points[j][1] + points[i][1]);
  return sum / 2; // positive = clockwise with y pointing north
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// A parcel's rings in local metres, each closed, outer rings clockwise and
// holes (rings inside another ring of the same parcel) anticlockwise.
function orientedRings(parcel, frame) {
  const rings = [];
  for (const ring of parcel.rings) {
    const pts = ring.map(([lon, lat]) => frame.to(lon, lat));
    if (pts.length < 3) continue;
    const [fx, fy] = pts[0], [lx, ly] = pts[pts.length - 1];
    if (fx !== lx || fy !== ly) pts.push([fx, fy]);
    rings.push(pts);
  }
  return rings.map((pts, index) => {
    const hole = rings.some((other, j) => j !== index && pointInRing(pts[0][0], pts[0][1], other));
    const clockwise = signedArea(pts) > 0;
    return { hole, pts: clockwise === !hole ? pts : pts.slice().reverse() };
  });
}

// ── Merge by owner ───────────────────────────────────────────────────────

function vertexIndex(snap) {
  const cells = new Map(), verts = [];
  const cellKey = (cx, cy) => `${cx},${cy}`;
  return {
    verts,
    id(x, y) {
      const cx = Math.floor(x / snap), cy = Math.floor(y / snap);
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const id of cells.get(cellKey(cx + dx, cy + dy)) || []) {
          const v = verts[id];
          if (Math.hypot(v[0] - x, v[1] - y) <= snap) return id;
        }
      }
      const id = verts.length;
      verts.push([x, y]);
      const key = cellKey(cx, cy);
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(id);
      return id;
    },
  };
}

function bboxOf(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) for (const [x, y] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  return { minX, minY, maxX, maxY };
}

const bboxTouch = (a, b, pad) => a.minX - pad <= b.maxX && a.maxX + pad >= b.minX && a.minY - pad <= b.maxY && a.maxY + pad >= b.minY;

// Vertices of neighbouring parcels that lie on an edge (a T-junction, where
// one side of a shared boundary has a corner the other does not) are inserted
// into the edge, so the shared stretch can cancel on both sides. This is
// bounded work (splitBudget); a parcel over the budget is not reconciled.
function splitAtVertices(ids, verts, candidates, snap) {
  if (!candidates.length) return ids;
  const out = [ids[0]];
  for (let i = 1; i < ids.length; i++) {
    const a = verts[ids[i - 1]], b = verts[ids[i]];
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    if (len2 > snap * snap * 4) {
      const hits = [];
      for (const id of candidates) {
        if (id === ids[i - 1] || id === ids[i]) continue;
        const p = verts[id];
        const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
        if (t <= 0 || t >= 1) continue;
        const ex = a[0] + t * dx - p[0], ey = a[1] + t * dy - p[1];
        if (ex * ex + ey * ey <= snap * snap) hits.push([t, id]);
      }
      hits.sort((p, q) => p[0] - q[0]);
      for (const [, id] of hits) if (out[out.length - 1] !== id) out.push(id);
    }
    if (out[out.length - 1] !== ids[i]) out.push(ids[i]);
  }
  return out;
}

// The parts of a parcel's rings that are real boundary: a ring the server
// clipped at its coverage envelope is split at the segments it names in
// `cuts`, which run along the cut and are never drawn.
export function parcelStrokeLines(parcel) {
  const lines = [];
  parcel.rings.forEach((ring, index) => {
    const cut = new Set(parcel.cuts?.[index] || []);
    if (!cut.size) { lines.push(ring); return; }
    let run = [ring[0]];
    for (let k = 0; k < ring.length - 1; k++) {
      if (cut.has(k)) { if (run.length >= 2) lines.push(run); run = [ring[k + 1]]; } else run.push(ring[k + 1]);
    }
    if (run.length >= 2) lines.push(run);
  });
  return lines;
}

// Chain directed edges [u, v] into polylines (closed loops end where they
// start; open runs start at their free end).
function chainEdges(edges) {
  const outgoing = new Map(), incoming = new Set();
  edges.forEach(([u, v], index) => { if (!outgoing.has(u)) outgoing.set(u, []); outgoing.get(u).push(index); incoming.add(v); });
  const used = new Uint8Array(edges.length);
  const lines = [];
  const order = [...edges.keys()].sort((a, b) => Number(incoming.has(edges[a][0])) - Number(incoming.has(edges[b][0])));
  for (const start of order) {
    if (used[start]) continue;
    used[start] = 1;
    const line = [edges[start][0], edges[start][1]];
    for (;;) {
      const next = (outgoing.get(line[line.length - 1]) || []).find(index => !used[index]);
      if (next === undefined) break;
      used[next] = 1;
      line.push(edges[next][1]);
    }
    lines.push(line);
  }
  return lines;
}

function mergeGroup(group, frame, snap, splitBudget) {
  const index = vertexIndex(snap);
  const items = group.map(parcel => {
    const rings = orientedRings(parcel, frame).map(({ pts }) => {
      const ids = [];
      for (const [x, y] of pts) { const id = index.id(x, y); if (ids[ids.length - 1] !== id) ids.push(id); }
      return ids;
    }).filter(ids => ids.length >= 4);
    return { parcel, rings, bbox: bboxOf(rings.map(ids => ids.map(id => index.verts[id]))), vertexIds: [...new Set(rings.flat())] };
  });
  // Segments the server closed along its clipping envelope, in local metres:
  // an edge lying on one is kept for the shape but never drawn.
  const cutSegments = group.flatMap(parcel => parcel.rings.flatMap((ring, r) => (parcel.cuts?.[r] || [])
    .filter(k => ring[k + 1]).map(k => [frame.to(...ring[k]), frame.to(...ring[k + 1])])));
  const onSegment = (p, [a, b]) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    const t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
    if (t < -1e-6 || t > 1 + 1e-6) return false;
    return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) <= snap;
  };
  const isCut = (u, v) => cutSegments.some(seg => onSegment(index.verts[u], seg) && onSegment(index.verts[v], seg));
  // Insert neighbours' corners into edges, within the per-parcel budget. Over
  // it (very dense same-owner land), only edges whose corners already match
  // cancel, and a shared stretch with unmatched corners stays drawn.
  for (const item of items) {
    const candidates = [];
    for (const other of items) if (other !== item && bboxTouch(item.bbox, other.bbox, snap)) candidates.push(...other.vertexIds);
    const edges = item.rings.reduce((n, ids) => n + ids.length, 0);
    if (candidates.length && edges * candidates.length <= splitBudget)
      item.rings = item.rings.map(ids => splitAtVertices(ids, index.verts, candidates, snap));
  }
  // Directed edges; an edge also present in the opposite direction from
  // another parcel is a shared boundary inside the owner's land.
  const edgeOwners = new Map();
  items.forEach((item, i) => {
    for (const ids of item.rings) for (let k = 1; k < ids.length; k++) {
      if (ids[k - 1] === ids[k]) continue;
      const key = `${ids[k - 1]}>${ids[k]}`;
      if (!edgeOwners.has(key)) edgeOwners.set(key, new Set());
      edgeOwners.get(key).add(i);
    }
  });
  const parent = items.map((_, i) => i);
  const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const internal = new Set();
  for (const [key, owners] of edgeOwners) {
    const [u, v] = key.split('>');
    const reverse = edgeOwners.get(`${v}>${u}`);
    if (!reverse) continue;
    for (const a of owners) for (const b of reverse) {
      if (a === b) continue;
      internal.add(key);
      parent[find(a)] = find(b);
    }
  }
  const components = new Map();
  items.forEach((item, i) => {
    const root = find(i);
    if (!components.has(root)) components.set(root, { members: [], edges: [] });
    components.get(root).members.push(item.parcel);
  });
  for (const [key, owners] of edgeOwners) {
    if (internal.has(key)) continue;
    const [u, v] = key.split('>').map(Number);
    if (cutSegments.length && isCut(u, v)) continue;
    components.get(find(owners.values().next().value)).edges.push([u, v]);
  }
  return [...components.values()].map(({ members, edges }) => ({
    members,
    lines: chainEdges(edges).map(ids => ids.map(id => frame.from(...index.verts[id]))),
  }));
}

// One outline per owner area. With merge on, parcels whose normalized owner
// names match are joined where they share a boundary: an edge one parcel
// has in one direction and another has in the opposite direction (same
// corners within snapMeters) is removed, and the parcels become one outline.
// Corners present on one side only are reconciled first within splitBudget;
// beyond it, or where the two sides were drawn without common corners at all,
// that stretch stays drawn (and parcels joined by nothing else stay
// separate outlines). Same-owner parcels that do not touch stay separate.
// With merge off, or without an owner name, every parcel is its own outline.
// Returns [{ ownerKey, owner, parcels, parcelIds, lines: [[[lon, lat], ...]] }]:
// `lines` are the boundary to stroke (never a clipping cut); `parcels` keep
// their whole rings for labels.
export function dissolveParcelsByOwner(parcels, { merge = true, snapMeters = OWNER_LABEL_LIMITS.snapMeters, splitBudget = OWNER_LABEL_LIMITS.splitBudget } = {}) {
  const list = Array.isArray(parcels) ? parcels.filter(p => Array.isArray(p?.rings) && p.rings.length) : [];
  if (!list.length) return [];
  const [lon0, lat0] = list[0].rings[0][0];
  const frame = localFrame(lon0, lat0);
  const groups = new Map();
  list.forEach((parcel, i) => {
    const ownerKey = normalizeOwnerName(parcel.owner);
    const key = merge && ownerKey ? `o:${ownerKey}` : `p:${i}`;
    if (!groups.has(key)) groups.set(key, { ownerKey, parcels: [] });
    groups.get(key).parcels.push(parcel);
  });
  const outlines = [];
  const describe = (ownerKey, members, lines) => ({
    ownerKey, owner: ownerDisplayName(members[0].owner), parcels: members,
    parcelIds: members.map(p => p.id).filter(id => id != null), lines,
  });
  for (const { ownerKey, parcels: group } of groups.values()) {
    if (group.length === 1) { outlines.push(describe(ownerKey, group, parcelStrokeLines(group[0]))); continue; }
    for (const component of mergeGroup(group, frame, snapMeters, splitBudget))
      if (component.lines.length) outlines.push(describe(ownerKey, component.members, component.lines));
  }
  return outlines;
}

// ── Label placement ──────────────────────────────────────────────────────

// Small binary max-heap on `max`.
function heap() {
  const items = [];
  return {
    get size() { return items.length; },
    push(item) {
      items.push(item);
      for (let i = items.length - 1; i > 0;) { const p = (i - 1) >> 1; if (items[p].max >= items[i].max) break; [items[p], items[i]] = [items[i], items[p]]; i = p; }
    },
    pop() {
      const top = items[0], last = items.pop();
      if (items.length) {
        items[0] = last;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < items.length && items[l].max > items[m].max) m = l;
          if (r < items.length && items[r].max > items[m].max) m = r;
          if (m === i) break;
          [items[m], items[i]] = [items[i], items[m]]; i = m;
        }
      }
      return top;
    },
  };
}

// Distance from (x, y) to the polygon's edge; negative outside.
function signedDistance(x, y, rings) {
  let inside = false, best = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
      const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
      const t = len2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len2)) : 0;
      best = Math.min(best, (a[0] + t * dx - x) ** 2 + (a[1] + t * dy - y) ** 2);
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(best);
}

// The point inside the polygon farthest from its edges (the centre of the
// largest circle that fits), by recursive grid refinement. Works for thin,
// bent and holed shapes, where a centroid can fall outside.
export function polygonLabelPoint(rings, { precision = null, maxCells = 4000 } = {}) {
  const outer = rings[0];
  if (!outer || outer.length < 3) return null;
  const { minX, minY, maxX, maxY } = bboxOf([outer]);
  const size = Math.min(maxX - minX, maxY - minY);
  if (!(size > 0)) return { x: outer[0][0], y: outer[0][1], distance: 0 };
  const eps = precision ?? Math.max(0.25, size / 200);
  const cell = (x, y, h) => { const d = signedDistance(x, y, rings); return { x, y, h, d, max: d + h * SQRT2 }; };
  const queue = heap();
  const h = size / 2;
  for (let x = minX; x < maxX; x += size) for (let y = minY; y < maxY; y += size) queue.push(cell(x + h, y + h, h));
  // Start from the area centroid (or the box centre when that is better).
  let area = 0, cx = 0, cy = 0;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
    const f = outer[i][0] * outer[j][1] - outer[j][0] * outer[i][1];
    cx += (outer[i][0] + outer[j][0]) * f; cy += (outer[i][1] + outer[j][1]) * f; area += f * 3;
  }
  let best = area ? cell(cx / area, cy / area, 0) : cell(outer[0][0], outer[0][1], 0);
  const box = cell(minX + (maxX - minX) / 2, minY + (maxY - minY) / 2, 0);
  if (box.d > best.d) best = box;
  let cells = 0;
  while (queue.size && cells < maxCells) {
    const c = queue.pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= eps) continue;
    const q = c.h / 2;
    queue.push(cell(c.x - q, c.y - q, q)); queue.push(cell(c.x + q, c.y - q, q));
    queue.push(cell(c.x - q, c.y + q, q)); queue.push(cell(c.x + q, c.y + q, q));
    cells += 4;
  }
  return { x: best.x, y: best.y, distance: Math.max(0, best.d) };
}

// Label point, inscribed radius and area of one parcel, cached per parcel
// object (parcel objects are reused from the tile cache).
const parcelGeometryCache = new WeakMap();
export function parcelLabelGeometry(parcel) {
  if (parcelGeometryCache.has(parcel)) return parcelGeometryCache.get(parcel);
  const [lon0, lat0] = parcel.rings[0][0];
  const frame = localFrame(lon0, lat0);
  const rings = orientedRings(parcel, frame);
  const outers = rings.filter(r => !r.hole).map(r => r.pts), holes = rings.filter(r => r.hole).map(r => r.pts);
  let best = null, area = 0;
  for (const outer of outers) {
    const inner = holes.filter(hole => pointInRing(hole[0][0], hole[0][1], outer));
    area += Math.abs(signedArea(outer)) - inner.reduce((sum, hole) => sum + Math.abs(signedArea(hole)), 0);
    const point = polygonLabelPoint([outer, ...inner]);
    if (point && (!best || point.distance > best.distance)) best = point;
  }
  const value = best ? { lonLat: frame.from(best.x, best.y), radiusMeters: best.distance, areaM2: Math.max(0, area) } : null;
  parcelGeometryCache.set(parcel, value);
  return value;
}

// One label candidate per outline with an owner: at the label point of its
// roomiest parcel, with the outline's total area as its priority.
export function ownerLabelCandidates(outlines) {
  const out = [];
  for (const outline of outlines) {
    if (!outline.owner) continue;
    let best = null, area = 0;
    for (const parcel of outline.parcels) {
      const geometry = parcelLabelGeometry(parcel);
      if (!geometry) continue;
      area += geometry.areaM2;
      if (!best || geometry.radiusMeters > best.radiusMeters) best = geometry;
    }
    if (best) out.push({ text: outline.owner, ownerKey: outline.ownerKey, lon: best.lonLat[0], lat: best.lonLat[1], radiusMeters: best.radiusMeters, areaM2: area });
  }
  return out;
}

export function wrapOwnerLabel(text, { maxLineChars = OWNER_LABEL_LIMITS.maxLineChars, maxChars = OWNER_LABEL_LIMITS.maxChars } = {}) {
  let value = ownerDisplayName(text);
  if (value.length > maxChars) value = `${value.slice(0, maxChars - 1).trimEnd()}…`;
  if (value.length <= maxLineChars || !value.includes(' ')) return [value];
  const middle = value.length / 2;
  let split = -1;
  for (let i = 0; i < value.length; i++) if (value[i] === ' ' && (split < 0 || Math.abs(i - middle) < Math.abs(split - middle))) split = i;
  return [value.slice(0, split), value.slice(split + 1)];
}

export function ownerLabelFontPx(zoom, limits = OWNER_LABEL_LIMITS) {
  return Math.max(limits.fontMinPx, Math.min(limits.fontMaxPx, Math.round((limits.fontMinPx + (zoom - 15) * 1.5) * 2) / 2));
}

export function metersPerPixel(zoom, lat) {
  return EARTH_CIRCUMFERENCE * Math.cos(lat * DEG) / 2 ** (zoom + 8);
}

// Which labels to show for this view, and where (container pixels). A label
// is shown only when its outline is big enough on screen to hold it, and
// never on top of another: bigger outlines win. Text size follows the zoom.
// project(lon, lat) -> [x, y]; measure(text, fontPx) -> width in pixels.
export function placeOwnerLabels(candidates, { zoom, project, viewport, measure, limits = OWNER_LABEL_LIMITS } = {}) {
  if (!Number.isFinite(zoom) || zoom < limits.minLabelZoom) return [];
  const fontPx = ownerLabelFontPx(zoom, limits);
  const lineHeight = Math.round(fontPx * 1.2);
  const fitting = [];
  for (const candidate of candidates) {
    const mpp = metersPerPixel(zoom, candidate.lat);
    const radiusPx = candidate.radiusMeters / mpp, areaPx = candidate.areaM2 / (mpp * mpp);
    const lines = wrapOwnerLabel(candidate.text, limits);
    const width = Math.ceil(Math.max(...lines.map(line => measure(line, fontPx))));
    const height = lines.length * lineHeight;
    // Too small on screen: the text would spill well past the outline.
    if (radiusPx < Math.max(limits.minRadiusPx, height / 2 + 2) || width > radiusPx * 2.6 || areaPx < width * height * 1.5) continue;
    const [x, y] = project(candidate.lon, candidate.lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    // Whole labels only: one cut by the map edge is left out until panned into view.
    if (viewport && (x - width / 2 < 2 || y - height / 2 < 2 || x + width / 2 > viewport.width - 2 || y + height / 2 > viewport.height - 2)) continue;
    fitting.push({ text: candidate.text, ownerKey: candidate.ownerKey, lines, x, y, width, height, fontPx, lineHeight, areaPx });
  }
  fitting.sort((a, b) => b.areaPx - a.areaPx);
  const placed = [];
  const pad = limits.paddingPx;
  for (const label of fitting) {
    if (placed.length >= limits.maxLabels) break;
    const clash = placed.some(other => Math.abs(other.x - label.x) * 2 < other.width + label.width + pad * 2
      && Math.abs(other.y - label.y) * 2 < other.height + label.height + pad * 2);
    if (!clash) placed.push(label);
  }
  return placed;
}
