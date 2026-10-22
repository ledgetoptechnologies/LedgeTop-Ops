function finiteElevation(value, nodata) {
  return Number.isFinite(value) && value > -1000 && (!Number.isFinite(nodata) || value !== nodata);
}

export function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    const crosses = ((yi > y) !== (yj > y))
      && x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

// Integrate a regularly sampled elevation grid against an explicit horizontal
// reference plane. Bounds are UTM metres: minE/minN/maxE/maxN.
export function integrateElevationVolume({ values, width, height, bounds, polygon, nodata = NaN, reference = 'lowest', customReference = null }) {
  if (!values || width < 1 || height < 1 || polygon?.length < 3) throw new Error('A sampled elevation grid and polygon are required.');
  const cellWidth = (bounds.maxE - bounds.minE) / width;
  const cellHeight = (bounds.maxN - bounds.minN) / height;
  const samples = [];
  for (let row = 0; row < height; row++) {
    const n = bounds.maxN - (row + 0.5) * cellHeight;
    for (let col = 0; col < width; col++) {
      const e = bounds.minE + (col + 0.5) * cellWidth;
      const z = Number(values[row * width + col]);
      if (pointInPolygon(e, n, polygon) && finiteElevation(z, nodata)) samples.push(z);
    }
  }
  if (!samples.length) throw new Error('The polygon does not contain valid elevation samples.');
  let referenceElevation;
  if (reference === 'custom') {
    referenceElevation = Number(customReference);
    if (!Number.isFinite(referenceElevation)) throw new Error('Enter a valid custom reference elevation.');
  } else if (reference === 'average') {
    referenceElevation = samples.reduce((sum, z) => sum + z, 0) / samples.length;
  } else {
    referenceElevation = samples.reduce((lowest, z) => Math.min(lowest, z), Infinity);
  }
  const cellArea = Math.abs(cellWidth * cellHeight);
  let cut = 0, fill = 0;
  for (const z of samples) {
    const delta = z - referenceElevation;
    if (delta >= 0) cut += delta * cellArea;
    else fill += -delta * cellArea;
  }
  return {
    cutM3: cut,
    fillM3: fill,
    netM3: cut - fill,
    referenceElevation,
    sampleCount: samples.length,
    cellAreaM2: cellArea,
  };
}
