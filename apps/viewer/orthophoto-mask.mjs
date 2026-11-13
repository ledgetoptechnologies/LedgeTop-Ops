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

// Interpolate premultiplied colors so transparent black pixels do not darken
// the visible edge when neighboring independently rendered tiles meet.
export function maskedRgbaBilinear(red,green,blue,alpha,indices,weights,{associated=false}={}){
  let coverage=0,r=0,g=0,b=0;
  for(let i=0;i<indices.length;i++){const index=indices[i],weight=weights[i]*Math.max(0,Math.min(255,alpha[index]))/255,colorWeight=associated?weights[i]:weight;coverage+=weight;r+=red[index]*colorWeight;g+=green[index]*colorWeight;b+=blue[index]*colorWeight;}
  if(coverage<=1e-12)return {r:0,g:0,b:0,a:0};
  return {r:r/coverage,g:g/coverage,b:b/coverage,a:Math.round(255*Math.min(1,coverage))};
}
