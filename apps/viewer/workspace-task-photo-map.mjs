import {parsePhotoExif,PHOTO_HEADER_BYTES as HEADER_BYTES} from './server/photoExif.mjs';
export {parsePhotoExif} from './server/photoExif.mjs';
const MAX_FILES=20_000;
const abort=()=>{throw new DOMException('Photo preview cancelled','AbortError');};
function check(signal){if(signal?.aborted)abort();}
const fileOrder=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});

// Path order for the preview line: EXIF capture time when every located photo
// has one, otherwise file name order. Ties keep selection order.
export function orderPhotoPath(points){
  const list=(Array.isArray(points)?points:[]).map((point,index)=>({point,index}));
  const timed=list.length>0&&list.every(({point})=>typeof point.capturedAt==='string'&&point.capturedAt);
  list.sort((a,b)=>(timed?(a.point.capturedAt<b.point.capturedAt?-1:a.point.capturedAt>b.point.capturedAt?1:0):fileOrder.compare(String(a.point.name||''),String(b.point.name||'')))||a.index-b.index);
  return list.map(item=>item.point);
}

// Ctrl (or a pinch, which browsers report as Ctrl+wheel) zooms the map; a
// plain wheel is left alone so the page keeps scrolling.
export function wheelZoomStep(event,state={accumulated:0}){
  if(!event?.ctrlKey)return 0;
  const scale=event.deltaMode===1?40:event.deltaMode===2?800:1;
  state.accumulated+=Number(event.deltaY||0)*scale;
  if(Math.abs(state.accumulated)<50)return 0;
  const step=state.accumulated>0?-1:1;state.accumulated=0;return step;
}

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

const ICONS={download:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m-5-5 5 5 5-5M5 20h14" fill="none" stroke="currentColor" stroke-width="2"/></svg>',crop:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6l13-1 1 12-9 2z" fill="none" stroke="currentColor" stroke-width="2"/></svg>',fit:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>'};

export function mountPhotoMap(container,{loadLeaflet=()=>import('leaflet'),onBoundary=null}={}){
  const doc=container.ownerDocument,summary=doc.createElement('p'),surface=doc.createElement('div');
  summary.className='photo-map-summary';summary.setAttribute('role','status');summary.textContent='Reading photo locations…';
  surface.className='photo-map-surface';surface.setAttribute('aria-label','Photo GPS positions. Hold Ctrl and scroll to zoom.');
  container.append(summary,surface);let map=null,layer=null,path=null,boundaryLayer=null,disposed=false,generation=0,controller=null,followPhotos=true,all=[],Lref=null,drawing=null,cropButton=null;
  const stopFollowing=()=>{followPhotos=false;};
  const wheelState={accumulated:0};
  const onWheel=event=>{
    if(!event.ctrlKey||!map)return;
    event.preventDefault();followPhotos=false;
    const step=wheelZoomStep(event,wheelState);
    if(step)map.setZoomAround(map.mouseEventToContainerPoint(event),map.getZoom()+step);
  };
  const interactionEvents=['pointerdown','keydown'];
  for(const event of interactionEvents)surface.addEventListener(event,stopFollowing,{passive:true});
  surface.addEventListener('wheel',onWheel,{passive:false});
  function downloadPositions(){
    const ordered=orderPhotoPath(all),features=ordered.map(item=>({type:'Feature',properties:{name:item.name,...(item.capturedAt?{capturedAt:item.capturedAt}:{})},geometry:{type:'Point',coordinates:[item.longitude,item.latitude]}}));
    if(ordered.length>1)features.push({type:'Feature',properties:{name:'Capture order'},geometry:{type:'LineString',coordinates:ordered.map(item=>[item.longitude,item.latitude])}});
    const view=doc.defaultView,url=view.URL.createObjectURL(new view.Blob([JSON.stringify({type:'FeatureCollection',features})],{type:'application/geo+json'})),link=doc.createElement('a');
    link.href=url;link.download='photo-positions.geojson';doc.body.append(link);link.click();link.remove();view.setTimeout(()=>view.URL.revokeObjectURL(url),1000);
  }
  function finishBoundary(){
    if(!drawing)return;const vertices=drawing.vertices;stopDrawing();
    if(vertices.length<3)return;
    const ring=[...vertices,vertices[0]].map(([lat,lng])=>[Number(lng.toFixed(7)),Number(lat.toFixed(7))]);
    boundaryLayer=Lref.polygon(vertices,{color:'#f8cb2e',weight:2,fillOpacity:.08,interactive:false}).addTo(map);
    onBoundary({type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[ring]}}]});
  }
  function stopDrawing(){if(!drawing)return;map.off('click',drawing.click);map.off('dblclick',drawing.finish);drawing.preview.remove();map.doubleClickZoom?.enable();surface.removeEventListener('keydown',drawing.key);drawing=null;cropButton?.setAttribute('aria-pressed','false');surface.classList?.remove('photo-map-drawing');}
  function toggleCrop(){
    if(drawing){stopDrawing();return;}
    if(boundaryLayer){boundaryLayer.remove();boundaryLayer=null;cropButton.setAttribute('aria-pressed','false');onBoundary(null);return;}
    const preview=Lref.polyline([],{color:'#f8cb2e',weight:2,dashArray:'4 4',interactive:false}).addTo(map);
    drawing={vertices:[],preview,click:event=>{drawing.vertices.push([event.latlng.lat,event.latlng.lng]);preview.setLatLngs(drawing.vertices);},finish:()=>finishBoundary(),key:event=>{if(event.key==='Enter'){event.preventDefault();finishBoundary();}else if(event.key==='Escape'){event.preventDefault();stopDrawing();}}};
    map.doubleClickZoom?.disable();map.on('click',drawing.click);map.on('dblclick',drawing.finish);surface.addEventListener('keydown',drawing.key);
    cropButton.setAttribute('aria-pressed','true');surface.classList?.add('photo-map-drawing');
  }
  function toolButton(L,bar,name,label,handler){const button=L.DomUtil.create('a','photo-map-tool',bar);button.href='#';button.setAttribute('role','button');button.title=label;button.setAttribute('aria-label',label);button.dataset.mapTool=name;button.innerHTML=ICONS[name];L.DomEvent.on(button,'click',event=>{L.DomEvent.preventDefault(event);L.DomEvent.stopPropagation(event);handler();});return button;}
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
    map=L.map(surface,{preferCanvas:true,...(PreviewCanvas?{renderer:new PreviewCanvas()}:{}),attributionControl:true,zoomControl:false,scrollWheelZoom:false}).setView([0,0],2);
    // Reuse the Viewer basemap host and anonymous CORS policy. Imagery is
    // visual context only: photo positions still come from recorded EXIF.
    const imagery=L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
      crossOrigin:'anonymous',maxZoom:22,maxNativeZoom:19,
      attribution:'Tiles © Esri — Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    });
    imagery.addTo(map);
    if(L.Control&&L.DomUtil&&L.DomEvent){
      const Tools=L.Control.extend({options:{position:'topleft'},onAdd(){
        const bar=L.DomUtil.create('div','leaflet-bar photo-map-tools');L.DomEvent.disableClickPropagation(bar);
        toolButton(L,bar,'download','Download photo positions',downloadPositions);
        if(onBoundary)cropButton=toolButton(L,bar,'crop','Draw processing boundary',toggleCrop);
        toolButton(L,bar,'fit','Fit to photos',()=>{const bounds=layer?.getBounds();if(bounds?.isValid?.()!==false&&all.length)map.fitBounds(bounds,{padding:[20,20],maxZoom:18});});
        return bar;}});
      new Tools().addTo(map);
    }
    L.control.zoom?.({position:'topleft'})?.addTo(map);
    L.control.layers({'Satellite imagery':imagery,'No basemap':L.layerGroup()},null,{collapsed:true,position:'topright'}).addTo(map);
    layer=L.featureGroup().addTo(map);Lref=L;return L;
  }).catch(()=>{if(!disposed)summary.textContent='Photo map unavailable';return null;});
  function drawPath(L){
    if(!L.polyline)return;const ordered=orderPhotoPath(all).map(item=>[item.latitude,item.longitude]);
    if(!path){if(ordered.length<2)return;path=L.polyline(ordered,{color:'#f8cb2e',weight:1.5,opacity:.85,interactive:false}).addTo(layer);}
    else path.setLatLngs(ordered);
  }
  async function appendLocations(locations,epoch,signal){
    const L=await ready;check(signal);if(disposed||epoch!==generation)return null;
    if(L){for(let i=0;i<locations.length;i++){
      check(signal);if(disposed||epoch!==generation)return null;const item=locations[i],label=doc.createElement('span');label.textContent=`${item.name}${item.trueHeading===null?' · Heading not recorded':` · Heading ${item.trueHeading.toFixed(1)}° true`}`;
      L.circleMarker([item.latitude,item.longitude],{radius:4,color:'#ff7417',weight:1,fillColor:'#ff7417',fillOpacity:.75}).bindTooltip(label).addTo(layer);all.push(item);
      if((i+1)%128===0){await new Promise(resolve=>setTimeout(resolve,0));check(signal);}
    }drawPath(L);if(locations.length&&followPhotos)map.fitBounds(layer.getBounds(),{padding:[20,20],maxZoom:18,animate:false});map.invalidateSize();}
    return L;
  }
  async function render(result,epoch,signal,{alreadyAdded=false}={}){
    const L=alreadyAdded?await ready:await appendLocations(result.locations,epoch,signal);check(signal);if(disposed||epoch!==generation)return null;
    summary.textContent=`${L?'':'Map unavailable · '}${result.locations.length.toLocaleString()} ${result.locations.length===1?'photo':'photos'} located${result.missingGps?` · ${result.missingGps.toLocaleString()} without GPS`:''}${result.omitted?` · ${result.omitted.toLocaleString()} not scanned`:''}`;return result;
  }
  function clear(){stopDrawing();layer?.clearLayers();path=null;all=[];followPhotos=true;}
  return {
    async setLocations(preview,{signal}={}){
      if(disposed)return null;const epoch=++generation;controller?.abort();controller=new AbortController();const local=controller,cancel=()=>local.abort();
      signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)local.abort();clear();
      const points=Array.isArray(preview?.points)?preview.points:[],locations=points.slice(0,MAX_FILES).filter(p=>Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&Math.abs(p.latitude)<=90&&Math.abs(p.longitude)<=180).map(p=>({latitude:p.latitude,longitude:p.longitude,name:String(p.name||'Photo'),trueHeading:Number.isFinite(p.trueHeading)&&p.trueHeading>=0&&p.trueHeading<360?p.trueHeading:null,...(typeof p.capturedAt==='string'&&p.capturedAt.length<=40?{capturedAt:p.capturedAt}:{})}));
      const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
      try{return await render({locations,missingGps:count(preview?.missingGpsCount),omitted:count(preview?.unscannedCount)+Math.max(0,points.length-MAX_FILES)},epoch,local.signal);}catch{return null;}finally{signal?.removeEventListener('abort',cancel);}
    },
    async setFiles(files,{signal}={}){
      if(disposed)return null;
      const epoch=++generation;controller?.abort();controller=new AbortController();const local=controller;
      const cancel=()=>local.abort();signal?.addEventListener('abort',cancel,{once:true});if(signal?.aborted)local.abort();
      clear();summary.textContent='Reading photo locations…';
      try{
        const result=await scanPhotoLocations(files,{signal:local.signal,onLocations:points=>appendLocations(points,epoch,local.signal),onProgress:p=>{if(!disposed&&epoch===generation)summary.textContent=`Reading photo locations: ${p.processed.toLocaleString()} / ${p.total.toLocaleString()}`;}});
        return await render(result,epoch,local.signal,{alreadyAdded:true});
      }catch(error){if(error?.name!=='AbortError'&&!disposed&&epoch===generation)summary.textContent='Photo GPS preview unavailable';return null;}
      finally{signal?.removeEventListener('abort',cancel);}
    },
    clearBoundary(){boundaryLayer?.remove();boundaryLayer=null;cropButton?.setAttribute('aria-pressed','false');},
    dispose(){
      if(disposed)return;disposed=true;generation++;controller?.abort();
      // Remove paths while their renderer still owns its canvas. Map.remove()
      // may otherwise destroy the renderer first; later path removals schedule
      // another redraw against its already-disposed context (Leaflet 1.9).
      for(const event of interactionEvents)surface.removeEventListener(event,stopFollowing);
      surface.removeEventListener('wheel',onWheel);
      if(map)stopDrawing();boundaryLayer?.remove();layer?.clearLayers();map?.remove();container.replaceChildren();
    },
  };
}
