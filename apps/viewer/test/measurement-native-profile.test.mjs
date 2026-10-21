import test from 'node:test';
import assert from 'node:assert/strict';
import {profileLine, profileStation, validateNativeProfile, exportNativeProfile} from '../measurement-native-profile.mjs';

const source={assetId:'dsm',kind:'dsm',modelVersionId:'version',sha256:'a'.repeat(64),verticalUnit:'m',verticalUnitBasis:'raster-metadata',crs:'EPSG:32616',resolutionM:[1,1]};
const fixture=()=>({method:'surface-transect',sampling:'native-cell-step',parentCalculationId:'volume',baseHash:'b'.repeat(64),source,line:{start:[500000,4800000],end:[500003,4800000]},lengthM:3,cellCount:3,segments:[
  {startM:0,endM:1,start:[500000,4800000],end:[500001,4800000],status:'sample',surfaceM:-2,baseStartM:-3,baseEndM:-2.5,cell:[0,0]},
  {startM:1,endM:2,start:[500001,4800000],end:[500002,4800000],status:'nodata',cell:[1,0]},
  {startM:2,endM:3,start:[500002,4800000],end:[500003,4800000],status:'sample',surfaceM:4,baseStartM:0,baseEndM:1,cell:[2,0]},
]});
test('profile line uses translated projected coordinates and rotates through the polygon center',()=>{
  const vertices=[[500000,4800000,0],[500010,4800000,0],[500010,4800020,0],[500000,4800020,0]];
  assert.deepEqual(profileLine(vertices),{start:[500000,4800010],end:[500010,4800010]});
  const north=profileLine(vertices,90);assert.ok(Math.abs(north.start[0]-500005)<1e-8);assert.ok(Math.abs(north.end[1]-4800020)<1e-8);
  assert.equal(profileLine(vertices,0,100).start[1],4800020);assert.equal(profileLine(vertices,0,-100).start[1],4800000);
  for(const malformed of [[[],[],[]],[[0,0],[0,0],[0,0]],[[0,0],[1,0],[NaN,1]],[]])assert.throws(()=>profileLine(malformed));
});
test('native profile preserves gaps, exact surface steps and linearly sampled frozen base',()=>{
  const profile=validateNativeProfile(fixture()),p=profileStation(profile,.5);
  assert.equal(p.segment.surfaceM,-2);assert.equal(p.base,-2.75);assert.equal(p.difference,.75);assert.equal(p.x,500000.5);
  assert.equal(profileStation(profile,1.5).base,null);assert.equal(profileStation(profile,1).segment.status,'nodata');assert.equal(profileStation(profile,3).index,2);
});
test('profile validation rejects mismatched line/source/base, malformed endpoints/cells and unbounded result',()=>{
  const valid=fixture();assert.throws(()=>validateNativeProfile(valid,{parentCalculationId:'other'}));assert.throws(()=>validateNativeProfile(valid,{source:{...source,sha256:'c'.repeat(64)}}));assert.throws(()=>validateNativeProfile(valid,{line:{start:[0,0],end:[3,0]}}));
  for(const mutate of [r=>delete r.cellCount,r=>r.cellCount=20001,r=>r.source.crs='',r=>r.source.resolutionM=[0,1],r=>r.baseHash='',r=>r.segments[0].cell=[0,0,999],r=>r.segments[0].cell=[.5,0],r=>r.segments[0].start=[900,900],r=>r.segments[0].endM=1.5,r=>r.segments[0].surfaceM=NaN,r=>r.segments.pop(),r=>r.segments.push(...Array(20000).fill(r.segments[0]))]){const r=structuredClone(valid);mutate(r);assert.throws(()=>validateNativeProfile(r));}
});
test('CSV exports unrounded signed numeric elevations and explicit gaps with consistent columns',()=>{
  const profile=fixture();profile.segments[0].surfaceM=-2.123456789;profile.source.modelVersionId='=untrusted';const rows=exportNativeProfile(profile).split('\r\n');
  assert.ok(rows[1].includes('"-2.123456789"'));assert.ok(!rows[1].includes("'-2"));assert.match(rows[1],/'=untrusted/);assert.match(rows[2],/"nodata","","",""/);for(const row of rows)assert.equal(row.split(',').length,19);
});
