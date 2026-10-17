import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { isAdministrator, sqlScope } from './acl';
import { readBoundedJson } from './bounded-json';
import { correspondenceCommandSchema, managePortalDirectoryCorrespondence, previewPortalDirectoryCorrespondence } from './portal-directory-correspondence';
import type { Env, StaffPrincipal } from './types';

export const PORTAL_DIRECTORY_CORRESPONDENCE_ROUTE='/api/admin/integrations/project-alpha/connectors/:sourceId/portal-correspondence';
/** Existing /api staff authentication and mutation origin/CSRF middleware run first. */
export function registerPortalDirectoryCorrespondenceRoutes(app:Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>):void{
 app.use(PORTAL_DIRECTORY_CORRESPONDENCE_ROUTE,async(c,next)=>{
  const actor=c.get('principal');const scope=await sqlScope(c.env,actor,'integrations.manage');
  if(!await isAdministrator(c.env,actor)||!scope.global||scope.deniedGlobal)throw new HTTPException(403,{message:'Global integration administration required'});
  c.header('Cache-Control','no-store');await next();
 });
 app.get(PORTAL_DIRECTORY_CORRESPONDENCE_ROUTE,async c=>c.json(await previewPortalDirectoryCorrespondence(c.env,c.req.param('sourceId'))));
 app.post(PORTAL_DIRECTORY_CORRESPONDENCE_ROUTE,async c=>{
  if(c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw new HTTPException(415,{message:'application/json required'});
  const parsed=correspondenceCommandSchema.safeParse(await readBoundedJson(c.req.raw,2048,'Portal correspondence'));
  if(!parsed.success||c.req.header('Idempotency-Key')!==parsed.data.operationId)throw new HTTPException(400,{message:'Invalid portal correspondence command'});
  const result=await managePortalDirectoryCorrespondence(c.env,c.get('principal'),c.req.param('sourceId'),parsed.data);
  if(!result.ok)return c.json(result,result.code==='outcome_unknown'?503:409);
  return c.json(result);
 });
}
