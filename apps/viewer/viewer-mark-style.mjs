import { DEFAULT_COLOR, MARK_ICONS, MARK_SWATCHES, markIconName, markIconSvg, safeColor } from './viewer-mark-icons.mjs';

// How marks and categories look: the one place the panel, map and GeoJSON take
// colours and icons from. Changing pins or icons is a change here (and in the
// icon table), never in the store, the rules or the API. Markup is built only
// from the fixed icon table and validated colours.
export { MARK_SWATCHES, markIconName, safeColor };
export const ICON_CHOICES = Object.freeze(Object.entries(MARK_ICONS).map(([name, { label }]) => Object.freeze({ name, label })));
export const DEFAULT_STYLE = Object.freeze({ color: DEFAULT_COLOR, icon: 'pin' });
// An icon key is kept as it is, even one this build cannot draw (it shows as a
// dot): a newer build's icons must survive a save or an import here.
const ICON_KEY = /^[a-z0-9-]{1,32}$/;
export const isIconKey = name => typeof name === 'string' && ICON_KEY.test(name);
export const keepIcon = name => (isIconKey(name) ? name : DEFAULT_STYLE.icon);

// A category gives its marks a colour and icon to start from.
export const categoryStyle = category => (category ? { color: safeColor(category.color), icon: keepIcon(category.icon) } : { ...DEFAULT_STYLE });

export const iconMarkup = (name, color, size) => markIconSvg(name, color, size);
export const categoryBadge = category => markIconSvg(category.icon, category.color, 18);
export function markBadge(mark) {
  if (mark.geometry.type === 'Point') return markIconSvg(mark.icon, mark.color, 18);
  const color = safeColor(mark.color), area = mark.geometry.type === 'Polygon';
  return `<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path d="${area ? 'M3 14L5 4l9 2 1 8z' : 'M2 14l5-8 4 5 5-8'}" fill="${area ? color + '55' : 'none'}" stroke="${color}" stroke-width="2"/></svg>`;
}
// The map marker for a point: markup, size and the pixel that sits on the position.
export const mapPin = mark => ({ html: markIconSvg(mark.icon, mark.color, 26), size: [26, 26], anchor: [13, 13], labelOffset: [0, -12] });
