import test from 'node:test';
import assert from 'node:assert/strict';
import { createEptPotreeSlicePrototype } from '../ept-potree-slice-prototype.mjs';

function fixture() {
  const events = () => { const listeners = new Map(); return {
    addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type) { for (const fn of listeners.get(type) || []) fn({ type }); },
    count() { return [...listeners.values()].reduce((n, group) => n + group.size, 0); },
  }; };
  class BoxVolume {
    constructor() { this.position = { set: (...v) => { this.center = v; } }; this.scale = { set: (...v) => { this.size = v; } }; }
    updateMatrixWorld() { this.updated = true; }
    traverse(callback) { callback(this); }
  }
  const Potree = { BoxVolume, ClipTask: { SHOW_INSIDE: 2 }, ClipMethod: { INSIDE_ALL: 1 } };
  const scene = { ...events(), volumes: [], profiles: [], polygonClipVolumes: [], addVolume(v) { this.volumes.push(v); this.emit('volume_added'); }, removeVolume(v) { const i=this.volumes.indexOf(v); if(i>=0) {this.volumes.splice(i, 1); this.emit('volume_removed');} } };
  const viewer = { ...events(), scene, task: 1, method: 0, getClipTask() { return this.task; }, getClipMethod() { return this.method; }, setClipTask(v) { this.task = v; this.emit('cliptask_changed'); }, setClipMethod(v) { this.method = v; this.emit('clipmethod_changed'); } };
  return { Potree, scene, viewer };
}
const bounds = { min: [600000, 4500000, 0], max: [600100, 4500200, 100] };
test('prototype uses one native volume and restores its own state', () => {
  const { Potree, scene, viewer } = fixture(), adapter = createEptPotreeSlicePrototype(viewer, Potree);
  const first = adapter.set(bounds, { axis: 'northing', fraction: .25 });
  assert.equal(first.cut, 4500050); assert.equal(scene.volumes.length, 1);
  const volume = scene.volumes[0]; assert.equal(volume.clip, true); assert.equal(volume.visible, false);
  assert.deepEqual(volume.center, first.center); assert.deepEqual(volume.size, first.size);
  assert.equal(viewer.task, 2); assert.equal(viewer.method, 1);
  adapter.set(bounds, { axis: 'elevation', flipped: true }); assert.equal(scene.volumes[0], volume);
  adapter.dispose(); assert.equal(scene.volumes.length, 0); assert.equal(viewer.task, 1); assert.equal(viewer.method, 0);
  assert.throws(() => adapter.set(bounds, {}));
});
test('prototype refuses existing clipping and never removes another volume', () => {
  const { Potree, scene, viewer } = fixture(), adapter = createEptPotreeSlicePrototype(viewer, Potree);
  const other = { clip: true }; scene.volumes.push(other);
  assert.throws(() => adapter.set(bounds, {}), /Other clipping/); assert.deepEqual(scene.volumes, [other]);
  scene.volumes.pop(); adapter.set(bounds, {}); scene.volumes.push(other);
  assert.throws(() => adapter.set(bounds, {}), /Other clipping/); assert.deepEqual(scene.volumes, [other]);
  adapter.dispose();
});
test('asynchronous ownership changes stop the slice without overwriting the new owner', () => {
  for (const kind of ['volume', 'task', 'method', 'scene', 'removed', 'profile']) {
    const { Potree, scene, viewer } = fixture(), adapter = createEptPotreeSlicePrototype(viewer, Potree);
    adapter.set(bounds, {}); const owned = scene.volumes[0];
    if (kind === 'volume') scene.addVolume({ clip: true });
    if (kind === 'task') viewer.setClipTask(3);
    if (kind === 'method') viewer.setClipMethod(7);
    if (kind === 'scene') { viewer.scene = {}; viewer.emit('scene_changed'); }
    if (kind === 'removed') scene.removeVolume(owned);
    if (kind === 'profile') { scene.profiles.push({ boxes: [{}] }); viewer.emit('update'); }
    assert.equal(adapter.interrupted, true, kind); assert.equal(scene.volumes.includes(owned), false, kind);
    if (kind === 'task') assert.equal(viewer.task, 3);
    if (kind === 'method') assert.equal(viewer.method, 7);
    if (kind === 'volume') assert.equal(scene.volumes.length, 1);
    adapter.dispose(); assert.equal(viewer.count(), 0); assert.equal(scene.count(), 0);
  }
});
test('removing the clip volume notifies the parent exactly once',()=>{
  const {Potree,scene,viewer}=fixture(),notifications=[];
  const adapter=createEptPotreeSlicePrototype(viewer,Potree,{onInterrupted:reason=>notifications.push(reason)});
  adapter.set(bounds,{});scene.removeVolume(scene.volumes[0]);viewer.emit('update');
  assert.deepEqual(notifications,['clip-ownership-lost']);assert.equal(adapter.interrupted,true);
  adapter.dispose();assert.equal(viewer.count(),0);assert.equal(scene.count(),0);
});
