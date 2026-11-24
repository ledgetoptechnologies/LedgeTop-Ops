import { FAR_OUT_ZOOM, areaGlyph, mapPin, mapStroke, safeColor } from './viewer-mark-style.mjs';

// Leaflet view of marks. The store is the source of truth: this layer follows it
// and reports clicks back. Only the open draft moves, and only while it is
// movable; its position is written when the person saves. Labels are DOM text,
// never HTML, because people type them.
//
// What is drawn is kept by mark id and changed in place, so a pin keeps its
// element (and keyboard focus) while anything else on the map changes.
const latLng = ([lon, lat]) => [lat, lon];
const toPosition = ({ lat, lng }) => [Math.round(lng * 1e8) / 1e8, Math.round(lat * 1e8) / 1e8];
const DRAFT = '__draft__';
const STEPS = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

export function markPositions(geometry) {
  if (geometry.type === 'Point') return [geometry.coordinates];
  if (geometry.type === 'LineString') return geometry.coordinates;
  return geometry.coordinates[0].slice(0, -1);
}

export function geometryFrom(type, positions) {
  if (type === 'Point') return { type, coordinates: positions[0] };
  if (type === 'LineString') return { type, coordinates: positions };
  return { type, coordinates: [[...positions, positions[0]]] };
}

// The middle of an area by its shape, so the glyph does not sit on one corner of it.
export function areaCentre(positions) {
  const [x0, y0] = positions[0];
  let twice = 0, x = 0, y = 0;
  positions.forEach(([ax, ay], i) => {
    const [bx, by] = positions[(i + 1) % positions.length];
    const cross = (ax - x0) * (by - y0) - (bx - x0) * (ay - y0);
    twice += cross;
    x += (ax - x0 + bx - x0) * cross;
    y += (ay - y0 + by - y0) * cross;
  });
  return Math.abs(twice) < 1e-16 ? positions[0] : [x0 + x / (3 * twice), y0 + y / (3 * twice)];
}

export function createMarkMapLayer({ L, getMap, onSelect = () => {}, onDraftMove = () => {}, describe = mark => mark.name }) {
  let group = null, overlay = null, previewLine = null, attachedMap = null, last = null, far = false;
  // One tab stop for all pins: the last one focused, else the first.
  let tabStop = null;
  const items = new Map(); // mark id -> { kind, signature, marker | layers }

  function label(map, text) {
    const span = map.getContainer().ownerDocument.createElement('span');
    span.textContent = text;
    return span;
  }
  // A mark's name on hover and focus is bound once and renamed in place: Leaflet adds
  // listeners to the element each time one is bound and never takes them off. A label
  // that stays on the map is a layer of its own, which focus and blur do not close.
  // A pin being placed has no name here; it is in the editor.
  const LABEL = { direction: 'top', className: 'viewer-mark-label', interactive: false };
  function setLabel(map, item, layer, mark, offset) {
    if (!item.hover) {
      layer.bindTooltip(label(map, mark.name), { ...LABEL, permanent: false, offset });
      // After it has finished opening, not in the middle of it.
      layer.on('tooltipopen', () => { if (item.kept) queueMicrotask(() => { if (item.kept) layer.closeTooltip(); }); });
      item.hover = layer;
    } else {
      layer.setTooltipContent(label(map, mark.name));
      layer.getTooltip().options.offset = offset;
    }
  }
  function keepLabel(map, item, show, { at, text, offset }) {
    if (!show) {
      if (item.kept) group.removeLayer(item.kept);
      item.kept = null;
      return;
    }
    if (!item.kept) item.hover.closeTooltip();
    else item.kept.options.offset = offset;
    const kept = item.kept || L.tooltip({ ...LABEL, permanent: true, offset });
    kept.setLatLng(latLng(at));
    kept.setContent(label(map, text));
    if (!item.kept) kept.addTo(group);
    item.kept = kept;
  }

  function removeItem(id) {
    const item = items.get(id);
    // Nothing a marker or its element listens to outlives it.
    item.listeners?.abort();
    if (item.kept) group.removeLayer(item.kept);
    for (const layer of item.layers || [item.marker]) {
      layer.unbindTooltip?.();
      group.removeLayer(layer);
      layer.off();
    }
    items.delete(id);
  }

  // ---- points ----------------------------------------------------------------
  function pinKeys(event, id) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      onSelect(id);
      return;
    }
    const step = STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation(); // the map pans with the arrow keys
    const order = pinOrder(), index = order.indexOf(id);
    const next = order[(index + step + order.length) % order.length];
    tabStop = next;
    syncTabStops();
    items.get(next)?.marker.getElement()?.focus();
  }
  // A pin not saved yet has nothing to open, so it is not among them.
  const pinOrder = () => [...items].filter(([id, item]) => item.kind === 'pin' && item.interactive && id !== DRAFT).map(([id]) => id);
  function syncTabStops() {
    const order = pinOrder();
    const current = order.includes(tabStop) ? tabStop : order[0];
    for (const id of order) {
      const element = items.get(id).marker.getElement();
      if (element) element.tabIndex = id === current ? 0 : -1;
    }
  }

  function drawPin(map, id, mark, { selected, draft, movable, labels, interactive }) {
    // An open mark looks selected; one not saved yet is dashed.
    const look = { selected: selected && id !== DRAFT, draft: id === DRAFT, far };
    const signature = JSON.stringify([mark.geometry.coordinates, mark.name, mark.color, mark.icon, look, movable, labels, describe(mark)]);
    let item = items.get(id);
    // A marker that does not take clicks (while drawing) is a different marker.
    if (item && (item.kind !== 'pin' || item.interactive !== interactive)) { removeItem(id); item = null; }
    if (item?.signature === signature) return;
    const { html, size, anchor, labelOffset } = mapPin(mark, look);
    const icon = L.divIcon({ className: 'viewer-map-mark' + (look.selected ? ' selected' : '') + (look.draft ? ' draft' : ''), html, iconSize: size, iconAnchor: anchor });
    const position = latLng(mark.geometry.coordinates);
    if (!item) {
      const keyboard = interactive && id !== DRAFT, listeners = new AbortController();
      const marker = L.marker(position, { icon, draggable: movable, interactive, keyboard, autoPan: true }).addTo(group);
      item = { kind: 'pin', interactive, marker, listeners };
      items.set(id, item);
      marker.on('dragend', () => { if (item.movable) onDraftMove({ type: 'Point', coordinates: toPosition(marker.getLatLng()) }); });
      // Clicking the pin being placed is not a click on the map under it.
      if (interactive) marker.on('click', event => { L.DomEvent.stop(event); if (id !== DRAFT) onSelect(id); });
      if (keyboard) {
        const element = marker.getElement(), { signal } = listeners;
        element?.addEventListener('keydown', event => pinKeys(event, id), { signal });
        element?.addEventListener('focus', () => { tabStop = id; syncTabStops(); }, { signal });
      }
    } else {
      item.marker.setLatLng(position);
      item.marker.setIcon(icon);
    }
    item.movable = movable;
    item.marker.dragging?.[movable ? 'enable' : 'disable']();
    // Selected is always on top; otherwise Leaflet puts southern pins over northern ones.
    item.marker.setZIndexOffset(selected || draft ? 10_000 : 0);
    item.marker.getElement()?.setAttribute('aria-label', describe(mark));
    if (id !== DRAFT) {
      setLabel(map, item, item.marker, mark, labelOffset);
      keepLabel(map, item, labels && !draft, { at: mark.geometry.coordinates, text: mark.name, offset: labelOffset });
    }
    item.signature = signature;
  }

  // ---- lines and areas ---------------------------------------------------------
  function vertexHandles(map, mark, shapes, layers) {
    const positions = markPositions(mark.geometry).map(p => [...p]);
    positions.forEach((position, index) => {
      const handle = L.marker(latLng(position), { draggable: true, keyboard: false, zIndexOffset: 11_000,
        icon: L.divIcon({ className: 'viewer-mark-vertex', iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(group);
      layers.push(handle);
      handle.on('drag', () => {
        positions[index] = toPosition(handle.getLatLng());
        for (const shape of shapes) shape.setLatLngs(positions.map(latLng));
      });
      handle.on('dragend', () => onDraftMove(geometryFrom(mark.geometry.type, positions)));
    });
  }

  function drawShape(map, id, mark, { selected, draft, movable, labels, interactive }) {
    const signature = JSON.stringify([mark.geometry, mark.name, mark.color, mark.icon, selected, draft, movable, labels, interactive]);
    const item = items.get(id);
    if (item?.kind === 'shape' && item.signature === signature) return;
    if (item) removeItem(id);
    const area = mark.geometry.type === 'Polygon', positions = markPositions(mark.geometry);
    const make = (style, options) => (area ? L.polygon : L.polyline)(positions.map(latLng), { ...style, ...options });
    const { casing, line } = mapStroke(mark, { selected });
    const shapes = [make(casing, { interactive: false, fill: false }), make(line, { interactive, bubblingMouseEvents: false })];
    const layers = shapes.map(shape => shape.addTo(group));
    if (area) {
      const { html, size, anchor } = areaGlyph(mark);
      layers.push(L.marker(latLng(areaCentre(positions)), { interactive: false, keyboard: false, zIndexOffset: -1000,
        icon: L.divIcon({ className: 'viewer-map-area', html, iconSize: size, iconAnchor: anchor }) }).addTo(group));
    }
    if (interactive && id !== DRAFT) shapes[1].on('click', event => { L.DomEvent.stop(event); onSelect(id); });
    const made = { kind: 'shape', signature, layers };
    if (id !== DRAFT) {
      setLabel(map, made, shapes[1], mark, [0, 0]);
      keepLabel(map, made, labels && !draft, { at: area ? areaCentre(positions) : positions[0], text: mark.name, offset: [0, 0] });
    }
    if (movable && interactive) vertexHandles(map, mark, shapes, layers);
    items.set(id, made);
  }

  const draw = (map, id, mark, options) => (mark.geometry.type === 'Point' ? drawPin : drawShape)(map, id, mark, options);

  // ---- attach ------------------------------------------------------------------
  function zoomed() {
    const next = attachedMap.getZoom() < FAR_OUT_ZOOM;
    if (next === far) return;
    far = next;
    if (last) render(last);
  }

  function attach(map) {
    if (attachedMap === map) return;
    detach();
    attachedMap = map;
    group = L.layerGroup().addTo(map);
    overlay = L.layerGroup().addTo(map);
    far = map.getZoom() < FAR_OUT_ZOOM;
    map.on('mousemove', preview);
    map.on('zoomend', zoomed);
  }

  function detach() {
    if (!attachedMap) return;
    attachedMap.off('mousemove', preview);
    attachedMap.off('zoomend', zoomed);
    for (const id of [...items.keys()]) removeItem(id);
    for (const layers of [group, overlay]) { layers.clearLayers(); layers.remove(); }
    group = null;
    overlay = null;
    previewLine = null;
    attachedMap = null;
  }

  function preview(event) {
    const drawing = last?.drawing;
    if (!drawing?.positions.length || !previewLine) return;
    previewLine.setLatLngs([latLng(drawing.positions.at(-1)), event.latlng]);
  }

  function drawOverlay(next) {
    overlay.clearLayers();
    previewLine = null;
    if (next.preview) {
      L.circleMarker(latLng(next.preview), { radius: 9, color: '#ffffff', weight: 2, dashArray: '3 3', fillOpacity: 0, interactive: false }).addTo(overlay);
    }
    if (!next.drawing) return;
    const { type, positions } = next.drawing;
    const color = safeColor(next.drawing.color);
    if (positions.length >= 2) {
      (type === 'Polygon' && positions.length >= 3 ? L.polygon : L.polyline)(positions.map(latLng),
        { color, weight: 3, dashArray: '6 4', fillOpacity: 0.15, interactive: false }).addTo(overlay);
    }
    for (const position of positions) L.circleMarker(latLng(position), { radius: 4, color, weight: 2, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(overlay);
    if (positions.length) previewLine = L.polyline([latLng(positions.at(-1)), latLng(positions.at(-1))], { color, weight: 2, dashArray: '2 6', interactive: false }).addTo(overlay);
  }

  function render(next) {
    last = next;
    const map = getMap();
    if (!map || !next.visible) { detach(); return; }
    attach(map);
    const interactive = !next.drawing, draft = next.draft?.geometry ? next.draft : null;
    const marks = new Map(next.marks.map(mark => [mark.id, mark]));
    if (draft) marks.set(draft.id, draft);
    for (const id of [...items.keys()]) if (!marks.has(id)) removeItem(id);
    for (const [id, mark] of marks) {
      draw(map, id, mark, { selected: mark === draft || id === next.selectedId, draft: mark === draft,
        movable: mark === draft && interactive && Boolean(draft.movable), labels: next.labels, interactive });
    }
    syncTabStops();
    drawOverlay(next);
  }

  return {
    render,
    focus(geometry) {
      const map = getMap();
      if (!map) return;
      const positions = markPositions(geometry).map(latLng);
      if (positions.length === 1) map.setView(positions[0], Math.max(map.getZoom() || 0, 18));
      else map.fitBounds(L.latLngBounds(positions), { maxZoom: 20, padding: [40, 40] });
    },
    dispose: detach,
  };
}
