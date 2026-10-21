import fs from 'node:fs';
import readline from 'node:readline';
import crypto from 'node:crypto';
import { Box3, BufferAttribute, BufferGeometry, Line3, Vector3 } from 'three';
import { ExtendedTriangle, MeshBVH } from 'three-mesh-bvh';
import { clipHalfPlane, polygonArea, validatePolygon } from '../measurement-volume.mjs';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const finite3 = p => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
const cross2 = (a,b,c) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
import { insideSelection as inside } from './measurementSelection.mjs';
function canonicalize(vertices, triangles) {
  if (!Array.isArray(vertices) || !Array.isArray(triangles) || vertices.length < 4 || triangles.length < 4 || triangles.length > 200_000 || vertices.length > 200_000 || !vertices.every(finite3)) fail('measurement_mesh_invalid');
  const unique=[],index=new Map(),mapping=vertices.map(p=>{const key=p.join(',');if(!index.has(key)){index.set(key,unique.length);unique.push(p);}return index.get(key);});
  const faces=triangles.map(t=>{if(!Array.isArray(t)||t.length!==3||!t.every(i=>Number.isSafeInteger(i)&&i>=0&&i<vertices.length))fail('measurement_mesh_invalid');return t.map(i=>mapping[i]);});
  return { vertices: unique, triangles: faces };
}
function connectedFaces(triangles) {
  const byVertex=new Map(),seen=new Set(),components=[];
  triangles.forEach((t,i)=>t.forEach(v=>{if(!byVertex.has(v))byVertex.set(v,[]);byVertex.get(v).push(i);}));
  for(let i=0;i<triangles.length;i++){if(seen.has(i))continue;const component=[],pending=[i];seen.add(i);while(pending.length){const face=pending.pop();component.push(face);for(const v of triangles[face])for(const next of byVertex.get(v)){if(!seen.has(next)){seen.add(next);pending.push(next);}}}components.push(component);}
  return components;
}
function overlapArea(a,b,normal) {
  const drop=Math.abs(normal.x)>Math.abs(normal.y)?(Math.abs(normal.x)>Math.abs(normal.z)?0:2):(Math.abs(normal.y)>Math.abs(normal.z)?1:2);
  const project=p=>p.toArray().filter((_,i)=>i!==drop),one=[a.a,a.b,a.c].map(project),two=[b.a,b.b,b.c].map(project);
  if(polygonArea(two)<0)two.reverse();let clipped=one;
  for(let i=0;i<3;i++)clipped=clipHalfPlane(clipped,p=>cross2(two[i],two[(i+1)%3],p));
  return Math.abs(polygonArea(clipped));
}
export function validateClosedMesh(input, { maxIntersectionTests = 5_000_000 } = {}) {
  const {vertices,triangles}=canonicalize(input.vertices,input.triangles),components=connectedFaces(triangles);
  if(components.length!==1)fail('measurement_mesh_multiple_components');
  const edges=new Map(),incident=new Map(),facesSeen=new Set();
  for(let i=0;i<triangles.length;i++){
    const t=triangles[i],key=[...t].sort((a,b)=>a-b).join(',');
    if(new Set(t).size!==3||facesSeen.has(key))fail('measurement_mesh_degenerate');facesSeen.add(key);
    for(let k=0;k<3;k++){const a=t[k],b=t[(k+1)%3],edge=[Math.min(a,b),Math.max(a,b)].join(',');if(!edges.has(edge))edges.set(edge,[]);edges.get(edge).push({face:i,direction:a<b?1:-1});if(!incident.has(a))incident.set(a,[]);incident.get(a).push(i);}
  }
  for(const uses of edges.values())if(uses.length!==2||uses[0].direction===uses[1].direction)fail('measurement_mesh_not_closed_or_oriented');
  // Every vertex link must form one fan: edge-manifold alone accepts bow ties.
  for(const[v,faces]of incident){const pending=[faces[0]],visited=new Set(pending);while(pending.length){const f=pending.pop(),t=triangles[f];for(const u of t){if(u===v)continue;const uses=edges.get([Math.min(v,u),Math.max(v,u)].join(','));for(const other of uses)if(!visited.has(other.face)){visited.add(other.face);pending.push(other.face);}}}if(visited.size!==faces.length)fail('measurement_mesh_nonmanifold_vertex');}
  const origin=vertices[triangles[0][0]],local=vertices.map(p=>new Vector3(p[0]-origin[0],p[1]-origin[1],p[2]-origin[2]));
  const geometry=new BufferGeometry();geometry.setAttribute('position',new BufferAttribute(new Float64Array(local.flatMap(p=>p.toArray())),3));geometry.setIndex(triangles.flat());
  const bvh=new MeshBVH(geometry,{indirect:true,targetLeafSize:8}),triangle=new ExtendedTriangle(),box=new Box3(),line=new Line3(),normal=new Vector3();
  let volume=0,area=0,checks=0;
  try {
    for(let i=0;i<triangles.length;i++){
      const ids=triangles[i],[a,b,c]=ids.map(k=>local[k]);triangle.set(a,b,c);triangle.needsUpdate=true;
      const triangleArea=triangle.getArea();if(triangleArea<1e-12)fail('measurement_mesh_degenerate');area+=triangleArea;
      volume+=a.dot(new Vector3().crossVectors(b,c))/6;box.setFromPoints([a,b,c]).expandByScalar(1e-9);triangle.getNormal(normal);
      let invalid=false;
      bvh.shapecast({intersectsBounds:bounds=>bounds.intersectsBox(box),intersectsTriangle:(other,j)=>{
        if(j<=i)return false;if(++checks>maxIntersectionTests)fail('measurement_mesh_complexity_limit');
        if(!triangle.intersectsTriangle(other,line,true))return false;
        const shared=triangles[j].filter(v=>ids.includes(v));
        if(!shared.length){invalid=true;return true;}
        const coplanar=Math.abs(normal.dot(new Vector3().subVectors(other.a,a)))<1e-9&&Math.abs(normal.dot(new Vector3().subVectors(other.b,a)))<1e-9&&Math.abs(normal.dot(new Vector3().subVectors(other.c,a)))<1e-9;
        if(coplanar){if(overlapArea(triangle,other,normal)>1e-10){invalid=true;return true;}return false;}
        if(shared.length===1){if(line.start.distanceTo(local[shared[0]])>1e-7||line.end.distanceTo(local[shared[0]])>1e-7){invalid=true;return true;}}
        else {const expected=new Line3(local[shared[0]],local[shared[1]]),p=new Vector3();for(const end of[line.start,line.end]){expected.closestPointToPoint(end,true,p);if(p.distanceTo(end)>1e-7){invalid=true;return true;}}}
        return false;
      }});
      if(invalid)fail('measurement_mesh_self_intersection');
    }
    if(!Number.isFinite(volume)||Math.abs(volume)<1e-12)fail('measurement_mesh_zero_volume');
    return {method:'closed-mesh',status:'complete',volumeM3:Math.abs(volume),surfaceAreaM2:area,vertexCount:vertices.length,triangleCount:triangles.length,componentCount:1,checks:{closed:true,edgeManifold:true,vertexManifold:true,orientationConsistent:true,selfIntersections:false},warnings:['Enclosed volume describes the observed closed mesh, not guaranteed physical-object or survey accuracy.'],vertices,triangles};
  } finally { geometry.dispose(); }
}
export async function readSelectedObj(absolutePath,request,{signal}={}) {
  const polygon=validatePolygon(request.vertices),selection=request.selection;
  if(!selection||!finite3(selection.seed)||!Number.isFinite(selection.minElevationM)||!Number.isFinite(selection.maxElevationM)||selection.maxElevationM<=selection.minElevationM)fail('measurement_mesh_selection_invalid');
  const offset=request.sourceOffset||[0,0,0];if(!finite3(offset))fail('measurement_mesh_frame_unknown');
  const before=await fs.promises.stat(absolutePath);if(!before.isFile()||before.size!==request.source.byteSize)fail('measurement_source_changed');
  const hash=crypto.createHash('sha256'),stream=fs.createReadStream(absolutePath,{signal});stream.on('data',chunk=>hash.update(chunk));
  const lines=readline.createInterface({input:stream,crlfDelay:Infinity}),selected=new Map(),vertices=[],triangles=[];let index=0;
  try {
    for await(const line of lines){if(signal?.aborted)fail('measurement_cancelled');if(line.length>1024*1024)fail('measurement_mesh_invalid');
      if(/^v\s/.test(line)){const p=line.trim().split(/\s+/).slice(1,4).map(Number);index++;if(!finite3(p))fail('measurement_mesh_invalid');for(let k=0;k<3;k++)p[k]+=offset[k];if(p[2]>=selection.minElevationM&&p[2]<=selection.maxElevationM&&inside(p[0],p[1],polygon)){selected.set(index,vertices.length);vertices.push(p);if(vertices.length>200_000)fail('measurement_mesh_selection_limit');}}
      else if(/^f\s/.test(line)){const words=line.trim().split(/\s+/).slice(1),ids=words.map(word=>{const value=Number(word.split('/')[0]);return value<0?index+1+value:value;});if(!ids.every(Number.isInteger))fail('measurement_mesh_invalid');if(ids.every(id=>selected.has(id))){if(ids.length!==3)fail('measurement_mesh_nontriangular_source');triangles.push(ids.map(id=>selected.get(id)));if(triangles.length>200_000)fail('measurement_mesh_selection_limit');}}
    }
  }finally{lines.close();stream.destroy();}
  if(hash.digest('hex')!==request.source.sha256)fail('measurement_source_changed');
  const after=await fs.promises.stat(absolutePath);if(['dev','ino','size','mtimeMs','ctimeMs'].some(k=>before[k]!==after[k]))fail('measurement_source_changed');
  if(!triangles.length)fail('measurement_mesh_selection_empty');
  const mesh=canonicalize(vertices,triangles),components=connectedFaces(mesh.triangles),seed=new Vector3(...selection.seed),closest=new Vector3();let chosen=null,distance=Infinity;
  for(const component of components)for(const i of component){const t=new ExtendedTriangle(...mesh.triangles[i].map(k=>new Vector3(...mesh.vertices[k])));t.closestPointToPoint(seed,closest);const d=closest.distanceToSquared(seed);if(d<distance){distance=d;chosen=component;}}
  return {vertices:mesh.vertices,triangles:chosen.map(i=>mesh.triangles[i]),selection:{...selection,selectedComponents:1,availableComponents:components.length,seedDistanceM:Math.sqrt(distance)}};
}
export async function calculateClosedObj(absolutePath,request,options={}) {
  const selected=await readSelectedObj(absolutePath,request,options),validated=validateClosedMesh(selected),{vertices,triangles,...result}=validated;
  const previewLimit=10_000,stride=Math.max(1,Math.ceil(triangles.length/previewLimit)),previewFaces=triangles.filter((_,i)=>i%stride===0),used=[...new Set(previewFaces.flat())],mapping=new Map(used.map((v,i)=>[v,i]));
  return {...result,calculationOrigin:'server-original-mesh',source:{assetId:request.source.id,sha256:request.source.sha256,modelVersionId:request.modelVersionId,coordinateFrame:request.sourceCoordinateFrame},selection:selected.selection,preview:{previewOnly:stride>1,vertices:used.map(i=>vertices[i]),triangles:previewFaces.map(t=>t.map(i=>mapping.get(i)))}};
}
