// Generic mark symbols, drawn for this project (no third-party icon licence).
// Each is a 24x24 stroke path drawn white on the mark colour. Names are stored
// with marks, so keep existing names stable.
export const MARK_ICONS = Object.freeze({
  pin: { label: 'Dot', path: 'M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0' },
  flag: { label: 'Flag', path: 'M6 21V4M6 4h11l-2 4 2 4H6' },
  star: { label: 'Star', path: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z' },
  tree: { label: 'Tree', path: 'M12 3l6 9h-3l4 5H5l4-5H6zM12 17v4' },
  home: { label: 'Building', path: 'M4 11l8-7 8 7M6 9.5V20h12V9.5M10 20v-6h4v6' },
  gate: { label: 'Gate', path: 'M4 5v15M20 5v15M4 8h16M4 16h16M8 8v8M12 8v8M16 8v8' },
  ladder: { label: 'Stand', path: 'M8 3v18M16 3v18M8 7h8M8 11h8M8 15h8M8 19h8' },
  feed: { label: 'Bucket', path: 'M5 8h14l-2 12H7zM5 8a7 3 0 0 1 14 0' },
  water: { label: 'Water', path: 'M12 3c3.5 4.5 6 8 6 11a6 6 0 0 1-12 0c0-3 2.5-6.5 6-11z' },
  camera: { label: 'Camera', path: 'M4 8h4l2-3h4l2 3h4v11H4zM12 14m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0' },
  warning: { label: 'Warning', path: 'M12 3l10 18H2zM12 10v5M12 18v.5' },
  cross: { label: 'Cross', path: 'M6 6l12 12M18 6L6 18' },
  target: { label: 'Survey point', path: 'M12 12m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M12 2v6M12 16v6M2 12h6M16 12h6' },
  tower: { label: 'Tower', path: 'M12 3l-5 18M12 3l5 18M8.5 15h7M10 9h4M12 3v2' },
  tent: { label: 'Tent', path: 'M3 20L12 4l9 16zM12 4v16M9 20l3-5 3 5' },
  vehicle: { label: 'Vehicle', path: 'M3 16v-4l2-5h14l2 5v4zM3 12h18M7 16v3M17 16v3' },
  post: { label: 'Sign', path: 'M12 21V10M5 4h14v6H5z' },
  square: { label: 'Square', path: 'M6 6h12v12H6z' },
});

export const MARK_SWATCHES = Object.freeze(['#212121', '#ffffff', '#f8cb2e', '#e53935', '#43a047', '#1e88e5',
  '#8e24aa', '#00acc1', '#6d4c41', '#ee5007']);

export const markIconName = name => (Object.hasOwn(MARK_ICONS, name) ? name : 'pin');

const SAFE_COLOR = /^#[0-9a-f]{6}$/i;
// The default is not the property-line orange, so a mark never reads as a boundary.
export const DEFAULT_COLOR = '#212121';
export const safeColor = color => (SAFE_COLOR.test(color || '') ? color.toLowerCase() : DEFAULT_COLOR);

// Dark glyph on light colours so a white or yellow marker still reads.
export function glyphColor(color) {
  const hex = safeColor(color);
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 170 ? '#111111' : '#ffffff';
}

// Markup is built only from the fixed table above and a validated colour.
export function markIconSvg(name, color, size = 24) {
  const fill = safeColor(color), glyph = glyphColor(fill);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">`
    + `<circle cx="12" cy="12" r="11" fill="${fill}" stroke="#ffffff" stroke-width="1.5"/>`
    + `<g transform="translate(5.4 5.4) scale(.55)" fill="none" stroke="${glyph}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">`
    + `<path d="${MARK_ICONS[markIconName(name)].path}"/></g></svg>`;
}
