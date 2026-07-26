export const DELIVERY_ROOT_PREFIX="Jobs/Clients/";

function validSegment(value:string):boolean{
  const reserved=value.toLowerCase();
  return Boolean(value&&value!=="."&&value!==".."&&!/[\/\\\u0000-\u001f\u007f]/.test(value)&&reserved!=="dump"&&reserved!=="_ltds"&&reserved!==".previews");
}

export function prefixFromDeliveryPath(pathname:string):string{
  const raw=pathname.split("?")[0]!.split("#")[0]!;
  const parts=raw.split("/").filter(Boolean);
  if(parts[0]!=="delivery"||parts.length===1)return DELIVERY_ROOT_PREFIX;
  try{
    const decoded=parts.slice(1).map(decodeURIComponent);
    if(decoded.some(segment=>!validSegment(segment)))return DELIVERY_ROOT_PREFIX;
    return `${DELIVERY_ROOT_PREFIX}${decoded.join("/")}/`;
  }catch{return DELIVERY_ROOT_PREFIX}
}

export function deliveryPathFromPrefix(prefix:string):string{
  const normalized=prefix.replace(/\\/g,"/").replace(/\/{2,}/g,"/").replace(/\/+$/,"")+"/";
  if(!normalized.startsWith(DELIVERY_ROOT_PREFIX))return"/delivery";
  const relative=normalized.slice(DELIVERY_ROOT_PREFIX.length).replace(/\/$/,"");
  if(!relative)return"/delivery";
  const segments=relative.split("/");
  if(segments.some(segment=>!validSegment(segment)))return"/delivery";
  return `/delivery/${segments.map(encodeURIComponent).join("/")}`;
}
