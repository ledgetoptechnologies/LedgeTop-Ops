'use strict';
const crypto=require('node:crypto');
const path=require('node:path');
const {GcpSourceOriginals,MAX_GCP_SOURCE_BYTES}=require('./gcpSourceOriginals');
const {readIndexedOriginal}=require('./gcpDatasetRetention');
const isSource=file=>file?.processingRole==='gcp_source'||/\.csv$/i.test(file?.relativePath||'');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

// Completed CSV bytes must survive even when another image in the same upload
// never completes, before dataset_files exists. Never parse or normalize here.
function retainUploadedGcpOriginal(processing,storage,upload,file,rawLocation=null){
  if(!isSource(file))return null;
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(upload?.id||'')||!/^[A-Za-z0-9_-]{1,128}$/.test(file.id||'')||
    !Number.isSafeInteger(file.byteSize)||file.byteSize<0||
    !/^[a-f0-9]{64}$/.test(file.sha256||'')||!Number.isSafeInteger(upload.chunkSize)||upload.chunkSize<=0)
    fail('gcp_original_upload_invalid');
  // Oversized/invalid GCP input must not block the photo upload. Its raw cache
  // tree remains protected by cleanup below; do not load it into the BLOB store.
  if(file.byteSize>MAX_GCP_SOURCE_BYTES)return null;
  const originals=new GcpSourceOriginals(processing.database),fileName=path.posix.basename(file.relativePath);
  const saved=processing.database.prepare(`SELECT id FROM viewer_gcp_source_originals
    WHERE dataset_id=? AND sha256=? AND byte_size=? AND file_name=? AND fidelity='original_bytes' LIMIT 1`)
    .get(upload.datasetId,file.sha256,file.byteSize,fileName);
  const previous=saved&&originals.get(saved.id,upload.datasetId);
  if(previous)return originals.retain({datasetId:upload.datasetId,projectId:previous.originProjectId,
    fileName,bytes:previous.bytes,actorId:upload.subject});
  const dataset=processing.getDataset(upload.datasetId);
  if(!dataset)fail('gcp_original_upload_dataset_missing');
  const retain=bytes=>originals.retain({datasetId:upload.datasetId,projectId:dataset.projectId,
    fileName,bytes,actorId:upload.subject});
  function assembledBytes(){
    try{return readIndexedOriginal(storage,rawLocation?.rootKey||dataset.rootKey,rawLocation?.relativePath||dataset.relativePath,
      {byte_size:file.byteSize,sha256:file.sha256,relative_path:file.relativePath});}
    catch(error){if(['ENOENT','ENOTDIR'].includes(error.code))return null;throw error;}
  }
  const chunks=processing.listChunks(upload.id,file.id),expected=Math.ceil(file.byteSize/upload.chunkSize)||1;
  if(chunks.length<expected){const bytes=assembledBytes();return bytes?retain(bytes):null;}
  if(chunks.length!==expected||chunks.some((row,index)=>row.chunk_index!==index))fail('gcp_original_upload_chunks_invalid');
  const pieces=[];
  try{
    for(let index=0;index<chunks.length;index++){
      const row=chunks[index],size=index===expected-1?file.byteSize-upload.chunkSize*(expected-1):upload.chunkSize;
      if(row.byte_size!==size||!/^[a-f0-9]{64}$/.test(row.sha256||''))fail('gcp_original_upload_chunks_invalid');
      pieces.push(readIndexedOriginal(storage,'cache',`uploads/${upload.id}/${file.id}`,
        {byte_size:size,sha256:row.sha256,relative_path:`${index}.part`}));
    }
  }catch(error){
    if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;
    // Older finalized uploads may already have removed their chunk cache.
    // Recover only the exact size/hash manifest-bound assembled raw source.
    const bytes=assembledBytes();if(bytes)return retain(bytes);throw error;
  }
  const bytes=Buffer.concat(pieces,file.byteSize);
  if(hash(bytes)!==file.sha256)fail('gcp_original_upload_hash_mismatch');
  return retain(bytes);
}

function cleanupUploadPreservingGcp(processing,storage,uploadId){
  const upload=processing.getUpload(uploadId);
  if(!upload)fail('gcp_original_upload_metadata_missing');
  const retained=[],incomplete=[];
  for(const file of upload.files.filter(isSource)){
    const original=retainUploadedGcpOriginal(processing,storage,upload,file);
    if(original)retained.push(original.id);
    else incomplete.push(file.id);
  }
  // A partial file is not an original. Preserve its cache tree, without falsely
  // registering it as complete or preventing deletion of the enclosing dataset.
  if(incomplete.length)return {cleaned:false,retained,incomplete};
  storage.cleanupUpload(uploadId);return {cleaned:true,retained,incomplete};
}
module.exports={isSource,retainUploadedGcpOriginal,cleanupUploadPreservingGcp};
