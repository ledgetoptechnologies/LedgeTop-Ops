'use strict';

const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const MAX_READ_BYTES=128*1024,MAX_ENTRIES=4096;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const need=(value,code)=>{if(!value)fail(code);};

// Only first-IFD scalar dimensions/flags. Unknown fields, overviews, image blocks
// and pixel arrays are never followed/read. This is NOT full-file integrity.
async function parseOrthophotoJpegSize(readBytes,totalBytes){
  need(typeof readBytes==='function'&&Number.isSafeInteger(totalBytes)&&totalBytes>0,
    'invalid_orthophoto_metadata_size');
  let budget=0;
  async function read(offset,length){
    need(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(length)&&length>=0&&
      offset<=totalBytes-length,'orthophoto_metadata_offset');
    budget+=length;need(budget<=MAX_READ_BYTES,'orthophoto_metadata_read_budget');
    const bytes=await readBytes(offset,length);
    need(Buffer.isBuffer(bytes)&&bytes.length===length,'orthophoto_metadata_short_read');return bytes;
  }
  const header=await read(0,8),order=header.toString('ascii',0,2);
  need(order==='II'||order==='MM','orthophoto_metadata_byte_order');
  const little=order==='II';
  const u16=(b,at)=>little?b.readUInt16LE(at):b.readUInt16BE(at);
  const u32=(b,at)=>little?b.readUInt32LE(at):b.readUInt32BE(at);
  const u64=(b,at)=>{
    const value=little?b.readBigUInt64LE(at):b.readBigUInt64BE(at);
    need(value<=BigInt(Number.MAX_SAFE_INTEGER),'orthophoto_metadata_unsafe_integer');return Number(value);
  };
  const version=u16(header,2),big=version===43;
  need(version===42||big,'orthophoto_metadata_tiff_version');
  let first,headerSize=8,countSize=2,entrySize=12,inline=4;
  if(big){
    need(u16(header,4)===8&&u16(header,6)===0,'orthophoto_metadata_bigtiff_header');
    first=u64(await read(8,8),0);headerSize=16;countSize=8;entrySize=20;inline=8;
  }else first=u32(header,4);
  need(first>=headerSize,'orthophoto_metadata_first_ifd');
  const countBuffer=await read(first,countSize),count=big?u64(countBuffer,0):u16(countBuffer,0);
  need(count<=MAX_ENTRIES,'orthophoto_metadata_entry_limit');
  const start=first+countSize,length=count*entrySize;
  need(Number.isSafeInteger(start)&&start<=totalBytes-length-inline,'orthophoto_metadata_ifd_extent');
  const entries=await read(start,length),seen=new Set();let width,height,reduced=0,legacySubfile=null;
  for(let at=0;at<entries.length;at+=entrySize){
    const tag=u16(entries,at),type=u16(entries,at+2);
    need(!seen.has(tag),'orthophoto_metadata_duplicate_tag');seen.add(tag);
    if(![254,255,256,257].includes(tag))continue;
    const n=big?u64(entries,at+4):u32(entries,at+4);
    need(n===1&&[3,4,16].includes(type),'orthophoto_metadata_scalar_type');
    const size=type===3?2:type===4?4:8,valueAt=at+entrySize-inline;
    const bytes=size<=inline?entries.subarray(valueAt,valueAt+size):
      await read(u32(entries,valueAt),size);
    const value=type===3?u16(bytes,0):type===4?u32(bytes,0):u64(bytes,0);
    if(tag===256)width=value;else if(tag===257)height=value;else if(tag===255)legacySubfile=value;else reduced=value;
  }
  need(reduced%2===0,'orthophoto_metadata_reduced_image');
  need(legacySubfile!==2,'orthophoto_metadata_reduced_image');
  need(legacySubfile===null||legacySubfile===1||legacySubfile===3,'orthophoto_metadata_legacy_subfile');
  need(Number.isSafeInteger(width)&&width>0&&Number.isSafeInteger(height)&&height>0,
    'orthophoto_metadata_dimensions');
  need(width<=65500&&height<=65500,'full_resolution_jpeg_dimension_limit');
  return {width,height,metadataOnly:true,fullFileIntegrityVerified:false};
}

const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.uid,s.gid,s.mode,s.nlink].join(':');

async function readOrthophotoJpegSize(storage,asset){
  need(asset&&typeof asset.rootKey==='string'&&asset.rootKey&&typeof asset.relativePath==='string'&&
    asset.relativePath&&Number.isSafeInteger(asset.byteSize)&&asset.byteSize>0&&
    typeof asset.sha256==='string'&&/^[a-f0-9]{64}$/.test(asset.sha256),
    'invalid_orthophoto_metadata_source');
  need(Number.isInteger(constants.O_NOFOLLOW)&&Number.isInteger(constants.O_NONBLOCK),
    'orthophoto_metadata_nofollow_unavailable');
  const absolute=storage.resolve(asset.rootKey,asset.relativePath,{mustExist:true});
  need(typeof absolute==='string'&&path.isAbsolute(absolute)&&path.normalize(absolute)===absolute&&
    await fs.realpath(absolute)===absolute,'orthophoto_metadata_canonical_path');
  const before=await fs.lstat(absolute,{bigint:true});
  need(before.isFile()&&before.nlink===1n&&before.size===BigInt(asset.byteSize),
    'orthophoto_metadata_source_changed');
  const handle=await fs.open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    need(stamp(await handle.stat({bigint:true}))===stamp(before),'orthophoto_metadata_source_changed');
    const result=await parseOrthophotoJpegSize(async(offset,length)=>{
      const buffer=Buffer.alloc(length),{bytesRead}=await handle.read(buffer,0,length,offset);
      return buffer.subarray(0,bytesRead);
    },asset.byteSize);
    need(stamp(await handle.stat({bigint:true}))===stamp(before)&&
      stamp(await fs.lstat(absolute,{bigint:true}))===stamp(before)&&
      await fs.realpath(absolute)===absolute,'orthophoto_metadata_source_changed');
    return result; // sha256 format checked above; full hashing belongs to worker.
  }finally{await handle.close();}
}

module.exports={readOrthophotoJpegSize,parseOrthophotoJpegSize,MAX_READ_BYTES,MAX_ENTRIES};
