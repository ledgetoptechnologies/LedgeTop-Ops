'use strict';
// Disabled Linux experiment. Trust requires an independently fenced root and UID.
const fs=require('node:fs'),path=require('node:path'),{validManifest,classifyResultResponse}=require('./nativeReferenceProtocolCandidate'),{captureVerified}=require('./nativeReferenceObjectCandidate');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hold=()=>Object.assign(new Error('reference storage requires review'),{code:'native_reference_storage_hold'});
async function protectedDirectory(directory){const s=await fs.promises.lstat(directory);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid()||(s.mode&0o077)!==0||await fs.promises.realpath(directory)!==path.resolve(directory))throw hold();return s;}
async function syncDirectory(directory){let h;try{h=await fs.promises.open(directory,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);await h.sync();}finally{if(h)await h.close();}}
async function stage({root,storageReceiptId,manifest,expected,openObject,maxBytes,signal=null,enabled=false}){
  if(enabled!==true||process.platform!=='linux'||typeof root!=='string'||!path.isAbsolute(root)||typeof storageReceiptId!=='string'||!uuid.test(storageReceiptId)||typeof openObject!=='function'||!Number.isSafeInteger(maxBytes)||maxBytes<0)throw hold();
  try{const checked=validManifest(manifest,expected);let total=0;for(const o of checked.objects){total+=o.byteSize;if(!Number.isSafeInteger(total)||total>maxBytes)throw hold();}signal?.throwIfAborted();await protectedDirectory(root);const directory=path.join(root,'receipt-'+storageReceiptId);await fs.promises.mkdir(directory,{mode:0o700});await protectedDirectory(directory);await syncDirectory(root);const objects=[];
    for(const object of checked.objects){signal?.throwIfAborted();const response=await openObject(object,{signal});if(!response||classifyResultResponse(response.status,response.body)!=='provisional'||!response.headers||typeof response.headers.get!=='function'||response.headers.get('content-length')!==String(object.byteSize)||response.headers.get('x-result-sha256')!==object.sha256||response.headers.get('x-result-manifest-sha256')!==checked.resultManifestSha256)throw hold();await protectedDirectory(root);await protectedDirectory(directory);const target=path.join(directory,'object-'+object.id);let file;try{file=await fs.promises.open(target,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);await captureVerified({source:response.source,file,byteSize:object.byteSize,sha256:object.sha256,maxBytes,signal,enabled:true});}finally{if(file)await file.close();}objects.push({id:object.id,byteSize:object.byteSize,sha256:object.sha256});}
    await protectedDirectory(directory);await syncDirectory(directory);await syncDirectory(root);return{storageReceiptId,objects};
  }catch{throw hold();}
}
module.exports={stage};
