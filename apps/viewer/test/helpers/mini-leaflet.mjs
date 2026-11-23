// Records what the marks layer draws. Pins and corners only move when they were
// drawn draggable, as in Leaflet.
export function createMiniLeaflet(document) {
  const groups = new Set();
  class Layer {
    constructor(kind, positions, options = {}) { Object.assign(this, { kind, positions, options, handlers: {}, label: null }); }
    addTo(target) { target.layers.add(this); return this; }
    on(type, handler) { (this.handlers[type] ||= []).push(handler); return this; }
    bindTooltip(content, options) { this.label = { text: content.textContent, options }; return this; }
    unbindTooltip() { this.label = null; }
    setLatLngs(positions) { this.positions = positions; }
    getLatLng() { return { lat: this.positions[0], lng: this.positions[1] }; }
    // A person dragging this layer: nothing happens unless it is draggable.
    drag(lat, lng) {
      if (!this.options.draggable) return false;
      this.positions = [lat, lng];
      for (const type of ['drag', 'dragend']) for (const handler of this.handlers[type] || []) handler({ target: this });
      return true;
    }
    click() { for (const handler of this.handlers.click || []) handler({ target: this }); }
  }
  const container = document.createElement('div');
  const map = { layers: new Set(), on() {}, off() {}, getContainer: () => container, getZoom: () => 18, setView() {}, fitBounds() {},
    doubleClickZoom: { enable() {}, disable() {} } };
  const L = {
    DomEvent: { stop() {} },
    divIcon: options => options,
    latLngBounds: positions => positions,
    layerGroup: () => {
      const group = { layers: new Set(), addTo: () => { groups.add(group); return group; }, eachLayer: fn => group.layers.forEach(fn),
        clearLayers: () => group.layers.clear(), remove: () => groups.delete(group) };
      return group;
    },
  };
  for (const kind of ['marker', 'polyline', 'polygon', 'circleMarker']) L[kind] = (positions, options) => new Layer(kind, positions, options);
  const drawn = () => [...groups].flatMap(group => [...group.layers]);
  return { L, map, drawn, pins: () => drawn().filter(layer => layer.kind === 'marker' && layer.options.icon.className.startsWith('viewer-map-mark')),
    corners: () => drawn().filter(layer => layer.kind === 'marker' && layer.options.icon.className === 'viewer-mark-vertex') };
}
