import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createDemUpdateQueue } from '../dem-update-queue.mjs';

const source=fs.readFileSync(new URL('../main.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('rapid DEM edits debounce, serialize rendering and invalidate obsolete image results',async()=>{
  let callback=null,active=0,maxActive=0,started=0,applied=0,finish;
  const queue=createDemUpdateQueue(async current=>{active++;maxActive=Math.max(maxActive,active);started++;await new Promise(resolve=>finish=resolve);if(current())applied++;active--;},{setTimer:fn=>{callback=fn;return 1;},clearTimer:()=>{callback=null;}});
  for(let i=0;i<100;i++)queue.request(); assert.equal(started,0);callback();await tick();assert.equal(started,1);
  queue.request();callback();assert.equal(started,1);finish();await tick();assert.equal(applied,0);assert.equal(started,2);finish();await tick();assert.equal(applied,1);assert.equal(maxActive,1);
});

test('DEM reset runs immediately and canceled/rejected renders do not become unhandled failures',async()=>{
  const errors=[];let runs=0;
  const queue=createDemUpdateQueue(async()=>{runs++;throw new Error('test failure');},{onError:e=>errors.push(e.message)});
  queue.request({immediate:true});await tick();assert.equal(runs,1);assert.deepEqual(errors,['test failure']);
  queue.request();queue.invalidate();await tick();assert.equal(runs,1);
});

test('DEM opacity starts/reset at 100 and all color inputs apply without an Apply button',()=>{
  assert.match(html,/id="dem-opacity"[^>]*value="100"/);assert.doesNotMatch(html,/id="dem-apply"/);assert.match(html,/id="dem-reset">Reset to defaults/);
  assert.match(source,/getElementById\('dem-opacity'\)\.value = '100'/);
  assert.match(source,/dom\.demColormap, document\.getElementById\('dem-steps'\)[\s\S]*addEventListener\('change'/);
  assert.match(source,/dom\.demShading\.addEventListener\('input',[\s\S]*?demUpdateQueue\.request\(\)/);
  assert.match(source,/if \(!isCurrent\(\) \|\| signal\?\.aborted\) return/);
});

test('DSM and DTM reuse the same stable camera layer as orthophoto with permission checks',()=>{
  const fn=source.slice(source.indexOf('function refreshMapCameraLayer()'),source.indexOf('\nlet cameraMarkerUserScale',source.indexOf('function refreshMapCameraLayer()')));
  let added=0;const layer={addTo(){added++;return this;}};
  const context={state:{activeMode:'dsm',camerasVisible:true,camerasLoaded:true},SHARE_PERMISSIONS:{cameras:true},SHOTS_URL:'/shots',map:{hasLayer:()=>true,removeLayer(){}},mapCameraLayer:layer,mapCameraFeatures:[],camFeatures:[],mapCameraScale:0.5,cameraMarkerUserScale:0.5,mapCameraSources:[1,2],window:{},isMapMode(){return ['ortho','dsm','dtm'].includes(context.state.activeMode);}};
  context.camFeatures=context.mapCameraFeatures;vm.createContext(context);vm.runInContext(fn,context);
  for(const mode of ['ortho','dsm','dtm']){context.state.activeMode=mode;assert.equal(context.refreshMapCameraLayer(),true);assert.equal(context.mapCameraLayer,layer);}
  assert.equal(added,3,'same canvas layer is reused; its onFrame callback owns painted diagnostics');
  context.SHARE_PERMISSIONS.cameras=false;assert.equal(context.refreshMapCameraLayer(),false);
});

test('DEM volume controls are hidden for browsing but remain available for real volume measurements',()=>{
  const fn=source.slice(source.indexOf('function syncMapVolumeAvailability()'),source.indexOf('\nfunction cancelMapMeasure',source.indexOf('function syncMapVolumeAvailability()')));
  const options={style:{}},surface={value:'auto',querySelector:()=>({disabled:false}),selectedOptions:[{disabled:false}]},button={};
  const context={state:{activeMode:'dsm',activeTool:'none'},demLayers:{dsm:{}},DSM_URL:'/dsm',DTM_URL:'/dtm',isMapMode:()=>true,document:{getElementById:id=>({'map-volume-options':options,'map-volume-surface':surface,'tool-volume':button}[id])}};
  vm.createContext(context);vm.runInContext(fn,context);context.syncMapVolumeAvailability();assert.equal(options.style.display,'none');
  context.state.activeTool='volume';context.syncMapVolumeAvailability();assert.equal(options.style.display,'block');assert.equal(surface.value,'dsm');
  assert.match(source,/polygon, nodata: ds\.nodata, reference, customReference/,'reference-plane math is unchanged');
});

test('both real DEM pixel paths are opaque and remap colors without clipping out-of-range elevations',()=>{
  const extract=name=>{const start=source.indexOf(`function ${name}(`);return source.slice(start,source.indexOf('\nfunction ',start+1));};
  const context={demSettings:{cmap:'test',shade:0,minFt:0,maxFt:10,steps:0},COLORMAPS:{test:[[0,0,0,0],[1,255,255,255]]},elevationInputMeters:v=>v,latLonToUtm:(lat,lon)=>[lon,lat],document:{createElement:()=>({getContext(){return{createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:image=>{this.pixels=image.data;}};}})}};
  vm.createContext(context);vm.runInContext([extract('sampleCmap'),extract('warpedSampleGrid'),extract('renderOrthoTile'),extract('renderDemTile')].join('\n'),context);
  const raster=[new Float32Array([-1,2,11,-9999])],ds={isDem:true,nodata:-9999,min:-1,max:11};
  const paths=[()=>context.renderDemTile(raster,4,1,ds),()=>context.warpedSampleGrid(raster,4,1,0,4,1,0,[0.5],[0.5,1.5,2.5,3.5],4,1,ds)];
  for(const render of paths){context.demSettings.minFt=0;context.demSettings.maxFt=10;const before=render().pixels;assert.deepEqual([before[3],before[7],before[11],before[15]],[255,255,255,0]);assert.deepEqual([before[0],before[4],before[8]],[0,51,255]);context.demSettings.minFt=4;context.demSettings.maxFt=6;const after=render().pixels;assert.deepEqual([after[3],after[7],after[11],after[15]],[255,255,255,0]);assert.deepEqual([after[0],after[4],after[8]],[0,0,255]);}
});

test('actual DEM settings renderer paints only the latest requested elevation bounds',async()=>{
  const start=source.indexOf('async function applyDemSettings('),fn=source.slice(start,source.indexOf('\nfunction resetDemSettings',start));
  const painted=[],pending=[],demSettings={};
  const context={modeAbortController:{signal:{aborted:false}},demSettings,dom:{demColormap:{value:'viridis'},demShading:{value:'1'},demMin:{value:'0'},demMax:{value:'10'}},document:{getElementById:()=>({value:'0'})},demLayers:{dsm:{ds:{},overlay:{setUrl:url=>painted.push(url)},grid:{redraw(){}}}},overviewCanvas:()=>{const captured=`${demSettings.minFt}:${demSettings.maxFt}`;return new Promise(resolve=>pending.push(()=>resolve({canvas:{toDataURL:()=>captured}})));},renderDemTile(){},state:{activeMode:'dsm'},refreshLegendFor(){},applyDemOpacity(){}};
  vm.createContext(context);vm.runInContext(fn,context);
  const queue=createDemUpdateQueue(context.applyDemSettings);queue.request({immediate:true});assert.equal(pending.length,1);
  context.dom.demMin.value='5';context.dom.demMax.value='15';queue.request({immediate:true});pending.shift()();await tick();assert.equal(painted.length,0);assert.equal(pending.length,1);
  pending.shift()();await tick();assert.deepEqual(painted,['5:15']);
});
