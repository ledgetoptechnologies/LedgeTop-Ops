import test from 'node:test';
import assert from 'node:assert/strict';
import { isRgbNoData, maskedRgbBilinear, maskedRgbaBilinear, parseFiniteGdalNoData } from '../orthophoto-mask.mjs';
import fs from 'node:fs';

test('adjacent source windows produce the same warped RGBA pixels as a continuous window',()=>{
  const source=fs.readFileSync(new URL('../main.js',import.meta.url),'utf8');
  const start=source.indexOf('function warpedSampleGrid('),end=source.indexOf('\nfunction renderOrthoTile(',start);assert.ok(start>=0&&end>start);
  const document={createElement(){let pixels;return {getContext(){return {createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{pixels=[...image.data]}}},get pixels(){return pixels}}}};
  const warp=new Function('document','latLonToUtm','maskedRgbBilinear','maskedRgbaBilinear',`${source.slice(start,end)}; return warpedSampleGrid;`)(document,(lat,lon)=>[lon,lat],maskedRgbBilinear,maskedRgbaBilinear);
  const bands=[[50,100,150,200],[30,60,90,120],[10,20,30,40],[255,0,128,255]].map(row=>[...row,...row]);
  const crop=(from,to)=>bands.map(b=>[...b.slice(from,to),...b.slice(4+from,4+to)]),ds={isDem:false,alphaType:2};
  const reference=warp(bands,4,2,0,4,2,0,[1],[.5,1.5,2.5,3.5],4,1,ds).pixels;
  const left=warp(crop(0,3),3,2,0,3,2,0,[1],[.5,1.5],2,1,ds).pixels;
  const right=warp(crop(1,4),3,2,1,4,2,0,[1],[2.5,3.5],2,1,ds).pixels;
  assert.deepEqual([...left,...right],reference);
});

test('transparent RGBA neighbors preserve visible color instead of creating a dark fringe',()=>{
 const red=[200,0,200,0],green=[100,0,100,0],blue=[50,0,50,0],alpha=[255,0,255,0];
 assert.deepEqual(maskedRgbaBilinear(red,green,blue,alpha,[0,1,2,3],[.25,.25,.25,.25]),{r:200,g:100,b:50,a:128});
 assert.deepEqual(maskedRgbaBilinear([100,0,100,0],[50,0,50,0],[25,0,25,0],[127.5,0,127.5,0],[0,1,2,3],[.25,.25,.25,.25],{associated:true}),{r:200,g:100,b:50,a:64});
 assert.deepEqual(maskedRgbaBilinear(red,green,blue,[0,0,0,0],[0,1,2,3],[.25,.25,.25,.25]),{r:0,g:0,b:0,a:0});
});

test('GDAL nodata is enabled only by a complete finite metadata value', () => {
  assert.equal(parseFiniteGdalNoData('0\0'), 0);
  assert.equal(parseFiniteGdalNoData('-9999'), -9999);
  for (const value of [undefined, null, '', 'NaN', '0 trailing', Infinity]) {
    assert.equal(Number.isNaN(parseFiniteGdalNoData(value)), true, String(value));
  }
  assert.equal(isRgbNoData(0, 0, 0, Number.NaN), false, 'generic black is not inferred as nodata');
  assert.equal(isRgbNoData(0, 0, 0, 0), true);
  assert.equal(isRgbNoData(0, 1, 0, 0), false);
});

test('warped RGB sampling masks only authoritative nodata neighbors and renormalizes color', () => {
  const r = Uint8Array.from([0, 100, 100, 100]);
  const g = Uint8Array.from([0, 50, 50, 50]);
  const b = Uint8Array.from([0, 25, 25, 25]);
  const masked = maskedRgbBilinear(r, g, b, [0, 1, 2, 3], [0.25, 0.25, 0.25, 0.25], 0);
  assert.deepEqual(masked, { r: 100, g: 50, b: 25, a: 191 });
  const unmasked = maskedRgbBilinear(r, g, b, [0, 1, 2, 3], [0.25, 0.25, 0.25, 0.25], Number.NaN);
  assert.deepEqual(unmasked, { r: 75, g: 37.5, b: 18.75, a: 255 });
});
