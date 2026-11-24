import { FAR_OUT_ZOOM, areaGlyph, groupPlate, mapPin, mapStroke, safeColor } from './viewer-mark-style.mjs';

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
// Pins closer than this on the screen are drawn as one plate.
export const GROUP_PX = 24;
const GROUP = 'group:';
const LABEL_LIMIT = 400;
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

// Points within GROUP_PX of one another, in a fixed order so the same marks always
// make the same groups. Each point is in one group at most.
export function groupPoints(points, distance = GROUP_PX) {
  const cells = new Map(), cell = ({ x, y }) => [Math.floor(x / distance), Math.floor(y / distance)], taken = new Set(), groups = [];
  const sorted = [...points].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const point of sorted) {
    const key = cell(point).join();
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(point);
  }
  for (const point of sorted) {
    if (taken.has(point.id)) continue;
    const [cx, cy] = cell(point), members = [];
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
      for (const other of cells.get([cx + dx, cy + dy].join()) || []) {
        if (!taken.has(other.id) && Math.hypot(other.x - point.x, other.y - point.y) < distance) members.push(other);
      }
    }
    if (members.length < 2) continue;
    for (const member of members) taken.add(member.id);
    groups.push(members.map(member => member.id).sort());
  }
  return groups;
}

const overlaps = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

// Which labels fit. A label gives way to every pin and to the names already on the
// map (owners, acreage) and to labels placed before it; a selected mark's is kept.
export function placeMarkLabels(labels, pins, obstacles) {
  const placed = [], shown = new Set();
  for (const label of labels) {
    const clear = label.selected || (!pins.some(pin => pin.id !== label.id && overlaps(label, pin)) && !obstacles.some(box => overlaps(label, box))
      && !placed.some(other => overlaps(label, other)));
    if (!clear) continue;
    placed.push(label);
    shown.add(label.id);
  }
  return shown;
}

export function createMarkMapLayer({ L, getMap, onSelect = () => {}, onGroup = () => {}, onDelete = () => {}, obstacles = () => [], schedule = work => work(), onDraftMove = () => {}, onViewChange = () => {}, describe = mark => mark.name }) {
  let group = null, overlay = null, previewLine = null, ghost = null, pointer = null, attachedMap = null, last = null, far = false;
  // One tab stop for all pins: the last one focused, else the first.
  let tabStop = null, labelsDue = false, placingLabels = false;
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
  // Whether a name stays is decided for all of them together (placeLabels).
  function setLabel(map, item, layer, mark, offset) {
    item.label = { text: mark.name, offset };
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
  function keepLabel(map, item, show) {
    if (!show) {
      if (item.kept) group.removeLayer(item.kept);
      item.kept = null;
      return;
    }
    if (!item.kept) item.hover.closeTooltip();
    else item.kept.options.offset = item.label.offset;
    const kept = item.kept || L.tooltip({ ...LABEL, permanent: true, offset: item.label.offset });
    kept.setLatLng(latLng(item.at));
    kept.setContent(label(map, item.label.text));
    if (!item.kept) kept.addTo(group);
    item.kept = kept;
  }

  function placeLabels() {
    labelsDue = false;
    const map = attachedMap, mode = last?.labels;
    if (!map || !last) return;
    const size = map.getSize?.(), labels = [], pins = [];
    for (const [id, item] of items) {
      const point = item.at && map.latLngToContainerPoint?.(latLng(item.at));
      if (!point) continue;
      const height = item.height || 0;
      if (item.kind === 'pin') pins.push({ id, x: point.x - height * 0.4, y: point.y - height, width: height * 0.8, height });
      if (item.kind === 'group') pins.push({ id, x: point.x - 23, y: point.y - 18, width: 46, height: 36 });
      if (!item.label || id === DRAFT || mode === 'off' || (mode !== 'on' && !item.selected)) continue;
      if (size && (point.x < 0 || point.y < 0 || point.x > size.x || point.y > size.y)) continue;
      const width = Math.min(220, 12 + item.label.text.length * 6.4);
      labels.push({ id, selected: item.selected, x: point.x - width / 2, y: point.y - height - 24, width, height: 18 });
    }
    labels.sort((a, b) => Number(b.selected) - Number(a.selected) || b.y - a.y || (a.id < b.id ? -1 : 1));
    const shown = placeMarkLabels(labels.slice(0, LABEL_LIMIT), pins, labels.length ? obstacles() : []);
    placingLabels = true;
    try { for (const [id, item] of items) if (item.label) keepLabel(map, item, shown.has(id)); }
    finally { placingLabels = false; }
  }
  // After the map and the names on it have settled.
  function labelsSoon() {
    if (labelsDue || placingLabels) return;
    labelsDue = true;
    schedule(() => { if (labelsDue) placeLabels(); });
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
    if (items.get(id)?.movable) return; // the keys move it
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (items.get(id)?.kind === 'group') onGroup(items.get(id).ids); else onSelect(id);
      return;
    }
    if (event.key === 'Delete') {
      if (items.get(id)?.kind !== 'pin') return;
      event.preventDefault();
      event.stopPropagation();
      return onDelete(id);
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
  const pinOrder = () => [...items].filter(([id, item]) => (item.kind === 'pin' || item.kind === 'group') && item.interactive && id !== DRAFT).map(([id]) => id);
  function syncTabStops() {
    const order = pinOrder();
    const current = order.includes(tabStop) ? tabStop : order[0];
    for (const id of order) {
      const element = items.get(id).marker.getElement();
      if (element) element.tabIndex = id === current ? 0 : -1;
    }
  }

  function drawPin(map, id, mark, { selected, draft, movable, interactive }) {
    // An open mark looks selected; one not saved yet is dashed.
    const look = { selected: selected && id !== DRAFT, draft: id === DRAFT, far };
    const signature = JSON.stringify([mark.geometry.coordinates, mark.name, mark.color, mark.icon, look, movable, describe(mark)]);
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
      if (interactive) marker.on('click', event => { L.DomEvent.stop(event); if (id !== DRAFT) onSelect(id, { pointer: true }); });
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
    if (id !== DRAFT) setLabel(map, item, item.marker, mark, labelOffset);
    Object.assign(item, { signature, selected, at: mark.geometry.coordinates, height: size[1] });
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

  function drawShape(map, id, mark, { selected, draft, movable, interactive }) {
    const signature = JSON.stringify([mark.geometry, mark.name, mark.color, mark.icon, selected, draft, movable, interactive]);
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
    const made = { kind: 'shape', signature, layers, selected, at: area ? areaCentre(positions) : positions[0] };
    if (id !== DRAFT) setLabel(map, made, shapes[1], mark, [0, 0]);
    if (movable && interactive) vertexHandles(map, mark, shapes, layers);
    items.set(id, made);
  }

  // ---- several pins on one spot ------------------------------------------------
  function drawGroup(map, id, marks, interactive) {
    const at = [0, 1].map(axis => marks.reduce((sum, mark) => sum + mark.geometry.coordinates[axis], 0) / marks.length);
    const name = `${marks.length} marks: ${marks.slice(0, 3).map(mark => mark.name).join(', ')}${marks.length > 3 ? '…' : ''}`;
    const signature = JSON.stringify([at, name, marks.map(mark => [mark.id, mark.icon, mark.color])]);
    let item = items.get(id);
    if (item && (item.kind !== 'group' || item.interactive !== interactive)) { removeItem(id); item = null; }
    if (item?.signature === signature) return;
    const { html, size, anchor } = groupPlate(marks);
    const icon = L.divIcon({ className: 'viewer-map-group', html, iconSize: size, iconAnchor: anchor });
    if (!item) {
      const listeners = new AbortController(), { signal } = listeners;
      const marker = L.marker(latLng(at), { icon, interactive, keyboard: interactive, zIndexOffset: 500 }).addTo(group);
      item = { kind: 'group', interactive, marker, listeners };
      items.set(id, item);
      if (interactive) {
        marker.on('click', event => { L.DomEvent.stop(event); onGroup(item.ids); });
        marker.getElement()?.addEventListener('keydown', event => pinKeys(event, id), { signal });
        marker.getElement()?.addEventListener('focus', () => { tabStop = id; syncTabStops(); }, { signal });
      }
    } else {
      item.marker.setLatLng(latLng(at));
      item.marker.setIcon(icon);
    }
    item.marker.getElement()?.setAttribute('aria-label', name);
    Object.assign(item, { signature, ids: marks.map(mark => mark.id), at });
  }

  // Screen positions that do not change when the map is only panned.
  function screen(map, mark) {
    const at = latLng(mark.geometry.coordinates), point = map.project ? map.project(at, map.getZoom()) : map.latLngToContainerPoint?.(at);
    return point ? { id: mark.id, x: point.x, y: point.y } : null;
  }

  const draw = (map, id, mark, options) => (mark.geometry.type === 'Point' ? drawPin : drawShape)(map, id, mark, options);

  // ---- attach ------------------------------------------------------------------
  function zoomed() {
    far = attachedMap.getZoom() < FAR_OUT_ZOOM;
    // Sizes, groups and labels all depend on the zoom.
    if (last) render(last);
  }
  function layersChanged() { if (!placingLabels && !rendering) labelsSoon(); }

  function attach(map) {
    if (attachedMap === map) return;
    detach();
    attachedMap = map;
    group = L.layerGroup().addTo(map);
    overlay = L.layerGroup().addTo(map);
    far = map.getZoom() < FAR_OUT_ZOOM;
    map.on('mousemove', preview);
    map.on('zoomend', zoomed);
    map.on('move', onViewChange);
    map.on('moveend', labelsSoon);
    // Owner names come and go with their outlines.
    map.on('layeradd', layersChanged);
    map.on('layerremove', layersChanged);
    map.on('resize', onViewChange);
  }

  function detach() {
    if (!attachedMap) return;
    attachedMap.off('mousemove', preview);
    attachedMap.off('zoomend', zoomed);
    attachedMap.off('move', onViewChange);
    attachedMap.off('moveend', labelsSoon);
    attachedMap.off('layeradd', layersChanged);
    attachedMap.off('layerremove', layersChanged);
    labelsDue = false;
    attachedMap.off('resize', onViewChange);
    for (const id of [...items.keys()]) removeItem(id);
    for (const layers of [group, overlay]) { layers.clearLayers(); layers.remove(); }
    group = null;
    overlay = null;
    previewLine = null;
    ghost = null;
    pointer = null;
    attachedMap = null;
  }

  function preview(event) {
    pointer = event.latlng;
    if (last?.ghost) drawGhost();
    const drawing = last?.drawing;
    if (!drawing?.positions.length || !previewLine) return;
    previewLine.setLatLngs([latLng(drawing.positions.at(-1)), event.latlng]);
  }

  // The pin that follows the pointer while a spot is picked.
  function drawGhost() {
    if (!pointer) return;
    if (ghost) { ghost.setLatLng(pointer); return; }
    const { html, size, anchor } = mapPin(last.ghost, { draft: true });
    ghost = L.marker(pointer, { icon: L.divIcon({ className: 'viewer-map-ghost', html, iconSize: size, iconAnchor: anchor }),
      interactive: false, keyboard: false, zIndexOffset: 12_000 }).addTo(overlay);
  }

  function drawOverlay(next) {
    overlay.clearLayers();
    previewLine = null;
    ghost = null;
    if (next.ghost) drawGhost();
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

  let rendering = false;
  function render(next) {
    rendering = true;
    try { renderAll(next); } finally { rendering = false; }
  }
  function renderAll(next) {
    last = next;
    const map = getMap();
    if (!map || !next.visible) { detach(); return; }
    attach(map);
    const interactive = !next.drawing, draft = next.draft?.geometry ? next.draft : null;
    const marks = new Map(next.marks.map(mark => [mark.id, mark]));
    if (draft) marks.set(draft.id, draft);
    // Pins on one spot become one plate; the selected mark and the open one never do.
    const groups = new Map();
    if (next.group && interactive) {
      const points = [...marks.values()].filter(mark => mark.geometry.type === 'Point' && mark !== draft && mark.id !== next.selectedId)
        .map(mark => screen(map, mark)).filter(Boolean);
      for (const ids of groupPoints(points)) {
        groups.set(GROUP + ids[0], ids.map(id => marks.get(id)));
        for (const id of ids) marks.delete(id);
      }
    }
    for (const id of [...items.keys()]) if (!marks.has(id) && !groups.has(id)) removeItem(id);
    for (const [id, members] of groups) drawGroup(map, id, members, interactive);
    for (const [id, mark] of marks) {
      draw(map, id, mark, { selected: mark === draft || id === next.selectedId, draft: mark === draft,
        movable: mark === draft && interactive && Boolean(draft.movable), interactive });
    }
    syncTabStops();
    drawOverlay(next);
    labelsSoon();
  }

  const anchorPosition = geometry => (geometry.type === 'Polygon' ? areaCentre(markPositions(geometry)) : markPositions(geometry)[0]);
  return {
    render,
    // Where a mark is in the map's container, for the card beside it.
    anchor(geometry) {
      const point = attachedMap?.latLngToContainerPoint?.(latLng(anchorPosition(geometry)));
      return point ? [point.x, point.y] : null;
    },
    // Shifts the map so a mark is above a sheet that covers the lower part of it.
    keepAbove(geometry, covered) {
      const point = this.anchor(geometry), size = attachedMap?.getSize?.();
      if (!point || !size) return;
      const limit = size.y * (1 - covered) - 24;
      if (point[1] > limit) attachedMap.panBy([0, point[1] - limit], { animate: false });
    },
    centre() { const centre = getMap()?.getCenter?.(); return centre ? toPosition(centre) : null; },
    nudge(position, dx, dy) {
      const point = attachedMap?.latLngToContainerPoint?.(latLng(position));
      return point ? toPosition(attachedMap.containerPointToLatLng([point.x + dx, point.y + dy])) : position;
    },
    focusPin(id) {
      const item = items.get(id) || [...items.values()].find(row => row.kind === 'group' && row.ids.includes(id));
      item?.marker?.getElement()?.focus?.({ preventScroll: true });
    },
    // The pins' tab stop, when what had the focus is gone.
    focusStop() {
      const order = pinOrder(), id = order.includes(tabStop) ? tabStop : order[0];
      items.get(id)?.marker.getElement()?.focus?.({ preventScroll: true });
    },
    // Marks whose points are this close to one on the screen, itself first.
    near(id, distance) {
      const map = attachedMap, mark = last?.marks.find(item => item.id === id);
      if (!map || mark?.geometry.type !== 'Point') return [id];
      const here = screen(map, mark);
      return [id, ...last.marks.filter(item => item.id !== id && item.geometry.type === 'Point').map(item => screen(map, item))
        .filter(point => point && Math.hypot(point.x - here.x, point.y - here.y) < distance).map(point => point.id)];
    },
    zoomTo(geometries) {
      const map = attachedMap;
      if (!map) return;
      const before = map.getZoom();
      map.fitBounds(L.latLngBounds(geometries.map(geometry => latLng(anchorPosition(geometry)))), { maxZoom: Math.min(map.getMaxZoom?.() ?? 28, 24), padding: [60, 60], animate: false });
      if (map.getZoom() <= before) map.setZoom?.(before + 1, { animate: false });
    },
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
