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
import { readRasterBandMetadata, resolveRasterVerticalUnits } from './raster-vertical-units.mjs';

export const CONTOUR_PANE = 'contours';
const VIEW_MAX_CELLS = 1_000_000;
const EXPORT_MAX_CELLS = 2_400_000;
// Vertex caps: a dense interval on steep ground stops with a message
// instead of handing the map or the print an unbounded line set.
export const VIEW_MAX_POINTS = 600_000;
export const EXPORT_MAX_POINTS = 2_000_000;
export const CONTOUR_WORKER_UNAVAILABLE = 'contour_worker_unavailable';

const cancelledError = () => new DOMException('Contours cancelled.', 'AbortError');
const workerUnavailable = () => Object.assign(new Error('Contours need a background worker, which this browser could not start.'), { code: CONTOUR_WORKER_UNAVAILABLE });

/**
 * Traces in a module worker. There is no silent main-thread fallback: a
 * worker that cannot start or crashes rejects with CONTOUR_WORKER_UNAVAILABLE
 * so the caller can say so. `inline: true` exists for tests only.
 */
export function createContourWorkerClient({ WorkerClass = null, inline = false } = {}) {
  let worker = null, seq = 0, failed = false;
  const pending = new Map();
  const failAll = (error) => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  function ensure() {
    if (worker || failed) return worker;
    try {
      const Ctor = WorkerClass || globalThis.Worker;
      if (typeof Ctor !== 'function') throw new Error('no worker');
      worker = WorkerClass ? new WorkerClass() : new Worker(new URL('./contour-worker.mjs', import.meta.url), { type: 'module' });
    } catch { failed = true; worker = null; return null; }
    worker.onmessage = (event) => {
      const { id, features, error, code } = event.data || {};
      const p = pending.get(id); if (!p) return;
      pending.delete(id);
      if (error) p.reject(Object.assign(new Error(error), { code: code || null })); else p.resolve(features);
    };
    worker.onerror = () => { failed = true; worker?.terminate(); worker = null; failAll(workerUnavailable()); };
    return worker;
  }
  return {
    compute(data, signal) {
      if (signal?.aborted) return Promise.reject(cancelledError());
      if (inline) return Promise.resolve().then(() => computeContourMessage(data));
      const w = ensure();
      if (!w) return Promise.reject(workerUnavailable());
      const id = ++seq;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        signal?.addEventListener('abort', () => {
          if (!pending.has(id)) return;
          pending.delete(id);
          // A stale trace can be long; restart the worker instead of waiting.
          w.terminate(); if (worker === w) worker = null;
          failAll(cancelledError());
          reject(cancelledError());
        }, { once: true });
        w.postMessage({ id, ...data }, [data.values.buffer]);
      });
    },
    dispose() { worker?.terminate(); worker = null; failAll(cancelledError()); },
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

export const CONTOUR_VERTICAL_UNITS = 'contour_vertical_units';

/**
 * Metres per stored DTM value, from the raster's declared vertical units
 * (VerticalUnitsGeoKey or GDAL band UNITTYPE), the same resolution the
 * measurement path uses. Undeclared rasters are read as metres, as the
 * DSM/DTM views read them; unsupported or conflicting declarations refuse.
 */
export async function dtmVerticalScale(ds) {
  const image = ds.images[0];
  try {
    const bandMetadata = await readRasterBandMetadata(image);
    return resolveRasterVerticalUnits(image, { bandMetadata, confirmMeters: true }).verticalFactor;
  } catch (error) {
    throw Object.assign(new Error('The DTM declares elevation units the Viewer cannot use for contours.'), { code: CONTOUR_VERTICAL_UNITS, cause: error });
  }
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

  const verticalScale = deps.verticalScale || dtmVerticalScale;
  const elevations = new WeakMap(); // ds -> Promise<{ scale, min, max }> in metres
  const colors = () => CONTOUR_COLORS[colorKey] || CONTOUR_COLORS.brown;

  function elevationInfo(ds) {
    if (!elevations.has(ds)) {
      elevations.set(ds, Promise.resolve(verticalScale(ds)).then(scale => ({ scale, min: ds.min * scale, max: ds.max * scale })));
      elevations.get(ds).catch(() => elevations.delete(ds));
    }
    return elevations.get(ds);
  }

  function messageFor(error, interval, u) {
    if (error?.code === 'contours_too_dense' || error?.code === 'contours_too_many') return `${interval} ${unitSuffix(u)} is too fine here. Choose a larger interval.`;
    if (error?.code === CONTOUR_WORKER_UNAVAILABLE) return 'Contours are unavailable in this browser.';
    if (error?.code === CONTOUR_VERTICAL_UNITS) return 'Contours are unavailable: the DTM elevation units are not supported.';
    return 'Could not draw contours. Try again or choose a larger interval.';
  }
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

  function resolveInterval(elev) {
    if (intervalChoice !== 'auto') return Number(intervalChoice);
    return autoContourInterval(elev.min, elev.max, units());
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
    let u = units(), interval = null;
    try {
      const ds = await deps.getDtm(signal);
      const elev = await elevationInfo(ds);
      if (mine !== generation) return;
      interval = resolveInterval(elev);
      const { levels, tooMany } = contourLevels(elev.min, elev.max, interval, u);
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
      const features = await traceWindow(ds, elev.scale, plan, levels, signal, deps.projection?.() || null, worker, VIEW_MAX_POINTS);
      if (mine !== generation) return;
      cache = { settingsKey, level: plan.level, cellE: plan.grid.cellE, extent: plan.extent, features, interval, units: u };
      layer?.setData(features, colors());
      setStatus('');
    } catch (error) {
      if (error?.name === 'AbortError' || mine !== generation) return;
      if (error?.code === 'contours_too_dense') { layer?.setData([], colors()); cache = null; }
      setStatus(messageFor(error, interval, u));
    }
  }

  async function traceWindow(ds, valueScale, plan, levels, signal, projection, client, maxPoints) {
    const image = ds.images[plan.level];
    const nodata = Number.isFinite(ds.nodata) ? ds.nodata : -9999;
    const raster = await image.readRasters({
      window: plan.window, width: plan.outW, height: plan.outH,
      resampleMethod: 'nearest', interleave: false, fillValue: nodata, pool: deps.pool?.(), signal,
    });
    const band = raster[0];
    const values = band instanceof Float32Array ? band : Float32Array.from(band);
    return client.compute({ values, width: plan.outW, height: plan.outH, nodata, valueScale, levels, grid: plan.grid, projection, maxPoints }, signal);
  }

  /** Contours in raster CRS (UTM metres) for an export extent. */
  async function computeForExtent(extent, targetCell, { signal, interval: chosen } = {}) {
    const ds = await deps.getDtm(signal);
    const elev = await elevationInfo(ds);
    const u = units(), interval = chosen ?? resolveInterval(elev);
    const { levels, tooMany } = contourLevels(elev.min, elev.max, interval, u);
    if (tooMany) throw Object.assign(new Error(messageFor({ code: 'contours_too_many' }, interval, u)), { code: 'contours_too_many' });
    const plan = chooseDemWindow({ ...ds, levels: demLevels(ds) }, extent, { targetCell, maxCells: EXPORT_MAX_CELLS });
    if (!plan) return { features: [], interval, units: u };
    exportWorker ||= createContourWorkerClient();
    try {
      const features = await traceWindow(ds, elev.scale, plan, levels, signal, null, exportWorker, EXPORT_MAX_POINTS);
      return { features, interval, units: u };
    } catch (error) {
      if (error?.name === 'AbortError' || !error?.code) throw error;
      throw Object.assign(new Error(messageFor(error, interval, u)), { code: error.code });
    }
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
