import { createHash } from 'node:crypto';
import { POTREE_OUTPUT_SHA256 as GPU_PATCHED_SHA256 } from './potree-local-clip-candidate.mjs';

// Isolated candidate, not used by the production build.
export const POTREE_CULL_INPUT_SHA256='d86b62377d9f74a8269ce800d5c191f45dbed13b3cf48307a8200ff670710c45';
export const POTREE_CULL_OUTPUT_SHA256='c0ac67bf950b93f5342ced4af34e471d30a91f8e1c3621065bb907865f0866a1';
export const POTREE_COMBINED_OUTPUT_SHA256='c19fb8c31d31f06e1bae9e55ecd93660fb512afce505cf7842bcb2c4bfbd0f24';
const start='let pxN = new Vector3().subVectors(nx, px).normalize();';
const end='let nzPlane = new Plane().setFromNormalAndCoplanarPoint(nzN, nz);';
export function patchPotreeCullNormals(source){
  if(typeof source!=='string')throw new Error('Unexpected Potree bundle hash');
  const inputHash=createHash('sha256').update(source).digest('hex');
  if(![POTREE_CULL_INPUT_SHA256,GPU_PATCHED_SHA256].includes(inputHash))throw new Error('Unexpected Potree bundle hash');
  const scope='let pcWorldInverse = pointcloud.matrixWorld.clone().invert();';
  if(source.split(scope).length!==2||source.split(end).length!==2)throw new Error('Potree cull patch target missing or ambiguous');
  const anchor=source.indexOf(scope),from=source.indexOf(start,anchor),to=source.indexOf(end,from)+end.length;
  if(from<anchor||source.slice(from,to).split(start).length!==2)throw new Error('Potree cull patch target missing or ambiguous');
  if(to<=from)throw new Error('Potree cull patch order invalid');
  const replacement=`// Non-invertible transforms cannot prove a node disjoint: retain it.
          const det=toPCObject.determinant();
          if(!Number.isFinite(det)||Math.abs(det)<1e-12){numIntersecting++;numIntersectionVolumes++;continue;}
          const normalMatrix=toPCObject.clone().invert().transpose();
          let pxN=new Vector3(-1,0,0).transformDirection(normalMatrix);
          let nxN=new Vector3(1,0,0).transformDirection(normalMatrix);
          let pyN=new Vector3(0,-1,0).transformDirection(normalMatrix);
          let nyN=new Vector3(0,1,0).transformDirection(normalMatrix);
          let pzN=new Vector3(0,0,-1).transformDirection(normalMatrix);
          let nzN=new Vector3(0,0,1).transformDirection(normalMatrix);
          let pxPlane=new Plane().setFromNormalAndCoplanarPoint(pxN,px);
          let nxPlane=new Plane().setFromNormalAndCoplanarPoint(nxN,nx);
          let pyPlane=new Plane().setFromNormalAndCoplanarPoint(pyN,py);
          let nyPlane=new Plane().setFromNormalAndCoplanarPoint(nyN,ny);
          let pzPlane=new Plane().setFromNormalAndCoplanarPoint(pzN,pz);
          let nzPlane=new Plane().setFromNormalAndCoplanarPoint(nzN,nz);`;
  const result=source.slice(0,from)+replacement+source.slice(to);
  const actual=createHash('sha256').update(result).digest('hex');
  const expected=inputHash===POTREE_CULL_INPUT_SHA256?POTREE_CULL_OUTPUT_SHA256:POTREE_COMBINED_OUTPUT_SHA256;
  if(actual!==expected)throw new Error(`Unexpected patched Potree bundle hash: ${actual}`);
  return result;
}
