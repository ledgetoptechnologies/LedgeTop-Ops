import test from 'node:test';
import assert from 'node:assert/strict';
import { createDelaunayReference } from '../server/measurementDelaunayReference.mjs';
import { frozenReferenceIntervals } from '../server/measurementRasterTransect.mjs';

test('frozen Delaunay side-profile retains sloping base and offset without bridging concave notch', () => {
  const outline = [[0,0],[4,0],[4,4],[3,4],[3,1],[1,1],[1,4],[0,4]];
  const vertices = outline.map(([x,y]) => [406000+x,4905000+y,170+2*x-y]);
  const base = createDelaunayReference(vertices, { offsetM: .125 });
  const frozen = base.patches.map(({polygon,sample}) => polygon.map(([x,y]) => [x,y,sample(x,y)]));
  const line = {start:[406000,4905003],end:[406004,4905003]};
  const intervals = frozenReferenceIntervals(line,frozen);
  const length = intervals.reduce((sum,p) => sum+p.endT-p.startT,0)*4;
  assert.ok(Math.abs(length-2)<1e-8);
  assert.ok(!intervals.some(p=>p.startT<.5&&p.endT>.5),'no sample/reference across missing polygon notch');
  for (const interval of intervals) {
    const t=(interval.startT+interval.endT)/2,x=406000+4*t;
    assert.ok(Math.abs(interval.sample([x,4905003])-(170+8*t-3+.125))<1e-8);
  }
});

test('excessively fragmented concave Delaunay references fail before incompatible frozen profile', () => {
  const points=Array.from({length:64},(_,i)=>{
    const angle=2*Math.PI*i/64,r=i%2?5:10;
    return [r*Math.cos(angle),r*Math.sin(angle),i%3];
  });
  assert.throws(()=>createDelaunayReference(points),{code:'measurement_reference_invalid'});
});
