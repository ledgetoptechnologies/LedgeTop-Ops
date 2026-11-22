import { Hono } from 'hono';
import type { Env } from '../types';
import { configuredClientPortalOrigins } from '../origin-policy';
import { clientAccessConfiguration, resolveCloudflareClientPrincipal } from './access-identity';
import { readNativeOperationsPortalHomes } from './operations-native-recipient-read';
import { createDirectWorkspaceFolderResourceRouter, directWorkspaceFolderCoordinate } from './direct-workspace-folder-resources';
import type { ClientPortalSession, ResolveClientPrincipal, VerifiedClientPrincipal } from './types';
import { PORTAL_WORKSPACE_HEADER } from './workspace-v2';

type Bindings={Bindings:Env;Variables:{clientSession:ClientPortalSession;clientPrincipal:VerifiedClientPrincipal}};

/** Separate native admission: no PA account/session is created or consulted.
 * Home access admits the request; only the direct grant permits file access. */
export function createOperationsDirectFolderRouter(dependencies:{resolvePrincipal?:ResolveClientPrincipal}={}){
  const router=new Hono<Bindings>();
  router.use('*',async(c,next)=>{
    c.header('Cache-Control','private, no-store');c.header('Cloudflare-CDN-Cache-Control','no-store');
    const base='/api/client/operations/direct-folders',path=c.req.path.startsWith(base)?c.req.path.slice(base.length):c.req.path;
    const capability=path==='/capability',enabled=c.env.CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED?.trim().toLowerCase()==='true';
    if(c.env.CLIENT_PORTAL_ENABLED!=='true'||(!capability&&!enabled)
      ||c.env.CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED!=='true')return c.json({error:'Not found'},404);
    if(!['GET','HEAD'].includes(c.req.method))return c.json({error:'Method not allowed'},405);
    const origins=configuredClientPortalOrigins(c.env);
    if(!origins)return c.json({error:'Client portal is not configured'},503);
    if(!origins.includes(new URL(c.req.url).origin))return c.json({error:'Not found'},404);
    let principal:VerifiedClientPrincipal|null;
    try{
      if(!dependencies.resolvePrincipal)clientAccessConfiguration(c.env);
      principal=await(dependencies.resolvePrincipal??resolveCloudflareClientPrincipal)(c.req.raw,c.env);
    }catch{return c.json({error:'Shared folder access is temporarily unavailable'},503);}
    if(!principal)return c.json({error:'Client authentication is required'},401);
    if(capability){
      if(c.req.method!=='GET')return c.json({error:'Method not allowed'},405);
      if(new URL(c.req.url).search)return c.json({error:'Invalid request'},400);
      const homes=await readNativeOperationsPortalHomes(c.env.DELIVERY_DB,principal,true);
      if(homes===null)return c.json({error:'Shared folder access is temporarily unavailable'},503);
      if(homes.length===0)return c.json({error:'Client access is not provisioned'},403);
      return c.json({protocolVersion:1,enabled});
    }
    let workspaceId=c.req.header(PORTAL_WORKSPACE_HEADER);
    const match=/^\/(?:files\/([A-Za-z0-9_-]+)|([A-Za-z0-9_-]+)\/files|(preview|download))$/.exec(path);
    if(match){
      const raw=match[1]??match[2]??c.req.query('file');
      const coordinate=raw?await directWorkspaceFolderCoordinate(c.env,raw,match[1]||match[3]?'file':'folder'):null;
      if(!coordinate||workspaceId&&workspaceId!==coordinate.workspaceId)return c.json({error:'Shared folder is unavailable'},404);
      workspaceId=coordinate.workspaceId;
    }else if(path!==''&&path!=='/')return c.json({error:'Not found'},404);
    if(!workspaceId)return c.json({error:'Select an authorized client profile'},403);
    const homes=await readNativeOperationsPortalHomes(c.env.DELIVERY_DB,principal,true);
    if(homes===null)return c.json({error:'Shared folder access is temporarily unavailable'},503);
    if(!homes.some(home=>home.workspaceId===workspaceId))return c.json({error:'Shared folder is unavailable'},404);
    c.set('clientPrincipal',principal);
    c.set('clientSession',{accountId:'',identityId:'',workspaceId,principalIssuer:principal.issuer,
      principalSubject:principal.subject,principalEmail:principal.email,displayName:'Client portal',role:'member',canViewBilling:false});
    await next();
  });
  router.route('/',createDirectWorkspaceFolderResourceRouter());
  return router;
}
