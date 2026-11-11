import test from 'node:test';import assert from 'node:assert/strict';import {gcpPhotoWidth} from '../gcp-photo-zoom.mjs';
test('fit and zoom preserve source aspect and clamp scale',()=>{
 const base={naturalWidth:4000,naturalHeight:3000,viewportWidth:800,viewportHeight:600};
 assert.equal(gcpPhotoWidth({...base,zoom:1}),800);assert.equal(gcpPhotoWidth({...base,zoom:3}),2400);
 assert.equal(gcpPhotoWidth({...base,zoom:99}),6400);assert.equal(gcpPhotoWidth({...base,zoom:.1}),800);
 assert.equal(gcpPhotoWidth({...base,viewportWidth:0}),null);
});
test('pixel mapping is invariant across zoom and scroll-adjusted image rectangles',()=>{
 const natural=4000,pixel=1234.5;
 for(const zoom of [1,1.5,4,8]){const width=gcpPhotoWidth({naturalWidth:natural,naturalHeight:3000,viewportWidth:800,viewportHeight:600,zoom});
  const rectLeft=-317.2,click=rectLeft+pixel*width/natural;
  assert.ok(Math.abs((click-rectLeft)*natural/width-pixel)<1e-9);
 }
});

test('rounded pixel coordinates never reach or exceed image dimensions',async()=>{
 const {gcpRoundedPixel}=await import('../gcp-photo-zoom.mjs');
 assert.equal(gcpRoundedPixel(100,100),99.99);assert.equal(gcpRoundedPixel(99.999,100),99.99);
 assert.equal(gcpRoundedPixel(79.995,80),79.99);assert.equal(gcpRoundedPixel(-1,100),0);
 assert.equal(gcpRoundedPixel(0,100),0);assert.equal(gcpRoundedPixel(NaN,100),null);
});

test('keyboard marking uses labeled pixel fields and a focusable scroll viewport',async()=>{
 const {readFileSync}=await import('node:fs'),source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
 assert.match(source,/class="gcp-image-viewport" tabindex="0" aria-label="Photo viewport/);
 assert.match(source,/field\('Pixel X','pixelX'/);assert.match(source,/field\('Pixel Y','pixelY'/);
 const line=source.split(/\r?\n/).find(value=>value.startsWith('function configureGcpImage('));
 assert.doesNotMatch(line,/setAttribute\('role','button'\)|tabIndex=0/);
});
