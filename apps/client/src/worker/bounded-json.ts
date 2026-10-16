import { HTTPException } from 'hono/http-exception';
/** Enforce the byte limit while reading, including chunked requests. */
export async function readBoundedClientJson(request:Request,maximumBytes:number):Promise<unknown>{
 const declared=request.headers.get('Content-Length');
 if(declared!==null){const length=Number(declared);if(!Number.isSafeInteger(length)||length<0)throw new HTTPException(400);
  if(length>maximumBytes)throw new HTTPException(413);}
 if(!request.body)throw new HTTPException(400);
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;
  if(size>maximumBytes){await reader.cancel();throw new HTTPException(413);}chunks.push(value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new HTTPException(400);}
}
