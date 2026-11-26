// Owner names on property lines: touching parcels of one owner become one
// outline, and each outline gets one clean label in its middle. Pure maths,
// no DOM and no network; shared by the map views, 3D views and tests.
//
// Parcels arrive as { id, rings: [[[lon, lat], ...], ...], owner?, lines? }
// (see property-lines.mjs). A parcel the server clipped at its coverage
// envelope has `lines`, its real boundary; its rings, closed along the
// envelope, then serve as shape only (labels, merging) and are not drawn. Esri rings are closed, outer rings clockwise and holes
// anticlockwise; orientation is enforced here so any source works.

const DEG = Math.PI / 180;
const SQRT2 = Math.SQRT2;
const EARTH_CIRCUMFERENCE = 40075016.686;

export const OWNER_LABEL_LIMITS = Object.freeze({
  snapMeters: 0.2,       // vertices closer than this are the same corner
  splitBudget: 2_000_000, // per parcel: edges x neighbouring corners checked for T-junctions
  minLabelZoom: 14,      // no owner names when zoomed out further
  minAcreageZoom: 15,    // no acreage when zoomed out further
  minRadiusPx: 14,       // a circle this big must fit inside the shape
  fontMinPx: 10,
  fontMaxPx: 15,
  maxLabels: 150,
  paddingPx: 6,          // clear space between two labels
  maxLineChars: 18,      // longer names wrap onto a second line
  maxChars: 40,          // and are cut with an ellipsis beyond this
});

// Placeholder "owners" that name nobody. Merging on them would join whole
// runs of unrelated neighbours, so they never merge or label. A name made
// only of these words (or with no letters at all) is a placeholder. From the
// V12 statewide data (checked 2026-11-23): NOT AVAILABLE (about 90,000
// parcels), NOT AVAILABLE NOT AVAILABLE, UNKNOWN OWNER, UNKNOWN, OWNER
// UNKNOWN, UNKNOWN UNKNOWN, UNKNOWN OWNERSHIP, UNKNOWN OWNER UNTILRESEARCHED,
// PRIVATE and REDACTED; the rest are common placeholders elsewhere.
const PLACEHOLDER_OWNER_WORDS = new Set([
  'NOT', 'AVAILABLE', 'UNAVAILABLE', 'UNKNOWN', 'UNK', 'OWNER', 'OWNERS', 'OWNERSHIP', 'UNTILRESEARCHED', 'NONE', 'NULL',
  'N/A', 'NA', 'TBD', 'REDACTED', 'WITHHELD', 'CONFIDENTIAL', 'PRIVATE', 'PROVIDED', 'LISTED', 'UNASSIGNED', 'NO', 'NAME',
]);
export function isPlaceholderOwner(normalized) {
  if (!normalized || !/\p{L}/u.test(normalized)) return true;
  return normalized.split(' ').every(word => PLACEHOLDER_OWNER_WORDS.has(word));
}

// The key two parcels must share to count as one owner: case, punctuation
// spacing and repeated whitespace do not matter. Empty means "no owner",
// including placeholders such as NOT AVAILABLE or UNKNOWN.
export function normalizeOwnerName(name) {
  if (typeof name !== 'string') return '';
  const key = name.normalize('NFKC').toUpperCase().replace(/[.,;]/g, ' ').replace(/\s+/g, ' ').trim();
  return isPlaceholderOwner(key) ? '' : key;
}

// The text shown: the owner's name as published, with whitespace tidied;
// nothing for a placeholder.
export function ownerDisplayName(name) {
  return typeof name === 'string' && normalizeOwnerName(name) ? name.replace(/\s+/g, ' ').trim() : '';
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

// ── Acreage ──────────────────────────────────────────────────────────────

// GRS80, the ellipsoid of the NAD83 parcel data (WGS84 differs by 1e-10).
const GRS80_A = 6378137, GRS80_F = 1 / 298.257222101;
const GRS80_E2 = GRS80_F * (2 - GRS80_F), GRS80_E = Math.sqrt(GRS80_E2);
const SQUARE_METERS_PER_ACRE = 4046.8564224;

// Northing on the ellipsoid's equal-area cylinder (authalic latitude): with
// easting a * longitude, plane areas equal true areas on the ellipsoid at any
// latitude. The Web Mercator rings the state serves are about twice the true
// size in Wisconsin, and the label frame above is about 0.7% small; neither
// is ever used for an area that is shown.
function equalAreaNorthing(lat) {
  const s = Math.sin(lat * DEG), es = GRS80_E * s;
  return GRS80_A * (1 - GRS80_E2) / 2 * (s / (1 - es * es) + Math.atanh(es) / GRS80_E);
}

// A parcel's area in square metres on the ellipsoid: outer rings less holes,
// plus islands. Null when any ring is not closed: that is not a whole shape.
export function parcelAreaM2(parcel) {
  if (!parcel?.rings?.length) return null;
  for (const ring of parcel.rings) {
    const first = ring[0], last = ring[ring.length - 1];
    if (ring.length < 4 || first[0] !== last[0] || first[1] !== last[1]) return null;
  }
  const area = orientedRings(parcel, equalAreaFrame(parcel.rings[0][0])).reduce((sum, { pts }) => sum + signedArea(pts), 0);
  return area > 0 ? area : null;
}

function equalAreaFrame([lon0, lat0]) {
  const y0 = equalAreaNorthing(lat0);
  return { to: (lon, lat) => [GRS80_A * (lon - lon0) * DEG, equalAreaNorthing(lat) - y0] };
}

// The area covered by any of the parcels, so land under two of them counts
// once. The plane is cut into horizontal slabs at every corner and every edge
// crossing; inside a slab no edges cross, so its covered width at mid-height
// times its height is exact. Null past the work budget: no total rather than
// a guess.
const UNION_WORK = 8_000_000;
function unionAreaM2(parcels, budget = UNION_WORK) {
  const frame = equalAreaFrame(parcels[0].rings[0][0]);
  const edges = [], levels = [];
  parcels.forEach((parcel, owner) => {
    for (const ring of parcel.rings) {
      const pts = ring.map(([lon, lat]) => frame.to(lon, lat));
      for (let i = 1; i < pts.length; i++) {
        const [a, b] = pts[i - 1][1] <= pts[i][1] ? [pts[i - 1], pts[i]] : [pts[i], pts[i - 1]];
        levels.push(a[1]);
        if (a[1] < b[1]) edges.push({ owner, x0: a[0], y0: a[1], x1: b[0], y1: b[1], minX: Math.min(a[0], b[0]), maxX: Math.max(a[0], b[0]), slope: (b[0] - a[0]) / (b[1] - a[1]) });
        levels.push(b[1]);
      }
    }
  });
  edges.sort((a, b) => a.y0 - b.y0);
  let work = 0, active = [];
  for (const edge of edges) {
    const still = [];
    for (const other of active) {
      work++;
      if (other.y1 <= edge.y0) continue;
      still.push(other);
      if (other.maxX < edge.minX || other.minX > edge.maxX || other.slope === edge.slope) continue;
      const y = (edge.x0 - other.x0 + other.slope * other.y0 - edge.slope * edge.y0) / (other.slope - edge.slope);
      if (y > edge.y0 && y < Math.min(edge.y1, other.y1)) levels.push(y);
    }
    still.push(edge);
    active = still;
    if (work > budget) return null;
  }
  levels.sort((a, b) => a - b);
  let area = 0, next = 0;
  active = [];
  for (let i = 1; i < levels.length; i++) {
    const low = levels[i - 1], high = levels[i];
    if (!(high > low)) continue;
    const mid = (low + high) / 2;
    active = active.filter(edge => edge.y1 > low);
    while (next < edges.length && edges[next].y0 <= low) { if (edges[next].y1 > low) active.push(edges[next]); next++; }
    work += active.length;
    if (work > budget) return null;
    const crossings = active.map(edge => [edge.x0 + edge.slope * (mid - edge.y0), edge.owner]).sort((a, b) => a[0] - b[0]);
    // Inside a parcel after an odd number of its own edges; covered while inside any.
    const inside = new Set();
    let start = 0;
    for (const [x, owner] of crossings) {
      if (!inside.size) start = x;
      if (!inside.delete(owner)) inside.add(owner);
      if (!inside.size) area += (x - start) * (high - low);
    }
  }
  return area > 0 ? area : null;
}

// One parcel's area when its rings are sound: the signed ring sum and the area
// actually covered agree. Crossed, doubled or overlapping rings do not, and
// have no area to state. Cached per parcel object, like the label geometry.
const soundAreaCache = new WeakMap();
function soundAreaM2(parcel) {
  if (!soundAreaCache.has(parcel)) {
    const signed = parcelAreaM2(parcel), covered = signed == null ? null : unionAreaM2([parcel]);
    soundAreaCache.set(parcel, covered != null && Math.abs(signed - covered) <= 0.5 + signed * 1e-5 ? signed : null);
  }
  return soundAreaCache.get(parcel);
}

// Two parcels with the same rings, whatever their start corner, direction or
// order: stacked records (condominium units), one piece of land.
function shapeKey(parcel) {
  return parcel.rings.map(ring => {
    const corners = ring.slice(0, -1).map(p => p.join(','));
    let start = 0;
    corners.forEach((corner, i) => { if (corner < corners[start]) start = i; });
    const turned = [...corners.slice(start), ...corners.slice(0, start)];
    const reversed = [turned[0], ...turned.slice(1).reverse()];
    return [turned.join(';'), reversed.join(';')].sort()[0];
  }).sort().join('|');
}

// An outline's whole area in square metres, or null when it cannot be stated:
// a parcel the server clipped (`lines`) or left open, an owner's land that
// may continue past the loaded tiles, or land too intricate to add up. Land
// under two of the owner's records counts once.
// covered(bounds): whether everything touching those lon/lat bounds is loaded.
// Only needed for land that can be merged; a single parcel arrives whole.
function landLoaded(outline, covered) {
  if (!covered) return false;
  for (const parcel of outline.parcels) for (const ring of parcel.rings) {
    const { minX, minY, maxX, maxY } = bboxOf([ring]);
    if (!covered({ west: minX, south: minY, east: maxX, north: maxY })) return false;
  }
  return true;
}
export function outlineAreaM2(outline, { merged = true, covered = null } = {}) {
  if (outline.parcels.some(parcel => Array.isArray(parcel.lines))) return null;
  if (merged && outline.ownerKey && !landLoaded(outline, covered)) return null;
  const parcels = outline.parcels.length > 1 ? [...new Map(outline.parcels.map(parcel => [shapeKey(parcel), parcel])).values()] : outline.parcels;
  if (parcels.some(parcel => soundAreaM2(parcel) == null)) return null;
  return parcels.length === 1 ? soundAreaM2(parcels[0]) : unionAreaM2(parcels);
}

// The land of the outline's parcels as the public parcel data states it, in
// square metres, or null when any parcel has no stated value (or, merged, when
// the owner's land may continue past the loaded tiles). Each record counts
// once; records over the same land count once. Which record speaks for the
// same land does not depend on the order they arrived in: the one with a
// stated value and the lowest id, then the lowest value.
// One record per piece of land, the same whatever order the records came in:
// the one with a stated value and the lowest id, then the lowest value.
const recordRank = parcel => [parcel.acres > 0 ? 0 : 1, Number.isSafeInteger(parcel.id) ? parcel.id : Infinity, parcel.acres > 0 ? parcel.acres : 0];
export function sameLandOnce(parcels) {
  const ordered = [...parcels].sort((a, b) => { const x = recordRank(a), y = recordRank(b); return x[0] - y[0] || (x[1] === y[1] ? 0 : x[1] < y[1] ? -1 : 1) || x[2] - y[2]; });
  const first = (list, key) => { const kept = new Map(); for (const parcel of list) { const k = key(parcel); if (!kept.has(k)) kept.set(k, parcel); } return [...kept.values()]; };
  return first(first(ordered, parcel => parcel.id ?? shapeKey(parcel)), shapeKey);
}
export function publishedAreaM2(outline, { merged = true, covered = null } = {}) {
  if (merged && outline.ownerKey && !landLoaded(outline, covered)) return null;
  const unique = sameLandOnce(outline.parcels);
  if (!unique.length || unique.some(parcel => !(parcel.acres > 0))) return null;
  return unique.reduce((sum, parcel) => sum + parcel.acres, 0) * SQUARE_METERS_PER_ACRE;
}

// "40.2 ac" for a stated value, "~40.2 ac" for one computed from the lines:
// one decimal from 1 acre, two below, square feet under 0.1 acre; hectares or
// square metres in metric.
export function formatParcelArea(squareMeters, units = 'imperial', { approx = true } = {}) {
  if (!Number.isFinite(squareMeters) || squareMeters <= 0) return '';
  const metric = units === 'metric';
  const value = squareMeters / (metric ? 10_000 : SQUARE_METERS_PER_ACRE);
  if (value < 0.1) {
    const small = metric ? squareMeters : squareMeters / SQUARE_METERS_PER_ACRE * 43560;
    return `${approx ? '~' : ''}${Math.max(10, Math.round(small / 10) * 10).toLocaleString('en-US')} ${metric ? 'm²' : 'sq ft'}`;
  }
  const digits = value < 0.995 ? 2 : 1;
  return `${approx ? '~' : ''}${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${metric ? 'ha' : 'ac'}`;
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

// Whether most of one ring's corners and edge middles lie inside another, so
// a hole that touches its outer ring at a corner is still a hole.
function mostlyInside(pts, other) {
  const step = Math.max(1, Math.floor(pts.length / 16));
  let votes = 0, inside = 0;
  for (let i = 1; i < pts.length; i += step) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    for (const [x, y] of [[ax, ay], [(ax + bx) / 2, (ay + by) / 2]]) { votes++; if (pointInRing(x, y, other)) inside++; }
  }
  return inside * 2 > votes;
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
  // A ring inside an odd number of the parcel's other rings is a hole; an
  // island inside a hole (inside two) is an outer ring again.
  return rings.map((pts, index) => {
    const depth = rings.filter((other, j) => j !== index && mostlyInside(pts, other)).length;
    const hole = depth % 2 === 1;
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
// flags[i] belongs to segment ids[i] -> ids[i + 1]; the pieces of a split
// segment keep its flag. Returns { ids, flags }.
function splitAtVertices(ids, flags, verts, candidates, snap) {
  if (!candidates.length) return { ids, flags };
  const out = [ids[0]], outFlags = [];
  const push = (id, flag) => { if (out[out.length - 1] !== id) { out.push(id); outFlags.push(flag); } };
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
      for (const [, id] of hits) push(id, flags[i - 1]);
    }
    push(ids[i], flags[i - 1]);
  }
  return { ids: out, flags: outFlags };
}

// What to stroke for one parcel: its real boundary. A parcel the server
// clipped at its coverage envelope says so itself (`lines`, the original
// edges clipped one by one); otherwise its rings are its boundary.
export function parcelStrokeLines(parcel) {
  return Array.isArray(parcel.lines) ? parcel.lines : parcel.rings;
}

// Within this distance (metres) a clipped parcel's ring segment counts as
// lying on its own real boundary: rounding only (coordinates are 1e-7°).
const PROVENANCE_METERS = 0.05;
function onSegment(p, [a, b], tolerance) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
  const t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
  if (t < -1e-9 || t > 1 + 1e-9) return Math.min(Math.hypot(p[0] - a[0], p[1] - a[1]), Math.hypot(p[0] - b[0], p[1] - b[1])) <= tolerance;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) <= tolerance;
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
  // Each ring segment carries where it came from: real boundary, or (for a
  // parcel the server clipped) a closing segment along the envelope. That
  // is decided per parcel, in its own unsnapped coordinates, against its own
  // real boundary (`lines`); the flag then travels with the segment through
  // snapping and splitting, and only real segments are ever stroked.
  const items = group.map(parcel => {
    const real = Array.isArray(parcel.lines) ? parcel.lines.flatMap(line => line.slice(1).map((p, k) => [frame.to(...line[k]), frame.to(...p)])) : null;
    const genuine = (p, q) => !real || real.some(seg => onSegment(p, seg, PROVENANCE_METERS) && onSegment(q, seg, PROVENANCE_METERS));
    const rings = [], flags = [];
    for (const { pts } of orientedRings(parcel, frame)) {
      const ids = [], segmentFlags = [];
      for (let k = 0; k < pts.length; k++) {
        const id = index.id(pts[k][0], pts[k][1]);
        if (ids[ids.length - 1] === id) continue;
        if (ids.length) segmentFlags.push(genuine(pts[k - 1], pts[k]));
        ids.push(id);
      }
      if (ids.length >= 4) { rings.push(ids); flags.push(segmentFlags); }
    }
    return { parcel, rings, flags, bbox: bboxOf(rings.map(ids => ids.map(id => index.verts[id]))), vertexIds: [...new Set(rings.flat())] };
  });
  // Insert neighbours' corners into edges, within the per-parcel budget. Over
  // it (very dense same-owner land), only edges whose corners already match
  // cancel, and a shared stretch with unmatched corners stays drawn.
  for (const item of items) {
    const candidates = [];
    for (const other of items) if (other !== item && bboxTouch(item.bbox, other.bbox, snap)) candidates.push(...other.vertexIds);
    const edges = item.rings.reduce((n, ids) => n + ids.length, 0);
    if (candidates.length && edges * candidates.length <= splitBudget) {
      const split = item.rings.map((ids, r) => splitAtVertices(ids, item.flags[r], index.verts, candidates, snap));
      item.rings = split.map(s => s.ids); item.flags = split.map(s => s.flags);
    }
  }
  // Directed edges; an edge also present in the opposite direction from
  // another parcel is a shared boundary inside the owner's land.
  const edgeOwners = new Map(), realEdges = new Set();
  items.forEach((item, i) => {
    item.rings.forEach((ids, r) => {
      for (let k = 1; k < ids.length; k++) {
        if (ids[k - 1] === ids[k]) continue;
        const key = `${ids[k - 1]}>${ids[k]}`;
        if (!edgeOwners.has(key)) edgeOwners.set(key, new Set());
        edgeOwners.get(key).add(i);
        if (item.flags[r][k - 1]) realEdges.add(key);
      }
    });
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
    if (!realEdges.has(key)) continue;   // a closing segment along the envelope: shape only
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
  for (const { ownerKey, parcels: all } of groups.values()) {
    // Records over the same land of one owner are one parcel before dissolving, so none is lost with its acres.
    const group = all.length > 1 ? sameLandOnce(all) : all;
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
// acreage: null for names only, or { merged, covered } (see outlineAreaM2) to
// add the area shown under the name. Without merging, a parcel with no usable
// owner name shows its area alone.
export function ownerLabelCandidates(outlines, { acreage = null } = {}) {
  const out = [];
  for (const outline of outlines) {
    // The public value when every parcel has one; else the area of the lines, marked approximate.
    const published = acreage ? publishedAreaM2(outline, acreage) : null;
    const shownArea = published ?? (acreage ? outlineAreaM2(outline, acreage) : null);
    if (!outline.owner && (shownArea == null || acreage.merged !== false)) continue;
    let best = null, area = 0, home = null;
    for (const parcel of outline.parcels) {
      const geometry = parcelLabelGeometry(parcel);
      if (!geometry) continue;
      area += geometry.areaM2;
      if (!best || geometry.radiusMeters > best.radiusMeters) { best = geometry; home = parcel; }
    }
    if (best) out.push({ text: outline.owner, ownerKey: outline.ownerKey, lon: best.lonLat[0], lat: best.lonLat[1], radiusMeters: best.radiusMeters, areaM2: area, rings: home.rings, ...(shownArea == null ? {} : { acreageM2: shownArea, acreageApprox: published == null }) });
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
// Names come first: they are placed exactly as without acreage. Then each
// acreage line is added where the taller label still fits its outline and the
// view and stays clear of every other label; labels that are acreage alone
// (no owner name) come last.
export function placeOwnerLabels(candidates, { zoom, project, viewport, measure, units = 'imperial', limits = OWNER_LABEL_LIMITS } = {}) {
  if (!Number.isFinite(zoom) || zoom < limits.minLabelZoom) return [];
  const largest = ownerLabelFontPx(zoom, limits);
  // The whole label box inside its own parcel: corners inside, no edge of the
  // parcel crossing it. A label that does not fit is tried smaller, then left out.
  const insideOwn = (candidate, box) => {
    if (!candidate.rings) return true;
    const rings = candidate.rings.map(ring => ring.map(([lon, lat]) => project(lon, lat)));
    const inside = (px, py) => { let hit = false; for (const ring of rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) hit = !hit; } return hit; };
    const { left, top, right, bottom } = box;
    if (![[left, top], [right, top], [left, bottom], [right, bottom]].every(([px, py]) => inside(px, py))) return false;
    const crosses = ([x0, y0], [x1, y1]) => { let t0 = 0, t1 = 1; const dx = x1 - x0, dy = y1 - y0;
      for (const [p, q] of [[-dx, x0 - left], [dx, right - x0], [-dy, y0 - top], [dy, bottom - y0]]) {
        if (p === 0) { if (q < 0) return false; continue; }
        const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; } }
      return true; };
    return !rings.some(ring => ring.some((point, i) => i > 0 && crosses(ring[i - 1], point)));
  };
  // The label for these lines, or null where it does not fit.
  const fit = (candidate, lines) => {
    for (let fontPx = largest; fontPx >= limits.fontMinPx; fontPx--) {
      const label = fitAt(candidate, lines, fontPx);
      if (label) return label;
    }
    return null;
  };
  const fitAt = (candidate, lines, fontPx) => {
    const lineHeight = Math.round(fontPx * 1.2);
    const mpp = metersPerPixel(zoom, candidate.lat);
    const radiusPx = candidate.radiusMeters / mpp, areaPx = candidate.areaM2 / (mpp * mpp);
    const width = Math.ceil(Math.max(...lines.map(line => measure(line, fontPx))));
    const height = lines.length * lineHeight;
    // Too small on screen: the text would spill well past the outline.
    if (radiusPx < Math.max(limits.minRadiusPx, height / 2 + 2) || width > radiusPx * 2.6 || areaPx < width * height * 1.5) return null;
    const [x, y] = project(candidate.lon, candidate.lat);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Whole labels only: one cut by the map edge is left out until panned into view.
    if (viewport && (x - width / 2 < 2 || y - height / 2 < 2 || x + width / 2 > viewport.width - 2 || y + height / 2 > viewport.height - 2)) return null;
    if (!insideOwn(candidate, { left: x - width / 2 - 1, top: y - height / 2 - 1, right: x + width / 2 + 1, bottom: y + height / 2 + 1 })) return null;
    return { text: candidate.text, ownerKey: candidate.ownerKey, lines, x, y, width, height, fontPx, lineHeight, areaPx, candidate };
  };
  const pad = limits.paddingPx;
  const clear = (label, others) => !others.some(other => Math.abs(other.x - label.x) * 2 < other.width + label.width + pad * 2
    && Math.abs(other.y - label.y) * 2 < other.height + label.height + pad * 2);
  const place = (labels, placed) => {
    for (const label of labels.filter(Boolean).sort((a, b) => b.areaPx - a.areaPx)) {
      if (placed.length >= limits.maxLabels) break;
      if (clear(label, placed)) placed.push(label);
    }
    return placed;
  };
  const acreage = candidate => (zoom >= limits.minAcreageZoom ? formatParcelArea(candidate.acreageM2, units, { approx: candidate.acreageApprox !== false }) : '');
  const placed = place(candidates.filter(c => c.text).map(c => fit(c, wrapOwnerLabel(c.text, limits))), []);
  placed.forEach((label, i) => {
    const line = acreage(label.candidate);
    const taller = line && fit(label.candidate, [...label.lines, line]);
    if (taller && clear(taller, placed.filter((_, j) => j !== i))) placed[i] = taller;
  });
  place(candidates.filter(c => !c.text && acreage(c)).map(c => fit(c, [acreage(c)])), placed);
  return placed.map(({ candidate, ...label }) => label);
}
