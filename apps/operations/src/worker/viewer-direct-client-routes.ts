import type { Hono } from "hono";
import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import type { Env, StaffPrincipal } from "./types";
import { sqlScope } from "./acl";
import { ViewerServiceError } from "@ltds/shared";
import { createDirectViewerClientGrant, DirectViewerGrantError, directViewerClientGrantListQuerySchema,
  listDirectViewerClientGrantWorkspace, revokeDirectViewerClientGrant } from "./viewer-direct-client-grants";
import { viewerIntegrationEnabled, viewerServiceClient } from "./viewer-integration";

type App = Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>;
const opaque=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const key=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/);
function directError(error:unknown):Response{
  if(error instanceof DirectViewerGrantError)return Response.json({error:error.message,code:error.code,
    ...(error.grantId?{grantId:error.grantId}:{})},{status:error.status,headers:{"Cache-Control":"private, no-store"}});
  if(error instanceof ViewerServiceError){
    const status=error.status===404?404:503;
    return Response.json({error:status===404?"Published Viewer delivery is unavailable":"Viewer delivery catalog is unavailable"},
      {status,headers:{"Cache-Control":"private, no-store"}});
  }
  throw error;
}
async function requireDirectShareCatalogAccess(env:Env,principal:StaffPrincipal):Promise<void>{
  if(!viewerIntegrationEnabled(env)||env.CLIENT_VIEWER_SESSION_ISSUER_ENABLED!=="true")
    throw new HTTPException(404,{message:"Not found"});
  for(const permission of ["viewer.view","viewer.manage"] as const){
    const scope=await sqlScope(env,principal,permission);
    if(!scope.global||scope.deniedGlobal)throw new HTTPException(403,{message:"Global Viewer management permission required"});
  }
}
const catalogQuery=z.object({q:z.string().max(120).regex(/^[^\u0000-\u001f\u007f]*$/).trim().optional(),cursor:z.string().min(8).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit:z.coerce.number().int().min(1).max(50).default(25)}).strict();
function parseCatalogQuery(c:{req:{queries:()=>Record<string,string[]|undefined>;query:()=>Record<string,string>}}){
  const queries=c.req.queries();
  if(Object.keys(queries).some(key=>!['q','cursor','limit'].includes(key))||Object.values(queries).some(values=>values?.length!==1))
    throw new HTTPException(400,{message:"Invalid delivery catalog query"});
  const parsed=catalogQuery.safeParse(c.req.query());
  if(!parsed.success)throw new HTTPException(400,{message:"Invalid delivery catalog query"});
  return parsed.data;
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
  app.get("/api/viewer/direct-share-catalog",async c=>{
    c.header("Cache-Control","private, no-store");
    const principal=c.get("principal");
    await requireDirectShareCatalogAccess(c.env,principal);
    const query=parseCatalogQuery(c);
    try{
      const catalog=await viewerServiceClient(c.env).clientDeliveryProjects(query);
      return c.json({projects:catalog.projects.map(project=>({viewerProjectId:project.id,name:project.displayName})),
        nextCursor:catalog.nextCursor});
    }catch(error){return directError(error);}
  });
  app.get("/api/viewer/direct-share-catalog/:viewerProjectId/tasks",async c=>{
    c.header("Cache-Control","private, no-store");
    const principal=c.get("principal");
    await requireDirectShareCatalogAccess(c.env,principal);
    const query=parseCatalogQuery(c),viewerProjectId=opaque.safeParse(c.req.param("viewerProjectId"));
    if(!viewerProjectId.success)throw new HTTPException(400,{message:"Invalid Viewer project ID"});
    try{
      const catalog=await viewerServiceClient(c.env).clientDeliveryCatalog({projectId:viewerProjectId.data,
        cursor:query.cursor,limit:query.limit});
      return c.json({project:{viewerProjectId:catalog.project.id,name:catalog.project.displayName},
        tasks:catalog.tasks.map(task=>({taskId:task.id,title:task.displayName,publishedAt:task.publishedAt,modelId:task.modelId||null})),
        nextCursor:catalog.nextCursor});
    }catch(error){return directError(error);}
  });
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
