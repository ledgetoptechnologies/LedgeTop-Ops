'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const unzipper = require('unzipper');
const { safeRelativePath } = require('./processingSecurity');

const CRC_TABLE=(()=>{const table=new Uint32Array(256);for(let value=0;value<256;value++){let crc=value;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);table[value]=crc>>>0;}return table;})();
const updateCrc32=(crc,chunk)=>{for(const byte of chunk)crc=CRC_TABLE[(crc^byte)&0xff]^(crc>>>8);return crc>>>0;};
const archiveError=(message)=>Object.assign(new Error(message),{code:'invalid_archive'});
function readAt(fd,offset,length){if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<0)throw archiveError('archive contains an invalid offset');const buffer=Buffer.alloc(length);let read=0;while(read<length){const count=fs.readSync(fd,buffer,read,length-read,offset+read);if(count<=0)throw archiveError('archive is truncated');read+=count;}return buffer;}
function preflightEndRecord(fd,size,maxEntries){if(size<22)throw archiveError('archive is truncated');const tailLength=Math.min(size,65557),tail=readAt(fd,size-tailLength,tailLength);let at=-1;for(let index=tail.length-22;index>=0;index--){if(tail.readUInt32LE(index)===0x06054b50&&index+22+tail.readUInt16LE(index+20)===tail.length){at=index;break;}}if(at<0)throw archiveError('archive end record is missing');const disk=tail.readUInt16LE(at+4),diskStart=tail.readUInt16LE(at+6),recordsOnDisk=tail.readUInt16LE(at+8),records=tail.readUInt16LE(at+10),absolute=size-tailLength+at;if(disk!==0||diskStart!==0)throw archiveError('archive spans multiple disks');if(records===0xffff||recordsOnDisk===0xffff){if(maxEntries<0xffff)throw archiveError('archive entry limit exceeded');if(absolute<20)throw archiveError('archive ZIP64 locator is missing');const locator=readAt(fd,absolute-20,20);if(locator.readUInt32LE(0)!==0x07064b50||locator.readUInt32LE(4)!==0||locator.readUInt32LE(16)!==1)throw archiveError('archive ZIP64 locator is invalid');const zip64Offset=Number(locator.readBigUInt64LE(8));if(!Number.isSafeInteger(zip64Offset))throw archiveError('archive ZIP64 offset exceeds the safe limit');const record=readAt(fd,zip64Offset,56);if(record.readUInt32LE(0)!==0x06064b50||record.readUInt32LE(16)!==0||record.readUInt32LE(20)!==0)throw archiveError('archive ZIP64 end record is invalid');const onDisk=record.readBigUInt64LE(24),total=record.readBigUInt64LE(32);if(onDisk!==total||total>BigInt(Number.MAX_SAFE_INTEGER)||total>BigInt(maxEntries))throw archiveError('archive entry limit exceeded');return {entries:Number(total),tailSize:size-absolute};}if(recordsOnDisk!==records)throw archiveError('archive spans multiple disks');if(records>maxEntries)throw archiveError('archive entry limit exceeded');return {entries:records,tailSize:size-absolute};}
// Pass only the already-validated EOCD and comment to unzipper. Its signature
// match offset is chunk-relative; searching a 65KiB tail across 64KiB reads
// otherwise miscomputes the preceding ZIP64 locator for valid large archives.
function descriptorSource(fd,size){
  if(!Number.isSafeInteger(size)||size<0)throw archiveError('archive size is invalid');
  return{size:()=>Promise.resolve(size),stream(offset,length){const start=Number(offset),hasLength=length!==undefined&&length!==null,span=hasLength?Number(length):null;if(!Number.isSafeInteger(start)||start<0||start>size||hasLength&&(!Number.isSafeInteger(span)||span<=0||start>=size||!Number.isSafeInteger(start+span)))throw archiveError('archive contains an invalid range');const options={autoClose:true,start};if(hasLength)options.end=Math.min(size-1,start+span);let duplicate=null;try{duplicate=fs.openSync(`/proc/self/fd/${fd}`,fs.constants.O_RDONLY|fs.constants.O_CLOEXEC);options.fd=duplicate;return fs.createReadStream(null,options);}catch(error){if(duplicate!==null)try{fs.closeSync(duplicate);}catch{}if(error.code==='invalid_archive')throw error;throw archiveError('archive contains an invalid range');}}};
}
function zip64LocalSizes(rawCompressed,rawUncompressed,extra){let cursor=0,compressed=rawCompressed,uncompressed=rawUncompressed;while(cursor+4<=extra.length){const id=extra.readUInt16LE(cursor),length=extra.readUInt16LE(cursor+2),body=extra.subarray(cursor+4,cursor+4+length);if(cursor+4+length>extra.length)throw archiveError('archive local extra field is truncated');if(id===1){let at=0;if(rawUncompressed===0xffffffff){if(at+8>body.length)throw archiveError('archive ZIP64 size is missing');uncompressed=Number(body.readBigUInt64LE(at));at+=8;}if(rawCompressed===0xffffffff){if(at+8>body.length)throw archiveError('archive ZIP64 size is missing');compressed=Number(body.readBigUInt64LE(at));}break;}cursor+=4+length;}if(!Number.isSafeInteger(compressed)||!Number.isSafeInteger(uncompressed))throw archiveError('archive ZIP64 size exceeds the safe limit');return{compressed,uncompressed};}
function validateLocalHeader(fd,entry){const fixed=readAt(fd,Number(entry.offsetToLocalFileHeader),30);if(fixed.readUInt32LE(0)!==0x04034b50)throw archiveError('archive local header signature is invalid');const flags=fixed.readUInt16LE(6),method=fixed.readUInt16LE(8),crc=fixed.readUInt32LE(14),rawCompressed=fixed.readUInt32LE(18),rawUncompressed=fixed.readUInt32LE(22),nameLength=fixed.readUInt16LE(26),extraLength=fixed.readUInt16LE(28),tail=readAt(fd,Number(entry.offsetToLocalFileHeader)+30,nameLength+extraLength),name=tail.subarray(0,nameLength),extra=tail.subarray(nameLength);if(!name.equals(entry.pathBuffer)||flags!==entry.flags||method!==entry.compressionMethod)throw archiveError('archive local and central headers disagree');const sizes=zip64LocalSizes(rawCompressed,rawUncompressed,extra),descriptor=Boolean(flags&0x08),zip64Descriptor=rawCompressed===0xffffffff||rawUncompressed===0xffffffff;if(!descriptor&&(crc!==entry.crc32||sizes.compressed!==entry.compressedSize||sizes.uncompressed!==entry.uncompressedSize))throw archiveError('archive local and central headers disagree');if(descriptor){const compressedConflict=rawCompressed===0xffffffff?sizes.compressed!==0&&sizes.compressed!==entry.compressedSize:rawCompressed!==0&&rawCompressed!==entry.compressedSize,uncompressedConflict=rawUncompressed===0xffffffff?sizes.uncompressed!==0&&sizes.uncompressed!==entry.uncompressedSize:rawUncompressed!==0&&rawUncompressed!==entry.uncompressedSize;if(crc!==0&&crc!==entry.crc32||compressedConflict||uncompressedConflict)throw archiveError('archive local and central headers disagree');let dataOffset=Number(entry.offsetToLocalFileHeader)+30+nameLength+extraLength+Number(entry.compressedSize),data=readAt(fd,dataOffset,zip64Descriptor?24:16),cursor=0;if(data.readUInt32LE(0)===0x08074b50)cursor=4;const descriptorCrc=data.readUInt32LE(cursor);cursor+=4;let compressed,uncompressed;if(zip64Descriptor){compressed=Number(data.readBigUInt64LE(cursor));uncompressed=Number(data.readBigUInt64LE(cursor+8));}else{compressed=data.readUInt32LE(cursor);uncompressed=data.readUInt32LE(cursor+4);}if(descriptorCrc!==entry.crc32||compressed!==entry.compressedSize||uncompressed!==entry.uncompressedSize)throw archiveError('archive data descriptor disagrees with the central header');}return Number(entry.offsetToLocalFileHeader)+30+nameLength+extraLength;}
async function extractZipDescriptor(fd,size,destination,{maxEntries=100000,maxBytes=500*1024*1024*1024,workId=crypto.randomUUID(),signal=null,onProgress=async()=>{}}={}){if(!Number.isSafeInteger(size)||size<0||!Number.isSafeInteger(maxEntries)||maxEntries<1||!Number.isSafeInteger(maxBytes)||maxBytes<0)throw archiveError('archive limits are invalid');if(signal?.aborted)throw Object.assign(new Error('archive extraction cancelled'),{code:'lease_lost'});const endRecord=preflightEndRecord(fd,size,maxEntries),expectedEntries=endRecord.entries,incomplete=`${destination}.${String(workId).replace(/[^A-Za-z0-9._-]/g,'_')}.incomplete`;fs.rmSync(incomplete,{recursive:true,force:true});fs.mkdirSync(incomplete,{recursive:true});const directory=await unzipper.Open.custom(descriptorSource(fd,size),{tailSize:endRecord.tailSize}),entries=directory.files;if(entries.length!==expectedEntries||entries.length>maxEntries)throw archiveError('archive entry limit or directory count mismatch');let declared=0;for(const entry of entries){if(entry.signature!==0x02014b50)throw archiveError('archive central header signature is invalid');if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||!Number.isSafeInteger(entry.compressedSize)||entry.compressedSize<0)throw archiveError('archive entry size is invalid');declared+=entry.uncompressedSize;if(!Number.isSafeInteger(declared)||declared>maxBytes)throw archiveError('archive expansion limit exceeded');}const seen=new Set();let bytes=0,completed=0;for(const entry of entries){if(signal?.aborted)throw Object.assign(new Error('archive extraction cancelled'),{code:'lease_lost'});const raw=String(entry.path||''),directoryEntry=entry.type==='Directory';if(raw.includes('\\'))throw archiveError('archive contains an invalid path');const trimmed=raw.replace(/\/$/,'');const rel=safeRelativePath(trimmed);if(!rel||rel!==trimmed||seen.has(rel.toLowerCase()))throw archiveError('archive contains an invalid or duplicate path');seen.add(rel.toLowerCase());if(entry.flags&1)throw archiveError('archive contains an encrypted entry');if(![0,8].includes(entry.compressionMethod))throw archiveError('archive contains an unsupported compression method');const mode=(entry.externalFileAttributes>>>16)&0xffff,type=mode&0o170000;if(type&&!((directoryEntry&&type===0o040000)||(!directoryEntry&&type===0o100000)))throw archiveError('archive contains a symbolic link or special entry');validateLocalHeader(fd,entry);const target=path.join(incomplete,...rel.split('/'));if(directoryEntry){fs.mkdirSync(target,{recursive:true});completed+=1;await onProgress(completed/Math.max(1,entries.length),{extractedBytes:bytes,declaredBytes:declared,extractedEntries:completed,totalEntries:entries.length});continue;}fs.mkdirSync(path.dirname(target),{recursive:true});let fileBytes=0,crc=0xffffffff;const limiter=new Transform({transform(chunk,_encoding,callback){fileBytes+=chunk.length;bytes+=chunk.length;if(bytes>maxBytes)return callback(archiveError('archive expansion limit exceeded'));crc=updateCrc32(crc,chunk);callback(null,chunk);}});await pipeline(entry.stream(),limiter,fs.createWriteStream(target,{flags:'wx',mode:0o600}),...(signal?[{signal}]:[]));crc=(crc^0xffffffff)>>>0;if(fileBytes!==entry.uncompressedSize)throw archiveError('archive entry size mismatch');if(crc!==entry.crc32)throw archiveError('archive entry CRC mismatch');completed+=1;await onProgress(completed/Math.max(1,entries.length),{extractedBytes:bytes,declaredBytes:declared,extractedEntries:completed,totalEntries:entries.length});}if(signal?.aborted)throw Object.assign(new Error('archive extraction cancelled'),{code:'lease_lost'});if(fs.existsSync(destination))throw archiveError('ingestion destination already exists');fs.renameSync(incomplete,destination);return{entries:entries.length,bytes};}

async function extractZipStream(readable, destination, { maxEntries = 100000, maxBytes = 500 * 1024 * 1024 * 1024, workId = crypto.randomUUID(), signal = null } = {}) {
  const incomplete = `${destination}.${String(workId).replace(/[^A-Za-z0-9._-]/g, '_')}.incomplete`;
  fs.rmSync(incomplete, { recursive: true, force: true });
  fs.mkdirSync(incomplete, { recursive: true });
  let entries = 0, bytes = 0;
  try {
    const parser = readable.pipe(unzipper.Parse({ forceStream: true }));
    for await (const entry of parser) {
      if (signal?.aborted) throw Object.assign(new Error('archive extraction cancelled'), { code: 'lease_lost' });
      entries += 1;
      if (entries > maxEntries) throw new Error('archive entry limit exceeded');
      const rel = safeRelativePath(String(entry.path || '').replace(/\/$/, ''));
      if (!rel) throw new Error('archive contains an invalid path');
      const mode = (entry.vars?.externalFileAttributes >>> 16) & 0xffff;
      if ((mode & 0o170000) === 0o120000) throw new Error('archive contains a symbolic link');
      const target = path.join(incomplete, ...rel.split('/'));
      if (entry.type === 'Directory') { fs.mkdirSync(target, { recursive: true }); entry.autodrain(); continue; }
      if (entry.type !== 'File') throw new Error('archive contains an unsupported entry');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let fileBytes = 0;
      const limiter = new Transform({ transform(chunk, _enc, cb) { fileBytes += chunk.length; bytes += chunk.length; if (bytes > maxBytes) return cb(new Error('archive expansion limit exceeded')); cb(null, chunk); } });
      const streams = [entry, limiter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 })];
      if (signal) await pipeline(...streams, { signal });
      else await pipeline(...streams);
      if (Number(entry.vars?.uncompressedSize || fileBytes) !== fileBytes) throw new Error('archive entry size mismatch');
    }
    if (signal?.aborted) throw Object.assign(new Error('archive extraction cancelled'), { code: 'lease_lost' });
    if (fs.existsSync(destination)) throw new Error('ingestion destination already exists');
    fs.renameSync(incomplete, destination);
    return { entries, bytes };
  } catch (error) {
    fs.rmSync(incomplete, { recursive: true, force: true });
    throw error;
  }
}

async function extractZipFile(filePath, destination, {
  maxEntries = 100000,
  maxBytes = 500 * 1024 * 1024 * 1024,
  workId = crypto.randomUUID(),
  signal = null,
  onProgress = async () => {},
} = {}) {
  const incomplete = `${destination}.${String(workId).replace(/[^A-Za-z0-9._-]/g, '_')}.incomplete`;
  fs.rmSync(incomplete, { recursive: true, force: true });
  fs.mkdirSync(incomplete, { recursive: true });
  let bytes = 0, completedEntries = 0;
  try {
    const directory = await unzipper.Open.file(filePath), entries = directory.files;
    if (entries.length > maxEntries) throw new Error('archive entry limit exceeded');
    const declared = entries.reduce((sum, entry) => sum + Number(entry.uncompressedSize || 0), 0);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) throw new Error('archive expansion limit exceeded');
    const progress = typeof onProgress === 'function' ? onProgress : async () => {};
    let lastFraction = -1, lastReportedAt = 0;
    const report = async (force = false) => {
      const raw = declared > 0 ? bytes / declared : completedEntries / Math.max(1, entries.length);
      const fraction = force && completedEntries === entries.length ? 1 : Math.max(0, Math.min(0.999, raw));
      const timestamp = Date.now();
      // Keep progress useful without turning every decompression chunk into a
      // database heartbeat. Long extractions still update at most four times
      // per second, and faster ones report in half-percent increments.
      if (!force && lastFraction >= 0 && fraction - lastFraction < 0.005 && timestamp - lastReportedAt < 250) return;
      lastFraction = fraction;
      lastReportedAt = timestamp;
      await progress(fraction, { extractedBytes: bytes, declaredBytes: declared, extractedEntries: completedEntries, totalEntries: entries.length });
    };
    await report();
    const seen = new Set();
    for (const entry of entries) {
      if (signal?.aborted) throw Object.assign(new Error('archive extraction cancelled'), { code: 'lease_lost' });
      const rel = safeRelativePath(String(entry.path || '').replace(/\/$/, ''));
      if (!rel || seen.has(rel.toLowerCase())) throw new Error('archive contains an invalid or duplicate path');
      seen.add(rel.toLowerCase());
      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      if ((mode & 0o170000) === 0o120000) throw new Error('archive contains a symbolic link');
      const target = path.join(incomplete, ...rel.split('/'));
      if (entry.type === 'Directory') {
        fs.mkdirSync(target, { recursive: true });
        completedEntries += 1;
        await report();
        continue;
      }
      if (entry.type !== 'File') throw new Error('archive contains an unsupported entry');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      let fileBytes = 0;
      const limiter = new Transform({
        transform(chunk, _enc, callback) {
          fileBytes += chunk.length;
          bytes += chunk.length;
          if (bytes > maxBytes) return callback(new Error('archive expansion limit exceeded'));
          Promise.resolve(report()).then(() => callback(null, chunk), callback);
        },
      });
      const streams = [entry.stream(), limiter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 })];
      if (signal) await pipeline(...streams, { signal });
      else await pipeline(...streams);
      if (Number(entry.uncompressedSize) !== fileBytes) throw new Error('archive entry size mismatch');
      completedEntries += 1;
      await report();
    }
    if (signal?.aborted) throw Object.assign(new Error('archive extraction cancelled'), { code: 'lease_lost' });
    await report(true);
    if (fs.existsSync(destination)) throw new Error('ingestion destination already exists');
    fs.renameSync(incomplete, destination);
    return { entries: entries.length, bytes };
  } catch (error) {
    fs.rmSync(incomplete, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { descriptorSource, extractZipDescriptor, extractZipFile, extractZipStream };
