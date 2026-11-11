'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {finalizeUpload,finalizedUploadMatches}=require('../server/datasetOperationWorker');

test('a finalized dataset matches only the complete unique upload manifest',()=>{
  const csv={relativePath:'control.csv',byteSize:3,sha256:'a'.repeat(64)};
  const photo={relativePath:'photo.jpg',byteSize:10,sha256:'b'.repeat(64)};
  const upload={files:[csv,photo]},dataset={files:[{...photo,processingRole:'image'},{...csv,processingRole:'gcp_source'}]};
  assert.equal(finalizedUploadMatches(upload,dataset),true);
  for(const files of [[],[photo],[photo,{...csv,sha256:'c'.repeat(64)}],[photo,{...csv,byteSize:4}],[csv,csv]])
    assert.equal(finalizedUploadMatches(upload,{files}),false);
  assert.equal(finalizedUploadMatches({files:[csv,csv]},{files:[csv,photo]}),false);
  assert.equal(finalizedUploadMatches(upload,{files:[photo,{...csv,sha256:'invalid'}]}),false);
  assert.equal(finalizedUploadMatches(upload,{files:[{...photo,processingRole:'administrative'},{...csv,processingRole:'gcp_source'}]}),false);
  assert.equal(finalizedUploadMatches(upload,{files:[{...photo,processingRole:'image',contentType:'image/jpeg'},{...csv,processingRole:'gcp_source'}]}),false);
});

test('a finalized dataset from a different upload cannot complete or clean up the pending upload',async()=>{
  const upload={id:'upload',datasetId:'dataset',files:[{relativePath:'control.csv',byteSize:3,sha256:'a'.repeat(64)}]};
  const dataset={id:'dataset',status:'finalized',files:[{relativePath:'control.csv',byteSize:3,sha256:'b'.repeat(64),processingRole:'gcp_source'}]};
  let completed=false,cleaned=false;
  const processing={getUpload:()=>upload,getDataset:()=>dataset,completeUpload:()=>{completed=true;}};
  const storage={cleanupUpload:()=>{cleaned=true;}};
  await assert.rejects(finalizeUpload({upload_id:upload.id,subject:'test'},{processing,storage},'owner',()=>{}),{code:'upload_finalized_manifest_mismatch'});
  assert.equal(completed,false);assert.equal(cleaned,false);
});
