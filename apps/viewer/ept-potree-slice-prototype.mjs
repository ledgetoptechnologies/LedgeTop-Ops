import { eptSliceBox } from './ept-slice-geometry.mjs';

// Isolated proof only. Potree's scene owns the clip volume; no source data or
// measurement calculation is modified. A second clipping owner is unsupported.
export function createEptPotreeSlicePrototype(viewer, Potree, { onInterrupted = () => {} } = {}) {
  const scene = viewer?.scene;
  if (!scene || typeof Potree?.BoxVolume !== 'function' || Potree.ClipTask?.SHOW_INSIDE == null
    || Potree.ClipMethod?.INSIDE_ALL == null || !Array.isArray(scene.volumes)
    || !Array.isArray(scene.profiles) || !Array.isArray(scene.polygonClipVolumes))
    throw new Error('Unsupported Potree clipping interface.');
  let volume = null, saved = null, disposed = false, changing = false, interrupted = false;
  const conflict = () => scene.volumes.some(v => v !== volume && v.clip)
    || scene.profiles.some(p => p.boxes?.length) || scene.polygonClipVolumes.some(p => p.initialized);
  function disable({ restore = true } = {}) {
    if (!volume) return;
    const owned = volume; volume = null;
    if (scene.volumes.includes(owned)) scene.removeVolume(owned);
    owned.traverse?.(object => {
      object.geometry?.dispose?.();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) material?.dispose?.();
    });
    if (restore && !conflict() && viewer.scene === scene
      && viewer.getClipTask() === Potree.ClipTask.SHOW_INSIDE
      && viewer.getClipMethod() === Potree.ClipMethod.INSIDE_ALL) {
      changing = true;
      try { viewer.setClipTask(saved.task); viewer.setClipMethod(saved.method); } finally { changing = false; }
    }
    saved = null;
  }
  function checkOwnership() {
    if (changing || !volume) return;
    if (viewer.scene !== scene || !scene.volumes.includes(volume) || !volume.clip || conflict()
      || viewer.getClipTask() !== Potree.ClipTask.SHOW_INSIDE
      || viewer.getClipMethod() !== Potree.ClipMethod.INSIDE_ALL) {
      interrupted = true; disable({ restore: false });
      try { onInterrupted('clip-ownership-lost'); } catch { /* Never disrupt Potree's event loop. */ }
    }
  }
  const bindings = [[scene, 'volume_added'], [scene, 'volume_removed'], [scene, 'profile_added'],
    [scene, 'polygon_clip_volume_added'], [viewer, 'cliptask_changed'], [viewer, 'clipmethod_changed'],
    [viewer, 'scene_changed'], [viewer, 'update']];
  for (const [target, type] of bindings) target.addEventListener(type, checkOwnership);
  function set(bounds, settings) {
    if (disposed) throw new Error('Slice adapter is disposed.');
    checkOwnership();
    if (viewer.scene !== scene || conflict()) { disable({ restore: false }); throw new Error('Other clipping is active.'); }
    const box = eptSliceBox(bounds, settings);
    if (!volume) {
      saved = { task: viewer.getClipTask(), method: viewer.getClipMethod() };
      volume = new Potree.BoxVolume({ clip: true });
      volume.clip = true; volume.modifieable = false; volume.visible = false;
      volume.raycast = () => {};
      changing = true;
      try { scene.addVolume(volume); viewer.setClipTask(Potree.ClipTask.SHOW_INSIDE);
        viewer.setClipMethod(Potree.ClipMethod.INSIDE_ALL); } finally { changing = false; }
    }
    volume.position.set(...box.center); volume.scale.set(...box.size); volume.updateMatrixWorld(true);
    interrupted = false; return box;
  }
  return { set, disable, get interrupted() { return interrupted; },
    dispose() { if (!disposed) { disable(); for (const [target, type] of bindings) target.removeEventListener(type, checkOwnership); } disposed = true; } };
}
