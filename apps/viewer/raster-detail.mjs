// Select by real overview dimensions, not the IFD's position in the file.
// Keep at least one source sample per display pixel where the source permits.
export function selectRasterDetailImage(images, { sourceWidth, sourceHeight, windowWidth, windowHeight, tileWidth, tileHeight }) {
  if (!images.length) throw new Error('raster_images_missing');
  const candidates = images.map(image => ({
    image,
    width: windowWidth * image.getWidth() / sourceWidth,
    height: windowHeight * image.getHeight() / sourceHeight,
    area: image.getWidth() * image.getHeight(),
  }));
  // One source pixel of tolerance covers rounded overview dimensions without
  // promoting an entire request to a much larger level for a fractional pixel.
  const sufficient = candidates.filter(candidate => candidate.width + 1 >= tileWidth && candidate.height + 1 >= tileHeight);
  // At native-pixel zoom no overview has enough samples; use the base image.
  const selected = sufficient.length
    ? sufficient.reduce((best, next) => next.area < best.area ? next : best)
    : candidates.reduce((best, next) => next.area > best.area ? next : best);
  return selected.image;
}
