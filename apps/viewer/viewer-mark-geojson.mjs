import { MARK_ICONS, safeColor } from './viewer-mark-icons.mjs';

// GeoJSON (RFC 7946, WGS84 lon/lat) is the lossless exchange format for marks.
// Style uses simplestyle-spec names so other tools keep colours. Heights travel
// as elevation_navd88_m, never as a third coordinate.

export const IMPORT_LIMIT = 500;
const COLOR = /^#[0-9a-f]{6}$/i;
const SHORT_COLOR = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

export function marksToGeoJson(marks, categories = []) {
  const names = new Map(categories.map(category => [category.id, category.name]));
  return {
    type: 'FeatureCollection',
    features: marks.map(mark => {
      const color = safeColor(mark.color);
      const style = mark.geometry.type === 'Point' ? { 'marker-color': color, 'marker-symbol': mark.icon }
        : mark.geometry.type === 'LineString' ? { stroke: color, 'stroke-width': 3 }
          : { stroke: color, 'stroke-width': 2, fill: color, 'fill-opacity': 0.2 };
      return {
        type: 'Feature', id: mark.id, geometry: mark.geometry,
        properties: {
          name: mark.name, description: mark.note || '', category: names.get(mark.categoryId) || null,
          ...style, elevation_navd88_m: Number.isFinite(mark.elevationNavd88M) ? mark.elevationNavd88M : null,
          visibility: mark.visibility, updated_at: mark.updatedAt || null,
        },
      };
    }),
  };
}

function color(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (COLOR.test(text)) return text.toLowerCase();
  const short = text.match(SHORT_COLOR);
  return short ? ('#' + short.slice(1).map(c => c + c).join('')).toLowerCase() : null;
}

const text = (value, max) => (typeof value === 'string' || typeof value === 'number') ? String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const note = value => typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 2000) : '';
const position = value => Array.isArray(value) && Number.isFinite(value[0]) && Number.isFinite(value[1])
  && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90 ? [value[0], value[1]] : null;

// Split multi-part geometries into simple ones; drop what the tool cannot hold.
function simpleGeometries(geometry) {
  if (!geometry || typeof geometry !== 'object') return [];
  const { type, coordinates } = geometry;
  if (type === 'GeometryCollection') return (geometry.geometries || []).flatMap(simpleGeometries);
  if (type === 'MultiPoint') return (coordinates || []).map(c => ({ type: 'Point', coordinates: c })).flatMap(simpleGeometries);
  if (type === 'MultiLineString') return (coordinates || []).map(c => ({ type: 'LineString', coordinates: c })).flatMap(simpleGeometries);
  if (type === 'MultiPolygon') return (coordinates || []).map(c => ({ type: 'Polygon', coordinates: c })).flatMap(simpleGeometries);
  if (type === 'Point') { const p = position(coordinates); return p ? [{ type, coordinates: p }] : []; }
  if (type === 'LineString' && Array.isArray(coordinates)) {
    const line = coordinates.map(position);
    return line.length >= 2 && line.length <= 500 && line.every(Boolean) ? [{ type, coordinates: line }] : [];
  }
  if (type === 'Polygon' && Array.isArray(coordinates?.[0])) {
    const ring = coordinates[0].map(position);
    if (!ring.every(Boolean)) return [];
    const open = ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring.slice(0, -1) : ring;
    return open.length >= 3 && open.length <= 500 ? [{ type, coordinates: [[...open, open[0]]] }] : [];
  }
  return [];
}

// Returns marks ready to send and the categories the file names that the
// project does not have yet (matched by name, case-insensitive).
export function geoJsonToMarks(input, { categories = [], newId, visibility = 'private', defaultColor = '#ee5007' } = {}) {
  const features = input?.type === 'FeatureCollection' ? input.features
    : input?.type === 'Feature' ? [input]
      : input?.type ? [{ type: 'Feature', geometry: input, properties: {} }] : null;
  if (!Array.isArray(features)) throw new Error('This file is not GeoJSON.');
  const known = new Map(categories.map(category => [category.name.toLowerCase(), category]));
  const added = new Map();
  const marks = [];
  let skipped = 0;
  for (const feature of features) {
    const properties = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
    const geometries = simpleGeometries(feature?.geometry);
    if (!geometries.length) { skipped += 1; continue; }
    const categoryName = text(properties.category, 60);
    let category = categoryName ? known.get(categoryName.toLowerCase()) || added.get(categoryName.toLowerCase()) : null;
    const featureColor = color(properties['marker-color']) || color(properties.stroke) || color(properties.fill) || color(properties.color);
    const symbol = typeof properties['marker-symbol'] === 'string' && Object.hasOwn(MARK_ICONS, properties['marker-symbol'])
      ? properties['marker-symbol'] : null;
    if (categoryName && !category) {
      category = { id: newId(), name: categoryName, color: featureColor || defaultColor, icon: symbol || 'pin' };
      added.set(categoryName.toLowerCase(), category);
    }
    const elevation = Number(properties.elevation_navd88_m);
    const name = text(properties.name ?? properties.title ?? properties.label, 100) || categoryName || 'Imported mark';
    for (const geometry of geometries) {
      if (marks.length >= IMPORT_LIMIT) throw new Error(`Import up to ${IMPORT_LIMIT} marks at a time.`);
      marks.push({
        id: newId(), geometry, name, note: note(properties.description ?? properties.notes ?? properties.note),
        categoryId: category?.id || null, color: featureColor || category?.color || defaultColor,
        icon: symbol || category?.icon || 'pin', elevationNavd88M: properties.elevation_navd88_m != null
          && Number.isFinite(elevation) && elevation >= -500 && elevation <= 9000 ? elevation : null,
        visibility,
      });
    }
  }
  return { marks, categories: [...added.values()], skipped };
}
