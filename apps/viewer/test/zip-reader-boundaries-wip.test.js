'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {descriptorSource,extractZipDescriptor}=require('../server/safeZip');
const {createArchiveLedger,createVerifiedArchiveReader}=require('../server/verifiedArchiveReader');
const {makeZip,makeZip64Descriptor}=require('./helpers/zipFixture');

function fixture(t,bytes){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zip-boundaries-wip-')),archive=path.join(root,'source.zip');fs.writeFileSync(archive,bytes);const fd=fs.openSync(archive,'r');
  t.after(()=>{fs.closeSync(fd);if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('zip-boundaries-wip-'))throw new Error('unexpected fixture root');fs.rmSync(root,{recursive:true,force:true});});
  const ledger=createArchiveLedger(8);ledger.update(bytes);return {root,archive,fd,descriptor:descriptorSource(fd,bytes.length),verified:createVerifiedArchiveReader(fd,ledger.finish())};
}
async function collect(readable){const chunks=[];for await(const chunk of readable)chunks.push(chunk);return Buffer.concat(chunks);}

// unzipper's file adapter has historically used a different stream-range
// convention; these assertions define the custom reader contract, not its API.
test('descriptor and verified range adapters return exactly the same finite bytes',async t=>{
  const bytes=Buffer.from('abcdefghijklmnopq'),c=fixture(t,bytes);
  for(const [offset,length] of [[0,1],[3,2],[7,3],[8,8],[16,1],[14,20]]){
    const expected=bytes.subarray(offset,Math.min(bytes.length,offset+length));
    assert.deepEqual(await collect(c.verified.stream(offset,length)),expected);
    assert.deepEqual(await collect(c.descriptor.stream(offset,length)),expected,`descriptor range ${offset}+${length}`);
  }
});

test('both custom readers handle EOF and reject zero-length finite ranges',async t=>{
  const c=fixture(t,Buffer.from('abc'));
  for(const source of [c.descriptor,c.verified]){
    assert.deepEqual(await collect(source.stream(3)),Buffer.alloc(0));
    assert.deepEqual(await collect(source.stream(3,1)),Buffer.alloc(0));
    assert.throws(()=>source.stream(0,0));assert.throws(()=>source.stream(4,1));
  }
});

test('descriptor rejects ranges whose end exceeds the safe integer limit',t=>{
  const c=fixture(t,Buffer.from('abc'));
  assert.throws(()=>c.descriptor.stream(1,Number.MAX_SAFE_INTEGER),{code:'invalid_archive'});
  assert.throws(()=>c.verified.stream(1,Number.MAX_SAFE_INTEGER),{code:'processing_archive_changed'});
  // Numeric coercion is an existing descriptor API behavior; the verified
  // reader intentionally requires numbers, so parity is for numeric inputs.
});

for(const [label,bytes,expected] of [
  ['stored and deflated',makeZip([{path:'nested/a.bin',data:'stored'},{path:'nested/b.bin',data:'deflated body',method:8,descriptor:true}]),[['nested/a.bin','stored'],['nested/b.bin','deflated body']]],
  ['ZIP64 data descriptor',makeZip64Descriptor('nested/zip64.bin','small zip64'),[['nested/zip64.bin','small zip64']]],
])test(`${label} extracts the same bytes through descriptor and verified adapters`,async t=>{
  const c=fixture(t,bytes);
  for(const [name,reader] of [['descriptor',null],['verified',c.verified]]){
    const destination=path.join(c.root,name);
    await extractZipDescriptor(c.fd,bytes.length,destination,{archiveReader:reader,maxEntries:100,maxBytes:1024*1024,workId:name});
    for(const [relative,content] of expected)assert.equal(fs.readFileSync(path.join(destination,...relative.split('/')),'utf8'),content);
  }
});

test('truncated ZIP never publishes an extraction through either adapter',async t=>{
  const bytes=makeZip([{path:'model.glb',data:'mesh'}]),truncated=bytes.subarray(0,bytes.length-7),c=fixture(t,truncated);
  for(const [name,reader] of [['descriptor',null],['verified',c.verified]]){
    const destination=path.join(c.root,name);
    await assert.rejects(extractZipDescriptor(c.fd,truncated.length,destination,{archiveReader:reader,maxEntries:100,maxBytes:1024*1024,workId:name}));
    assert.equal(fs.existsSync(destination),false);
  }
});
