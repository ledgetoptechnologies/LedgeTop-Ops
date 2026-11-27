// Property lines layer controller: one "Property lines" toggle that draws the
// same parcel outlines on the Leaflet map views, in the three.js 3D views and
// in the Potree point cloud. Main.js supplies everything model-specific.
// Touching parcels of one owner are drawn as one outline, and map views label
// each outline with its owner's name (property-lines-owners.mjs).
import { BRAND_COLORS } from './brand-colors.mjs';
import {
  boundsKey,
  createParcelFetcher,
  createParcelTileLoader,
  groundHeightsConsistent,
  parcelsToUtmPolylines,
  propertyLinesAvailability,
  propertyLinesMessage,
  propertyLinesRequestBounds,
  propertyLinesTilesForView,
  sampleGrid,
  tilesCoverBounds,
  utmExtentToLonLatBounds,
} from './property-lines.mjs';
import { dissolveParcelsByOwner, ownerLabelCandidates, placeOwnerLabels } from './property-lines-owners.mjs';

// The Viewer's orange accent (--brand-orange in index.html, generated from
// packages/ui/src/brand.ts) with a dark halo for contrast on imagery.
export const PROPERTY_LINE_STYLE = Object.freeze({
  color: BRAND_COLORS.orange,
  halo: '#111111',
  mapWeight: 2.5,
  mapHaloWeight: 5,
  lineWidthPx: 2.5,
  haloWidthPx: 5,
  liftMeters: 0.2,
});

const RETRY_MS = 1500;
// Tiles the server could not answer (busy or down) are asked for again,
// backing off: 2 s, 4 s, 8 s, 16 s, 30 s, then the card says so and stops.
const TILE_RETRY_MS = 2000;
const TILE_RETRY_MAX_MS = 30_000;
const TILE_RETRIES = 5;
const MAX_RETRIES = 40;

export function propertyLinesModeKind(mode, cloudMode) {
  if (mode === 'ortho' || mode === 'dsm' || mode === 'dtm') return 'map';
  if (mode === 'model' || (mode === 'cloud' && cloudMode === 'direct')) return 'three';
  if (mode === 'cloud' && cloudMode === 'potree') return 'potree';
  return null;
}

// Heights for UTM polylines: the published DTM when it agrees with the scene,
// otherwise one flat height (the scene's lowest level), with the reason.
export function drapePolylines(lines, { grid = null, minAlt, maxAlt, lift = PROPERTY_LINE_STYLE.liftMeters } = {}) {
  const flat = Number.isFinite(minAlt) ? minAlt : 0;
  if (grid) {
    const probe = [];
    const stride = Math.max(1, Math.floor(lines.reduce((n, l) => n + l.length, 0) / 400));
    let index = 0;
    for (const line of lines) for (const [e, n] of line) { if (index++ % stride === 0) probe.push(sampleGrid(grid, e, n)); }
    if (groundHeightsConsistent(probe, { minAlt, maxAlt })) {
      const finite = probe.filter(Number.isFinite).sort((a, b) => a - b);
      const fallback = finite[Math.floor(finite.length / 2)];
      return {
        draped: true,
        note: 'Lines follow the published ground model (DTM).',
        lines: lines.map(line => line.map(([e, n]) => { const z = sampleGrid(grid, e, n); return [e, n, (Number.isFinite(z) ? z : fallback) + lift]; })),
      };
    }
    return { draped: false, note: 'Ground model does not match this scene; lines are drawn flat at the site’s lowest level and show through the surface.',
      lines: lines.map(line => line.map(([e, n]) => [e, n, flat + lift])) };
  }
  return { draped: false, note: 'No ground model is published; lines are drawn flat at the site’s lowest level and show through the surface.',
    lines: lines.map(line => line.map(([e, n]) => [e, n, flat + lift])) };
}

// A viewer's explicit Hide, remembered per project in this browser with the
// same plain localStorage pattern as the Viewer's other display preferences.
// Only project ids are stored. Storage that is missing or blocked (private
// windows, sandboxed embeds) simply means nothing is remembered after reload.
export const PROPERTY_LINES_HIDDEN_KEY = 'ltds-viewer:property-lines-hidden';
export const PROPERTY_LINES_HIDDEN_LIMIT = 100;
// "Merge parcels by owner" is on unless this browser turned it off ('0').
export const PROPERTY_LINES_MERGE_KEY = 'ltds-viewer:property-lines-merge';

export function createPropertyLinesPreferences(storage) {
  const store = () => { try { return storage === undefined ? globalThis.localStorage ?? null : storage; } catch { return null; } };
  const list = () => {
    try {
      const value = JSON.parse(store()?.getItem(PROPERTY_LINES_HIDDEN_KEY) || '[]');
      return Array.isArray(value) ? value.filter(id => typeof id === 'string' && id).slice(-PROPERTY_LINES_HIDDEN_LIMIT) : [];
    } catch { return []; }
  };
  return {
    hidden(projectId) { return Boolean(projectId) && list().includes(String(projectId)); },
    setHidden(projectId, hidden) {
      if (!projectId) return;
      const id = String(projectId);
      const next = list().filter(entry => entry !== id);
      if (hidden) next.push(id);
      try {
        if (next.length) store()?.setItem(PROPERTY_LINES_HIDDEN_KEY, JSON.stringify(next.slice(-PROPERTY_LINES_HIDDEN_LIMIT)));
        else store()?.removeItem(PROPERTY_LINES_HIDDEN_KEY);
      } catch { /* The choice still holds for this page. */ }
    },
    merged() { try { return store()?.getItem(PROPERTY_LINES_MERGE_KEY) !== '0'; } catch { return true; } },
    setMerged(value) {
      try { if (value) store()?.removeItem(PROPERTY_LINES_MERGE_KEY); else store()?.setItem(PROPERTY_LINES_MERGE_KEY, '0'); } catch { /* kept for this page */ }
    },
  };
}

// Label text width for the label font, measured once per text and size.
function createTextMeasure() {
  const widths = new Map();
  let context = null;
  return (text, px) => {
    const key = `${px}|${text}`;
    if (widths.has(key)) return widths.get(key);
    let width = text.length * px * 0.62;
    try {
      context ||= document.createElement('canvas').getContext('2d');
      if (context) {
        const family = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'sans-serif';
        context.font = `600 ${px}px ${family}`;
        width = context.measureText(text).width;
      }
    } catch { /* estimate */ }
    widths.set(key, width);
    return width;
  };
}

// The layer is shown by default wherever it is offered and available; an
// explicit Hide is kept per project. Everything fetched belongs to one
// lifecycle (project + model version + access); a result from an older
// lifecycle is dropped without drawing or rendering anything.
export function createPropertyLinesController(deps) {
  const { L, THREE, LineSegments2, LineSegmentsGeometry, LineMaterial, dom } = deps;
  const fetcher = createParcelFetcher({ fetchImpl: deps.fetchImpl, headers: deps.headers, model: () => deps.projectId(), ...(deps.fetcherOptions || {}) });
  const { cacheEntries: _siteCacheEntries, ...tileOptions } = deps.fetcherOptions || {};
  const tiles = createParcelTileLoader({ fetchImpl: deps.fetchImpl, headers: deps.headers, model: () => deps.projectId(), ...tileOptions });
  const preferences = deps.preferences || createPropertyLinesPreferences(deps.storage);
  const measure = deps.measureText || createTextMeasure();
  const hiddenByProject = new Map();
  let merge = true;
  try { merge = preferences.merged?.() !== false; } catch { merge = true; }
  let offered = false, source = null, hidden = false, suspended = false, status = 'off', count = 0, partial = false;
  let failedTiles = false, tileRetries = 0, tileRetryTimer = null, tileRetryKey = null;
  let labelsEl = null, labelsMap = null, labelKey = null, viewTilesKey = null;
  let life = 0, lifeKey = null, lifeProject = null, offerSeq = 0;
  let siteBounds = null, retryTimer = null, retries = 0, seq = 0;
  // One canvas renderer per Leaflet map, reused for every redraw.
  let mapRenderer = null, rendererMap = null, drawnMapKey = null;
  let current = null, mapLayers = null, threeGroup = null, threeKey = null, potreeKey = null, potreeShown = false, heightNote = '', heightDraped = false, groundAbort = null;
  const draped = new Map();

  function kind() { return propertyLinesModeKind(deps.getMode(), deps.getCloudMode()); }
  function isOn() { return offered && !hidden && !suspended; }

  function hiddenFor(projectId) {
    if (!projectId) return false;
    if (hiddenByProject.has(projectId)) return hiddenByProject.get(projectId);
    try { return preferences.hidden(projectId) === true; } catch { return false; }
  }

  function rememberHidden(projectId, value) {
    if (!projectId) return;
    hiddenByProject.set(projectId, value);
    try { preferences.setHidden(projectId, value); } catch { /* kept for this page */ }
  }

  // Project + model version + who the access belongs to. Hide follows the project only.
  function lifecycleKey() {
    const id = deps.projectId() || null;
    if (!id) return { id, key: null };
    const version = deps.projectVersion?.() ?? '';
    const authority = deps.authorityKey?.() ?? '';
    return { id, key: JSON.stringify([id, version, authority]) };
  }

  function stopWork() {
    seq++;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (tileRetryTimer) { clearTimeout(tileRetryTimer); tileRetryTimer = null; }
    fetcher.cancel();
    tiles.cancel();
    groundAbort?.abort();
    groundAbort = null;
  }

  // Forget everything fetched or drawn for the old lifecycle.
  function invalidate() {
    life++;
    stopWork();
    retries = 0;
    fetcher.clear();
    tiles.clear();
    siteBounds = null; current = null; viewTilesKey = null; count = 0; partial = false; failedTiles = false; tileRetries = 0; tileRetryKey = null; heightNote = ''; heightDraped = false; draped.clear();
    clearDrawings();
  }

  // Outlines for the current parcels: merged by owner, or one per parcel.
  // Worked out once per parcel set and merge choice.
  function outlines() {
    if (!current) return [];
    const mode = merge ? 'merged' : 'raw';
    if (current.outlines?.mode !== mode) current.outlines = { mode, list: dissolveParcelsByOwner(current.parcels, { merge }) };
    return current.outlines.list;
  }

  function drawKey() { return current ? `${current.key}#${current.parcels.length}#${merge ? 'm' : 'r'}` : null; }

  // True when the project or model version changed since the last call.
  // The Hide choice follows the project only, never the version or view.
  function syncLifecycle() {
    const { id, key } = lifecycleKey();
    if (key === lifeKey) return false;
    invalidate();
    lifeKey = key;
    offered = false; source = null; status = 'off';
    if (id !== lifeProject) { lifeProject = id; hidden = hiddenFor(id); }
    return true;
  }

  function ensureSiteBounds() {
    if (siteBounds || !deps.georefVerified()) return;
    const extent = deps.getSceneExtentUtm();
    if (extent) siteBounds = utmExtentToLonLatBounds(extent, deps.utmToLatLon);
  }

  function availability() {
    return propertyLinesAvailability({ offered, georefVerified: deps.georefVerified(), modelBounds: siteBounds, regionLimited: source?.kind !== 'upload' });
  }

  function render() {
    if (!dom.panel) return;
    const panelShown = offered && !suspended;
    dom.panel.hidden = !panelShown;
    if (!panelShown) {
      if (dom.notice) dom.notice.hidden = true;
      if (dom.mergeRow) dom.mergeRow.hidden = true;
      return;
    }
    const on = isOn();
    const av = availability();
    const disabled = !av.available;
    const shown = on && !disabled;
    // The "not a survey" notice on the view belongs to drawn lines only. The
    // card itself is the title and its controls: no count, source or
    // disclaimer text, only a status line while loading or when something
    // needs the viewer (unavailable, zoom in, too many, lines show through).
    const drawn = shown && status === 'ready';
    dom.button.disabled = disabled;
    dom.button.classList.toggle('active', shown);
    dom.button.textContent = shown ? 'Hide' : 'Show';
    dom.button.setAttribute('aria-pressed', String(shown));
    dom.button.setAttribute('aria-label', shown ? 'Hide property lines' : 'Show property lines');
    // The merge choice, where the source has owner names.
    if (dom.mergeRow) dom.mergeRow.hidden = !(shown && source?.owners === 'yes');
    if (dom.merge && dom.merge.checked !== merge) dom.merge.checked = merge;
    let message = disabled ? propertyLinesMessage(av.reason) : (on ? propertyLinesMessage(status, { count, partial, failed: failedTiles, retrying: Boolean(tileRetryTimer), threeD: kind() !== 'map' }) : '');
    if (drawn && kind() !== 'map' && heightNote && !heightDraped) message = [message, heightNote].filter(Boolean).join(' ');
    if (dom.status.textContent !== message) dom.status.textContent = message;
    dom.status.dataset.state = disabled ? av.reason : (on ? status : 'off');
    if (dom.notice) {
      dom.notice.hidden = !drawn;
      if (drawn && source) dom.notice.textContent = `Property lines are approximate, not a survey. Source: ${source.name} ${source.release}.`;
    }
  }

  function clearLabels() {
    labelKey = null;
    if (labelsEl) labelsEl.replaceChildren?.();
  }

  function clearMap() {
    const map = deps.getMap();
    if (mapLayers && map) for (const layer of mapLayers) map.removeLayer(layer);
    mapLayers = null;
    drawnMapKey = null;
    clearLabels();
  }

  // Owner names, with acreage under them, in the middle of each outline, in
  // their own pane above the lines. Laid out again after every move or zoom (hidden while zooming);
  // only labels that fit their outline and clear each other are shown.
  function renderLabels() {
    const map = deps.getMap();
    if (!map || !current || kind() !== 'map' || typeof document === 'undefined'
      || typeof map.latLngToContainerPoint !== 'function' || typeof map.getZoom !== 'function') { clearLabels(); return; }
    if (!labelsEl || labelsMap !== map) {
      let pane = map.getPane('propertyLineLabels');
      if (!pane) {
        pane = map.createPane('propertyLineLabels');
        pane.style.zIndex = 465;
        pane.style.pointerEvents = 'none';
      }
      labelsEl?.remove?.();
      labelsEl = document.createElement('div');
      labelsEl.className = 'property-line-labels';
      pane.appendChild(labelsEl);
      map.on?.('zoomstart', () => { if (labelsEl) labelsEl.style.visibility = 'hidden'; });
      labelsMap = map;
      labelKey = null;
    }
    const zoom = map.getZoom(), size = map.getSize(), center = map.getCenter();
    // Owner totals only once every tile of this view has answered in full. A
    // single parcel (merging off) arrives whole, so its area needs no wait.
    const complete = Boolean(current.complete && !current.failed && !current.partial && current.key === viewTilesKey);
    const units = deps.units?.() === 'metric' ? 'metric' : 'imperial';
    const key = `${drawKey()}|${complete ? 'c' : 'i'}|${units}|${zoom}|${size.x}x${size.y}|${center.lat.toFixed(6)},${center.lng.toFixed(6)}`;
    labelsEl.style.visibility = '';
    if (key === labelKey) return;
    labelKey = key;
    const candidatesKey = `${merge ? 'merged' : 'raw'}|${complete}`;
    if (current.candidates?.key !== candidatesKey) {
      const covered = complete ? bounds => tilesCoverBounds(current.loaded, bounds) : null;
      // Acreage where the source has owners: its shapes are whole parcels. An
      // uploaded boundary file may hold open lines and shows none.
      const acreage = source?.owners === 'yes' ? { merged: merge, covered } : null;
      current.candidates = { key: candidatesKey, list: ownerLabelCandidates(outlines(), { acreage }) };
    }
    const placed = placeOwnerLabels(current.candidates.list, {
      zoom, measure, units, viewport: { width: size.x, height: size.y },
      project: (lon, lat) => { const p = map.latLngToContainerPoint([lat, lon]); return [p.x, p.y]; },
    });
    labelsEl.replaceChildren(...placed.map(label => {
      const node = document.createElement('div');
      node.className = 'property-line-label';
      node.textContent = label.lines.join('\n');   // text only, never HTML
      const point = map.containerPointToLayerPoint([label.x, label.y]);
      Object.assign(node.style, { width: `${label.width + 2}px`, fontSize: `${label.fontPx}px`, lineHeight: `${label.lineHeight}px`,
        transform: `translate(${Math.round(point.x - label.width / 2 - 1)}px, ${Math.round(point.y - label.height / 2)}px)` });
      return node;
    }));
  }

  function clearThree() {
    if (!threeGroup) return;
    threeGroup.parent?.remove(threeGroup);
    threeGroup.traverse(object => { object.geometry?.dispose?.(); object.material?.dispose?.(); });
    threeGroup = null; threeKey = null;
  }

  function clearPotree() {
    potreeKey = null;
    if (!potreeShown) return;
    potreeShown = false;
    const api = deps.getPotreeApi();
    try { api?.setParcelVisibility?.(false); api?.setParcelLines?.([]); } catch { /* iframe unloading */ }
  }

  function clearDrawings() { clearMap(); clearThree(); clearPotree(); }

  // Pending states retry on a timer with one bounded budget. Only a real
  // readiness signal (wake), a new lifecycle or an explicit Show refills it.
  function scheduleRetry() {
    if (retryTimer || !isOn() || retries >= MAX_RETRIES) return;
    retries++;
    retryTimer = setTimeout(() => { retryTimer = null; refresh(); }, RETRY_MS);
  }

  function settle(next) { retries = 0; status = next; render(); }

  function mapViewBounds() {
    const map = deps.getMap();
    if (!map) return null;
    const b = map.getBounds();
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  }

  function drawMap() {
    const map = deps.getMap();
    if (!map || !current) return;
    // Thinner lines when zoomed out, where parcels are dense.
    const thin = typeof map.getZoom === 'function' && map.getZoom() < 15;
    const mapKey = `${drawKey()}#${thin ? 'thin' : 'full'}`;
    if (drawnMapKey === mapKey && mapLayers && mapLayers.every(layer => map.hasLayer(layer))) { renderLabels(); return; }
    clearMap();
    if (!map.getPane('propertyLines')) {
      const pane = map.createPane('propertyLines');
      pane.style.zIndex = 460;            // above ortho/DEM detail tiles (450)
      pane.style.pointerEvents = 'none';
    }
    if (!mapRenderer || rendererMap !== map) {
      mapRenderer = L.canvas({ pane: 'propertyLines', padding: 0.2 });
      rendererMap = map;
    }
    const renderer = mapRenderer;
    const lines = outlines().flatMap(outline => outline.lines.map(line => line.map(([lon, lat]) => [lat, lon])));
    const common = { pane: 'propertyLines', renderer, interactive: false, lineJoin: 'round', lineCap: 'round', smoothFactor: 0.5 };
    mapLayers = [
      L.polyline(lines, { ...common, color: PROPERTY_LINE_STYLE.halo, weight: PROPERTY_LINE_STYLE.mapHaloWeight * (thin ? 0.6 : 1), opacity: 0.55 }),
      L.polyline(lines, { ...common, color: PROPERTY_LINE_STYLE.color, weight: PROPERTY_LINE_STYLE.mapWeight * (thin ? 0.6 : 1), opacity: 1 }),
    ];
    for (const layer of mapLayers) layer.addTo(map);
    drawnMapKey = mapKey;
    renderLabels();
  }

  async function drapedLines(mySeq) {
    const extent = deps.getSceneExtentUtm();
    if (!extent || !Number.isFinite(extent.minAlt)) return null;
    const key = `${drawKey()}|${deps.getMode()}|${extent.minAlt.toFixed(1)}|${extent.maxAlt.toFixed(1)}`;
    if (draped.has(key)) return { key, ...draped.get(key) };
    const { lines, truncated } = parcelsToUtmPolylines(outlines().map(outline => ({ rings: outline.lines })), deps.latLonToUtm);
    if (truncated) return { key, tooMany: true };
    let minE = Infinity, minN = Infinity, maxE = -Infinity, maxN = -Infinity;
    for (const line of lines) for (const [e, n] of line) { minE = Math.min(minE, e); maxE = Math.max(maxE, e); minN = Math.min(minN, n); maxN = Math.max(maxN, n); }
    groundAbort?.abort();
    const abort = groundAbort = new AbortController();
    let grid = null;
    try { grid = lines.length ? await deps.getGroundGrid({ minE, minN, maxE, maxN }, abort.signal) : null; } catch { grid = null; }
    if (mySeq !== seq) return null;
    const value = drapePolylines(lines, { grid, minAlt: extent.minAlt, maxAlt: extent.maxAlt });
    draped.clear();
    draped.set(key, value);
    return { key, ...value };
  }

  function drawThree(result) {
    const scene = deps.getScene();
    if (!scene) return;
    if (threeKey === result.key && threeGroup?.parent === scene) { threeGroup.visible = true; return; }
    clearThree();
    const positions = [];
    for (const line of result.lines) {
      for (let i = 1; i < line.length; i++) {
        const a = deps.utmToWorld(...line[i - 1]), b = deps.utmToWorld(...line[i]);
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    const group = new THREE.Group();
    group.name = 'property-lines';
    group.renderOrder = 5;
    const noRaycast = object => { object.raycast = () => {}; object.frustumCulled = false; return object; };
    const size = new THREE.Vector2();
    const fat = (width, color, opacity, order) => {
      const geometry = new LineSegmentsGeometry();
      geometry.setPositions(positions);
      const material = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, depthWrite: false });
      const line = noRaycast(new LineSegments2(geometry, material));
      line.renderOrder = order;
      line.onBeforeRender = renderer => { renderer.getSize(size); material.resolution.copy(size); };
      return line;
    };
    group.add(fat(PROPERTY_LINE_STYLE.haloWidthPx, PROPERTY_LINE_STYLE.halo, 0.6, 5));
    group.add(fat(PROPERTY_LINE_STYLE.lineWidthPx, PROPERTY_LINE_STYLE.color, 1, 6));
    // Faint copy drawn on top so lines under trees or roofs stay findable.
    const thinGeometry = new THREE.BufferGeometry();
    thinGeometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const thin = noRaycast(new THREE.LineSegments(thinGeometry, new THREE.LineBasicMaterial({ color: PROPERTY_LINE_STYLE.color, transparent: true, opacity: 0.4, depthTest: false, depthWrite: false })));
    thin.renderOrder = 7;
    group.add(thin);
    scene.add(group);
    threeGroup = group; threeKey = result.key;
  }

  function drawPotree(result) {
    const api = deps.getPotreeApi();
    if (!api?.setParcelLines) return false;
    if (potreeKey !== result.key) {
      if (api.setParcelLines(result.lines) < 0) return false;
      potreeKey = result.key;
    }
    api.setParcelVisibility(true);
    potreeShown = true;
    return true;
  }

  function syncVisibility(active) {
    if (threeGroup) threeGroup.visible = isOn() && active === 'three';
    if (mapLayers && active !== 'map') clearMap();
    if (active !== 'potree') clearPotree();
  }

  async function refresh({ immediate = false } = {}) {
    // A new project or model version first needs its own offer.
    if (syncLifecycle()) { render(); void loadOffer(); return; }
    ensureSiteBounds();
    const active = kind();
    syncVisibility(active);
    if (!isOn()) { stopWork(); clearDrawings(); status = 'off'; render(); return; }
    const av = availability();
    if (!av.available) { stopWork(); clearDrawings(); settle(av.reason); return; }
    // A view without a drawing surface shows nothing and waits for the next view change.
    if (!active) { stopWork(); clearDrawings(); settle('idle'); return; }
    if (av.reason === 'pending') { status = 'pending'; render(); scheduleRetry(); return; }
    const myLife = life, myKey = lifeKey;
    const mySeq = ++seq;
    // Also compare the live project/version/authority, in case it changed without a sync yet.
    const stillCurrent = () => mySeq === seq && myLife === life && myKey === lifecycleKey().key;
    if (active === 'map') return refreshMap({ immediate, stillCurrent });
    // Map tiles' retry state belongs to the map view only.
    failedTiles = false;
    if (tileRetryTimer) { clearTimeout(tileRetryTimer); tileRetryTimer = null; }
    const request = propertyLinesRequestBounds({ modelBounds: siteBounds, viewBounds: null });
    if (request.status !== 'ok') {
      fetcher.cancel(); clearDrawings();
      if (request.status === 'unknown') { status = 'pending'; render(); scheduleRetry(); } else settle(request.status);
      return;
    }
    const key = `site:${boundsKey(request.bounds)}`;
    if (!(current && current.key === key)) { status = 'loading'; render(); }
    const result = current && current.key === key ? { status: 'ok', parcels: current.parcels } : await fetcher.request(request.bounds, { immediate });
    if (result.status === 'aborted' || !stillCurrent() || !isOn()) { if (lifeKey !== lifecycleKey().key) void refresh(); return; }
    if (result.status !== 'ok') { clearDrawings(); current = null; count = 0; partial = false; settle(result.status); return; }
    if (!(current && current.key === key)) current = { key, parcels: result.parcels };
    count = result.parcels.length; partial = false;
    status = 'loading'; render();
    const lines = await drapedLines(mySeq);
    if (!stillCurrent() || !isOn()) { if (lifeKey !== lifecycleKey().key) void refresh(); return; }
    if (!lines) { status = 'pending'; render(); scheduleRetry(); return; }
    if (lines.tooMany) { clearDrawings(); settle('too_many'); return; }
    heightNote = lines.note; heightDraped = lines.draped === true;
    if (active === 'three') drawThree(lines);
    else if (!drawPotree(lines)) { status = 'pending'; render(); scheduleRetry(); return; }
    settle('ready');
  }

  // Map views: the tiles covering the visible map near the model. Lines from
  // the previous view stay until the new tiles arrive; tiles are drawn as
  // they come in, and already-cached tiles draw at once.
  async function refreshMap({ immediate, stillCurrent }) {
    const map = deps.getMap();
    const zoom = typeof map?.getZoom === 'function' ? map.getZoom() : null;
    const plan = propertyLinesTilesForView({ modelBounds: siteBounds, viewBounds: mapViewBounds(), zoom });
    if (plan.status !== 'ok') {
      tiles.cancel(); clearDrawings(); current = null; count = 0; partial = false; failedTiles = false;
      if (plan.status === 'unknown') { status = 'pending'; render(); scheduleRetry(); } else settle(plan.status);
      return;
    }
    const key = `tiles:${plan.tiles.map(tile => tile.key).join(';')}`;
    viewTilesKey = key;
    if (key !== tileRetryKey) { tileRetryKey = key; tileRetries = 0; }
    if (current && current.key === key && current.complete && !current.failed) {
      tiles.cancel();
      drawMap(); settle('ready'); return;
    }
    if (status !== 'ready' || !current) { status = 'loading'; render(); }
    // Lay the names out for the new view now; the new tiles redraw them as they arrive.
    renderLabels();
    const onProgress = parcels => {
      if (!stillCurrent() || !isOn() || !parcels.length) return;
      current = { key, parcels, complete: false };
      drawMap();
    };
    const result = await tiles.load(plan.tiles, { area: plan.area, immediate: immediate || tiles.cached(plan.tiles), onProgress });
    if (result.status === 'aborted' || !stillCurrent() || !isOn()) { if (lifeKey !== lifecycleKey().key) void refresh(); return; }
    if (result.status !== 'ok') { clearDrawings(); current = null; count = 0; partial = false; failedTiles = false; settle(result.status); return; }
    current = { key, parcels: result.parcels, complete: true, failed: Boolean(result.failed), partial: Boolean(result.partial || plan.partial), loaded: new Set(result.loaded || []) };
    count = result.parcels.length;
    partial = Boolean(result.partial || plan.partial);
    failedTiles = Boolean(result.failed);
    if (tileRetryTimer) { clearTimeout(tileRetryTimer); tileRetryTimer = null; }
    if (!failedTiles) tileRetries = 0;
    else if (tileRetries < TILE_RETRIES) {
      // Ask again for the tiles that failed; the ones already answered come from the cache.
      const wait = Math.min(TILE_RETRY_MAX_MS, TILE_RETRY_MS * 2 ** tileRetries);
      tileRetries++;
      tileRetryTimer = setTimeout(() => { tileRetryTimer = null; void refresh(); }, wait);
    }
    drawMap();
    settle('ready');
  }

  // "Merge parcels by owner": redraws from the parcels already fetched.
  function setMerge(value) {
    const next = value !== false;
    if (next === merge) return;
    merge = next;
    try { preferences.setMerged?.(merge); } catch { /* kept for this page */ }
    draped.clear();
    clearDrawings();
    if (isOn()) refresh({ immediate: true }); else render();
  }

  function toggle() {
    syncLifecycle();
    if (!offered || suspended || !availability().available) return;
    hidden = !hidden;
    rememberHidden(lifeProject, hidden);
    retries = 0;
    if (hidden) { stopWork(); clearDrawings(); status = 'off'; render(); return; }
    refresh({ immediate: true });
  }

  // Ask whether the layer is offered only when it can matter: a model with a
  // verified UTM georeference. Otherwise no request is made and the panel
  // stays hidden. Any failure degrades silently to "no layer". An answer that
  // arrives after the project, version or access changed is dropped unseen.
  async function loadOffer() {
    syncLifecycle();
    const mine = ++offerSeq, myLife = life, myKey = lifeKey;
    const stale = () => mine !== offerSeq || myLife !== life || myKey !== lifecycleKey().key;
    if (suspended || !deps.projectId() || !deps.georefVerified()) { offered = false; source = null; refresh(); return; }
    let nextOffered = false, nextSource = null;
    try {
      const response = await deps.fetchImpl(`/api/v1/property-lines?model=${encodeURIComponent(deps.projectId() || '')}`, { headers: deps.headers(), credentials: 'same-origin', cache: 'no-store' });
      if (stale()) return;
      const body = response.ok ? await response.json() : null;
      nextOffered = body?.offered === true && Boolean(body.source);
      // Plain strings only; they are shown with textContent, never as HTML.
      nextSource = nextOffered ? Object.fromEntries(['kind', 'name', 'release', 'credit', 'disclaimer', 'datumNote', 'datum', 'region', 'owners']
        .filter(key => typeof body.source[key] === 'string').map(key => [key, body.source[key].slice(0, 600)])) : null;
    } catch { nextOffered = false; nextSource = null; }
    if (stale()) return;
    offered = nextOffered; source = nextSource;
    retries = 0;
    refresh();
  }

  // Access lost (session expired or revoked): drop the offer, the cache and
  // everything drawn. The Hide choice is kept.
  function suspend() {
    if (suspended) return;
    suspended = true;
    invalidate();
    offered = false; source = null; status = 'off';
    render();
  }

  // Access restored: ask for the offer again under the new access.
  function resume() {
    if (!suspended) return Promise.resolve();
    suspended = false;
    return loadOffer();
  }

  // The page accepted new session or project details: when the project,
  // model version or authority changed, drop everything from the old one at
  // once and ask for the new offer. The same context is a no-op.
  function sync() {
    if (!syncLifecycle()) return Promise.resolve();
    render();
    return loadOffer();
  }

  // The current view became ready (tiles, point cloud or raster loaded):
  // refill the pending retry budget and try again. Never changes Hide.
  function wake() {
    retries = 0;
    return refresh();
  }

  dom.button?.addEventListener('click', toggle);
  dom.merge?.addEventListener?.('change', () => setMerge(dom.merge.checked));

  return {
    loadOffer,
    refresh,
    toggle,
    setMerge,
    wake,
    sync,
    suspend,
    resume,
    get state() {
      return { offered, on: isOn(), hidden, suspended, status, count, partial, failedTiles, tileRetries, retryingTiles: Boolean(tileRetryTimer), merge, outlines: current ? outlines().length : 0,
        labels: labelsEl?.childElementCount ?? 0, siteBounds, heightNote, retries,
        drawn: { map: Boolean(mapLayers), three: Boolean(threeGroup?.visible), potree: potreeShown } };
    },
    stats: () => ({ ...fetcher.stats(), tiles: tiles.stats() }),
    /** Outlines as drawn on the map, for picking: { key, owner, rings: [[lon, lat], ...][] }. */
    selectableParcels: () => (isOn() && mapLayers ? outlines() : []).map((outline, i) => ({
      key: outline.parcelIds.length ? `id:${outline.parcelIds.join('+')}` : `o:${outline.ownerKey || ''}#${i}`,
      owner: outline.owner, rings: outline.parcels.flatMap(parcel => parcel.rings),
    })),
  };
}
