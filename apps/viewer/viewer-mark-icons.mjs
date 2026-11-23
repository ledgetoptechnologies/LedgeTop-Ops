// Mark pins: our own glyphs, shapes and colours, drawn for this project (no
// third-party icon set). A mark stores an icon key and a colour only; its shape
// and glyph come from this table, so keep existing keys stable.
// [label, group, shape, glyph]. Glyphs are 24x24 strokes. The picker follows ICON_GROUPS.
// Shape is a second cue beside the glyph: round for hunting and general, square
// for built things, diamond for a hazard.
const TABLE = {
  ladder: ['Tree stand', 'Hunting', 'round', 'M9 21V7M15 21V7M9 11h6M9 15h6M9 19h6M4 7h16M19 7V3'],
  blind: ['Blind', 'Hunting', 'square', 'M4 20V9l8-5 8 5v11zM8 12h8v3H8z'],
  feed: ['Feeder', 'Hunting', 'round', 'M6 4h12l-2 8H8zM8 12l-3 9M16 12l3 9M12 12v5'],
  plot: ['Food plot', 'Hunting', 'round', 'M12 20v-9M12 12C12 8 9 6 5 6c0 4 3 6 7 6M12 14c0-3 3-5 7-5 0 4-3 5-7 5M4 20h16'],
  trailcam: ['Trail camera', 'Hunting', 'square', 'M7 4h10v16H7zM9.5 9.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M10 16h4M3 8h4M17 8h4'],
  track: ['Sighting', 'Hunting', 'round', 'M10 4C6 8 5 14 7 19c3-1 4-5 4-9zM14 4c4 4 5 10 3 15-3-1-4-5-4-9z'],
  rub: ['Rub, scrape', 'Hunting', 'round', 'M8 3v18M16 3v18M11 8l3 3M11 12l3 3M11 4l3 3'],
  bed: ['Bedding', 'Hunting', 'round', 'M3 14c0-4 4-6 9-6s9 2 9 6-4 5-9 5-9-1-9-5M8 13c2-2 6-2 8 0'],
  tree: ['Tree', 'Land', 'round', 'M12 3l6 9h-3l4 5H5l4-5H6zM12 17v4'],
  water: ['Water', 'Land', 'round', 'M12 3c3.5 4.5 6 8 6 11a6 6 0 0 1-12 0c0-3 2.5-6.5 6-11z'],
  crossing: ['Crossing', 'Land', 'round', 'M3 9c3-3 6 3 9 0s6 3 9 0M3 16c3-3 6 3 9 0s6 3 9 0'],
  culvert: ['Culvert', 'Land', 'square', 'M3 6h18M7 14a5 5 0 1 0 10 0a5 5 0 1 0-10 0'],
  home: ['Building', 'Land', 'square', 'M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-6h4v6'],
  fence: ['Fence', 'Land', 'square', 'M6 4v17M18 4v17M3 9h18M3 15h18'],
  gate: ['Gate', 'Access', 'square', 'M4 5v15M20 5v15M4 8h16M4 17h16M4 17L20 8'],
  post: ['Sign', 'Access', 'square', 'M12 21V11M4 4h16v7H4z'],
  park: ['Parking', 'Access', 'square', 'M8 20V4h5a5 5 0 0 1 0 10H8'],
  trail: ['Trail', 'Access', 'round', 'M6 21c0-6 11-5 11-10 0-4-6-3-6-8'],
  vehicle: ['Vehicle', 'Access', 'square', 'M3 16v-4l2-5h14l2 5v4zM3 12h18M7 16v3M17 16v3'],
  corner: ['Corner', 'Access', 'square', 'M6 4v14h14M13 8v3h3'],
  pin: ['Dot', 'General', 'round', 'M8 12a4 4 0 1 0 8 0a4 4 0 1 0-8 0'],
  flag: ['Flag', 'General', 'round', 'M6 21V4M6 4h11l-2 4 2 4H6'],
  star: ['Star', 'General', 'round', 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z'],
  warning: ['Hazard', 'General', 'diamond', 'M12 4v10M12 19v.6'],
  cross: ['Cross', 'General', 'round', 'M6 6l12 12M18 6L6 18'],
  tent: ['Camp', 'General', 'round', 'M3 20L12 4l9 16zM9 20l3-6 3 6'],
  camera: ['Photo point', 'General', 'round', 'M4 8h4l2-3h4l2 3h4v11H4zM9 13.5a3 3 0 1 0 6 0a3 3 0 1 0-6 0'],
  target: ['Survey point', 'General', 'round', 'M5 12a7 7 0 1 0 14 0a7 7 0 1 0-14 0M12 2v6M12 16v6M2 12h6M16 12h6'],
  tower: ['Tower', 'General', 'square', 'M12 3l-5 18M12 3l5 18M8.5 15h7M10 9h4'],
  square: ['Square', 'General', 'square', 'M6 6h12v12H6z'],
};
export const MARK_ICONS = Object.freeze(Object.fromEntries(Object.entries(TABLE)
  .map(([key, [label, group, shape, path]]) => [key, Object.freeze({ label, group, shape, path })])));
export const ICON_GROUPS = Object.freeze(['General', 'Land', 'Access', 'Hunting']);
export const markIconName = name => (Object.hasOwn(MARK_ICONS, name) ? name : 'pin');

// Ten named colours. Any other colour a mark has is kept and reads as Custom.
// Orange comes last and is darker than the property lines.
export const MARK_COLORS = Object.freeze([['Charcoal', '#1f2328'], ['White', '#ffffff'], ['Red', '#c62828'], ['Blue', '#1565c0'],
  ['Green', '#2e7d32'], ['Brown', '#6d4c41'], ['Purple', '#6a1b9a'], ['Yellow', '#f9c80e'], ['Teal', '#00707a'], ['Orange', '#cc4706']]
  .map(([name, color]) => Object.freeze({ name, color })));
export const DEFAULT_COLOR = MARK_COLORS[0].color;
const SAFE_COLOR = /^#[0-9a-f]{6}$/i;
export const safeColor = color => (SAFE_COLOR.test(color || '') ? color.toLowerCase() : DEFAULT_COLOR);
export const colorName = color => MARK_COLORS.find(item => item.color === safeColor(color))?.name || 'Custom';

function luminance(color) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [high, low] = [luminance(safeColor(a)), luminance(safeColor(b))].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}
// The glyph is dark or white, whichever reads better on the pin.
export const glyphColor = color => (contrast(color, '#ffffff') >= contrast(color, '#111111') ? '#ffffff' : '#111111');

// The tip is at (16, 38.5) in a 32 x 40 box.
const BODIES = Object.freeze({
  round: 'M16 38.5L9.5 26.3A13 13 0 1 1 22.5 26.3Z',
  square: 'M7.5 2.5h17a4 4 0 0 1 4 4v17a4 4 0 0 1-4 4h-4L16 38.5 11.5 27.5h-4a4 4 0 0 1-4-4v-17a4 4 0 0 1 4-4z',
  diamond: 'M16 .8L30.2 15 20 25.2 16 38.5 12 25.2 1.8 15z',
});
export const PIN_BOX = Object.freeze({ width: 32, height: 40, tipX: 16, tipY: 38.5 });

// Markup is built only from the tables above and a validated colour. A white
// ring and a dark edge keep every colour readable on forest, crop, gravel and snow.
export function pinSvg(name, color, width, { selected = false, draft = false } = {}) {
  const { shape, path } = MARK_ICONS[markIconName(name)], fill = safeColor(color), body = BODIES[shape];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 40" width="${width}" height="${width * 1.25}" overflow="visible" aria-hidden="true">`
    + (selected ? '<circle cx="16" cy="38.5" r="4.5" fill="none" stroke="#000000" stroke-width="4"/><circle cx="16" cy="38.5" r="4.5" fill="none" stroke="#ffffff" stroke-width="2"/>' : '')
    + `<path d="${body}" fill="none" stroke="#0b0d10" stroke-width="${selected ? 8 : 4.6}" stroke-linejoin="round"/>`
    + `<path d="${body}" fill="${fill}" stroke="#ffffff" stroke-width="${selected ? 4 : 2.2}" stroke-linejoin="round"${draft ? ' stroke-dasharray="4 3"' : ''}/>`
    + `<g transform="translate(7.6 6.6) scale(.7)" fill="none" stroke="${glyphColor(fill)}" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></g></svg>`;
}

// The glyph alone on a disc, for the middle of an area.
export function glyphSvg(name, color, size) {
  const fill = safeColor(color);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" overflow="visible" aria-hidden="true">`
    + `<circle cx="12" cy="12" r="11" fill="${fill}" stroke="#0b0d10" stroke-width="4"/><circle cx="12" cy="12" r="11" fill="${fill}" stroke="#ffffff" stroke-width="2"/>`
    + `<g transform="translate(4.8 4.8) scale(.6)" fill="none" stroke="${glyphColor(fill)}" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="${MARK_ICONS[markIconName(name)].path}"/></g></svg>`;
}
