import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { Env,StaffPrincipal } from './types';
import { readBoundedJson } from './bounded-json';
import { authenticateNativeStaffWithAdmissionVersion } from './native-staff-auth';
import { auditStatement } from './request-security';
import { DIRECTORY_BINDING_REFRESH_ROUTE,directoryBindingRefreshEnabled,DirectoryBindingRefreshDenied,
  directoryBindingRefreshRecoveryEnabled,reviewDirectoryBindingRefresh,executeDirectoryBindingRefresh,
  reviewDirectoryBindingRefreshRecovery,executeDirectoryBindingRefreshSuccessor } from './native-directory-binding-refresh';
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const review=z.object({recordId:z.string().min(1).max(191).refine(x=>!/[\p{C}]/u.test(x)),sourceId:z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/)}).strict();
const execute=z.object({commandId:uuid,confirm:z.literal(true)}).strict();
const recoveryReview=z.object({commandId:uuid,confirm:z.literal(true)}).strict();
export function registerNativeDirectoryBindingRefreshRoutes(app:Hono<{Bindings:Env;Variables:{principal:StaffPrincipal;administrator:boolean}}>):void{
  for(const action of ['review','execute'] as const)app.post(`${DIRECTORY_BINDING_REFRESH_ROUTE}/${action}`,async c=>{
    if(!directoryBindingRefreshEnabled(c.env))throw new HTTPException(404,{message:'Not found'});
    c.header('Cache-Control','no-store');
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(c.req.header('Content-Type')??''))throw new HTTPException(400,{message:'Invalid request'});
    const input=await readBoundedJson(c.req.raw,2048,'Directory binding revision refresh');
    const parsed=action==='review'?review.safeParse(input):execute.safeParse(input);
    if(!parsed.success)throw new HTTPException(400,{message:'Invalid request'});
    try{
      let actor:Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
      try{actor=await authenticateNativeStaffWithAdmissionVersion(c.req.raw,c.env.OPS_DB,{enabled:true,issuer:c.env.TEAM_DOMAIN??'',staffAudience:c.env.OPERATIONS_AUD});}
      catch{throw new DirectoryBindingRefreshDenied();}
      const principal=c.get('principal');
      if(actor.identity.staffId!==principal.id||actor.identity.email!==principal.email||actor.identity.verifiedAccessSubject!==principal.accessSubject)
        throw new DirectoryBindingRefreshDenied();
      if(action==='review'){
        const value=review.parse(parsed.data),result=await reviewDirectoryBindingRefresh(c.env,actor,value.recordId,value.sourceId);
        await c.env.OPS_DB.batch([await auditStatement(c.env,c.req.raw,principal,'directory.binding_revision_refresh.reviewed',
          'native_directory_binding_refresh',result.commandId,null,{commandId:result.commandId,localVersion:result.localVersion,priorRevision:result.priorRevision,liveRevision:result.liveRevision})]);
        return c.json(result);
      }
      const value=execute.parse(parsed.data),result=await executeDirectoryBindingRefresh(c.env,actor,value.commandId);
      await c.env.OPS_DB.batch([await auditStatement(c.env,c.req.raw,principal,'directory.binding_revision_refresh.execution_result',
        'native_directory_binding_refresh',value.commandId,null,result)]);
      return c.json(result);
    }catch(error){if(error instanceof DirectoryBindingRefreshDenied)throw new HTTPException(409,{message:'Current owner, mapping, and acknowledged revision authority required'});
      throw new HTTPException(503,{message:'Directory binding revision refresh unavailable; preserve the frozen command for retry'});}
  });
  app.post(`${DIRECTORY_BINDING_REFRESH_ROUTE}/recovery-review`,async c=>{
    if(!directoryBindingRefreshRecoveryEnabled(c.env))throw new HTTPException(404,{message:'Not found'});c.header('Cache-Control','no-store');
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(c.req.header('Content-Type')??''))throw new HTTPException(400,{message:'Invalid request'});
    const parsed=recoveryReview.safeParse(await readBoundedJson(c.req.raw,2048,'Directory binding revision refresh recovery'));if(!parsed.success)throw new HTTPException(400,{message:'Invalid request'});
    try{
      const actor=await authenticateNativeStaffWithAdmissionVersion(c.req.raw,c.env.OPS_DB,{enabled:true,issuer:c.env.TEAM_DOMAIN??'',staffAudience:c.env.OPERATIONS_AUD});
      const principal=c.get('principal');if(actor.identity.staffId!==principal.id||actor.identity.email!==principal.email||actor.identity.verifiedAccessSubject!==principal.accessSubject)throw new DirectoryBindingRefreshDenied();
      const result=await reviewDirectoryBindingRefreshRecovery(c.env,actor,parsed.data.commandId);
      await c.env.OPS_DB.batch([await auditStatement(c.env,c.req.raw,principal,'directory.binding_revision_refresh.terminal_conflict_successor_reviewed',
        'native_directory_binding_refresh',result.commandId,null,{successorCommandId:result.commandId,supersededCommandId:result.supersededCommandId,
          capturedAttempts:result.capturedAttempts,localVersion:result.localVersion,priorRevision:result.priorRevision,liveRevision:result.liveRevision})]);
      return c.json(result);
    }catch(error){if(error instanceof DirectoryBindingRefreshDenied)throw new HTTPException(409,{message:'Exact terminal conflict and current owner authority required'});
      throw new HTTPException(503,{message:'Directory binding revision refresh reconciliation unavailable; the frozen command remains unchanged'});}
  });
  app.post(`${DIRECTORY_BINDING_REFRESH_ROUTE}/recovery-execute`,async c=>{
    if(!directoryBindingRefreshRecoveryEnabled(c.env))throw new HTTPException(404,{message:'Not found'});c.header('Cache-Control','no-store');
    if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(c.req.header('Content-Type')??''))throw new HTTPException(400,{message:'Invalid request'});
    const parsed=execute.safeParse(await readBoundedJson(c.req.raw,2048,'Directory binding revision refresh successor'));if(!parsed.success)throw new HTTPException(400,{message:'Invalid request'});
    try{
      const actor=await authenticateNativeStaffWithAdmissionVersion(c.req.raw,c.env.OPS_DB,{enabled:true,issuer:c.env.TEAM_DOMAIN??'',staffAudience:c.env.OPERATIONS_AUD});
      const principal=c.get('principal');if(actor.identity.staffId!==principal.id||actor.identity.email!==principal.email||actor.identity.verifiedAccessSubject!==principal.accessSubject)throw new DirectoryBindingRefreshDenied();
      const result=await executeDirectoryBindingRefreshSuccessor(c.env,actor,parsed.data.commandId);
      await c.env.OPS_DB.batch([await auditStatement(c.env,c.req.raw,principal,'directory.binding_revision_refresh.successor_execution_result',
        'native_directory_binding_refresh',parsed.data.commandId,null,result)]);return c.json(result);
    }catch(error){if(error instanceof DirectoryBindingRefreshDenied)throw new HTTPException(409,{message:'Current successor authority and frozen evidence required'});
      throw new HTTPException(503,{message:'Directory binding revision refresh successor unavailable; preserve the exact successor command'});}
  });
}
