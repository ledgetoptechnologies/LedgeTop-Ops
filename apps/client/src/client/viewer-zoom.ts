export interface ViewerPoint { x: number; y: number; }
export interface ViewerBounds { width: number; height: number; }

/** Keep the image coordinate under the pointer stable while scaling. */
export function pointerAnchoredOffset(
  currentScale: number,
  nextScale: number,
  currentOffset: ViewerPoint,
  pointerFromCenter: ViewerPoint,
): ViewerPoint {
  if (nextScale <= 1) return { x: 0, y: 0 };
  const ratio = nextScale / currentScale;
  return {
    x: currentOffset.x + (1 - ratio) * (pointerFromCenter.x - currentOffset.x),
    y: currentOffset.y + (1 - ratio) * (pointerFromCenter.y - currentOffset.y),
  };
}

/** Keep the fitted image footprint intersecting the visible media stage. */
export function constrainViewerOffset(scale: number, offset: ViewerPoint, bounds: ViewerBounds): ViewerPoint {
  if (scale <= 1 || bounds.width <= 0 || bounds.height <= 0) return { x: 0, y: 0 };
  const maxX = bounds.width * (scale - 1) / 2;
  const maxY = bounds.height * (scale - 1) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, offset.x)),
    y: Math.max(-maxY, Math.min(maxY, offset.y)),
  };
}
