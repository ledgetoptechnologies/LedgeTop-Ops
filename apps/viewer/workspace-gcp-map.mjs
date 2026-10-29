// Site-local camera map. No external map tiles or location network requests.
export const feetToMeters = feet => Number(feet) * 0.3048;
export function gcpMapPositions(point, images, radiusM) {
  const lat = Number(point?.latitude), lon = Number(point?.longitude), radius = Number(radiusM);
  if (point?.latitude == null || point?.longitude == null || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || !Number.isFinite(radius) || radius <= 0) return null;
  const longitudeScale = Math.cos(lat * Math.PI / 180);
  const candidates = (images || []).filter(image => image.latitude != null && image.longitude != null && Number.isFinite(Number(image.latitude)) && Number.isFinite(Number(image.longitude)) && Math.abs(Number(image.latitude)) <= 90 && Math.abs(Number(image.longitude)) <= 180).map(image => {
    const deltaLon = ((Number(image.longitude) - lon + 540) % 360) - 180;
    return {...image, east: deltaLon * longitudeScale * 111195, north: (Number(image.latitude) - lat) * 111195};
  });
  const extent = candidates.reduce((max, image) => Math.max(max, Math.abs(image.east), Math.abs(image.north)), Math.max(radius, 1));
  const scale = 132 / extent;
  return {radius: +(radius * scale).toFixed(2), cameras: candidates.map(image => ({...image, x: +(150 + image.east * scale).toFixed(2), y: +(150 - image.north * scale).toFixed(2)}))};
}
