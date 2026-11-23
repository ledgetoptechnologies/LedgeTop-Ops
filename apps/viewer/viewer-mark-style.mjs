import { DEFAULT_COLOR, ICON_GROUPS, MARK_COLORS, MARK_ICONS, PIN_BOX, colorName, glyphSvg, markIconName, pinSvg, safeColor } from './viewer-mark-icons.mjs';

// How marks and categories look: the one place the panel, map and GeoJSON take
// colours and icons from. Changing pins or icons is a change here (and in the
// icon table), never in the store, the rules or the API. Markup is built only
// from the fixed icon table and validated colours.
export { MARK_COLORS, colorName, markIconName, safeColor };
export const ICONS_BY_GROUP = Object.freeze(ICON_GROUPS.map(group => Object.freeze({ group, icons: Object.entries(MARK_ICONS)
  .filter(([, icon]) => icon.group === group).map(([name, { label }]) => Object.freeze({ name, label, group })) })));
export const ICON_CHOICES = Object.freeze(ICONS_BY_GROUP.flatMap(({ icons }) => icons));
export const DEFAULT_STYLE = Object.freeze({ color: DEFAULT_COLOR, icon: 'pin' });
// An icon key is kept as it is, even one this build cannot draw (it shows as a
// dot): a newer build's icons must survive a save or an import here.
const ICON_KEY = /^[a-z0-9-]{1,32}$/;
export const isIconKey = name => typeof name === 'string' && ICON_KEY.test(name);
export const keepIcon = name => (isIconKey(name) ? name : DEFAULT_STYLE.icon);

// A category gives its marks a colour and icon to start from.
export const categoryStyle = category => (category ? { color: safeColor(category.color), icon: keepIcon(category.icon) } : { ...DEFAULT_STYLE });

export const iconMarkup = (name, color, size) => pinSvg(name, color, size);
export const categoryBadge = category => pinSvg(category.icon, category.color, 16);
export function markBadge(mark) {
  if (mark.geometry.type === 'Point') return pinSvg(mark.icon, mark.color, 16);
  const color = safeColor(mark.color), area = mark.geometry.type === 'Polygon', path = area ? 'M3 14L5 4l9 2 1 8z' : 'M2 14l5-8 4 5 5-8';
  return `<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path d="${path}" fill="none" stroke="#0b0d10" stroke-width="5"/>`
    + `<path d="${path}" fill="${area ? color + '55' : 'none'}" stroke="${color}" stroke-width="2"/></svg>`;
}

// Offered to someone with no categories yet; nothing is made until one is used.
// Generic on purpose. Keys match the server's list; names and looks are here.
const named = name => MARK_COLORS.find(item => item.name === name).color;
export const STARTER_CATEGORIES = Object.freeze([
  ['poi', 'Point of interest', 'flag', 'Blue'], ['building', 'Building', 'home', 'Brown'], ['access', 'Gate or access', 'gate', 'Charcoal'],
  ['road', 'Road or trail', 'trail', 'Yellow'], ['utility', 'Utility', 'tower', 'Purple'], ['water', 'Water', 'water', 'Teal'],
  ['vegetation', 'Vegetation', 'tree', 'Green'], ['hazard', 'Hazard', 'warning', 'Red'], ['boundary', 'Boundary or corner', 'corner', 'White'],
  ['equipment', 'Equipment', 'vehicle', 'Orange'], ['photo', 'Photo spot', 'camera', 'Blue'], ['other', 'Other', 'pin', 'Charcoal'],
].map(([key, name, icon, color]) => Object.freeze({ key, name, icon, color: named(color) })));

// ---- on the map -----------------------------------------------------------
export const FAR_OUT_ZOOM = 16;
const PIN_WIDTH = { normal: 32, far: 25, selected: 40 };
// A point's marker: markup, size and the pixel that sits on the position (the tip).
export function mapPin(mark, { selected = false, draft = false, far = false } = {}) {
  const width = selected ? PIN_WIDTH.selected : far ? PIN_WIDTH.far : PIN_WIDTH.normal, scale = width / PIN_BOX.width;
  const height = PIN_BOX.height * scale;
  return { html: pinSvg(mark.icon, mark.color, width, { selected, draft }), size: [width, height],
    anchor: [PIN_BOX.tipX * scale, PIN_BOX.tipY * scale], labelOffset: [0, -height] };
}
// Lines and areas: the colour over a dark casing that is drawn first.
export function mapStroke(mark, { selected = false } = {}) {
  const color = safeColor(mark.color), weight = selected ? 6 : 4;
  return { casing: { color: '#0b0d10', weight: weight + 3, opacity: 0.85 },
    line: { color, weight, ...(mark.geometry.type === 'Polygon' ? { fillColor: color, fillOpacity: 0.2 } : {}) } };
}
export const areaGlyph = mark => ({ html: glyphSvg(mark.icon, mark.color, 22), size: [22, 22], anchor: [11, 11] });
