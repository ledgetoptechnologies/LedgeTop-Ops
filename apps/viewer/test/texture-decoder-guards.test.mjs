import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createPinnedBasisDecoder,inspectKtxSampling} from '../scripts/lib/pinned-basis-decoder.mjs';
import {parseAtlasRows,compareAtlasLevelZero,streamRawAtlasRows} from '../scripts/lib/raw-atlas-rows.mjs';

function structuralKtx(orientation=null) {
  const payload=orientation===null?null:Buffer.from('KTXorientation\0'+orientation+'\0');
  const kv=payload?Buffer.alloc(4+Math.ceil(payload.length/4)*4):Buffer.alloc(0);
  if(payload){kv.writeUInt32LE(payload.length);payload.copy(kv,4);}
  const sgd=Math.ceil((148+kv.length)/8)*8, data=sgd+8, b=Buffer.alloc(data+4);
  Buffer.from('ab4b5458203230bb0d0a1a0a','hex').copy(b); b.writeUInt32LE(1,16);
  b.writeUInt32LE(1,20); b.writeUInt32LE(1,24); b.writeUInt32LE(1,36); b.writeUInt32LE(1,40); b.writeUInt32LE(1,44);
  b.writeUInt32LE(104,48); b.writeUInt32LE(44,52); if(kv.length){b.writeUInt32LE(148,56);b.writeUInt32LE(kv.length,60);kv.copy(b,148);}
  b.writeBigUInt64LE(BigInt(sgd),64); b.writeBigUInt64LE(4n,72); b.writeBigUInt64LE(BigInt(data),80); b.writeBigUInt64LE(4n,88);
  b.writeUInt32LE(44,104); b.writeUInt16LE(2,112); b.writeUInt16LE(40,114); b[116]=163;b[117]=1;b[118]=2;
  return b; // metadata fixture only, deliberately not a valid Basis stream
}
const digest='a'.repeat(64), expected={width:2,height:2,sha256:digest};
function frame({header={},body=Buffer.from([1,2,3,255,4,5,6,255,7,8,9,255,10,11,12,255])}={}) {
  return Buffer.concat([Buffer.from(JSON.stringify({protocol:'ltds-rgba-rows-v1',schemaVersion:1,width:2,height:2,rowBytes:8,
    sha256:digest,interpretation:'rgba8-straight-srgb-byte-values-no-transform',gdalVersion:'test-metadata-only',...header})+'\n'),body]);
}
async function* chunks(data,size=1){for(let i=0;i<data.length;i+=size)yield data.subarray(i,i+size);}

test('untrusted decoder library bytes are rejected before code can execute', async()=>{
  globalThis.textureUntrustedExecuted=false;
  await assert.rejects(createPinnedBasisDecoder({javascript:Buffer.from('globalThis.textureUntrustedExecuted=true'),wasm:Buffer.of(0)}),{code:'lod_texture_basis_pin'});
  assert.equal(globalThis.textureUntrustedExecuted,false);delete globalThis.textureUntrustedExecuted;
});

test('KTX sampling metadata admits explicit or default right/down straight sRGB',()=>{
  for(const bytes of [structuralKtx(),structuralKtx('rd')]){
    const result=inspectKtxSampling(bytes);assert.equal(result.orientation,'rd');assert.equal(result.alphaMode,'straight');assert.equal(result.colorDomain,'srgb-byte-values');
  }
});
for(const [name,mutate] of [['linear transfer',b=>{b[118]=1;}],['premultiplied alpha',b=>{b[119]=1;}],['metadata overlap',b=>{b.writeBigUInt64LE(104n,64);}]])
test(`sampling metadata rejects ${name}`,()=>{
  const bytes=structuralKtx();mutate(bytes);assert.throws(()=>inspectKtxSampling(bytes),error=>/^lod_texture_/.test(error.code));
});
test('sampling metadata rejects an orientation mismatch',()=>assert.throws(()=>inspectKtxSampling(structuralKtx('ru')),{code:'lod_texture_ktx_orientation_swizzle'}));

test('row framing handles arbitrary chunk boundaries without dropping or duplicating pixels',async()=>{
  for(const size of [1,3,7,65536]){
    const result=[];for await(const row of parseAtlasRows(chunks(frame(),size),expected))result.push({y:row.y,bytes:[...row.rgba]});
    assert.deepEqual(result,[{y:0,bytes:[1,2,3,255,4,5,6,255]},{y:1,bytes:[7,8,9,255,10,11,12,255]}]);
  }
});
for(const [name,value] of [['wrong dimensions',frame({header:{width:3}})],['truncated pixels',frame({body:Buffer.alloc(15)})],['extra pixels',frame({body:Buffer.alloc(17)})],['wrong source digest',frame({header:{sha256:'b'.repeat(64)}})]])
test(`row framing refuses ${name}`,async()=>{
  await assert.rejects(async()=>{for await(const row of parseAtlasRows(chunks(value),expected))void row;},error=>/^lod_texture_/.test(error.code));
});

test('pixel statistics cannot succeed when source verification fails after the last row',async()=>{
  const reason=new Error('synthetic final source hash failure'),data=frame();
  async function* lateFailure(){for await(const row of parseAtlasRows(chunks(data),expected))yield row;throw reason;}
  await assert.rejects(compareAtlasLevelZero({rows:lateFailure(),rgba:Buffer.alloc(16),width:2,height:2}),error=>error===reason);
});

test('completed row comparison retains exact decoder/source interpretation metadata',async()=>{
  const rgba=Buffer.from([1,2,3,255,4,5,6,255,7,8,9,255,10,11,12,255]);
  const result=await compareAtlasLevelZero({rows:parseAtlasRows(chunks(frame()),expected),rgba,width:2,height:2});
  assert.equal(result.rgb.mae,0);assert.equal(result.pixelsCompared,4);assert.equal(result.calibrationRequired,true);
  assert.deepEqual(result.rawDecoder,{interpretation:'rgba8-straight-srgb-byte-values-no-transform',gdalVersion:'test-metadata-only',sourceSha256:digest});
});

test('unavailable owned interpreter is observed closed without a live child or leaked timer',async()=>{
  const missing=path.join(os.tmpdir(),'viewer-missing-interpreter-'+crypto.randomUUID());
  await assert.rejects(async()=>{for await(const row of streamRawAtlasRows({...expected,filename:path.join(os.tmpdir(),'unused.png'),python:missing,timeoutMs:1000}))void row;},
    {code:'lod_texture_raw_unavailable'});
});
