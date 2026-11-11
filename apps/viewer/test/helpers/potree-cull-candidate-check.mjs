import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { patchPotreeCullNormals } from '../../scripts/potree-cull-normal-candidate.mjs';
import { patchPotreeCombinedClip } from '../../scripts/potree-combined-clip-candidate.mjs';
const require=createRequire(import.meta.url),T=require('/app/dist/potree/libs/three.js/build/three.js');
const source=readFileSync('/app/dist/potree/build/potree/potree.js','utf8'),patched=patchPotreeCombinedClip(source);
assert.ok(patchPotreeCullNormals(source));assert.throws(()=>patchPotreeCombinedClip(patched),/hash/);
console.log('candidate sha256',createHash('sha256').update(patched).digest('hex'));
const begin='let pcWorldInverse = pointcloud.matrixWorld.clone().invert();',end='let intersects = frustum.intersectsBox(box);';
const part=s=>{let a=s.indexOf(begin),b=s.indexOf(end,a);assert.ok(a>=0&&b>a);return s.slice(a,b)+end;};
const native=new Function('pointcloud','clipBox','box','Vector3','Plane','Frustum',part(source)+'return intersects;');
const fixed=new Function('pointcloud','clipBox','box','Vector3','Plane','Frustum',`let numIntersecting=0,numIntersectionVolumes=0;for(const item of [0]){${part(patched)}return intersects;}return true;`);
const run=(fn,cloud,clip,box)=>fn({matrixWorld:cloud},{box:{matrixWorld:clip}},box,T.Vector3,T.Plane,T.Frustum);
const node=(x,y,z,r=.005)=>new T.Box3(new T.Vector3(x-r,y-r,z-r),new T.Vector3(x+r,y+r,z+r));
const clip=new T.Matrix4().compose(new T.Vector3(10,0,0),new T.Quaternion().setFromAxisAngle(new T.Vector3(0,0,1),Math.PI/4),new T.Vector3(2,1,1));
const cloud=new T.Matrix4().makeScale(2,1,1),inv=cloud.clone().invert().multiply(clip).invert();
let inside=0,outside=0,crossing=0,crossingMiss=0,nativeMiss=0,fixedMiss=0,fixedOutsideRejected=0;
for(let x=4.1;x<=5.9;x+=.04)for(let y=-1;y<=1;y+=.04){const box=node(x,y,0),corners=[];for(const dx of [box.min.x,box.max.x])for(const dy of [box.min.y,box.max.y])for(const dz of [box.min.z,box.max.z])corners.push(new T.Vector3(dx,dy,dz).applyMatrix4(inv));const allInside=corners.every(p=>Math.abs(p.x)<.5&&Math.abs(p.y)<.5&&Math.abs(p.z)<.5);const clearOutside=[0,1,2].some(i=>corners.every(p=>p.getComponent(i)>.6)||corners.every(p=>p.getComponent(i)<-.6));const n=run(native,cloud,clip,box),f=run(fixed,cloud,clip,box);if(allInside){inside++;if(!n)nativeMiss++;if(!f)fixedMiss++;}else if(corners.some(p=>Math.abs(p.x)<.5&&Math.abs(p.y)<.5&&Math.abs(p.z)<.5)){crossing++;if(!f)crossingMiss++;}if(clearOutside){outside++;if(!f)fixedOutsideRejected++;}}
assert.ok(inside>100&&outside>100&&crossing>0);assert.ok(nativeMiss>0);assert.equal(fixedMiss,0);assert.equal(crossingMiss,0);assert.ok(fixedOutsideRejected>0);
// A second unrelated clip volume exercises any/all aggregation on independently
// evaluated boxes; conservative intersection can admit extra nodes.
const second=new T.Matrix4().makeTranslation(50,0,0),near=node(5,0,0),far=node(25,0,0),firstHit=run(fixed,cloud,clip,near),secondHit=run(fixed,cloud,second,near),farSecond=run(fixed,cloud,second,far);
assert.equal(firstHit,true);assert.equal(secondHit,false);assert.equal(firstHit||secondHit,true);assert.equal(firstHit&&secondHit,false);assert.equal(farSecond,true);
const reflected=new T.Matrix4().makeScale(-2,1,1),reflectedInv=reflected.clone().invert().multiply(clip).invert();let reflectedInside=0;
for(let x=-5.9;x<=-4.1;x+=.04)for(let y=-1;y<=1;y+=.04){const box=node(x,y,0),corners=[];for(const dx of [box.min.x,box.max.x])for(const dy of [box.min.y,box.max.y])for(const dz of [box.min.z,box.max.z])corners.push(new T.Vector3(dx,dy,dz).applyMatrix4(reflectedInv));if(corners.every(p=>Math.abs(p.x)<.5&&Math.abs(p.y)<.5&&Math.abs(p.z)<.5)){reflectedInside++;assert.equal(run(fixed,reflected,clip,box),true,'reflected contained node');}}
assert.ok(reflectedInside>100);
// Degenerate candidate transforms conservatively retain the node.
assert.equal(run(fixed,new T.Matrix4(),new T.Matrix4().makeScale(0,1,1),node(100,100,100)),true);
console.log(JSON.stringify({inside,outside,crossing,crossingMiss,nativeMiss,fixedMiss,fixedOutsideRejected,reflectedInside,multipleBoxes:true,singularConservative:true}));
