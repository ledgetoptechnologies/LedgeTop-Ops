import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSampledCrossSection,nearestSectionSample,initialSectionOffsetPercent} from '../measurement-cross-section.mjs';

test('narrow corridor selects a known sloping plane without flattening base or inventing samples',()=>{
  const samples=[];for(let x=0;x<=10;x++)for(let y=-3;y<=3;y++)samples.push([500000+x,4500000+y,100+x*.2+y*.1,90+x*.1]);
  const result=buildSampledCrossSection(samples,{width:.1});assert.equal(result.points.length,11);assert.equal(result.points[0].distance,0);assert.equal(result.points.at(-1).distance,10);assert.equal(result.points.at(-1).elevation,102);assert.equal(result.points.at(-1).base,91);assert.equal(result.points.at(-1).difference,11);
});
test('azimuth and offset choose a different physical corridor, not the whole region projected sideways',()=>{
  const samples=[];for(let x=-2;x<=2;x++)for(let y=-2;y<=2;y++)samples.push([x,y,x+y,0]);
  const result=buildSampledCrossSection(samples,{azimuth:90,offset:1,width:.1});assert.equal(result.points.length,5);assert.ok(result.points.every(p=>p.x===-1));assert.ok(Math.abs(result.points[0].distance)<1e-9);assert.equal(result.points.at(-1).distance,4);
});
test('pile cross section keeps the actual observed heights and does not fill a large missing interval',()=>{
  const samples=[[0,0,0,0],[1,0,2,0],[2,0,4,0],[8,0,4,0],[9,0,2,0],[10,0,0,0]];
  const section=buildSampledCrossSection(samples,{width:.1});assert.equal(section.points.length,6);assert.equal(nearestSectionSample(section,5,{tolerance:1}),null);assert.equal(nearestSectionSample(section,1.05,{tolerance:.1}).elevation,2);assert.deepEqual(samples[2],[2,0,4,0]);
});
test('empty corridors remain empty and malformed/unbounded data is rejected',()=>{
  assert.equal(buildSampledCrossSection([[0,0,3,0]],{offset:5,width:1}).points.length,0);
  assert.deepEqual(buildSampledCrossSection([]).points,[]);
  for(const samples of [[[0,0,NaN,0]],[[0,0,1]],Array.from({length:20001},()=>[0,0,1,0])])assert.throws(()=>buildSampledCrossSection(samples));
  assert.throws(()=>buildSampledCrossSection([[0,0,1,0]],{width:0}));assert.throws(()=>buildSampledCrossSection([[0,0,1,0]],{azimuth:Infinity}));
});

test('hover chooses the actual nearby height when a corridor has several samples at one station',()=>{
  const section=buildSampledCrossSection([[0,-1,2,0],[0,0,4,0],[0,1,6,0]],{width:3});
  assert.equal(nearestSectionSample(section,0,{tolerance:.1,elevation:4.02,verticalTolerance:.2}).elevation,4);
  assert.equal(nearestSectionSample(section,0,{tolerance:.1,elevation:5,verticalTolerance:.2}),null);
});

test('initial corridor selects a real sparse sample row, while manual empty positions remain empty',()=>{
  const samples=[];for(let x=0;x<11;x++)for(let y=0;y<6;y++)samples.push([x,y*10,5,0]);
  const initial=buildSampledCrossSection(samples,{width:5}),percent=initialSectionOffsetPercent(initial);
  assert.equal(initial.points.length,0);assert.notEqual(percent,0);
  const offset=(initial.crossExtent[0]+initial.crossExtent[1])/2+percent*(initial.crossExtent[1]-initial.crossExtent[0])/200;
  assert.equal(buildSampledCrossSection(samples,{offset,width:5}).points.length,11);
  assert.equal(buildSampledCrossSection(samples,{offset:0,width:5}).points.length,0);
});
