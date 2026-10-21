export const PHOTO_HEADER_BYTES=256*1024;
const HEADER_BYTES=PHOTO_HEADER_BYTES;
// Read only GPS IFD values within a bounded JPEG APP1 segment. Missing or
// malformed metadata is not a position; horizontal flight direction is never
// inferred from filenames or the order in which photos were selected.
export function parsePhotoExif(input){
  const bytes=input instanceof Uint8Array?input:new Uint8Array(input);
  if(bytes.length<4||bytes.length>HEADER_BYTES||bytes[0]!==255||bytes[1]!==216)return null;
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  let offset=2;
  while(offset+4<=bytes.length){
    if(bytes[offset++]!==255)return null;
    while(bytes[offset]===255)offset++;
    const marker=bytes[offset++];if(marker===0xda||marker===0xd9)return null;
    if(marker===1||(marker>=0xd0&&marker<=0xd7))continue;
    if(offset+2>bytes.length)return null;
    const size=view.getUint16(offset);if(size<2||offset+size>bytes.length)return null;
    const start=offset+2,end=offset+size;offset=end;
    if(marker!==0xe1||end-start<14||String.fromCharCode(...bytes.subarray(start,start+6))!=='Exif\0\0')continue;
    try{
      const base=start+6,little=bytes[base]===73&&bytes[base+1]===73;
      if(!little&&!(bytes[base]===77&&bytes[base+1]===77))return null;
      const bounds=(at,n)=>{if(!Number.isSafeInteger(at)||at<base||at+n>end)throw new Error('truncated EXIF');};
      const u16=at=>{bounds(at,2);return view.getUint16(at,little);},u32=at=>{bounds(at,4);return view.getUint32(at,little);};
      if(u16(base+2)!==42)return null;
      const entries=relative=>{const at=base+relative,count=u16(at);if(count>256)throw new Error('oversized IFD');bounds(at+2,count*12+4);return Array.from({length:count},(_,i)=>at+2+i*12);};
      const root=entries(u32(base+4)),gpsPointer=root.find(at=>u16(at)===0x8825);
      if(gpsPointer===undefined||u16(gpsPointer+2)!==4||u32(gpsPointer+4)!==1)return null;
      const gps=new Map(entries(u32(gpsPointer+8)).map(at=>[u16(at),at]));
      const value=(tag,type,count)=>{const at=gps.get(tag);if(at===undefined||u16(at+2)!==type||u32(at+4)!==count)return null;const length=count*(type===5?8:1),data=length<=4?at+8:base+u32(at+8);bounds(data,length);return data;};
      const text=tag=>{const at=value(tag,2,2);return at===null?null:String.fromCharCode(bytes[at]).toUpperCase();};
      const rationals=(tag,count)=>{const at=value(tag,5,count);if(at===null)return null;const values=[];for(let i=0;i<count;i++){const denominator=u32(at+i*8+4);if(!denominator)return null;values.push(u32(at+i*8)/denominator);}return values;};
      const lat=rationals(2,3),lon=rationals(4,3),latRef=text(1),lonRef=text(3);
      if(!lat||!lon||!['N','S'].includes(latRef)||!['E','W'].includes(lonRef))return null;
      const valid=(v,max)=>v.every(Number.isFinite)&&v[0]<=max&&v[1]<60&&v[2]<60;
      if(!valid(lat,90)||!valid(lon,180))return null;
      const latitude=(lat[0]+lat[1]/60+lat[2]/3600)*(latRef==='S'?-1:1),longitude=(lon[0]+lon[1]/60+lon[2]/3600)*(lonRef==='W'?-1:1);
      if(Math.abs(latitude)>90||Math.abs(longitude)>180)return null;
      const direction=rationals(0x11,1),trueHeading=text(0x10)==='T'&&direction&&direction[0]>=0&&direction[0]<360?direction[0]:null;
      return {latitude,longitude,trueHeading};
    }catch{return null;}
  }
  return null;
}
