import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectEmbeddedTile, matchDeclaredFaces, renderContents } from '../scripts/lib/lod-texture-association.mjs';

// Independently assembled GLB/B3DM records. The 1px KTX is structural data only;
// these tests never claim Basis decoding or pixel correspondence.
function fixture({ copies = 1, reverse = false, mutate = () => {} } = {}) {
  const positions = Buffer.alloc(36), uv = Buffer.alloc(24), indices = Buffer.alloc(copies * 12), ktx = Buffer.alloc(108);
  [0,0,0,1,0,0,0,1,0].forEach((v, i) => positions.writeFloatLE(v, i * 4));
  [0,1,1,1,0,0].forEach((v, i) => uv.writeFloatLE(v, i * 4));
  for (let i = 0; i < copies; i++) (reverse ? [0,2,1] : [0,1,2]).forEach((v, j) => indices.writeUInt32LE(v, i * 12 + j * 4));
  Buffer.from('ab4b5458203230bb0d0a1a0a', 'hex').copy(ktx); ktx.writeUInt32LE(1, 20); ktx.writeUInt32LE(1, 24);
  ktx.writeUInt32LE(1, 36); ktx.writeUInt32LE(1, 40); ktx.writeBigUInt64LE(104n, 80); ktx.writeBigUInt64LE(4n, 88);
  const bin = Buffer.concat([positions, uv, indices, ktx]);
  const model = { asset:{version:'2.0'}, buffers:[{byteLength:bin.length}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:36},{buffer:0,byteOffset:36,byteLength:24},
      {buffer:0,byteOffset:60,byteLength:indices.length},{buffer:0,byteOffset:60+indices.length,byteLength:108}],
    accessors:[{bufferView:0,componentType:5126,count:3,type:'VEC3'}, {bufferView:1,componentType:5126,count:3,type:'VEC2'},
      {bufferView:2,componentType:5125,count:copies*3,type:'SCALAR'}],
    meshes:[{primitives:[{attributes:{POSITION:0,TEXCOORD_0:1},indices:2,material:0}]}], nodes:[{mesh:0}],
    images:[{name:'atlas.png',mimeType:'image/ktx2',bufferView:3}], textures:[{extensions:{KHR_texture_basisu:{source:0}}}],
    materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}], scenes:[{nodes:[0]}], scene:0 };
  mutate(model, bin);
  const rawJson = Buffer.from(JSON.stringify(model)), json = Buffer.alloc(Math.ceil(rawJson.length/4)*4, 0x20); rawJson.copy(json);
  const glb = Buffer.alloc(28+json.length+bin.length);
  glb.writeUInt32LE(0x46546c67); glb.writeUInt32LE(2,4); glb.writeUInt32LE(glb.length,8);
  glb.writeUInt32LE(json.length,12); glb.writeUInt32LE(0x4e4f534a,16); json.copy(glb,20);
  glb.writeUInt32LE(bin.length,20+json.length); glb.writeUInt32LE(0x004e4942,24+json.length); bin.copy(glb,28+json.length);
  const result = Buffer.alloc(32+glb.length+(8-glb.length%8)%8, 0x20);
  result.write('b3dm'); result.writeUInt32LE(1,4); result.writeUInt32LE(result.length,8);
  [4,0,0,0].forEach((v,i) => result.writeUInt32LE(v,12+i*4)); result.write('{}  ',28); glb.copy(result,32);
  return result;
}
const face = () => ({recordType:'face',atlasIdentity:'atlas.png',triangle:[0,0,0,1,0,0,0,1,0],atlasUv:[0,0,1,0,0,1]});

test('emitted positions, V-flipped UV and actual material-selected embedded image join the declaration', async () => {
  const tile = inspectEmbeddedTile(fixture());
  assert.equal(tile.images.size, 1); assert.equal(tile.images.get('atlas.png').width, 1);
  assert.deepEqual(await matchDeclaredFaces(tile, [face()]), {declaredTriangles:1,emittedTriangles:1,scope:'emitted-to-declared position/UV/material multiplicity only'});
  const rotated = face(); rotated.triangle = [1,0,0,0,1,0,0,0,0]; rotated.atlasUv = [1,0,0,1,0,0];
  await matchDeclaredFaces(tile, [rotated]);
});

for (const change of ['uv','material','missing','duplicate','winding']) test(`association refuses ${change} mismatch`, async () => {
  const expected = face(), tile = inspectEmbeddedTile(fixture({reverse:change==='winding'}));
  if (change === 'uv') expected.atlasUv[0] = .25;
  if (change === 'material') expected.atlasIdentity = 'other.png';
  const records = change === 'missing' ? [] : change === 'duplicate' ? [expected, expected] : [expected];
  await assert.rejects(matchDeclaredFaces(tile, records), error => /^lod_texture_/.test(error.code));
});

test('streamed multiplicities handle more than the old tiny-fixture 10k triangles', async () => {
  const tile = inspectEmbeddedTile(fixture({copies:12000}));
  function* records() { for (let i=0;i<12000;i++) yield face(); }
  assert.equal((await matchDeclaredFaces(tile, records())).emittedTriangles, 12000);
});

for (const [name, mutate] of [
  ['external image', m => { m.images[0].uri='https://external.invalid/image'; }],
  ['nonidentity transform', m => { m.nodes[0].translation=[1,0,0]; }],
  ['skinning at index zero', m => { m.nodes[0].skin=0; }],
  ['unaligned stride', m => { m.bufferViews[0].byteStride=13; }],
  ['unbounded accessor', m => { m.accessors[0].count=Number.MAX_SAFE_INTEGER; }],
  ['vertex tint', m => { m.meshes[0].primitives[0].attributes.COLOR_0=0; }],
  ['wrong base color factor', m => { m.materials[0].pbrMetallicRoughness.baseColorFactor=[0,0,0,1]; }],
  ['unused embedded image', m => { m.images.push({...m.images[0],name:'unused.png'}); }],
  ['unused material', m => { m.materials.push(structuredClone(m.materials[0])); }],
  ['parent out-of-range index', (m, bin) => { bin.writeUInt32LE(99,60); }],
  ['nonfinite unreferenced vertex', (m, bin) => { bin.writeFloatLE(NaN,0); }],
]) test(`closed current-writer profile rejects ${name}`, () => {
  assert.throws(() => inspectEmbeddedTile(fixture({mutate})), error => /^lod_texture_/.test(error.code));
});

test('image-alias scanning checks cancellation before hashing more image entries', () => {
  const bytes=fixture({mutate(m){m.images=Array.from({length:20},(_,i)=>({...m.images[0],name:`image${i}.png`}));}});
  let calls=0; const reason=new Error('synthetic image-scan cancellation');
  assert.throws(()=>inspectEmbeddedTile(bytes,{checkpoint(){if(++calls===3)throw reason;}}), error=>error===reason);
  assert.equal(calls,3);
});

test('unused resource-free default material is accounted without omitting an embedded image', () => {
  const tile=inspectEmbeddedTile(fixture({mutate(m){m.materials.unshift({name:'default',pbrMetallicRoughness:{baseColorFactor:[.5,.5,.5,1],metallicFactor:0,roughnessFactor:1},alphaMode:'OPAQUE',doubleSided:false});m.meshes[0].primitives[0].material=1;}}));
  assert.deepEqual(tile.unusedUntexturedMaterials,[0]); assert.equal(tile.images.size,1);
});

test('shared accessors are validated once rather than rescanned for every primitive', () => {
  const copies=200, bytes=fixture({mutate(m){m.meshes[0].primitives=Array.from({length:copies},()=>structuredClone(m.meshes[0].primitives[0]));}});
  let checkpoints=0;
  const tile=inspectEmbeddedTile(bytes,{checkpoint(){checkpoints++;}});
  assert.equal(tile.triangleCount,copies);
  assert.ok(checkpoints<=copies+10, 'work checkpoints include each primitive but not repeated accessor scans');
});

test('content closure includes root and parent content, not only terminal leaves', () => {
  const tileset={asset:{version:'1.0'},root:{content:{uri:'root.b3dm'},children:[{content:{uri:'LOD-2/parent.b3dm'},children:[{content:{uri:'LOD-0/leaf.b3dm'}}]}]}};
  assert.deepEqual(renderContents(tileset), [{uri:'root.b3dm',fullDetail:false},{uri:'LOD-2/parent.b3dm',fullDetail:false},{uri:'LOD-0/leaf.b3dm',fullDetail:true}]);
  tileset.root.children[0].content.uri='../private-proof.json';
  assert.throws(() => renderContents(tileset), {code:'lod_texture_content_identity'});
});

test('checkpoint cancellation stops association before a success receipt', async () => {
  const tile=inspectEmbeddedTile(fixture()), reason=new Error('synthetic cancellation');
  await assert.rejects(matchDeclaredFaces(tile,[face()],{checkpoint(){throw reason;}}), error=>error===reason);
});
