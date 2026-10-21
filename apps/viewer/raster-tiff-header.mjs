// Inspect raw first-IFD declarations before GeoTIFF can allocate eager fields or
// DeferredArray backing storage. Measurement calculations use only image 0.
export async function validateRasterTiffHeader(readBytes, totalBytes) {
  const fail=()=>{throw Object.assign(new Error('measurement_raster_metadata_limit'),{code:'measurement_raster_metadata_limit'});};
  const size=totalBytes;
  if(!Number.isSafeInteger(size)||size<16)fail();
  {
    const read=async(offset,length)=>{
      if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0||offset+length>size)fail();
      const bytes=await readBytes(offset,length);if(!(bytes instanceof Uint8Array)||bytes.byteLength!==length)fail();return new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
    };
    const header=await read(0,16),order=String.fromCharCode(header.getUint8(0),header.getUint8(1));
    if(!['II','MM'].includes(order))fail();
    const little=order==='II',u16=(b,o)=>b.getUint16(o,little),u32=(b,o)=>b.getUint32(o,little),u64=(b,o)=>Number(b.getBigUint64(o,little));
    const magic=u16(header,2),big=magic===43;
    if(magic!==42&&!big)fail();if(big&&(u16(header,4)!==8||u16(header,6)!==0))fail();
    const offset=big?u64(header,8):u32(header,4),countSize=big?8:2,entrySize=big?20:12,inline=big?8:4;
    const countHeader=await read(offset,countSize),count=big?u64(countHeader,0):u16(countHeader,0);
    if(!Number.isSafeInteger(count)||count<=0||count>256)fail();
    const entries=await read(offset+countSize,count*entrySize+inline),sizes={1:1,2:1,3:2,4:4,5:8,6:1,7:1,8:2,9:4,10:8,11:4,12:8,13:4,16:8,17:8,18:8};
    let total=0;const tags=new Set();
    for(let i=0;i<count;i++){
      const p=i*entrySize,tag=u16(entries,p),type=u16(entries,p+2),items=big?u64(entries,p+4):u32(entries,p+4),bytes=items*sizes[type];
      if(tags.has(tag)||!Number.isSafeInteger(items)||items<0||items>1_000_000||!Number.isSafeInteger(bytes)||bytes>8*1024*1024)fail();tags.add(tag);
      total+=bytes;if(total>32*1024*1024)fail();
      if(bytes>inline){const start=big?u64(entries,p+12):u32(entries,p+8);if(!Number.isSafeInteger(start)||start<0||start+bytes>size)fail();}
    }
    return true;
  }
}
