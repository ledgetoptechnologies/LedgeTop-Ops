import * as THREE from 'three';

export function tilesetWorldBounds(renderer) {
  if (!renderer?.group || typeof renderer.getBoundingBox !== 'function') return null;
  const bounds = new THREE.Box3();
  if (!renderer.getBoundingBox(bounds) || bounds.isEmpty()) return null;
  renderer.group.updateWorldMatrix(true, false);
  return bounds.applyMatrix4(renderer.group.matrixWorld);
}

export function homeViewForBounds(bounds) {
  if (!bounds || bounds.isEmpty()) return null;
  const lookAt = bounds.getCenter(new THREE.Vector3());
  const diameter = bounds.getSize(new THREE.Vector3()).length();
  const distance = Math.max(20, diameter * 0.9);
  return {
    position: new THREE.Vector3(
      lookAt.x,
      lookAt.y + distance * 0.55,
      lookAt.z + distance * 0.75,
    ),
    lookAt,
    diameter,
    distance,
  };
}
