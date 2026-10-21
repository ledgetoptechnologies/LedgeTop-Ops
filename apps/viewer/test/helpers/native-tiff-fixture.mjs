// Minimal genuine TIFF encoder for metadata/decoding regressions. Unlike the
// convenience GeoTIFF writer this can create tiled and multi-strip layouts.
export function nativeTiffFixture({tiled=false,rowsPerStrip=1,width=2,height=2,tileWidth=2,tileLength=2,transform,encodedCountOverride,externalPadding=8192,gdalMetadata,verticalUnit=9001}={}) {
  const entries=[],tag=(id,type,values)=>entries.push({id,type,values:Array.isArray(values)?values:[values]}),sizes={2:1,3:2,4:4,12:8};
  tag(256,4,width);tag(257,4,height);tag(258,3,32);tag(259,3,1);tag(262,3,1);tag(277,3,1);tag(284,3,1);tag(339,3,3);
  const blockW=tiled?tileWidth:width,blockH=tiled?tileLength:rowsPerStrip,cols=Math.ceil(width/blockW),rows=Math.ceil(height/blockH),blocks=[];
  for(let row=0;row<rows;row++)for(let col=0;col<cols;col++){
    const h=tiled?blockH:Math.min(blockH,height-row*blockH),bytes=Buffer.alloc(blockW*h*4);
    for(let y=0;y<h;y++)for(let x=0;x<blockW;x++)bytes.writeFloatLE((row*blockH+y)*width+col*blockW+x+1,(y*blockW+x)*4);
    blocks.push(bytes);
  }
  if(tiled){tag(322,4,tileWidth);tag(323,4,tileLength);}else tag(278,4,rowsPerStrip);
  const offsetsTag=tiled?324:273,countsTag=tiled?325:279;
  tag(offsetsTag,4,blocks.map(()=>0));tag(countsTag,4,blocks.map(b=>encodedCountOverride??b.length));
  if(transform)tag(34264,12,transform);else{tag(33550,12,[1,1,0]);tag(33922,12,[0,0,0,0,height,0]);}
  tag(34735,3,[1,1,0,verticalUnit===null?4:5,1024,0,1,1,1025,0,1,1,3072,0,1,32616,3076,0,1,9001,...(verticalUnit===null?[]:[4099,0,1,verticalUnit])]);
  if(gdalMetadata!==undefined)tag(42112,2,Array.from(Buffer.from(`${gdalMetadata}\0`,'utf8')));
  entries.sort((a,b)=>a.id-b.id);
  let cursor=8+2+entries.length*12+4+externalPadding;
  for(const entry of entries){entry.bytes=entry.values.length*sizes[entry.type];if(entry.bytes>4){entry.offset=cursor;cursor+=entry.bytes;}}
  const offsets=entries.find(e=>e.id===offsetsTag).values;
  for(let i=0;i<blocks.length;i++){offsets[i]=cursor;cursor+=blocks[i].length;}
  const output=Buffer.alloc(cursor);output.write('II');output.writeUInt16LE(42,2);output.writeUInt32LE(8,4);output.writeUInt16LE(entries.length,8);
  for(let i=0;i<entries.length;i++){
    const entry=entries[i],p=10+i*12;output.writeUInt16LE(entry.id,p);output.writeUInt16LE(entry.type,p+2);output.writeUInt32LE(entry.values.length,p+4);
    if(entry.offset)output.writeUInt32LE(entry.offset,p+8);
    entry.values.forEach((v,n)=>{const at=(entry.offset||p+8)+n*sizes[entry.type];if(entry.type===2)output.writeUInt8(v,at);else if(entry.type===3)output.writeUInt16LE(v,at);else if(entry.type===4)output.writeUInt32LE(v,at);else output.writeDoubleLE(v,at);});
  }
  blocks.forEach((block,i)=>block.copy(output,offsets[i]));return output;
}
