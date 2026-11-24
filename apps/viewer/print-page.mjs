// The Print map page: what is on the sheet (createPrintModel, no DOM) and the
// dialog around it (mountPrintPage). Print, Save PDF and the preview draw the
// same sheet (print-sheet.mjs); only the dots per inch differ.
import { BRAND_COLORS } from './brand-colors.mjs';
import { clampExtent } from './ortho-print-export.mjs';
import { dissolveParcelsByOwner, formatParcelArea, outlineAreaM2, ownerLabelCandidates, parcelLabelGeometry } from './property-lines-owners.mjs';
import {
  CLIP_HIDE, METERS_PER_FOOT, PRINT_DISTANCES_FT, PRINT_DISTANCE_DEFAULT_FT, coverageNote, linesToUtm, outlineToUtm, printClip, printPropertyError, propertyCoverage,
  propertyFrame, resolvePrintProperty,
} from './print-property.mjs';
import { PRINT_PAGES, layoutSheet, planSheet, renderSheet, sheetLabels, sheetMapCap } from './print-sheet.mjs';
import { encodeSheetPdf, sheetFilename } from './print-pdf.mjs';

// Printed on every sheet.
export const IMAGERY_CREDIT = 'Imagery: Ledge Top.';
export const JPEG_QUALITY = 0.92;
const LIST_LIMIT = 200;

const parcelKey = parcel => (parcel.id != null ? `id:${parcel.id}` : `geom:${JSON.stringify(parcel.rings[0])}`);
const outlineKey = outline => outline.parcels.map(parcelKey).sort().join('|');

/**
 * One print: its choices, and drawing the sheet for them.
 * deps: { ortho, orthoGsd, capture, outlines, loaded (tiles), merge, loadParcels(bounds),
 *   latLonToUtm, utmToLatLon, attribution (''), datumNote, units, meta: { title, project, captured, printed },
 *   imageryCredit, policy(), screen() -> {x, y}, pixelRatio(), maxPixels, traceContours(extent, cell, signal) | null,
 *   colors(), createCanvas, pool, measure, checkpoint() }
 * checkpoint() throws when the page no longer belongs to this viewer.
 */
export function createPrintModel(deps) {
  const ortho = deps.ortho, orthoExtent = { minE: ortho.minE, maxE: ortho.maxE, minN: ortho.minN, maxN: ortho.maxN };
  const wide = orthoExtent.maxE - orthoExtent.minE >= orthoExtent.maxN - orthoExtent.minN;
  const state = { area: 'whole', page: 'letter', orientation: wide ? 'landscape' : 'portrait', marginFt: PRINT_DISTANCE_DEFAULT_FT, trimFt: PRINT_DISTANCE_DEFAULT_FT,
    crop: false, contours: false, lines: Boolean(deps.attribution && deps.outlines?.length), names: false, title: deps.meta.title || '' };
  const chosen = new Map();   // outlineKey -> { outline, outlines, areaM2 }
  const known = new Map();    // parcelKey -> parcel: everything loaded so far
  const remember = outlines => { for (const outline of outlines) for (const parcel of outline.parcels) if (!known.has(parcelKey(parcel))) known.set(parcelKey(parcel), parcel); };
  remember(deps.outlines || []);
  let traced = null;

  // Outlines to list: those with captured ground, most of it first.
  const list = (deps.outlines || []).map(outline => {
    const coverage = propertyCoverage({ parcels: outlineToUtm(outline, deps.latLonToUtm), capture: deps.capture, edge: 64 });
    let point = null, radius = -1;
    for (const parcel of outline.parcels) { const g = parcelLabelGeometry(parcel); if (g && g.radiusMeters > radius) { point = g.lonLat; radius = g.radiusMeters; } }
    const area = outlineAreaM2(outline, { merged: deps.merge, covered: deps.covered || null });
    return { key: outlineKey(outline), parcels: outline.parcels.map(parcelKey), point, owner: outline.owner, area, label: [outline.owner || 'No owner listed', formatParcelArea(area, deps.units)].filter(Boolean).join(' '), percent: coverage.percent, size: radius };
  }).filter(item => item.percent > 0 && item.point).sort((a, b) => b.size - a.size).slice(0, LIST_LIMIT);

  async function toggle(point) {
    if (!deps.attribution) throw printPropertyError('unavailable');
    const found = await resolvePrintProperty({ point, merge: deps.merge, load: deps.loadParcels });
    deps.checkpoint();
    const key = outlineKey(found.outline);
    if (chosen.has(key)) { chosen.delete(key); return { key, on: false }; }
    const coverage = propertyCoverage({ parcels: outlineToUtm(found.outline, deps.latLonToUtm), capture: deps.capture, edge: 256 });
    if (!coverage.percent) throw printPropertyError('uncaptured');
    chosen.set(key, found);
    remember(found.outlines);
    state.area = 'property';
    return { key, on: true };
  }

  // A listed outline is chosen when its land is in a chosen property (which may
  // have grown past what the list knew).
  function isChosen(key) {
    const item = list.find(entry => entry.key === key);
    return Boolean(item) && ownParcels().some(parcel => item.parcels.includes(parcelKey(parcel)));
  }

  const ownOutlines = () => [...chosen.values()].map(found => found.outline);
  const ownParcels = () => [...new Map(ownOutlines().flatMap(outline => outline.parcels).map(parcel => [parcelKey(parcel), parcel])).values()];

  // "Property 118.4 ac, 3 parcels, approximate": land under two records once.
  function acreageLine(parcels, coverage) {
    const area = outlineAreaM2({ ownerKey: 'own', parcels }, { merged: true, covered: () => true });
    const count = `${parcels.length} ${parcels.length === 1 ? 'parcel' : 'parcels'}`;
    const words = area == null ? `Property, ${count}` : `Property ${formatParcelArea(area, deps.units).replace('≈ ', '')}, ${count}, approximate`;
    return coverage.percent < 100 ? `${words} · ${coverage.percent}% captured` : words;
  }

  async function trace(extent, cell, signal) {
    const key = JSON.stringify([extent, cell]);
    if (traced?.key !== key) traced = { key, value: await deps.traceContours(extent, cell, signal) };
    return traced.value;
  }

  // dpi null: the final sheet. Otherwise a preview, which may still be waiting for a property.
  async function draw({ dpi = null, signal = null } = {}) {
    deps.checkpoint();
    const picking = state.area === 'property' && !chosen.size;
    if (picking && dpi === null) throw printPropertyError('choose');
    const own = state.area === 'property' && chosen.size > 0;
    const marginMeters = state.marginFt * METERS_PER_FOOT, trimMeters = state.trimFt * METERS_PER_FOOT;
    const parcels = own ? ownParcels() : [], shapes = own ? outlineToUtm({ parcels }, deps.latLonToUtm) : null;
    const coverage = own ? propertyCoverage({ parcels: shapes, capture: deps.capture, trimMeters }) : null;
    if (own && !coverage.percent) throw printPropertyError('uncaptured');
    let extent = own ? propertyFrame(shapes, marginMeters) : orthoExtent;
    if (own && state.crop && coverage.percent < 100) extent = clampExtent(extent, orthoExtent) || extent;

    // Parcel data on the sheet, in any form, brings its note and source.
    const lines = state.lines || picking, names = state.names && !picking, property = lines || own || names;
    const mine = new Set(parcels.map(parcelKey)), all = property ? dissolveParcelsByOwner([...known.values()], { merge: deps.merge }) : [];
    const others = all.filter(outline => !outline.parcels.some(parcel => mine.has(parcelKey(parcel))));
    const lineColor = lines ? BRAND_COLORS.orange : null;
    const content = contours => ({
      title: state.title, project: deps.meta.project, captured: deps.meta.captured, printed: deps.meta.printed,
      acreage: own ? acreageLine(parcels, coverage) : '', contours, property, lineColor, uncaptured: own && coverage.percent < 100,
      credits: [property ? deps.attribution : '', property ? deps.datumNote : '', deps.imageryCredit].filter((text, i) => text || (i === 0 && property)),
    });
    const layoutWith = contours => layoutSheet({ page: state.page, orientation: state.orientation, extent, content: content(contours), measure: deps.measure, units: deps.units });
    const planOf = layout => planSheet({ layout, page: state.page, orthoGsd: deps.orthoGsd, maxPixels: deps.maxPixels, dpi,
      mapCap: sheetMapCap({ policy: deps.policy(), screen: deps.screen(), pixelRatio: deps.pixelRatio(), frame: layout.frame }) });
    const wantContours = Boolean(state.contours && deps.traceContours);
    // The legend row's height does not depend on the interval, so the frame is known before tracing.
    let layout = layoutWith(wantContours ? { interval: 10, units: deps.units } : null), plan = planOf(layout), contours = null;
    if (wantContours) {
      contours = await trace(layout.extent, (layout.extent.maxE - layout.extent.minE) / plan.frame.width * 2.5, signal);
      deps.checkpoint();
      if (!contours?.features?.length) contours = null;
      layout = layoutWith(contours); plan = planOf(layout);
    }
    const clip = size => printClip({ ...size, parcels: shapes, marginMeters, trimMeters: picking ? 0 : trimMeters, capture: deps.capture });
    let labels = [];
    if (own || names) {
      const w = Math.max(1, Math.round(layout.frame.width)), h = Math.max(1, Math.round(layout.frame.height)), { mask } = clip({ width: w, height: h, extent: layout.extent });
      const acreage = { merged: deps.merge, covered: deps.covered || null };
      const candidates = [
        ...(own ? ownerLabelCandidates(ownOutlines(), { acreage: { merged: deps.merge, covered: () => true } }).map(c => ({ ...c, own: true })) : []),
        ...(names ? ownerLabelCandidates(others, { acreage }) : []),
      ];
      labels = sheetLabels({ candidates, layout, latLonToUtm: deps.latLonToUtm, measure: deps.measure, names, own: c => c.own === true, units: deps.units,
        allowed: (x, y) => { const i = Math.floor(y) * w + Math.floor(x); return x >= 0 && y >= 0 && x < w && y < h && mask[i] !== CLIP_HIDE; } });
    }
    const sheet = await renderSheet({
      layout, plan, ortho, contours, colors: deps.colors(), clip, labels, lineColor: lineColor || BRAND_COLORS.orange,
      propertyLines: lines ? linesToUtm(others, deps.latLonToUtm) : null, boundary: lines && own ? linesToUtm(ownOutlines(), deps.latLonToUtm) : null,
      createCanvas: deps.createCanvas, pool: deps.pool, signal, checkpoint: deps.checkpoint,
    });
    try { deps.checkpoint(); } catch (error) { sheet.release(); throw error; }
    return { ...sheet, layout, plan, coverage, picking };
  }

  // The final sheet as a JPEG and its PDF page size.
  async function finalJpeg({ signal } = {}) {
    const sheet = await draw({ signal });
    try {
      const blob = await new Promise((resolve, reject) => sheet.canvas.toBlob(b => (b ? resolve(b) : reject(Object.assign(new Error('This browser cannot draw a page that large. Choose a smaller page.'), { code: 'print_too_large' }))), 'image/jpeg', JPEG_QUALITY));
      deps.checkpoint();
      return { blob, width: sheet.width, height: sheet.height, widthIn: sheet.layout.widthIn, heightIn: sheet.layout.heightIn };
    } finally { sheet.release(); }
  }

  async function finalPdf(options) {
    const image = await finalJpeg(options);
    const jpeg = new Uint8Array(await image.blob.arrayBuffer());
    deps.checkpoint();
    const bytes = encodeSheetPdf({ jpeg, pixelWidth: image.width, pixelHeight: image.height, widthIn: image.widthIn, heightIn: image.heightIn, title: state.title });
    return { blob: new Blob([bytes], { type: 'application/pdf' }), filename: sheetFilename(state.title) };
  }

  // Ground under a spot of a drawn sheet (0..1 across and down the paper), as lon/lat; null off the map.
  function pointAt(drawn, fx, fy) {
    const { layout } = drawn, x = fx * layout.width - layout.frame.x, y = fy * layout.height - layout.frame.y;
    if (x < 0 || y < 0 || x > layout.frame.width || y > layout.frame.height) return null;
    const [lat, lon] = deps.utmToLatLon(layout.extent.minE + x * layout.metersPerUnit, layout.extent.maxN - y * layout.metersPerUnit);
    return Number.isFinite(lat) && Number.isFinite(lon) ? [lon, lat] : null;
  }

  return { state, list, chosen, toggle, isChosen, checkpoint: deps.checkpoint, draw, finalJpeg, finalPdf, pointAt,
    canChoose: Boolean(deps.attribution), hasContours: Boolean(deps.traceContours) };
}

// The day, or days, the photos were taken: camera features with capture_time
// (seconds). null when not recorded.
export function captureDates(features) {
  const times = (features || []).map(f => Number(f?.properties?.capture_time)).filter(t => Number.isFinite(t) && t > 946684800);
  if (!times.length) return null;
  const day = t => new Date(t * 1000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const [first, last] = [day(times.reduce((a, b) => Math.min(a, b))), day(times.reduce((a, b) => Math.max(a, b)))];
  return first === last ? first : `${first} to ${last}`;
}

// What the preview is worth saying about the print; '' when nothing is.
export function printStatus({ plan, coverage, picking }) {
  if (picking) return 'Click your property.';
  return [`Prints at ${plan.printDpi} dpi.`, plan.soft ? 'It will look soft on paper.' : '', coverage ? coverageNote(coverage) : ''].filter(Boolean).join(' ');
}

/**
 * The dialog. open() -> a model (createPrintModel), or throws with a message.
 * pages: page keys this browser can draw, or a function giving them. onClose: the page is done with.
 */
export function mountPrintPage({ documentRef = document, windowRef = window, openButton, open, pages = Object.keys(PRINT_PAGES), onClose = () => {}, previewDelayMs = 150 }) {
  const el = (tag, props = {}, children = []) => { const n = documentRef.createElement(tag); Object.assign(n, props); n.append(...children); return n; };
  const select = (name, options) => el('select', { name }, options.map(([value, text]) => el('option', { value: String(value), textContent: text })));
  const feet = name => select(name, PRINT_DISTANCES_FT.map(ft => [ft, `${ft} ft`]));
  const title = el('input', { type: 'text', name: 'title', maxLength: 120 });
  const area = select('area', [['whole', 'Whole captured area'], ['property', 'My property']]);
  const page = select('page', []);
  const orientation = select('orientation', [['portrait', 'Portrait'], ['landscape', 'Landscape']]);
  const margin = feet('margin'), trim = feet('trim');
  const box = name => el('input', { type: 'checkbox', name });
  const contours = box('contours'), lines = box('lines'), names = box('names'), crop = box('crop');
  const row = (label, control) => el('label', { className: 'print-map-row' }, [el('span', { textContent: label }), control]);
  const check = (label, control) => el('label', { className: 'print-map-check' }, [control, el('span', { textContent: label })]);
  const properties = el('div', { className: 'print-map-list' });
  properties.setAttribute('role', 'group'); properties.setAttribute('aria-label', 'Properties');
  const marginRow = row('Around the property', margin), cropRow = check('Crop to imagery', crop);
  const status = el('p', { className: 'hint print-map-status' }); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const print = el('button', { type: 'button', className: 'tool-btn', textContent: 'Print' }), save = el('button', { type: 'button', className: 'tool-btn', textContent: 'Save PDF' });
  const close = el('button', { type: 'button', className: 'print-map-close', textContent: 'Close' });
  const preview = el('div', { className: 'print-map-preview' });
  const controls = el('div', { className: 'print-map-controls' }, [
    el('h2', { textContent: 'Print map' }), row('Title', title), row('Area', area), properties, marginRow, cropRow, row('Trim edges', trim),
    row('Page', page), row('Orientation', orientation), check('Contour lines', contours), check('Property lines', lines), check('Neighbours’ names', names),
    el('div', { className: 'print-map-actions' }, [print, save, close]), status,
  ]);
  const paper = el('div', { className: 'print-map-paper' });   // what the browser prints; empty otherwise
  const dialog = el('dialog', { className: 'print-map' }, [controls, preview, paper]);
  dialog.setAttribute('aria-label', 'Print map');
  documentRef.body.append(dialog);

  let model = null, life = 0, timer = null, drawing = null, shown = null, busy = null, choosing = 0, isOpen = false, paperUrl = null, pageStyle = null;
  const say = text => { if (status.textContent !== text) status.textContent = text; };
  const explain = error => (error?.code ? error.message : 'Could not draw this page. Try a smaller page.');

  function clearPaper() {
    paper.replaceChildren();
    if (paperUrl) URL.revokeObjectURL(paperUrl);
    pageStyle?.remove();
    paperUrl = pageStyle = null;
  }

  function dropPreview() { preview.replaceChildren(); shown?.release(); shown = null; }

  // Everything off: the page closed, or no longer belongs to this viewer.
  function retire() {
    life++;
    clearTimeout(timer); timer = null;
    drawing?.abort(); drawing = null;
    busy?.abort(); busy = null;
    clearPaper(); dropPreview();
    properties.replaceChildren();
    model = null;
    say('');
  }

  function sync() {
    if (!model) return;
    const s = model.state, own = s.area === 'property';
    area.value = s.area; page.value = s.page; orientation.value = s.orientation; margin.value = String(s.marginFt); trim.value = String(s.trimFt);
    contours.checked = s.contours; lines.checked = s.lines; names.checked = s.names; crop.checked = s.crop;
    contours.disabled = !model.hasContours; lines.disabled = !model.canChoose; names.disabled = !model.canChoose;
    for (const option of area.children) if (option.value === 'property') { option.disabled = !model.canChoose; option.hidden = !model.canChoose; }
    properties.hidden = !own; marginRow.hidden = !own;
    cropRow.hidden = !(own && shown?.coverage && shown.coverage.percent < 100);
    for (const entry of properties.children) entry.control.checked = model.isChosen(entry.control.value);
    // Only what the preview shows can be printed: not while a new one is on its way.
    const ready = !busy && !timer && !drawing && Boolean(shown) && !shown.picking;
    print.disabled = save.disabled = !ready;
  }

  function previewDpi() {
    const { widthIn } = shown?.layout || { widthIn: 11 }, width = preview.clientWidth || 640;
    return Math.max(40, Math.min(110, width * (windowRef.devicePixelRatio || 1) / widthIn));
  }

  function refresh(delay = previewDelayMs) {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void drawPreview(); }, delay);
    sync();
  }

  async function drawPreview() {
    if (!model) return;
    const mine = life, current = model;
    drawing?.abort();
    const own = drawing = new AbortController();
    try {
      const drawn = await current.draw({ dpi: previewDpi(), signal: own.signal });
      if (mine !== life || own.signal.aborted) { drawn.release(); return; }
      preview.replaceChildren(drawn.canvas);
      shown?.release();
      shown = drawn;
      say(printStatus(drawn));
    } catch (error) {
      if (mine !== life || own.signal.aborted) return;
      if (error?.name === 'AbortError') { shut(); return; }
      dropPreview();
      say(explain(error));
    } finally { if (mine === life && drawing === own) { drawing = null; sync(); } }
  }

  // Toggle the property at a point; one at a time, the newest result wins.
  async function choose(point) {
    if (!model || !point) return;
    const mine = life, turn = ++choosing, current = model;
    say('Loading…');
    try { await current.toggle(point); } catch (error) {
      if (mine !== life || turn !== choosing) return;
      if (error?.name === 'AbortError') { shut(); return; }
      sync();
      say(error?.code ? error.message : 'Could not load the property. Try again.');
      return;
    }
    if (mine === life) refresh(0);
  }

  function listProperties() {
    properties.replaceChildren(...model.list.map(item => {
      const control = el('input', { type: 'checkbox', value: item.key });
      control.addEventListener('change', () => void choose(item.point));
      return Object.assign(check(item.label, control), { control });
    }));
  }

  async function output(work) {
    if (!model || busy) return;
    const mine = life, own = busy = new AbortController();
    sync();
    say('Rendering…');
    try {
      await work(model, own.signal, () => mine === life && !own.signal.aborted);
    } catch (error) {
      if (mine !== life || own.signal.aborted) return;
      if (error?.name === 'AbortError') { shut(); return; }
      say(explain(error));
    } finally { if (mine === life && busy === own) { busy = null; sync(); } }
  }

  save.addEventListener('click', () => output(async (current, signal, live) => {
    const pdf = await current.finalPdf({ signal });
    if (!live()) return;
    current.checkpoint();
    const url = URL.createObjectURL(pdf.blob), a = el('a', { href: url, download: pdf.filename });
    documentRef.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    say(`Saved ${pdf.filename}.`);
  }));
  print.addEventListener('click', () => output(async (current, signal, live) => {
    const image = await current.finalJpeg({ signal });
    if (!live()) return;
    clearPaper();
    paperUrl = URL.createObjectURL(image.blob);
    const img = el('img', { src: paperUrl, alt: current.state.title || 'Map' });
    paper.replaceChildren(img);
    // The paper's own size, no browser margins: the sheet has its own.
    pageStyle = el('style', { textContent: `@page { size: ${image.widthIn}in ${image.heightIn}in; margin: 0; }` });
    documentRef.head.append(pageStyle);
    await img.decode();
    if (!live()) return;
    // Once more, with nothing awaited in between.
    current.checkpoint();
    windowRef.print();
    say(shown ? printStatus(shown) : '');
  }));
  windowRef.addEventListener?.('afterprint', () => clearPaper());

  const set = (control, key, read, { now = false } = {}) => control.addEventListener(now ? 'input' : 'change', () => { if (!model) return; model.state[key] = read(control); sync(); refresh(); });
  set(title, 'title', c => c.value, { now: true });
  set(area, 'area', c => c.value); set(page, 'page', c => c.value); set(orientation, 'orientation', c => c.value);
  set(margin, 'marginFt', c => Number(c.value)); set(trim, 'trimFt', c => Number(c.value));
  set(contours, 'contours', c => c.checked); set(lines, 'lines', c => c.checked); set(names, 'names', c => c.checked); set(crop, 'crop', c => c.checked);
  preview.addEventListener('click', event => {
    if (!model || !shown?.picking) return;
    const rect = shown.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    void choose(model.pointAt(shown, (event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height));
  });

  function shut() {
    if (!isOpen) return;
    isOpen = false;
    retire();
    if (dialog.open) dialog.close();
    onClose();
  }
  close.addEventListener('click', shut);
  dialog.addEventListener('close', () => { if (!dialog.open) shut(); });   // Escape

  openButton?.addEventListener('click', async () => {
    if (isOpen) return;
    isOpen = true;
    retire();
    const mine = life;
    const usable = typeof pages === 'function' ? pages() : pages;
    page.replaceChildren(...usable.map(key => el('option', { value: key, textContent: PRINT_PAGES[key].label })));
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    say('Loading…');
    print.disabled = save.disabled = true;
    try {
      const opened = await open();
      if (mine !== life) return;
      model = opened;
      title.value = model.state.title;
      listProperties();
      sync();
      refresh(0);
    } catch (error) {
      if (mine !== life) return;
      if (error?.name === 'AbortError') { shut(); return; }
      say(error?.code ? error.message : 'Could not open the print page. Try again.');
    }
  });

  return { dialog, shut, controls: { title, area, page, orientation, margin, trim, contours, lines, names, crop, print, save, close, status, preview, properties, paper } };
}
