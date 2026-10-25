import type { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import type { Env, StaffPrincipal } from "./types";
import { createDirectViewerClientGrant, DirectViewerGrantError, directViewerClientGrantListQuerySchema,
  listDirectViewerClientGrantWorkspace, revokeDirectViewerClientGrant } from "./viewer-direct-client-grants";
import { viewerIntegrationEnabled } from "./viewer-integration";

type App = Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>;
const key=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);
function directError(error:unknown):Response{
  if(error instanceof DirectViewerGrantError)return Response.json({error:error.message,code:error.code,
    ...(error.grantId?{grantId:error.grantId}:{})},{status:error.status,headers:{"Cache-Control":"private, no-store"}});
  throw error;
}
async function boundedJson(request:Request):Promise<unknown>{
  if(!request.body)return null;
  const reader=request.body.getReader(),chunks:Uint8Array[]=[];let total=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;
    if(total>16_384){await reader.cancel();throw new HTTPException(413,{message:"Share request is too large"});}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes));}catch{return null;}
}
export function registerDirectViewerClientRoutes(app:App):void{
  for(const path of ["/api/viewer/direct-client-grants","/api/viewer/direct-client-grants/*"])app.use(path,async(c,next)=>{
    c.header("Cache-Control","private, no-store");
    if(!viewerIntegrationEnabled(c.env)||c.env.CLIENT_VIEWER_SESSION_ISSUER_ENABLED!=="true")throw new HTTPException(404,{message:"Not found"});
    await next();
  });
  app.get("/api/viewer/direct-client-grants",async c=>{
    try{
    const queries=c.req.queries();
    if(Object.values(queries).some(values=>values.length!==1))throw new HTTPException(400,{message:"Invalid share query"});
    const parsed=directViewerClientGrantListQuerySchema.safeParse(c.req.query());
    if(!parsed.success)throw new HTTPException(400,{message:"Invalid share query"});
    return c.json(await listDirectViewerClientGrantWorkspace(c.env,c.get("principal"),parsed.data));
    }catch(error){return directError(error);}
  });
  app.post("/api/viewer/direct-client-grants",async c=>{
    try{
    const parsedKey=key.safeParse(c.req.header("Idempotency-Key"));
    if(!parsedKey.success)throw new HTTPException(400,{message:"A valid Idempotency-Key is required"});
    const result=await createDirectViewerClientGrant({env:c.env,principal:c.get("principal"),grant:await boundedJson(c.req.raw),
      idempotencyKey:parsedKey.data,request:c.req.raw});
    return c.json(result,result.replayed?200:201);
    }catch(error){return directError(error);}
  });
  app.delete("/api/viewer/direct-client-grants/:grantId",async c=>{
    try{
    const parsedKey=key.safeParse(c.req.header("Idempotency-Key"));
    const body=z.object({reason:z.string().trim().min(1).max(240).default("Revoked by staff")}).strict().safeParse(await boundedJson(c.req.raw));
    if(!parsedKey.success||!body.success)throw new HTTPException(400,{message:"Invalid share revocation"});
    const result=await revokeDirectViewerClientGrant({env:c.env,principal:c.get("principal"),grantId:c.req.param("grantId"),
      reason:body.data.reason,idempotencyKey:parsedKey.data,request:c.req.raw});
    return c.json(result,result.sessionRevocation.pending?202:200);
    }catch(error){return directError(error);}
  });
}
