import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { readBoundedJson } from './bounded-json';
import { nativeActor, actorWithGrants, updateDestinations, currentClientRelationship, normalizeProfile,
  organizationProfile, clientUpdateProfile, canonicalRecordId, mutationId, selectGrant, nativeDirectoryProfileWritesEnabled } from './native-directory-profile-routes';
import { writeNativeDirectorySharedProfiles, type NativeDirectoryUpdateWrite } from './native-directory-profile-writer';
import type { Env, StaffPrincipal } from './types';
import { directoryMaterializationReadSource } from './project-alpha-directory-materialization-read-source';
import { probeConfiguredProjectAlphaDirectoryClientContactProfile } from './project-alpha-directory-profile-api-v2';
import { resolveDirectoryPortalSource,aliasWorkspaceWitnessSql } from './portal-directory-correspondence';
import { manageSharedProfilePortalGrant,portalGrantSchema,sharedProfileCorrespondenceColumns,sharedProfileGrantSourceCurrent,type SharedProfilePortalGrant } from './shared-profile-portal-authority';
import { readSharedProfileAuthorityRecoveryStatus, recoverSharedProfileAuthority } from './shared-profile-authority-recovery';

type Bindings = { Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } };
type C = Context<Bindings>;
export type SharedProfileMember = { recordId: string; kind: 'organization'|'client'; version: number; profile: Record<string,string>;
  sourceIds: string[]; parentRecordId: string|null; relationshipVersion: number|null; parentVersion: number|null };
export const NATIVE_DIRECTORY_SHARED_PROFILE_ROUTE = '/api/client-hub/shared-profiles';
const pairSchema = z.object({recordIds:z.array(canonicalRecordId).length(2),primaryRecordId:canonicalRecordId}).strict();
const confirmSchema = z.object({previewToken:mutationId,mutationId}).strict();
const bootstrapSchema = z.object({recordId:canonicalRecordId,mutationId}).strict();
const recoverySchema = z.object({operationId:mutationId}).strict();
const patchSchema = z.object({mutationId,expectedVersion:z.number().int().positive(),expectedMembers:z.array(z.object({
  recordId:canonicalRecordId,version:z.number().int().positive()}).strict()).min(1).max(2),profile:z.record(z.string(),z.string())}).strict();
const fail = (reason:string):never => {throw new HTTPException(409,{message:reason});};
async function body<T>(c:C,schema:z.ZodType<T>):Promise<T>{const result=schema.safeParse(await readBoundedJson(c.req.raw,24*1024,'Shared profile'));
  if(!result.success)throw new HTTPException(400,{message:'shared_profile_request_invalid'});return result.data;}
function keyed(c:C,id:string,field='mutationId'){if(c.req.header('Idempotency-Key')!==id)throw new HTTPException(400,{message:`Idempotency-Key must match ${field}`});}
async function hash(v:unknown){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v))))].map(b=>b.toString(16).padStart(2,'0')).join('');}
function normalized(kind:Member['kind'],v:unknown){const checked=(kind==='organization'?organizationProfile:clientUpdateProfile).safeParse(v);
  if(!checked.success)fail('shared_profile_fields_invalid');return normalizeProfile(checked.data as Record<string,string>);}
async function member(c:C,id:string,edit=true):Promise<Member>{
  const actor=await nativeActor(c),session=c.env.OPS_DB.withSession('first-primary');
  const r=await session.prepare(`SELECT r.record_kind kind,r.current_version version,v.profile_json FROM operations_directory_records r
    JOIN operations_directory_revisions v ON v.record_id=r.record_id AND v.version=r.current_version WHERE r.record_id=?`).bind(id)
    .first<{kind:Member['kind'];version:number;profile_json:string}>();
  if(!r)throw new HTTPException(404,{message:'Directory record not found'});
  if(!await selectGrant(c.env.OPS_DB,actor.staffId,'directory.profile.view',id,[],false))throw new HTTPException(403,{message:'Directory profile view permission required'});
  if(edit){await actorWithGrants(c,r.kind,id,[],false,actor);
    if(!await selectGrant(c.env.OPS_DB,actor.staffId,'directory.identity.link',id,[],false))throw new HTTPException(403,{message:'Directory identity-link permission required'});}
  const enrollment=await session.prepare('SELECT destinations_json FROM effective_native_directory_enrollments WHERE record_id=?').bind(id).first<string>('destinations_json');
  let sourceIds:string[];try{const values=JSON.parse(enrollment??'null') as {sourceId:string}[];sourceIds=values.map(v=>v.sourceId).sort();
    if(!sourceIds.length||new Set(sourceIds).size!==sourceIds.length)fail('source_authority_unavailable');}catch{fail('source_authority_unavailable');}
  if(edit&&!await updateDestinations(c.env,r.kind,id,r.version))fail('source_authority_unavailable');
  let raw:Record<string,string>;try{raw=JSON.parse(r.profile_json);}catch{fail('shared_profile_fields_invalid');}
  if(r.kind==='client')delete raw!.clientType;
  const relationship=r.kind==='client'?await currentClientRelationship(c.env.OPS_DB,id):null;
  if(r.kind==='client'&&!relationship)fail('relationship_state_unavailable');
  const parentRecordId=relationship?.organization_record_id??null;
  const parentVersion=parentRecordId?await session.prepare("SELECT current_version FROM operations_directory_records WHERE record_id=? AND record_kind='organization'").bind(parentRecordId).first<number>('current_version'):null;
  if(parentRecordId&&!parentVersion)fail('relationship_state_unavailable');
  return {recordId:id,kind:r.kind,version:r.version,profile:normalized(r.kind,raw!),sourceIds:sourceIds!,
    parentRecordId,relationshipVersion:relationship?.relationship_version??null,parentVersion};
}
async function pair(c:C,ids:readonly string[]){
  if(ids.length!==2||new Set(ids).size!==2)fail('shared_profile_pair_invalid');
  const members=await Promise.all([...ids].sort().map(id=>member(c,id)));
  if(members[0]!.kind!==members[1]!.kind||members[0]!.sourceIds.some(s=>members[1]!.sourceIds.includes(s)))fail('shared_profile_source_overlap');
  if(members[0]!.kind==='client'){
    const parents=members.map(m=>m.parentRecordId);
    if(parents.some(Boolean)){
      if(!parents.every(Boolean))fail('shared_profile_parent_mismatch');
      const groups=await Promise.all(parents.map(id=>c.env.OPS_DB.prepare('SELECT group_id FROM native_directory_shared_profile_members WHERE record_id=?').bind(id).first<string>('group_id')));
      if(!groups[0]||groups[0]!==groups[1])fail('shared_profile_parent_mismatch');
    }
  }
  return members;
}
async function canMerge(c:C){if(!c.get('administrator'))return false;const actor=await nativeActor(c);
  for(const permission of ['directory.profile.edit','directory.identity.link']){
    if(!await c.env.OPS_DB.prepare(`SELECT 1 FROM native_directory_grants WHERE staff_id=? AND permission=? AND effect='allow' AND active=1 AND scope_kind='global'`)
      .bind(actor.staffId,permission).first())return false;
    if(await c.env.OPS_DB.prepare(`SELECT 1 FROM native_directory_grants WHERE staff_id=? AND permission=? AND effect='deny' AND active=1`)
      .bind(actor.staffId,permission).first())return false;
  }return true;}
async function requireMerge(c:C){if(!await canMerge(c))throw new HTTPException(403,{message:'Shared profile merge permission required'});}
async function identitySafeContactReady(c:C,members:readonly Member[]):Promise<boolean>{
  const sources=[...new Set(members.flatMap(m=>m.sourceIds))];
  if(!sources.length)return false;
  const probes=await Promise.all(sources.map(source=>probeConfiguredProjectAlphaDirectoryClientContactProfile(c.env,source)));
  return probes.every(probe=>probe.status==='verified');
}
type Member = SharedProfileMember;
type CreationActor=Awaited<ReturnType<typeof nativeActor>>;
export function sharedProfileCreationFence(db:D1Database,input:{groupId:string;mutationId:string;mode:'single'|'pair';requestSha256:string;
  actor:CreationActor;kind:Member['kind'];profile:Record<string,string>;members:Member[];previewToken:string|null}) {
  return db.prepare(`INSERT INTO native_directory_shared_profile_creation_fences
    (group_id,mutation_id,mode,request_sha256,actor_id,access_subject,admission_version,profile_version,login_email,kind,profile_json,membership_json,members_json,preview_token)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.groupId,input.mutationId,input.mode,input.requestSha256,input.actor.staffId,
      input.actor.accessSubject,input.actor.admissionVersion,input.actor.profileVersion,input.actor.loginEmail,input.kind,
      JSON.stringify(input.profile),JSON.stringify(input.members.map(m=>m.recordId)),JSON.stringify(input.members),input.previewToken);
}
export function sharedProfileCreationStatements(db:D1Database,groupId:string,kind:Member['kind'],profile:Record<string,string>,members:Member[],actorId:string){
  const profileJson=JSON.stringify(profile);
  return [db.prepare('INSERT INTO native_directory_shared_profiles(id,kind,profile_json,membership_json,created_by) VALUES(?,?,?,?,?)')
      .bind(groupId,kind,profileJson,JSON.stringify(members.map(m=>m.recordId)),actorId),
    ...members.map(m=>db.prepare(`INSERT INTO native_directory_shared_profile_members(record_id,group_id,initial_version,initial_parent_record_id,initial_relationship_version)
      VALUES(?,?,?,?,?)`).bind(m.recordId,groupId,m.version,m.parentRecordId,m.relationshipVersion)),
    db.prepare('INSERT INTO native_directory_shared_profile_revisions(group_id,version,profile_json) VALUES(?,1,?)').bind(groupId,profileJson)];
}
export async function nativeDirectorySharedProfileDelivery(db:D1Database,groupId:string){
  const row=await db.prepare(`SELECT members_json FROM native_directory_shared_profile_commands WHERE group_id=? ORDER BY expected_version DESC LIMIT 1`)
    .bind(groupId).first<{members_json:string}>();
  if(!row)return {state:'acknowledged' as const,destinations:[]};
  const commands=JSON.parse(row.members_json) as {recordId:string;mutationId:string}[];
  const materializationSource=await directoryMaterializationReadSource(db);
  const destinations=[] as {recordId:string;sourceId:string;state:'acknowledged'|'pending'|'conflict'}[];
  for(const m of commands){const rows=(await db.prepare(`SELECT o.source_id,o.state FROM project_alpha_directory_outbox o
    JOIN ${materializationSource} materialization ON materialization.command_id=o.command_id
    JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id WHERE intent.mutation_id=?`).bind(m.mutationId)
    .all<{source_id:string;state:string}>()).results;
    if(!rows.length)destinations.push({recordId:m.recordId,sourceId:'',state:'conflict'});
    for(const r of rows)destinations.push({recordId:m.recordId,sourceId:r.source_id,state:r.state==='acknowledged'?'acknowledged':['terminal','dead_letter'].includes(r.state)?'conflict':'pending'});
  }
  return {state:destinations.some(d=>d.state==='conflict')?'conflict' as const:destinations.every(d=>d.state==='acknowledged')?'acknowledged' as const:'pending' as const,destinations};
}
export type SharedProfilePortalSetupCandidate={workspaceId:string;sourceId:string;portalSourceId?:string;correspondenceRevisionId?:string;
 principalPublicId:string;targetPublicId:string;recordId:string;groupId:string;clientName:string;
 state:'available'|'enabled'|'revoked'|'suspended';currentGrantId?:string;currentGrantRevision?:number};
export async function sharedProfilePortalSetup(c:C,groupId:string,members:readonly Member[],identitySafe:boolean){
  if(!await canMerge(c))return{available:false,candidates:[] as SharedProfilePortalSetupCandidate[]};
  return readSharedProfilePortalSetup(c.env,groupId,members,identitySafe);
}
/** Read-only candidate discovery. Mutations independently revalidate the
 * saved/native owner and exact principal/client authority in their issuer. */
export async function readSharedProfilePortalSetup(env:Env,groupId:string,members:readonly SharedProfileMember[],identitySafe:boolean){
  const candidates:SharedProfilePortalSetupCandidate[]=[];
  if(members.some(m=>m.kind!=='client'))return{available:false,candidates};
  try{
    const db=env.OPS_DB.withSession('first-primary'),bridgeColumns=await sharedProfileCorrespondenceColumns(db);
    for(const member of members){
      const stored=(await db.prepare("SELECT * FROM shared_profile_portal_grants WHERE group_id=? AND record_id=? AND target_type='client' ORDER BY id LIMIT 65")
        .bind(groupId,member.recordId).all<SharedProfilePortalGrant&{state:string}>()).results;
      if(stored.length>64)return{available:false,candidates:[]};
      const seen=new Set<string>();
      const mappings=(await db.prepare("SELECT source_id,project_alpha_public_id,source_instance_id,application_id,history_epoch_id FROM project_alpha_active_directory_mappings WHERE record_id=? AND resource_type='client' ORDER BY source_id")
        .bind(member.recordId).all<{source_id:string;project_alpha_public_id:string;source_instance_id:string;application_id:string;history_epoch_id:string}>()).results;
      for(const mapping of mappings){
        if(!member.sourceIds.includes(mapping.source_id))continue;
        const resolved=await resolveDirectoryPortalSource(env,mapping.source_id,{sourceInstanceId:mapping.source_instance_id,applicationId:mapping.application_id,historyEpochId:mapping.history_epoch_id});
        if(!resolved||(resolved.correspondenceRevisionId&&!bridgeColumns))continue;
        const rows=(await env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT w.id workspaceId,p.public_id principalPublicId,e.public_id targetPublicId
          FROM portal_v2_workspaces w JOIN pa_portal_workspace_sources s ON s.workspace_id=w.id AND s.projection_source_id=w.project_alpha_source_id
          JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=w.id
          JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=w.id AND generation.status='active' AND generation.complete=1
          ${resolved.correspondenceRevisionId?`JOIN portal_v2_directory_entities root ON root.workspace_id=w.id AND root.generation_id=generation.id AND root.active=1 AND root.parent_public_id IS NULL
            AND ((w.root_type='organization' AND root.entity_type='organization' AND root.public_id=w.pa_organization_public_id)
              OR (w.root_type='standalone_client' AND root.entity_type IN('client','standalone_client') AND root.public_id=w.pa_client_public_id))`:''}
          JOIN pa_portal_principals p ON p.workspace_id=w.id AND p.status='active'
          JOIN portal_v2_directory_entities e ON e.workspace_id=w.id AND e.generation_id=generation.id AND e.public_id=? AND e.active=1 AND e.entity_type IN('client','standalone_client')
          WHERE w.project_alpha_source_id=? AND w.status='active' ${resolved.correspondenceRevisionId?`AND ${aliasWorkspaceWitnessSql('w')}`:''}
          ${resolved.correspondenceRevisionId?"AND ((w.root_type='organization' AND e.parent_public_id=root.public_id) OR (w.root_type='standalone_client' AND e.public_id=root.public_id AND e.parent_public_id IS NULL))":''}
          AND EXISTS(SELECT 1 FROM pa_portal_entitlement_intents entitlement WHERE entitlement.workspace_id=w.id
            AND entitlement.principal_public_id=p.public_id AND entitlement.scope_type='client' AND entitlement.scope_public_id=e.public_id
            AND entitlement.effect='allow' AND entitlement.capability='directory.read' AND entitlement.status='active'
            AND (entitlement.valid_from IS NULL OR datetime(entitlement.valid_from)<=datetime('now'))
            AND (entitlement.expires_at IS NULL OR datetime(entitlement.expires_at)>datetime('now'))) ORDER BY w.id,p.public_id LIMIT 65`)
          .bind(mapping.project_alpha_public_id,resolved.portalSourceId).all<{workspaceId:string;principalPublicId:string;targetPublicId:string}>()).results;
        if(rows.length>64)return{available:false,candidates:[]};
        for(const row of rows){
          const prior=stored.find(g=>g.workspace_id===row.workspaceId&&(g.directory_source_id??g.source_id)===mapping.source_id&&g.principal_public_id===row.principalPublicId&&g.target_public_id===row.targetPublicId);
          if(prior)seen.add(prior.id);
          const current=prior&&JSON.stringify(JSON.parse(prior.group_membership_json).slice().sort())===JSON.stringify(members.map(m=>m.recordId).sort())&&prior.source_instance_id===mapping.source_instance_id&&prior.application_id===mapping.application_id&&prior.history_epoch_id===mapping.history_epoch_id&&await sharedProfileGrantSourceCurrent(env,prior);
          const sourceFields=prior?.directory_source_id?{portalSourceId:prior.source_id,correspondenceRevisionId:prior.correspondence_revision_id!}:
            resolved.correspondenceRevisionId?{portalSourceId:resolved.portalSourceId,correspondenceRevisionId:resolved.correspondenceRevisionId}:{};
          candidates.push({...row,sourceId:mapping.source_id,...sourceFields,recordId:member.recordId,groupId,clientName:member.profile.name!,
            state:prior?.state==='revoked'?'revoked':prior?(current?'enabled':'suspended'):'available',...(prior?{currentGrantId:prior.id,currentGrantRevision:prior.revision}:{})});
        }
      }
      // Retain exact old authority for explicit unlink even when its producer/root is unavailable.
      for(const prior of stored){if(seen.has(prior.id))continue;
        candidates.push({workspaceId:prior.workspace_id,sourceId:prior.directory_source_id??prior.source_id,
          ...(prior.directory_source_id?{portalSourceId:prior.source_id,correspondenceRevisionId:prior.correspondence_revision_id!}:{}),
          principalPublicId:prior.principal_public_id,targetPublicId:prior.target_public_id,recordId:member.recordId,groupId,clientName:member.profile.name!,
          state:prior.state==='revoked'?'revoked':'suspended',currentGrantId:prior.id,currentGrantRevision:prior.revision});
      }
      if(candidates.length>64)return{available:false,candidates:[]};
    }
    return{available:identitySafe,candidates};
  }catch{return{available:false,candidates:[]};}
}
async function readGroup(c:C,groupId:string){
  const g=await c.env.OPS_DB.prepare('SELECT id,kind,version,profile_json,membership_json FROM native_directory_shared_profiles WHERE id=?').bind(groupId)
    .first<{id:string;kind:Member['kind'];version:number;profile_json:string;membership_json:string}>();
  if(!g)throw new HTTPException(404,{message:'Shared profile not found'});
  // Reads still require authority on every linked profile; none are inferred by email.
  const members=await Promise.all((JSON.parse(g.membership_json) as string[]).map(id=>member(c,id,false)));
  let editable=true;const actor=await nativeActor(c);for(const m of members){try{await actorWithGrants(c,m.kind,m.recordId,[],false,actor);}catch(error){if(!(error instanceof HTTPException))throw error;editable=false;}}
  const identitySafe=g.kind!=='client'||await identitySafeContactReady(c,members);
  return {id:g.id,kind:g.kind,version:g.version,profile:JSON.parse(g.profile_json),members:members.map(({profile:_,...m})=>m),
    emailEditing:identitySafe,emailEditingReason:identitySafe?null:'identity_safe_contact_profile_unavailable',
    portalSetup:await sharedProfilePortalSetup(c,g.id,members,identitySafe),
    editing:{available:editable&&identitySafe,reason:!identitySafe?'identity_safe_contact_profile_unavailable':editable?null:'directory_edit_permission_required'},delivery:await nativeDirectorySharedProfileDelivery(c.env.OPS_DB,g.id)};
}
export function registerNativeDirectorySharedProfileRoutes(app:Hono<Bindings>){const route=NATIVE_DIRECTORY_SHARED_PROFILE_ROUTE;
  app.use(`${route}/*`,async(c,next)=>{if(!nativeDirectoryProfileWritesEnabled(c.env))throw new HTTPException(404,{message:'Not found'});
    c.header('Cache-Control','no-store');await nativeActor(c);await next();});
  app.get(`${route}/authority-recovery`,async c=>{
    await requireMerge(c);
    return c.json(await readSharedProfileAuthorityRecoveryStatus(c.env,c.get('principal')));
  });
  app.post(`${route}/authority-recovery`,async c=>{
    await requireMerge(c);const input=await body(c,recoverySchema);keyed(c,input.operationId,'operationId');
    const result=await recoverSharedProfileAuthority(c.env,c.get('principal'),input);
    if(!result.ok)return c.json(result,result.code==='denied'?403:result.code==='invalid'?400:result.code==='unavailable'?503:409);
    return c.json(result);
  });
  app.get(`${route}/records/:recordId`,async c=>{const id=canonicalRecordId.parse(c.req.param('recordId'));const record=await member(c,id,false);
    const group=await c.env.OPS_DB.prepare('SELECT group_id FROM native_directory_shared_profile_members WHERE record_id=?').bind(id).first<string>('group_id');
    const owner=await canMerge(c);return c.json({sharedProfile:group?await readGroup(c,group):null,canMerge:owner,canBootstrap:!group&&record.kind==='client'&&owner});});
  app.post(`${route}/bootstrap`,async c=>{await requireMerge(c);const input=await body(c,bootstrapSchema);keyed(c,input.mutationId);
    const actor=await nativeActor(c),requestSha256=await hash(input);
    const prior=await c.env.OPS_DB.prepare('SELECT group_id,request_sha256,actor_id,mode FROM native_directory_shared_profile_creation_fences WHERE mutation_id=?')
      .bind(input.mutationId).first<{group_id:string;request_sha256:string;actor_id:string;mode:string}>();
    if(prior){if(prior.request_sha256!==requestSha256||prior.actor_id!==actor.staffId||prior.mode!=='single')fail('idempotency_body_conflict');
      return c.json({replayed:true,sharedProfile:await readGroup(c,prior.group_id)});}
    const m=await member(c,input.recordId),existing=await c.env.OPS_DB.prepare('SELECT group_id FROM native_directory_shared_profile_members WHERE record_id=?')
      .bind(input.recordId).first<string>('group_id');
    if(existing)fail('record_already_grouped');
    const groupId=input.mutationId;
    try{await c.env.OPS_DB.batch([sharedProfileCreationFence(c.env.OPS_DB,{groupId,mutationId:input.mutationId,mode:'single',requestSha256,
      actor,kind:m.kind,profile:m.profile,members:[m],previewToken:null}),...sharedProfileCreationStatements(c.env.OPS_DB,groupId,m.kind,m.profile,[m],actor.staffId)]);}
    catch{fail('shared_membership_changed');}
    return c.json({replayed:false,sharedProfile:await readGroup(c,groupId)},201);
  });
  app.post(`${route}/portal-grants`,async c=>{await requireMerge(c);const input=await body(c,portalGrantSchema);keyed(c,input.operationId,'operationId');
    const result=await manageSharedProfilePortalGrant(c.env,c.get('principal'),input);
    if(!result.ok||!Number.isSafeInteger(result.revision)||result.revision!<1)return c.json({ok:false},409);
    return c.json({ok:true,revision:result.revision},201);
  });
  app.get(`${route}/candidates`,async c=>{await requireMerge(c);const kind=c.req.query('kind');if(!['organization','client'].includes(kind??''))throw new HTTPException(400,{message:'kind_invalid'});
    const exclude=c.req.query('excludeRecordId')??'',q=(c.req.query('q')??'').trim();if(q.length>150)throw new HTTPException(400,{message:'query_invalid'});
    const rows=(await c.env.OPS_DB.prepare(`SELECT r.record_id FROM operations_directory_records r JOIN operations_directory_revisions v ON v.record_id=r.record_id AND v.version=r.current_version
      WHERE r.record_kind=? AND r.record_id<>? AND NOT EXISTS(SELECT 1 FROM native_directory_shared_profile_members m WHERE m.record_id=r.record_id)
      AND instr(lower(json_extract(v.profile_json,'$.name')),lower(?))>0 ORDER BY json_extract(v.profile_json,'$.name'),r.record_id LIMIT 100`).bind(kind,exclude,q).all<{record_id:string}>()).results;
    const current=exclude?await member(c,exclude,false):null,candidates=[] as {recordId:string;kind:string;name:string;version:number;sourceIds:string[]}[];
    for(const row of rows){try{const m=await member(c,row.record_id,false),actor=await nativeActor(c);await actorWithGrants(c,m.kind,m.recordId,[],false,actor);
      if(!await selectGrant(c.env.OPS_DB,actor.staffId,'directory.identity.link',m.recordId,[],false))continue;
      if(current&&m.sourceIds.some(s=>current.sourceIds.includes(s)))continue;
      candidates.push({recordId:m.recordId,kind:m.kind,name:m.profile.name!,version:m.version,sourceIds:m.sourceIds});}catch(error){if(!(error instanceof HTTPException))throw error;}
      if(candidates.length===25)break;}return c.json({candidates});});
  app.post(`${route}/preview`,async c=>{await requireMerge(c);const input=await body(c,pairSchema);if(!input.recordIds.includes(input.primaryRecordId))fail('primary_record_invalid');
    const members=await pair(c,input.recordIds);for(const m of members)if(await c.env.OPS_DB.prepare('SELECT 1 FROM native_directory_shared_profile_members WHERE record_id=?').bind(m.recordId).first())fail('record_already_grouped');
    const primary=members.find(m=>m.recordId===input.primaryRecordId)!,differences=Object.keys(primary.profile).filter(k=>members.some(m=>m.profile[k]!==primary.profile[k]));
    const previewToken=crypto.randomUUID(),expiresAt=new Date(Date.now()+5*60_000).toISOString(),actor=await nativeActor(c);
    const proof={members,primaryRecordId:input.primaryRecordId,profile:primary.profile,kind:primary.kind,differences,actor};
    await c.env.OPS_DB.prepare('INSERT INTO native_directory_shared_profile_previews(token,actor_id,proof_json,expires_at) VALUES(?,?,?,?)')
      .bind(previewToken,actor.staffId,JSON.stringify(proof),expiresAt).run();
    return c.json({previewToken,expiresAt,...proof,canConfirm:differences.length===0});});
  app.post(`${route}/confirm`,async c=>{await requireMerge(c);const input=await body(c,confirmSchema);keyed(c,input.mutationId);const actor=await nativeActor(c);
    const saved=await c.env.OPS_DB.prepare('SELECT * FROM native_directory_shared_profile_previews WHERE token=? AND actor_id=?').bind(input.previewToken,actor.staffId)
      .first<{proof_json:string;expires_at:string;confirmed_mutation_id:string|null;group_id:string|null}>();
    if(!saved)throw new HTTPException(409,{message:'shared_preview_unavailable'});if(saved.confirmed_mutation_id){if(saved.confirmed_mutation_id!==input.mutationId)fail('idempotency_body_conflict');return c.json({status:'linked',replayed:true,sharedProfile:await readGroup(c,saved.group_id!)});}
    if(!Number.isFinite(Date.parse(saved.expires_at))||Date.parse(saved.expires_at)<=Date.now())fail('shared_preview_expired');
    const proof=JSON.parse(saved.proof_json) as {members:Member[];profile:Record<string,string>;kind:Member['kind'];differences:string[];actor:CreationActor};
    if(!Array.isArray(proof.members)||!Array.isArray(proof.differences)||JSON.stringify(proof.actor)!==JSON.stringify(actor))fail('shared_preview_changed');
    const members=await pair(c,proof.members.map(m=>m.recordId));if(JSON.stringify(members)!==JSON.stringify(proof.members))fail('shared_preview_changed');if(proof.differences.length)fail('shared_profiles_differ');
    const groupId=crypto.randomUUID(),requestSha256=await hash(input);
    try{await c.env.OPS_DB.batch([
      sharedProfileCreationFence(c.env.OPS_DB,{groupId,mutationId:input.mutationId,mode:'pair',requestSha256,actor,kind:proof.kind,profile:proof.profile,members,previewToken:input.previewToken}),
      ...sharedProfileCreationStatements(c.env.OPS_DB,groupId,proof.kind,proof.profile,members,actor.staffId),
      c.env.OPS_DB.prepare('UPDATE native_directory_shared_profile_previews SET confirmed_mutation_id=?,group_id=? WHERE token=? AND confirmed_mutation_id IS NULL').bind(input.mutationId,groupId,input.previewToken),
    ]);}catch{fail('shared_membership_changed');}return c.json({status:'linked',replayed:false,sharedProfile:await readGroup(c,groupId)},201);});
  app.patch(`${route}/:groupId`,async c=>{const input=await body(c,patchSchema);keyed(c,input.mutationId);const groupId=mutationId.parse(c.req.param('groupId'));
    const g=await c.env.OPS_DB.prepare('SELECT kind,version,membership_json FROM native_directory_shared_profiles WHERE id=?').bind(groupId)
      .first<{kind:Member['kind'];version:number;membership_json:string}>();if(!g)throw new HTTPException(404,{message:'Shared profile not found'});
    const profile=normalized(g.kind,input.profile),expected=[...input.expectedMembers].sort((a,b)=>a.recordId.localeCompare(b.recordId));
    if(JSON.stringify(expected.map(v=>v.recordId))!==g.membership_json)fail('shared_membership_changed');
    const identitySafeContactProfile=g.kind==='client';
    if(identitySafeContactProfile&&!await identitySafeContactReady(c,await Promise.all(expected.map(v=>member(c,v.recordId,false)))))fail('identity_safe_contact_profile_unavailable');
    const actor=await nativeActor(c),requestSha256=await hash({groupId,...input,expectedMembers:expected,profile,identitySafeContactProfile});
    const prior=await c.env.OPS_DB.prepare('SELECT request_sha256,actor_id FROM native_directory_shared_profile_commands WHERE mutation_id=?').bind(input.mutationId).first<{request_sha256:string;actor_id:string}>();
    if(prior){for(const v of expected){const m=await member(c,v.recordId,false);await actorWithGrants(c,m.kind,m.recordId,[],false,actor);}if(prior.request_sha256!==requestSha256||prior.actor_id!==actor.staffId)fail('idempotency_body_conflict');return c.json({status:'written',replayed:true,sharedProfile:await readGroup(c,groupId)});}
    if(g.version!==input.expectedVersion)fail('shared_profile_changed');if((await nativeDirectorySharedProfileDelivery(c.env.OPS_DB,groupId)).state!=='acknowledged')fail('shared_delivery_unsettled');
    const members=expected.length===2?await pair(c,expected.map(v=>v.recordId)):[await member(c,expected[0]!.recordId)],writes=[] as NativeDirectoryUpdateWrite[];
    for(const m of members){const version=expected.find(v=>v.recordId===m.recordId)!.version;if(version!==m.version)fail('shared_member_changed');
      const destinations=await updateDestinations(c.env,m.kind,m.recordId,m.version);if(!destinations)fail('source_authority_unavailable');
      const base={operation:'update' as const,mutationId:await derivedUuid(input.mutationId+'\0'+m.recordId),recordId:m.recordId,expectedLocalVersion:m.version,
        actor:await actorWithGrants(c,m.kind,m.recordId,[],false,actor),destinations,profile};
      writes.push(m.kind==='client'?{...base,kind:'client',profile:profile as NativeDirectoryUpdateWrite['profile'],relationship:{organizationRecordId:m.parentRecordId,expectedRelationshipVersion:m.relationshipVersion!}} as NativeDirectoryUpdateWrite
        :{...base,kind:'organization',profile:profile as NativeDirectoryUpdateWrite['profile']} as NativeDirectoryUpdateWrite);
    }
    const result=await writeNativeDirectorySharedProfiles(c.env.OPS_DB,{groupId,mutationId:input.mutationId,expectedVersion:input.expectedVersion,requestSha256,profile,writes,identitySafeContactProfile},c.env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED==='true');
    if(result.status!=='written')return c.json(result,409);return c.json({...result,sharedProfile:await readGroup(c,groupId)});
  });
}
async function derivedUuid(seed:string){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(seed))).slice(0,16);
  bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;const h=[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
