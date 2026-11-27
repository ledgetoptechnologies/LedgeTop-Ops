// Download dialog: one place for the model's products and the orthophoto
// image. The first page lists what can be downloaded; Orthophoto opens its
// own page with the area (whole, current view, selected parcels), the format
// (TIFF, JPEG, PNG), layers, a preview of the whole area and progress.
// Rendered images are always full native resolution where access allows it;
// the whole orthophoto as TIFF without layers is the original file. The work
// itself is done by the callbacks.
//   defaults() → { areas: { full, view, parcels }, parcelCount, contoursAvailable, contoursOn, propertyAvailable, geotiffAvailable }
//   preview(options, signal) → { canvas, width, height } (width/height of the final file)
//   run(options, signal, { onProgress, onCommit, writable }) → { blob | null, filename, note?, stillCurrent?, committed? }
//     onCommit(): the chosen file is being written for good; committed: it was.
//   pickParcels() → Promise<count>; the dialog hides while the person picks on the map.
//   products: { available(), list(signal) → [{ kind, label, format, size }], download(product, signal) }
// Nothing is downloaded or exported except by a press on a product or on
// Download that started inside the dialog once it had settled after it
// (re)opened or changed page: a click carried over from the map (a double
// click on Done), a key held or let go from before, starts nothing.

export const LARGE_EXPORT_PIXELS = 100_000_000;
export const MEMORY_WARNING_PIXELS = 250_000_000;
export const JPEG_MAX_SIDE = 65535;
const AREAS = [['full', 'Whole orthophoto'], ['view', 'Current view'], ['parcels', 'Selected parcels']];
const FORMATS = [['tif', 'TIFF'], ['jpg', 'JPEG'], ['png', 'PNG']];
const MIME = { tif: ['GeoTIFF', 'image/tiff', '.tif'], jpg: ['JPEG image', 'image/jpeg', '.jpg'], png: ['PNG image', 'image/png', '.png'] };
const HANDED = 'Download handed to your browser. Check its Downloads panel for progress.';

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function exportFileName({ area, format, contours }) {
  return `orthophoto${area === 'view' ? '-view' : area === 'parcels' ? '-parcels' : ''}${contours ? '-contours' : ''}.${format === 'tif' ? 'tif' : format === 'jpg' ? 'jpg' : 'png'}`;
}

export function mountOrthoExportDialog({ documentRef = document, windowRef = globalThis.window, openButton, defaults = () => ({}), preview, run, pickParcels, products = null, settleMs = 350, now = () => globalThis.performance?.now?.() ?? Date.now() }) {
  const el = (tag, props = {}, children = []) => { const n = documentRef.createElement(tag); Object.assign(n, props); n.append(...children); return n; };
  const icon = (d) => { const svg = documentRef.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); const p = documentRef.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', d); svg.append(p); return svg; };
  const segmented = (name, options) => {
    const group = el('div', { className: 'oe-seg' });
    group.setAttribute('role', 'radiogroup');
    const inputs = {};
    for (const [value, text] of options) {
      const input = el('input', { type: 'radio', name: `oe-${name}`, value });
      inputs[value] = input;
      group.append(el('label', { className: 'oe-seg-option' }, [input, el('span', { textContent: text })]));
    }
    return { group, inputs, get value() { return Object.values(inputs).find(i => i.checked)?.value; }, set value(v) { if (inputs[v]) for (const [key, input] of Object.entries(inputs)) input.checked = key === v; } };
  };
  const toggle = (text) => {
    const input = el('input', { type: 'checkbox' });
    return { input, row: el('label', { className: 'oe-toggle' }, [el('span', { textContent: text }), input, el('i', { className: 'oe-switch' })]) };
  };

  const area = segmented('area', AREAS), format = segmented('format', FORMATS);
  const contours = toggle('Contour lines'), property = toggle('Property lines');
  const parcelCount = el('span', { className: 'oe-parcel-count' });
  const pickButton = el('button', { type: 'button', className: 'oe-btn', textContent: 'Pick on map' });
  const parcelRow = el('div', { className: 'oe-parcels' }, [parcelCount, pickButton]);
  const canvasHost = el('div', { className: 'oe-preview-image' });
  const previewState = el('div', { className: 'oe-preview-state' });
  const dims = el('span', { className: 'oe-dims' });
  const status = el('p', { className: 'oe-status' }); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const bar = el('div', { className: 'oe-progress-bar' }), progress = el('div', { className: 'oe-progress' }, [bar]);
  progress.hidden = true;
  const back = el('button', { type: 'button', className: 'oe-back' }, [icon('M15 5l-7 7 7 7')]);
  back.setAttribute('aria-label', 'All downloads');
  const title = el('h2', { textContent: 'Download' });
  const close = el('button', { type: 'button', className: 'oe-close' }, [icon('M6 6l12 12M18 6L6 18')]);
  close.setAttribute('aria-label', 'Close');
  const cancel = el('button', { type: 'button', className: 'oe-btn', textContent: 'Cancel' });
  const downloadButton = el('button', { type: 'button', className: 'oe-btn oe-primary', textContent: 'Download' });
  const actions = el('div', { className: 'oe-actions' }, [cancel, downloadButton]);
  const field = (heading, ...children) => el('section', { className: 'oe-field' }, [el('h3', { textContent: heading }), ...children]);
  const list = el('div', { className: 'dl-list' });
  list.setAttribute('role', 'list');
  const listPage = el('div', { className: 'dl-page' }, [list]);
  const orthoPage = el('div', { className: 'oe-body' }, [
    el('figure', { className: 'oe-preview' }, [canvasHost, previewState, el('figcaption', {}, [dims])]),
    el('div', { className: 'oe-controls' }, [
      field('Area', area.group, parcelRow),
      field('Format', format.group),
      field('Layers', contours.row, property.row),
    ]),
  ]);
  const dialog = el('dialog', { className: 'oe-dialog' }, [
    el('header', { className: 'oe-head' }, [back, title, close]),
    listPage, orthoPage,
    el('footer', { className: 'oe-foot' }, [progress, status, actions]),
  ]);
  dialog.setAttribute('aria-label', 'Download');
  documentRef.body.append(dialog);

  let available = {}, previewController = null, exportController = null, previewTimer = null, last = null, picking = null, committing = null; // committing: the export whose chosen file is being written
  let page = 'list', listController = null, orthoProduct = null, productRequest = null, armed = false, settledAt = 0;
  const options = () => ({ area: area.value, format: format.value, contours: contours.input.checked, property: property.input.checked });
  const busy = () => Boolean(exportController);
  const exportAvailable = () => Object.values(available.areas || {}).some(Boolean);
  // The whole orthophoto as TIFF without layers is the original file, not a rendering.
  const useOriginal = () => Boolean(orthoProduct) && format.value === 'tif' && area.value === 'full' && !contours.input.checked && !property.input.checked;
  const tiffBlocked = () => format.value === 'tif' && !useOriginal() && !available.geotiffAvailable;
  // Baseline JPEG holds at most 65,535 px per side.
  const jpegTooLarge = () => format.value === 'jpg' && Boolean(last) && (last.width > JPEG_MAX_SIDE || last.height > JPEG_MAX_SIDE);

  // ---- explicit intent ---------------------------------------------------------
  // A press counts only when it starts inside the open dialog after it settled:
  // pointer down, or a key going down (not a repeat). Opening, reopening after
  // picking and changing page disarm it and start a new settling time, so the
  // second half of a double click, or a key from before, does nothing.
  const disarm = () => { armed = false; settledAt = now() + settleMs; };
  const arm = (event) => { if (!event?.repeat && now() >= settledAt) armed = true; };
  for (const type of ['pointerdown', 'mousedown', 'keydown']) dialog.addEventListener(type, arm);
  const dropRepeats = (event) => { if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault?.(); };
  dialog.addEventListener('keydown', dropRepeats);

  function syncControls() {
    const a = available.areas || {};
    for (const [value] of AREAS) area.inputs[value].closest('label').hidden = !a[value];
    if (!a[area.value]) area.value = AREAS.map(([v]) => v).find(v => a[v]) || 'view';
    const tiff = Boolean(available.geotiffAvailable || orthoProduct);
    format.inputs.tif.closest('label').hidden = !tiff;
    // While the list loads the original may yet be offered: keep a TIFF choice until it is known.
    if (!tiff && format.value === 'tif' && !listController) format.value = 'png';
    contours.input.disabled = !available.contoursAvailable; contours.row.hidden = !available.contoursAvailable;
    if (!available.contoursAvailable) contours.input.checked = false;
    property.input.disabled = !available.propertyAvailable; property.row.hidden = !available.propertyAvailable;
    if (!available.propertyAvailable) property.input.checked = false;
    const parcels = area.value === 'parcels', n = available.parcelCount || 0;
    parcelRow.hidden = !parcels;
    parcelCount.textContent = n ? plural(n, 'parcel', 'parcels') : 'No parcels selected';
    pickButton.textContent = n ? 'Change' : 'Pick on map';
    downloadButton.disabled = busy() || Boolean(productRequest) || tiffBlocked() || jpegTooLarge() || (!useOriginal() && ((parcels && !n) || !last));
    cancel.disabled = Boolean(committing);
    if (useOriginal()) dims.textContent = `Original GeoTIFF · ${orthoProduct.size}`;
    else if (last) dims.textContent = `${last.width.toLocaleString('en-US')} × ${last.height.toLocaleString('en-US')} px`;
    // Pages
    listPage.hidden = page !== 'list'; orthoPage.hidden = page !== 'ortho';
    actions.hidden = page !== 'ortho'; back.hidden = page !== 'ortho' || !listOffersMore(); back.disabled = busy() || Boolean(committing);
    title.textContent = page === 'ortho' ? 'Orthophoto' : 'Download';
  }
  const listOffersMore = () => list.children.length > 1;

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewController?.abort();
    last = null; syncControls();
    if (page !== 'ortho') return;
    previewTimer = setTimeout(renderPreview, 120);
  }

  async function renderPreview() {
    const opts = options();
    if (opts.area === 'parcels' && !(available.parcelCount > 0)) {
      canvasHost.replaceChildren(); dims.textContent = ''; previewState.textContent = 'Pick parcels on the map'; previewState.className = 'oe-preview-state'; return;
    }
    const controller = previewController = new AbortController();
    previewState.textContent = ''; previewState.className = 'oe-preview-state oe-loading';
    try {
      const result = await preview(opts, controller.signal);
      if (controller.signal.aborted) return;
      last = { ...opts, width: result.width, height: result.height };
      result.canvas.className = 'oe-preview-canvas';
      canvasHost.replaceChildren(result.canvas);
      // Without a save-file picker the whole file is built in memory.
      if (!useOriginal() && result.width * result.height >= MEMORY_WARNING_PIXELS && typeof windowRef?.showSaveFilePicker !== 'function') status.textContent = 'Very large file: this browser builds it in memory and may run out. Chrome or Edge on a computer saves it straight to disk.';
      if (jpegTooLarge()) status.textContent = `JPEG holds at most ${JPEG_MAX_SIDE.toLocaleString('en-US')} px per side. Choose PNG or TIFF, or a smaller area.`;
      previewState.className = 'oe-preview-state';
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      canvasHost.replaceChildren(); dims.textContent = '';
      previewState.className = 'oe-preview-state'; previewState.textContent = error?.code ? error.message : 'Preview unavailable';
    } finally { if (previewController === controller) { previewController = null; syncControls(); } }
  }

  function stopExport() { exportController?.abort(); exportController = null; progress.hidden = true; bar.style.width = '0'; }
  function stopProduct() { productRequest?.abort(); productRequest = null; }
  function stopAll() { clearTimeout(previewTimer); previewController?.abort(); previewController = null; stopExport(); stopProduct(); syncControls(); }

  // ---- the list ---------------------------------------------------------------
  function row(label, meta, { onPress, opens = false }) {
    const button = el('button', { type: 'button', className: 'dl-item' }, [
      el('span', { className: 'dl-item-text' }, [el('strong', { textContent: label }), el('small', { textContent: meta })]),
      icon(opens ? 'M9 5l7 7-7 7' : 'M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14'),
    ]);
    button.addEventListener('click', () => { if (armed) onPress(button); });
    const item = el('div', { className: 'dl-row' }, [button]);
    item.setAttribute('role', 'listitem');
    return item;
  }
  function orthoMeta() {
    const kinds = [(available.geotiffAvailable || orthoProduct) && 'TIFF', 'JPEG', 'PNG'].filter(Boolean);
    const formats = kinds.length === 3 ? 'TIFF, JPEG or PNG' : kinds.join(' or ');
    return orthoProduct ? `${formats} · original ${orthoProduct.size}` : formats;
  }
  function renderList(items) {
    const rows = [];
    let orthoShown = false;
    const showOrthoRow = () => { if (orthoShown || !exportAvailable()) return; orthoShown = true; rows.push(row('Orthophoto', orthoMeta(), { opens: true, onPress: () => showPage('ortho') })); };
    for (const product of items) {
      if (product.kind === 'ortho' && exportAvailable()) { showOrthoRow(); continue; }
      rows.push(row(product.label, `${product.format} · ${product.size}`, { onPress: (button) => void downloadProduct(product, button) }));
    }
    showOrthoRow();
    list.replaceChildren(...rows);
  }
  async function loadList() {
    listController?.abort();
    const controller = listController = new AbortController();
    orthoProduct = null;
    renderList([]);
    if (!products?.available?.()) { syncControls(); return; }
    status.textContent = 'Loading downloads…';
    try {
      const items = await products.list(controller.signal);
      if (controller.signal.aborted) return;
      orthoProduct = items.find(item => item.kind === 'ortho') || null;
      renderList(items);
      status.textContent = items.length || exportAvailable() ? '' : 'Nothing to download for this view.';
    } catch (error) {
      if (controller.signal.aborted) return;
      // Access or the model changed while loading: say nothing stale.
      status.textContent = error?.name === 'AbortError' ? '' : error?.message || 'Could not load the downloads. Close and retry.';
    } finally { if (listController === controller) { listController = null; syncControls(); } }
  }
  async function downloadProduct(product, button) {
    if (productRequest || busy()) return;
    const controller = productRequest = new AbortController();
    if (button) button.disabled = true;
    status.textContent = ''; syncControls();
    try {
      await products.download(product, controller.signal);
      if (!controller.signal.aborted) status.textContent = HANDED;
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      status.textContent = error?.message || 'This product could not be downloaded.';
    } finally {
      if (productRequest === controller) productRequest = null;
      if (button) button.disabled = false;
      syncControls();
    }
  }

  function showPage(next) {
    if (busy() || committing) return;
    page = next; disarm(); status.textContent = '';
    if (next !== 'ortho') stopAll();
    syncControls();
    if (next === 'ortho') schedulePreview();
    (next === 'ortho' ? area.inputs[area.value] : list.querySelector?.('button') || close)?.focus?.();
  }

  function open({ keepStatus = false, page: to = 'list' } = {}) {
    available = defaults() || {};
    disarm();
    if (!keepStatus) {
      // Property lines start off; contours follow the map.
      property.input.checked = false;
      contours.input.checked = Boolean(available.contoursAvailable && available.contoursOn);
      if (!area.value) area.value = AREAS.map(([v]) => v).find(v => available.areas?.[v]) || 'view';
      if (!format.value) format.value = 'png';
      status.textContent = '';
      // Only the image to offer: its page is the dialog.
      page = to === 'list' && !products?.available?.() && exportAvailable() ? 'ortho' : to;
      void loadList();
    }
    syncControls();
    if (!dialog.open) { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
    schedulePreview();
  }

  for (const input of [...Object.values(area.inputs), ...Object.values(format.inputs), contours.input, property.input]) {
    input.addEventListener('change', () => { status.textContent = ''; if (area.value === 'parcels' && !(available.parcelCount > 0) && input === area.inputs.parcels) { void startPicking(); return; } syncControls(); if (tiffBlocked() && orthoProduct) status.textContent = 'A TIFF of part of the orthophoto, or with layers, needs a declared coordinate system. Choose the whole orthophoto without layers, or JPEG or PNG.'; schedulePreview(); });
  }

  // One picking session at a time; the dialog comes back when it ends, however it ends.
  function startPicking() {
    if (picking) return picking;
    if (!pickParcels || busy()) return Promise.resolve();
    stopAll();
    let settle;
    const run = picking = new Promise((resolve) => { settle = resolve; }).finally(() => { if (picking === run) picking = null; open({ keepStatus: true }); });
    // Picking is marked before the dialog closes, so closing does not count as a cancel.
    dialog.close();
    Promise.resolve().then(() => pickParcels()).then((count) => { available.parcelCount = count; }, () => { /* keep the previous selection */ }).finally(settle);
    return run;
  }
  pickButton.addEventListener('click', () => { void startPicking(); });

  back.addEventListener('click', () => { if (!committing) showPage('list'); });
  close.addEventListener('click', () => dialog.close());
  cancel.addEventListener('click', () => {
    if (busy()) { stopExport(); status.textContent = 'Export cancelled.'; syncControls(); }
    else if (productRequest) { stopProduct(); status.textContent = ''; syncControls(); }
    else dialog.close();
  });
  dialog.addEventListener('close', () => { if (!picking && !committing) { stopAll(); listController?.abort(); } });
  openButton?.addEventListener('click', () => open());

  downloadButton.addEventListener('click', async () => {
    if (!armed || busy() || productRequest || tiffBlocked() || jpegTooLarge()) return;
    if (useOriginal()) { await downloadProduct(orthoProduct, null); return; }
    if (!last) return;
    const opts = options(), filename = exportFileName(opts), [description, mime, extension] = MIME[opts.format] || MIME.png;
    // The export is cancellable from here on: Cancel or Close while the save
    // picker or the file is opening creates nothing and runs nothing.
    const controller = exportController = new AbortController(), signal = controller.signal;
    progress.hidden = false; bar.style.width = '0'; status.textContent = 'Exporting…'; syncControls();
    let writable = null, committed = false;
    const discard = () => { const w = writable; writable = null; w?.abort?.()?.catch?.(() => {}); };
    try {
      // Very large files go straight to disk where the browser can do that.
      if (last.width * last.height >= LARGE_EXPORT_PIXELS && typeof windowRef?.showSaveFilePicker === 'function') {
        let handle = null;
        try {
          handle = await windowRef.showSaveFilePicker({ suggestedName: filename, types: [{ description, accept: { [mime]: [extension] } }] });
        } catch (error) { if (error?.name === 'AbortError') { if (!signal.aborted) status.textContent = ''; return; } }
        if (signal.aborted) return;
        if (handle) {
          try { writable = await handle.createWritable(); } catch { writable = null; }
          if (signal.aborted) { discard(); return; }
        }
      }
      const result = await run({ ...opts, filename }, signal, {
        writable,
        onProgress: (fraction) => { if (!signal.aborted && committing !== controller) { bar.style.width = `${Math.round(fraction * 100)}%`; status.textContent = `Exporting… ${Math.round(fraction * 100)}%`; } },
        // From here the chosen file is final: nothing is left to cancel.
        onCommit: () => { if (exportController !== controller) return; committing = controller; status.textContent = 'Saving…'; syncControls(); },
      });
      committed = result.committed === true;
      if (!committed) {
        if (signal.aborted) return;
        if (result.stillCurrent?.() === false) { status.textContent = ''; return; }
        if (result.blob) {
          const url = URL.createObjectURL(result.blob);
          const a = el('a', { href: url, download: result.filename || filename });
          documentRef.body.append(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        }
      }
      status.textContent = result.note || `Saved ${result.filename || filename}`;
    } catch (error) {
      if (error?.name === 'AbortError') { if (!signal.aborted) status.textContent = ''; return; }
      status.textContent = error?.code ? error.message : 'Could not export the image.';
    } finally {
      if (exportController === controller) { exportController = null; progress.hidden = true; }
      // Only this export's own commit ends here; an older one unwinding late leaves a newer commit alone.
      if (committing === controller) committing = null;
      syncControls();
    }
  });

  return { dialog, open, controls: { area, format, contours: contours.input, property: property.input, exportButton: downloadButton, downloadButton, cancel, status, pickButton, dims, back, list, title } };
}
