import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePhotoExif,scanPhotoLocations,mountPhotoMap} from '../workspace-task-photo-map.mjs';
function jpeg({little=true,latRef='N',lonRef='W',headingRef='T',heading=123,denominator=1}={}){
  const data=new Uint8Array(174),v=new DataView(data.buffer),base=12;
  data.set([255,216,255,225,0,168,69,120,105,102,0,0]);data.set(little?[73,73]:[77,77],base);
  const u16=(o,n)=>v.setUint16(base+o,n,little),u32=(o,n)=>v.setUint32(base+o,n,little);
  u16(2,42);u32(4,8);u16(8,1);u16(10,0x8825);u16(12,4);u32(14,1);u32(18,26);u16(26,6);
  [[1,2,2,latRef],[2,5,3,104],[3,2,2,lonRef],[4,5,3,128],[16,2,2,headingRef],[17,5,1,152]].forEach(([tag,type,count,value],i)=>{const at=28+i*12;u16(at,tag);u16(at+2,type);u32(at+4,count);if(type===2)data[base+at+8]=value.charCodeAt(0);else u32(at+8,value);});
  [45,30,0,90,15,0,heading].forEach((value,i)=>{u32(104+i*8,value);u32(108+i*8,i===0?denominator:1);});data.set([255,217],172);return data;
}
function photo(bytes=jpeg(),name='photo.jpg'){return{name,slice(start,end){assert.equal(start,0);assert.equal(end,256*1024);return{arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};}};}
test('bounded JPEG EXIF reads both byte orders and true heading without guessing flight orientation',()=>{
  for(const little of [true,false])assert.deepEqual(parsePhotoExif(jpeg({little})),{latitude:45.5,longitude:-90.25,trueHeading:123});
  assert.deepEqual(parsePhotoExif(jpeg({latRef:'S',lonRef:'E'})),{latitude:-45.5,longitude:90.25,trueHeading:123});
  assert.equal(parsePhotoExif(jpeg({headingRef:'M'})).trueHeading,null);assert.equal(parsePhotoExif(jpeg({heading:360})).trueHeading,null);
});
test('truncated segments, invalid offsets, rationals, coordinates and unsupported files never fabricate GPS',()=>{
  const badOffset=jpeg();new DataView(badOffset.buffer).setUint32(12+18,65535,true);
  const badLat=jpeg();new DataView(badLat.buffer).setUint32(12+104,91,true);
  for(const data of [new Uint8Array(),new Uint8Array(300000),jpeg().slice(0,100),jpeg({denominator:0}),jpeg({latRef:'X'}),badOffset,badLat])assert.equal(parsePhotoExif(data),null);
});
test('scanning remains bounded, yields for many files, counts missing GPS and reports preview omissions',async()=>{
  let yields=0;const files=Array.from({length:40},()=>photo());files[0]=photo(new Uint8Array([1,2,3]));files[1]=photo(jpeg(),'raw.dng');
  const result=await scanPhotoLocations(files,{maxFiles:35,yieldTask:async()=>{yields++;}});
  assert.equal(result.locations.length,33);assert.equal(result.missingGps,2);assert.equal(result.omitted,5);assert.equal(result.processed,35);assert.equal(yields,1);
});
test('cancellation after a delayed header read prevents stale metadata from being returned',async()=>{
  const controller=new AbortController();const file={name:'delayed.jpg',slice(){return{arrayBuffer:async()=>{controller.abort();return jpeg().buffer;}};}};
  await assert.rejects(scanPhotoLocations([file],{signal:controller.signal}),{name:'AbortError'});
});
function mapFixture(){
  const node=()=>({children:[],listeners:{},style:{},textContent:'',setAttribute(){},addEventListener(name,fn){this.listeners[name]=fn;},removeEventListener(name){delete this.listeners[name];},append(...children){this.children.push(...children);},replaceChildren(){this.children=[];}}),doc={createElement:()=>node()},container={...node(),ownerDocument:doc};let removed=0;const markers=[],fits=[];
  const layer={addTo(){return this;},clearLayers(){assert.equal(removed,0,'paths must detach before the map destroys its renderer');markers.length=0;},getBounds(){return markers.map(m=>m.position);}},map={setView(){return this;},fitBounds(bounds,options){fits.push({bounds,options});},invalidateSize(){},remove(){assert.equal(markers.length,0,'no paths may outlive renderer teardown');removed++;}};
  const tiles=[],controls=[];let mapOptions;
  const L={map:(_host,options)=>{mapOptions=options;return map;},tileLayer:(url,options)=>{const item={url,options,addTo(){return this;}};tiles.push(item);return item;},layerGroup:()=>({}),control:{layers:(...args)=>{controls.push(args);return{addTo(){return this;}};}},featureGroup:()=>layer,circleMarker(position){return{position,bindTooltip(label){this.label=label;return this;},addTo(){markers.push(this);return this;}};}};
  return{container,markers,fits,tiles,controls,mapOptions:()=>mapOptions,removed:()=>removed,preview:mountPhotoMap(container,{loadLeaflet:async()=>L})};
}

test('photo preview uses attributed anonymous satellite tiles with an optional blank basemap',async()=>{
  const f=mapFixture();await f.preview.setFiles([photo()]);
  assert.equal(f.mapOptions().attributionControl,true);assert.equal(f.tiles.length,1);
  assert.match(f.tiles[0].url,/^https:\/\/server\.arcgisonline\.com\//);assert.equal(f.tiles[0].options.crossOrigin,'anonymous');
  assert.match(f.tiles[0].options.attribution,/Esri/);assert.equal(f.tiles[0].options.maxNativeZoom,19);
  assert.deepEqual(Object.keys(f.controls[0][0]),['Satellite imagery','No basemap']);
  assert.match(f.container.children[0].textContent,/background context, not your survey/);f.preview.dispose();
});
test('map renders canvas markers without flight paths, treats filenames as text, and disposes pending work',async()=>{
  const f=mapFixture();await f.preview.setFiles([photo(jpeg(),'<img src=x>.jpg')]);assert.equal(f.markers.length,1);assert.equal(f.markers[0].label.textContent,'<img src=x>.jpg · Heading 123.0° true');assert.match(f.container.children[0].textContent,/No flight paths/);
  let release;const pending=f.preview.setFiles([{name:'late.jpg',slice(){return{arrayBuffer:()=>new Promise(resolve=>{release=resolve;})};}}]);f.preview.dispose();release(jpeg().buffer);assert.equal(await pending,null);assert.equal(f.removed(),1);assert.equal(f.container.children.length,0);assert.equal(await f.preview.setFiles([photo()]),null);
});
test('server positions reuse map without inventing heading and preserve unscanned versus missing GPS counts',async()=>{
  const f=mapFixture();await f.preview.setLocations({points:[{latitude:45,longitude:-90,name:'Server photo'},{latitude:999,longitude:0}],missingGpsCount:2,unscannedCount:12});
  assert.equal(f.markers.length,1);assert.equal(f.markers[0].label.textContent,'Server photo · Heading not recorded');assert.match(f.container.children[0].textContent,/2 without readable GPS · 12 not scanned/);f.preview.dispose();
});

test('first GPS marker and fit appear before later headers resolve; interaction preserves chosen view',async()=>{
  const f=mapFixture();let release,started;
  const reached=new Promise(resolve=>{started=resolve;});
  const slow={name:'slow.jpg',slice(){return{arrayBuffer:()=>{started();return new Promise(resolve=>{release=resolve;});}};}};
  const pending=f.preview.setFiles([photo(),slow,photo()]);await reached;
  assert.equal(f.markers.length,1,'first valid location is rendered while subsequent files are pending');assert.equal(f.fits.length,1);assert.deepEqual(f.fits[0].bounds,[[45.5,-90.25]]);assert.equal(f.fits[0].options.animate,false);
  f.container.children[1].listeners.pointerdown();release(jpeg().buffer);
  await pending;assert.equal(f.markers.length,3);assert.equal(f.fits.length,1,'background metadata cannot move the map after interaction');
  await f.preview.setFiles([photo()]);assert.equal(f.markers.length,1);assert.equal(f.fits.length,2,'a new selection restores initial framing');f.preview.dispose();
});

test('progressive scan delivers each location exactly once in bounded batches',async()=>{
  const batches=[];const result=await scanPhotoLocations(Array.from({length:70},()=>photo()),{onLocations:async points=>batches.push(points)});
  assert.deepEqual(batches.map(points=>points.length),[1,31,32,6]);assert.deepEqual(batches.flat(),result.locations);
});

test('reselection cancels an in-flight scan without appending stale markers or summary',async()=>{
  const f=mapFixture();let release,started;const reached=new Promise(resolve=>{started=resolve;});
  const pending=f.preview.setFiles([photo(),{name:'old.jpg',slice(){return{arrayBuffer:()=>{started();return new Promise(resolve=>{release=resolve;});}};}}]);await reached;
  await f.preview.setLocations({points:[{latitude:40,longitude:-80,name:'New selection'}]});release(jpeg().buffer);
  assert.equal(await pending,null);assert.equal(f.markers.length,1);assert.deepEqual(f.markers[0].position,[40,-80]);assert.match(f.container.children[0].textContent,/1 photo located/);f.preview.dispose();
});
