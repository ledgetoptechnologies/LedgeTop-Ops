import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { nativeTiffFixture } from './helpers/native-tiff-fixture.mjs';
import { prepareProcessingUnitEvidence } from '../server/processingUnitEvidence.js';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../server/database.js';
import { MeasurementSourceUnitEvidence, matchedSourceUnitEvidence } from '../server/measurementSourceUnitEvidence.js';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
// Real LAS 1.2 binary header and GeoTIFF VLR. The LAZ flag exercises the
// metadata-only compressed path; no assertion about point decoding is made.
function nativePoints({verticalUnit=null,compressed=true,unsupported=false}={}){
  const entries=[[1024,1],[3072,32616],[3076,9001],...(verticalUnit===null?[]:[[4099,verticalUnit]]),...(unsupported?[[4096,5703]]:[])];
  const keys=Buffer.alloc(8+entries.length*8);keys.writeUInt16LE(1,0);keys.writeUInt16LE(1,2);keys.writeUInt16LE(entries.length,6);
  entries.forEach(([key,value],i)=>{keys.writeUInt16LE(key,8+i*8);keys.writeUInt16LE(1,12+i*8);keys.writeUInt16LE(value,14+i*8);});
  const vlr=Buffer.alloc(54);vlr.write('LASF_Projection',2);vlr.writeUInt16LE(34735,18);vlr.writeUInt16LE(keys.length,20);
  const header=Buffer.alloc(227);header.write('LASF');header[24]=1;header[25]=2;
  header.writeUInt16LE(header.length,94);header.writeUInt32LE(header.length+vlr.length+keys.length,96);header.writeUInt32LE(1,100);
  header[104]=compressed?128:0;header.writeUInt16LE(20,105);for(const at of [131,139,147])header.writeDoubleLE(.01,at);
  return Buffer.concat([header,vlr,keys]);
}
function fixture(t,{verticalUnit=null,engineVersion='3.5.6',pointCloud=false,compressed=true,unsupported=false}={}){
  const destination=fs.mkdtempSync(path.join(os.tmpdir(),'ingestion-unit-evidence-'));
  t.after(()=>fs.rmSync(destination,{recursive:true,force:true}));
  const archiveFiles=[],inputFiles=[{relativePath:'photo.jpg',byteSize:4,sha256:sha('jpeg')}];
  const put=(relativePath,data)=>{const bytes=Buffer.from(data),file=path.join(destination,relativePath);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);const row={relativePath,byteSize:bytes.length,sha256:sha(bytes)};archiveFiles.push(row);return row;};
  const log={odmVersion:engineVersion,images:1,success:true,startTime:'2026-01-01T00:00:00Z',endTime:'2026-01-01T00:01:00Z',totalTime:60,
    options:{gcp:null,geo:null,align:null,sm_cluster:null,split_image_groups:null,rerun:null,rerun_from:null,rerun_all:false,split:999999,end_with:'odm_postprocess',gps_z_offset:0,dsm:true,dtm:true},
    stages:['dataset','opensfm','odm_georeferencing','odm_dem','odm_postprocess'].map(name=>({name,messages:[]})),processes:[{exitCode:0}]};
  put('log.json',JSON.stringify(log));put('images.json',JSON.stringify([{filename:'photo.jpg',latitude:43,longitude:-88,altitude:200}]));put('odm_georeferencing/coords.txt','WGS84 UTM 16N\n100 200\n1 2 200\n');
  const assets=['dsm','dtm'].map(kind=>({id:kind,kind,...put(`odm_dem/${kind}.tif`,nativeTiffFixture({verticalUnit})),relativePath:`task/attempt/odm_dem/${kind}.tif`}));
  if(pointCloud){assets.length=0;assets.push({id:'point',kind:'pointCloud',...put('odm_georeferencing/odm_georeferenced_model.laz',nativePoints({verticalUnit,compressed,unsupported})),relativePath:'task/attempt/odm_georeferencing/odm_georeferenced_model.laz'});}
  const producer={archiveFiles,inputFiles,receipt:{operation:'create',status:'completed',providerTaskId:'task',completedTaskId:'task',archiveSha256:sha('archive'),inputManifestSha256:sha(JSON.stringify(inputFiles))}};
  return{destination,assets,producer,sourcePrefix:'task/attempt',modelId:'model',modelVersionId:'version'};
}
test('ingestion prepares both registered native raster identities from real metadata and bound artifacts',async t=>{
  const f=fixture(t),candidates=await prepareProcessingUnitEvidence(f);
  assert.equal(candidates.length,2);
  for(const item of candidates){assert.equal(item.request.modelVersionId,'version');assert.equal(item.request.source.id,item.input.source.kind);assert.equal(item.input.source.verticalUnit,null);assert.equal(item.request.coordinateReference.crs,'EPSG:32616');}
});

test('native LAS/LAZ headers and durable receipts prepare and persist matched verified point evidence',async t=>{
  for(const compressed of [false,true])for(const verticalUnit of [null,9001]){
    const f=fixture(t,{pointCloud:true,compressed,verticalUnit}),candidates=await prepareProcessingUnitEvidence(f);
    assert.equal(candidates.length,1);const {request,input}=candidates[0];
    assert.equal(input.source.verticalUnit,verticalUnit===null?null:'metre');
    const db=new DatabaseSync(':memory:');t.after(()=>db.close());applyMigrations(db);
    db.prepare("INSERT INTO models(id,provider,provider_model_id,display_name,status,created_at,updated_at) VALUES('model','test','model','Model','importing','now','now')").run();
    db.prepare("INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at) VALUES('version','model','version','{}','importing','now','now')").run();
    const source=request.source;
    db.prepare("INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,byte_size,sha256,created_at) VALUES(?,'version','pointCloud','models',?,?,?,'now')").run(source.id,source.relativePath,source.byteSize,source.sha256);
    const store=new MeasurementSourceUnitEvidence(db),evidence=store.recordVerifiedOdm(request,input);
    assert.equal(evidence.basis,'verified-odm-source');assert.equal(evidence.verticalUnit,'m');
    assert.deepEqual(matchedSourceUnitEvidence(request,evidence),evidence);
    assert.equal(matchedSourceUnitEvidence(request,{...evidence,basis:'administrator-reviewed-source'}),null);
    assert.equal(matchedSourceUnitEvidence({...request,source:{...source,sha256:sha('changed')}},evidence),null);
  }
});

test('native points reject feet, unsupported metadata, unaudited versions and absent receipts',async t=>{
  for(const options of [{verticalUnit:9002},{verticalUnit:9003},{verticalUnit:9999},{unsupported:true},{engineVersion:'3.5.7'}]){
    assert.deepEqual(await prepareProcessingUnitEvidence(fixture(t,{pointCloud:true,...options})),[]);
  }
  const f=fixture(t,{pointCloud:true});delete f.producer.receipt;
  assert.deepEqual(await prepareProcessingUnitEvidence(f),[]);
});

test('changed native bytes cannot reuse the registered hash or producer receipt',async t=>{
  const f=fixture(t,{pointCloud:true}),file=path.join(f.destination,'odm_georeferencing/odm_georeferenced_model.laz');
  const bytes=fs.readFileSync(file);bytes[50]^=1;fs.writeFileSync(file,bytes);
  await assert.rejects(prepareProcessingUnitEvidence(f),{code:'source_changed'});
});
test('feet, unsupported engines and missing receipts never auto-resolve',async t=>{
  for(const options of [{verticalUnit:9002},{engineVersion:'unknown'}])assert.deepEqual(await prepareProcessingUnitEvidence(fixture(t,options)),[]);
  const f=fixture(t);assert.deepEqual(await prepareProcessingUnitEvidence({...f,producer:null}),[]);
  f.producer.archiveFiles=f.producer.archiveFiles.filter(file=>file.relativePath!=='log.json');
  assert.deepEqual(await prepareProcessingUnitEvidence(f),[]);
});
test('changed companion artifact bytes fail integrity instead of authorizing a unit assumption',async t=>{
  const f=fixture(t),log=path.join(f.destination,'log.json'),bytes=fs.readFileSync(log);bytes[0]^=1;fs.writeFileSync(log,bytes);
  await assert.rejects(prepareProcessingUnitEvidence(f),{code:'source_changed'});
});
test('asset path or source identity mismatch cannot borrow producer evidence',async t=>{
  const f=fixture(t);f.assets[0].sha256=sha('wrong');f.assets[1].relativePath='other/odm_dem/dtm.tif';
  assert.deepEqual(await prepareProcessingUnitEvidence(f),[]);
});
