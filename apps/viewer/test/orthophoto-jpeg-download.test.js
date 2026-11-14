'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createOrthophotoJpegDownload,parseJpegDownloadRange:range,jpegDownloadState}=require('../server/orthophotoJpegDownload');
test('sender construction performs no storage IO',()=>{
  const sender=createOrthophotoJpegDownload({storage:{resolve:()=>{throw new Error('unexpected IO');}}});
  assert.equal(typeof sender.send,'function');
});
test('all inert factories share read-only health with no reset or admission side effect',()=>{
  const before=jpegDownloadState();assert.deepEqual(before,{active:0,limit:2,halted:false});
  createOrthophotoJpegDownload();createOrthophotoJpegDownload();
  assert.deepEqual(jpegDownloadState(),before);assert.equal(Object.isFrozen(before),true);
  assert.throws(()=>{before.halted=true;},TypeError);
  assert.equal('reset' in before,false);
});
test('preflight rejection cannot consume a send slot or invoke storage',async()=>{
  const before=jpegDownloadState();
  const sender=createOrthophotoJpegDownload({storage:{resolve:()=>{throw new Error('unexpected IO');}}});
  await assert.rejects(sender.send(null,null,null,()=>true),error=>
    error.code==='jpeg_download_runtime'||error.code==='jpeg_download_request');
  assert.deepEqual(jpegDownloadState(),before);
});
test('absent single open-ended suffix and clamped ranges normalize exactly',()=>{
  assert.equal(range(undefined,100),null);assert.equal(range(null,100),null);
  for(const [header,expected] of [['bytes=0-0',{start:0,end:0}],['bytes=20-',{start:20,end:99}],
    ['bytes=-20',{start:80,end:99}],['bytes=-999',{start:0,end:99}],
    ['bytes=20-999999999999999999999999',{start:20,end:99}],['bytes=0-99',{start:0,end:99}]])
    assert.deepEqual(range(header,100),expected);
});
test('malformed multi unsatisfiable zero-suffix and excessive header ranges reject',()=>{
  for(const header of ['', 'bytes=-','bytes=-0','bytes=100-','bytes=9-8','bytes=0-1,4-5',
    'bytes= 0-1','bytes=+0-1','bytes=1.5-2','Bytes=0-1','items=0-1',[], 'bytes='+ '9'.repeat(128)+'-'])
    assert.throws(()=>range(header,100),{code:'jpeg_download_range',status:416});
  for(const size of [0,-1,NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1])
    assert.throws(()=>range(undefined,size),{code:'jpeg_download_size',status:409});
});
