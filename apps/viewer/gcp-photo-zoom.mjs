// Image size changes only the display; saved pixel coordinates remain native.
export function gcpPhotoWidth({naturalWidth,naturalHeight,viewportWidth,viewportHeight,zoom=1}){
  if(![naturalWidth,naturalHeight,viewportWidth,viewportHeight,zoom].every(Number.isFinite)||Math.min(naturalWidth,naturalHeight,viewportWidth,viewportHeight,zoom)<=0)return null;
  const base=Math.min(naturalWidth,viewportWidth,viewportHeight*naturalWidth/naturalHeight);
  return base*Math.max(1,Math.min(8,zoom));
}

// Coordinates are stored to hundredths; the rounded value must stay inside
// the image even when the pointer is exactly at the right or bottom edge.
export function gcpRoundedPixel(value,dimension){
  if(!Number.isFinite(value)||!Number.isSafeInteger(dimension)||dimension<=0)return null;
  return Math.max(0,Math.min(Math.ceil(dimension*100)-1,Math.round(value*100)))/100;
}
