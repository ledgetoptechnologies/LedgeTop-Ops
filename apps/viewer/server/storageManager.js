'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { safeRelativePath } = require('./processingSecurity');
const { fsyncDirectory, fsyncDirectoryTree } = require('./durableFs');

const SCOPED_STORAGE_ROOT = /^(webodm|terra|terra_import)@([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

function scopedStorageRootKey(value) {
  const match = String(value || '').match(SCOPED_STORAGE_ROOT);
  if (!match) return null;
  return match[1].toLowerCase() === 'webodm' ? 'webodm' : 'terra_import';
}

function physicalStorageRootKey(value) {
  const key = String(value || '');
  if (key === 'terra') return 'terra_import';
  return scopedStorageRootKey(key) || key;
}

function descriptorMountId(fd) {
  const value = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').match(/^mnt_id:\s*(\d+)$/m)?.[1];
  if (!value) throw Object.assign(new Error('filesystem mount identity is unavailable'), { code: 'cleanup_mount_unavailable' });
  return value;
}

function hashFile(filePath,{signal=null}={}) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    const abort=()=>stream.destroy(Object.assign(new Error('file operation cancelled'),{code:'lease_lost'}));if(signal?.aborted){abort();return;}signal?.addEventListener('abort',abort,{once:true});stream.on('data',(chunk)=>hash.update(chunk));stream.on('error',(error)=>{signal?.removeEventListener('abort',abort);reject(error);});stream.on('end',()=>{signal?.removeEventListener('abort',abort);resolve(hash.digest('hex'));});
  });
}

async function hashFileChunks(filePath,{signal=null,chunkSize=4*1024*1024}={}){const stat=fs.statSync(filePath),whole=crypto.createHash('sha256'),chunks=[],handle=await fs.promises.open(filePath,'r');try{let position=0,index=0;while(position<stat.size){if(signal?.aborted)throw Object.assign(new Error('file operation cancelled'),{code:'lease_lost'});const size=Math.min(chunkSize,stat.size-position),buffer=Buffer.allocUnsafe(size),{bytesRead}=await handle.read(buffer,0,size,position);if(bytesRead!==size)throw new Error('file changed while hashing');const bytes=buffer.subarray(0,bytesRead);whole.update(bytes);if(stat.size>chunkSize)chunks.push({chunkIndex:index,byteOffset:position,byteSize:bytesRead,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});position+=bytesRead;index+=1;}return{sha256:whole.digest('hex'),chunks};}finally{await handle.close();}}

async function hashTree(root,{signal=null}={}) {
  const files=[];const walk=(directory,relative='')=>{if(signal?.aborted)throw Object.assign(new Error('file operation cancelled'),{code:'lease_lost'});for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const absolute=path.join(directory,entry.name),rel=relative?`${relative}/${entry.name}`:entry.name,stat=fs.lstatSync(absolute);if(stat.isSymbolicLink())throw Object.assign(new Error('asset tree contains a symbolic link'),{code:'invalid_asset_tree'});if(entry.isDirectory())walk(absolute,rel);else if(entry.isFile())files.push({absolutePath:absolute,relativePath:rel,byteSize:stat.size});else throw Object.assign(new Error('asset tree contains a special file'),{code:'invalid_asset_tree'});}};walk(root);files.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));for(const file of files)Object.assign(file,await hashFileChunks(file.absolutePath,{signal}));const manifestSha256=crypto.createHash('sha256').update(JSON.stringify(files.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256})))).digest('hex');return{files:files.map(({absolutePath,...file})=>file),manifestSha256};
}

function readHead(filePath,maxBytes=256*1024) { const fd=fs.openSync(filePath,'r');try{const stat=fs.fstatSync(fd),buffer=Buffer.allocUnsafe(Math.min(maxBytes,stat.size));const bytes=fs.readSync(fd,buffer,0,buffer.length,0);return buffer.subarray(0,bytes);}finally{fs.closeSync(fd);} }

function jpegMetadata(buffer) {
  const result = {};
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return result;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break;
    const marker = buffer[offset + 1], length = buffer.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > buffer.length) break;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker) && length >= 7) {
      result.height = buffer.readUInt16BE(offset + 5); result.width = buffer.readUInt16BE(offset + 7);
    }
    if (marker === 0xe1 && buffer.toString('ascii', offset + 4, offset + 10) === 'Exif\0\0') {
      try { Object.assign(result, parseExif(buffer.subarray(offset + 10, offset + 2 + length))); } catch { /* best effort */ }
    }
    offset += 2 + length;
  }
  return result;
}

function parseExif(tiff) {
  const little = tiff.toString('ascii',0,2)==='II'; const u16=(o)=>little?tiff.readUInt16LE(o):tiff.readUInt16BE(o); const u32=(o)=>little?tiff.readUInt32LE(o):tiff.readUInt32BE(o);
  if (u16(2)!==42) return {}; const first=u32(4); const out={}; let gpsOffset=null;
  function entries(at, callback) { if(at<0||at+2>tiff.length)return; const count=u16(at); for(let i=0;i<count;i++){const p=at+2+i*12;if(p+12>tiff.length)break; callback(u16(p),u16(p+2),u32(p+4),p+8,u32(p+8));} }
  function ascii(type,count,valuePos,raw){ if(type!==2)return null; const p=count<=4?valuePos:raw; return p+count<=tiff.length?tiff.toString('ascii',p,p+count).replace(/\0+$/,''):null; }
  entries(first,(tag,type,count,pos,raw)=>{ if(tag===0x0110)out.cameraModel=ascii(type,count,pos,raw); if(tag===0x0132)out.capturedAt=ascii(type,count,pos,raw); if(tag===0x8769){const exif=raw;entries(exif,(t,ty,c,p,r)=>{if(t===0x9003)out.capturedAt=ascii(ty,c,p,r);});} if(tag===0x8825)gpsOffset=raw; });
  if(gpsOffset){let latRef,lonRef,lat,lon,altitudeRef=0,altitude; const rational=(p)=>u32(p)/u32(p+4); const triplet=(p)=>rational(p)+rational(p+8)/60+rational(p+16)/3600;
    entries(gpsOffset,(tag,type,count,pos,raw)=>{ if(tag===1)latRef=ascii(type,count,pos,raw); if(tag===2&&type===5)lat=triplet(raw); if(tag===3)lonRef=ascii(type,count,pos,raw); if(tag===4&&type===5)lon=triplet(raw);if(tag===5&&type===1&&count===1)altitudeRef=tiff[pos];if(tag===6&&type===5&&count===1)altitude=rational(raw); });
    if(Number.isFinite(lat)&&Number.isFinite(lon)){out.gps={latitude:latRef==='S'?-lat:lat,longitude:lonRef==='W'?-lon:lon};if(Number.isFinite(altitude))out.gps.altitudeM=altitudeRef===1?-altitude:altitude;}
  }
  return out;
}

class StorageManager {
  constructor(config) {
    this.config=config;
    this.roots={datasets:config.datasetsMount,models:config.modelsMount,cache:config.cacheMount,trash:config.trashMount};
    this.cleanupRootPins=new Map();
    if(config.datasetImportMount)this.roots.dataset_import=config.datasetImportMount;
    if(config.webodmMediaMount)this.roots.webodm=config.webodmMediaMount;
    if(config.terraImportMount)this.roots.terra_import=config.terraImportMount;
  }
  initialize() {
    for(const key of ['datasets','models','cache','trash','dataset_import','terra_import'])if(this.roots[key])fs.mkdirSync(this.roots[key],{recursive:true});
    for(const key of ['cache','dataset_import']){
      if(!this.roots[key]||this.cleanupRootPins.has(key))continue;
      const realPath=fs.realpathSync.native(this.roots[key]),fd=fs.openSync(realPath,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);
      try{const stat=fs.fstatSync(fd,{bigint:true});if(!stat.isDirectory())throw Object.assign(new Error('cleanup root is not a directory'),{code:'cleanup_root_changed'});this.cleanupRootPins.set(key,{realPath,dev:String(stat.dev),ino:String(stat.ino),mountId:descriptorMountId(fd)});}finally{fs.closeSync(fd);}
    }
  }
  openCleanupRoot(rootKey){const key=physicalStorageRootKey(rootKey);if(!['cache','dataset_import'].includes(key)||key!==rootKey)throw Object.assign(new Error('cleanup root is not permitted'),{code:'invalid_cleanup_root'});const pin=this.cleanupRootPins.get(key);if(!pin)throw Object.assign(new Error('cleanup root was not pinned at startup'),{code:'cleanup_root_unpinned'});const realPath=fs.realpathSync.native(this.roots[key]);let fd;try{fd=fs.openSync(realPath,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);const stat=fs.fstatSync(fd,{bigint:true}),mountId=descriptorMountId(fd);if(!stat.isDirectory()||realPath!==pin.realPath||String(stat.dev)!==pin.dev||String(stat.ino)!==pin.ino||mountId!==pin.mountId)throw Object.assign(new Error('cleanup root changed after startup'),{code:'cleanup_root_changed'});return{fd,mountId,realPath,stat};}catch(error){if(fd!==undefined)fs.closeSync(fd);throw error;}}
  resolve(rootKey,relativePath,{mustExist=false}={}) {
    const root=this.roots[physicalStorageRootKey(rootKey)], rel=safeRelativePath(relativePath); if(!root||!rel)throw Object.assign(new Error('invalid storage location'),{code:'invalid_storage_location'});
    const resolvedRoot=fs.realpathSync.native(root), candidate=path.resolve(resolvedRoot,...rel.split('/'));
    if(candidate!==resolvedRoot&&!candidate.startsWith(resolvedRoot+path.sep))throw Object.assign(new Error('path escapes configured root'),{code:'invalid_storage_location'});
    if(mustExist){const real=fs.realpathSync.native(candidate);if(real!==resolvedRoot&&!real.startsWith(resolvedRoot+path.sep))throw Object.assign(new Error('symlink escapes configured root'),{code:'invalid_storage_location'});return real;}
    let parent=path.dirname(candidate);while(!fs.existsSync(parent)&&parent!==resolvedRoot)parent=path.dirname(parent);const realParent=fs.realpathSync.native(parent);if(realParent!==resolvedRoot&&!realParent.startsWith(resolvedRoot+path.sep))throw Object.assign(new Error('parent symlink escapes configured root'),{code:'invalid_storage_location'});return candidate;
  }
  space(rootKey,requiredBytes=0) {
    const root=this.roots[rootKey],stat=fs.statfsSync(root);
    const available=Number(stat.bavail)*Number(stat.bsize),total=Number(stat.blocks)*Number(stat.bsize);
    const reserve=Math.max(this.config.storageReserveBytes,Math.ceil(total*this.config.storageReservePercent/100));
    return {available,total,reserve,required:requiredBytes,ok:available-requiredBytes>=reserve,files:Number(stat.files),ffree:Number(stat.ffree)};
  }
  requireSpace(rootKey,bytes) { const result=this.space(rootKey,bytes);if(!result.ok)throw Object.assign(new Error('insufficient storage headroom'),{code:'insufficient_storage',details:result});return result; }
  requireDerivativeSpace(rootKey,{sourceBytes,expectedFiles=10000,reservedBytes=0,otherReservedBytes=0,reservedDatasetBytes=[]}={}){
    const bytes=Number(sourceBytes),reserved=Number(reservedBytes),other=Number(otherReservedBytes),datasets=Array.isArray(reservedDatasetBytes)?reservedDatasetBytes:[],filesNeeded=Math.max(1,Number(expectedFiles)||0),gib=1024**3;
    if(!Number.isSafeInteger(bytes)||bytes<0)throw Object.assign(new Error('derivative input size is invalid'),{code:'invalid_storage_estimate'});
    if(bytes>16*gib)throw Object.assign(new Error('derivative input closure exceeds the 16 GiB supported bound'),{code:'derivative_source_too_large',details:{inputBytes:bytes,limitBytes:16*gib}});
    if(!Number.isSafeInteger(reserved)||reserved<0||!Number.isSafeInteger(other)||other<0)throw Object.assign(new Error('derivative reservation is invalid'),{code:'invalid_storage_estimate'});
    let processingReserved=0;const targetDevice=fs.statSync(this.roots[rootKey]).dev,cacheSharesDevice=fs.statSync(this.roots.cache).dev===targetDevice;for(const value of datasets){const datasetBytes=Number(value);if(!Number.isSafeInteger(datasetBytes)||datasetBytes<0)throw Object.assign(new Error('processing reservation is invalid'),{code:'insufficient_storage'});processingReserved+=Math.max(gib,datasetBytes*3)+(cacheSharesDevice?Math.max(256*1024**2,datasetBytes):0);if(!Number.isSafeInteger(processingReserved))throw Object.assign(new Error('derivative storage estimate overflowed'),{code:'insufficient_storage'});}
    const required=Math.max(5*gib,bytes*4,reserved)+other+processingReserved;
    if(!Number.isSafeInteger(required))throw Object.assign(new Error('derivative storage estimate overflowed'),{code:'insufficient_storage'});
    const result=this.requireSpace(rootKey,required),totalInodes=Number(result.files),freeInodes=Number(result.ffree);
    if(!Number.isFinite(totalInodes)||totalInodes<=0||!Number.isFinite(freeInodes)||freeInodes<0)throw Object.assign(new Error('inode headroom is unavailable'),{code:'insufficient_storage',details:result});
    const inodeReserve=Math.min(100000,Math.max(10000,Math.ceil(totalInodes*0.05)));
    if(freeInodes-filesNeeded<inodeReserve)throw Object.assign(new Error('insufficient inode headroom'),{code:'insufficient_storage',details:{...result,expectedFiles:filesNeeded,inodeReserve}});
    return {...result,expectedFiles:filesNeeded,inodeReserve};
  }
  sameFilesystem(left,right){return fs.statSync(this.roots[left]).dev===fs.statSync(this.roots[right]).dev;}
  requireProcessingHeadroom(datasetBytes,reservedDatasetBytes=[],reservedDerivativeBytes=0){
    const derivativeBytes=Number(reservedDerivativeBytes),dataset=Number(datasetBytes),reservedValues=Array.isArray(reservedDatasetBytes)?reservedDatasetBytes.map(Number):null;
    if(!Number.isSafeInteger(dataset)||dataset<0||!reservedValues||reservedValues.some((value)=>!Number.isSafeInteger(value)||value<0)||!Number.isSafeInteger(derivativeBytes)||derivativeBytes<0)throw Object.assign(new Error('processing reservation is invalid'),{code:'insufficient_storage'});
    const estimate=(bytes)=>{const models=Math.max(1024*1024*1024,bytes*3),cache=Math.max(256*1024*1024,bytes);if(!Number.isSafeInteger(models)||!Number.isSafeInteger(cache))throw Object.assign(new Error('processing storage estimate overflowed'),{code:'insufficient_storage'});return{datasets:0,cache,models};},requirements=estimate(dataset),reserved=reservedValues.map(estimate),groups=new Map();
    for(const [rootKey,required] of Object.entries(requirements)){const dev=fs.statSync(this.roots[rootKey]).dev,key=String(dev),current=groups.get(key)||{rootKey,required:0,reservedRequired:0,roots:[]},reservedForRoot=reserved.reduce((sum,item)=>{const next=sum+item[rootKey];if(!Number.isSafeInteger(next))throw Object.assign(new Error('processing storage estimate overflowed'),{code:'insufficient_storage'});return next;},0)+(rootKey==='models'?derivativeBytes:0);current.required+=required;current.reservedRequired+=reservedForRoot;if(!Number.isSafeInteger(current.required)||!Number.isSafeInteger(current.reservedRequired))throw Object.assign(new Error('processing storage estimate overflowed'),{code:'insufficient_storage'});current.roots.push(rootKey);groups.set(key,current);}
    const result={};for(const group of groups.values()){const sharedRequired=group.required+group.reservedRequired;if(!Number.isSafeInteger(sharedRequired))throw Object.assign(new Error('processing storage estimate overflowed'),{code:'insufficient_storage'});const checked=this.requireSpace(group.rootKey,sharedRequired);for(const rootKey of group.roots)result[rootKey]={...checked,required:requirements[rootKey],reservedRequired:group.reservedRequired,sharedRequired,sharedWith:[...group.roots]};}return result;
  }
  chunkPath(uploadId,fileId,index) { return this.resolve('cache',`uploads/${uploadId}/${fileId}/${index}.part`); }
  writeChunk(uploadId,fileId,index,body,expectedSha) { const actual=crypto.createHash('sha256').update(body).digest('hex');if(actual!==expectedSha)throw Object.assign(new Error('chunk checksum mismatch'),{code:'checksum_mismatch'});this.requireSpace('cache',body.length);const target=this.chunkPath(uploadId,fileId,index);fs.mkdirSync(path.dirname(target),{recursive:true});if(fs.existsSync(target)){const existing=fs.readFileSync(target);const old=crypto.createHash('sha256').update(existing).digest('hex');if(old!==actual)throw Object.assign(new Error('chunk conflict'),{code:'chunk_conflict'});return {sha256:actual,byteSize:body.length,replayed:true};}const temp=`${target}.${crypto.randomUUID()}.tmp`;fs.writeFileSync(temp,body,{flag:'wx'});fs.renameSync(temp,target);return {sha256:actual,byteSize:body.length,replayed:false}; }
  cleanupUpload(uploadId){fs.rmSync(this.resolve('cache',`uploads/${uploadId}`),{recursive:true,force:true});}
  async assembleFile(upload,fileSpec,chunks,datasetRelative) { const output=this.resolve('datasets',`${datasetRelative}/${fileSpec.relativePath}`),result=(stat,sha)=>({id:fileSpec.id,relativePath:fileSpec.relativePath,byteSize:stat.size,sha256:sha,contentType:fileSpec.contentType||null,processingRole:fileSpec.processingRole||'auto',metadata:jpegMetadata(readHead(output))});fs.mkdirSync(path.dirname(output),{recursive:true});if(fs.existsSync(output)){const stat=fs.statSync(output),sha=await hashFile(output);if(stat.size!==fileSpec.byteSize||sha!==fileSpec.sha256)throw Object.assign(new Error('existing finalized file conflicts with manifest'),{code:'manifest_mismatch'});return result(stat,sha);}const temp=`${output}.${crypto.randomUUID()}.incomplete`;try{const sources=async function*(){for(const chunk of chunks){const input=fs.createReadStream(this.chunkPath(upload.id,fileSpec.id,chunk.chunk_index));for await(const bytes of input)yield bytes;}}.bind(this);await pipeline(sources(),fs.createWriteStream(temp,{flags:'wx'}));const stat=fs.statSync(temp);const sha=await hashFile(temp);if(stat.size!==fileSpec.byteSize||sha!==fileSpec.sha256)throw Object.assign(new Error('assembled file does not match manifest'),{code:'manifest_mismatch'});fs.renameSync(temp,output);return result(stat,sha);}catch(error){fs.rmSync(temp,{force:true});throw error;} }
  scanTree(rootKey,relativePath,{maxFiles=100000}={}) { const root=this.resolve(rootKey,relativePath,{mustExist:true});const stat=fs.lstatSync(root);if(!stat.isDirectory())throw new Error('import source must be a directory');const files=[];let bytes=0;const walk=(dir,rel='')=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(files.length>=maxFiles)throw new Error('import contains too many files');const childRel=rel?`${rel}/${entry.name}`:entry.name;const child=path.join(dir,entry.name);const childStat=fs.lstatSync(child,{bigint:true});if(childStat.isSymbolicLink())throw new Error('import may not contain symbolic links');if(childStat.isDirectory())walk(child,childRel);else if(childStat.isFile()){const byteSize=Number(childStat.size);if(!Number.isSafeInteger(byteSize))throw new Error('import file is too large to index safely');files.push({relativePath:childRel,byteSize,mtimeMs:Number(childStat.mtimeNs/1000000n),ctimeMs:Number(childStat.ctimeNs/1000000n),absolutePath:child});bytes+=byteSize;if(!Number.isSafeInteger(bytes))throw new Error('import is too large to index safely');}else throw new Error('import contains unsupported special files');}};walk(root);files.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));return {root,files,byteSize:bytes}; }
  async treeFingerprint(scan,{captureHashes=false,signal=null,onProgress=()=>{}}={}) { const hash=crypto.createHash('sha256');for(let index=0;index<scan.files.length;index+=1){const file=scan.files[index],sha256=await hashFile(file.absolutePath,{signal});if(captureHashes)file.sha256=sha256;hash.update(`${file.relativePath}\0${file.byteSize}\0${sha256}\n`);await onProgress((index+1)/Math.max(1,scan.files.length));}return hash.digest('hex');}
  async previewImport(rootKey,relativePath,{maxFiles=100000,signal=null,onProgress=()=>{}}={}) { const scan=this.scanTree(rootKey,relativePath,{maxFiles});await onProgress(0.05);const destinationSpace=this.space('datasets',scan.byteSize),treeFingerprint=await this.treeFingerprint(scan,{signal,onProgress:(value)=>onProgress(0.05+0.9*value)});await onProgress(0.98);return {rootKey,relativePath:safeRelativePath(relativePath),fileCount:scan.files.length,byteSize:scan.byteSize,treeFingerprint,files:scan.files.slice(0,1000).map(({absolutePath,...file})=>file),truncated:scan.files.length>1000,sameFilesystem:fs.statSync(scan.root).dev===fs.statSync(this.roots.datasets).dev,destinationSpace}; }
  // Same-device adoption is an atomic rename. Deterministic destination and
  // `.incomplete` paths make a killed worker resumable without re-copying or
  // losing the source authorization boundary.
  async adoptImport(rootKey,relativePath,datasetRelative,{externalReference=false,expectedFingerprint=null,maxFiles=100000,onProgress=()=>{}}={}) {
    const destination=this.resolve('datasets',datasetRelative),incomplete=`${destination}.incomplete`;
    let source=null,before=null;
    try{source=this.resolve(rootKey,relativePath,{mustExist:true});before=this.scanTree(rootKey,relativePath,{maxFiles});}catch(error){if(error.code!=='ENOENT'&&!/ENOENT/.test(error.message))throw error;}
    if(externalReference){if(!before)throw Object.assign(new Error('import source is unavailable'),{code:'import_source_unavailable'});const fingerprint=await this.treeFingerprint(before,{captureHashes:true});if(expectedFingerprint&&fingerprint!==expectedFingerprint)throw Object.assign(new Error('import source changed after preview'),{code:'import_changed'});for(const file of before.files)file.metadata=jpegMetadata(readHead(file.absolutePath));return{rootKey,relativePath:safeRelativePath(relativePath),scan:before,sourceToRemove:null};}
    const scanAndHash=async(root)=>{const scan=this.scanAbsolute(root,{maxFiles});await this.treeFingerprint(scan,{captureHashes:true});for(const file of scan.files)file.metadata=jpegMetadata(readHead(file.absolutePath));return scan;};
    if(fs.existsSync(destination)){const scan=await scanAndHash(destination),fingerprint=await this.treeFingerprint(scan);if(expectedFingerprint&&fingerprint!==expectedFingerprint)throw Object.assign(new Error('existing import destination conflicts with manifest'),{code:'manifest_mismatch'});fsyncDirectoryTree(destination,{code:'import_durability_failed'});fsyncDirectory(path.dirname(destination),{code:'import_durability_failed'});return{rootKey:'datasets',relativePath:datasetRelative,scan,sourceToRemove:source};}
    if(fs.existsSync(incomplete)&&!before){const staged=await scanAndHash(incomplete),fingerprint=await this.treeFingerprint(staged);if(expectedFingerprint&&fingerprint!==expectedFingerprint)throw Object.assign(new Error('staged import conflicts with manifest'),{code:'manifest_mismatch'});fsyncDirectoryTree(incomplete,{code:'import_durability_failed'});fs.renameSync(incomplete,destination);fsyncDirectory(path.dirname(destination),{code:'import_durability_failed'});return{rootKey:'datasets',relativePath:datasetRelative,scan:await scanAndHash(destination),sourceToRemove:null};}
    if(!before||!source)throw Object.assign(new Error('import source is unavailable'),{code:'import_source_unavailable'});
    const fingerprint=await this.treeFingerprint(before,{captureHashes:true});if(expectedFingerprint&&fingerprint!==expectedFingerprint)throw Object.assign(new Error('import source changed after preview'),{code:'import_changed'});for(const file of before.files)file.metadata=jpegMetadata(readHead(file.absolutePath));
    const sameDevice=fs.statSync(source).dev===fs.statSync(this.roots.datasets).dev;if(!sameDevice)this.requireSpace('datasets',before.byteSize);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.rmSync(incomplete,{recursive:true,force:true});
    try{
      if(sameDevice){fs.renameSync(source,incomplete);fsyncDirectory(path.dirname(incomplete),{code:'import_durability_failed'});fsyncDirectory(path.dirname(source),{code:'import_durability_failed'});}
      else{for(let index=0;index<before.files.length;index+=1){const file=before.files[index],target=path.join(incomplete,...file.relativePath.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});await pipeline(fs.createReadStream(file.absolutePath),fs.createWriteStream(target,{flags:'wx'}));await onProgress(0.7*(index+1)/Math.max(1,before.files.length));}}
      const staged=await scanAndHash(incomplete),stagedFingerprint=await this.treeFingerprint(staged);if(stagedFingerprint!==fingerprint)throw Object.assign(new Error('adopted import verification failed'),{code:'manifest_mismatch'});fsyncDirectoryTree(incomplete,{code:'import_durability_failed'});fs.renameSync(incomplete,destination);fsyncDirectory(path.dirname(destination),{code:'import_durability_failed'});const scan=await scanAndHash(destination);await onProgress(0.98);return{rootKey:'datasets',relativePath:datasetRelative,scan,sourceToRemove:sameDevice?null:source};
    }catch(error){if(!sameDevice)fs.rmSync(incomplete,{recursive:true,force:true});throw error;}
  }
  scanAbsolute(root,{maxFiles=100000}={}) { const files=[];let byteSize=0;const walk=(dir,rel='')=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(files.length>=maxFiles)throw new Error('too many files');const p=path.join(dir,entry.name),r=rel?`${rel}/${entry.name}`:entry.name,s=fs.lstatSync(p);if(s.isSymbolicLink())throw new Error('symbolic links are forbidden');if(s.isDirectory())walk(p,r);else if(s.isFile()){files.push({absolutePath:p,relativePath:r,byteSize:s.size,mtimeMs:Math.trunc(s.mtimeMs),ctimeMs:Math.trunc(s.ctimeMs)});byteSize+=s.size;}else throw new Error('special files are forbidden');}};walk(root);files.sort((a,b)=>a.relativePath.localeCompare(b.relativePath));return{files,byteSize}; }
  async removeAdoptedSourceIfMatches(rootKey,relativePath,{fingerprint,byteSize,cleanupId,sourceDev,sourceIno,sourceCtimeNs,sourceMtimeNs,maxFiles=100000}={}){
    const relative=safeRelativePath(relativePath),expected=String(fingerprint||'').toLowerCase(),size=Number(byteSize),token=String(cleanupId||''),identity={dev:String(sourceDev||''),ino:String(sourceIno||''),ctimeNs:String(sourceCtimeNs||''),mtimeNs:String(sourceMtimeNs||'')};
    if(!relative||relative!==String(relativePath||'').replaceAll('\\','/')||!/^[a-f0-9]{64}$/.test(expected)||!Number.isSafeInteger(size)||size<0||!/^[a-f0-9-]{16,64}$/i.test(token)||Object.values(identity).some((value)=>!/^\d+$/.test(value)))throw Object.assign(new Error('import cleanup identity is invalid'),{code:'invalid_source_cleanup'});
    const source=this.resolve(rootKey,relative),quarantine=`${source}.cleanup-${token}`,verify=async(absolute)=>{if(!fs.existsSync(absolute))return null;const stat=fs.lstatSync(absolute);if(!stat.isDirectory())return false;const scan=this.scanAbsolute(absolute,{maxFiles});if(scan.byteSize!==size)return false;return await this.treeFingerprint(scan)===expected;},sameObject=(stat,withTimes=true)=>String(stat.dev)===identity.dev&&String(stat.ino)===identity.ino&&(!withTimes||(String(stat.ctimeNs)===identity.ctimeNs&&String(stat.mtimeNs)===identity.mtimeNs)),removeVerified=(descriptor,held)=>{try{this.removeVerifiedAdoptedSource(quarantine,descriptor,held.dev,held.ino);}catch(error){if(!fs.existsSync(source)&&fs.existsSync(quarantine)){const current=fs.lstatSync(quarantine,{bigint:true});if(String(current.dev)===String(held.dev)&&String(current.ino)===String(held.ino)){fs.renameSync(quarantine,source);const restored=fs.statSync(source,{bigint:true});error.restoredSourceIdentity={sourceDev:String(restored.dev),sourceIno:String(restored.ino),sourceCtimeNs:String(restored.ctimeNs),sourceMtimeNs:String(restored.mtimeNs)};}}throw error;}};
    if(fs.existsSync(quarantine)){let descriptor;try{descriptor=fs.openSync(quarantine,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);const held=fs.fstatSync(descriptor,{bigint:true});if(!sameObject(held,false)||await verify(quarantine)!==true)return false;removeVerified(descriptor,held);return true;}finally{if(descriptor!==undefined)fs.closeSync(descriptor);}}
    if(!fs.existsSync(source))return true;
    let descriptor;try{descriptor=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);const held=fs.fstatSync(descriptor,{bigint:true});if(!sameObject(held,true)||await verify(source)!==true)return false;try{fs.renameSync(source,quarantine);}catch(error){if(error.code==='ENOENT')return false;throw error;}const moved=fs.lstatSync(quarantine,{bigint:true});if(String(moved.dev)!==String(held.dev)||String(moved.ino)!==String(held.ino)||await verify(quarantine)!==true){if(!fs.existsSync(source)&&String(moved.dev)===String(held.dev)&&String(moved.ino)===String(held.ino))fs.renameSync(quarantine,source);return false;}removeVerified(descriptor,held);return true;}finally{if(descriptor!==undefined)fs.closeSync(descriptor);}
  }
  removeVerifiedAdoptedSource(absolutePath,descriptor,expectedDev,expectedIno){const resolved=path.resolve(absolutePath),allowed=Object.entries(this.roots).some(([key,root])=>['dataset_import','terra_import'].includes(key)&&root&&(resolved===path.resolve(root)||resolved.startsWith(`${path.resolve(root)}${path.sep}`)));if(!allowed)throw Object.assign(new Error('import cleanup path is outside an adoptable root'),{code:'invalid_source_cleanup'});const held=fs.fstatSync(descriptor,{bigint:true});if(String(held.dev)!==String(expectedDev)||String(held.ino)!==String(expectedIno))throw Object.assign(new Error('opened cleanup source identity changed'),{code:'source_changed'});const openedRoot=`/proc/self/fd/${descriptor}`;for(const entry of fs.readdirSync(openedRoot))fs.rmSync(path.join(openedRoot,entry),{recursive:true,force:false});const current=fs.lstatSync(resolved,{bigint:true});if(String(current.dev)!==String(held.dev)||String(current.ino)!==String(held.ino))throw Object.assign(new Error('cleanup quarantine path was replaced'),{code:'source_changed'});fs.rmdirSync(resolved);}
  removeAdoptedSource(absolutePath){if(!absolutePath)return;const resolved=path.resolve(absolutePath);const allowed=Object.entries(this.roots).some(([key,root])=>['dataset_import','terra_import'].includes(key)&&root&&(resolved===path.resolve(root)||resolved.startsWith(`${path.resolve(root)}${path.sep}`)));if(!allowed)throw new Error('import cleanup path is outside an adoptable root');fs.rmSync(resolved,{recursive:true,force:true});}
  reconcileAdoptionIntent(rootKey,relativePath,datasetRelative){
    const source=this.resolve(rootKey,relativePath),destination=this.resolve('datasets',datasetRelative),incomplete=`${destination}.incomplete`;
    const recover=(candidate)=>{if(!fs.existsSync(candidate))return false;if(!fs.existsSync(source)){fs.mkdirSync(path.dirname(source),{recursive:true});fs.renameSync(candidate,source);}else fs.rmSync(candidate,{recursive:true,force:true});return true;};
    const destinationRecovered=recover(destination),incompleteRecovered=recover(incomplete);
    return destinationRecovered||incompleteRecovered;
  }
  moveToTrash(rootKey,relativePath,entityType,entityId){if(rootKey!=='datasets'&&rootKey!=='models')throw Object.assign(new Error('only Viewer-managed assets can be trashed'),{code:'external_reference'});const source=this.resolve(rootKey,relativePath,{mustExist:true}),trashRelative=`${entityType}/${entityId}-${crypto.randomUUID()}`,destination=this.resolve('trash',trashRelative);fs.mkdirSync(path.dirname(destination),{recursive:true});if(fs.statSync(source).dev!==fs.statSync(this.roots.trash).dev)throw new Error('trash must be on the same filesystem');fs.renameSync(source,destination);return{rootKey,relativePath,trashRelative};}
  pathExists(rootKey,relativePath){try{return fs.existsSync(this.resolve(rootKey,relativePath));}catch{return false;}}
  pathExistsStrict(rootKey,relativePath){const root=this.roots[rootKey];if(!root)throw Object.assign(new Error('lifecycle storage root is not configured'),{code:'lifecycle_storage_unavailable'});let rootStat;try{rootStat=fs.lstatSync(root);}catch(error){throw Object.assign(new Error('lifecycle storage root is unavailable'),{code:'lifecycle_storage_unavailable',cause:error});}if(!rootStat.isDirectory())throw Object.assign(new Error('lifecycle storage root is not a directory'),{code:'lifecycle_storage_unavailable'});const target=this.resolve(rootKey,relativePath);try{fs.lstatSync(target);return true;}catch(error){if(error.code==='ENOENT')return false;throw Object.assign(new Error('lifecycle storage path could not be inspected'),{code:'lifecycle_storage_unavailable',cause:error});}}
  trashExists(relativePath){return Boolean(relativePath)&&this.pathExists('trash',relativePath);}
  restoreFromTrash(trashRelative,rootKey,relativePath){const source=this.resolve('trash',trashRelative,{mustExist:true}),destination=this.resolve(rootKey,relativePath);if(fs.existsSync(destination))throw Object.assign(new Error('restore destination exists'),{code:'restore_conflict'});fs.mkdirSync(path.dirname(destination),{recursive:true});fs.renameSync(source,destination);}
  purgeTrash(trashRelative){const target=this.resolve('trash',trashRelative);if(!fs.existsSync(target))return false;fs.rmSync(target,{recursive:true,force:false});return true;}
  moveExact(sourceRootKey,sourceRelativePath,destinationRootKey,destinationRelativePath){const owned=new Set(['datasets','models']),allowed=(owned.has(sourceRootKey)&&destinationRootKey==='trash')||(sourceRootKey==='trash'&&owned.has(destinationRootKey));if(!allowed)throw Object.assign(new Error('lifecycle moves are restricted to Viewer-owned storage and trash'),{code:'external_reference'});const source=this.resolve(sourceRootKey,sourceRelativePath,{mustExist:true}),destination=this.resolve(destinationRootKey,destinationRelativePath);if(this.pathExistsStrict(destinationRootKey,destinationRelativePath))throw Object.assign(new Error('lifecycle destination already exists'),{code:'lifecycle_conflict'});if(fs.statSync(source).dev!==fs.statSync(this.roots[destinationRootKey]).dev)throw Object.assign(new Error('lifecycle move must remain on one filesystem'),{code:'lifecycle_cross_device'});fs.mkdirSync(path.dirname(destination),{recursive:true});fs.renameSync(source,destination);return true;}
  removeExact(rootKey,relativePath){if(rootKey!=='trash')throw Object.assign(new Error('lifecycle deletion is restricted to Viewer trash'),{code:'external_reference'});const target=this.resolve(rootKey,relativePath);if(!this.pathExistsStrict(rootKey,relativePath))return false;fs.rmSync(target,{recursive:true,force:false});return true;}
}

module.exports={StorageManager,descriptorMountId,hashFile,hashFileChunks,hashTree,jpegMetadata,parseExif,physicalStorageRootKey,readHead,scopedStorageRootKey};
