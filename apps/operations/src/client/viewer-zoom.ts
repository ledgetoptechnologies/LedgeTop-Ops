export interface ViewerPoint { x: number; y: number; }

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
