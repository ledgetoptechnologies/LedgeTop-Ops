import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createNativeDeliveryGrant, listNativeDeliveryGrants, previewNativeDeliveryGrant, revokeNativeDeliveryGrant,
  searchNativeDeliveryRecipients, searchNativeDeliveryTargets } from './native-delivery-bindings';
import { requireMutationSecurity } from './request-security';
import type { Env, StaffPrincipal } from './types';

type App=Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>;
async function body(request:Request):Promise<unknown>{
  if(request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='application/json')
    throw new HTTPException(415,{message:'native_delivery_json_required'});
  if(!request.body)throw new HTTPException(400,{message:'native_delivery_invalid'});
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0,timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=Date.now()+5000;
  try{await Promise.race([(async()=>{while(true){if(Date.now()>=deadline)throw new HTTPException(408,{message:'native_delivery_body_timeout'});
    const item=await reader.read();if(item.done)return;size+=item.value.byteLength;
    if(size>8192)throw new HTTPException(413,{message:'native_delivery_body_too_large'});if(item.value.byteLength)chunks.push(item.value);}})(),
    new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new HTTPException(408,{message:'native_delivery_body_timeout'})),5000);})]);
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
    try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}catch{throw new HTTPException(400,{message:'native_delivery_invalid'});}
  }finally{if(timer!==undefined)clearTimeout(timer);let cancelTimer:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([reader.cancel().catch(()=>undefined),new Promise<void>(resolve=>{cancelTimer=setTimeout(resolve,50);})]);
    if(cancelTimer!==undefined)clearTimeout(cancelTimer);reader.releaseLock();}
}
function query(url:URL,keys:string[]):Record<string,string>{const values:Record<string,string>={};
  for(const key of url.searchParams.keys())if(!keys.includes(key)||url.searchParams.getAll(key).length!==1)throw new HTTPException(400,{message:'native_delivery_invalid'});
  for(const key of keys){const value=url.searchParams.get(key);if(value===null||value.length>1400)throw new HTTPException(400,{message:'native_delivery_invalid'});values[key]=value;}
  return values;}
/** The application's staff authentication remains mandatory. Mutation security
 * is also enforced here so mounting this adapter cannot omit origin/CSRF. */
export function registerNativeDeliveryBindingRoutes(app:App):void{
  const base='/api/delivery/native-grants';
  app.use(base,async(c,next)=>{c.header('Cache-Control','no-store');await next();});
  app.use(`${base}/*`,async(c,next)=>{c.header('Cache-Control','no-store');await next();});
  app.get(`${base}/targets`,async c=>{const q=query(new URL(c.req.url),['folderRef','q']);return c.json(await searchNativeDeliveryTargets(c.env,c.get('principal'),q.folderRef!,q.q!));});
  app.get(`${base}/recipients`,async c=>{const q=query(new URL(c.req.url),['folderRef','sourceId','workspaceId','projectId','q']);
    return c.json(await searchNativeDeliveryRecipients(c.env,c.get('principal'),{folderRef:q.folderRef!,sourceId:q.sourceId!,workspaceId:q.workspaceId!,projectId:q.projectId!,q:q.q!}));});
  app.get(base,async c=>{const q=query(new URL(c.req.url),['folderRef']);return c.json(await listNativeDeliveryGrants(c.env,c.get('principal'),q.folderRef!));});
  app.post(`${base}/preview`,async c=>{await requireMutationSecurity(c.req.raw,c.env,c.get('principal'));
    return c.json({preview:await previewNativeDeliveryGrant(c.env,c.get('principal'),await body(c.req.raw))});});
  app.post(base,async c=>{await requireMutationSecurity(c.req.raw,c.env,c.get('principal'));
    return c.json(await createNativeDeliveryGrant(c.env,c.get('principal'),await body(c.req.raw),c.req.header('Idempotency-Key')??''));});
  app.post(`${base}/:grantId/revoke`,async c=>{await requireMutationSecurity(c.req.raw,c.env,c.get('principal'));
    return c.json(await revokeNativeDeliveryGrant(c.env,c.get('principal'),c.req.param('grantId'),await body(c.req.raw),c.req.header('Idempotency-Key')??''));});
}
