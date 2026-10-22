// GeoTIFF 3 exposes ImageFileDirectory accessors, not plain tag properties.
// Keep plain dictionaries supported for small isolated geometry fixtures only.
export function rasterDirectoryValue(directory, tag) {
  return typeof directory?.getValue === 'function' ? directory.getValue(tag) : directory?.[tag];
}

export function rasterDecodedBlockBytes(image) {
  const directory=image.getFileDirectory?.() || image.fileDirectory;
  const value=tag=>rasterDirectoryValue(directory,tag);
  const bits=value('BitsPerSample') || [64];
  const tiled=image.isTiled ?? Boolean(value('TileWidth'));
  const width=tiled?value('TileWidth'):image.getWidth();
  // TIFF tiles include padding at the bottom edge; strips can be truncated.
  const height=tiled?value('TileLength'):Math.min(value('RowsPerStrip') || image.getHeight(),image.getHeight());
  return Number(width)*Number(height)*Number(value('SamplesPerPixel') || 1)*Math.max(...bits)/8;
}

export async function validateRasterEncodedBlocks(image,{maxBlockBytes,maxBlocks=1_000_000}={}) {
  const directory=image.getFileDirectory?.() || image.fileDirectory;
  const value=tag=>rasterDirectoryValue(directory,tag);
  const tiled=image.isTiled ?? Boolean(value('TileWidth'));
  const width=tiled?value('TileWidth'):image.getWidth();
  const height=tiled?value('TileLength'):Math.min(value('RowsPerStrip') || image.getHeight(),image.getHeight());
  const blocks=Math.ceil(image.getWidth()/width)*Math.ceil(image.getHeight()/height)*(value('PlanarConfiguration')===2?(value('SamplesPerPixel')||1):1);
  const fail=()=>{throw Object.assign(new Error('measurement_raster_block_too_large'),{code:'measurement_raster_block_too_large'});};
  if(!Number.isSafeInteger(blocks)||blocks<=0||blocks>maxBlocks)fail();
  const tag=tiled?'TileByteCounts':'StripByteCounts';
  const counts=typeof directory?.loadValue==='function'?await directory.loadValue(tag):value(tag);
  if(counts===undefined){if(typeof directory?.loadValue==='function')fail();return;}
  const values=typeof counts==='number'?[counts]:counts;
  if(values.length!==blocks||values.length>maxBlocks)fail();
  // Zero byte counts are valid sparse TIFF blocks, decoded as NoData by GeoTIFF.
  for(const count of values)if(!Number.isSafeInteger(Number(count))||Number(count)<0||Number(count)>maxBlockBytes)fail();
}
