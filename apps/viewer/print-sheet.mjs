// One printed sheet: page sizes, layout and drawing, for the preview, Print and
// Save PDF alike. Everything is laid out in sheet units (96 to the inch) and
// drawn at whatever dots per inch the output has, so the preview and the paper
// are the same picture. No DOM beyond the canvas it is given.
import { BRAND_COLORS } from './brand-colors.mjs';
import { CONTOUR_COLORS, CONTOUR_INDEX_EVERY, drawContours, unitMeters, unitSuffix } from './contours.mjs';
import { PROPERTY_LINES_NOTE, PROPERTY_LINE_STYLE_PRINT, UNCAPTURED_LABEL, applyClip, cleanAttribution, drawHatch, drawPropertyLines, isIosLike, niceLength, renderOrthoPixels } from './ortho-print-export.mjs';
import { placeOwnerLabels } from './property-lines-owners.mjs';

export const UNITS_PER_INCH = 96;
const METERS_PER_FOOT = 0.3048, EARTH_CIRCUMFERENCE = 40075016.686;

// Short side first; `dpi` is the most a page is drawn at. Tabloid at 300 would
// pass what iOS can draw; ARCH D is for desktops that can.
export const PRINT_PAGES = Object.freeze({
  letter: Object.freeze({ label: 'Letter (8.5 × 11 in)', shortIn: 8.5, longIn: 11, dpi: 300 }),
  legal: Object.freeze({ label: 'Legal (8.5 × 14 in)', shortIn: 8.5, longIn: 14, dpi: 290 }),
  tabloid: Object.freeze({ label: 'Tabloid (11 × 17 in)', shortIn: 11, longIn: 17, dpi: 240 }),
  archd: Object.freeze({ label: 'ARCH D (24 × 36 in)', shortIn: 24, longIn: 36, dpi: 170 }),
});
export const IOS_MAX_PIXELS = 16_777_216;
export const SOFT_DPI = 100;      // below this the imagery looks soft on paper
export const TEXT_DPI = 150;      // a final sheet is never drawn coarser: its text stays sharp
export const NO_DOWNLOAD_MAX_EDGE = 2048;

export function pageInches(page, orientation) {
  const spec = PRINT_PAGES[page];
  if (!spec) throw new RangeError('Unknown page size.');
  return orientation === 'landscape' ? { widthIn: spec.longIn, heightIn: spec.shortIn } : { widthIn: spec.shortIn, heightIn: spec.longIn };
}

/** Page sizes this browser can draw; a size past 4096 px is probed. */
export function supportedPages({ navigatorRef = globalThis.navigator, probe = null } = {}) {
  return Object.keys(PRINT_PAGES).filter(key => {
    const { shortIn, longIn, dpi } = PRINT_PAGES[key], w = Math.round(longIn * dpi), h = Math.round(shortIn * dpi);
    if (isIosLike(navigatorRef) && w * h > IOS_MAX_PIXELS) return false;
    return Math.max(w, h) <= 4096 || !probe || probe(w, h);
  });
}

// Grown about its centre to the frame's shape; never cropped.
export function fitExtent(extent, aspect) {
  const e = (extent.minE + extent.maxE) / 2, n = (extent.minN + extent.maxN) / 2;
  let w = extent.maxE - extent.minE, h = extent.maxN - extent.minN;
  if (w / h < aspect) w = h * aspect; else h = w / aspect;
  return { minE: e - w / 2, maxE: e + w / 2, minN: n - h / 2, maxN: n + h / 2 };
}

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const INK = '#1b1b1b', MUTED = '#4a4a4a';
const fontOf = (size, weight = 400) => `${weight} ${size}px ${FONT}`;

function wrap(text, room, measure, size, weight) {
  const lines = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const longer = lines.length ? `${lines[lines.length - 1]} ${word}` : null;
    if (longer && measure(longer, size, weight) <= room) lines[lines.length - 1] = longer; else lines.push(word);
  }
  return lines;
}

function cut(text, room, measure, size, weight) {
  let value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (measure(value, size, weight) <= room) return value;
  while (value && measure(`${value}…`, size, weight) > room) value = value.slice(0, -1).trimEnd();
  return value ? `${value}…` : '';
}

const noRoom = () => Object.assign(new Error('This page is too small for the map and its credits. Choose a larger page.'), { code: 'print_note' });

/**
 * Where everything goes, in sheet units.
 * measure(text, size, weight) -> width in units.
 * content: { title, project, captured, printed, acreage, contours: { interval,
 *   units } | null, property (lines or a property clip are on the sheet),
 *   lineColor (null: no lines drawn), uncaptured, credits: [text] }.
 * The credits are never cut: an image without room for them is refused.
 */
export function layoutSheet({ page, orientation, extent, content, measure, units = 'imperial' }) {
  const { widthIn, heightIn } = pageInches(page, orientation);
  const width = widthIn * UNITS_PER_INCH, height = heightIn * UNITS_PER_INCH;
  // Bigger paper is read from further away.
  const s = Math.sqrt(Math.min(widthIn, heightIn) / 8.5);
  const margin = 38 * s, gap = 8 * s, inner = width - margin * 2;
  const items = [];
  const text = (value, x, y, size, { weight = 400, color = INK, align = 'left' } = {}) => { if (value) items.push({ kind: 'text', text: value, x, y, size, weight, color, align }); };

  // Header: title, project and dates, the property; the mark on the right.
  const mark = 40 * s, titleSize = 21 * s, subSize = 11.5 * s, headRoom = inner - mark - gap * 2;
  let y = margin + titleSize / 2;
  text(cut(content.title, headRoom, measure, titleSize, 700), margin, y, titleSize, { weight: 700 });
  y += titleSize / 2 + 4 * s + subSize / 2;
  const sub = [content.project, content.captured ? `Captured ${content.captured}` : '', content.printed ? `Printed ${content.printed}` : ''].filter(Boolean).join(' · ');
  text(cut(sub, headRoom, measure, subSize), margin, y, subSize, { color: MUTED });
  let headBottom = y + subSize / 2;
  if (content.acreage) {
    y = headBottom + 4 * s + subSize / 2;
    text(cut(content.acreage, headRoom, measure, subSize, 600), margin, y, subSize, { weight: 600 });
    headBottom = y + subSize / 2;
  }
  items.push({ kind: 'mark', x: width - margin - mark, y: margin, size: mark });
  headBottom = Math.max(headBottom, margin + mark) + gap;

  // Property lines never print without their source.
  if (content.property && !cleanAttribution(content.credits?.[0])) throw Object.assign(new Error('The property line source is not available. Print without property lines.'), { code: 'print_note' });
  // Footer, from the bottom: credits (never cut), then legend, scale and north.
  const creditSize = 8 * s, creditLine = creditSize * 1.3;
  const credits = [content.property ? PROPERTY_LINES_NOTE : '', ...(content.credits || []).map(cleanAttribution)].filter(Boolean).join(' ');
  const creditLines = wrap(credits, inner, measure, creditSize, 400);
  if (creditLines.some(line => measure(line, creditSize, 400) > inner)) throw noRoom();
  const creditTop = height - margin - creditLines.length * creditLine;
  creditLines.forEach((line, i) => text(line, margin, creditTop + creditLine * (i + 0.5), creditSize, { color: MUTED }));

  const rows = [];
  if (content.contours) rows.push(['contours', `Contours ${content.contours.interval} ${unitSuffix(content.contours.units)} · index every ${+(content.contours.interval * CONTOUR_INDEX_EVERY).toFixed(3)} ${unitSuffix(content.contours.units)}`]);
  if (content.lineColor) rows.push(['property', 'Property lines']);
  if (content.uncaptured) rows.push(['uncaptured', UNCAPTURED_LABEL]);
  const rowSize = 10 * s, rowLine = 15 * s, swatch = 26 * s;
  const stripHeight = Math.max(46 * s, rows.length * rowLine);
  const stripTop = creditTop - gap - stripHeight, mapTop = headBottom, mapBottom = stripTop - gap;
  rows.forEach(([kind, label], i) => {
    const cy = stripTop + rowLine * (i + 0.5);
    items.push({ kind: 'swatch', of: kind, x: margin, y: cy, width: swatch, height: 9 * s, scale: s });
    text(label, margin + swatch + 7 * s, cy, rowSize);
  });
  const legendWidth = rows.length ? swatch + 7 * s + Math.max(...rows.map(([, label]) => measure(label, rowSize, 400))) : 0;

  const frame = { x: margin, y: mapTop, width: inner, height: mapBottom - mapTop };
  if (!(frame.height >= height * 0.4)) throw noRoom();
  const shown = fitExtent(extent, frame.width / frame.height);
  const metersPerUnit = (shown.maxE - shown.minE) / frame.width;

  // Scale bar and paper scale, right of the legend; north arrow at the right edge.
  const u = unitMeters(units), suffix = unitSuffix(units);
  const barUnits = niceLength(inner * 0.2 * metersPerUnit / u), barWidth = barUnits * u / metersPerUnit;
  const barX = Math.max(margin + legendWidth + gap * 3, margin + inner * 0.42), barY = stripTop + 10 * s;
  const metric = suffix === 'm';
  const perInch = metersPerUnit * UNITS_PER_INCH;
  const ratio = metric ? perInch / 2.54 : perInch / METERS_PER_FOOT;
  const scaleText = `1 ${metric ? 'cm' : 'inch'} = about ${Number(ratio.toPrecision(3)).toLocaleString('en-US')} ${suffix} at 100% size`;
  items.push({ kind: 'bar', x: barX, y: barY, width: barWidth, height: 6 * s });
  text(`${barUnits.toLocaleString('en-US')} ${suffix}`, barX + barWidth + 7 * s, barY, rowSize);
  text(scaleText, barX, barY + 18 * s, 9.5 * s, { color: MUTED });
  const north = { x: width - margin - 26 * s, y: stripTop };
  items.push({ kind: 'north', x: north.x, y: north.y, size: 26 * s });
  text('Grid north', north.x, stripTop + 38 * s, 9 * s, { color: MUTED, align: 'center' });
  // Nothing in the strip may run into the arrow.
  if (barX + Math.max(barWidth + 7 * s + measure(`${barUnits.toLocaleString('en-US')} ${suffix}`, rowSize, 400), measure(scaleText, 9.5 * s, 400)) > north.x - 26 * s) throw noRoom();

  return { widthIn, heightIn, width, height, scale: s, frame, extent: shown, metersPerUnit, unitsPerInchOnGround: ratio, scaleText, items, credits };
}

/**
 * Pixels for one sheet. `dpi` null: a final sheet, as fine as the page, the
 * device and the orthophoto allow; a number: a preview.
 * orthoGsd: the orthophoto's own pixel size (m). mapCap: most map pixels on
 * the long edge this viewer may have (Infinity with download permission).
 */
export function planSheet({ layout, page, orthoGsd, mapCap = Infinity, maxPixels = Infinity, dpi = null }) {
  const frameIn = { width: layout.frame.width / UNITS_PER_INCH, height: layout.frame.height / UNITS_PER_INCH };
  const spanE = layout.extent.maxE - layout.extent.minE;
  // Never finer than the orthophoto, or than this viewer may have.
  const mapDpi = Math.min(spanE / orthoGsd / frameIn.width, mapCap / Math.max(frameIn.width, frameIn.height));
  const pageMax = Math.min(PRINT_PAGES[page].dpi, Math.sqrt(maxPixels / (layout.widthIn * layout.heightIn)));
  const sheetDpi = Math.min(pageMax, dpi ?? Math.max(TEXT_DPI, mapDpi));
  const k = sheetDpi / UNITS_PER_INCH;
  const width = Math.floor(layout.width * k), height = Math.floor(layout.height * k);
  const x = Math.round(layout.frame.x * k), y = Math.round(layout.frame.y * k);
  const frame = { x, y, width: Math.round((layout.frame.x + layout.frame.width) * k) - x, height: Math.round((layout.frame.y + layout.frame.height) * k) - y };
  // Floor, so rounding never passes the cap or the orthophoto.
  const map = { width: Math.max(1, Math.min(frame.width, Math.floor(frameIn.width * mapDpi))), height: Math.max(1, Math.min(frame.height, Math.floor(frameIn.height * mapDpi))) };
  // What the page reaches when printed, whatever this drawing is.
  const printDpi = Math.round(Math.min(pageMax, mapDpi));
  return { width, height, k, dpi: sheetDpi, frame, map, printDpi, soft: printDpi < SOFT_DPI };
}

/** Most map pixels (long edge) for a viewer: unlimited with download, else the screen fitted to the frame, at most 2048. */
export function sheetMapCap({ policy, screen, pixelRatio = 1, frame }) {
  if (policy?.whole === true) return Infinity;
  const fit = screen && frame ? Math.min(screen.x / frame.width, screen.y / frame.height) * Math.max(frame.width, frame.height) * pixelRatio : NaN;
  return Math.max(16, Math.min(NO_DOWNLOAD_MAX_EDGE, Number.isFinite(fit) && fit > 0 ? Math.floor(fit) : NO_DOWNLOAD_MAX_EDGE));
}

// Owner labels at print size, in frame units. candidates: ownerLabelCandidates
// (lon, lat); `own` says which belong to the chosen property. Neighbours only
// with `names`. allowed(x, y, own): whether a spot of the frame may hold text.
export function sheetLabels({ candidates, layout, latLonToUtm, measure, names = false, own = () => false, allowed = () => true, units }) {
  const { frame, extent, metersPerUnit, scale: s } = layout;
  const wanted = candidates.filter(c => names || own(c)).map(c => ({ ...c, own: own(c) }));
  if (!wanted.length) return [];
  const project = (lon, lat) => { const [e, n] = latLonToUtm(lat, lon); return [(e - extent.minE) / metersPerUnit, (extent.maxN - n) / metersPerUnit]; };
  const zoom = Math.log2(EARTH_CIRCUMFERENCE * Math.cos(wanted[0].lat * Math.PI / 180) / metersPerUnit) - 8;
  const limits = { minLabelZoom: -Infinity, minAcreageZoom: -Infinity, minRadiusPx: 12 * s, fontMinPx: 8.5 * s, fontMaxPx: 12 * s, maxLabels: 150, paddingPx: 5 * s, maxLineChars: 18, maxChars: 40 };
  const options = { zoom, project, viewport: { width: frame.width, height: frame.height }, measure: (value, size) => measure(value, size, 600), units, limits };
  // The chosen property's own labels first; neighbours must clear them.
  const ownLabels = placeOwnerLabels(wanted.filter(c => c.own), options);
  const fits = (label, isOwn) => [[0, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]].every(([dx, dy]) => allowed(label.x + dx * label.width / 2, label.y + dy * label.height / 2, isOwn));
  const clear = label => !ownLabels.some(other => Math.abs(other.x - label.x) * 2 < other.width + label.width + limits.paddingPx * 2 && Math.abs(other.y - label.y) * 2 < other.height + label.height + limits.paddingPx * 2);
  return [...ownLabels.filter(label => fits(label, true)), ...placeOwnerLabels(wanted.filter(c => !c.own), options).filter(label => clear(label) && fits(label, false))];
}

// The mark, as drawn in public/lt-mark.svg (viewBox 238.5 226 776 776), in print ink.
const MARK_BOX = { x: 238.5, y: 226, size: 776 };
const MARK_STROKES = [
  ['ink', 'M273.5 655V370.5a99 99 0 0 1 99-99H605M979.5 583v274.5a99 99 0 0 1-99 99H650M605 956.5H372.5a99 99 0 0 1-99-99V703'],
  ['brand', 'M650 271.5h230.5a99 99 0 0 1 99 99V538'],
];
const MARK_FILL = 'M365 370l93 92v244h135l66 94H418l-53-54zM503 453h349l54 88H780v332l-96-100V541H563z';

function drawMark(ctx, { x, y, size }) {
  if (typeof Path2D !== 'function') return;
  ctx.save();
  ctx.translate(x, y); ctx.scale(size / MARK_BOX.size, size / MARK_BOX.size); ctx.translate(-MARK_BOX.x, -MARK_BOX.y);
  ctx.lineWidth = 56;
  for (const [tone, path] of MARK_STROKES) { ctx.strokeStyle = tone === 'brand' ? BRAND_COLORS.orange : INK; ctx.stroke(new Path2D(path)); }
  ctx.fillStyle = INK; ctx.fill(new Path2D(MARK_FILL));
  ctx.restore();
}

function drawItem(ctx, item, k, { colors, lineColor }) {
  ctx.save();
  if (item.kind === 'text') {
    ctx.font = fontOf(item.size * k, item.weight); ctx.fillStyle = item.color; ctx.textAlign = item.align; ctx.textBaseline = 'middle';
    ctx.fillText(item.text, item.x * k, item.y * k);
  } else if (item.kind === 'bar') {
    const [x, y, w, h] = [item.x, item.y - item.height / 2, item.width, item.height].map(v => v * k), line = Math.max(1, k * 0.8);
    ctx.fillStyle = INK; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(x + w / 2, y + line, w / 2 - line, h - line * 2);
  } else if (item.kind === 'north') {
    const x = item.x * k, y = item.y * k, h = item.size * k, w = h * 0.36;
    ctx.fillStyle = INK; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h * 0.78); ctx.lineTo(x - w, y + h); ctx.closePath(); ctx.fill();
  } else if (item.kind === 'mark') {
    drawMark(ctx, { x: item.x * k, y: item.y * k, size: item.size * k });
  } else if (item.kind === 'swatch') {
    const x = item.x * k, y = item.y * k, w = item.width * k, h = item.height * k, scale = item.scale * k;
    const line = (dy, color, width) => { ctx.strokeStyle = color; ctx.lineWidth = width * scale; ctx.beginPath(); ctx.moveTo(x, y + dy * scale); ctx.lineTo(x + w, y + dy * scale); ctx.stroke(); };
    if (item.of === 'contours') { line(-3, colors.index, 2); line(3, colors.minor, 1); }
    else if (item.of === 'property') { line(0, PROPERTY_LINE_STYLE_PRINT.halo, PROPERTY_LINE_STYLE_PRINT.haloWidth * 0.8); line(0, lineColor, PROPERTY_LINE_STYLE_PRINT.width * 0.8); }
    else drawHatch(ctx, { x, y: y - h / 2, width: w, height: h, scale: scale * 0.7 });
  }
  ctx.restore();
}

const cancelled = signal => { if (signal?.aborted) throw new DOMException('Export cancelled.', 'AbortError'); };
const tooLarge = () => Object.assign(new Error('This browser cannot draw a page that large. Choose a smaller page.'), { code: 'print_too_large' });

/**
 * Draw one sheet on a new canvas.
 * ortho: GeoTIFF dataset. contours: { features, interval, units } | null.
 * propertyLines / boundary: [[[E, N], ...]]; clip: function (width, height,
 * extent) -> { mask, uncaptured } | null. labels: from sheetLabels (frame units).
 */
export async function renderSheet({ layout, plan, ortho, contours = null, colors = CONTOUR_COLORS.brown, propertyLines = null, boundary = null, lineColor = null,
  clip = null, labels = [], createCanvas, pool, signal, maxStripPixels, checkpoint = null }) {
  cancelled(signal);
  const make = (width, height) => {
    let canvas, ctx;
    try { canvas = createCanvas(width, height); canvas.width = width; canvas.height = height; ctx = canvas.getContext('2d'); } catch { throw tooLarge(); }
    if (!ctx || canvas.width !== width || canvas.height !== height) throw tooLarge();
    return { canvas, ctx, release: () => { canvas.width = 0; canvas.height = 0; } };
  };
  const { k, frame } = plan, sheet = make(plan.width, plan.height), { ctx } = sheet;
  let image = null;
  try {
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, plan.width, plan.height);
    if (ctx.getImageData(plan.width - 1, plan.height - 1, 1, 1).data[3] !== 255) throw tooLarge();
    // Imagery, at its own (or the permitted) resolution, then scaled to the frame.
    const { rgba } = await renderOrthoPixels({ ds: ortho, extent: layout.extent, width: plan.map.width, height: plan.map.height, signal, pool, maxStripPixels, background: [255, 255, 255] });
    cancelled(signal);
    checkpoint?.();
    image = make(plan.map.width, plan.map.height);
    const pixels = image.ctx.createImageData(plan.map.width, plan.map.height);
    pixels.data.set(rgba);
    image.ctx.putImageData(pixels, 0, 0);
    ctx.drawImage(image.canvas, frame.x, frame.y, frame.width, frame.height);
    image.release(); image = null;
    const gsdE = (layout.extent.maxE - layout.extent.minE) / frame.width, gsdN = (layout.extent.maxN - layout.extent.minN) / frame.height;
    const project = (e, n) => [frame.x + (e - layout.extent.minE) / gsdE, frame.y + (layout.extent.maxN - n) / gsdN];
    const scale = k * layout.scale * 0.8;
    const inFrame = draw => { ctx.save(); ctx.beginPath(); ctx.rect(frame.x, frame.y, frame.width, frame.height); ctx.clip(); draw(); ctx.restore(); };
    inFrame(() => {
      if (contours?.features?.length) drawContours(ctx, contours.features, project, { colors, scale, width: frame.x + frame.width, height: frame.y + frame.height });
      if (propertyLines?.length) drawPropertyLines(ctx, propertyLines, { color: lineColor, scale, project });
    });
    // One mask over imagery, contours and neighbours' lines alike.
    const clipped = clip ? clip({ width: frame.width, height: frame.height, extent: layout.extent }) : null;
    if (clipped) applyClip(ctx, { mask: clipped.mask, width: frame.width, height: frame.height, scale, x: frame.x, y: frame.y });
    inFrame(() => { if (boundary?.length) drawPropertyLines(ctx, boundary, { color: lineColor, scale, project }); });
    for (const label of labels) {
      ctx.save();
      ctx.font = fontOf(label.fontPx * k, 600); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      label.lines.forEach((line, i) => {
        const x = (layout.frame.x + label.x) * k, y = (layout.frame.y + label.y - label.height / 2 + label.lineHeight * (i + 0.5)) * k;
        ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = label.fontPx * k * 0.28; ctx.strokeText(line, x, y);
        ctx.fillStyle = '#ffffff'; ctx.fillText(line, x, y);
      });
      ctx.restore();
    }
    ctx.strokeStyle = INK; ctx.lineWidth = Math.max(1, k);
    ctx.beginPath(); ctx.rect(frame.x, frame.y, frame.width, frame.height); ctx.stroke();
    for (const item of layout.items) drawItem(ctx, item, k, { colors, lineColor: lineColor || BRAND_COLORS.orange });
    return { canvas: sheet.canvas, ctx, width: plan.width, height: plan.height, uncaptured: clipped?.uncaptured || 0, release: sheet.release };
  } catch (error) {
    image?.release(); sheet.release();
    if (error instanceof RangeError) throw tooLarge();
    throw error;
  }
}

// Text widths in sheet units, from a canvas of its own: the same at any dpi.
export function createSheetMeasure(createCanvas) {
  const ctx = createCanvas(1, 1).getContext('2d');
  return (text, size, weight = 400) => { ctx.font = fontOf(size, weight); return ctx.measureText(text).width; };
}
