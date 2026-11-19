// Property lines layer controller: one "Property lines" toggle that draws the
// same parcel outlines on the Leaflet map views, in the three.js 3D views and
// in the Potree point cloud. Main.js supplies everything model-specific.
import {
  boundsKey,
  createParcelFetcher,
  groundHeightsConsistent,
  parcelsToUtmPolylines,
  propertyLinesAvailability,
  propertyLinesDatumNote,
  propertyLinesMessage,
  propertyLinesRequestBounds,
  sampleGrid,
  utmExtentToLonLatBounds,
} from './property-lines.mjs';

export const PROPERTY_LINE_STYLE = Object.freeze({
  color: '#FFD60A',
  halo: '#111111',
  mapWeight: 2.5,
  mapHaloWeight: 5,
  lineWidthPx: 2.5,
  haloWidthPx: 5,
  liftMeters: 0.2,
});

const RETRY_MS = 1500;
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

export function createPropertyLinesController(deps) {
  const { L, THREE, LineSegments2, LineSegmentsGeometry, LineMaterial, dom } = deps;
  const fetcher = createParcelFetcher({ fetchImpl: deps.fetchImpl, headers: deps.headers, model: () => deps.projectId(), ...(deps.fetcherOptions || {}) });
  let offered = false, source = null, on = false, status = 'off', count = 0;
  let siteBounds = null, siteProject = null, retryTimer = null, retries = 0, seq = 0;
  // One canvas renderer per Leaflet map, reused for every redraw.
  let mapRenderer = null, rendererMap = null, drawnMapKey = null;
  let current = null, mapLayers = null, threeGroup = null, threeKey = null, potreeKey = null, heightNote = '', groundAbort = null;
  const draped = new Map();

  function kind() { return propertyLinesModeKind(deps.getMode(), deps.getCloudMode()); }

  function resetForProject() {
    const id = deps.projectId();
    if (siteProject === id) return;
    siteProject = id; siteBounds = null; current = null; draped.clear(); clearDrawings();
  }

  function ensureSiteBounds() {
    resetForProject();
    if (siteBounds || !deps.georefVerified()) return;
    const extent = deps.getSceneExtentUtm();
    if (extent) siteBounds = utmExtentToLonLatBounds(extent, deps.utmToLatLon);
  }

  function availability() {
    return propertyLinesAvailability({ offered, georefVerified: deps.georefVerified(), modelBounds: siteBounds });
  }

  function render() {
    if (!dom.panel) return;
    dom.panel.hidden = !offered;
    if (!offered) { if (dom.notice) dom.notice.hidden = true; return; }
    const av = availability();
    const disabled = !av.available;
    dom.button.disabled = disabled;
    dom.button.classList.toggle('active', on && !disabled);
    dom.button.textContent = on && !disabled ? 'Hide' : 'Show';
    dom.button.setAttribute('aria-pressed', String(on && !disabled));
    dom.button.setAttribute('aria-label', on && !disabled ? 'Hide property lines' : 'Show property lines');
    const shown = on && !disabled;
    let message = disabled ? propertyLinesMessage(av.reason) : (on ? propertyLinesMessage(status, { count, threeD: kind() !== 'map' }) : '');
    if (shown && status === 'ready' && kind() !== 'map' && heightNote) message += ` ${heightNote}`;
    if (dom.status.textContent !== message) dom.status.textContent = message;
    dom.status.dataset.state = disabled ? av.reason : (on ? status : 'off');
    if (dom.about) dom.about.hidden = !shown;
    if (shown && source && dom.about) {
      dom.about.querySelector('[data-pl="source"]').textContent = `${source.name}, release ${source.release}. ${source.credit}`;
      dom.about.querySelector('[data-pl="disclaimer"]').textContent = [source.disclaimer, propertyLinesDatumNote(deps.modelDatum?.(), source.datum) || source.datumNote].filter(Boolean).join(' ');
    }
    if (dom.notice) {
      dom.notice.hidden = !shown;
      if (shown && source) dom.notice.textContent = `Property lines are approximate, not a survey. Source: ${source.name} ${source.release}.`;
    }
  }

  function clearMap() {
    const map = deps.getMap();
    if (mapLayers && map) for (const layer of mapLayers) map.removeLayer(layer);
    mapLayers = null;
    drawnMapKey = null;
  }

  function clearThree() {
    if (!threeGroup) return;
    threeGroup.parent?.remove(threeGroup);
    threeGroup.traverse(object => { object.geometry?.dispose?.(); object.material?.dispose?.(); });
    threeGroup = null; threeKey = null;
  }

  function clearPotree() {
    const api = deps.getPotreeApi();
    try { api?.setParcelVisibility?.(false); api?.setParcelLines?.([]); } catch { /* iframe unloading */ }
    potreeKey = null;
  }

  function clearDrawings() { clearMap(); clearThree(); clearPotree(); }

  function scheduleRetry() {
    if (retryTimer || !on || retries >= MAX_RETRIES) return;
    retries++;
    retryTimer = setTimeout(() => { retryTimer = null; refresh(); }, RETRY_MS);
  }

  function mapViewBounds() {
    const map = deps.getMap();
    if (!map) return null;
    const b = map.getBounds();
    return { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  }

  function drawMap() {
    const map = deps.getMap();
    if (!map || !current) return;
    if (drawnMapKey === current.key && mapLayers && mapLayers.every(layer => map.hasLayer(layer))) return;
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
    const rings = current.parcels.flatMap(parcel => parcel.rings.map(ring => ring.map(([lon, lat]) => [lat, lon])));
    const common = { pane: 'propertyLines', renderer, interactive: false, lineJoin: 'round', lineCap: 'round', smoothFactor: 0.5 };
    mapLayers = [
      L.polyline(rings, { ...common, color: PROPERTY_LINE_STYLE.halo, weight: PROPERTY_LINE_STYLE.mapHaloWeight, opacity: 0.55 }),
      L.polyline(rings, { ...common, color: PROPERTY_LINE_STYLE.color, weight: PROPERTY_LINE_STYLE.mapWeight, opacity: 1 }),
    ];
    for (const layer of mapLayers) layer.addTo(map);
    drawnMapKey = current.key;
  }

  async function drapedLines(mySeq) {
    const extent = deps.getSceneExtentUtm();
    if (!extent || !Number.isFinite(extent.minAlt)) return null;
    const key = `${current.key}|${deps.getMode()}|${extent.minAlt.toFixed(1)}|${extent.maxAlt.toFixed(1)}`;
    if (draped.has(key)) return { key, ...draped.get(key) };
    const { lines, truncated } = parcelsToUtmPolylines(current.parcels, deps.latLonToUtm);
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
    return true;
  }

  function syncVisibility(active) {
    if (threeGroup) threeGroup.visible = on && active === 'three';
    if (mapLayers && active !== 'map') clearMap();
    if (active !== 'potree') potreeKey = null;
  }

  async function refresh({ immediate = false } = {}) {
    ensureSiteBounds();
    const active = kind();
    syncVisibility(active);
    if (!on) { render(); return; }
    const av = availability();
    if (!av.available) { fetcher.cancel(); clearDrawings(); status = av.reason; render(); return; }
    if (av.reason === 'pending' || !active) { status = 'pending'; render(); scheduleRetry(); return; }
    retries = 0;
    const request = propertyLinesRequestBounds({ modelBounds: siteBounds, viewBounds: active === 'map' ? mapViewBounds() : null });
    const mySeq = ++seq;
    if (request.status !== 'ok') {
      fetcher.cancel(); clearDrawings(); status = request.status === 'unknown' ? 'pending' : request.status; render();
      if (request.status === 'unknown') scheduleRetry();
      return;
    }
    const key = boundsKey(request.bounds);
    if (!(current && current.key === key)) { status = 'loading'; render(); }
    const result = current && current.key === key ? { status: 'ok', parcels: current.parcels } : await fetcher.request(request.bounds, { immediate });
    if (result.status === 'aborted' || mySeq !== seq || !on) return;
    if (result.status !== 'ok') { clearDrawings(); current = null; count = 0; status = result.status; render(); return; }
    current = { key, parcels: result.parcels };
    count = result.parcels.length;
    if (active === 'map') { drawMap(); status = 'ready'; render(); return; }
    status = 'loading'; render();
    const lines = await drapedLines(mySeq);
    if (mySeq !== seq || !on) return;
    if (!lines) { status = 'pending'; render(); scheduleRetry(); return; }
    if (lines.tooMany) { clearDrawings(); status = 'too_many'; render(); return; }
    heightNote = lines.note;
    if (active === 'three') drawThree(lines);
    else if (!drawPotree(lines)) { status = 'pending'; render(); scheduleRetry(); return; }
    status = 'ready';
    render();
  }

  function toggle() {
    if (!availability().available) return;
    on = !on;
    retries = 0;
    if (!on) { seq++; fetcher.cancel(); groundAbort?.abort(); clearDrawings(); status = 'off'; render(); return; }
    refresh({ immediate: true });
  }

  async function loadOffer() {
    try {
      const response = await deps.fetchImpl(`/api/v1/property-lines?model=${encodeURIComponent(deps.projectId() || '')}`, { headers: deps.headers(), credentials: 'same-origin', cache: 'no-store' });
      const body = response.ok ? await response.json() : null;
      offered = body?.offered === true && Boolean(body.source);
      source = offered ? body.source : null;
    } catch { offered = false; source = null; }
    refresh();
  }

  dom.button?.addEventListener('click', toggle);

  return {
    loadOffer,
    refresh,
    toggle,
    get state() { return { offered, on, status, count, siteBounds, heightNote }; },
    stats: () => fetcher.stats(),
  };
}
