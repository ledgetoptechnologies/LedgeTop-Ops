import type { Env } from './types';
import { historicalCrossSurfaceGenerationConflict } from './project-alpha-inventory-historical-generation-evidence';
import type { AuthenticatedNativeStaffWithAdmissionVersion as Actor } from './native-staff-auth';
import { resolveProjectAlphaApiV2Connection, withEnabledConfiguredProjectAlphaApiV2Connection } from './project-alpha-api-v2-connections';
import { readConfiguredProjectAlphaDirectoryInventory, type ProjectAlphaDirectoryInventoryResource } from './project-alpha-directory-inventory-api-v2';
import { directoryMaterializationReadSource } from './project-alpha-directory-materialization-read-source';
import { readNativeDirectoryDurableRemoteHead } from './native-directory-profile-writer';
import { preflightProjectAlphaDirectoryBindingRevisionRefresh, sendProjectAlphaDirectoryBindingRevisionRefreshCommand, validatedProjectAlphaDirectoryBindingRevisionRefreshAcknowledgement,
  reconcileProjectAlphaDirectoryBindingRevisionRefreshCommand,validatedProjectAlphaDirectoryBindingRevisionRefreshReconciliation,
  isProjectAlphaDirectoryBindingRevisionRefreshCommand, type ProjectAlphaDirectoryBindingRevisionRefreshCommand,
  type ProjectAlphaDirectoryBindingRevisionRefreshOutcome } from './project-alpha-directory-binding-revision-refresh-api-v2';

export const DIRECTORY_BINDING_REFRESH_ROUTE='/api/client-hub/directory/binding-revisions';
// Same protected native owner pin used by the existing staging Directory
// maintenance boundary; a role label or browser capability is not sufficient.
export const DIRECTORY_BINDING_REFRESH_PROTECTED_OWNER='staff-beau-koltz';
export function directoryBindingRefreshEnabled(env: Pick<Env,'ENVIRONMENT'|'NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED'>): boolean {
  return env.NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED==='true' && (env.ENVIRONMENT==='staging'||env.ENVIRONMENT==='local');
}
export function directoryBindingRefreshRecoveryEnabled(env:Pick<Env,'ENVIRONMENT'|'NATIVE_DIRECTORY_BINDING_REFRESH_ENABLED'|'NATIVE_DIRECTORY_BINDING_REFRESH_RECOVERY_ENABLED'>):boolean{
  return directoryBindingRefreshEnabled(env)&&env.NATIVE_DIRECTORY_BINDING_REFRESH_RECOVERY_ENABLED==='true';
}
export class DirectoryBindingRefreshDenied extends Error { constructor(){super('directory_binding_refresh_denied');} }
const deny=():never=>{throw new DirectoryBindingRefreshDenied();};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Request-local adapter: legacy head readers and every assertion share the
 * same first-primary bookmark, including helpers that accept D1Database. */
function primary(database:D1Database):D1Database{
  const session=database.withSession('first-primary');
  return {prepare:sql=>session.prepare(sql),batch:statements=>session.batch(statements),withSession:()=>session,
    exec:sql=>database.exec(sql),dump:()=>database.dump()};
}
type Mapping={record_id:string;source_id:string;source_instance_id:string;application_id:string;history_epoch_id:string;
  resource_type:'client'|'organization';external_id:string;public_id:string;mapping_kind:'legacy'|'acquired';mapping_provenance_id:string;local_version:number};
type Command=Mapping&{command_id:string;acknowledged_command_id:string;acknowledged_command_json:string;acknowledged_outcome_json:string;destination_origin:string;prior_revision:string;live_revision:string;
  projection_sha256:string;authorization_generation:string;actor_id:string;access_subject:string;actor_login_email:string;admission_version:number;profile_version:number;
  grant_generation:number;command_json:string;request_sha256:string;created_at:string};
type Authority={grant_generation:number};
export type DirectoryBindingRefreshReview={commandId:string;recordId:string;sourceId:string;localVersion:number;priorRevision:string;liveRevision:string};
export type DirectoryBindingRefreshRecoveryCandidate=DirectoryBindingRefreshReview&{recoveryCandidate:true;capturedAttempts:number};
export type DirectoryBindingRefreshResult={commandId:string;status:'acknowledged'|'uncertain'|'blocked'|'conflict';revision?:string;inventoryRefreshRequired?:true;reason?:string;frozenCommandRetained?:true;latestAttemptSent?:false;successorCommandId?:string};
export type DirectoryBindingRefreshRecoveryReview=DirectoryBindingRefreshReview&{supersededCommandId:string;capturedAttempts:number};
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),x=>x.toString(16).padStart(2,'0')).join('');
function applies(alias:string):string{return `(${alias}.scope_kind='global' OR ${alias}.scope_kind='resource' AND ${alias}.resource_id=c.record_id
  OR ${alias}.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=c.record_id AND a.staff_id=c.actor_id AND a.active=1)
  OR ${alias}.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=c.record_id AND s.active=1 AND s.business_area_id=${alias}.business_area_id)
  OR ${alias}.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=c.record_id AND s.active=1 AND s.division_id=${alias}.division_id))`;}
function permission(permission:'directory.profile.edit'|'directory.identity.link'):string{return `EXISTS(SELECT 1 FROM native_directory_grants g
  WHERE g.staff_id=c.actor_id AND g.permission='${permission}' AND g.active=1 AND g.effect='allow' AND ${applies('g')})
  AND NOT EXISTS(SELECT 1 FROM native_directory_grants g WHERE g.staff_id=c.actor_id AND g.permission='${permission}' AND g.active=1 AND g.effect='deny' AND ${applies('g')})`;}
const authoritySql=`EXISTS(SELECT 1 FROM native_staff_admissions a JOIN native_staff_profiles p ON p.staff_id=a.staff_id
  JOIN staff_users u ON u.id=a.staff_id JOIN native_directory_grant_generations gen ON gen.staff_id=a.staff_id
  WHERE a.staff_id=c.actor_id AND a.active=1 AND a.bound_access_subject=c.access_subject AND a.version=c.admission_version
    AND p.version=c.profile_version AND p.login_email=c.actor_login_email AND u.status='active' AND u.access_subject=c.access_subject AND gen.generation=c.grant_generation
    AND a.staff_id='${DIRECTORY_BINDING_REFRESH_PROTECTED_OWNER}'
    AND EXISTS(SELECT 1 FROM staff_role_assignments r JOIN role_permissions rp ON rp.role_id=r.role_id
      WHERE r.staff_id=a.staff_id AND r.role_id='role-owner' AND r.scope='global' AND rp.permission_key='integrations.manage')
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides o WHERE o.staff_id=a.staff_id AND o.permission_key='integrations.manage' AND o.effect='deny' AND o.scope='global'))
  AND ${permission('directory.profile.edit')} AND ${permission('directory.identity.link')}`;
function actorMatches(actor:Actor,c:Command):boolean{return actor.identity.staffId===c.actor_id&&actor.identity.verifiedAccessSubject===c.access_subject
  &&actor.identity.email===c.actor_login_email&&actor.admissionVersion===c.admission_version&&actor.identity.profileVersion===c.profile_version&&Date.parse(actor.verifiedUntil)>Date.now();}
function review(c:Command):DirectoryBindingRefreshReview{return{commandId:c.command_id,recordId:c.record_id,sourceId:c.source_id,
  localVersion:c.local_version,priorRevision:c.prior_revision,liveRevision:c.live_revision};}
async function mapping(db:D1Database,recordId:string,sourceId:string):Promise<Mapping>{
  const rows=(await db.prepare(`SELECT m.record_id,m.source_id,m.source_instance_id,m.application_id,m.history_epoch_id,
    m.resource_type,m.external_id,m.project_alpha_public_id public_id,m.mapping_kind,m.provenance_id mapping_provenance_id,r.current_version local_version
    FROM project_alpha_active_directory_mappings m JOIN operations_directory_records r ON r.record_id=m.record_id AND r.record_kind=m.resource_type
    WHERE m.record_id=? AND m.source_id=? AND (SELECT count(*) FROM project_alpha_active_directory_mappings other
      WHERE other.source_id=m.source_id AND other.source_instance_id=m.source_instance_id AND other.application_id=m.application_id
        AND other.history_epoch_id=m.history_epoch_id AND other.resource_type=m.resource_type
        AND (other.record_id=m.record_id OR other.external_id=m.external_id OR other.project_alpha_public_id=m.project_alpha_public_id))=1 LIMIT 2`)
    .bind(recordId,sourceId).all<Mapping>()).results;
  if(rows.length!==1||!Number.isSafeInteger(rows[0]!.local_version)||rows[0]!.local_version<1)return deny();return rows[0]!;
}
function configured(env:Env,m:Mapping):string{
  const c=resolveProjectAlphaApiV2Connection(env,m.source_id);
  if(!c.enabled||c.connection.expectedSourceInstanceId!==m.source_instance_id||c.connection.expectedApplicationId!==m.application_id
    ||c.connection.expectedHistoryEpoch!==m.history_epoch_id)return deny();return c.connection.baseUrl;
}
async function acknowledgedHead(db:D1Database,m:Mapping,origin:string):Promise<{command_id:string;command_json:string;outcome_json:string;revision:string}>{
  const head=await readNativeDirectoryDurableRemoteHead(db,m.resource_type,m.record_id,m.local_version,
    {sourceId:m.source_id,sourceInstanceUUID:m.source_instance_id,applicationUUID:m.application_id,historyEpoch:m.history_epoch_id,
      origin,externalCanonicalId:m.external_id});
  if(!head||head.projectAlphaPublicId!==m.public_id||head.externalCanonicalId!==m.external_id)return deny();
  const materialization=await directoryMaterializationReadSource(db);
  const rows=(await db.prepare(`SELECT o.command_id,o.command_json,o.outcome_json, json_extract(o.outcome_json,'$.response.result.resource.revision') revision
    FROM operations_directory_intents i JOIN ${materialization} x ON x.intent_id=i.intent_id AND x.history_epoch_id=i.expected_history_epoch_id
    JOIN project_alpha_directory_outbox o ON o.command_id=x.command_id AND o.command_json=x.command_json
    WHERE i.record_id=? AND i.record_version=? AND i.state='acknowledged' AND i.source_id=? AND i.source_instance_uuid=?
      AND i.application_uuid=? AND i.expected_history_epoch_id=? AND i.destination_origin=? AND i.external_canonical_id=?
      AND o.state='acknowledged' AND o.source_id=i.source_id AND o.expected_source_instance_id=i.source_instance_uuid
      AND o.application_id=i.application_uuid AND o.expected_history_epoch_id=i.expected_history_epoch_id
      AND o.destination_base_url=i.destination_origin AND o.resource_type=? AND o.external_id=i.external_canonical_id
      AND json_extract(o.command_json,'$.operation')='update' AND json_extract(o.command_json,'$.expectedProjectAlphaPublicId')=?
      AND json_extract(o.outcome_json,'$.status')='acknowledged'
      AND json_extract(o.outcome_json,'$.response.sourceInstanceId')=i.source_instance_uuid
      AND json_extract(o.outcome_json,'$.response.applicationId')=i.application_uuid
      AND json_extract(o.outcome_json,'$.response.historyEpoch')=i.expected_history_epoch_id
      AND json_extract(o.outcome_json,'$.response.result.resource.type')=?
      AND json_extract(o.outcome_json,'$.response.result.resource.publicId')=? LIMIT 2`)
    .bind(m.record_id,m.local_version,m.source_id,m.source_instance_id,m.application_id,m.history_epoch_id,origin,m.external_id,
      m.resource_type,m.public_id,m.resource_type,m.public_id).all<{command_id:string;command_json:string;outcome_json:string;revision:string}>()).results;
  if(rows.length!==1||rows[0]!.revision!==head.revision)return deny();return rows[0]!;
}
async function fresh(env:Env,m:Mapping,send:typeof fetch):Promise<{item:ProjectAlphaDirectoryInventoryResource;generation:string}>{
  let cursor:string|null=null,generation:string|null=null;
  for(let page=0;page<5;page++){
    const out=await readConfiguredProjectAlphaDirectoryInventory(env,m.source_id,{type:m.resource_type,cursor,limit:200},send);
    if(out.status!=='observed')return deny();const inventory=out.inventory;
    if(inventory.sourceInstanceId!==m.source_instance_id||inventory.applicationId!==m.application_id||inventory.historyEpoch!==m.history_epoch_id
      ||generation!==null&&generation!==inventory.authorizationGeneration)return deny();generation=inventory.authorizationGeneration;
    const candidates=inventory.resources.filter(x=>x.type===m.resource_type&&(x.publicId===m.public_id||x.binding?.externalId===m.external_id));
    // PA enforces one active external binding per application/resource and one
    // canonical public ID per type. Later pages cannot contain another identity
    // for this exact binding; this is not inferred from a local LIMIT query.
    if(candidates.length){if(candidates.length!==1)return deny();const item=candidates[0]!;
      if(item.publicId!==m.public_id||!item.present||item.lastAction!=='upsert'||item.binding?.status!=='active'||item.binding.externalId!==m.external_id)return deny();
      return{item,generation};}
    cursor=inventory.nextCursor;if(!cursor)break;
  }return deny();
}
async function load(db:D1Database,id:string):Promise<Command>{const c=await db.prepare('SELECT * FROM native_directory_active_binding_refresh_commands WHERE command_id=?').bind(id).first<Command>();return c??deny();}
function currentPredicate():string{return `${authoritySql}
  AND EXISTS(SELECT 1 FROM operations_directory_records r WHERE r.record_id=c.record_id AND r.record_kind=c.resource_type AND r.current_version=c.local_version)
  AND (SELECT count(*) FROM project_alpha_active_directory_mappings m WHERE m.source_id=c.source_id AND m.source_instance_id=c.source_instance_id
    AND m.application_id=c.application_id AND m.history_epoch_id=c.history_epoch_id AND m.resource_type=c.resource_type
    AND (m.record_id=c.record_id OR m.external_id=c.external_id OR m.project_alpha_public_id=c.public_id))=1
  AND EXISTS(SELECT 1 FROM project_alpha_active_directory_mappings m WHERE m.record_id=c.record_id AND m.source_id=c.source_id
    AND m.source_instance_id=c.source_instance_id AND m.application_id=c.application_id AND m.history_epoch_id=c.history_epoch_id
    AND m.resource_type=c.resource_type AND m.external_id=c.external_id AND m.project_alpha_public_id=c.public_id
    AND m.mapping_kind=c.mapping_kind AND m.provenance_id=c.mapping_provenance_id)
  AND EXISTS(SELECT 1 FROM project_alpha_directory_outbox o JOIN operations_directory_effective_materializations x ON x.command_id=o.command_id
    JOIN operations_directory_intents i ON i.intent_id=x.intent_id AND i.expected_history_epoch_id=x.history_epoch_id
    WHERE o.command_id=c.acknowledged_command_id AND o.state='acknowledged' AND i.state='acknowledged'
    AND i.record_id=c.record_id AND i.record_version=c.local_version AND i.source_id=c.source_id AND i.source_instance_uuid=c.source_instance_id
    AND i.application_uuid=c.application_id AND i.expected_history_epoch_id=c.history_epoch_id AND i.destination_origin=c.destination_origin
    AND i.external_canonical_id=c.external_id AND o.command_json=c.acknowledged_command_json AND x.command_json=c.acknowledged_command_json
    AND o.outcome_json=c.acknowledged_outcome_json AND o.source_id=c.source_id AND o.expected_source_instance_id=c.source_instance_id
    AND o.application_id=c.application_id AND o.expected_history_epoch_id=c.history_epoch_id AND o.destination_base_url=c.destination_origin
    AND o.resource_type=c.resource_type AND o.external_id=c.external_id
    AND json_extract(o.outcome_json,'$.response.result.resource.revision')=c.live_revision)
  AND NOT EXISTS(SELECT 1 FROM client_hub_native_project_effective_directory_conflicts conflict
    WHERE conflict.source_id=c.source_id AND conflict.source_instance_id=c.source_instance_id AND conflict.application_id=c.application_id
      AND conflict.history_epoch_id=c.history_epoch_id AND (conflict.resource_type='source'
        AND (conflict.conflict_kind IN('source_identity_changed','request_reuse_mismatch')
          OR conflict.inventory_kind='directory' AND NOT (${historicalCrossSurfaceGenerationConflict('directory')}))
        OR conflict.inventory_kind='directory' AND conflict.resource_type=c.resource_type
          AND (conflict.project_alpha_public_id=c.public_id OR conflict.external_id=c.external_id)))`;}
async function guarded(db:D1Database,c:Command,actor:Actor,statements:D1PreparedStatement[]):Promise<void>{
  if(!actorMatches(actor,c))return deny();const id=crypto.randomUUID();
  try{await db.batch([db.prepare(`INSERT INTO native_directory_active_binding_refresh_guards(guard_id,ok)
    SELECT ?,CASE WHEN julianday(?)>julianday('now') AND ${currentPredicate()} THEN 1 ELSE 0 END
    FROM native_directory_active_binding_refresh_commands c WHERE c.command_id=?`).bind(id,actor.verifiedUntil,c.command_id),
    db.prepare(`INSERT INTO native_directory_active_binding_refresh_guards(guard_id,ok) VALUES(?,
      CASE WHEN EXISTS(SELECT 1 FROM native_directory_active_binding_refresh_guards WHERE guard_id=?) THEN 1 ELSE 0 END)`).bind(`${id}:exists`,id),
    ...statements,db.prepare('DELETE FROM native_directory_active_binding_refresh_guards WHERE guard_id IN(?,?)').bind(id,`${id}:exists`)]);
  }catch(error){if(error instanceof Error&&/CHECK constraint failed: ok=1/u.test(error.message))return deny();throw error;}
}
export async function reviewDirectoryBindingRefresh(env:Env,actor:Actor,recordId:string,sourceId:string,send:typeof fetch=fetch):Promise<DirectoryBindingRefreshReview|DirectoryBindingRefreshRecoveryCandidate|DirectoryBindingRefreshRecoveryReview>{
  if(!directoryBindingRefreshEnabled(env)||Date.parse(actor.verifiedUntil)<=Date.now())return deny();
  env={...env,OPS_DB:primary(env.OPS_DB)};
  const db=env.OPS_DB.withSession('first-primary'),m=await mapping(env.OPS_DB,recordId,sourceId),origin=configured(env,m);
  const generation=await db.prepare('SELECT generation grant_generation FROM native_directory_grant_generations WHERE staff_id=?').bind(actor.identity.staffId).first<Authority>();
  if(!generation)return deny();
  const admitted=await db.prepare(`WITH c AS(SELECT ? actor_id,? access_subject,? actor_login_email,? admission_version,? profile_version,? grant_generation,? record_id)
    SELECT 1 ok FROM c WHERE ${authoritySql} AND julianday(?)>julianday('now')`).bind(actor.identity.staffId,
      actor.identity.verifiedAccessSubject,actor.identity.email,actor.admissionVersion,actor.identity.profileVersion,generation.grant_generation,m.record_id,actor.verifiedUntil).first();
  if(!admitted)return deny();
  const ack=await acknowledgedHead(env.OPS_DB,m,origin);
  // Discover the frozen command before checking for a stale remote binding.
  // A lost successful POST leaves PA already current; reload must still recover
  // the original command and replay its durable PA receipt, not mint a new ID.
  const pending=(await db.prepare(`SELECT c.command_id,d.attempts FROM native_directory_active_binding_refresh_commands c
    JOIN native_directory_active_binding_refresh_dispatch d ON d.command_id=c.command_id AND d.state<>'acknowledged'
    WHERE c.record_id=? AND c.source_id=? AND c.source_instance_id=? AND c.application_id=? AND c.history_epoch_id=?
      AND c.local_version=? LIMIT 2`).bind(m.record_id,m.source_id,m.source_instance_id,m.application_id,m.history_epoch_id,m.local_version)
    .all<{command_id:string;attempts:number}>()).results;
  if(pending.length>1)return deny();
  const live=await fresh(env,m,send);
  if(pending.length){const c=await load(env.OPS_DB,pending[0]!.command_id);
    const successor=await loadSuccessor(env.OPS_DB,c.command_id);if(successor){if(!directoryBindingRefreshRecoveryEnabled(env))return deny();await guardedSuccessor(env.OPS_DB,successor,actor,[]);
      return{...review(successor),supersededCommandId:successor.superseded_command_id,capturedAttempts:successor.captured_attempts};}
    const original=live.generation===c.authorization_generation&&live.item.binding!.resourceRevision===c.prior_revision;
    const replay=pending[0]!.attempts>0&&live.generation===(BigInt(c.authorization_generation)+1n).toString()&&live.item.binding!.resourceRevision===c.live_revision;
    const recoverable=pending[0]!.attempts>0&&BigInt(live.generation)>BigInt(c.authorization_generation)&&live.item.binding!.resourceRevision===c.prior_revision;
    if(c.acknowledged_command_id!==ack.command_id||c.destination_origin!==origin||live.item.revision!==c.live_revision
      ||live.item.projectionSha256!==c.projection_sha256||!original&&!replay&&!recoverable)return deny();
    if(recoverable){if(!directoryBindingRefreshRecoveryEnabled(env)||actor.identity.staffId!==c.actor_id||actor.identity.verifiedAccessSubject!==c.access_subject||actor.identity.email!==c.actor_login_email)return deny();
      return{...review(c),recoveryCandidate:true,capturedAttempts:pending[0]!.attempts};}
    await guarded(env.OPS_DB,c,actor,[]);return review(c);
  }
  if(live.item.revision!==ack.revision||BigInt(live.item.revision)<=BigInt(live.item.binding!.resourceRevision))return deny();
  const existing=await db.prepare(`SELECT command_id FROM native_directory_active_binding_refresh_commands WHERE record_id=? AND source_id=?
    AND source_instance_id=? AND application_id=? AND history_epoch_id=? AND local_version=? AND prior_revision=?`)
    .bind(m.record_id,m.source_id,m.source_instance_id,m.application_id,m.history_epoch_id,m.local_version,live.item.binding!.resourceRevision).first<{command_id:string}>();
  if(existing){const c=await load(env.OPS_DB,existing.command_id);await guarded(env.OPS_DB,c,actor,[]);return review(c);}
  const id=crypto.randomUUID(),command:ProjectAlphaDirectoryBindingRevisionRefreshCommand={commandId:id,externalId:m.external_id,
    expectedPriorRevision:live.item.binding!.resourceRevision,expectedLiveRevision:live.item.revision,expectedAuthorizationGeneration:live.generation};
  if(!isProjectAlphaDirectoryBindingRevisionRefreshCommand(command))return deny();const body=JSON.stringify(command);
  const c:Command={...m,command_id:id,acknowledged_command_id:ack.command_id,acknowledged_command_json:ack.command_json,acknowledged_outcome_json:ack.outcome_json,destination_origin:origin,prior_revision:command.expectedPriorRevision,
    live_revision:command.expectedLiveRevision,projection_sha256:live.item.projectionSha256,authorization_generation:live.generation,
    actor_id:actor.identity.staffId,access_subject:actor.identity.verifiedAccessSubject,actor_login_email:actor.identity.email,admission_version:actor.admissionVersion,
    profile_version:actor.identity.profileVersion,grant_generation:generation.grant_generation,command_json:body,request_sha256:await hash(body),created_at:new Date().toISOString()};
  // Reservation and all authority/head assertions commit atomically. The first
  // insertion is rolled back if any assertion fails; no PA mutation occurs here.
  const fields=Object.keys(c),values=Object.values(c);
  try{await db.batch([db.prepare(`INSERT INTO native_directory_active_binding_refresh_commands(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).bind(...values),
    db.prepare(`INSERT INTO native_directory_active_binding_refresh_guards(guard_id,ok) SELECT ?,CASE WHEN ${currentPredicate()}
      AND julianday(?)>julianday('now') THEN 1 ELSE 0 END FROM native_directory_active_binding_refresh_commands c WHERE c.command_id=?`).bind(id,actor.verifiedUntil,id),
    db.prepare("INSERT INTO native_directory_active_binding_refresh_dispatch(command_id,state) VALUES(?,'pending')").bind(id),
    db.prepare('DELETE FROM native_directory_active_binding_refresh_guards WHERE guard_id=?').bind(id)]);}catch{return deny();}
  return review(c);
}
/** Only transport-minted acknowledgements can reach this settlement path. */
export async function settleDirectoryBindingRefresh(env:Env,actor:Actor,id:string,lease:string,outcome:ProjectAlphaDirectoryBindingRevisionRefreshOutcome):Promise<DirectoryBindingRefreshResult>{
  if(!directoryBindingRefreshEnabled(env))return deny();
  env={...env,OPS_DB:primary(env.OPS_DB)};
  const evidence=validatedProjectAlphaDirectoryBindingRevisionRefreshAcknowledgement(outcome);if(!evidence)return deny();
  const c=await load(env.OPS_DB,id);
  if(JSON.stringify(evidence.command)!==c.command_json||evidence.destinationOrigin!==c.destination_origin||evidence.response.result.binding.publicId!==c.public_id)return deny();
  const response=JSON.stringify(evidence.response),guard=crypto.randomUUID();
  await guarded(env.OPS_DB,c,actor,[env.OPS_DB.prepare(`INSERT INTO native_directory_active_binding_refresh_guards(guard_id,ok) VALUES(?,
    CASE WHEN EXISTS(SELECT 1 FROM native_directory_active_binding_refresh_dispatch WHERE command_id=? AND state='leased'
      AND lease_token=? AND lease_until>unixepoch('now')) THEN 1 ELSE 0 END)`).bind(guard,id,lease),
    env.OPS_DB.prepare(`INSERT INTO native_directory_active_binding_refresh_receipts(command_id,response_json,response_sha256,pa_request_id,authorization_generation)
      VALUES(?,?,?,?,?)`).bind(id,response,await hash(response),evidence.response.requestId,evidence.response.result.binding.authorizationGeneration),
    env.OPS_DB.prepare("UPDATE native_directory_active_binding_refresh_dispatch SET state='acknowledged',lease_token=NULL,lease_until=NULL WHERE command_id=? AND lease_token=?").bind(id,lease),
    env.OPS_DB.prepare('DELETE FROM native_directory_active_binding_refresh_guards WHERE guard_id=?').bind(guard)]);
  return{status:'acknowledged',commandId:id,revision:c.live_revision,inventoryRefreshRequired:true};
}
export async function executeDirectoryBindingRefresh(env:Env,actor:Actor,id:string,send:typeof fetch=fetch):Promise<DirectoryBindingRefreshResult>{
  if(!directoryBindingRefreshEnabled(env)||!UUID.test(id))return deny();
  env={...env,OPS_DB:primary(env.OPS_DB)};
  const successor=await loadSuccessor(env.OPS_DB,id);
  if(successor&&successor.superseded_command_id===id){await guardedSuccessor(env.OPS_DB,successor,actor,[]);
    return{status:'conflict',commandId:id,reason:'terminally_superseded',successorCommandId:successor.command_id};}
  const c=await load(env.OPS_DB,id);
  if(configured(env,c)!==c.destination_origin||await hash(c.command_json)!==c.request_sha256)return deny();
  await guarded(env.OPS_DB,c,actor,[]);
  const receipt=await env.OPS_DB.prepare('SELECT command_id FROM native_directory_active_binding_refresh_receipts WHERE command_id=?').bind(id).first();
  if(receipt)return{status:'acknowledged',commandId:id,revision:c.live_revision,inventoryRefreshRequired:true};
  if((await acknowledgedHead(env.OPS_DB,c,c.destination_origin)).command_id!==c.acknowledged_command_id)return deny();
  const state=await env.OPS_DB.prepare('SELECT state,attempts FROM native_directory_active_binding_refresh_dispatch WHERE command_id=?').bind(id).first<{state:string;attempts:number}>();if(!state)return deny();
  const live=await fresh(env,c,send),binding=live.item.binding!;
  const initial=live.generation===c.authorization_generation&&binding.resourceRevision===c.prior_revision;
  const replay=state.attempts>0&&live.generation===(BigInt(c.authorization_generation)+1n).toString()&&binding.resourceRevision===c.live_revision;
  if(live.item.revision!==c.live_revision||live.item.projectionSha256!==c.projection_sha256||!initial&&!replay)
    return{status:'blocked',commandId:id,reason:'frozen_remote_head_or_generation_changed'};
  let command:unknown;try{command=JSON.parse(c.command_json);}catch{return deny();}if(!isProjectAlphaDirectoryBindingRevisionRefreshCommand(command))return deny();
  const frozen=command;
  // Fail closed before reserving an attempt. Do not rewrite a prior uncertain dispatch.
  const preflight=await withEnabledConfiguredProjectAlphaApiV2Connection(env,c.source_id,connection=>preflightProjectAlphaDirectoryBindingRevisionRefresh(connection,c.resource_type,send));
  if(preflight.status!=='enabled'||preflight.value.status!=='verified')return{status:state.attempts>0?'uncertain':'blocked',commandId:id,
    reason:'refresh_capability_unavailable',frozenCommandRetained:true,latestAttemptSent:false};
  const lease=crypto.randomUUID(),guard=crypto.randomUUID();
  try{await guarded(env.OPS_DB,c,actor,[env.OPS_DB.prepare(`UPDATE native_directory_active_binding_refresh_dispatch SET state='leased',lease_token=?,lease_until=unixepoch('now')+60,attempts=attempts+1
    WHERE command_id=? AND state<>'acknowledged' AND (state<>'leased' OR lease_until<=unixepoch('now'))`).bind(lease,id),
    env.OPS_DB.prepare(`INSERT INTO native_directory_active_binding_refresh_guards(guard_id,ok) VALUES(?,CASE WHEN EXISTS(
      SELECT 1 FROM native_directory_active_binding_refresh_dispatch WHERE command_id=? AND lease_token=?) THEN 1 ELSE 0 END)`).bind(guard,id,lease),
    env.OPS_DB.prepare('DELETE FROM native_directory_active_binding_refresh_guards WHERE guard_id=?').bind(guard)]);}catch{return{status:'conflict',commandId:id};}
  let preflightBlocked=false;
  try{
    const sent=await withEnabledConfiguredProjectAlphaApiV2Connection(env,c.source_id,connection=>sendProjectAlphaDirectoryBindingRevisionRefreshCommand(connection,c.resource_type,frozen,send));
    if(sent.status==='enabled'&&sent.value.status==='acknowledged')return await settleDirectoryBindingRefresh(env,actor,id,lease,sent.value);
    preflightBlocked=sent.status!=='enabled'||(sent.value.status==='blocked'&&sent.value.reason==='preflight');
  }catch{/* A POST may have succeeded. Preserve its identity for an exact retry. */}
  await env.OPS_DB.prepare("UPDATE native_directory_active_binding_refresh_dispatch SET state='uncertain',lease_token=NULL,lease_until=NULL WHERE command_id=? AND state='leased' AND lease_token=?").bind(id,lease).run();
  return{status:'uncertain',commandId:id,...(preflightBlocked?{reason:'refresh_capability_unavailable',frozenCommandRetained:true as const,latestAttemptSent:false as const}:{})};
}

type Supersession={successor_command_id:string;superseded_command_id:string;captured_attempts:number;reason:string;reconciliation_request_id:string;
  reconciliation_response_json:string;reconciliation_response_sha256:string;observed_resource_revision:string;observed_resource_projection_sha256:string;
  observed_binding_revision:string;observed_binding_projection_sha256:string;observed_authorization_generation:string;actor_id:string;access_subject:string;
  actor_login_email:string;admission_version:number;profile_version:number;grant_generation:number;command_json:string;request_sha256:string;created_at:string};
type SuccessorCommand=Command&{superseded_command_id:string;captured_attempts:number};
const successorProjection=`old.record_id,old.source_id,old.source_instance_id,old.application_id,old.history_epoch_id,old.resource_type,
  old.external_id,old.public_id,old.mapping_kind,old.mapping_provenance_id,old.local_version,s.successor_command_id command_id,
  old.acknowledged_command_id,old.acknowledged_command_json,old.acknowledged_outcome_json,old.destination_origin,old.prior_revision,old.live_revision,
  old.projection_sha256,s.observed_authorization_generation authorization_generation,s.actor_id,s.access_subject,s.actor_login_email,
  s.admission_version,s.profile_version,s.grant_generation,s.command_json,s.request_sha256,s.created_at`;
const recoveryAuthorityProjection=`old.record_id,old.source_id,old.source_instance_id,old.application_id,old.history_epoch_id,old.resource_type,
  old.external_id,old.public_id,old.mapping_kind,old.mapping_provenance_id,old.local_version,old.command_id,old.acknowledged_command_id,
  old.acknowledged_command_json,old.acknowledged_outcome_json,old.destination_origin,old.prior_revision,old.live_revision,old.projection_sha256,
  old.authorization_generation,? actor_id,? access_subject,? actor_login_email,? admission_version,? profile_version,? grant_generation,
  old.command_json,old.request_sha256,old.created_at`;
async function loadSuccessor(db:D1Database,id:string):Promise<SuccessorCommand|null>{
  const s=await db.prepare(`SELECT * FROM native_directory_active_binding_refresh_supersessions
    WHERE successor_command_id=? OR superseded_command_id=? LIMIT 2`).bind(id,id).all<Supersession>();
  if(s.results.length===0)return null;if(s.results.length!==1)return deny();const row=s.results[0]!,base=await load(db,row.superseded_command_id);
  return{...base,command_id:row.successor_command_id,authorization_generation:row.observed_authorization_generation,actor_id:row.actor_id,
    access_subject:row.access_subject,actor_login_email:row.actor_login_email,admission_version:row.admission_version,profile_version:row.profile_version,
    grant_generation:row.grant_generation,command_json:row.command_json,request_sha256:row.request_sha256,created_at:row.created_at,
    superseded_command_id:row.superseded_command_id,captured_attempts:row.captured_attempts};
}
async function guardedSuccessor(db:D1Database,c:SuccessorCommand,actor:Actor,statements:D1PreparedStatement[]):Promise<void>{
  if(!actorMatches(actor,c))return deny();const id=crypto.randomUUID();
  try{await db.batch([db.prepare(`INSERT INTO native_directory_active_binding_refresh_guards(guard_id,ok)
    SELECT ?,CASE WHEN julianday(?)>julianday('now') AND c.command_id=? AND ${currentPredicate()} THEN 1 ELSE 0 END FROM(
      SELECT ${successorProjection}
      FROM native_directory_active_binding_refresh_supersessions s JOIN native_directory_active_binding_refresh_commands old
        ON old.command_id=s.superseded_command_id WHERE s.successor_command_id=?) c`).bind(id,actor.verifiedUntil,c.command_id,c.command_id),
    db.prepare(`INSERT INTO native_directory_active_binding_refresh_guards(guard_id,ok) VALUES(?,CASE WHEN EXISTS(
      SELECT 1 FROM native_directory_active_binding_refresh_guards WHERE guard_id=?) THEN 1 ELSE 0 END)`).bind(`${id}:exists`,id),
    ...statements,db.prepare('DELETE FROM native_directory_active_binding_refresh_guards WHERE guard_id IN(?,?)').bind(id,`${id}:exists`)]);
  }catch(error){if(error instanceof Error&&/CHECK constraint failed: ok=1/u.test(error.message))return deny();throw error;}
}

/** Explicit, read-only PA reconciliation followed by one atomic local terminal
 * marker and successor reservation. It never POSTs the refresh command. */
export async function reviewDirectoryBindingRefreshRecovery(env:Env,actor:Actor,supersededCommandId:string,send:typeof fetch=fetch):Promise<DirectoryBindingRefreshRecoveryReview>{
  if(!directoryBindingRefreshRecoveryEnabled(env)||!UUID.test(supersededCommandId)||Date.parse(actor.verifiedUntil)<=Date.now())return deny();
  env={...env,OPS_DB:primary(env.OPS_DB)};const db=env.OPS_DB;
  const existing=await loadSuccessor(db,supersededCommandId);if(existing){await guardedSuccessor(db,existing,actor,[]);return{...review(existing),supersededCommandId:existing.superseded_command_id,capturedAttempts:existing.captured_attempts};}
  const old=await load(db,supersededCommandId);
  if(actor.identity.staffId!==old.actor_id||actor.identity.verifiedAccessSubject!==old.access_subject||actor.identity.email!==old.actor_login_email
    ||Date.parse(actor.verifiedUntil)<=Date.now())return deny();
  const dispatch=await db.prepare(`SELECT state,attempts,lease_token,lease_until FROM native_directory_active_binding_refresh_dispatch WHERE command_id=?`)
    .bind(old.command_id).first<{state:string;attempts:number;lease_token:string|null;lease_until:number|null}>();
  if(!dispatch||dispatch.state!=='uncertain'||dispatch.attempts<1||dispatch.lease_token!==null||dispatch.lease_until!==null)return deny();
  const generation=await db.prepare('SELECT generation grant_generation FROM native_directory_grant_generations WHERE staff_id=?').bind(actor.identity.staffId).first<Authority>();if(!generation)return deny();
  const admitted=await db.prepare(`WITH c AS(SELECT ? actor_id,? access_subject,? actor_login_email,? admission_version,? profile_version,? grant_generation,? record_id)
    SELECT 1 ok FROM c WHERE ${authoritySql} AND julianday(?)>julianday('now')`).bind(actor.identity.staffId,actor.identity.verifiedAccessSubject,
      actor.identity.email,actor.admissionVersion,actor.identity.profileVersion,generation.grant_generation,old.record_id,actor.verifiedUntil).first();if(!admitted)return deny();
  if(configured(env,old)!==old.destination_origin||await hash(old.command_json)!==old.request_sha256)return deny();
  let frozen:unknown;try{frozen=JSON.parse(old.command_json);}catch{return deny();}if(!isProjectAlphaDirectoryBindingRevisionRefreshCommand(frozen))return deny();
  const outcome=await withEnabledConfiguredProjectAlphaApiV2Connection(env,old.source_id,connection=>
    reconcileProjectAlphaDirectoryBindingRevisionRefreshCommand(connection,old.resource_type,frozen,old.request_sha256,send));
  if(outcome.status!=='enabled'||outcome.value.status!=='reconciled')return deny();const evidence=validatedProjectAlphaDirectoryBindingRevisionRefreshReconciliation(outcome.value);if(!evidence)return deny();
  const observed=evidence.response.observation;if(evidence.destinationOrigin!==old.destination_origin||JSON.stringify(evidence.command)!==old.command_json
    ||evidence.response.status!=='terminal_conflict'||evidence.response.acknowledgement!==null||observed.resource.type!==old.resource_type
    ||observed.resource.id!==old.external_id||observed.resource.revision!==old.live_revision||observed.resource.projectionSha256!==old.projection_sha256
    ||observed.binding.publicId!==old.public_id||observed.binding.revision!==old.prior_revision
    ||BigInt(observed.authorizationGeneration)<=BigInt(old.authorization_generation))return deny();
  const successorCommandId=crypto.randomUUID(),command:ProjectAlphaDirectoryBindingRevisionRefreshCommand={commandId:successorCommandId,externalId:old.external_id,
    expectedPriorRevision:old.prior_revision,expectedLiveRevision:old.live_revision,expectedAuthorizationGeneration:observed.authorizationGeneration};
  if(!isProjectAlphaDirectoryBindingRevisionRefreshCommand(command))return deny();const body=JSON.stringify(command),response=JSON.stringify(evidence.response);
  const values=[successorCommandId,old.command_id,dispatch.attempts,'remote_receipt_absent_generation_advanced',evidence.response.requestId,response,await hash(response),
    observed.resource.revision,observed.resource.projectionSha256,observed.binding.revision,observed.binding.projectionSha256,observed.authorizationGeneration,
    actor.identity.staffId,actor.identity.verifiedAccessSubject,actor.identity.email,actor.admissionVersion,actor.identity.profileVersion,generation.grant_generation,body,await hash(body)];
  const guard=crypto.randomUUID();
  try{await db.batch([db.prepare(`INSERT INTO native_directory_active_binding_refresh_guards(guard_id,ok)
      WITH c AS(SELECT ${recoveryAuthorityProjection}
        FROM native_directory_active_binding_refresh_commands old WHERE old.command_id=?)
      SELECT ?,CASE WHEN julianday(?)>julianday('now') AND ${currentPredicate()} AND EXISTS(
        SELECT 1 FROM native_directory_active_binding_refresh_dispatch d WHERE d.command_id=c.command_id AND d.state='uncertain'
          AND d.attempts=? AND d.lease_token IS NULL AND d.lease_until IS NULL)
        AND NOT EXISTS(SELECT 1 FROM native_directory_active_binding_refresh_receipts r WHERE r.command_id=c.command_id)
        AND NOT EXISTS(SELECT 1 FROM native_directory_active_binding_refresh_supersessions s WHERE s.superseded_command_id=c.command_id)
        THEN 1 ELSE 0 END FROM c`).bind(actor.identity.staffId,actor.identity.verifiedAccessSubject,actor.identity.email,actor.admissionVersion,
          actor.identity.profileVersion,generation.grant_generation,old.command_id,guard,actor.verifiedUntil,dispatch.attempts),
    db.prepare(`INSERT INTO native_directory_active_binding_refresh_supersessions(successor_command_id,superseded_command_id,captured_attempts,reason,
      reconciliation_request_id,reconciliation_response_json,reconciliation_response_sha256,observed_resource_revision,observed_resource_projection_sha256,
      observed_binding_revision,observed_binding_projection_sha256,observed_authorization_generation,actor_id,access_subject,actor_login_email,
      admission_version,profile_version,grant_generation,command_json,request_sha256) VALUES(${values.map(()=>'?').join(',')})`).bind(...values),
    db.prepare("INSERT INTO native_directory_active_binding_refresh_successor_dispatch(command_id,state) VALUES(?,'pending')").bind(successorCommandId),
    db.prepare('DELETE FROM native_directory_active_binding_refresh_guards WHERE guard_id=?').bind(guard)]);
  }catch{
    const winner=await loadSuccessor(db,old.command_id);if(!winner)return deny();await guardedSuccessor(db,winner,actor,[]);
    return{...review(winner),supersededCommandId:winner.superseded_command_id,capturedAttempts:winner.captured_attempts};
  }
  return{commandId:successorCommandId,supersededCommandId:old.command_id,recordId:old.record_id,sourceId:old.source_id,localVersion:old.local_version,
    priorRevision:old.prior_revision,liveRevision:old.live_revision,capturedAttempts:dispatch.attempts};
}

async function settleDirectoryBindingRefreshSuccessor(env:Env,actor:Actor,c:SuccessorCommand,lease:string,outcome:ProjectAlphaDirectoryBindingRevisionRefreshOutcome):Promise<DirectoryBindingRefreshResult>{
  const evidence=validatedProjectAlphaDirectoryBindingRevisionRefreshAcknowledgement(outcome);if(!evidence||JSON.stringify(evidence.command)!==c.command_json
    ||evidence.destinationOrigin!==c.destination_origin||evidence.response.result.binding.publicId!==c.public_id)return deny();
  const response=JSON.stringify(evidence.response),guard=crypto.randomUUID();
  await guardedSuccessor(env.OPS_DB,c,actor,[env.OPS_DB.prepare(`INSERT INTO native_directory_active_binding_refresh_guards(guard_id,ok) VALUES(?,CASE WHEN EXISTS(
      SELECT 1 FROM native_directory_active_binding_refresh_successor_dispatch WHERE command_id=? AND state='leased' AND lease_token=? AND lease_until>unixepoch('now')) THEN 1 ELSE 0 END)`).bind(guard,c.command_id,lease),
    env.OPS_DB.prepare(`INSERT INTO native_directory_active_binding_refresh_successor_receipts(command_id,response_json,response_sha256,pa_request_id,authorization_generation) VALUES(?,?,?,?,?)`)
      .bind(c.command_id,response,await hash(response),evidence.response.requestId,evidence.response.result.binding.authorizationGeneration),
    env.OPS_DB.prepare("UPDATE native_directory_active_binding_refresh_successor_dispatch SET state='acknowledged',lease_token=NULL,lease_until=NULL WHERE command_id=? AND lease_token=?").bind(c.command_id,lease),
    env.OPS_DB.prepare('DELETE FROM native_directory_active_binding_refresh_guards WHERE guard_id=?').bind(guard)]);
  return{status:'acknowledged',commandId:c.command_id,revision:c.live_revision,inventoryRefreshRequired:true};
}

export async function executeDirectoryBindingRefreshSuccessor(env:Env,actor:Actor,id:string,send:typeof fetch=fetch):Promise<DirectoryBindingRefreshResult>{
  if(!directoryBindingRefreshRecoveryEnabled(env)||!UUID.test(id))return deny();env={...env,OPS_DB:primary(env.OPS_DB)};
  const c=await loadSuccessor(env.OPS_DB,id);if(!c||c.command_id!==id)return deny();
  if(configured(env,c)!==c.destination_origin||await hash(c.command_json)!==c.request_sha256)return deny();await guardedSuccessor(env.OPS_DB,c,actor,[]);
  if(await env.OPS_DB.prepare('SELECT 1 FROM native_directory_active_binding_refresh_successor_receipts WHERE command_id=?').bind(id).first())
    return{status:'acknowledged',commandId:id,revision:c.live_revision,inventoryRefreshRequired:true};
  if((await acknowledgedHead(env.OPS_DB,c,c.destination_origin)).command_id!==c.acknowledged_command_id)return deny();
  const state=await env.OPS_DB.prepare('SELECT state,attempts FROM native_directory_active_binding_refresh_successor_dispatch WHERE command_id=?').bind(id).first<{state:string;attempts:number}>();if(!state)return deny();
  const live=await fresh(env,c,send),binding=live.item.binding!,initial=live.generation===c.authorization_generation&&binding.resourceRevision===c.prior_revision,
    replay=state.attempts>0&&live.generation===(BigInt(c.authorization_generation)+1n).toString()&&binding.resourceRevision===c.live_revision;
  if(live.item.revision!==c.live_revision||live.item.projectionSha256!==c.projection_sha256||!initial&&!replay)return{status:'blocked',commandId:id,reason:'frozen_remote_head_or_generation_changed'};
  let command:unknown;try{command=JSON.parse(c.command_json);}catch{return deny();}if(!isProjectAlphaDirectoryBindingRevisionRefreshCommand(command))return deny();
  const preflight=await withEnabledConfiguredProjectAlphaApiV2Connection(env,c.source_id,connection=>preflightProjectAlphaDirectoryBindingRevisionRefresh(connection,c.resource_type,send));
  if(preflight.status!=='enabled'||preflight.value.status!=='verified')return{status:state.attempts>0?'uncertain':'blocked',commandId:id,reason:'refresh_capability_unavailable',frozenCommandRetained:true,latestAttemptSent:false};
  const lease=crypto.randomUUID(),guard=crypto.randomUUID();
  try{await guardedSuccessor(env.OPS_DB,c,actor,[env.OPS_DB.prepare(`UPDATE native_directory_active_binding_refresh_successor_dispatch SET state='leased',lease_token=?,lease_until=unixepoch('now')+60,attempts=attempts+1
      WHERE command_id=? AND state<>'acknowledged' AND (state<>'leased' OR lease_until<=unixepoch('now'))`).bind(lease,id),
    env.OPS_DB.prepare(`INSERT INTO native_directory_active_binding_refresh_guards(guard_id,ok) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM native_directory_active_binding_refresh_successor_dispatch WHERE command_id=? AND lease_token=?) THEN 1 ELSE 0 END)`).bind(guard,id,lease),
    env.OPS_DB.prepare('DELETE FROM native_directory_active_binding_refresh_guards WHERE guard_id=?').bind(guard)]);}catch{return{status:'conflict',commandId:id};}
  let preflightBlocked=false;try{const sent=await withEnabledConfiguredProjectAlphaApiV2Connection(env,c.source_id,connection=>sendProjectAlphaDirectoryBindingRevisionRefreshCommand(connection,c.resource_type,command,send));
    if(sent.status==='enabled'&&sent.value.status==='acknowledged')return await settleDirectoryBindingRefreshSuccessor(env,actor,c,lease,sent.value);
    preflightBlocked=sent.status!=='enabled'||sent.value.status==='blocked'&&sent.value.reason==='preflight';}catch{/* preserve exact successor for replay */}
  await env.OPS_DB.prepare("UPDATE native_directory_active_binding_refresh_successor_dispatch SET state='uncertain',lease_token=NULL,lease_until=NULL WHERE command_id=? AND state='leased' AND lease_token=?").bind(id,lease).run();
  return{status:'uncertain',commandId:id,...(preflightBlocked?{reason:'refresh_capability_unavailable',frozenCommandRetained:true as const,latestAttemptSent:false as const}:{})};
}
