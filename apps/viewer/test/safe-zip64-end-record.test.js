'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {Readable}=require('node:stream');
const {makeZip64EndRecord}=require('./helpers/zipFixture');
const {extractZipDescriptor}=require('../server/safeZip');
const {captureProcessingArchive,verifyProcessingArchive}=require('../server/processingArchiveEvidence');
const linux={skip:process.platform!=='linux'&&'descriptor extraction requires Linux /proc/self/fd'};
const payload=Buffer.alloc(96*1024,0x30);
function fixture(t,bytes){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-zip64-tail-')),archive=path.join(root,'input.zip');fs.writeFileSync(archive,bytes);const fd=fs.openSync(archive,'r');t.after(()=>{fs.closeSync(fd);fs.rmSync(root,{recursive:true,force:true});});return{fd,root,destination:path.join(root,'expanded')};}

for(const comment of ['', 'metadata'.repeat(700), 'z'.repeat(65535)])test(`validated ZIP64 end record extracts with comment length ${comment.length}`,linux,async t=>{
 const bytes=makeZip64EndRecord([{path:'result.bin',data:payload}],{comment}),f=fixture(t,bytes);
 const result=await extractZipDescriptor(f.fd,bytes.length,f.destination,{maxEntries:10,maxBytes:1024*1024});
 assert.deepEqual(result,{entries:1,bytes:payload.length});assert.deepEqual(fs.readFileSync(path.join(f.destination,'result.bin')),payload);fs.fstatSync(f.fd);
});

test('validated ZIP64 end record supports count sentinels without changing allocation limits',linux,async t=>{
 const bytes=makeZip64EndRecord([{path:'small.bin',data:'small'}]);bytes.writeUInt16LE(0xffff,bytes.length-14);bytes.writeUInt16LE(0xffff,bytes.length-12);
 const f=fixture(t,bytes),result=await extractZipDescriptor(f.fd,bytes.length,f.destination,{maxEntries:100000,maxBytes:100});
 assert.deepEqual(result,{entries:1,bytes:5});assert.equal(fs.readFileSync(path.join(f.destination,'small.bin'),'utf8'),'small');
});

test('ZIP64 response capture retains full digest and receipt after bounded extraction',linux,async t=>{
 const crypto=require('node:crypto'),bytes=makeZip64EndRecord([{path:'result.bin',data:payload}]),f=fixture(t,bytes);
 const receipt=await captureProcessingArchive(Readable.from([bytes]),f.destination,{maxEntries:10,maxBytes:1024*1024,maxArchiveBytes:1024*1024,maxDiskBytes:2*1024*1024});
 assert.equal(receipt.archiveSha256,crypto.createHash('sha256').update(bytes).digest('hex'));assert.equal(receipt.archiveByteSize,bytes.length);
 assert.equal(await verifyProcessingArchive(f.destination,receipt),true);
});

test('ZIP64 fix continues to reject a corrupt locator and publishes no destination',linux,async t=>{
 const bytes=makeZip64EndRecord([{path:'result.bin',data:payload}]);bytes.writeUInt32LE(0x30,bytes.length-42);const f=fixture(t,bytes);
 await assert.rejects(extractZipDescriptor(f.fd,bytes.length,f.destination,{maxEntries:10,maxBytes:1024*1024}),/zip64.*locator|ZIP64.*locator/);
 assert.equal(fs.existsSync(f.destination),false);
});
