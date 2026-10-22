import fs from 'node:fs';
import { validateRasterTiffHeader } from '../raster-tiff-header.mjs';

export async function validateMeasurementTiffHeader(filePath) {
  const handle=await fs.promises.open(filePath,'r');
  try {
    const stat=await handle.stat();
    return await validateRasterTiffHeader(async(offset,length)=>{
      const bytes=Buffer.alloc(length),result=await handle.read(bytes,0,length,offset);
      return bytes.subarray(0,result.bytesRead);
    },stat.size);
  } finally {await handle.close();}
}
