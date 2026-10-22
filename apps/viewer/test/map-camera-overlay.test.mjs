import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraFrame, hitCamera, cameraZoomEase, createMapCameraOverlay } from '../map-camera-overlay.mjs';

function fixture() {
  const calls = { projections: 0, paints: 0, created: [], selected: [], frames: [] }, timers = new Map();
  let clock = 0, serial = 0;
  function element(tag) {
    calls.created.push(tag);
    return { tag, style: {}, listeners: new Map(), children: [], attributes: {}, width: 0, height: 0,
      appendChild(child) { this.children.push(child); },
      addEventListener(type, fn, capture) { this.listeners.set(`${type}:${!!capture}`, fn); },
      removeEventListener(type, fn, capture) { if (this.listeners.get(`${type}:${!!capture}`) === fn) this.listeners.delete(`${type}:${!!capture}`); },
      setAttribute(name, value) { this.attributes[name] = value; }, remove() { this.removed = true; },
      getBoundingClientRect() { return { left: 0, top: 0 }; },
      getContext() { return new Proxy({}, { get(_target, key) { return (..._args) => { if (key === 'drawImage') calls.paints++; }; }, set() { return true; } }); },
    };
  }
  const documentRef = { createElement: element, activeElement: null }, container = element('div');
  const map = { zoom: 0, offset: { x: 0, y: 0 }, dragMoved: false,
    project(position, zoom) { calls.projections++; return { x: position[0] * 2 ** zoom, y: position[1] * 2 ** zoom }; },
    getZoomScale(to, from) { return 2 ** (to - from); }, getZoom() { return this.zoom; }, getPixelOrigin() { return { x: 0, y: 0 }; },
    layerPointToContainerPoint() { return this.offset; }, getSize() { return { x: 500, y: 500 }; }, getContainer() { return container; },
    panInside(latlng) { this.lastPan = latlng; }, dragging: { moved() { return map.dragMoved; } },
  };
  const L = { point: (x, y) => ({ x, y }), Layer: { extend(methods) { return class { constructor() { Object.assign(this, methods); this.initialize(); } }; } },
    control() { return { addTo(map) { this.element = this.onAdd(map); }, remove() { this.element.removed = true; } }; },
    DomEvent: { stopPropagation(event) { event.stopped = true; }, disableClickPropagation() {}, disableScrollPropagation() {} },
  };
  let interactive = true;
  const layer = createMapCameraOverlay(L, { documentRef, requestFrame(fn) { timers.set(++serial, fn); return serial; }, cancelFrame(id) { timers.delete(id); },
    pixelRatio: () => 2, now: () => clock, isInteractive: () => interactive,
    onSelect: source => calls.selected.push(source), onFrame: points => calls.frames.push(points),
  });
  return { layer, calls, timers, map, container, documentRef, setInteractive: value => { interactive = value; },
    tick(time = clock) { clock = time; const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn(time)); },
  };
}

test('10,000 overlapping/visible cameras use bounded DOM, one frame per event burst and cached projection', () => {
  const f = fixture(), records = Array.from({ length: 10_000 }, (_, source) => ({ source, latlng: [source % 100 * 4, Math.floor(source / 100) * 4 + 32], bearing: source % 360, label: `image-${source}.jpg` }));
  f.layer.setData(records, 24); f.layer.onAdd(f.map);
  for (let i = 0; i < 100; i++) f.layer.schedule();
  assert.equal(f.timers.size, 1); f.tick();
  assert.equal(f.layer.frame.points.length, 10_000); assert.equal(f.calls.paints, 10_000);
  assert.equal(new Set(f.layer.frame.points.map(point => point.source)).size, 10_000);
  assert.equal(f.calls.created.filter(tag => tag === 'canvas').length, 2, 'one viewport and one shared sprite');
  assert.equal(f.calls.created.filter(tag => tag === 'button').length, 1);
  const projections = f.calls.projections, created = f.calls.created.length;
  f.map.offset = { x: 2, y: -3 }; f.layer.schedule(); f.tick();
  assert.equal(f.calls.projections, projections, 'pan does not reproject every source');
  assert.equal(f.calls.created.length, created, 'pan neither creates pins nor replaces the sprite');
  assert.equal(f.layer.frame.points[0].size, 24);
  assert.equal(f.layer.canvas.style.pointerEvents, 'none');
});

test('clipping preserves all source records and a keyboard route to occluded/offscreen captures', () => {
  const f = fixture(); f.layer.setData([{ source: 7, latlng: [50, 60], bearing: 33, label: 'front.jpg' }, { source: 9, latlng: [800, 800], bearing: 287, label: 'far.jpg' }], 24); f.layer.onAdd(f.map); f.tick();
  assert.deepEqual(f.layer.frame.points.map(p => p.source), [7]);
  assert.equal(f.layer.records.length, 2);
  f.layer.button.listeners.get('keydown:false')({ key: 'End', preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(f.map.lastPan, [800, 800]); assert.match(f.layer.button.attributes['aria-label'], /2 \/ 2: far.jpg/);
  f.layer.button.listeners.get('click:false')(); assert.deepEqual(f.calls.selected, [9]);
  assert.equal(f.layer.records[1].bearing, 287);
});

test('paint-order hit testing opens exact photo; drag, controls, measurements and empty clicks pass through', () => {
  const f = fixture(); f.layer.setData([{ source: 1, latlng: [50, 60], bearing: 0 }, { source: 2, latlng: [50, 60], bearing: 180 }], 24); f.layer.onAdd(f.map); f.tick();
  const click = f.container.listeners.get('click:true');
  const event = { clientX: 50, clientY: 50 }; click(event); assert.equal(event.stopped, true); assert.deepEqual(f.calls.selected, [2]);
  f.map.dragMoved = true; click({ clientX: 50, clientY: 50 }); f.map.dragMoved = false;
  f.setInteractive(false); click({ clientX: 50, clientY: 50 }); f.setInteractive(true);
  click({ clientX: 50, clientY: 50, target: { closest: () => ({}) } });
  const empty = { clientX: 450, clientY: 450 }; click(empty);
  assert.equal(empty.stopped, undefined); assert.deepEqual(f.calls.selected, [2]);
});

test('animated zoom interpolates anchors with Leaflet easing while pin dimensions and identities stay fixed', () => {
  const f = fixture(); f.layer.setData([{ source: 1, latlng: [200, 200], bearing: 19 }], 24); f.layer.onAdd(f.map); f.tick();
  const initial = f.layer.frame.points[0].x;
  f.layer.animateZoom({ center: [250, 250], zoom: 1 }); f.tick(125);
  const midway = f.layer.frame.points[0]; assert.equal(midway.source, 1); assert.equal(midway.size, 24);
  assert.ok(midway.x < initial && midway.x > 150); assert.ok(f.timers.size <= 1);
  f.tick(250); assert.equal(f.layer.frame.points[0].x, 150); assert.equal(f.layer.frame.points[0].size, 24);
  assert.ok(cameraZoomEase(.5) > .5); assert.ok(cameraZoomEase(0) < .0001); assert.ok(cameraZoomEase(1) > .9999);
});

test('remove cancels redraw/listeners and releases raster buffers; re-add starts cleanly', () => {
  const f = fixture(); f.layer.setData([{ source: 3, latlng: [30, 50], bearing: 0 }], 24); f.layer.onAdd(f.map); f.tick();
  const canvas = f.layer.canvas, sprite = f.layer.sprite; f.layer.schedule(); f.layer.onRemove();
  assert.equal(f.timers.size, 0); assert.equal(f.container.listeners.size, 0); assert.equal(canvas.width, 0); assert.equal(sprite.width, 0);
  assert.deepEqual(f.calls.frames.at(-1), []); f.layer.onAdd(f.map); f.tick(); assert.equal(f.layer.frame.points[0].source, 3);
});

test('hit grid includes boundary/edge-overlapping pins without inventing a source', () => {
  const frame = cameraFrame([{ source: 4, world: { x: -5, y: 10 }, bearing: 0 }], { scale: 1, origin: { x: 0, y: 0 }, offset: { x: 0, y: 0 }, width: 100, height: 100, size: 24 });
  assert.equal(frame.points.length, 1); assert.equal(hitCamera(frame, 0, 2), 4); assert.equal(hitCamera(frame, 90, 90), null);
});

test('camera hover uses the bounded hit grid and restores navigation cursor',()=>{
  const f=fixture();f.container.style.cursor='grab';f.layer.setData([{source:1,latlng:[50,60],bearing:0}],24);f.layer.onAdd(f.map);f.tick();const hover=f.container.listeners.get('pointermove:false');
  hover({clientX:50,clientY:50});assert.equal(f.container.style.cursor,'pointer');hover({clientX:450,clientY:450});assert.equal(f.container.style.cursor,'grab');hover({clientX:50,clientY:50});f.setInteractive(false);hover({clientX:50,clientY:50});assert.equal(f.container.style.cursor,'grab');f.setInteractive(true);hover({clientX:50,clientY:50});f.layer.onRemove();assert.equal(f.container.style.cursor,'grab');assert.equal(f.container.listeners.size,0);
});
