import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import type { Env } from './types';
import type { SharedProfileAuthorityReadRequest,SharedProfileAuthorityReadResult } from '../../../../packages/shared/src/shared-business-profile';
import { resolveBusinessProfileProof,type SharedProfileClientEnvironment } from './client-portal/business-profile';
const text=z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
const request=z.object({protocolVersion:z.literal(1),workspaceId:text,sourceId:z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/),
 issuer:text,subject:text,principalPublicId:text,scopeType:z.enum(['client','organization']),publicId:text}).strict();
/** Reauthorize queued business-profile commands from live identity and scoped authority.
 * This grants nothing and does not require or recreate a browser session.
 */
export async function readSharedProfilePortalAuthority(env:SharedProfileClientEnvironment,raw:SharedProfileAuthorityReadRequest):Promise<SharedProfileAuthorityReadResult>{
 const parsed=request.safeParse(raw);if(!parsed.success)return{ok:false,code:'denied'};const v=parsed.data;
 try{
  const identity=await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT identity.verified_email FROM portal_v2_identities identity
   JOIN pa_portal_principals p ON p.workspace_id=? AND p.public_id=? AND p.status='active'
   LEFT JOIN portal_v2_identity_eligibility_bindings eligibility ON eligibility.workspace_id=p.workspace_id
     AND eligibility.principal_public_id=p.public_id AND eligibility.identity_id=identity.id AND eligibility.principal_source_version=p.source_version
   JOIN portal_v2_workspaces w ON w.id=p.workspace_id AND w.project_alpha_source_id=? AND w.status='active'
   WHERE identity.issuer=? AND identity.subject=? AND identity.status='active' AND identity.revoked_at IS NULL
   AND (p.identity_id=identity.id OR (p.identity_id IS NULL AND eligibility.identity_id=identity.id)) LIMIT 2`)
   .bind(v.workspaceId,v.principalPublicId,v.sourceId,v.issuer,v.subject).all<{verified_email:string}>();
  if(identity.results.length!==1)return{ok:false,code:'denied'};
  const proof=await resolveBusinessProfileProof(env,{issuer:v.issuer,subject:v.subject,email:identity.results[0]!.verified_email},v.workspaceId,{bindTemplates:false});
  if(!proof||proof.sourceId!==v.sourceId)return{ok:false,code:'denied'};
  const target=proof.targets.filter(t=>t.principalPublicId===v.principalPublicId&&t.scopeType===v.scopeType&&t.publicId===v.publicId);
  if(target.length!==1)return{ok:false,code:'denied'};
  return{ok:true,proof:{...proof,targets:target}};
 }catch{return{ok:false,code:'unavailable'};}
}
/** Private named Ops -> Client service binding. Never mounted as a public HTTP route. */
export class SharedProfilePortalAuthorityReader extends WorkerEntrypoint<Env>{
 readAuthority(input:SharedProfileAuthorityReadRequest){return readSharedProfilePortalAuthority(this.env,input);}
}
