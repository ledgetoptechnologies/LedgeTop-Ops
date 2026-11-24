// Records what the marks layer draws. Pins and corners only move when they were
// drawn draggable, as in Leaflet.
export function createMiniLeaflet(document) {
  const groups = new Set(), made = [], mapHandlers = {};
  class Layer {
    constructor(kind, positions, options = {}) {
      Object.assign(this, { kind, positions, options: { ...options }, handlers: {}, label: null, element: null });
      // As in Leaflet, a marker that takes no input has no dragging.
      if (kind === 'marker' && options.interactive !== false) {
        this.dragging = { enable: () => { this.options.draggable = true; }, disable: () => { this.options.draggable = false; } };
      }
    }
    addTo(target) {
      target.layers.add(this);
      made.push(this);
      if (this.kind === 'marker' && !this.element) {
        this.element = document.createElement('div');
        this.paint();
      }
      return this;
    }
    // As in Leaflet, a new icon repaints the same element and makes it a tab stop again.
    paint() {
      this.element.className = this.options.icon.className;
      this.element.innerHTML = this.options.icon.html || '';
      if (this.options.keyboard !== false) this.element.tabIndex = 0;
    }
    getElement() { return this.element; }
    setIcon(icon) { this.options.icon = icon; this.paint(); return this; }
    setLatLng(position) { this.positions = position; return this; }
    setLatLngs(positions) { this.positions = positions; return this; }
    setZIndexOffset(offset) { this.options.zIndexOffset = offset; return this; }
    on(type, handler) { (this.handlers[type] ||= []).push(handler); return this; }
    off() { this.handlers = {}; return this; }
    // As in Leaflet 1.9: each hover tooltip bound to a marker listens on its element for
    // focus and blur, those listeners are never taken off, and they act on whatever
    // tooltip is bound by then.
    bindTooltip(content, options) {
      this.binds = (this.binds || 0) + 1;
      this.label = { text: content.textContent, options, open: Boolean(options.permanent) };
      if (!options.permanent && this.element) {
        this.element.addEventListener('focus', () => { if (this.label) this.openTooltip(); });
        this.element.addEventListener('blur', () => this.closeTooltip());
      }
      return this;
    }
    setTooltipContent(content) { if (this.label) this.label.text = content.textContent; return this; }
    getTooltip() { return this.label; }
    openTooltip() { if (this.label) { this.label.open = true; for (const handler of this.handlers.tooltipopen || []) handler({}); } return this; }
    closeTooltip() { if (this.label) this.label.open = false; return this; }
    setContent(content) { this.text = content.textContent; return this; }
    unbindTooltip() { this.label = null; return this; }
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
  let zoom = 18;
  const map = { layers: new Set(), on: (type, handler) => { (mapHandlers[type] ||= new Set()).add(handler); },
    off: (type, handler) => { mapHandlers[type]?.delete(handler); }, getContainer: () => container, getZoom: () => zoom, setView() {}, fitBounds() {},
    doubleClickZoom: { enable() {}, disable() {} } };
  const L = {
    DomEvent: { stop() {} },
    divIcon: options => options,
    latLngBounds: positions => positions,
    layerGroup: () => {
      const group = { layers: new Set(), addTo: () => { groups.add(group); return group; }, eachLayer: fn => group.layers.forEach(fn),
        clearLayers: () => group.layers.clear(), removeLayer: layer => group.layers.delete(layer), remove: () => groups.delete(group) };
      return group;
    },
  };
  for (const kind of ['marker', 'polyline', 'polygon', 'circleMarker']) L[kind] = (positions, options) => new Layer(kind, positions, options);
  L.tooltip = options => new Layer('tooltip', null, options);
  const drawn = () => [...groups].flatMap(group => [...group.layers]);
  const markers = className => drawn().filter(layer => layer.kind === 'marker' && layer.options.icon.className.split(' ')[0] === className);
  // The names that stay on the map: each once per label drawn.
  const shown = () => [...drawn().filter(layer => layer.kind === 'tooltip').map(layer => layer.text),
    ...drawn().filter(layer => layer.label?.options.permanent && layer.label.open).map(layer => layer.label.text)].sort();
  return { L, map, drawn, made, shown, mapHandlers, setZoom: next => { zoom = next; for (const handler of mapHandlers.zoomend || []) handler(); },
    pins: () => markers('viewer-map-mark'), corners: () => markers('viewer-mark-vertex'), areaGlyphs: () => markers('viewer-map-area') };
}
