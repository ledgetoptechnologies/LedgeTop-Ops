import test from 'node:test';
import assert from 'node:assert/strict';
import {mountGcpGeographicMap,AERIAL_TILES} from '../workspace-gcp-geographic.mjs';

function leaflet() {
  const state={markers:[],tiles:[],removed:0,resized:0};
  const map={setView(center,zoom){state.view={center,zoom}},remove(){state.removed++},removeLayer(layer){layer.removed=true},fitBounds(bounds,options){state.fit={bounds,options}},invalidateSize(){state.resized++}};
  const L={map:()=>map,divIcon:options=>options,circle:(pos,options)=>({addTo(){state.circle={pos,options};return this},getBounds(){return 'circle-bounds'}}),latLngBounds:()=>({points:[],extend(pos){this.points.push(pos)},pad(){return this}}),marker:(pos,options)=>{const listeners={},element={attrs:{},setAttribute(k,v){this.attrs[k]=v},addEventListener(k,fn){listeners[k]=fn}};const value={pos,options,listeners,element,addTo(){state.markers.push(this);return this},on(k,fn){listeners[k]=fn;return this},getElement(){return element}};return value},tileLayer:(url,options)=>({url,options,addTo(){state.tiles.push(this);return this}})};
  return {L,state};
}
test('large map plots GCPs, camera GPS and 50-foot radius without remote tiles by default',()=>{
 const {L,state}=leaflet(),calls=[],point={id:'p1',label:'Point one',latitude:44,longitude:-88};
 const mounted=mountGcpGeographicMap({L,element:{},point,points:[point,{id:'p2',label:'Point two',latitude:44.001,longitude:-88}],images:[{id:'i1',relativePath:'source/photo.jpg',latitude:44.00001,longitude:-88},{id:'bad',latitude:null,longitude:2}],radiusM:15.24,onPoint:id=>calls.push(['point',id]),onImage:id=>calls.push(['image',id])});
 assert.deepEqual(state.circle.pos,[44,-88]);assert.equal(state.circle.options.radius,15.24);assert.equal(state.markers.length,3);assert.equal(state.tiles.length,0);
 state.markers[1].listeners.click();state.markers[2].listeners.click();assert.deepEqual(calls,[['point','p2'],['image','i1']]);
 assert.equal(state.markers[2].element.attrs.role,'button');assert.match(state.markers[2].element.attrs['aria-label'],/Open photo/);
 let prevented=false;state.markers[2].listeners.keydown({key:' ',preventDefault(){prevented=true}});assert.equal(prevented,true);assert.deepEqual(calls.at(-1),['image','i1']);
 mounted.setAerial(true);assert.equal(state.tiles[0].url,AERIAL_TILES);mounted.setAerial(false);assert.equal(state.tiles[0].removed,true);mounted.resize();mounted.close();mounted.close();assert.equal(state.resized,1);assert.equal(state.removed,1);
});
test('invalid point coordinates and radius fail before opening a map',()=>{
 const {L}=leaflet();for(const point of [null,{latitude:null,longitude:0},{latitude:'',longitude:0},{latitude:false,longitude:0},{latitude:91,longitude:0}])assert.throws(()=>mountGcpGeographicMap({L,element:{},point,radiusM:15.24}));
 assert.throws(()=>mountGcpGeographicMap({L,element:{},point:{latitude:0,longitude:0},radiusM:0}));
});
test('camera positions near the antimeridian fit near the selected point',()=>{
 const {L,state}=leaflet();const point={id:'p',latitude:0,longitude:179.999};
 const map=mountGcpGeographicMap({L,element:{},point,points:[point],images:[{id:'i',latitude:0,longitude:-179.999}],radiusM:15.24});
 assert.ok(Math.abs(state.markers[1].pos[1]-point.longitude)<.01);map.close();
});
test('failed map initialization releases the partially mounted map',()=>{
 const {L,state}=leaflet();L.circle=()=>{throw Error('synthetic failure')};
 assert.throws(()=>mountGcpGeographicMap({L,element:{},point:{latitude:0,longitude:0},radiusM:15.24}));assert.equal(state.removed,1);
});
