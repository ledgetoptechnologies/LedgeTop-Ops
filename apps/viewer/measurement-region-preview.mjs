import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { measurementValue } from './measurement-document.mjs';

const LIMITS=Object.freeze({samples:20_000,vertices:30_000,triangles:10_000,patches:2000});
const ABOVE=[1,.38,.04],BELOW=[.12,.65,.95],OBSERVED=[.25,.67,.8],INFERRED=[.95,.2,.7];
const finitePoint=value=>Array.isArray(value)&&value.length>=3&&value.slice(0,3).every(v=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1e9);
const fail=message=>{throw new Error(message);};

// All geometry is translated in Float64 before conversion to GPU Float32.
// No renderer/camera/LOD state participates in these preview-only buffers.
export function buildMeasurementPreview(preview){
  if(!preview||typeof preview!=='object')fail('No calculation preview is available.');
  const surface=Array.isArray(preview.samples)&&preview.samples.length>0,mesh=Array.isArray(preview.vertices)&&Array.isArray(preview.triangles)&&preview.triangles.length>0;
  if(!surface&&!mesh)fail('No sampled region or selected mesh preview is available.');
  let origin,bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]},pointPositions=[],pointColors=[],basePositions=[],segments=[],segmentColors=[],meshPositions=[],meshColors=[],referencePositions=[];
  const updateBounds=p=>{for(let i=0;i<3;i++){bounds.min[i]=Math.min(bounds.min[i],p[i]);bounds.max[i]=Math.max(bounds.max[i],p[i]);}};
  const local=p=>{updateBounds(p);return p.slice(0,3).map((v,i)=>v-origin[i]);};
  let inferred=false;
  if(surface){
    if(preview.samples.length>LIMITS.samples||!preview.samples.every(p=>finitePoint(p)&&p.length===4&&Number.isFinite(p[3])&&Math.abs(p[3])<=1e9))fail('The sampled preview is invalid or exceeds the safe display limit.');
    origin=preview.samples[0].slice(0,3);
    for(const sample of preview.samples){const p=local(sample),base=local([sample[0],sample[1],sample[3]]),color=sample[2]>=sample[3]?ABOVE:BELOW;pointPositions.push(...p);pointColors.push(...color);basePositions.push(...base);segments.push(...base,...p);segmentColors.push(...color,...color);}
  }else{
    if(preview.vertices.length>LIMITS.vertices||preview.triangles.length>LIMITS.triangles||!preview.vertices.every(finitePoint)||!preview.triangles.every(t=>Array.isArray(t)&&t.length===3&&t.every(i=>Number.isSafeInteger(i)&&i>=0&&i<preview.vertices.length)))fail('The selected mesh preview is invalid or exceeds the safe display limit.');
    if(preview.inferredFaces!==undefined&&(!Array.isArray(preview.inferredFaces)||preview.inferredFaces.length>preview.triangles.length||!preview.inferredFaces.every(index=>Number.isSafeInteger(index)&&index>=0&&index<preview.triangles.length)))fail('The inferred-face preview labels are invalid.');
    origin=preview.vertices[preview.triangles[0][0]].slice(0,3);
    const inferredFaces=new Set(Array.isArray(preview.inferredFaces)?preview.inferredFaces:[]);
    preview.triangles.forEach((triangle,index)=>{const isInferred=preview.inferred===true||inferredFaces.has(index);if(isInferred)inferred=true;for(const id of triangle){meshPositions.push(...local(preview.vertices[id]));meshColors.push(...(isInferred?INFERRED:OBSERVED));}});
  }
  if(preview.referencePatches!==undefined){
    if(!Array.isArray(preview.referencePatches)||preview.referencePatches.length>LIMITS.patches||!preview.referencePatches.every(patch=>Array.isArray(patch)&&patch.length===3&&patch.every(finitePoint)))fail('Reference preview patches must be bounded triangles from the calculation base.');
    for(const patch of preview.referencePatches)for(const p of patch)referencePositions.push(...local(p));
  }
  const originCopy=[...origin],absoluteBounds={min:[...bounds.min],max:[...bounds.max]};
  bounds={min:bounds.min.map((v,i)=>v-origin[i]),max:bounds.max.map((v,i)=>v-origin[i])};
  return{kind:surface?'surface':'mesh',origin:originCopy,bounds,absoluteBounds,inferred,previewOnly:preview.previewOnly!==false,
    pointPositions:new Float32Array(pointPositions),pointColors:new Float32Array(pointColors),basePositions:new Float32Array(basePositions),segments:new Float32Array(segments),segmentColors:new Float32Array(segmentColors),meshPositions:new Float32Array(meshPositions),meshColors:new Float32Array(meshColors),referencePositions:new Float32Array(referencePositions)};
}

export function disposeMeasurementPreviewObject(object){
  const geometries=new Set(),materials=new Set();
  object?.traverse?.(node=>{if(node.geometry)geometries.add(node.geometry);for(const material of Array.isArray(node.material)?node.material:node.material?[node.material]:[])materials.add(material);});
  for(const geometry of geometries)geometry.dispose();for(const material of materials)material.dispose();
}

export function mountMeasurementRegionPreview(host,{preview,units='imperial'}={}){
  if(!host?.ownerDocument)throw new Error('A preview host is required.');
  const doc=host.ownerDocument,view=doc.defaultView||globalThis,wrapper=doc.createElement('div');
  wrapper.className='measurement-region-preview';wrapper.style.cssText='position:relative;width:100%;border:1px solid #39404b;border-radius:8px;background:#101720;overflow:hidden;margin:10px 0;';
  const viewport=doc.createElement('div');viewport.style.cssText='height:320px;min-height:220px;width:100%;position:relative;';
  const note=doc.createElement('p');note.style.cssText='font-size:12px;margin:8px 10px;color:#c6d3e0;';note.setAttribute('role','status');
  const reset=doc.createElement('button');reset.type='button';reset.textContent='Fit region';reset.style.cssText='position:absolute;right:10px;top:10px;z-index:1;';
  wrapper.append(viewport,note);viewport.append(reset);host.append(wrapper);
  let disposed=false,renderer=null,controls=null,scene=null,camera=null,group=null,observer=null,frame=null,built=null;
  const raf=callback=>(view.requestAnimationFrame?view.requestAnimationFrame(callback):setTimeout(callback,16));
  const caf=id=>(view.cancelAnimationFrame?view.cancelAnimationFrame(id):clearTimeout(id));
  function render(){frame=null;if(!disposed&&renderer&&scene&&camera)renderer.render(scene,camera);}
  function requestRender(){if(!disposed&&frame===null)frame=raf(render);}
  function resize(){if(disposed||!renderer||!camera)return;const width=Math.max(1,Math.round(viewport.clientWidth||host.clientWidth||640)),height=320;renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();requestRender();}
  function fit(){if(!built||!camera||!controls)return;const center=new THREE.Vector3(...built.bounds.min).add(new THREE.Vector3(...built.bounds.max)).multiplyScalar(.5),size=new THREE.Vector3(...built.bounds.max).sub(new THREE.Vector3(...built.bounds.min)),radius=Math.max(size.length()/2,.01),distance=radius/Math.sin(camera.fov*Math.PI/360)*1.3;camera.near=Math.max(radius/10_000,.00001);camera.far=Math.max(radius*100,100);camera.position.copy(center).add(new THREE.Vector3(1,-1,.8).normalize().multiplyScalar(distance));controls.target.copy(center);controls.minDistance=Math.max(radius/100,.001);controls.maxDistance=radius*30;camera.updateProjectionMatrix();controls.update();requestRender();}
  function geometry(positions,colors){const result=new THREE.BufferGeometry();result.setAttribute('position',new THREE.BufferAttribute(positions,3));if(colors?.length)result.setAttribute('color',new THREE.BufferAttribute(colors,3));return result;}
  function update(next,{displayUnits=units}={}){
    if(disposed)return false;
    try{
      const data=buildMeasurementPreview(next);
      if(!renderer){
        renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'});renderer.setPixelRatio(Math.min(view.devicePixelRatio||1,2));renderer.setClearColor(0x101720,1);renderer.domElement.style.cssText='width:100%;height:100%;display:block;touch-action:none;';renderer.domElement.tabIndex=0;renderer.domElement.setAttribute('aria-label','Isolated measurement region. Drag to rotate; scroll to zoom.');viewport.prepend(renderer.domElement);
        scene=new THREE.Scene();camera=new THREE.PerspectiveCamera(45,1,.001,10000);camera.up.set(0,0,1);
        scene.add(new THREE.HemisphereLight(0xffffff,0x444d60,2));const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(1,-2,3);scene.add(light);
        controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.addEventListener('change',requestRender);controls.listenToKeyEvents(renderer.domElement);
        if(view.ResizeObserver){observer=new view.ResizeObserver(resize);observer.observe(viewport);}else view.addEventListener?.('resize',resize);
        resize();
      }
      if(group){scene.remove(group);disposeMeasurementPreviewObject(group);}group=new THREE.Group();scene.add(group);built=data;units=displayUnits;
      if(data.pointPositions.length){group.add(new THREE.Points(geometry(data.pointPositions,data.pointColors),new THREE.PointsMaterial({size:3,sizeAttenuation:false,vertexColors:true})));group.add(new THREE.Points(geometry(data.basePositions),new THREE.PointsMaterial({size:2,sizeAttenuation:false,color:0xbfc5cf,transparent:true,opacity:.55})));group.add(new THREE.LineSegments(geometry(data.segments,data.segmentColors),new THREE.LineBasicMaterial({vertexColors:true,transparent:true,opacity:.24})));}
      if(data.meshPositions.length){const meshGeometry=geometry(data.meshPositions,data.meshColors);meshGeometry.computeVertexNormals();group.add(new THREE.Mesh(meshGeometry,new THREE.MeshStandardMaterial({vertexColors:true,side:THREE.DoubleSide,roughness:1,flatShading:true})));}
      if(data.referencePositions.length){const base=geometry(data.referencePositions);base.computeVertexNormals();group.add(new THREE.Mesh(base,new THREE.MeshBasicMaterial({color:0xb8bec8,side:THREE.DoubleSide,transparent:true,opacity:.25,depthWrite:false})));}
      note.textContent=`${data.kind==='surface'?'Orange: above base · Blue: below base · Gray: reference.':'Cyan: observed selected geometry.'}${data.inferred?' Pink: inferred geometry; this remains an estimate.':''} Elevation ${measurementValue(data.absoluteBounds.min[2],1,units)} to ${measurementValue(data.absoluteBounds.max[2],1,units)}. Visualization only; source calculations are unchanged. Drag to rotate; scroll to zoom.`;
      reset.hidden=false;fit();return true;
    }catch(error){if(group&&scene){scene.remove(group);disposeMeasurementPreviewObject(group);group=null;}built=null;reset.hidden=true;note.textContent=`3D region preview unavailable: ${renderer?error.message:'WebGL is unavailable or the preview data is invalid.'} Numerical results remain available.`;requestRender();return false;}
  }
  reset.onclick=fit;
  function dispose(){if(disposed)return;disposed=true;if(frame!==null)caf(frame);frame=null;observer?.disconnect();view.removeEventListener?.('resize',resize);controls?.removeEventListener('change',requestRender);controls?.dispose();if(group)disposeMeasurementPreviewObject(group);renderer?.renderLists?.dispose();renderer?.dispose();renderer?.forceContextLoss?.();wrapper.remove();renderer=null;controls=null;scene=null;camera=null;group=null;built=null;}
  update(preview);return{update,dispose,element:wrapper};
}
