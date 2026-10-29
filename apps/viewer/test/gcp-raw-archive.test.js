'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {materializeGcpRawSource}=require('../server/gcpRawArchive');
const id='11111111-1111-4111-8111-111111111111';

test('rejects unsafe archive identities without writing',()=>{
  const b=Buffer.from('source'),sha256=crypto.createHash('sha256').update(b).digest('hex');
  assert.throws(()=>materializeGcpRawSource(os.tmpdir(),{datasetId:'../escape',bytes:b,sha256}),{code:'gcp_archive_unavailable'});
});

test('writes exact immutable-by-name bytes and replays without overwrite',{skip:process.platform!=='linux'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-archive-test-'));
  try {
    const bytes=Buffer.from('\ufeffGCP,one\r\n','utf8'),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
    const relative=materializeGcpRawSource(root,{datasetId:id,bytes,sha256});
    assert.deepEqual(fs.readFileSync(path.join(root,relative)),bytes);
    assert.equal(materializeGcpRawSource(root,{datasetId:id,bytes,sha256}),relative);
    fs.writeFileSync(path.join(root,relative),'changed');
    assert.throws(()=>materializeGcpRawSource(root,{datasetId:id,bytes,sha256}),{code:'gcp_archive_unavailable'});
    assert.equal(fs.readFileSync(path.join(root,relative),'utf8'),'changed');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('refuses a symlink at the source destination',{skip:process.platform!=='linux'},()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-archive-test-'));
  try {
    const bytes=Buffer.from('source'),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
    fs.mkdirSync(path.join(root,'.gcp-retained',id),{recursive:true});
    fs.symlinkSync('/dev/null',path.join(root,'.gcp-retained',id,`${sha256}.csv`));
    assert.throws(()=>materializeGcpRawSource(root,{datasetId:id,bytes,sha256}));
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
