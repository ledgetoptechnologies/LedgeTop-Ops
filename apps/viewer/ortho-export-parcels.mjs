// Parcel picking for "Selected parcels" exports: click parcels on the map
// to toggle them; the export is cropped to their outline.

/** Even-odd point-in-polygon over a parcel's rings ([[lon, lat], ...]). */
export function pointInParcel(lon, lat, rings) {
  let inside = false;
  for (const ring of rings || []) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** The smallest parcel under a point (nested or overlapping records pick the inner one). */
export function parcelAt(parcels, lon, lat) {
  let best = null, bestArea = Infinity;
  for (const parcel of parcels || []) {
    if (!pointInParcel(lon, lat, parcel.rings)) continue;
    let area = 0;
    for (const ring of parcel.rings) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) area += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    area = Math.abs(area);
    if (area < bestArea) { best = parcel; bestArea = area; }
  }
  return best;
}

/**
 * Map picking. `getParcels()` → [{ key, owner, rings }] in lon/lat, as drawn.
 * `pick()` resolves once the person presses Done (or Esc).
 */
export function createParcelPicker({ L, getMap, getParcels, documentRef = document, host, onChange = () => {} }) {
  const selected = new Map(); // key -> parcel
  let layer = null, active = null, scope = null;
  const el = (tag, props = {}, children = []) => { const n = documentRef.createElement(tag); Object.assign(n, props); n.append(...children); return n; };

  function draw() {
    const map = getMap();
    layer?.remove(); layer = null;
    if (!map || !selected.size) return;
    if (!map.getPane('exportParcels')) { const pane = map.createPane('exportParcels'); pane.style.zIndex = 465; pane.style.pointerEvents = 'none'; }
    const shapes = [...selected.values()].map(p => p.rings.map(ring => ring.map(([lon, lat]) => [lat, lon])));
    layer = L.polygon(shapes, { pane: 'exportParcels', interactive: false, color: '#ee5007', weight: 3, fillColor: '#ee5007', fillOpacity: 0.22, fillRule: 'evenodd' }).addTo(map);
  }

  function label() { return selected.size === 1 ? '1 parcel' : `${selected.size} parcels`; }

  // One picking session at a time. It owns what it set up (the map it
  // listened on, its bar and key handler) and tears down exactly that, even
  // if the map has been replaced since.
  function finish() {
    if (!active) return;
    const own = active; active = null;
    own.map.off('click', own.click);
    own.map.getContainer?.().classList.remove('oe-picking');
    documentRef.removeEventListener('keydown', own.key, true);
    own.bar.remove();
    own.resolve(selected.size);
  }

  function pick() {
    if (active) return active.promise;
    const map = getMap();
    if (!map) return Promise.resolve(selected.size);
    draw();
    const count = el('strong', { textContent: label() });
    const clear = el('button', { type: 'button', className: 'oe-bar-btn', textContent: 'Clear' });
    const done = el('button', { type: 'button', className: 'oe-bar-btn oe-bar-done', textContent: 'Done' });
    const own = { map, bar: el('div', { className: 'oe-pick-bar', role: 'toolbar' }, [count, clear, done]) };
    own.bar.setAttribute('aria-label', 'Select parcels');
    own.promise = new Promise((resolve) => { own.resolve = resolve; });
    const update = () => { count.textContent = label(); draw(); onChange(selected.size); };
    clear.onclick = () => { if (active !== own) return; selected.clear(); update(); };
    done.onclick = () => { if (active === own) finish(); };
    own.click = (event) => {
      if (active !== own) return;
      const parcel = parcelAt(getParcels(), event.latlng.lng, event.latlng.lat);
      if (!parcel) return;
      if (selected.has(parcel.key)) selected.delete(parcel.key); else selected.set(parcel.key, parcel);
      update();
    };
    own.key = (event) => { if (active === own && (event.key === 'Escape' || event.key === 'Enter')) { event.preventDefault(); event.stopPropagation(); finish(); } };
    active = own;
    host.append(own.bar);
    map.on('click', own.click);
    map.getContainer?.().classList.add('oe-picking');
    documentRef.addEventListener('keydown', own.key, true);
    done.focus();
    return own.promise;
  }

  return {
    pick,
    finish,
    get count() { return selected.size; },
    get picking() { return Boolean(active); },
    /** Selected parcels' rings ([[lon, lat], ...] per ring), one array per parcel. */
    rings: () => [...selected.values()].map(p => p.rings),
    show: draw,
    hide() { layer?.remove(); layer = null; },
    /** Drop the selection when the model, version or access changes. */
    reset(nextScope) { if (nextScope === scope) return; scope = nextScope; finish(); selected.clear(); layer?.remove(); layer = null; },
    /** Keep only parcels still offered (parcels reload when lines are merged or reloaded). */
    prune() { const keys = new Set(getParcels().map(p => p.key)); for (const k of [...selected.keys()]) if (!keys.has(k)) selected.delete(k); },
  };
}
