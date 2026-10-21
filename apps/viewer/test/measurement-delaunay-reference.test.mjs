import test from 'node:test';
import assert from 'node:assert/strict';
import {createDelaunayReference} from '../server/measurementDelaunayReference.mjs';
import {integrateSurfaceVolume,polygonArea,createReference} from '../measurement-volume.mjs';
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);

test('Delaunay reference reproduces a plane at UTM coordinates with offset',()=>{
  const vertices=[[0,0],[4,0],[5,3],[2,5],[0,3]].map(([x,y])=>[600000+x,4500000+y,10+2*x-3*y]);
  const base=createDelaunayReference(vertices,{offsetM:2});
  near(base.sample(600002,4500002),10);
  near(base.patches.reduce((sum,p)=>sum+polygonArea(p.polygon),0),polygonArea(vertices));
  for(const p of vertices)near(base.sample(p[0],p[1]),p[2]+2);
  assert.match(base.numericalModel,/Delaunay/);
});

test('concave clipping excludes a deep notch and preserves fractional integration',()=>{
  const vertices=[[0,0,0],[4,0,0],[4,4,0],[3,4,0],[3,1,0],[1,1,0],[1,4,0],[0,4,0]];
  const base=createDelaunayReference(vertices);
  near(base.patches.reduce((sum,p)=>sum+polygonArea(p.polygon),0),10);
  assert.ok(Number.isNaN(base.sample(2,3)));
  const result=integrateSurfaceVolume({vertices,referenceBase:base,values:new Float64Array(16).fill(2),width:4,height:4,bounds:{minE:0,minN:0,maxE:4,maxN:4}});
  near(result.cutM3,20);near(result.validAreaM2,10);assert.equal(result.status,'complete');
});

test('clockwise and collinear boundary vertices preserve area; original reference remains unchanged',()=>{
  const vertices=[[0,0,0],[2,0,1],[4,0,2],[4,3,4],[0,3,2]];
  for(const points of [vertices,vertices.toReversed()]){
    const base=createDelaunayReference(points);
    near(base.patches.reduce((sum,p)=>sum+polygonArea(p.polygon),0),12);
    assert.ok(Number.isFinite(base.sample(2,1)));
  }
  assert.equal(createReference(vertices).numericalModel,undefined);
  assert.throws(()=>createDelaunayReference([[0,0],[1,0],[0,1]]),{code:'measurement_reference_invalid'});
});
