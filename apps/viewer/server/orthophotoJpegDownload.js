'use strict';
const fs=require('node:fs/promises');
const {constants}=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const UUID='[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}';
const PRODUCT_PATH=new RegExp(`^orthophoto-jpeg/ortho-jpeg-${UUID}/image\\.jpg$`);
const fail=(code,status)=>{throw Object.assign(new Error(code),{code,status});};
const need=(value,code,status)=>{if(!value)fail(code,status);};
const stamp=s=>['dev','ino','size','mtimeNs','ctimeNs','uid','gid','mode','nlink'].map(key=>String(s[key]));
const directoryStamp=s=>['dev','ino','uid','gid','mode'].map(key=>String(s[key]));
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// Shared by every factory in this Node process. There is deliberately no reset
// or lease takeover: unknown descriptor closure requires owner intervention.
let activeJpegSends=0,jpegDownloadsHalted=false;
const jpegDownloadState=()=>Object.freeze({active:activeJpegSends,limit:2,halted:jpegDownloadsHalted});
const canonical=value=>typeof value==='string'&&value.length<=4096&&value!=='/'&&value.startsWith('/')&&
  !/[\x00-\x1f\x7f\\:]/.test(value)&&path.posix.normalize(value)===value&&!value.endsWith('/');

function parseJpegDownloadRange(header,size){
  need(Number.isSafeInteger(size)&&size>0,'jpeg_download_size',409);
  if(header===undefined||header===null)return null;
  need(typeof header==='string'&&header.length<=128,'jpeg_download_range',416);
  const match=/^bytes=(\d*)-(\d*)$/.exec(header);
  need(match&&(match[1]||match[2]),'jpeg_download_range',416);
  const total=BigInt(size);let start,end;
  if(!match[1]){
    const suffix=BigInt(match[2]);need(suffix>0n,'jpeg_download_range',416);
    start=suffix>=total?0n:total-suffix;end=total-1n;
  }else{
    start=BigInt(match[1]);end=match[2]?BigInt(match[2]):total-1n;
    need(start<total&&end>=start,'jpeg_download_range',416);
    if(end>=total)end=total-1n;
  }
  return {start:Number(start),end:Number(end)};
}

// Capabilities and live source/share/version authorization belong to the caller.
// This sender accepts only the single typed JPG product, never a generic cache path.
// Hash/stamp checks are not protection against a hostile concurrent inode writer;
// the deployment must keep succeeded job files immutable to other workloads.
function createOrthophotoJpegDownload({storage}={}){
  async function send(req,res,selection,revalidate){
    need(!jpegDownloadsHalted,'jpeg_download_halted',503);
    need(activeJpegSends<2,'jpeg_download_busy',429);
    need(process.platform==='linux'&&process.getuid()===568&&Number.isInteger(constants.O_NOFOLLOW)&&
      Number.isInteger(constants.O_NONBLOCK),'jpeg_download_runtime',503);
    need(typeof storage?.resolve==='function'&&typeof revalidate==='function','jpeg_download_configuration',503);
    need(req&&res&&typeof req.on==='function'&&typeof req.removeListener==='function'&&
      typeof res.on==='function'&&typeof res.removeListener==='function'&&typeof res.setHeader==='function'&&
      typeof res.end==='function'&&req.headers&&['GET','HEAD'].includes(req.method),'jpeg_download_request',503);
    need(selection&&selection.rootKey==='cache'&&typeof selection.relativePath==='string'&&PRODUCT_PATH.test(selection.relativePath)&&
      typeof selection.sha256==='string'&&/^[a-f0-9]{64}$/.test(selection.sha256)&&
      Number.isSafeInteger(selection.byteSize)&&selection.byteSize>0&&selection.byteSize<=65500*65500*3+32*1024*1024,
      'jpeg_download_selection',404);
    const owned=new Set(),abort=new AbortController();let firstFailure=null;
    const cancel=()=>abort.abort(Object.assign(new Error('jpeg_download_aborted'),{code:'jpeg_download_aborted',status:499}));
    const responseClosed=()=>{if(!res.writableFinished)cancel();};
    const check=()=>{if(abort.signal.aborted)throw abort.signal.reason;};
    async function call(fn){check();const value=await fn();check();return value;}
    async function open(absolute,directory=false){
      check();const fd=await fs.open(absolute,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|
        (directory?constants.O_DIRECTORY:0));owned.add(fd);check();return fd;
    }
    async function pinDirectory(absolute){
      need(canonical(absolute)&&await call(()=>fs.realpath(absolute))===absolute,'jpeg_download_directory',409);
      const fd=await open(absolute,true),s=await call(()=>fd.stat({bigint:true}));
      need(s.isDirectory()&&s.uid===568n&&(s.mode&0o7777n)===0o700n,'jpeg_download_directory',409);
      return {path:absolute,fd,identity:directoryStamp(s)};
    }
    async function directoryCurrent(pin){
      need(await call(()=>fs.realpath(pin.path))===pin.path,'jpeg_download_directory_changed',409);
      const held=await call(()=>pin.fd.stat({bigint:true})),named=await call(()=>fs.lstat(pin.path,{bigint:true}));
      need(held.isDirectory()&&named.isDirectory()&&equal(pin.identity,directoryStamp(held))&&
        equal(pin.identity,directoryStamp(named)),'jpeg_download_directory_changed',409);
    }
    activeJpegSends++;
    try{
      req.on('aborted',cancel);res.on('close',responseClosed);
      if(req.aborted)cancel();
      const base=await call(()=>storage.resolve('cache','orthophoto-jpeg',{mustExist:true}));
      need(canonical(base),'jpeg_download_directory',409);
      const relative=selection.relativePath.slice('orthophoto-jpeg/'.length),absolute=`${base}/${relative}`;
      const root=await pinDirectory(base),stage=await pinDirectory(path.posix.dirname(absolute));
      need(await call(()=>storage.resolve('cache',selection.relativePath,{mustExist:true}))===absolute,
        'jpeg_download_path_changed',409);
      need(await call(()=>fs.realpath(absolute))===absolute,'jpeg_download_path_changed',409);
      const fd=await open(absolute),initial=await call(()=>fd.stat({bigint:true})),identity=stamp(initial);
      need(initial.isFile()&&initial.nlink===1n&&initial.uid===568n&&(initial.mode&0o7777n)===0o600n&&
        initial.size===BigInt(selection.byteSize),'jpeg_download_file_changed',409);
      async function current(){
        need(await call(()=>storage.resolve('cache','orthophoto-jpeg',{mustExist:true}))===base&&
          await call(()=>storage.resolve('cache',selection.relativePath,{mustExist:true}))===absolute&&
          await call(()=>fs.realpath(absolute))===absolute,'jpeg_download_path_changed',409);
        await directoryCurrent(root);await directoryCurrent(stage);
        const held=await call(()=>fd.stat({bigint:true})),named=await call(()=>fs.lstat(absolute,{bigint:true}));
        need(held.isFile()&&named.isFile()&&equal(identity,stamp(held))&&equal(identity,stamp(named)),
          'jpeg_download_file_changed',409);
      }
      await current();const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);
      for(let at=0;at<selection.byteSize;at+=buffer.length){
        const size=Math.min(buffer.length,selection.byteSize-at);let offset=0;
        while(offset<size){const row=await call(()=>fd.read(buffer,offset,size-offset,at+offset));
          need(row.bytesRead>0,'jpeg_download_short_read',409);offset+=row.bytesRead;}
        digest.update(buffer.subarray(0,size));
      }
      need(digest.digest('hex')===selection.sha256,'jpeg_download_integrity',409);await current();
      need(Boolean(await call(()=>revalidate())),'jpeg_download_revoked',403);
      // Revalidation may await external authorization. Recheck the same inode
      // and resolver binding again immediately before headers or body bytes.
      await current();
      const etag=`"${selection.sha256}"`,rangeHeader=req.headers.range,ifRange=req.headers['if-range'];
      res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Type','image/jpeg');
      res.setHeader('Content-Disposition','attachment; filename="orthophoto.jpg"');
      res.setHeader('Accept-Ranges','bytes');res.setHeader('ETag',etag);
      let range;
      try{range=parseJpegDownloadRange(ifRange!==undefined&&ifRange!==etag?undefined:rangeHeader,selection.byteSize);}
      catch(error){if(error.status!==416)throw error;res.statusCode=416;
        res.setHeader('Content-Range',`bytes */${selection.byteSize}`);res.setHeader('Content-Length',0);res.end();return;}
      const start=range?.start??0,end=range?.end??selection.byteSize-1;
      res.statusCode=range?206:200;res.setHeader('Content-Length',end-start+1);
      if(range)res.setHeader('Content-Range',`bytes ${start}-${end}/${selection.byteSize}`);
      if(req.method==='HEAD'){res.end();return;}
      await pipeline(fd.createReadStream({start,end,autoClose:false}),res,{signal:abort.signal});
    }catch(caught){
      const error=caught&&typeof caught==='object'?caught:new Error('jpeg_download_io',{cause:caught});
      firstFailure=error;
      if(abort.signal.aborted)throw abort.signal.reason;
      if(error.code?.startsWith('jpeg_download_'))throw error;
      const missing=['ENOENT','ENOTDIR'].includes(error.code);
      throw Object.assign(new Error(missing?'jpeg_download_not_found':'jpeg_download_io'),
        {code:missing?'jpeg_download_not_found':'jpeg_download_io',status:missing?404:409,cause:error});
    }finally{
      req.removeListener('aborted',cancel);res.removeListener('close',responseClosed);
      const outcomes=await Promise.all([...owned].map(async fd=>{
        try{await fd.close();return true;}catch{jpegDownloadsHalted=true;return false;}
      }));
      if(outcomes.every(Boolean))activeJpegSends--;
      if(!outcomes.every(Boolean))throw Object.assign(new Error('jpeg_download_close_unknown'),
        {code:'jpeg_download_close_unknown',status:503,resourceCleanupUnknown:true,cause:firstFailure});
    }
  }
  return {send};
}
module.exports={createOrthophotoJpegDownload,parseJpegDownloadRange,jpegDownloadState};
