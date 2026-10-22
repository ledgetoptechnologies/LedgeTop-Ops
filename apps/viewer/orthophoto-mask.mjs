export function parseFiniteGdalNoData(value) {
  if (typeof value === 'string') value = value.replace(/\0+$/g, '').trim();
  if (value === '' || value === null || value === undefined) return Number.NaN;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

export function isRgbNoData(red, green, blue, noData) {
  return Number.isFinite(noData) && red === noData && green === noData && blue === noData;
}

export function maskedRgbBilinear(red, green, blue, indices, weights, noData) {
  let validWeight = 0, r = 0, g = 0, b = 0;
  const maskEnabled = Number.isFinite(noData);
  for (let i = 0; i < indices.length; i++) {
    const index = indices[i], weight = weights[i];
    if (maskEnabled && isRgbNoData(red[index], green[index], blue[index], noData)) continue;
    validWeight += weight;
    r += red[index] * weight;
    g += green[index] * weight;
    b += blue[index] * weight;
  }
  if (validWeight <= 1e-12) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: r / validWeight,
    g: g / validWeight,
    b: b / validWeight,
    a: maskEnabled ? Math.round(255 * Math.min(1, validWeight)) : 255,
  };
}
