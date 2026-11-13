import test from 'node:test';
import assert from 'node:assert/strict';
import { compareUsedTileImages, proveTextureOutput } from '../scripts/lib/texture-output-proof.mjs';

const hash = 'a'.repeat(64);
function inputs({ failMip = false, short = false, duplicate = false, corrupt = false, lateRawFailure = false } = {}) {
  let closed = 0, rawClosed = 0, published = 0;
  const tile = { images:new Map([['atlas.png',{width:2,height:2,levels:2,sha256:hash}]]) };
  const atlases = new Map([['atlas.png',{width:2,height:2,sha256:hash}]]);
  const decoder = { async *levels() {
    try {
      yield { level:0,width:2,height:2,rgba:new Uint8Array(16).fill(corrupt ? 0 : 255) };
      if (failMip) throw Error('lower mip failure');
      if (!short) yield {level:duplicate ? 0 : 1,width:1,height:1,rgba:new Uint8Array(4).fill(255)};
    } finally { closed++; }
  } };
  const rows = async function* () {
    try {
      for (let y = 0; y < 2; y++) yield { y,rgba:new Uint8Array(8).fill(255),
        header:{interpretation:'rgba8-straight-srgb-byte-values-no-transform',gdalVersion:'fixture',sha256:hash} };
      if (lateRawFailure) throw Error('final source hash failed');
    } finally { rawClosed++; }
  };
  return { args:{tile,fullDetail:true,atlases,decoder,rows,onMetric:()=>{published++;}},
    state:()=>({closed,rawClosed,published}) };
}
test('full detail consumes complete raw stream and every mip before publishing image metrics',async()=>{
  const fixture = inputs();
  assert.deepEqual(await compareUsedTileImages(fixture.args),{images:1,mips:2,comparedPixels:4});
  assert.deepEqual(fixture.state(),{closed:1,rawClosed:1,published:1});
});
test('late lower mip failure closes decoder and cannot publish a level-zero pass',async()=>{
  const fixture = inputs({failMip:true});
  await assert.rejects(compareUsedTileImages(fixture.args),/lower mip failure/);
  assert.deepEqual(fixture.state(),{closed:1,rawClosed:1,published:0});
});
test('a source final-hash failure after the last row closes both iterators and rejects the image',async()=>{
  const fixture = inputs({lateRawFailure:true});
  await assert.rejects(compareUsedTileImages(fixture.args),/final source hash failed/);
  assert.deepEqual(fixture.state(),{closed:1,rawClosed:1,published:0});
});
test('missing and repeated mip levels fail exact sequence coverage',async()=>{
  for (const options of [{short:true},{duplicate:true}]) {
    const fixture = inputs(options);
    await assert.rejects(compareUsedTileImages(fixture.args),{code:options.short ? 'lod_texture_decoded_mips_incomplete' : 'lod_texture_decoded_mip_sequence'});
    assert.equal(fixture.state().published,0); assert.equal(fixture.state().closed,1);
  }
});
test('wrong raw image identity is refused before decoding; matching dimensions alone do not suffice',async()=>{
  const fixture = inputs(); fixture.args.atlases = new Map([['other.png',{width:2,height:2,sha256:hash}]]);
  await assert.rejects(compareUsedTileImages(fixture.args),{code:'lod_texture_raw_image_closure'});
  assert.deepEqual(fixture.state(),{closed:0,rawClosed:0,published:0});
});
test('failed photographic relation closes decoder without publishing statistics as acceptance',async()=>{
  const fixture = inputs({corrupt:true});
  await assert.rejects(compareUsedTileImages(fixture.args),{code:'lod_texture_photographic_relation_failed'});
  assert.equal(fixture.state().closed,1); assert.equal(fixture.state().published,0);
});
test('parent/root images decode every mip but cannot acquire raw source or geometry proof flags',async()=>{
  const fixture = inputs(); fixture.args.fullDetail = false; fixture.args.atlases = null;
  fixture.args.rows = ()=>{throw Error('parent must not fabricate a raw atlas');};
  assert.deepEqual(await compareUsedTileImages(fixture.args),{images:1,mips:2,comparedPixels:0});
  assert.deepEqual(fixture.state(),{closed:1,rawClosed:0,published:1});
});
test('cancellation before an image leaves no active decoder iterator',async()=>{
  const fixture = inputs(); fixture.args.checkpoint = ()=>{throw Error('cancelled');};
  await assert.rejects(compareUsedTileImages(fixture.args),/cancelled/);
  assert.deepEqual(fixture.state(),{closed:0,rawClosed:0,published:0});
});
test('filesystem entrypoint rejects a relative output before library or model execution',async()=>{
  await assert.rejects(proveTextureOutput({output:'relative'}),{code:'lod_texture_output_path'});
});
