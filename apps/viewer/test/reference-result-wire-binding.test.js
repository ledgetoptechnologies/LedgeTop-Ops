'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {ReferenceProvider} = require('../server/referenceProvider');
const p = require('../server/referenceProtocol');

function fixture(objectHeaders = {}, bytes = Buffer.from('abc')) {
  const manifest = {schemaVersion:1,jobId:'job-1',generation:1,environment:'staging',pipelineDigest:'a'.repeat(64),engineVersions:{odm:'synthetic-1'},objects:[{id:'archive-1',role:'odm_archive',byteSize:3,sha256:p.sha256('abc')}]};
  manifest.resultManifestSha256 = p.resultManifestSha256(manifest);
  const expected = {jobId:'job-1',generation:1,environment:'staging',pipelineDigest:manifest.pipelineDigest,requestedEngines:['odm'],resultManifestSha256:manifest.resultManifestSha256};
  const fetchImpl = async url => url.endsWith('/results')
    ? new Response(JSON.stringify(manifest),{headers:{'content-type':'application/json'}})
    : new Response(bytes,{headers:{'content-type':'application/zip','content-length':String(bytes.length),...objectHeaders}});
  return {manifest,expected,provider:new ReferenceProvider({endpoint:'https://example.test',token:'synthetic-token-only',environment:'staging',enabled:true,fetchImpl})};
}

test('result object is bound to sealed manifest headers and fully verified bytes', async () => {
  let f = fixture();
  f = fixture({'x-result-sha256':f.manifest.objects[0].sha256,'x-result-manifest-sha256':f.manifest.resultManifestSha256});
  await f.provider.results('job-1',f.expected);
  const chunks=[]; for await (const chunk of await f.provider.downloadObject('job-1','archive-1',{expectedBinding:f.expected})) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(),'abc');
});

test('missing or mismatched result binding headers fail before exposing bytes', async () => {
  const base=fixture();
  for (const headers of [{},{'x-result-sha256':base.manifest.objects[0].sha256},{'x-result-sha256':'b'.repeat(64),'x-result-manifest-sha256':base.manifest.resultManifestSha256},{'x-result-sha256':base.manifest.objects[0].sha256,'x-result-manifest-sha256':'c'.repeat(64)}]) {
    const f=fixture(headers); await f.provider.results('job-1',f.expected);
    await assert.rejects(f.provider.downloadObject('job-1','archive-1',{expectedBinding:f.expected}),{code:'BINDING_MISMATCH'});
  }
});

test('matching headers do not bypass verification of streamed bytes', async () => {
  const base=fixture();const f=fixture({'x-result-sha256':base.manifest.objects[0].sha256,'x-result-manifest-sha256':base.manifest.resultManifestSha256},Buffer.from('xyz'));
  await f.provider.results('job-1',f.expected);
  await assert.rejects(async()=>{for await(const chunk of await f.provider.downloadObject('job-1','archive-1',{expectedBinding:f.expected})) void chunk;},{code:'DIGEST_MISMATCH'});
});

test('result object requires canonical content length', async () => {
  const base=fixture();
  for (const length of ['', '03', '4']) {
    const f=fixture({'x-result-sha256':base.manifest.objects[0].sha256,'x-result-manifest-sha256':base.manifest.resultManifestSha256,'content-length':length});
    await f.provider.results('job-1',f.expected);
    await assert.rejects(f.provider.downloadObject('job-1','archive-1',{expectedBinding:f.expected}),error=>['BINDING_MISMATCH','BODY_LIMIT'].includes(error.code));
  }
  const manifest=base.manifest;const f=new ReferenceProvider({endpoint:'https://example.test',token:'synthetic-token-only',environment:'staging',enabled:true,fetchImpl:async url=>url.endsWith('/results')?new Response(JSON.stringify(manifest),{headers:{'content-type':'application/json'}}):new Response('abc',{headers:{'content-type':'application/zip','x-result-sha256':manifest.objects[0].sha256,'x-result-manifest-sha256':manifest.resultManifestSha256}})});
  await f.results('job-1',base.expected);await assert.rejects(f.downloadObject('job-1','archive-1',{expectedBinding:base.expected}),{code:'BINDING_MISMATCH'});
});

test('in-flight download remains bound to the original sealed manifest', async () => {
  const base=fixture(),old=base.manifest,newer=structuredClone(old);newer.engineVersions.odm='synthetic-2';newer.resultManifestSha256=p.resultManifestSha256(newer);
  let selected=old,release,started;const begun=new Promise(resolve=>{started=resolve});
  const f=new ReferenceProvider({endpoint:'https://example.test',token:'synthetic-token-only',environment:'staging',enabled:true,fetchImpl:async url=>{
    if(url.endsWith('/results'))return new Response(JSON.stringify(selected),{headers:{'content-type':'application/json'}});
    started();await new Promise(resolve=>{release=resolve});
    return new Response('abc',{headers:{'content-type':'application/zip','content-length':'3','x-result-sha256':old.objects[0].sha256,'x-result-manifest-sha256':old.resultManifestSha256}});
  }});
  await f.results('job-1',base.expected);const download=f.downloadObject('job-1','archive-1',{expectedBinding:base.expected});await begun;
  selected=newer;await f.results('job-1',{jobId:'job-1',generation:1,environment:'staging',pipelineDigest:old.pipelineDigest,requestedEngines:['odm']});release();
  const chunks=[];for await(const chunk of await download)chunks.push(chunk);assert.equal(Buffer.concat(chunks).toString(),'abc');
});
