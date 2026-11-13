'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {sha256File,verifyLodProvenance} = require('../server/lodProvenance');
const sha = value=>crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-provenance-close-'));
  const absolute=path.resolve(root),parent=path.resolve(os.tmpdir());
  t.after(()=>{assert.equal(path.dirname(absolute),parent);assert.match(path.basename(absolute),/^ltds-provenance-close-/);
    assert.equal(fs.realpathSync(absolute),absolute);fs.rmSync(absolute,{recursive:true,force:true});});
  const filename=path.join(root,'small.txt');fs.writeFileSync(filename,'bounded source-only bytes');return{root,filename};
}
function stream(t) {
  let created;const ready=new Promise(resolve=>{created=resolve;});
  const value=new EventEmitter();value.destroyed=false;
  value.destroy=error=>{value.destroyed=true;if(error)value.emit('error',error);return value;};
  t.mock.method(fs,'createReadStream',()=>{created();return value;});
  return {value,ready};
}
test('hash does not resolve at EOF before its actual stream close',async t=>{
  const {filename}=fixture(t),fake=stream(t);let settled=false;
  const pending=sha256File(filename).finally(()=>{settled=true;});
  await fake.ready;fake.value.emit('data',Buffer.from('payload'));fake.value.emit('end');
  await Promise.resolve();assert.equal(settled,false);
  fake.value.emit('close');assert.equal(await pending,sha('payload'));assert.equal(settled,true);
});
test('abort destroys the owned read stream but rejection waits for close',async t=>{
  const {filename}=fixture(t),fake=stream(t),abort=new AbortController();let settled=false;
  const pending=sha256File(filename,{signal:abort.signal}).finally(()=>{settled=true;});
  const rejected=assert.rejects(pending,/stop now/);
  await fake.ready;fake.value.emit('data',Buffer.from('partial'));abort.abort(new Error('stop now'));
  await Promise.resolve();assert.equal(fake.value.destroyed,true);assert.equal(settled,false);
  fake.value.emit('close');await rejected;assert.equal(settled,true);
});
test('lost lease during hashing destroys the stream and rejects only after close',async t=>{
  const {filename}=fixture(t),fake=stream(t);let lost=false,settled=false;
  const pending=sha256File(filename,{checkpoint:()=>{if(lost)throw Error('lease lost');}}).finally(()=>{settled=true;});
  const rejected=assert.rejects(pending,/lease lost/);
  await fake.ready;lost=true;fake.value.emit('data',Buffer.from('partial'));
  await Promise.resolve();assert.equal(fake.value.destroyed,true);assert.equal(settled,false);
  fake.value.emit('close');await rejected;
});
test('premature stream close and late abort cannot populate a success cache',async t=>{
  const {filename}=fixture(t),fake=stream(t);
  const first=sha256File(filename);const rejected=assert.rejects(first,/before EOF/);
  await fake.ready;fake.value.emit('close');await rejected;
  t.mock.restoreAll();assert.equal(await sha256File(filename),sha('bounded source-only bytes'));
  const abort=new AbortController();abort.abort(new Error('cached read revoked'));
  await assert.rejects(sha256File(filename,{signal:abort.signal}),/cached read revoked/);
});
function metadataFixture(t) {
  const {root}=fixture(t),source=path.join(root,'reference.glb'),manifest=path.join(root,'lod-provenance.json');
  // Legacy receipt metadata only; these bytes are never decoded as a model.
  fs.writeFileSync(source,'opaque legacy test source');
  const artifacts=['tileset.json','leaf.b3dm'].map(name=>{const bytes=Buffer.from(name);fs.writeFileSync(path.join(root,name),bytes);
    return{uri:name,sha256:sha(bytes),byteLength:bytes.length};});
  fs.writeFileSync(manifest,JSON.stringify({schemaVersion:2,sourceAsset:'reference.glb',sourceSha256:sha('opaque legacy test source'),
    geometry:'bounded-triangle-equivalence',textures:'byte-identical-material-equivalence',leafGeometricError:0,
    audit:{algorithm:'ltds-glb-leaf-equivalence-v2',coordinateTolerance:0,maxNumericDelta:0,triangleCount:1,
      equivalenceSha256:'a'.repeat(64),artifacts}}));
  return{root,source,manifest};
}
test('default legacy metadata caller remains compatible without cancellation options',async t=>{
  const value=metadataFixture(t),checked=await verifyLodProvenance(value.manifest,value.source);
  assert.equal(checked.verified,true,checked.errors.join('; '));assert.equal(checked.artifacts.length,2);
});
test('revoked authority between artifacts stops subsequent file hashing and propagates the interruption',async t=>{
  const value=metadataFixture(t),abort=new AbortController(),original=fs.promises.stat;
  t.mock.method(fs.promises,'stat',async function(filename,...args){const result=await original.call(this,filename,...args);
    if(filename===path.join(value.root,'leaf.b3dm'))abort.abort(new Error('authority revoked'));
    return result;});
  await assert.rejects(verifyLodProvenance(value.manifest,value.source,{signal:abort.signal}),/authority revoked/);
});
