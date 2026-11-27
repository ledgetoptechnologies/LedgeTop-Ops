// Export image dialog: area (whole, current view, selected parcels), format,
// layers, a live preview and progress. Always full native resolution where
// access allows it; the work itself is done by the callbacks.
//   defaults() → { areas: { full, view, parcels }, parcelCount, contoursAvailable, propertyAvailable, geotiffAvailable }
//   preview(options, signal) → { canvas, width, height } (width/height of the final file)
//   run(options, signal, { onProgress, writable }) → { blob | null, filename, note?, stillCurrent? }
//   pickParcels() → Promise<count>; the dialog hides while the person picks on the map.

export const LARGE_EXPORT_PIXELS = 100_000_000;
export const MEMORY_WARNING_PIXELS = 250_000_000;
const AREAS = [['full', 'Whole orthophoto'], ['view', 'Current view'], ['parcels', 'Selected parcels']];
const FORMATS = [['png', 'PNG'], ['tif', 'GeoTIFF']];

const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function exportFileName({ area, format, contours }) {
  return `orthophoto${area === 'view' ? '-view' : area === 'parcels' ? '-parcels' : ''}${contours ? '-contours' : ''}.${format === 'tif' ? 'tif' : 'png'}`;
}

export function mountOrthoExportDialog({ documentRef = document, windowRef = globalThis.window, openButton, defaults = () => ({}), preview, run, pickParcels }) {
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
    return { group, inputs, get value() { return Object.values(inputs).find(i => i.checked)?.value; }, set value(v) { if (inputs[v]) inputs[v].checked = true; } };
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
  const close = el('button', { type: 'button', className: 'oe-close' }, [icon('M6 6l12 12M18 6L6 18')]);
  close.setAttribute('aria-label', 'Close');
  const cancel = el('button', { type: 'button', className: 'oe-btn', textContent: 'Cancel' });
  const exportButton = el('button', { type: 'button', className: 'oe-btn oe-primary', textContent: 'Export' });
  const field = (title, ...children) => el('section', { className: 'oe-field' }, [el('h3', { textContent: title }), ...children]);
  const dialog = el('dialog', { className: 'oe-dialog' }, [
    el('header', { className: 'oe-head' }, [el('h2', { textContent: 'Export image' }), close]),
    el('div', { className: 'oe-body' }, [
      el('figure', { className: 'oe-preview' }, [canvasHost, previewState, el('figcaption', {}, [dims])]),
      el('div', { className: 'oe-controls' }, [
        field('Area', area.group, parcelRow),
        field('Format', format.group),
        field('Layers', contours.row, property.row),
      ]),
    ]),
    el('footer', { className: 'oe-foot' }, [progress, status, el('div', { className: 'oe-actions' }, [cancel, exportButton])]),
  ]);
  dialog.setAttribute('aria-label', 'Export orthophoto image');
  documentRef.body.append(dialog);

  let available = {}, previewController = null, exportController = null, previewTimer = null, last = null, picking = false;
  const options = () => ({ area: area.value, format: format.value, contours: contours.input.checked, property: property.input.checked });
  const busy = () => Boolean(exportController);

  function syncControls() {
    const a = available.areas || {};
    for (const [value] of AREAS) area.inputs[value].closest('label').hidden = !a[value];
    if (!a[area.value]) area.value = AREAS.map(([v]) => v).find(v => a[v]) || 'view';
    format.inputs.tif.closest('label').hidden = !available.geotiffAvailable;
    if (!available.geotiffAvailable) format.value = 'png';
    contours.input.disabled = !available.contoursAvailable; contours.row.hidden = !available.contoursAvailable;
    if (!available.contoursAvailable) contours.input.checked = false;
    property.input.disabled = !available.propertyAvailable; property.row.hidden = !available.propertyAvailable;
    if (!available.propertyAvailable) property.input.checked = false;
    const parcels = area.value === 'parcels', n = available.parcelCount || 0;
    parcelRow.hidden = !parcels;
    parcelCount.textContent = n ? plural(n, 'parcel', 'parcels') : 'No parcels selected';
    pickButton.textContent = n ? 'Change' : 'Pick on map';
    exportButton.disabled = busy() || (parcels && !n) || !last;
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewController?.abort();
    last = null; syncControls();
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
      dims.textContent = `${result.width.toLocaleString('en-US')} × ${result.height.toLocaleString('en-US')} px`;
      // Without a save-file picker the whole file is built in memory.
      if (result.width * result.height >= MEMORY_WARNING_PIXELS && typeof windowRef?.showSaveFilePicker !== 'function') status.textContent = 'Very large file: this browser builds it in memory and may run out. Chrome or Edge on a computer saves it straight to disk.';
      previewState.className = 'oe-preview-state';
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') return;
      canvasHost.replaceChildren(); dims.textContent = '';
      previewState.className = 'oe-preview-state'; previewState.textContent = error?.code ? error.message : 'Preview unavailable';
    } finally { if (previewController === controller) { previewController = null; syncControls(); } }
  }

  function stopExport() { exportController?.abort(); exportController = null; progress.hidden = true; bar.style.width = '0'; }
  function stopAll() { clearTimeout(previewTimer); previewController?.abort(); previewController = null; stopExport(); syncControls(); }

  function open({ keepStatus = false } = {}) {
    available = defaults() || {};
    if (!keepStatus) {
      // Property lines start off; contours follow the map.
      property.input.checked = false;
      contours.input.checked = Boolean(available.contoursAvailable && available.contoursOn);
      if (!area.value) area.value = AREAS.map(([v]) => v).find(v => available.areas?.[v]) || 'view';
      if (!format.value) format.value = 'png';
      status.textContent = '';
    }
    syncControls();
    if (!dialog.open) { if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
    schedulePreview();
  }

  for (const input of [...Object.values(area.inputs), ...Object.values(format.inputs), contours.input, property.input]) {
    input.addEventListener('change', () => { status.textContent = ''; if (area.value === 'parcels' && !(available.parcelCount > 0) && input === area.inputs.parcels) { void startPicking(); return; } syncControls(); schedulePreview(); });
  }

  async function startPicking() {
    if (!pickParcels || busy()) return;
    picking = true;
    stopAll();
    dialog.close();
    try { available.parcelCount = await pickParcels(); } finally { picking = false; }
    open({ keepStatus: true });
  }
  pickButton.addEventListener('click', () => { void startPicking(); });

  close.addEventListener('click', () => dialog.close());
  cancel.addEventListener('click', () => { if (busy()) { stopExport(); status.textContent = 'Export cancelled.'; syncControls(); } else dialog.close(); });
  dialog.addEventListener('close', () => { if (!picking) stopAll(); });
  openButton?.addEventListener('click', () => open());

  exportButton.addEventListener('click', async () => {
    if (busy() || !last) return;
    const opts = options(), filename = exportFileName(opts);
    let writable = null;
    // Very large files go straight to disk where the browser can do that.
    if (last.width * last.height >= LARGE_EXPORT_PIXELS && typeof windowRef?.showSaveFilePicker === 'function') {
      try {
        const handle = await windowRef.showSaveFilePicker({ suggestedName: filename, types: [{ description: opts.format === 'tif' ? 'GeoTIFF' : 'PNG image', accept: { [opts.format === 'tif' ? 'image/tiff' : 'image/png']: [opts.format === 'tif' ? '.tif' : '.png'] } }] });
        writable = await handle.createWritable();
      } catch (error) { if (error?.name === 'AbortError') return; writable = null; }
    }
    const controller = exportController = new AbortController(), signal = controller.signal;
    progress.hidden = false; bar.style.width = '0'; status.textContent = 'Exporting…'; syncControls();
    try {
      const result = await run({ ...opts, filename }, signal, {
        writable,
        onProgress: (fraction) => { if (!signal.aborted) { bar.style.width = `${Math.round(fraction * 100)}%`; status.textContent = `Exporting… ${Math.round(fraction * 100)}%`; } },
      });
      if (signal.aborted) return;
      if (result.stillCurrent?.() === false) { status.textContent = ''; return; }
      if (result.blob) {
        const url = URL.createObjectURL(result.blob);
        const a = el('a', { href: url, download: result.filename || filename });
        documentRef.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      status.textContent = result.note || `Saved ${result.filename || filename}`;
    } catch (error) {
      if (error?.name === 'AbortError') { if (!signal.aborted) status.textContent = ''; return; }
      status.textContent = error?.code ? error.message : 'Could not export the image.';
    } finally {
      if (exportController === controller) { exportController = null; progress.hidden = true; }
      syncControls();
    }
  });

  return { dialog, open, controls: { area, format, contours: contours.input, property: property.input, exportButton, cancel, status, pickButton, dims } };
}
