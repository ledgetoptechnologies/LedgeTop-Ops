'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const p=require('../server/referenceProtocol'),{prepareReferenceSubmission}=require('../server/referenceSubmissionDraft'),v=require('./fixtures/viewer-processing-source-map-public.json');
test('synthetic observed files map to the selected Processing manifest while retaining raw CSV',()=>{
 const datasetHash=crypto.createHash('sha256').update(JSON.stringify(v.observedFiles.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256})))).digest('hex');
 assert.deepEqual(v.observedFiles,v.preparationInput.dataset.files);assert.equal(v.preparationInput.dataset.manifestSha256,v.datasetManifestSha256);
 assert.equal(datasetHash,v.datasetManifestSha256);const result=prepareReferenceSubmission(v.preparationInput);assert.deepEqual(result.submission,v.submission);assert.deepEqual({...result.sourceFiles},v.sourceFiles);assert.deepEqual(result.permanentCsvIds,v.retainedExcludedIds);
 assert.equal(p.manifestSha256(v.submission.manifest),v.processingManifestSha256);assert.notEqual(v.processingManifestSha256,v.datasetManifestSha256);
 for(const object of v.submission.manifest.objects){const row=v.observedFiles.find(file=>file.id===object.id);assert.ok(row);assert.equal(result.sourceFiles[object.id],row.relativePath);assert.equal(object.name,path.posix.basename(row.relativePath));assert.equal(object.byteSize,row.byteSize);assert.equal(object.sha256,row.sha256)}
 assert.deepEqual(v.retainedExcludedIds,['survey']);assert.equal(v.submission.manifest.objects.some(object=>object.id==='survey'),false);
});
