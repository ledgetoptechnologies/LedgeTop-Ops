import {test} from 'node:test';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {compatibleRasterImages,readPreviewRaster,selectPreviewImage,fitPreviewDimensions,PREVIEW_SOURCE_PIXELS,PREVIEW_SAMPLE_DIM,PREVIEW_WINDOW_DIM,PREVIEW_MAX_READ_PIXELS,PREVIEW_MAX_BLOCK_BYTES} from '../raster-preview.mjs';
const require=createRequire(import.meta.url),{writeArrayBuffer,fromArrayBuffer}=require('geotiff');
function fake(w,h,{bands=1,block=256}={}){let reads=0,pixels=0;const counts=Array(Math.ceil(w/block)*Math.ceil(h/block)).fill(100);return {getWidth:()=>w,getHeight:()=>h,getTileWidth:()=>block,getTileHeight:()=>block,getSamplesPerPixel:()=>bands,getArrayForSample:(_s,n)=>new Float32Array(n),isTiled:true,getFileDirectory:()=>({NewSubfileType:1,PhotometricInterpretation:1,TileWidth:block,TileLength:block,SamplesPerPixel:bands,BitsPerSample:Array(bands).fill(32),TileByteCounts:counts}),async readRasters({window=[0,0,w,h],samples}){reads++;const rw=window[2]-window[0],rh=window[3]-window[1];assert.ok(rw<=PREVIEW_WINDOW_DIM&&rh<=PREVIEW_WINDOW_DIM);pixels+=rw*rh;const out=samples.map(()=>new Float32Array(rw*rh).fill(42));out.width=rw;out.height=rh;return out;},get reads(){return reads},get pixels(){return pixels}};}
test('large no-overview DEM uses bounded source windows, not output-only resampling',async()=>{const image=fake(120000,80000),out=await readPreviewRaster([image],{isDem:true});assert.equal(out.sparse,true);assert.ok(out.w<=PREVIEW_SAMPLE_DIM&&out.h<=PREVIEW_SAMPLE_DIM);assert.ok(image.reads<=PREVIEW_SAMPLE_DIM**2);assert.ok(image.pixels<=PREVIEW_MAX_READ_PIXELS);assert.equal(out.raster[0][0],42);});
test('large no-overview orthophoto uses transparent fallback without decoding sparse pixels',async()=>{const image=fake(120000,80000,{bands:4});const out=await readPreviewRaster([image]);assert.equal(out.sparse,true);assert.equal(out.raster,null);assert.equal(image.reads,0);});
test('irregular overview ordering selects highest compatible resolution within pixel cap',()=>{const a=fake(4000,3000),b=fake(200,150),c=fake(800,600);assert.equal(selectPreviewImage([a,b,c]),c);assert.deepEqual(compatibleRasterImages([a,b,c]),[a,c,b]);assert.ok(c.getWidth()*c.getHeight()<=PREVIEW_SOURCE_PIXELS);assert.deepEqual(fitPreviewDimensions(1200,2400,1200),{width:600,height:1200});});
test('real GeoTIFF preview preserves sampled values from a small uncompressed image',async()=>{const width=8,height=8,values=new Uint8Array(width*height);values[3]=23;const buffer=writeArrayBuffer(values,{width,height}),tiff=await fromArrayBuffer(buffer);try{const image=await tiff.getImage(),out=await readPreviewRaster([image],{isDem:true});assert.equal(out.sparse,false);assert.equal(out.w,width);assert.equal(out.h,height);assert.equal(out.raster[0][3],23);}finally{await tiff.close();}});
test('oversized decoded blocks skip preview reads and report unavailable',async()=>{const image=fake(120000,80000,{block:5000});assert.equal((await readPreviewRaster([image],{isDem:true})).unavailable,true);assert.ok(5000*5000*4>PREVIEW_MAX_BLOCK_BYTES);assert.equal(image.reads,0);});

function tagged(image, tags) {
  const original = image.getFileDirectory();
  image.getFileDirectory = () => ({ getValue: name => ({ ...original, ...tags })[name] });
  return image;
}

test('mask, unrelated page and incompatible band/sample/alpha IFDs cannot win preview selection', () => {
  const base = fake(4000, 3000), good = fake(800, 600);
  const bad = [
    tagged(fake(1000, 750), { NewSubfileType: 5, PhotometricInterpretation: 4 }),
    tagged(fake(1000, 750), { NewSubfileType: 2 }),
    tagged(fake(1000, 750), { NewSubfileType: 0 }),
    fake(1000, 750, { bands: 3 }),
    tagged(fake(1000, 750), { BitsPerSample: [16] }),
    tagged(fake(1000, 750), { SampleFormat: [3] }),
    tagged(fake(1000, 750), { ExtraSamples: [2] }),
    tagged(fake(1000, 750), { PhotometricInterpretation: 2 }),
    fake(1000, 500),
  ];
  assert.deepEqual(compatibleRasterImages([base, ...bad, good]), [base, good]);
  assert.equal(selectPreviewImage([base, ...bad, good]), good);
});

test('overviews inherit omitted geotags but reject conflicting CRS, NoData and explicit footprint', () => {
  const base = fake(4001, 3001);
  base.getGeoKeys = () => ({ ProjectedCSTypeGeoKey: 32616 });
  base.getGDALNoData = () => -9999;
  base.getOrigin = () => [100, 200]; base.getResolution = () => [2, -2];
  const inherited = fake(1001, 751);
  const rounded = tagged(fake(1001, 751), { ModelPixelScale: [8, 8, 0], ModelTiepoint: [0, 0, 0, 100, 200, 0] });
  rounded.getOrigin = () => [100, 200]; rounded.getResolution = () => [8, -8];
  const shifted = tagged(fake(1001, 751), { ModelPixelScale: [8, 8, 0] });
  shifted.getOrigin = () => [200, 200]; shifted.getResolution = () => [8, -8];
  const cropped = tagged(fake(1001, 751), { ModelPixelScale: [4, 4, 0] });
  cropped.getOrigin = () => [100, 200]; cropped.getResolution = () => [4, -4];
  const crs = fake(1001, 751); crs.getGeoKeys = () => ({ ProjectedCSTypeGeoKey: 32617 });
  const nodata = fake(1001, 751); nodata.getGDALNoData = () => 9999;
  assert.deepEqual(compatibleRasterImages([base, shifted, cropped, crs, nodata, inherited, rounded]), [base, inherited, rounded]);
});

test('legacy reduced-resolution tags are supported and explicit mirrored transforms are rejected', () => {
  const base = fake(4000, 3000);
  base.getOrigin = () => [0, 0]; base.getResolution = () => [1, -1];
  const legacy = tagged(fake(800, 600), { NewSubfileType: undefined, SubfileType: 2 });
  const mirrored = tagged(fake(800, 600), { ModelTransformation: [-5, 0, 0, 0, 0, -5, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] });
  assert.deepEqual(compatibleRasterImages([base, legacy, mirrored]), [base, legacy]);
});

test('full small preview also bounds aggregate padded-block decoding', async () => {
  const image = fake(1, 1024);
  // Padded blocks decode512KiB each while the source stays only1024px.
  tagged(image, { TileWidth: 131072, TileLength: 1, SamplesPerPixel: 1, BitsPerSample: [32], TileByteCounts: Array(1024).fill(1) });
  image.getTileWidth = () => 131072; image.getTileHeight = () => 1;
  const output = await readPreviewRaster([image], { isDem: true });
  assert.equal(output.unavailable, true); assert.equal(image.reads, 0);
});

test('custom projection parameters must agree while citation wording may differ', () => {
  const base = fake(4000, 3000);
  const keys = { ProjectedCSTypeGeoKey: 32767, ProjCoordTransGeoKey: 1, ProjNatOriginLongGeoKey: -87, GeogTOWGS84GeoKey: [0, 0, 0], PCSCitationGeoKey: 'Base' };
  base.getGeoKeys = () => keys;
  const good = fake(800, 600); good.getGeoKeys = () => ({ ...keys, PCSCitationGeoKey: 'Overview' });
  const wrongTransform = fake(800, 600); wrongTransform.getGeoKeys = () => ({ ...keys, ProjCoordTransGeoKey: 7 });
  const wrongOrigin = fake(800, 600); wrongOrigin.getGeoKeys = () => ({ ...keys, ProjNatOriginLongGeoKey: -88 });
  const wrongDatum = fake(800, 600); wrongDatum.getGeoKeys = () => ({ ...keys, GeogTOWGS84GeoKey: [1, 0, 0] });
  assert.deepEqual(compatibleRasterImages([base, wrongTransform, wrongOrigin, wrongDatum, good]), [base, good]);
});
