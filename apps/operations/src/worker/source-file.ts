import { HTTPException } from "hono/http-exception";
import { isMovedSourceMarker } from "@ltds/shared";
import { mediaKind, mime } from "./delivery";

type ByteRange={offset:number;length:number};

interface SourceObjectHead{
  size:number;
  httpEtag:string;
  customMetadata?:Record<string,string>;
}

interface SourceObjectBody{
  body:BodyInit|null;
}

export interface SourceBucket{
  head(key:string):Promise<SourceObjectHead|null>;
  get(key:string,options?:{range:ByteRange}):Promise<SourceObjectBody|null>;
}

export interface SourceFileRequest{
  method:string;
  header(name:string):string|undefined;
}

function range(value:string|undefined,size:number):ByteRange|undefined{
  if(!value)return undefined;
  const match=/^bytes=(\d*)-(\d*)$/.exec(value);
  if(!match||value.includes(",")||(!match[1]&&!match[2]))throw new HTTPException(416);
  if(!match[1]){
    const suffix=Number(match[2]);
    if(!Number.isSafeInteger(suffix)||suffix<=0)throw new HTTPException(416);
    return{offset:Math.max(0,size-suffix),length:Math.min(size,suffix)};
  }
  const start=Number(match[1]),end=match[2]?Number(match[2]):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||start>=size)throw new HTTPException(416);
  return{offset:start,length:Math.min(end,size-1)-start+1};
}

function matchesEtag(value:string|undefined,current:string):boolean{
  if(!value)return false;
  const clean=(etag:string)=>etag.trim().replace(/^W\//,"").replace(/^"|"$/g,"");
  const expected=clean(current);
  return value.split(",").some(candidate=>candidate.trim()==="*"||clean(candidate)===expected);
}

export async function serveSourceFile(
  bucket:SourceBucket,
  key:string,
  request:SourceFileRequest,
  disposition:"inline"|"attachment",
  expectedEtag?:string,
):Promise<Response>{
  const head=await bucket.head(key);
  if(!head||isMovedSourceMarker(head))throw new HTTPException(404,{message:"File not found"});
  if(expectedEtag&&head.httpEtag!==expectedEtag)throw new HTTPException(409,{message:"File content no longer matches its audited version"});

  let requested:ByteRange|undefined;
  const rangeHeader=request.header("Range"),ifRange=request.header("If-Range");
  try{
    requested=range(!ifRange||matchesEtag(ifRange,head.httpEtag)?rangeHeader:undefined,head.size);
  }catch{
    return new Response(null,{status:416,headers:{"Content-Range":`bytes */${head.size}`,"Accept-Ranges":"bytes"}});
  }

  const headers=new Headers();
  headers.set("Content-Type",mime(key));
  headers.set("Content-Disposition",`${disposition}; filename="${(key.split("/").pop()||"file").replace(/[\0-\x1f\x7f"\\]/g,"_")}"`);
  headers.set("ETag",head.httpEtag);
  headers.set("Accept-Ranges","bytes");
  headers.set("Cache-Control","private, no-store");
  headers.set("X-Content-Type-Options","nosniff");
  headers.set("Content-Length",String(requested?.length||head.size));
  if(requested)headers.set("Content-Range",`bytes ${requested.offset}-${requested.offset+requested.length-1}/${head.size}`);
  if(!requested&&disposition==="inline"&&matchesEtag(request.header("If-None-Match"),head.httpEtag)){
    headers.delete("Content-Length");
    return new Response(null,{status:304,headers});
  }
  if(request.method==="HEAD")return new Response(null,{status:requested?206:200,headers});
  const object=await bucket.get(key,requested?{range:requested}:undefined);
  if(!object)throw new HTTPException(404,{message:"File not found"});
  return new Response(object.body,{status:requested?206:200,headers});
}

export function servePdfSourceFile(bucket:SourceBucket,key:string,request:SourceFileRequest):Promise<Response>{
  if(mediaKind(key)!=="pdf")throw new HTTPException(415,{message:"PDF viewer unavailable"});
  return serveSourceFile(bucket,key,request,"inline");
}
