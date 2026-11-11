'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository'),{finalizeUpload}=require('../server/datasetOperationWorker');
const bytes=Buffer.from('raw data'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
test('CSV and GCP upload chunks survive expiry, cancellation, and successful finalization',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-csv-custody-')),db=openDatabase(':memory:'),p=new ProcessingRepository(db);t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});
 const project=p.createProject({displayName:'custody'});
 function upload(name,role){const dataset=p.createDataset({projectId:project.id,displayName:name,storageMode:'managed',rootKey:'datasets',relativePath:name});const file={id:'file',relativePath:name,byteSize:bytes.length,sha256:sha,...(role?{processingRole:role}:{})};const u=p.createUpload({datasetId:dataset.id,files:[file],subject:'fixture',chunkSize:20,expiresAt:'2000-01-01T00:00:00.000Z'}).upload;const filePath=path.join(dir,u.id);fs.mkdirSync(filePath);fs.writeFileSync(path.join(filePath,'original'),bytes);return {dataset,file,u,filePath};}
 const csv=upload('source.CSV'),gcp=upload('points.txt','gcp_source'),photo=upload('photo.jpg');
 assert.equal(p.expiredUploads().includes(csv.u.id),false);assert.equal(p.expiredUploads().includes(gcp.u.id),false);assert.equal(p.expiredUploads().includes(photo.u.id),true);
 for(const item of [csv,gcp,photo]){for(const id of p.cancelDatasetUploads(item.dataset.id))fs.rmSync(path.join(dir,id),{recursive:true,force:true});}
 assert.deepEqual(fs.readFileSync(path.join(csv.filePath,'original')),bytes);assert.deepEqual(fs.readFileSync(path.join(gcp.filePath,'original')),bytes);assert.equal(fs.existsSync(photo.filePath),false);
 for(const existing of [false,true]){
  const item=upload(existing?'existing.csv':'new.csv');let status=existing?'finalized':'draft',cleaned=false;
  const proc={uploadHasUnsafeFileIds:id=>p.uploadHasUnsafeFileIds(id),uploadRequiresRawCustody:id=>p.uploadRequiresRawCustody(id),getUpload:()=>({...item.u,status:'finalizing'}),getDataset:()=>({id:item.dataset.id,status,storageMode:'external_reference',relativePath:'x',files:[{...item.file,contentType:null,processingRole:'gcp_source'}]}),listChunks:()=>[{chunk_index:0}],finalizeDataset:()=>{status='finalized';return {id:item.dataset.id,status,storageMode:'external_reference'};},completeUpload:()=>{}};
  const storage={requireSpace(){},async assembleFile(){return item.file;},cleanupUpload(){cleaned=true;fs.rmSync(item.filePath,{recursive:true,force:true});}};
  await finalizeUpload({upload_id:item.u.id},{processing:proc,storage},'fixture',async()=>{});assert.equal(cleaned,false);assert.deepEqual(fs.readFileSync(path.join(item.filePath,'original')),bytes);
 }
});

