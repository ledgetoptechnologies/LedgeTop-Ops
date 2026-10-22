export const DIRECT_POINT_PICK_WINDOW = 11;
const MAX_DIRECT_POINT_PICK_WINDOW = 31;

function finiteVector3(value) {
  return value && [value.x, value.y, value.z].every(Number.isFinite);
}

export function directPointPickThreshold({ camera, points, viewportHeight, pickWindow = DIRECT_POINT_PICK_WINDOW }) {
  if (!camera?.isPerspectiveCamera || !points?.isPoints || !points.geometry) return null;
  const height = Number(viewportHeight);
  const windowPixels = Math.max(1, Math.min(MAX_DIRECT_POINT_PICK_WINDOW, Number(pickWindow) || DIRECT_POINT_PICK_WINDOW));
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(camera.fov) || camera.fov <= 0 || camera.fov >= 180) return null;
  if (!points.geometry.boundingSphere) points.geometry.computeBoundingSphere();
  const center = points.geometry.boundingSphere?.center;
  if (!finiteVector3(center)) return null;
  points.updateWorldMatrix(true, false);
  const worldCenter = center.clone().applyMatrix4(points.matrixWorld);
  const forward = worldCenter.clone();
  camera.getWorldDirection(forward);
  const depth = worldCenter.clone().sub(camera.position).dot(forward);
  const zoom = Number(camera.zoom);
  if (!Number.isFinite(depth) || depth <= 0 || !Number.isFinite(zoom) || zoom <= 0) return null;
  const worldUnitsPerPixel = 2 * depth * Math.tan(camera.fov * Math.PI / 360) / zoom / height;
  const threshold = worldUnitsPerPixel * windowPixels / 2;
  return Number.isFinite(threshold) && threshold > 0 ? threshold : null;
}

export function pickDirectPointSurface({ raycaster, camera, points, ndc, viewportHeight, pickWindow = DIRECT_POINT_PICK_WINDOW }) {
  if (!raycaster?.setFromCamera || !camera || !points?.isPoints || points.visible === false || !ndc) return null;
  const threshold = directPointPickThreshold({ camera, points, viewportHeight, pickWindow });
  if (!threshold) return null;
  const pointParams = raycaster.params.Points || (raycaster.params.Points = { threshold: 1 });
  const previousThreshold = pointParams.threshold;
  try {
    pointParams.threshold = threshold;
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(points, false).find((item) => finiteVector3(item.point));
    return hit ? hit.point.clone() : null;
  } finally {
    pointParams.threshold = previousThreshold;
  }
}
