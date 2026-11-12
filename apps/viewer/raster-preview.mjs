// Display-only sampling. Native measurement and detail tiles never use this
// raster. Output resampling alone does not bound GeoTIFF's input allocation.
import { rasterDecodedBlockBytes, validateRasterEncodedBlocks } from './raster-source-metadata.mjs';

export const PREVIEW_SOURCE_PIXELS = 1024 * 1024;
export const PREVIEW_SAMPLE_DIM = 8;
export const PREVIEW_WINDOW_DIM = 256;
export const PREVIEW_RENDER_DIM = 1200;
export const PREVIEW_MAX_READ_PIXELS = 4 * 1024 * 1024;
export const PREVIEW_MAX_BLOCK_BYTES = 64 * 1024 * 1024;
export const PREVIEW_MAX_ESTIMATED_BLOCK_BYTES = 256 * 1024 * 1024;

export function fitPreviewDimensions(width, height, maxDim) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw Error('invalid_preview_dimensions');
  }
  const scale = Math.min(1, maxDim / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function selectPreviewImage(images) {
  if (!images.length) throw Error('preview_source_missing');
  let best = null, smallest = null;
  for (const image of images) {
    const w = image.getWidth(), h = image.getHeight(), area = w * h;
    if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0 || !Number.isSafeInteger(area)) {
      throw Error('invalid_preview_dimensions');
    }
    if (!smallest || area < smallest.area) smallest = { image, area };
    if (area <= PREVIEW_SOURCE_PIXELS && (!best || area > best.area)) best = { image, area };
  }
  return (best || smallest).image;
}

export async function readPreviewRaster(images, { isDem = false, pool, signal } = {}) {
  const image = selectPreviewImage(images), w = image.getWidth(), h = image.getHeight();
  if (!Number.isSafeInteger(w) || !Number.isSafeInteger(h) || w <= 0 || h <= 0) throw Error('invalid_preview_dimensions');
  if (!isDem && w * h > PREVIEW_SOURCE_PIXELS) return { raster: null, w: 0, h: 0, sparse: true };
  const unavailable = () => ({ raster: null, w: 0, h: 0, sparse: true, unavailable: true });
  const blockBytes = rasterDecodedBlockBytes(image);
  if (!Number.isFinite(blockBytes) || blockBytes <= 0 || blockBytes > PREVIEW_MAX_BLOCK_BYTES) return unavailable();
  await validateRasterEncodedBlocks(image, { maxBlockBytes: PREVIEW_MAX_BLOCK_BYTES });
  const samples = Array.from({ length: isDem ? 1 : Math.min(4, image.getSamplesPerPixel()) }, (_, i) => i);
  if (!samples.length) throw Error('preview_no_samples');
  if (w * h <= PREVIEW_SOURCE_PIXELS) {
    const raster = await image.readRasters({ samples, pool, signal, interleave: false });
    return { raster, w: raster.width, h: raster.height, sparse: false };
  }

  const target = fitPreviewDimensions(w, h, PREVIEW_SAMPLE_DIM), groups = new Map();
  for (let y = 0; y < target.height; y++) {
    for (let x = 0; x < target.width; x++) {
      const sx = Math.min(w - 1, Math.floor((x + .5) * w / target.width));
      const sy = Math.min(h - 1, Math.floor((y + .5) * h / target.height));
      const key = `${Math.floor(sx / PREVIEW_WINDOW_DIM)},${Math.floor(sy / PREVIEW_WINDOW_DIM)}`;
      let group = groups.get(key);
      if (!group) {
        group = { minX: sx, maxX: sx, minY: sy, maxY: sy, points: [] };
        groups.set(key, group);
      }
      group.minX = Math.min(group.minX, sx);
      group.maxX = Math.max(group.maxX, sx);
      group.minY = Math.min(group.minY, sy);
      group.maxY = Math.max(group.maxY, sy);
      group.points.push({ x, y, sx, sy });
    }
  }
  const tileW = image.getTileWidth(), tileH = image.getTileHeight();
  if (!Number.isSafeInteger(tileW) || !Number.isSafeInteger(tileH) || tileW <= 0 || tileH <= 0) return unavailable();
  const windows = [...groups.values()];
  const windowPixels = windows.reduce((sum, g) => sum + (g.maxX - g.minX + 1) * (g.maxY - g.minY + 1), 0);
  // Count repeated block touches too: the decoder need not retain a block
  // between these sequential reads. This bounds work, not just output size.
  const blockTouches = windows.reduce((sum, g) => sum
    + (Math.floor(g.maxX / tileW) - Math.floor(g.minX / tileW) + 1)
    * (Math.floor(g.maxY / tileH) - Math.floor(g.minY / tileH) + 1), 0);
  if (groups.size > PREVIEW_SAMPLE_DIM ** 2 || windowPixels > PREVIEW_MAX_READ_PIXELS
    || !Number.isSafeInteger(blockTouches) || blockTouches * blockBytes > PREVIEW_MAX_ESTIMATED_BLOCK_BYTES) return unavailable();
  const result = samples.map(sample => image.getArrayForSample(sample, target.width * target.height));
  for (const group of groups.values()) {
    if (signal?.aborted) throw new DOMException('The viewer load was cancelled.', 'AbortError');
    const window = [group.minX, group.minY, group.maxX + 1, group.maxY + 1];
    const raster = await image.readRasters({ window, samples: [...samples], pool, signal, interleave: false });
    const rw = window[2] - window[0];
    for (const point of group.points) {
      const from = (point.sy - window[1]) * rw + point.sx - window[0];
      const to = point.y * target.width + point.x;
      for (let i = 0; i < result.length; i++) result[i][to] = raster[i][from];
    }
  }
  return { raster: result, w: target.width, h: target.height, sparse: true };
}
