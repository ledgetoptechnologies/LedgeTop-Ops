'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createOrthophotoJpegIo,evidenceBytes,stamp,dirStamp,resolveBoundPath}=require('../server/orthophotoJpegIo');
test('factory is inert and does not touch configured storage or process adapters',()=>{
  const unexpected=()=>{throw new Error('unexpected adapter call');};
  const io=createOrthophotoJpegIo({storage:{resolve:unexpected,requireSpace:unexpected},jobs:{sourceMatches:unexpected},
    processExecutor:{execute:unexpected},stagingParent:'/private/scratch'});
  assert.deepEqual(Object.keys(io).sort(),['execute','prepare','recordEvidence','releasePrepared','validateOutput']);
});
test('full file stamps preserve nanoseconds exactly while directory pins ignore child mutations',()=>{
  const s={dev:1n,ino:2n,size:123n,mtimeNs:9007199254740993001n,ctimeNs:9007199254740993002n,
    uid:568n,gid:568n,mode:33152n,nlink:1n};
  assert.equal(stamp(s)[3],'9007199254740993001');
  assert.notDeepEqual(stamp(s),stamp({...s,mtimeNs:s.mtimeNs+1n}));
  assert.deepEqual(dirStamp(s),dirStamp({...s,size:999n,mtimeNs:1n,ctimeNs:2n}));
  for(const key of ['dev','ino','uid','gid','mode'])assert.notDeepEqual(dirStamp(s),dirStamp({...s,[key]:s[key]+1n}));
});
test('private evidence selects only approved fields and never serializes hook controls',()=>{
  const bytes=evidenceBytes({kind:'jpeg-validation',jobId:'job-1',evidence:{pixelDecodeVerified:false},
    signal:{secret:'not evidence'},assertCurrent:()=>{},prepared:{secret:'not evidence'}});
  assert.deepEqual(JSON.parse(bytes),{kind:'jpeg-validation',jobId:'job-1',evidence:{pixelDecodeVerified:false}});
  assert.ok(bytes.length<128*1024);
});
test('evidence rejects oversized strings nesting functions cycles and foreign objects',()=>{
  const base={kind:'jpeg-closure',jobId:'job-1'};const cycle={};cycle.self=cycle;
  for(const evidence of [{text:'x'.repeat(128*1024)},cycle,{fn:()=>{}},{signal:new AbortController().signal},
    {number:Infinity},{raw:Buffer.from('private')},{stamp:1n}])
    assert.throws(()=>evidenceBytes({...base,evidence}));
  assert.throws(()=>evidenceBytes({...base,jobId:'../path'}));
});
test('unbranded release cannot close any resource',async()=>{
  await assert.rejects(createOrthophotoJpegIo().releasePrepared({prepared:{}}),{code:'jpeg_io_prepared_identity'});
});
test('registered alias retargeting is rejected while its old canonical path remains unchanged',async()=>{
  let target='/models/original.tif',checks=0;const calls=[];
  const storage={resolve:(...args)=>{calls.push(args);return target;}};
  const context={assertCurrent:()=>{checks++;}};
  assert.equal(await resolveBoundPath(storage,'models','alias.tif','/models/original.tif',context),target);
  target='/models/replacement.tif';
  await assert.rejects(resolveBoundPath(storage,'models','alias.tif','/models/original.tif',context),
    {code:'jpeg_io_storage_binding_changed'});
  assert.deepEqual(calls,[['models','alias.tif',{mustExist:true}],['models','alias.tif',{mustExist:true}]]);
  assert.equal(checks,4);
});
test('configured cache identity and cancellation after resolver await fail closed',async()=>{
  await assert.rejects(resolveBoundPath({resolve:()=>'/cache/other'},'cache','orthophoto-jpeg',
    '/cache/orthophoto-jpeg',{assertCurrent:()=>{}}),{code:'jpeg_io_storage_binding_changed'});
  const abort=new AbortController();
  await assert.rejects(resolveBoundPath({resolve:()=>{abort.abort();return '/cache/orthophoto-jpeg';}},
    'cache','orthophoto-jpeg','/cache/orthophoto-jpeg',{signal:abort.signal,assertCurrent:()=>{}}));
});
