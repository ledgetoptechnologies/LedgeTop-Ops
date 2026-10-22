// Map-only camera rendering. Source records never change with screen density;
// viewport clipping limits paint work, not which photos can be selected.
export function cameraFrame(records, { scale, origin, offset, width, height, size }) {
  const points = [], cells = new Map(), pinHeight = size * 4 / 3, cellSize = 48;
  for (const record of records) {
    const x = Math.round(record.world.x * scale - origin.x) + offset.x;
    const y = Math.round(record.world.y * scale - origin.y) + offset.y;
    if (x + size / 2 < 0 || x - size / 2 > width || y < 0 || y - pinHeight > height) continue;
    const point = { source: record.source, x, y, bearing: record.bearing, size, height: pinHeight };
    const index = points.push(point) - 1;
    for (let cy = Math.floor((y - pinHeight) / cellSize); cy <= Math.floor(y / cellSize); cy++) {
      for (let cx = Math.floor((x - size / 2) / cellSize); cx <= Math.floor((x + size / 2) / cellSize); cx++) {
        const key = `${cx}:${cy}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(index);
      }
    }
  }
  return { points, cells, cellSize };
}

export function hitCamera(frame, x, y) {
  const candidates = frame.cells.get(`${Math.floor(x / frame.cellSize)}:${Math.floor(y / frame.cellSize)}`) || [];
  // Match paint order (southerly pins above northerly ones), never nearest-photo
  // replacement. Every occluded capture remains accessible by keyboard.
  for (let i = candidates.length - 1; i >= 0; i--) {
    const point = frame.points[candidates[i]];
    if (x >= point.x - point.size / 2 && x <= point.x + point.size / 2
      && y >= point.y - point.height && y <= point.y) return point.source;
  }
  return null;
}

// Leaflet 1.9.4 zoom transitions use cubic-bezier(0,0,.25,1), 250ms.
// Interpolate anchors, not the canvas bitmap: pin size remains fixed mid-zoom.
export function cameraZoomEase(progress) {
  const x = Math.max(0, Math.min(1, progress));
  let low = 0, high = 1;
  for (let i = 0; i < 18; i++) {
    const t = (low + high) / 2, value = .75 * t * t + .25 * t * t * t;
    if (value < x) low = t; else high = t;
  }
  const t = (low + high) / 2;
  return 3 * t * t - 2 * t * t * t;
}

export function createMapCameraOverlay(L, {
  onSelect, onFrame = () => {}, isInteractive = () => true, documentRef = document,
  requestFrame = requestAnimationFrame, cancelFrame = cancelAnimationFrame,
  pixelRatio = () => window.devicePixelRatio || 1,
  now = () => performance.now(),
} = {}) {
  const Overlay = L.Layer.extend({
    initialize() {
      this.records = []; this.ordered = []; this.frame = { points: [], cells: new Map(), cellSize: 48 };
      this.size = 24; this.selected = 0; this.pendingFrame = null;
    },
    setData(records, size) {
      this.records = records.map(record => ({ ...record, world: null }));
      this.size = size; this.selected = Math.min(this.selected, Math.max(0, records.length - 1));
      this.prepare(); this.schedule(); return this;
    },
    prepare() {
      if (!this._map) return;
      for (const record of this.records) record.world = this._map.project(record.latlng, 0);
      this.ordered = [...this.records].sort((a, b) => a.world.y - b.world.y || a.source - b.source);
      this.updateLabel();
    },
    onAdd(map) {
      this._map = map;
      this.canvas = documentRef.createElement('canvas');
      this.canvas.className = 'map-camera-canvas';
      this.canvas.setAttribute('aria-hidden', 'true');
      Object.assign(this.canvas.style, { position: 'absolute', left: '0', top: '0', zIndex: '650', pointerEvents: 'none' });
      (map.getPane?.('markerPane') || map.getContainer()).appendChild(this.canvas);
      this.context = this.canvas.getContext('2d');
      this.click = event => {
        if (!isInteractive() || event.target?.closest?.('.leaflet-control') || map.dragging?.moved() || map.boxZoom?.moved()) return;
        const rect = this.canvas.getBoundingClientRect();
        const source = hitCamera(this.frame, event.clientX - rect.left, event.clientY - rect.top);
        if (source === null) return;
        L.DomEvent.stopPropagation(event);
        this.selected = this.records.findIndex(record => record.source === source);
        this.updateLabel(); onSelect?.(source);
      };
      // Preserve the original target for measurement paths and map controls.
      // Capture only real pin clicks; ordinary map clicks continue untouched.
      map.getContainer().addEventListener('click', this.click, true);
      this.hover = event => {
        const container=map.getContainer();
        if(!isInteractive()||event.buttons||event.target?.closest?.('.leaflet-control')){this.clearHover();return;}
        const rect=this.canvas.getBoundingClientRect(),hit=hitCamera(this.frame,event.clientX-rect.left,event.clientY-rect.top)!==null;
        if(hit){if(!this.hovering)this.previousCursor=container.style.cursor;this.hovering=true;container.style.cursor='pointer';}else this.clearHover();
      };
      this.clearHover=()=>{if(this.hovering){map.getContainer().style.cursor=this.previousCursor||'';this.hovering=false;}};
      map.getContainer().addEventListener('pointermove',this.hover);
      map.getContainer().addEventListener('pointerleave',this.clearHover);
      map.getContainer().addEventListener('pointerdown',this.clearHover);
      // A bounded DOM control exposes ALL captures, including overlapping and
      // offscreen pins, without thousands of tab stops or hidden buttons.
      this.control = L.control({ position: 'bottomleft' });
      this.control.onAdd = () => {
        const container = documentRef.createElement('div'); container.className = 'leaflet-bar';
        this.button = documentRef.createElement('button'); this.button.type = 'button';
        this.button.className = 'map-camera-selector';
        Object.assign(this.button.style, { padding: '6px 10px', background: '#17191d', color: '#fff', border: '1px solid #ee5007', cursor: 'pointer' });
        this.button.title = 'Arrow keys select a camera; Home/End jump; Enter or Space opens the photo.';
        this.button.addEventListener('keydown', event => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !this.records.length) return;
          event.preventDefault(); event.stopPropagation();
          this.selected = event.key === 'Home' ? 0 : event.key === 'End' ? this.records.length - 1
            : (this.selected + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + this.records.length) % this.records.length;
          this.updateLabel(); map.panInside(this.records[this.selected].latlng, { padding: [this.size, this.size * 2] }); this.schedule();
        });
        this.button.addEventListener('click', () => { if (this.records[this.selected]) onSelect?.(this.records[this.selected].source); });
        this.button.addEventListener('focus', () => this.schedule());
        this.button.addEventListener('blur', () => this.schedule());
        container.appendChild(this.button); L.DomEvent.disableClickPropagation(container); L.DomEvent.disableScrollPropagation(container);
        return container;
      };
      this.control.addTo(map); this.prepare(); this.schedule();
    },
    getEvents() { return { move: this.schedule, zoom: this.schedule, resize: this.schedule, viewreset: this.schedule, zoomanim: this.animateZoom, zoomend: this.finishZoom }; },
    currentTransform() {
      const origin = this._map.getPixelOrigin(), offset = this._map.layerPointToContainerPoint(L.point(0, 0));
      return { scale: this._map.getZoomScale(this._map.getZoom(), 0), origin: { x: origin.x - offset.x, y: origin.y - offset.y } };
    },
    animateZoom(event) {
      const center = this._map.project(event.center, event.zoom), size = this._map.getSize();
      this.animation = { from: this.viewTransform || this.currentTransform(),
        to: { scale: this._map.getZoomScale(event.zoom, 0), origin: { x: center.x - size.x / 2, y: center.y - size.y / 2 } }, start: now() };
      this.schedule();
    },
    finishZoom() { this.animation = null; this.schedule(); },
    updateLabel() {
      if (!this.button) return;
      this.button.disabled = !this.records.length;
      this.button.textContent = `Camera ${this.records.length ? this.selected + 1 : 0} / ${this.records.length}`;
      const name = this.records[this.selected]?.label || 'photo';
      this.button.setAttribute('aria-label', `${this.button.textContent}: ${name}. Arrow keys select; Enter opens photo.`);
    },
    schedule() {
      if (!this._map || this.pendingFrame !== null) return;
      this.pendingFrame = requestFrame(() => { this.pendingFrame = null; if (this._map && this.canvas) this.draw(); });
    },
    draw() {
      const map = this._map, dimensions = map.getSize(), width = dimensions.x, height = dimensions.y;
      if (!(width > 0 && height > 0) || !this.context) return;
      const paneOffset = map.layerPointToContainerPoint(L.point(0, 0));
      this.canvas.style.transform = `translate3d(${-paneOffset.x}px, ${-paneOffset.y}px, 0)`;
      const ratio = Math.min(2, Math.max(1, pixelRatio()), 8192 / width, 8192 / height);
      if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
        this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio);
        this.canvas.style.width = `${width}px`; this.canvas.style.height = `${height}px`;
      }
      const ctx = this.context; ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
      let transform = this.currentTransform();
      if (this.animation) {
        const { from, to, start } = this.animation, progress = Math.min(1, (now() - start) / 250), eased = cameraZoomEase(progress);
        const mix = (a, b) => a + (b - a) * eased;
        transform = { scale: mix(from.scale, to.scale), origin: { x: mix(from.origin.x, to.origin.x), y: mix(from.origin.y, to.origin.y) } };
        if (progress < 1) this.schedule();
      }
      this.viewTransform = transform;
      this.frame = cameraFrame(this.ordered, { ...transform, offset: { x: 0, y: 0 }, width, height, size: this.size });
      if (!this.sprite || this.spriteSize !== this.size || this.spriteRatio !== ratio) this.makeSprite(ratio);
      for (const point of this.frame.points) {
        ctx.drawImage(this.sprite, point.x - point.size / 2, point.y - point.height, point.size, point.height);
        const unit = point.size / 24, angle = point.bearing * Math.PI / 180;
        ctx.save(); ctx.translate(point.x, point.y - point.height + 12 * unit); ctx.rotate(angle); ctx.scale(unit, unit);
        ctx.fillStyle = '#f8cb2e'; ctx.beginPath(); ctx.moveTo(0, -10.5); ctx.lineTo(-2, -7.5); ctx.lineTo(2, -7.5); ctx.closePath(); ctx.fill(); ctx.restore();
        if (documentRef.activeElement === this.button && this.records[this.selected]?.source === point.source) {
          ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(point.x - point.size / 2 - 2, point.y - point.height - 2, point.size + 4, point.height + 4);
        }
      }
      onFrame(this.frame.points);
    },
    makeSprite(ratio) {
      this.sprite = documentRef.createElement('canvas'); this.sprite.width = Math.ceil(this.size * ratio); this.sprite.height = Math.ceil(this.size * 4 / 3 * ratio);
      const ctx = this.sprite.getContext('2d'); ctx.scale(this.size * ratio / 24, this.size * ratio / 24);
      ctx.fillStyle = '#ee5007'; ctx.strokeStyle = '#c73a0a'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(12, 31); ctx.bezierCurveTo(9, 26, 1, 17, 1, 12); ctx.arc(12, 12, 11, Math.PI, 0); ctx.bezierCurveTo(23, 17, 15, 27, 12, 31); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(5, 9); ctx.lineTo(8, 9); ctx.lineTo(9.5, 7); ctx.lineTo(14.5, 7); ctx.lineTo(16, 9); ctx.lineTo(19, 9); ctx.lineTo(19, 19); ctx.lineTo(5, 19); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#ee5007'; ctx.beginPath(); ctx.arc(12, 14, 3, 0, Math.PI * 2); ctx.fill();
      this.spriteSize = this.size; this.spriteRatio = ratio;
    },
    onRemove() {
      if (this.pendingFrame !== null) cancelFrame(this.pendingFrame);
      this.pendingFrame = null;
      if (documentRef.activeElement === this.button) this._map?.getContainer().focus?.();
      this._map?.getContainer().removeEventListener('click', this.click, true); this.canvas?.remove(); this.control?.remove();
      this.clearHover?.();this._map?.getContainer().removeEventListener('pointermove',this.hover);this._map?.getContainer().removeEventListener('pointerleave',this.clearHover);this._map?.getContainer().removeEventListener('pointerdown',this.clearHover);
      if (this.canvas) { this.canvas.width = 0; this.canvas.height = 0; }
      if (this.sprite) { this.sprite.width = 0; this.sprite.height = 0; }
      this.canvas = this.context = this.sprite = this.control = this.button = this._map = null;
      this.animation = this.viewTransform = null;
      this.frame = { points: [], cells: new Map(), cellSize: 48 }; onFrame([]);
    },
  });
  return new Overlay();
}
