'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createArchiveLedger,createVerifiedArchiveReader}=require('../server/verifiedArchiveReader');
test('verified reader serves original cross-chunk bytes and rejects transient replacement',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'verified-archive-')),file=path.join(dir,'archive'),original=Buffer.from('abcdefghijklmnopq');
  fs.writeFileSync(file,original);const fd=fs.openSync(file,'r+');t.after(()=>{fs.closeSync(fd);fs.rmSync(dir,{recursive:true,force:true})});
  const ledger=createArchiveLedger(8);ledger.update(original.subarray(0,3));ledger.update(original.subarray(3,14));ledger.update(original.subarray(14));
  const reader=createVerifiedArchiveReader(fd,ledger.finish());
  assert.equal(reader.readAt(6,6).toString(),'ghijkl');
  let chunks=[];for await(const bytes of reader.stream(5,10))chunks.push(bytes);assert.equal(Buffer.concat(chunks).toString(),'fghijklmno');
  fs.writeSync(fd,Buffer.from('ZZ'),0,2,9);assert.equal(reader.readAt(8,1).toString(),'i','cached verified bytes remain immutable');reader.clearCache();assert.throws(()=>reader.readAt(8,1),{code:'processing_archive_changed'});
  fs.writeSync(fd,original.subarray(9,11),0,2,9);assert.equal(reader.readAt(8,3).toString(),'ijk');
  fs.writeSync(fd,Buffer.from('Z'),0,1,9);assert.equal(reader.readAt(8,1).toString(),'i');
  assert.equal(reader.readAt(0,1).toString(),'a','reading another chunk evicts the cached proof buffer');
  assert.throws(()=>reader.readAt(8,1),{code:'processing_archive_changed'},'evicted chunks are verified again');
  fs.writeSync(fd,original.subarray(9,10),0,1,9);
  fs.ftruncateSync(fd,16);assert.throws(()=>reader.readAt(16,1),{code:'processing_archive_changed'});
});
test('verified reader enforces cancellation and exact proof count',()=>{
  const ledger=createArchiveLedger(4);ledger.update(Buffer.from('abcde'));const proof=ledger.finish();
  assert.throws(()=>createVerifiedArchiveReader(0,{...proof,proofs:[]}),{code:'processing_archive_changed'});
  const reader=createVerifiedArchiveReader(0,proof,{signal:AbortSignal.abort()});assert.throws(()=>reader.readAt(0,1),{code:'lease_lost'});
});
test('ZIP extraction rejects a temporary payload rewrite before using it',async t=>{
  const {makeZip}=require('./helpers/zipFixture'),{extractZipDescriptor}=require('../server/safeZip');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'verified-zip-')),file=path.join(dir,'archive.zip'),destination=path.join(dir,'output');
  const original=makeZip([{path:'a.txt',data:'first'},{path:'b.txt',data:'second'}]);
  fs.writeFileSync(file,original);const fd=fs.openSync(file,'r+');t.after(()=>{fs.closeSync(fd);fs.rmSync(dir,{recursive:true,force:true})});
  const ledger=createArchiveLedger(32);ledger.update(original);const archiveReader=createVerifiedArchiveReader(fd,ledger.finish());
  let changed=false;
  await assert.rejects(extractZipDescriptor(fd,original.length,destination,{archiveReader,maxEntries:10,maxBytes:1024,workId:'verified',onProgress(){
    if(!changed){changed=true;const position=original.indexOf(Buffer.from('second'));assert.ok(position>=0);fs.writeSync(fd,Buffer.from('X'),0,1,position);}
  }}),{code:'processing_archive_changed'});
  fs.writeSync(fd,original,0,original.length,0);
  assert.equal(fs.existsSync(destination),false,'a rejected transient rewrite must never be promoted');
});
test('ZIP extraction detects a changed local header before trusting it',async t=>{
  const {makeZip}=require('./helpers/zipFixture'),{extractZipDescriptor}=require('../server/safeZip');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'verified-header-')),file=path.join(dir,'archive.zip'),destination=path.join(dir,'output');
  const original=makeZip([{path:'a.txt',data:'first'},{path:'b.txt',data:'second'}]);fs.writeFileSync(file,original);
  const fd=fs.openSync(file,'r+');t.after(()=>{fs.closeSync(fd);fs.rmSync(dir,{recursive:true,force:true})});
  const ledger=createArchiveLedger(32);ledger.update(original);const archiveReader=createVerifiedArchiveReader(fd,ledger.finish());
  let altered=false;await assert.rejects(extractZipDescriptor(fd,original.length,destination,{archiveReader,maxEntries:10,maxBytes:1024,workId:'header',onProgress(){
    if(!altered){altered=true;const first=original.indexOf(Buffer.from([0x50,0x4b,3,4])),second=original.indexOf(Buffer.from([0x50,0x4b,3,4]),first+4);assert.ok(second>0);fs.writeSync(fd,Buffer.from([0]),0,1,second);}
  }}),{code:'processing_archive_changed'});
  fs.writeSync(fd,original,0,original.length,0);assert.equal(fs.existsSync(destination),false);
});
