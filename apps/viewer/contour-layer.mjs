// Contours map overlay: one Show/Hide toggle with an interval and colour
// chooser. Lines are traced from the task's DTM for the visible area (plus a
// margin) at a resolution matched to the zoom, off the main thread, and drawn
// on a canvas above the ortho/DEM tiles and below property lines.
import {
  CONTOUR_COLORS,
  autoContourInterval,
  chooseDemWindow,
  contourLevels,
  contourUnits,
  drawContours,
  intervalOptions,
  unitSuffix,
} from './contours.mjs';
import { computeContourMessage } from './contour-worker.mjs';

export const CONTOUR_PANE = 'contours';
const VIEW_MAX_CELLS = 1_000_000;
const EXPORT_MAX_CELLS = 2_400_000;

export function createContourWorkerClient({ WorkerClass = null, inline = false } = {}) {
  let worker = null, seq = 0;
  const pending = new Map();
  const failAll = (error) => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  function ensure() {
    if (inline) return null;
    if (worker) return worker;
    try {
      worker = WorkerClass ? new WorkerClass() : new Worker(new URL('./contour-worker.mjs', import.meta.url), { type: 'module' });
    } catch { inline = true; return null; }
    worker.onmessage = (event) => {
      const { id, features, error } = event.data || {};
      const p = pending.get(id); if (!p) return;
      pending.delete(id);
      if (error) p.reject(new Error(error)); else p.resolve(features);
    };
    worker.onerror = () => { failAll(new Error('Contour worker failed.')); worker?.terminate(); worker = null; inline = true; };
    return worker;
  }
  return {
    compute(data, signal) {
      if (signal?.aborted) return Promise.reject(new DOMException('Contours cancelled.', 'AbortError'));
      const w = ensure();
      if (!w) return Promise.resolve().then(() => computeContourMessage(data));
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        signal?.addEventListener('abort', () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          // A stale trace can be long; restart the worker instead of waiting.
          w.terminate(); if (worker === w) worker = null;
          failAll(new DOMException('Contours cancelled.', 'AbortError'));
          reject(new DOMException('Contours cancelled.', 'AbortError'));
        }, { once: true });
        w.postMessage({ id, ...data }, [data.values.buffer]);
      });
    },
    dispose() { worker?.terminate(); worker = null; failAll(new DOMException('Contours cancelled.', 'AbortError')); },
  };
}

export function createContourCanvasLayer(L) {
  return L.Layer.extend({
    options: { pane: CONTOUR_PANE, padding: 0.25 },
    initialize(options) { L.setOptions(this, options); this._features = []; this._colors = CONTOUR_COLORS.brown; this._proj = null; },
    onAdd(map) {
      if (!map.getPane(this.options.pane)) {
        const pane = map.createPane(this.options.pane);
        pane.style.zIndex = 455; // above ortho/DEM detail tiles (450), below property lines (460)
        pane.style.pointerEvents = 'none';
      }
      this._canvas = L.DomUtil.create('canvas', 'ltds-contour-canvas', map.getPane(this.options.pane));
      this._canvas.style.pointerEvents = 'none';
      map.on('moveend zoomend resize viewreset', this._reset, this);
      map.on('zoomstart', this._hide, this);
      this._reset();
    },
    onRemove(map) {
      map.off('moveend zoomend resize viewreset', this._reset, this);
      map.off('zoomstart', this._hide, this);
      this._canvas?.remove(); this._canvas = null; this._proj = null;
    },
    setData(features, colors) { this._features = features || []; if (colors) this._colors = colors; this._proj = null; this._reset(); return this; },
    setColors(colors) { this._colors = colors; this._reset(); return this; },
    drawnCount() { return this._drawn || null; },
    _hide() { if (this._canvas) this._canvas.style.visibility = 'hidden'; },
    _reset() {
      const map = this._map, canvas = this._canvas;
      if (!map || !canvas) return;
      const size = map.getSize();
      const padX = Math.round(size.x * this.options.padding), padY = Math.round(size.y * this.options.padding);
      const w = size.x + 2 * padX, h = size.y + 2 * padY;
      const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
      const topLeft = map.containerPointToLayerPoint([-padX, -padY]);
      L.DomUtil.setPosition(canvas, topLeft);
      canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const zoom = map.getZoom();
      if (!this._proj || this._proj.zoom !== zoom) {
        // Projected pixel coordinates at this zoom; panning only shifts them.
        const features = this._features.map(f => {
          const ll = f.latLng, out = new Float64Array(ll.length);
          for (let i = 0; i < ll.length; i += 2) { const p = map.project([ll[i], ll[i + 1]], zoom); out[i] = p.x; out[i + 1] = p.y; }
          return { isIndex: f.isIndex, label: f.label, coords: out };
        });
        this._proj = { zoom, features };
      }
      const origin = topLeft.add(map.getPixelOrigin());
      this._drawn = drawContours(ctx, this._proj.features, (x, y) => [x - origin.x, y - origin.y], { colors: this._colors, width: w, height: h });
      canvas.style.visibility = 'visible';
    },
  });
}

function demLevels(ds) {
  return ds.images.map(image => ({ width: image.getWidth(), height: image.getHeight() }));
}

function viewExtentUtm(map, latLonToUtm) {
  const b = map.getBounds();
  const corners = [b.getNorthWest(), b.getNorthEast(), b.getSouthWest(), b.getSouthEast()].map(c => latLonToUtm(c.lat, c.lng));
  const es = corners.map(c => c[0]), ns = corners.map(c => c[1]);
  return { minE: Math.min(...es), maxE: Math.max(...es), minN: Math.min(...ns), maxN: Math.max(...ns) };
}

function contains(outer, inner) {
  return outer && inner.minE >= outer.minE && inner.maxE <= outer.maxE && inner.minN >= outer.minN && inner.maxN <= outer.maxN;
}

/**
 * @param deps {
 *   L, documentRef, dom: { panel, button, interval, color, status },
 *   getMap(), isMapMode(), hasDtm(), getDtm(signal) -> GeoTIFF dataset as main.js builds it,
 *   pool(), units() -> 'imperial'|'metric', projection() -> { zoneLon0Deg, hemisphere },
 *   latLonToUtm(lat, lon), worker (optional client), debounceMs
 * }
 */
export function createContourController(deps) {
  const { L, dom } = deps;
  const documentRef = deps.documentRef || globalThis.document;
  const worker = deps.worker || createContourWorkerClient();
  // Exports trace on their own worker so a map pan never cancels them.
  let exportWorker = deps.exportWorker || null;
  const Layer = deps.Layer || createContourCanvasLayer(L);
  let on = false, layer = null, timer = null, abort = null, generation = 0, cache = null, status = '', lastUnits = null;
  let intervalChoice = 'auto', colorKey = 'brown';

  const colors = () => CONTOUR_COLORS[colorKey] || CONTOUR_COLORS.brown;
  const units = () => contourUnits(deps.units?.());
  const setStatus = (text) => { status = text; if (dom.status) dom.status.textContent = text; };

  function populateIntervals() {
    const u = units();
    if (u === lastUnits || !dom.interval) return;
    // Changing units invalidates a numeric choice; keep Auto.
    if (lastUnits !== null) intervalChoice = 'auto';
    lastUnits = u;
    const suffix = unitSuffix(u);
    const option = (value, text) => { const o = documentRef.createElement('option'); o.value = String(value); o.textContent = text; return o; };
    dom.interval.replaceChildren(option('auto', 'Auto'), ...intervalOptions(u).map(step => option(step, `${step} ${suffix}`)));
    dom.interval.value = String(intervalChoice);
  }

  function resolveInterval(ds) {
    if (intervalChoice !== 'auto') return Number(intervalChoice);
    return autoContourInterval(ds.min, ds.max, units());
  }

  function syncButton() {
    if (!dom.button) return;
    dom.button.textContent = on ? 'Hide' : 'Show';
    dom.button.classList?.toggle('active', on);
    dom.button.setAttribute('aria-pressed', String(on));
    dom.button.setAttribute('aria-label', on ? 'Hide contour lines' : 'Show contour lines');
  }

  function detach() {
    const map = deps.getMap();
    if (layer && map && map.hasLayer(layer)) map.removeLayer(layer);
  }

  function cancel() { generation++; abort?.abort(); abort = null; clearTimeout(timer); timer = null; }

  function refresh() {
    populateIntervals();
    const map = deps.getMap();
    const available = Boolean(deps.hasDtm() && deps.isMapMode() && map);
    if (dom.panel) dom.panel.hidden = !deps.hasDtm() || !deps.isMapMode();
    syncButton();
    if (!available || !on) { cancel(); detach(); if (!on) setStatus(''); return; }
    if (!layer) layer = new Layer();
    if (!map.hasLayer(layer)) { layer.setData(cache?.features || [], colors()); layer.addTo(map); }
    schedule();
  }

  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; update().catch(() => {}); }, deps.debounceMs ?? 120);
  }

  async function update() {
    const map = deps.getMap();
    if (!on || !map || !deps.isMapMode() || !deps.hasDtm()) return;
    generation++; abort?.abort();
    const mine = generation, controller = new AbortController(); abort = controller;
    const signal = controller.signal;
    try {
      const ds = await deps.getDtm(signal);
      if (mine !== generation) return;
      const u = units(), interval = resolveInterval(ds);
      const { levels, tooMany } = contourLevels(ds.min, ds.max, interval, u);
      if (tooMany) { layer?.setData([], colors()); cache = null; setStatus(`${interval} ${unitSuffix(u)} is too fine for this site. Choose a larger interval.`); return; }
      const view = viewExtentUtm(map, deps.latLonToUtm);
      const spanE = view.maxE - view.minE, spanN = view.maxN - view.minN;
      const padded = { minE: view.minE - spanE * 0.25, maxE: view.maxE + spanE * 0.25, minN: view.minN - spanN * 0.25, maxN: view.maxN + spanN * 0.25 };
      const metersPerPx = spanE / Math.max(1, map.getSize().x);
      const plan = chooseDemWindow({ ...ds, levels: demLevels(ds) }, padded, { targetCell: metersPerPx * 2, maxCells: VIEW_MAX_CELLS });
      if (!plan) { layer?.setData([], colors()); setStatus(''); return; }
      const settingsKey = `${u}|${interval}`;
      if (cache && cache.settingsKey === settingsKey && cache.level === plan.level
        && Math.abs(Math.log(cache.cellE / plan.grid.cellE)) < Math.log(1.6)
        && contains(cache.extent, { minE: Math.max(view.minE, ds.minE), maxE: Math.min(view.maxE, ds.maxE), minN: Math.max(view.minN, ds.minN), maxN: Math.min(view.maxN, ds.maxN) })) {
        setStatus(''); return;
      }
      setStatus('Loading contours…');
      const features = await traceWindow(ds, plan, levels, signal, deps.projection?.() || null);
      if (mine !== generation) return;
      cache = { settingsKey, level: plan.level, cellE: plan.grid.cellE, extent: plan.extent, features, interval, units: u };
      layer?.setData(features, colors());
      setStatus('');
    } catch (error) {
      if (error?.name === 'AbortError' || mine !== generation) return;
      setStatus('Could not draw contours. Try again or choose a larger interval.');
    }
  }

  async function traceWindow(ds, plan, levels, signal, projection, client = worker) {
    const image = ds.images[plan.level];
    const nodata = Number.isFinite(ds.nodata) ? ds.nodata : -9999;
    const raster = await image.readRasters({
      window: plan.window, width: plan.outW, height: plan.outH,
      resampleMethod: 'nearest', interleave: false, fillValue: nodata, pool: deps.pool?.(), signal,
    });
    const band = raster[0];
    const values = band instanceof Float32Array ? band : Float32Array.from(band);
    return client.compute({ values, width: plan.outW, height: plan.outH, nodata, levels, grid: plan.grid, projection }, signal);
  }

  /** Contours in raster CRS (UTM metres) for an export extent. */
  async function computeForExtent(extent, targetCell, { signal, interval: chosen } = {}) {
    const ds = await deps.getDtm(signal);
    const u = units(), interval = chosen ?? resolveInterval(ds);
    const { levels, tooMany } = contourLevels(ds.min, ds.max, interval, u);
    if (tooMany) throw Object.assign(new Error('Contour interval too fine for this site.'), { code: 'contours_too_many' });
    const plan = chooseDemWindow({ ...ds, levels: demLevels(ds) }, extent, { targetCell, maxCells: EXPORT_MAX_CELLS });
    if (!plan) return { features: [], interval, units: u };
    exportWorker ||= createContourWorkerClient();
    const features = await traceWindow(ds, plan, levels, signal, null, exportWorker);
    return { features, interval, units: u };
  }

  function toggle() { on = !on; refresh(); }

  dom.button?.addEventListener('click', toggle);
  dom.interval?.addEventListener('change', () => { intervalChoice = dom.interval.value === 'auto' ? 'auto' : Number(dom.interval.value); cache = null; refresh(); });
  dom.color?.addEventListener('change', () => { colorKey = CONTOUR_COLORS[dom.color.value] ? dom.color.value : 'brown'; layer?.setColors(colors()); });

  return {
    refresh,
    toggle,
    // Project changed: drop traced lines; keep the viewer's Show/Hide choice.
    sync() { cancel(); cache = null; layer?.setData([], colors()); lastUnits = null; refresh(); },
    computeForExtent,
    colors,
    get state() {
      return { on, status, interval: intervalChoice, color: colorKey, units: units(),
        traced: cache ? { interval: cache.interval, units: cache.units, features: cache.features.length, level: cache.level } : null };
    },
  };
}
