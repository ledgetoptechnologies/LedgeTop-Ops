import * as THREE from 'three';

// One view-only half-space in the centered Y-up render frame. Never passed to
// measurement documents or source calculators. Northing increases toward -Z.
const axes = {elevation:[0,1,0],easting:[1,0,0],northing:[0,0,-1]};
export function slicePlane(bounds,{axis='elevation',fraction=.5,flipped=false}={}) {
  if(!axes[axis]||!Number.isFinite(fraction)||!bounds||bounds.isEmpty()||![...bounds.min.toArray(),...bounds.max.toArray()].every(Number.isFinite))throw new Error('A finite data extent and slice position are required.');
  const normal=new THREE.Vector3(...axes[axis]),lo=Math.min(normal.dot(bounds.min),normal.dot(bounds.max)),hi=Math.max(normal.dot(bounds.min),normal.dot(bounds.max));
  const position=lo+(hi-lo)*Math.max(0,Math.min(1,fraction));
  const plane=new THREE.Plane(normal,-position);
  if(flipped)plane.negate();
  return plane;
}

export function createViewerSlice({renderer,scene,panel,getRoots,getBounds,supported=()=>true,describe=()=>''}) {
  const plane=new THREE.Plane(),helper=new THREE.PlaneHelper(plane,1,0xffa13e),original=new WeakMap();
  helper.visible=false;scene.add(helper);renderer.localClippingEnabled=true;
  let settings={enabled:false,axis:'elevation',fraction:.5,flipped:false};
  const listeners=[];
  const field=name=>panel.querySelector(`[data-slice="${name}"]`);
  const status=field('status');
  function visit(root,enabled){root?.traverse(object=>{
    if(!object.isMesh&&!object.isPoints)return;
    for(const material of Array.isArray(object.material)?object.material:[object.material]){
      if(!material)continue;
      if(enabled){
        if(material.clippingPlanes?.includes(plane))continue;
        if(!original.has(material))original.set(material,{planes:material.clippingPlanes,intersection:material.clipIntersection});
        const saved=original.get(material);material.clippingPlanes=[...(saved.planes||[]),plane];material.clipIntersection=false;material.needsUpdate=true;
      }else if(original.has(material)){
        const saved=original.get(material);material.clippingPlanes=saved.planes;material.clipIntersection=saved.intersection;material.needsUpdate=true;original.delete(material);
      }
    }
  });}
  function refresh({updateMaterials=true}={}){
    const bounds=getBounds(),available=supported(),ready=available&&bounds&&!bounds.isEmpty();
    if(!ready)settings.enabled=false;
    if(ready){plane.copy(slicePlane(bounds,settings));helper.size=Math.max(1,bounds.getSize(new THREE.Vector3()).length());}
    if(updateMaterials)for(const root of getRoots())visit(root,settings.enabled);
    helper.visible=Boolean(ready&&settings.enabled);
    field('enabled').checked=settings.enabled;field('enabled').disabled=!ready;
    for(const name of ['axis','position','flip'])field(name).disabled=!ready||!settings.enabled;
    field('axis').value=settings.axis;field('position').value=String(settings.fraction*100);field('flip').setAttribute('aria-pressed',String(settings.flipped));
    status.textContent=!available?'Slicing is not available for this streamed point-cloud view.':!ready?'Load a 3D surface to use the slice.':settings.enabled?`${describe(plane,settings.axis)} · ${settings.flipped?'lower':'higher'} coordinates retained.`:'Slicing off. The whole surface is visible.';
  }
  function set(changes){settings={...settings,...changes};refresh();}
  function reset(){settings={enabled:false,axis:'elevation',fraction:.5,flipped:false};refresh();}
  function bind(name,event,callback){const element=field(name);element.addEventListener(event,callback);listeners.push(()=>element.removeEventListener?.(event,callback));}
  bind('enabled','change',()=>set({enabled:field('enabled').checked}));
  bind('axis','change',()=>set({axis:field('axis').value}));
  bind('position','input',()=>set({fraction:Number(field('position').value)/100}));
  bind('flip','click',()=>set({flipped:!settings.flipped}));
  bind('reset','click',reset);
  refresh();
  return {refresh,reset,set,register:root=>visit(root,settings.enabled),accepts:point=>!settings.enabled||plane.distanceToPoint(point)>=-1e-7,
    get active(){return settings.enabled;},get plane(){return plane.clone();},
    dispose(){reset();for(const remove of listeners)remove();helper.removeFromParent();helper.dispose();}};
}
