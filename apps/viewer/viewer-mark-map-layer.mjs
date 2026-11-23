import { markIconSvg, safeColor } from './viewer-mark-icons.mjs';

// Leaflet view of marks. The store is the source of truth: this layer is
// redrawn from it and reports drags and clicks back. Labels are DOM text, never
// HTML, because people type them.
const latLng = ([lon, lat]) => [lat, lon];
const toPosition = ({ lat, lng }) => [Math.round(lng * 1e8) / 1e8, Math.round(lat * 1e8) / 1e8];

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

export function createMarkMapLayer({ L, getMap, onSelect = () => {}, onMove = () => {}, onDraftMove = () => {} }) {
  let group = null, previewLine = null, attachedMap = null, last = null;
  const label = (map, text) => {
    const span = map.getContainer().ownerDocument.createElement('span');
    span.textContent = text;
    return span;
  };

  function pointIcon(mark, extra = '') {
    return L.divIcon({ className: 'viewer-map-mark' + extra, html: markIconSvg(mark.icon, mark.color, 26), iconSize: [26, 26], iconAnchor: [13, 13] });
  }

  function vertexHandles(map, mark, shape, moved) {
    const positions = markPositions(mark.geometry).map(p => [...p]);
    positions.forEach((position, index) => {
      const handle = L.marker(latLng(position), { draggable: true, keyboard: false, zIndexOffset: 1000,
        icon: L.divIcon({ className: 'viewer-mark-vertex', iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(group);
      handle.on('drag', () => {
        positions[index] = toPosition(handle.getLatLng());
        shape.setLatLngs(positions.map(latLng));
      });
      handle.on('dragend', () => moved(mark, geometryFrom(mark.geometry.type, positions)));
    });
  }

  function drawMark(map, mark, { selected, editable, labels, interactive }, moved = onMove) {
    const color = safeColor(mark.color);
    let layer;
    if (mark.geometry.type === 'Point') {
      layer = L.marker(latLng(mark.geometry.coordinates), { icon: pointIcon(mark, selected ? ' selected' : ''),
        draggable: interactive && editable, interactive, keyboard: interactive, title: mark.name, autoPan: true });
      layer.on('dragend', () => onMove(mark, { type: 'Point', coordinates: toPosition(layer.getLatLng()) }));
    } else {
      const options = { color, weight: selected ? 5 : 3, interactive, bubblingMouseEvents: false,
        ...(mark.geometry.type === 'Polygon' ? { fillColor: color, fillOpacity: 0.2 } : {}) };
      const positions = markPositions(mark.geometry).map(latLng);
      layer = mark.geometry.type === 'Polygon' ? L.polygon(positions, options) : L.polyline(positions, options);
    }
    layer.addTo(group);
    if (interactive) layer.on('click', event => { L.DomEvent.stop(event); onSelect(mark.id); });
    layer.bindTooltip(label(map, mark.name), { permanent: labels, direction: 'top', offset: [0, mark.geometry.type === 'Point' ? -12 : 0],
      className: 'viewer-mark-label', interactive: false });
    if (selected && editable && interactive && mark.geometry.type !== 'Point') vertexHandles(map, mark, layer, moved);
  }

  function attach(map) {
    if (attachedMap === map) return;
    detach();
    attachedMap = map;
    group = L.layerGroup().addTo(map);
    map.on('mousemove', preview);
  }

  function clear() {
    group?.eachLayer(layer => layer.unbindTooltip?.());
    group?.clearLayers();
  }

  function detach() {
    if (!attachedMap) return;
    attachedMap.off('mousemove', preview);
    clear();
    group?.remove();
    group = null;
    previewLine = null;
    attachedMap = null;
  }

  function preview(event) {
    const drawing = last?.drawing;
    if (!drawing?.positions.length || !previewLine) return;
    previewLine.setLatLngs([latLng(drawing.positions.at(-1)), event.latlng]);
  }

  return {
    render(next) {
      last = next;
      const map = getMap();
      if (!map || !next.visible) { detach(); return; }
      attach(map);
      clear();
      previewLine = null;
      const interactive = !next.drawing;
      for (const mark of next.marks) {
        if (next.draft?.id === mark.id) continue;
        drawMark(map, mark, { selected: mark.id === next.selectedId, editable: next.editable(mark), labels: next.labels, interactive });
      }
      if (next.draft?.geometry) {
        const draft = next.draft;
        if (draft.geometry.type === 'Point') {
          const pin = L.marker(latLng(draft.geometry.coordinates), { icon: pointIcon(draft, ' draft'), draggable: true, autoPan: true, zIndexOffset: 900 }).addTo(group);
          pin.on('dragend', () => onDraftMove({ type: 'Point', coordinates: toPosition(pin.getLatLng()) }));
        } else drawMark(map, draft, { selected: true, editable: true, labels: false, interactive: !next.drawing }, (_mark, geometry) => onDraftMove(geometry));
      }
      if (next.preview) {
        L.circleMarker(latLng(next.preview), { radius: 9, color: '#ffffff', weight: 2, dashArray: '3 3', fillOpacity: 0, interactive: false }).addTo(group);
      }
      if (next.drawing) {
        const { type, positions } = next.drawing;
        const color = safeColor(next.drawing.color);
        if (positions.length >= 2) {
          (type === 'Polygon' && positions.length >= 3 ? L.polygon : L.polyline)(positions.map(latLng),
            { color, weight: 3, dashArray: '6 4', fillOpacity: 0.15, interactive: false }).addTo(group);
        }
        for (const position of positions) L.circleMarker(latLng(position), { radius: 4, color, weight: 2, fillColor: '#ffffff', fillOpacity: 1, interactive: false }).addTo(group);
        if (positions.length) previewLine = L.polyline([latLng(positions.at(-1)), latLng(positions.at(-1))], { color, weight: 2, dashArray: '2 6', interactive: false }).addTo(group);
      }
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
