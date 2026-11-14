'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {parseOrthophotoJpegSize,readOrthophotoJpegSize,MAX_READ_BYTES}=require('../server/orthophotoJpegMetadata');

function tiff({big=false,little=true,width=321,height=123,type=4,reduced=null,duplicate=false,unknown=false}={}){
  const header=big?16:8,countSize=big?8:2,entrySize=big?20:12,inline=big?8:4;
  const values=[[256,width],[257,height]];
  if(reduced!==null)values.unshift([254,reduced]);
  if(duplicate)values.push([256,width]);if(unknown)values.push([65000,0]);
  const end=header+countSize+values.length*entrySize+inline;
  const bytes=Buffer.alloc(end+32);let external=end;
  const u16=(at,value)=>little?bytes.writeUInt16LE(value,at):bytes.writeUInt16BE(value,at);
  const u32=(at,value)=>little?bytes.writeUInt32LE(value,at):bytes.writeUInt32BE(value,at);
  const u64=(at,value)=>little?bytes.writeBigUInt64LE(BigInt(value),at):bytes.writeBigUInt64BE(BigInt(value),at);
  bytes.write(little?'II':'MM');u16(2,big?43:42);
  if(big){u16(4,8);u16(6,0);u64(8,header);u64(header,values.length);}
  else{u32(4,header);u16(header,values.length);}
  values.forEach(([tag,value],index)=>{
    const at=header+countSize+index*entrySize,valueAt=at+entrySize-inline;
    u16(at,tag);u16(at+2,type);if(big)u64(at+4,1);else u32(at+4,1);
    if(tag===65000){if(big)u64(at+4,999999999);else u32(at+4,999999999);return;}
    if(type===3)u16(valueAt,Number(value));
    else if(type===4)u32(valueAt,Number(value));
    else if(big)u64(valueAt,value);
    else{u32(valueAt,external);u64(external,value);external+=8;}
  });
  return bytes;
}

async function parse(bytes,{short=false}={}){
  let requested=0,calls=0;
  const value=await parseOrthophotoJpegSize(async(offset,length)=>{
    requested+=length;calls++;
    assert.ok(Number.isSafeInteger(offset)&&offset>=0&&offset+length<=bytes.length);
    assert.ok(requested<=MAX_READ_BYTES);assert.ok(length<=MAX_READ_BYTES);
    return bytes.subarray(offset,offset+length-(short?1:0));
  },bytes.length);
  return {value,requested,calls};
}

test('both TIFF sizes and byte orders derive first-IFD scalar dimensions without integrity claim',async()=>{
  for(const big of [false,true])for(const little of [false,true])for(const type of [3,4,16]){
    const {value,requested}=await parse(tiff({big,little,type}));
    assert.deepEqual(value,{width:321,height:123,metadataOnly:true,fullFileIntegrityVerified:false});
    assert.ok(requested<200);
  }
});

test('reduced first IFD rejects instead of silently selecting an overview',async()=>{
  for(const reduced of [1,3,5])await assert.rejects(parse(tiff({big:true,reduced})),{code:'orthophoto_metadata_reduced_image'});
  assert.equal((await parse(tiff({reduced:2}))).value.width,321);
});

test('legacy SubfileType uses its own reduced-image value rather than the new bitmask',async()=>{
  for(const value of [1,2,3,0]){
    const bytes=tiff({reduced:value});bytes.writeUInt16LE(255,10);
    if(value===2)await assert.rejects(parse(bytes),{code:'orthophoto_metadata_reduced_image'});
    else if(value===0)await assert.rejects(parse(bytes),{code:'orthophoto_metadata_legacy_subfile'});
    else assert.equal((await parse(bytes)).value.width,321);
  }
});

test('duplicate dimensions, unsupported scalar type, missing dimension and JPEG oversize reject',async()=>{
  await assert.rejects(parse(tiff({duplicate:true})),{code:'orthophoto_metadata_duplicate_tag'});
  const wrong=tiff();wrong.writeUInt16LE(5,12);
  await assert.rejects(parse(wrong),{code:'orthophoto_metadata_scalar_type'});
  const missing=tiff();missing.writeUInt16LE(65001,22);
  await assert.rejects(parse(missing),{code:'orthophoto_metadata_dimensions'});
  await assert.rejects(parse(tiff({width:65501})),{code:'full_resolution_jpeg_dimension_limit'});
  await assert.rejects(parse(tiff({width:0})),{code:'orthophoto_metadata_dimensions'});
});

test('corrupt offsets, unsafe LONG8 values, excessive entries and short reads are bounded',async()=>{
  const offset=tiff();offset.writeUInt32LE(0xfffffff0,4);
  await assert.rejects(parse(offset),{code:'orthophoto_metadata_offset'});
  const huge=tiff({big:true});huge.writeBigUInt64LE(2n**53n,8);
  await assert.rejects(parse(huge),{code:'orthophoto_metadata_unsafe_integer'});
  await assert.rejects(parse(tiff({big:true,type:16,width:2n**53n})),{code:'orthophoto_metadata_unsafe_integer'});
  const count=tiff();count.writeUInt16LE(4097,8);
  await assert.rejects(parse(count),{code:'orthophoto_metadata_entry_limit'});
  await assert.rejects(parse(tiff(),{short:true}),{code:'orthophoto_metadata_short_read'});
  await assert.rejects(parse(tiff().subarray(0,11)),{code:'orthophoto_metadata_ifd_extent'});
});

test('unknown external field arrays are not read and known scalar external offsets stay bounded',async()=>{
  const {calls}=await parse(tiff({big:true,unknown:true}));assert.equal(calls,4);
  const bad=tiff({type:16});bad.writeUInt32LE(0xfffffff0,18);
  await assert.rejects(parse(bad),{code:'orthophoto_metadata_offset'});
  const count=tiff();count.writeUInt32LE(2,14);
  await assert.rejects(parse(count),{code:'orthophoto_metadata_scalar_type'});
});

test('largest supported BigTIFF table stays under the cumulative 128KiB metadata budget',async()=>{
  const bytes=Buffer.alloc(16+8+4096*20+8);
  bytes.write('II');bytes.writeUInt16LE(43,2);bytes.writeUInt16LE(8,4);
  bytes.writeBigUInt64LE(16n,8);bytes.writeBigUInt64LE(4096n,16);
  for(let tag=0;tag<4096;tag++){
    const at=24+tag*20;bytes.writeUInt16LE(tag,at);
    if([254,255,256,257].includes(tag)){
      bytes.writeUInt16LE(4,at+2);bytes.writeBigUInt64LE(1n,at+4);
      bytes.writeUInt32LE(tag===254?0:tag===255?1:tag===256?20:10,at+12);
    }
  }
  const result=await parse(bytes);assert.equal(result.requested,81944);
  assert.deepEqual(result.value,{width:20,height:10,metadataOnly:true,fullFileIntegrityVerified:false});
});

test('malformed BigTIFF headers and sub-header IFD offsets reject',async()=>{
  const bytes=tiff({big:true});bytes.writeUInt16LE(4,4);
  await assert.rejects(parse(bytes),{code:'orthophoto_metadata_bigtiff_header'});
  const offset=tiff();offset.writeUInt32LE(2,4);
  await assert.rejects(parse(offset),{code:'orthophoto_metadata_first_ifd'});
});

test('adapter requires source byte size and SHA metadata before any filesystem access',async()=>{
  const storage={resolve(){assert.fail('invalid descriptor must not resolve storage');}};
  for(const asset of [null,{rootKey:'models',relativePath:'ortho.tif',byteSize:0,sha256:'a'.repeat(64)},
    {rootKey:'models',relativePath:'ortho.tif',byteSize:100,sha256:'invalid'}])
    await assert.rejects(readOrthophotoJpegSize(storage,asset),{code:'invalid_orthophoto_metadata_source'});
});
