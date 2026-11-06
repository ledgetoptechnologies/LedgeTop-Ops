'use strict';
// Disabled byte-verification primitive, not a receiver or acceptance receipt.
// The caller must supply a newly created, exclusively owned regular-file handle
// inside an already secured destination; this module cannot establish that fence.
const crypto=require('node:crypto');
async function captureVerified({source,file,byteSize,sha256,maxBytes,signal=null,enabled=false}){
  const hold=()=>Object.assign(new Error('reference result bytes require review'),{code:'native_reference_object_hold'});
  if(enabled!==true||!source||typeof source[Symbol.asyncIterator]!=='function'||!file||typeof file.stat!=='function'||typeof file.write!=='function'||typeof file.sync!=='function'||!Number.isSafeInteger(byteSize)||byteSize<0||!Number.isSafeInteger(maxBytes)||maxBytes<0||byteSize>maxBytes||typeof sha256!=='string'||!/^[0-9a-f]{64}$/.test(sha256))throw hold();
  try{signal?.throwIfAborted();const initial=await file.stat();if(!initial.isFile()||initial.size!==0)throw hold();let written=0;const hash=crypto.createHash('sha256');for await(const chunk of source){signal?.throwIfAborted();if(!(chunk instanceof Uint8Array)||chunk.byteLength>1024*1024||written+chunk.byteLength>byteSize)throw hold();const data=Buffer.from(chunk);let offset=0;while(offset<data.length){signal?.throwIfAborted();const result=await file.write(data,offset,data.length-offset,written+offset);if(!Number.isSafeInteger(result.bytesWritten)||result.bytesWritten<=0)throw hold();offset+=result.bytesWritten;}hash.update(data);written+=data.length;}signal?.throwIfAborted();if(written!==byteSize||hash.digest('hex')!==sha256)throw hold();await file.sync();const final=await file.stat();if(!final.isFile()||final.dev!==initial.dev||final.ino!==initial.ino||final.size!==byteSize)throw hold();return{byteSize,sha256};}catch{throw hold();}
}
module.exports={captureVerified};
