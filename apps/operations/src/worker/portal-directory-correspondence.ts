import { z } from 'zod';
import { isAdministrator, sqlScope } from './acl';
import { resolveProjectAlphaApiV2Connection, probeConfiguredProjectAlphaApiV2Connection, listEnabledProjectAlphaApiV2SourceIds } from './project-alpha-api-v2-connections';
import type { Env, StaffPrincipal } from './types';
import type { PortalDirectoryCorrespondenceCommand, PortalDirectoryCorrespondenceProof, PortalDirectoryCorrespondenceStatus, PortalDirectoryCorrespondenceDiscovery, PortalDirectoryCorrespondenceResult } from '../../../../packages/shared/src/portal-directory-correspondence';

export type CorrespondenceEnv = Pick<Env,'OPS_DB'|'DELIVERY_DB'|'PROJECT_ALPHA_API_V2_CONNECTIONS'>;
export type DirectoryTuple = { sourceInstanceId:string; applicationId:string; historyEpochId:string };
export type DirectoryPortalSource = {directorySourceId:string;portalSourceId:string;correspondenceRevisionId:string|null;correspondenceVersion:number|null};
const PRIMARY='project-alpha:primary';
const source=z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/);
const sha=z.string().regex(/^[a-f0-9]{64}$/);
const proofSchema=z.object({directorySourceId:source,portalSourceId:z.literal(PRIMARY),sourceInstanceId:z.string().uuid(),applicationId:z.string().uuid(),historyEpochId:z.string().uuid(),
 baseUrl:z.string().url(),producerBindingId:z.string().min(1),applicationKey:z.string().min(1),connectorRevision:z.number().int().positive(),connectorVersion:z.number().int().positive(),
 currentKeyFingerprint:sha,primaryAuthorityVersion:z.number().int().positive()}).strict();
export const correspondenceCommandSchema=z.object({operationId:z.string().uuid(),action:z.enum(['approve','revoke']),expectedVersion:z.number().int().nonnegative(),expectedProofSha256:sha}).strict();
type Head={directory_source_id:string;portal_source_id:string;revision_id:string;version:number;state:'active'|'revoked';operation_id:string;proof_json:string;proof_sha256:string;actor_staff_id:string;created_at:string};
type Connector={producer_binding_id:string;snapshot_origin:string;application_key:string;active_revision:number;version:number;current_key_fingerprint:string};
const canonical=(v:PortalDirectoryCorrespondenceProof)=>JSON.stringify(proofSchema.parse(v));
export async function correspondenceHash(value:unknown):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
async function schemaReady(env:CorrespondenceEnv):Promise<boolean>{
 try{return await env.OPS_DB.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name IN('portal_directory_correspondence_heads','portal_directory_correspondence_revisions','portal_directory_correspondence_receipts')").first<number>('n')===3;}catch{return false;}
}
async function head(env:CorrespondenceEnv,id:string):Promise<Head|null>{return env.OPS_DB.withSession('first-primary').prepare(`SELECT h.*,r.proof_json,r.proof_sha256,r.actor_staff_id,r.created_at
 FROM portal_directory_correspondence_heads h JOIN portal_directory_correspondence_revisions r ON r.id=h.revision_id
 AND r.directory_source_id=h.directory_source_id AND r.portal_source_id=h.portal_source_id WHERE h.directory_source_id=?`).bind(id).first<Head>();}
/** Nomination is eligibility only. Only native reviewed approval creates correspondence authority. */
async function uniqueEligibleSource(env:CorrespondenceEnv):Promise<string|null>{
 try{
  const primary=await env.OPS_DB.prepare("SELECT snapshot_origin FROM pa_connectors WHERE source_id='project-alpha:primary' AND profile='primary_legacy' AND state='active' AND read_visible=1").first<{snapshot_origin:string}>();
  if(!primary)return null;
  const candidates:string[]=[];
  for(const id of listEnabledProjectAlphaApiV2SourceIds(env)){
   const entry=resolveProjectAlphaApiV2Connection(env,id);
   if(entry.connection.baseUrl!==primary.snapshot_origin)continue;
   if(id!==PRIMARY&&await env.OPS_DB.prepare('SELECT 1 FROM pa_connectors WHERE source_id=?').bind(id).first())continue;
   candidates.push(id);
  }
  return candidates.length===1?candidates[0]!:null;
 }catch{return null;}
}
export async function discoverPortalDirectoryCorrespondence(env:CorrespondenceEnv):Promise<PortalDirectoryCorrespondenceDiscovery>{
 const eligible=await uniqueEligibleSource(env);
 const ids=new Set<string>();
 if(eligible&&eligible!==PRIMARY)ids.add(eligible);
 if(await schemaReady(env)){
  const rows=await env.OPS_DB.prepare("SELECT directory_source_id FROM portal_directory_correspondence_heads WHERE state='active' ORDER BY directory_source_id LIMIT 2").all<{directory_source_id:string}>();
  if(rows.results.length>1)return{status:'unavailable',candidates:[]};
  for(const row of rows.results)ids.add(row.directory_source_id);
 }
 const candidates=[];
 for(const id of ids)candidates.push({directorySourceId:id,review:await previewPortalDirectoryCorrespondence(env,id)});
 return{status:candidates.length?'review':eligible===PRIMARY?'not_required':'unavailable',candidates};
}
async function metadata(env:CorrespondenceEnv,id:string):Promise<PortalDirectoryCorrespondenceProof|null>{
 if(id===PRIMARY||!source.safeParse(id).success||await uniqueEligibleSource(env)!==id)return null;
 try{
  const configured=resolveProjectAlphaApiV2Connection(env,id);if(!configured.enabled)return null;
  // A secondary registered producer can never be reassigned to the primary namespace.
  if(await env.OPS_DB.prepare('SELECT 1 FROM pa_connectors WHERE source_id=?').bind(id).first())return null;
  const connectorSql=`SELECT c.producer_binding_id,c.snapshot_origin,c.application_key,c.active_revision,c.version,r.current_key_fingerprint
   FROM pa_connectors c JOIN pa_connector_revisions r ON r.source_id=c.source_id AND r.revision=c.active_revision
   WHERE c.source_id='project-alpha:primary' AND c.profile='primary_legacy' AND c.state='active' AND c.read_visible=1`;
  const c=await env.OPS_DB.withSession('first-primary').prepare(connectorSql).first<Connector>();
  if(!c||configured.connection.baseUrl!==c.snapshot_origin)return null;
  const authority=await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT authority_version FROM pa_primary_delivery_authority
   WHERE source_id='project-alpha:primary' AND mode='registry' AND state='active' AND connector_revision=? AND connector_version=?`)
   .bind(c.active_revision,c.version).first<{authority_version:number}>();
  if(!authority)return null;
  if(!await env.DELIVERY_DB.withSession('first-primary').prepare("SELECT 1 FROM pa_portal_primary_private_authority WHERE source_id='project-alpha:primary' AND application_key=? AND state='active'").bind(c.application_key).first())return null;
  const after=await env.OPS_DB.withSession('first-primary').prepare(connectorSql).first<Connector>();
  if(JSON.stringify(after)!==JSON.stringify(c))return null;
  const parsed=proofSchema.safeParse({directorySourceId:id,portalSourceId:PRIMARY,sourceInstanceId:configured.connection.expectedSourceInstanceId,
   applicationId:configured.connection.expectedApplicationId,historyEpochId:configured.connection.expectedHistoryEpoch,baseUrl:configured.connection.baseUrl,
   producerBindingId:c.producer_binding_id,applicationKey:c.application_key,connectorRevision:c.active_revision,connectorVersion:c.version,
   currentKeyFingerprint:c.current_key_fingerprint,primaryAuthorityVersion:authority.authority_version});
  return parsed.success?parsed.data:null;
 }catch{return null;}
}
async function currentProof(env:CorrespondenceEnv,row:Head):Promise<PortalDirectoryCorrespondenceProof|null>{
 try{
  const stored=proofSchema.parse(JSON.parse(row.proof_json));
  if(stored.directorySourceId!==row.directory_source_id||stored.portalSourceId!==row.portal_source_id||await correspondenceHash(stored)!==row.proof_sha256)return null;
  const current=await metadata(env,row.directory_source_id);
  // Approval binds immutable producer identity, configuration, revision and key.
  // Normal pause/resume advances these two lifecycle counters without replacing
  // that approval. They are approval floors, not historical high-water marks;
  // metadata still requires the exact CURRENT active connector/mirror pair.
  if(!current||current.connectorVersion<stored.connectorVersion||current.primaryAuthorityVersion<stored.primaryAuthorityVersion)return null;
  return canonical({...current,connectorVersion:stored.connectorVersion,primaryAuthorityVersion:stored.primaryAuthorityVersion})===canonical(stored)?current:null;
 }catch{return null;}
}
export async function previewPortalDirectoryCorrespondence(env:CorrespondenceEnv,id:string):Promise<PortalDirectoryCorrespondenceStatus>{
 if(id===PRIMARY)return{status:'not_required',current:null,preview:null};
 if(!source.safeParse(id).success)return{status:'unavailable',reason:'configuration',current:null,preview:null};
 if(!await schemaReady(env))return{status:'unavailable',reason:'schema',current:null,preview:null};
 const row=await head(env,id),proof=await metadata(env,id);
 if(!row&&!proof&&await env.OPS_DB.prepare("SELECT 1 FROM pa_connectors WHERE source_id=? AND profile='business_data'").bind(id).first())
  return{status:'not_required',current:null,preview:null};
 const current=row?{version:row.version,state:row.state,revisionId:row.revision_id,
  approvedByStaffId:row.actor_staff_id,approvedAt:row.created_at,
  revocationProofSha256:await correspondenceHash({directorySourceId:id,revisionId:row.revision_id,version:row.version,state:row.state,proofSha256:row.proof_sha256})}:null;
 return{status:row?.state==='active'&&!await currentProof(env,row)?'suspended':proof?'ready':'unavailable',...(!proof?{reason:'producer' as const}:{}),current,
  preview:proof?{proof,proofSha256:await correspondenceHash(proof)}:null};
}
/** Explicit correspondence authority only; neither URL nor public-ID coincidence creates a bridge. */
export async function resolveDirectoryPortalSource(env:CorrespondenceEnv,id:string,expected?:DirectoryTuple,requiredRevisionId?:string|null):Promise<DirectoryPortalSource|null>{
 if(!source.safeParse(id).success)return null;
 const same=()=>requiredRevisionId?null:{directorySourceId:id,portalSourceId:id,correspondenceRevisionId:null,correspondenceVersion:null};
 if(id===PRIMARY)return same();
 if(!await schemaReady(env))return same();
 try{
  const row=await head(env,id);if(!row)return same();
  if(row.state!=='active'||(requiredRevisionId!==undefined&&requiredRevisionId!==row.revision_id))return null;
  const proof=await currentProof(env,row);if(!proof)return null;
  const final=await head(env,id);if(!final||JSON.stringify(final)!==JSON.stringify(row))return null;
  if(expected&&(proof.sourceInstanceId!==expected.sourceInstanceId||proof.applicationId!==expected.applicationId||proof.historyEpochId!==expected.historyEpochId))return null;
  return{directorySourceId:id,portalSourceId:PRIMARY,correspondenceRevisionId:row.revision_id,correspondenceVersion:row.version};
 }catch{return null;}
}
/** Alias-only native workspace witness. Callers retain their original same-ID compatibility guards. */
export function aliasWorkspaceWitnessSql(workspaceAlias:string):string{
 if(!/^[a-z_]+$/i.test(workspaceAlias))throw Error('Invalid alias workspace SQL identifier');
 // Workspace headers and root entities are independently versioned resources.
 // Signed events retain the selected snapshot while advancing both checkpoints.
 return `(${workspaceAlias}.legacy_account_id IS NULL AND EXISTS(
 SELECT 1 FROM pa_portal_workspace_sources reservation
 JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=reservation.workspace_id
 JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
  AND generation.workspace_id=checkpoint.workspace_id AND generation.source_sequence=checkpoint.source_sequence
  AND generation.status='active' AND generation.complete=1 AND generation.source_generation<>'legacy-backfill'
 JOIN portal_v2_directory_entities root ON root.workspace_id=generation.workspace_id AND root.generation_id=generation.id
  AND root.active=1 AND root.parent_public_id IS NULL
 JOIN pa_portal_projection_checkpoints projected ON projected.workspace_id=reservation.workspace_id AND projected.source_sequence=checkpoint.source_sequence
 JOIN pa_portal_projection_generations snapshot ON snapshot.id=projected.snapshot_generation_id AND snapshot.workspace_id=reservation.workspace_id
  AND snapshot.projection_source_id=reservation.projection_source_id AND snapshot.status='active' AND snapshot.complete=1 AND snapshot.workspace_active=1
 WHERE reservation.workspace_id=${workspaceAlias}.id AND reservation.projection_source_id=${workspaceAlias}.project_alpha_source_id
 AND reservation.source_workspace_id=${workspaceAlias}.id AND snapshot.workspace_root_type=${workspaceAlias}.root_type
 AND snapshot.workspace_root_public_id=COALESCE(${workspaceAlias}.pa_organization_public_id,${workspaceAlias}.pa_client_public_id)
 AND projected.source_generation=snapshot.source_generation AND snapshot.source_sequence<=projected.source_sequence
 AND root.source_version<>'legacy-backfill'
 AND EXISTS(SELECT 1 FROM pa_portal_projection_entities snapshot_root
  WHERE snapshot_root.generation_id=snapshot.id AND snapshot_root.public_id=snapshot.workspace_root_public_id
   AND snapshot_root.parent_public_id IS NULL AND snapshot_root.active=1
   AND ((${workspaceAlias}.root_type='organization' AND snapshot_root.entity_type='organization')
    OR (${workspaceAlias}.root_type='standalone_client' AND snapshot_root.entity_type IN('client','standalone_client')))
   AND ((generation.source_generation=snapshot.source_generation AND generation.source_sequence=snapshot.source_sequence
     AND root.source_version=snapshot_root.source_version)
    OR (generation.source_sequence>snapshot.source_sequence AND EXISTS(
     SELECT 1 FROM pa_portal_projection_receipts receipt JOIN pa_portal_projection_audit event_audit
      ON event_audit.workspace_id=receipt.workspace_id AND event_audit.delivery_id=receipt.delivery_id
       AND event_audit.source_sequence=receipt.source_sequence AND event_audit.source_generation=projected.source_generation
       AND event_audit.action IN('event_upserted','event_tombstoned')
     WHERE receipt.projection_source_id=reservation.projection_source_id AND receipt.workspace_id=reservation.workspace_id
      AND receipt.delivery_kind='event' AND receipt.status='completed' AND receipt.write_guard=1
      AND receipt.source_sequence=projected.source_sequence AND generation.source_generation='event-'||receipt.delivery_id))))
 AND root.public_id=snapshot.workspace_root_public_id
 AND ((${workspaceAlias}.root_type='organization' AND root.entity_type='organization')
  OR (${workspaceAlias}.root_type='standalone_client' AND root.entity_type IN('client','standalone_client')))))`;
}
/** SAME atomic SQL batch as grant use/writes. Client authority and deployed API pins are additionally checked by the resolver. */
export function correspondenceGrantSql(alias:string):string{
 if(!/^[a-z_]+$/i.test(alias))throw Error('Invalid correspondence grant alias');
 return `((${alias}.directory_source_id IS NULL AND ${alias}.correspondence_revision_id IS NULL) OR EXISTS(
 SELECT 1 FROM portal_directory_correspondence_heads bridge JOIN portal_directory_correspondence_revisions revision ON revision.id=bridge.revision_id
 JOIN pa_connectors connector ON connector.source_id=bridge.portal_source_id
 JOIN pa_connector_revisions signing ON signing.source_id=connector.source_id AND signing.revision=connector.active_revision
 WHERE (WITH correspondence_predicates(allowed) AS (VALUES
 (bridge.directory_source_id=${alias}.directory_source_id),
 (bridge.portal_source_id=${alias}.source_id),
 (bridge.revision_id=${alias}.correspondence_revision_id),
 (bridge.state='active'),
 (revision.source_instance_id=${alias}.source_instance_id),
 (revision.application_id=${alias}.application_id),
 (revision.history_epoch_id=${alias}.history_epoch_id),
 (connector.profile='primary_legacy'),
 (connector.state='active'),
 (connector.read_visible=1),
 (connector.producer_binding_id=json_extract(revision.proof_json,'$.producerBindingId')),
 (connector.snapshot_origin=json_extract(revision.proof_json,'$.baseUrl')),
 (connector.application_key=json_extract(revision.proof_json,'$.applicationKey')),
 (connector.active_revision=json_extract(revision.proof_json,'$.connectorRevision')),
 (connector.version>=json_extract(revision.proof_json,'$.connectorVersion')),
 (signing.current_key_fingerprint=json_extract(revision.proof_json,'$.currentKeyFingerprint'))
 ) SELECT MIN(coalesce(allowed,0)) FROM correspondence_predicates)=1))`;
}
export async function managePortalDirectoryCorrespondence(env:CorrespondenceEnv,actor:StaffPrincipal,id:string,raw:PortalDirectoryCorrespondenceCommand,send:typeof fetch=fetch):Promise<PortalDirectoryCorrespondenceResult>{
 const reject=():PortalDirectoryCorrespondenceResult=>({ok:false,code:'rejected',operationId:raw?.operationId??''});
 let batchAttempted=false;
 const parsed=correspondenceCommandSchema.safeParse(raw);if(!parsed.success||id===PRIMARY||!source.safeParse(id).success)return reject();
 const v=parsed.data,db=env.OPS_DB.withSession('first-primary');
 try{
  if(!await schemaReady(env)||!await isAdministrator(env as Env,actor))return reject();
  const scope=await sqlScope(env as Env,actor,'integrations.manage');if(!scope.global||scope.deniedGlobal)return reject();
  const owner=await db.prepare(`SELECT admission.version admission_version,profile.version profile_version FROM staff_users staff
   JOIN native_staff_admissions admission ON admission.staff_id=staff.id JOIN native_staff_profiles profile ON profile.staff_id=staff.id
   WHERE staff.id=? AND staff.access_subject=? AND staff.status='active' AND admission.active=1 AND admission.bound_access_subject=staff.access_subject
   AND lower(profile.login_email)=lower(?) AND lower(staff.email)=lower(?)`).bind(actor.id,actor.accessSubject,actor.email,actor.email)
   .first<{admission_version:number;profile_version:number}>();if(!owner)return reject();
  const requestSha=await correspondenceHash({directorySourceId:id,...v});
  const replay=await db.prepare('SELECT * FROM portal_directory_correspondence_receipts WHERE operation_id=?').bind(v.operationId)
   .first<{request_sha256:string;actor_staff_id:string;actor_access_subject:string;resulting_version:number;revision_id:string;action:'approve'|'revoke';directory_source_id:string}>();
  if(replay){if(replay.request_sha256!==requestSha||replay.actor_staff_id!==actor.id||replay.actor_access_subject!==actor.accessSubject)return reject();return{ok:true,operationId:v.operationId,action:replay.action,directorySourceId:replay.directory_source_id,requestSha256:replay.request_sha256,version:replay.resulting_version,revisionId:replay.revision_id,replayed:true};}
  const status=await previewPortalDirectoryCorrespondence(env,id);if((status.current?.version??0)!==v.expectedVersion)return reject();
  const prior=await head(env,id);let proof:PortalDirectoryCorrespondenceProof|null=null,revisionId=prior?.revision_id??'';
  if(v.action==='approve'){
   if(await db.prepare("SELECT 1 FROM portal_directory_correspondence_heads WHERE state='active' AND directory_source_id<>? LIMIT 1").bind(id).first())return reject();
   if(!status.preview||status.preview.proofSha256!==v.expectedProofSha256)return reject();proof=status.preview.proof;
   const probe=await probeConfiguredProjectAlphaApiV2Connection(env,id,[],send);if(probe.status!=='verified'||probe.sourceInstanceId!==proof.sourceInstanceId||probe.applicationId!==proof.applicationId||probe.historyEpoch!==proof.historyEpochId)return reject();
   const current=await metadata(env,id);if(!current||canonical(current)!==canonical(proof))return reject();revisionId=crypto.randomUUID();
  }else if(!prior||prior.state!=='active'||status.current?.revocationProofSha256!==v.expectedProofSha256)return reject();
  const statements:D1PreparedStatement[]=[];
  if(proof)statements.push(db.prepare(`INSERT INTO portal_directory_correspondence_revisions(id,directory_source_id,portal_source_id,source_instance_id,application_id,history_epoch_id,proof_json,proof_sha256,operation_id,actor_staff_id)
   VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(revisionId,id,PRIMARY,proof.sourceInstanceId,proof.applicationId,proof.historyEpochId,canonical(proof),v.expectedProofSha256,v.operationId,actor.id));
  statements.push(db.prepare(`INSERT INTO portal_directory_correspondence_receipts(operation_id,directory_source_id,revision_id,action,expected_version,resulting_version,request_sha256,actor_staff_id,actor_access_subject,admission_version,profile_version)
   VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(v.operationId,id,revisionId,v.action,v.expectedVersion,v.expectedVersion+1,requestSha,actor.id,actor.accessSubject,owner.admission_version,owner.profile_version));
  if(prior)statements.push(db.prepare(`UPDATE portal_directory_correspondence_heads SET revision_id=?,version=version+1,state=?,operation_id=? WHERE directory_source_id=? AND version=?`)
   .bind(revisionId,v.action==='approve'?'active':'revoked',v.operationId,id,v.expectedVersion));
  else statements.push(db.prepare(`INSERT INTO portal_directory_correspondence_heads(directory_source_id,portal_source_id,revision_id,version,state,operation_id) VALUES(?,?,?,1,'active',?)`)
   .bind(id,PRIMARY,revisionId,v.operationId));
  statements.push(db.prepare(`SELECT CASE WHEN EXISTS(SELECT 1 FROM portal_directory_correspondence_heads WHERE directory_source_id=? AND version=? AND operation_id=? AND revision_id=?) THEN 1 ELSE json('portal-correspondence-cas-failed') END ok`)
   .bind(id,v.expectedVersion+1,v.operationId,revisionId));
  batchAttempted=true;await db.batch(statements);
  return{ok:true,operationId:v.operationId,action:v.action,directorySourceId:id,requestSha256:requestSha,version:v.expectedVersion+1,revisionId,replayed:false};
 }catch{return batchAttempted?{ok:false,code:'outcome_unknown',operationId:raw.operationId}:reject();}
}
