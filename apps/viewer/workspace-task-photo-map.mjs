import {parsePhotoExif,PHOTO_HEADER_BYTES as HEADER_BYTES} from './server/photoExif.mjs';
export {parsePhotoExif} from './server/photoExif.mjs';
const MAX_FILES=20_000;
const abort=()=>{throw new DOMException('Photo preview cancelled','AbortError');};
function check(signal){if(signal?.aborted)abort();}


export async function scanPhotoLocations(files,{signal,onProgress=()=>{},onLocations=async()=>{},maxFiles=MAX_FILES,yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0))}={}){
  const list=Array.from(files||[]),limit=Math.min(MAX_FILES,Math.max(0,Number.isSafeInteger(maxFiles)?maxFiles:MAX_FILES)),selected=list.slice(0,limit),locations=[];
  let missingGps=0,pending=[];
  for(let index=0;index<selected.length;index++){
    check(signal);const file=selected[index];let location=null;
    try{if(/\.jpe?g$/i.test(file.name||'')){const bytes=await file.slice(0,HEADER_BYTES).arrayBuffer();check(signal);location=parsePhotoExif(bytes);}}catch(error){if(signal?.aborted||error?.name==='AbortError')throw error;}
    if(location){const point={...location,name:String(file.webkitRelativePath||file.name||'Photo')};locations.push(point);pending.push(point);}else missingGps++;
    // Fit the first valid photo immediately; subsequent markers arrive in
    // bounded batches rather than waiting for every header to be read.
    if(pending.length&&(locations.length===1||(index+1)%32===0)){await onLocations(pending);pending=[];check(signal);}
    if((index+1)%32===0){onProgress({processed:index+1,total:selected.length,located:locations.length,missingGps,omitted:list.length-selected.length});await yieldTask();check(signal);}
  }
  check(signal);if(pending.length){await onLocations(pending);check(signal);}const result={locations,processed:selected.length,total:selected.length,missingGps,omitted:list.length-selected.length};onProgress({...result,located:locations.length});return result;
}

export function mountPhotoMap(container,{loadLeaflet=()=>import('leaflet')}={}){
  const doc=container.ownerDocument,summary=doc.createElement('p'),surface=doc.createElement('div');
  summary.className='form-note';summary.setAttribute('role','status');summary.textContent='Select photos to preview recorded GPS positions.';
  surface.style.cssText='height:clamp(260px,38vh,430px);min-height:230px;border:1px solid #38424d;border-radius:8px;background:#17212c;';surface.setAttribute('aria-label','Photo GPS positions');
  container.append(summary,surface);let map=null,layer=null,disposed=false,generation=0,controller=null,followPhotos=true;
  const stopFollowing=()=>{followPhotos=false;};
  const interactionEvents=['pointerdown','wheel','keydown'];
  for(const event of interactionEvents)surface.addEventListener(event,stopFollowing,{passive:true});
  const ready=loadLeaflet().then(async module=>{
    if(disposed)return;const L=module.default||module;
    if(typeof window!=='undefined')await import('leaflet/dist/leaflet.css');
    if(disposed)return;
    // Leaflet 1.9 may synchronously redraw during fitBounds/resize while an
    // earlier animation-frame redraw is queued, losing the queued frame ID.
    // Its normal removal cancellation cannot cancel that orphaned callback.
    // Keep this lifecycle guard local to the preview renderer, not Leaflet's
    // global prototype; a late callback must never touch a removed canvas.
    const PreviewCanvas=L.Canvas?.extend({
      onAdd(...args){this.previewRemoved=false;return L.Canvas.prototype.onAdd.apply(this,args);},
      onRemove(...args){this.previewRemoved=true;return L.Canvas.prototype.onRemove.apply(this,args);},
      _redraw(...args){if(this.previewRemoved)return;return L.Canvas.prototype._redraw.apply(this,args);},
    });
    map=L.map(surface,{preferCanvas:true,...(PreviewCanvas?{renderer:new PreviewCanvas()}:{}),attributionControl:true,scrollWheelZoom:false}).setView([0,0],2);
    // Reuse the Viewer basemap host and anonymous CORS policy. Imagery is
    // visual context only: photo positions still come from recorded EXIF.
    const imagery=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
      crossOrigin:'anonymous',maxZoom:22,maxNativeZoom:19,
      attribution:'Tiles © Esri — Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    });
    imagery.addTo(map);
    L.control.layers({'Satellite imagery':imagery,'No basemap':L.layerGroup()},null,{collapsed:true}).addTo(map);
    layer=L.featureGroup().addTo(map);return L;
  }).catch(()=>{if(!disposed)summary.textContent='Photo map unavailable. Your selected photos are unchanged.';return null;});
  async function appendLocations(locations,epoch,signal){
    const L=await ready;check(signal);if(disposed||epoch!==generation)return null;
    if(L){for(let i=0;i<locations.length;i++){
      check(signal);if(disposed||epoch!==generation)return null;const item=locations[i],label=doc.createElement('span');label.textContent=`${item.name}${item.trueHeading===null?' · Heading not recorded':` · Heading ${item.trueHeading.toFixed(1)}° true`}`;
      L.circleMarker([item.latitude,item.longitude],{radius:4,color:'#ff7417',weight:1,fillColor:'#ff7417',fillOpacity:.75}).bindTooltip(label).addTo(layer);
      if((i+1)%128===0){await new Promise(resolve=>setTimeout(resolve,0));check(signal);}
    }if(locations.length&&followPhotos)map.fitBounds(layer.getBounds(),{padding:[20,20],maxZoom:18,animate:false});map.invalidateSize();}
    return L;
  }
  async function render(result,epoch,signal,{alreadyAdded=false}={}){
    const L=alreadyAdded?await ready:await appendLocations(result.locations,epoch,signal);check(signal);if(disposed||epoch!==generation)return null;
    summary.textContent=`${L?'':'Map unavailable. '}${result.locations.length.toLocaleString()} ${result.locations.length===1?'photo':'photos'} located · ${result.missingGps.toLocaleString()} without readable GPS${result.omitted?` · ${result.omitted.toLocaleString()} not scanned (preview limit)`:''}. Recorded true heading appears on hover. Satellite imagery is background context, not your survey. No flight paths are inferred.`;return result;
  }
  return {
    async setLocations(preview,{signal}={}){
      if(disposed)return null;const epoch=++generation;controller?.abort();controller=new AbortController();const local=controller,cancel=()=>local.abort();
      signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)local.abort();layer?.clearLayers();followPhotos=true;
      const points=Array.isArray(preview?.points)?preview.points:[],locations=points.slice(0,MAX_FILES).filter(p=>Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&Math.abs(p.latitude)<=90&&Math.abs(p.longitude)<=180).map(p=>({latitude:p.latitude,longitude:p.longitude,name:String(p.name||'Photo'),trueHeading:Number.isFinite(p.trueHeading)&&p.trueHeading>=0&&p.trueHeading<360?p.trueHeading:null}));
      const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
      try{return await render({locations,missingGps:count(preview?.missingGpsCount),omitted:count(preview?.unscannedCount)+Math.max(0,points.length-MAX_FILES)},epoch,local.signal);}catch{return null;}finally{signal?.removeEventListener('abort',cancel);}
    },
    async setFiles(files,{signal}={}){
      if(disposed)return null;
      const epoch=++generation;controller?.abort();controller=new AbortController();const local=controller;
      const cancel=()=>local.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)local.abort();
      layer?.clearLayers();followPhotos=true;summary.textContent='Reading local photo GPS metadata…';
      try{
        const result=await scanPhotoLocations(files,{signal:local.signal,onLocations:points=>appendLocations(points,epoch,local.signal),onProgress:p=>{if(!disposed&&epoch===generation)summary.textContent=`Reading photo locations: ${p.processed.toLocaleString()} / ${p.total.toLocaleString()}`;}});
        return await render(result,epoch,local.signal,{alreadyAdded:true});
      }catch(error){if(error?.name!=='AbortError'&&!disposed&&epoch===generation)summary.textContent='Photo GPS preview unavailable. Your selected photos are unchanged.';return null;}
      finally{signal?.removeEventListener('abort',cancel);}
    },
    dispose(){
      if(disposed)return;disposed=true;generation++;controller?.abort();
      // Remove paths while their renderer still owns its canvas. Map.remove()
      // may otherwise destroy the renderer first; later path removals schedule
      // another redraw against its already-disposed context (Leaflet 1.9).
      for(const event of interactionEvents)surface.removeEventListener(event,stopFollowing);
      layer?.clearLayers();map?.remove();container.replaceChildren();
    },
  };
}
