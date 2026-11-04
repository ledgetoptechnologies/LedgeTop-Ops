// Site data stays local unless the operator explicitly enables aerial tiles.
export const AERIAL_TILES='https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const MAP_PAGE_SIZE=100;
export function mapPage(items,page=0) {
  const values=Array.isArray(items)?items:[],pages=Math.max(1,Math.ceil(values.length/MAP_PAGE_SIZE));
  const current=Number.isInteger(page)?Math.max(0,Math.min(page,pages-1)):0;
  return {items:values.slice(current*MAP_PAGE_SIZE,(current+1)*MAP_PAGE_SIZE),current,pages,total:values.length};
}
function position(item) {
  if(item?.latitude==null||item?.longitude==null)return null;
  if (![item.latitude,item.longitude].every(value=>typeof value==='number'||typeof value==='string'&&value.trim()!==''))return null;
  const lat=Number(item.latitude),lon=Number(item.longitude);
  return Number.isFinite(lat)&&Number.isFinite(lon)&&Math.abs(lat)<=90&&Math.abs(lon)<=180?[lat,lon]:null;
}
export function mountGcpGeographicMap({L,element,point,points=[],images=[],radiusM,onPoint,onImage,aerial=false,view=null}) {
  const center=position(point),radius=Number(radiusM);
  if(!L||!element||!center||!Number.isFinite(radius)||radius<=0)throw Error('A valid control point and radius are required');
  const map=L.map(element,{zoomControl:true,attributionControl:true,maxZoom:22});
  try {
  map.setView(center,18);
  let tiles=null,closed=false;
  function setAerial(enabled) {
    if(closed)return;
    if(enabled&&!tiles)tiles=L.tileLayer(AERIAL_TILES,{maxZoom:22,maxNativeZoom:19,attribution:'Imagery © Esri'}).addTo(map);
    else if(!enabled&&tiles){map.removeLayer(tiles);tiles=null;}
  }
  const control=L.circle(center,{radius,color:'#f57335',fillOpacity:.08,weight:2}).addTo(map);
  const bounds=L.latLngBounds(control.getBounds());
  function marker(item,kind,selected,callback) {
    const raw=position(item);if(!raw)return;
    // Keep nearby points together across the antimeridian rather than fitting
    // a near-global span when the two longitudes straddle ±180 degrees.
    const pos=[raw[0],center[1]+((raw[1]-center[1]+540)%360)-180];
    const label=kind==='point'?(item.label||item.externalId||'Control point'):(String(item.relativePath||'Photo').split('/').at(-1));
    const icon=L.divIcon({className:`gcp-geo-icon gcp-geo-${kind}${selected?' selected':''}`,html:'<span aria-hidden="true"></span>',iconSize:[20,20],iconAnchor:[10,10]});
    const m=L.marker(pos,{icon,keyboard:true,title:String(label),alt:String(label)}).addTo(map);
    m.on('click',()=>callback?.(item.id));
    const node=m.getElement?.();if(node){node.setAttribute('aria-label',`${kind==='point'?'Select control point':'Open photo'} ${label}`);node.setAttribute('role','button');node.addEventListener('keydown',event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();event.stopPropagation();callback?.(item.id)}});}
    if(kind==='camera')bounds.extend(pos);
  }
  for(const p of points)marker(p,'point',p.id===point.id,onPoint);
  for(const image of images)marker(image,'camera',false,onImage);
  if(view&&Array.isArray(view.center)&&view.center.length===2&&view.center.every(Number.isFinite)&&Number.isFinite(view.zoom))map.setView(view.center,view.zoom);
  else map.fitBounds(bounds.pad(.15),{maxZoom:20});
  setAerial(aerial);
  return Object.freeze({setAerial,getView(){const center=map.getCenter();return {center:[center.lat,center.lng],zoom:map.getZoom()}},resize(){if(!closed)map.invalidateSize()},close(){if(!closed){closed=true;map.remove()}}});
  } catch(error) {map.remove();throw error;}
}
