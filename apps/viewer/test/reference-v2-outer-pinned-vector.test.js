'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {inspectPinnedFixture}=require('./helpers/reference-v2-outer-vector-inspector.cjs');
const p=require('../server/referenceProtocol');
const base=process.env.PROCESSING_V2_VECTOR_DIR;
function readBounded(file,limit){
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{
    const before=fs.fstatSync(fd);if(!before.isFile()||before.size<1||before.size>limit)throw Error('fixture_file_invalid');
    const buffer=Buffer.alloc(limit+1);let count=0,n;while((n=fs.readSync(fd,buffer,count,buffer.length-count,null))>0){count+=n;if(count>limit)throw Error('fixture_file_invalid')}
    const after=fs.fstatSync(fd);if(count!==before.size||after.size!==before.size)throw Error('fixture_file_invalid');return buffer.subarray(0,count);
  }finally{fs.closeSync(fd)}
}
test('exact pinned TreeDar and combined review vectors remain fixture-only',{skip:!base},async()=>{
  const source=readBounded(path.join(base,'sources','treedar-bundle-v1.contract.json'),256*1024);
  const v1=require('./fixtures/reference-v1-acceptance-sender.golden.json');
  assert.doesNotThrow(()=>p.validateResultManifest(v1.resultManifest,v1.expected));
  for(const mode of ['treedar_only','combined']){
    const raw=readBounded(path.join(base,'valid',`${mode}.json`),4*1024*1024);
    const result=await inspectPinnedFixture(mode,raw,source);
    assert.deepEqual(result,{mode,role:'treedar_bundle',artifactId:'treedar-file',files:22,action:'hold',scope:'exact-public-fixture-only'});
    const changed=Buffer.from(raw);changed[changed.length-2]^=1;
    await assert.rejects(inspectPinnedFixture(mode,changed,source),/pinned_fixture_invalid/);
    const changedSource=Buffer.from(source);changedSource[changedSource.length-2]^=1;
    await assert.rejects(inspectPinnedFixture(mode,raw,changedSource),/pinned_fixture_invalid/);
    const v2=JSON.parse(raw).documents.find(x=>x.type==='ResultManifest'&&x.value.stage.engine==='treedar').value;
    assert.throws(()=>p.validateResultManifest(v2,{}),{code:'INVALID_PROTOCOL'}); // Closed v1 is unchanged.
  }
  await assert.rejects(inspectPinnedFixture('production',Buffer.from('{}'),source),/pinned_fixture_invalid/);
});
