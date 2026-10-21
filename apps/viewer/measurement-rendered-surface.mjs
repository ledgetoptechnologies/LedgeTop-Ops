import * as THREE from 'three';

const pending=()=>Object.assign(new Error('Waiting for displayed surface detail at every outline point.'),{code:'measurement_display_surface_pending'});
const check=signal=>{if(signal?.aborted)throw new DOMException('Display placement cancelled','AbortError');};
const yieldDefault=()=>new Promise(resolve=>setTimeout(resolve,0));
export function renderedPointNodeDescriptor(node){
  const object=node?.sceneNode,geometry=object?.geometry||node?.geometryNode?.geometry,positions=geometry?.attributes?.position;
  if(!object||object.visible===false||!positions||!object.matrixWorld)return null;
  const matrixWorld=new THREE.Matrix4().fromArray(object.matrixWorld.elements),nodeBounds=node.geometryNode?.boundingBox;
  // Potree attaches the node minimum to sceneNode.position while its loader
  // can leave geometry.boundingBox in the untranslated node coordinate frame.
  const localBounds=nodeBounds?new THREE.Box3(new THREE.Vector3(),new THREE.Vector3().subVectors(nodeBounds.max,nodeBounds.min)):geometry.boundingBox;
  if(!localBounds)return null;
  const bounds=new THREE.Box3(new THREE.Vector3().copy(localBounds.min),new THREE.Vector3().copy(localBounds.max)).applyMatrix4(matrixWorld),spacing=Number(node.geometryNode?.spacing??node.spacing)*matrixWorld.getMaxScaleOnAxis();
  return{geometry,positions,matrixWorld,bounds,spacing};
}
function validate(record,expectedCrs){
  if(record?.collection!=='map'||!/^EPSG:\d+$/.test(expectedCrs||'')||record.coordinateReference?.crs!==expectedCrs)throw Object.assign(new Error('The outline does not match this view’s coordinate reference.'),{code:'measurement_display_reference_mismatch'});
  if(!Array.isArray(record.vertices)||record.vertices.length<2||record.vertices.length>2000||!record.vertices.every(p=>Array.isArray(p)&&p.length===3&&p.every(v=>Number.isFinite(v)&&Math.abs(v)<=1e9)))throw new Error('Invalid outline geometry.');
}
function result(record,heights,basis,surfaceRevision){
  if(heights.some(z=>!Number.isFinite(z)))throw pending();
  return{vertices:record.vertices.map(([e,n],i)=>[e,n,heights[i]]),basis,renderedSurface:true,displayOnly:true,surfaceRevision};
}

// Ephemeral placement against geometry already rendered by this view. These
// coordinates are never unit evidence, measurement edits, or volume inputs.
export async function resolveRenderedMeshBoundary({record,expectedCrs,roots=[],worldBounds,toWorld,fromWorld,signal,yieldControl=yieldDefault,surfaceRevision}={}){
  validate(record,expectedCrs);check(signal);
  if(!worldBounds||worldBounds.isEmpty()||![...worldBounds.min.toArray(),...worldBounds.max.toArray()].every(Number.isFinite))throw pending();
  const meshes=[],owners=new Map();
  const visit=(object,tile)=>{if(!object||object.visible===false)return;if(object.isMesh&&object.geometry&&(!object.material|| (Array.isArray(object.material)?object.material.some(m=>m.visible!==false):object.material.visible!==false))){meshes.push(object);owners.set(object,tile);}for(const child of object.children||[])visit(child,tile);};
  for(const item of roots){const root=item.root||item;root.updateWorldMatrix?.(true,true);visit(root,item.tile);}
  if(!meshes.length)throw pending();
  const margin=Math.max(1,worldBounds.max.y-worldBounds.min.y),ray=new THREE.Raycaster(),heights=[];
  ray.firstHitOnly=true;ray.far=worldBounds.max.y-worldBounds.min.y+2*margin;
  for(let i=0;i<record.vertices.length;i++){
    check(signal);const [e,n]=record.vertices[i],p=toWorld(e,n,0);p.y=worldBounds.max.y+margin;
    ray.set(p,new THREE.Vector3(0,-1,0));const hits=ray.intersectObjects(meshes,false);
    // An overlapping visible descendant supersedes its coarse fallback parent
    // at this XY, even when the simplified parent happens to sit higher.
    const ancestor=(a,b)=>{if(!a||!b||a===b)return false;for(let p=b.parent;p;p=p.parent)if(p===a)return true;return false;};
    const hit=hits.find(item=>Number.isFinite(item.point?.y)&&!hits.some(other=>ancestor(owners.get(item.object),owners.get(other.object))));
    if(!hit)throw pending();const canonical=fromWorld(hit.point);heights.push(canonical.alt??canonical[2]);
    if(i%8===7){await yieldControl();check(signal);}
  }
  return result(record,heights,'Placed on displayed 3D surface; display only (detail-dependent).',surfaceRevision);
}

const pointIndexes=new WeakMap(),pointIndexLru=new Map(),pointIndexBuilds=new WeakMap();let cachedCells=0;
const MAX_INDEX_CELLS=262144;
const indexLimit=()=>Object.assign(new Error('Displayed node exceeds bounded placement indexing.'),{code:'measurement_display_index_limit'});
async function buildPointIndex(node,signal,yieldControl){
  const positions=node.positions,signature=`${node.spacing}:${positions.version||0}:${node.matrixWorld.elements.join(',')}`;
  const old=pointIndexes.get(positions);
  if(old?.signature===signature&&old.limited)throw indexLimit();
  if(old?.signature===signature&&pointIndexLru.has(old)){pointIndexLru.delete(old);pointIndexLru.set(old,true);return old;}
  if(old&&pointIndexLru.delete(old)){cachedCells-=old.cells.size;old.cells.clear();}
  const cells=new Map(),point=new THREE.Vector3(),cellSize=node.spacing;
  for(let at=0;at<positions.count;at++){
    point.fromBufferAttribute(positions,at).applyMatrix4(node.matrixWorld);
    if(Number.isFinite(point.x)&&Number.isFinite(point.y)&&Number.isFinite(point.z)){
      const key=`${Math.floor(point.x/cellSize)},${Math.floor(point.y/cellSize)}`,previous=cells.get(key);
      if(!previous||point.z>previous[2])cells.set(key,[point.x,point.y,point.z]);
      if(cells.size>MAX_INDEX_CELLS){pointIndexes.set(positions,{signature,limited:true});throw indexLimit();}
    }
    if(at%16384===16383){await yieldControl();check(signal);}
  }
  check(signal);
  while(cachedCells+cells.size>MAX_INDEX_CELLS&&pointIndexLru.size){const first=pointIndexLru.keys().next().value;pointIndexLru.delete(first);cachedCells-=first.cells.size;first.cells.clear();}
  const entry={signature,cells,cellSize};pointIndexes.set(positions,entry);pointIndexLru.set(entry,true);cachedCells+=cells.size;return entry;
}
async function pointIndex(node,signal,yieldControl){
  check(signal);const signature=`${node.spacing}:${node.positions.version||0}:${node.matrixWorld.elements.join(',')}`;
  let entry=pointIndexBuilds.get(node.positions);
  if(!entry||entry.signature!==signature){entry={signature};pointIndexBuilds.set(node.positions,entry);entry.promise=buildPointIndex(node,signal,yieldControl).finally(()=>{if(pointIndexBuilds.get(node.positions)===entry)pointIndexBuilds.delete(node.positions);});}
  try{const value=await entry.promise;check(signal);return value;}
  catch(error){check(signal);if(error.name==='AbortError')return pointIndex(node,signal,yieldControl);throw error;}
}
// Cooperative indexes retain one top displayed point per spacing-sized cell,
// explicitly approximate and bounded globally. Unchanged nodes are reused
// across polygons and LOD-frontier changes instead of rescanning the cloud.
export async function resolveRenderedPointBoundary({record,expectedCrs,nodes=[],signal,yieldControl=yieldDefault,surfaceRevision}={}){
  validate(record,expectedCrs);check(signal);
  const best=record.vertices.map(()=>({distance:Infinity,z:NaN,spacing:Infinity}));let nodesSeen=0;
  for(const node of nodes){
    if(++nodesSeen%16===0){await yieldControl();check(signal);}
    check(signal);const spacing=Number(node.spacing),positions=node.positions,bounds=node.bounds,matrix=node.matrixWorld;
    if(!positions||!matrix||!Number.isFinite(spacing)||spacing<=0||!bounds||bounds.isEmpty())continue;
    const radius=spacing*1.5,queries=[];
    for(let i=0;i<record.vertices.length;i++){
      const [e,n]=record.vertices[i];if(e<bounds.min.x-radius||e>bounds.max.x+radius||n<bounds.min.y-radius||n>bounds.max.y+radius)continue;
      queries.push(i);
    }
    if(!queries.length)continue;
    let index;try{index=await pointIndex(node,signal,yieldControl);}catch(error){if(error.code==='measurement_display_index_limit')continue;throw error;}check(signal);
    for(const i of queries){const p=record.vertices[i],x=Math.floor(p[0]/spacing),y=Math.floor(p[1]/spacing),b=best[i];
      for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++){const point=index.cells.get(`${x+dx},${y+dy}`);if(!point)continue;const distance=(p[0]-point[0])**2+(p[1]-point[1])**2;
        if(distance<=radius*radius&&(spacing<b.spacing||(spacing===b.spacing&&(distance<b.distance||(distance===b.distance&&point[2]>b.z))))){b.distance=distance;b.z=point[2];b.spacing=spacing;}
      }
    }
  }
  check(signal);return result(record,best.map(p=>p.z),'Placed near displayed cloud points; display only (approximate, detail-dependent).',surfaceRevision);
}
