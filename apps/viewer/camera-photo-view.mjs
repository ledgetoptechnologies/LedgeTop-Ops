export const PHOTO_MIN_SCALE = 1;
export const PHOTO_MAX_SCALE = 40;

function finitePositive(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedScale(value) {
  const parsed = Number(value);
  return Math.min(PHOTO_MAX_SCALE, Math.max(PHOTO_MIN_SCALE, Number.isFinite(parsed) ? parsed : PHOTO_MIN_SCALE));
}

export function fitPhotoBox({ naturalWidth, naturalHeight, maxWidth, maxHeight } = {}) {
  const sourceWidth = finitePositive(naturalWidth, 4);
  const sourceHeight = finitePositive(naturalHeight, 3);
  const widthLimit = finitePositive(maxWidth);
  const heightLimit = finitePositive(maxHeight);
  if (!widthLimit || !heightLimit) return { width: 0, height: 0, aspectRatio: sourceWidth / sourceHeight };
  const aspectRatio = sourceWidth / sourceHeight;
  const width = Math.min(widthLimit, heightLimit * aspectRatio);
  return { width, height: width / aspectRatio, aspectRatio };
}

export function clampPhotoView(view = {}, bounds = {}) {
  const scale = boundedScale(view.scale);
  const baseWidth = finitePositive(bounds.baseWidth);
  const baseHeight = finitePositive(bounds.baseHeight);
  const viewportWidth = finitePositive(bounds.viewportWidth);
  const viewportHeight = finitePositive(bounds.viewportHeight);
  const maxTx = Math.max(0, (baseWidth * scale - viewportWidth) / 2);
  const maxTy = Math.max(0, (baseHeight * scale - viewportHeight) / 2);
  const requestedTx = Number(view.tx);
  const requestedTy = Number(view.ty);
  return {
    scale,
    tx: maxTx > 0 ? Math.min(maxTx, Math.max(-maxTx, Number.isFinite(requestedTx) ? requestedTx : 0)) : 0,
    ty: maxTy > 0 ? Math.min(maxTy, Math.max(-maxTy, Number.isFinite(requestedTy) ? requestedTy : 0)) : 0,
  };
}

export function zoomPhotoView(view = {}, {
  factor,
  cursorX = 0,
  cursorY = 0,
  ...bounds
} = {}) {
  const current = clampPhotoView(view, bounds);
  const requestedFactor = finitePositive(factor, 1);
  const scale = boundedScale(current.scale * requestedFactor);
  if (scale === current.scale) return current;
  const ratio = scale / current.scale;
  const x = Number.isFinite(Number(cursorX)) ? Number(cursorX) : 0;
  const y = Number.isFinite(Number(cursorY)) ? Number(cursorY) : 0;
  return clampPhotoView({
    scale,
    tx: x - (x - current.tx) * ratio,
    ty: y - (y - current.ty) * ratio,
  }, bounds);
}

export function panPhotoView(view = {}, { dx = 0, dy = 0, ...bounds } = {}) {
  const current = clampPhotoView(view, bounds);
  if (current.scale <= PHOTO_MIN_SCALE) return current;
  return clampPhotoView({
    scale: current.scale,
    tx: current.tx + (Number.isFinite(Number(dx)) ? Number(dx) : 0),
    ty: current.ty + (Number.isFinite(Number(dy)) ? Number(dy) : 0),
  }, bounds);
}
