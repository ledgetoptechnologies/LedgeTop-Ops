import { HTTPException } from "hono/http-exception";
import type { Env } from "./types";

const SEARCH_LIMIT = 12;
const GROUP_RECIPIENT_LIMIT = 100;
export type AudienceType = "organization" | "department" | "client" | "project" | "principal";
export type ShareRecipient = { principalPublicId: string; displayName: string; email: string };
export type ShareAudienceOption = { audienceType: AudienceType; publicId: string; displayName: string; email?: string; recipientCount?: number };
export type ShareAudienceSnapshot = {
  workspaceId: string; folderBindingId: string;
  ownerScopeType: Exclude<AudienceType, "principal">; ownerPublicId: string; directoryGenerationId: string;
  audienceType: AudienceType; audiencePublicId: string; audienceDisplayName: string;
  recipients: ShareRecipient[];
};
type BindingContext = Pick<ShareAudienceSnapshot, "workspaceId" | "folderBindingId" | "ownerScopeType" | "ownerPublicId" | "directoryGenerationId">;

export function shareDirectoryRecipientsEnabled(env: Pick<Env, "DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED">): boolean {
  return env.DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED === "true";
}

async function bindingContext(env: Env, prefix: string): Promise<BindingContext> {
  const rows = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT binding.id folder_binding_id,binding.workspace_id,binding.owner_scope_type,binding.owner_public_id,checkpoint.active_generation_id directory_generation_id,length(binding.r2_prefix) prefix_length
    FROM portal_v2_folder_bindings binding JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.status='active'
      AND workspace.project_alpha_source_id='project-alpha:primary'
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=binding.workspace_id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=binding.workspace_id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities owner ON owner.workspace_id=binding.workspace_id AND owner.generation_id=checkpoint.active_generation_id AND owner.entity_type=binding.owner_scope_type AND owner.public_id=binding.owner_public_id AND owner.active=1
    WHERE binding.status='active' AND substr(?,1,length(binding.r2_prefix))=binding.r2_prefix ORDER BY length(binding.r2_prefix) DESC,binding.id LIMIT 2`).bind(prefix).all<{
      folder_binding_id:string;workspace_id:string;owner_scope_type:BindingContext["ownerScopeType"];owner_public_id:string;directory_generation_id:string;prefix_length:number;
    }>();
  const first=rows.results[0];
  if(!first)throw new HTTPException(409,{message:"This folder is not bound to an active client directory"});
  if(rows.results[1]?.prefix_length===first.prefix_length)throw new HTTPException(409,{message:"This folder has an ambiguous client directory binding"});
  return{workspaceId:first.workspace_id,folderBindingId:first.folder_binding_id,ownerScopeType:first.owner_scope_type,ownerPublicId:first.owner_public_id,directoryGenerationId:first.directory_generation_id};
}

function ancestryCte(){return `WITH RECURSIVE owner_ancestry(entity_type,public_id,parent_public_id,display_name,depth) AS (
  SELECT entity_type,public_id,parent_public_id,display_name,0 FROM portal_v2_directory_entities WHERE workspace_id=? AND generation_id=? AND public_id=? AND entity_type=? AND active=1
  UNION ALL SELECT parent.entity_type,parent.public_id,parent.parent_public_id,parent.display_name,owner_ancestry.depth+1 FROM portal_v2_directory_entities parent JOIN owner_ancestry ON owner_ancestry.parent_public_id=parent.public_id
  WHERE parent.workspace_id=? AND parent.generation_id=? AND parent.active=1 AND owner_ancestry.depth<12)`;}
function contextBindings(context:BindingContext){return[context.workspaceId,context.directoryGenerationId,context.ownerPublicId,context.ownerScopeType,context.workspaceId,context.directoryGenerationId];}

async function authorizedRecipients(env:Env,context:BindingContext,query:string|null,exactId:string|null,limit=100):Promise<ShareRecipient[]>{
  const normalized=query?.trim().toLowerCase()||null,like=normalized?`%${normalized.replace(/[\\%_]/g,v=>`\\${v}`)}%`:null;
  const rows=await env.DELIVERY_DB.withSession("first-primary").prepare(`${ancestryCte()}
    SELECT principal.public_id,principal.display_name,lower(trim(principal.email_hint)) normalized_email FROM pa_portal_principals principal
    WHERE principal.workspace_id=? AND principal.status='active' AND length(trim(principal.email_hint)) BETWEEN 3 AND 320 AND instr(principal.email_hint,'@')>1
      AND (? IS NULL OR principal.public_id=?) AND (? IS NULL OR lower(principal.display_name) LIKE ? ESCAPE '\\' OR lower(principal.email_hint) LIKE ? ESCAPE '\\')
      AND EXISTS (SELECT 1 FROM pa_portal_entitlement_intents intent WHERE intent.workspace_id=principal.workspace_id AND intent.principal_public_id=principal.public_id AND intent.capability='delivery.view' AND intent.effect='allow' AND intent.status='active' AND datetime(intent.valid_from)<=datetime('now') AND (intent.expires_at IS NULL OR datetime(intent.expires_at)>datetime('now')) AND ((intent.scope_type='workspace' AND intent.scope_public_id=principal.workspace_id) OR intent.scope_public_id IN (SELECT public_id FROM owner_ancestry)))
      AND NOT EXISTS (SELECT 1 FROM pa_portal_entitlement_intents intent WHERE intent.workspace_id=principal.workspace_id AND intent.principal_public_id=principal.public_id AND intent.capability='delivery.view' AND intent.effect='deny' AND intent.status='active' AND datetime(intent.valid_from)<=datetime('now') AND (intent.expires_at IS NULL OR datetime(intent.expires_at)>datetime('now')) AND ((intent.scope_type='workspace' AND intent.scope_public_id=principal.workspace_id) OR intent.scope_public_id IN (SELECT public_id FROM owner_ancestry)))
    ORDER BY lower(principal.display_name),principal.public_id LIMIT ?`).bind(...contextBindings(context),context.workspaceId,exactId,exactId,normalized,like,like,limit*2).all<{public_id:string;display_name:string;normalized_email:string}>();
  const seen=new Set<string>();return rows.results.flatMap(row=>{if(seen.has(row.normalized_email))return[];seen.add(row.normalized_email);return[{principalPublicId:row.public_id,displayName:row.display_name,email:row.normalized_email}];}).slice(0,limit);
}

export async function searchShareRecipients(env:Env,prefix:string,queryValue:string):Promise<{audiences:ShareAudienceOption[]}>{
  if(!shareDirectoryRecipientsEnabled(env))throw new HTTPException(404,{message:"Not found"});
  const query=queryValue.trim();if(query.length<2||query.length>100)throw new HTTPException(400,{message:"Search must be between 2 and 100 characters"});
  const context=await bindingContext(env,prefix),like=`%${query.toLowerCase().replace(/[\\%_]/g,v=>`\\${v}`)}%`;
  const [entities,principals]=await Promise.all([
    env.DELIVERY_DB.withSession("first-primary").prepare(`${ancestryCte()} SELECT entity_type,public_id,display_name FROM owner_ancestry WHERE entity_type IN ('organization','department','client','project') AND lower(display_name) LIKE ? ESCAPE '\\' ORDER BY depth,lower(display_name) LIMIT ?`).bind(...contextBindings(context),like,SEARCH_LIMIT).all<{entity_type:Exclude<AudienceType,"principal">;public_id:string;display_name:string}>(),
    authorizedRecipients(env,context,query,null,SEARCH_LIMIT),
  ]);
  return{audiences:[...entities.results.map(row=>({audienceType:row.entity_type,publicId:row.public_id,displayName:row.display_name})),...principals.map(row=>({audienceType:"principal" as const,publicId:row.principalPublicId,displayName:row.displayName,email:row.email,recipientCount:1}))].slice(0,SEARCH_LIMIT)};
}

export async function resolveShareAudience(env:Env,prefix:string,audienceType:AudienceType,publicIdValue:string):Promise<ShareAudienceSnapshot>{
  if(!shareDirectoryRecipientsEnabled(env))throw new HTTPException(404,{message:"Not found"});
  const publicId=publicIdValue.trim();if(!publicId||publicId.length>128)throw new HTTPException(400,{message:"Recipient selection is invalid"});
  const context=await bindingContext(env,prefix);let audienceDisplayName="",recipients:ShareRecipient[];
  if(audienceType==="principal"){
    recipients=await authorizedRecipients(env,context,null,publicId,1);if(!recipients.length||recipients[0]!.principalPublicId!==publicId)throw new HTTPException(404,{message:"Recipient is not available for this folder"});audienceDisplayName=recipients[0]!.displayName;
  }else{
    const entity=await env.DELIVERY_DB.withSession("first-primary").prepare(`${ancestryCte()} SELECT display_name FROM owner_ancestry WHERE entity_type=? AND public_id=? LIMIT 1`).bind(...contextBindings(context),audienceType,publicId).first<{display_name:string}>();
    if(!entity)throw new HTTPException(404,{message:"Audience is not available for this folder"});audienceDisplayName=entity.display_name;recipients=await authorizedRecipients(env,context,null,null,GROUP_RECIPIENT_LIMIT+1);
    if(!recipients.length)throw new HTTPException(409,{message:"This audience has no authorized active notification recipients"});
    if(recipients.length>GROUP_RECIPIENT_LIMIT)throw new HTTPException(409,{message:"This audience is too large for one delivery notification group"});
  }
  return{...context,audienceType,audiencePublicId:publicId,audienceDisplayName,recipients};
}

export async function resolveProjectAlphaDeliveryPrincipal(env:Env,prefix:string,publicIdValue:string,sourceVersion:string):Promise<ShareAudienceSnapshot>{
  const publicId=publicIdValue.trim();if(!publicId||publicId.length>128)throw new HTTPException(400,{message:"Recipient selection is invalid"});
  const context=await bindingContext(env,prefix),rows=await env.DELIVERY_DB.withSession("first-primary").prepare(`${ancestryCte()} SELECT DISTINCT
    principal.display_name,identity.id identity_id,identity.issuer,identity.subject,lower(identity.verified_email) verified_email
    FROM pa_portal_principals principal
    JOIN portal_v2_identities identity ON identity.status='active' AND identity.revoked_at IS NULL
      AND (identity.id=principal.identity_id OR EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_bindings eligibility
        WHERE eligibility.identity_id=identity.id AND eligibility.workspace_id=principal.workspace_id
          AND eligibility.principal_public_id=principal.public_id AND eligibility.principal_source_version=principal.source_version
          AND eligibility.verified_email=identity.verified_email))
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=principal.workspace_id
      AND membership.identity_id=identity.id AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    WHERE principal.workspace_id=? AND principal.public_id=? AND principal.source_version=? AND principal.status='active'
      AND lower(trim(principal.email_hint))=lower(identity.verified_email)
      AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks block WHERE block.status='active'
        AND datetime(block.valid_from)<=datetime('now') AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))
        AND ((block.match_type='issuer_subject' AND block.issuer=identity.issuer AND block.subject=identity.subject)
          OR (block.match_type='email' AND block.normalized_email=identity.verified_email)))
      AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_denials denial WHERE denial.identity_id=identity.id
        AND denial.status='active' AND denial.revoked_at IS NULL AND datetime(denial.valid_from)<=datetime('now')
        AND (denial.expires_at IS NULL OR datetime(denial.expires_at)>datetime('now'))
        AND (denial.scope_type='global' OR (denial.workspace_id=principal.workspace_id AND
          ((denial.scope_type='workspace' AND denial.scope_public_id=principal.workspace_id)
           OR (denial.scope_type='folder' AND denial.scope_public_id=?)
           OR EXISTS(SELECT 1 FROM owner_ancestry WHERE entity_type=denial.scope_type AND public_id=denial.scope_public_id))))) LIMIT 2`)
    .bind(...contextBindings(context),context.workspaceId,publicId,sourceVersion,context.folderBindingId)
    .all<{display_name:string;identity_id:string;issuer:string;subject:string;verified_email:string}>();
  let eligible=rows.results;
  if(!eligible.length&&env.CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED==="true"){
    const unclaimed=await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT display_name,
      lower(trim(email_hint)) verified_email FROM pa_portal_principals principal
      WHERE workspace_id=? AND public_id=? AND source_version=? AND status='active' AND identity_id IS NULL
        AND length(trim(email_hint)) BETWEEN 3 AND 254 AND instr(email_hint,'@')>1
        AND NOT EXISTS(SELECT 1 FROM portal_v2_identity_eligibility_blocks block WHERE block.match_type='email'
          AND block.normalized_email=lower(trim(principal.email_hint)) AND block.status='active' AND datetime(block.valid_from)<=datetime('now')
          AND (block.expires_at IS NULL OR datetime(block.expires_at)>datetime('now'))) LIMIT 2`)
      .bind(context.workspaceId,publicId,sourceVersion).all<{display_name:string;verified_email:string}>();
    eligible=unclaimed.results.map(row=>({...row,identity_id:"",issuer:"",subject:""}));
  }
  if(eligible.length!==1)throw new HTTPException(409,{message:"Delivery recipient is not uniquely eligible"});
  const recipient=eligible[0]!;
  return{...context,audienceType:"principal",audiencePublicId:publicId,audienceDisplayName:recipient.display_name,
    recipients:[{principalPublicId:publicId,displayName:recipient.display_name,email:recipient.verified_email}]};
}

export async function latestShareAudienceSnapshot(env:Env,shareId:string):Promise<ShareAudienceSnapshot|null>{
  const db=env.DELIVERY_DB.withSession("first-primary"),audience=await db.prepare(`SELECT snapshot.workspace_id,snapshot.folder_binding_id,snapshot.owner_scope_type,snapshot.owner_public_id,snapshot.directory_generation_id,snapshot.audience_type,snapshot.audience_public_id,snapshot.audience_display_name,snapshot.share_version
    FROM shares share JOIN delivery_share_audience_snapshots snapshot
      ON snapshot.share_id=share.id AND snapshot.share_version=share.share_version
    WHERE share.id=? LIMIT 1`).bind(shareId).first<any>();
  if(!audience)return null;const members=await db.prepare("SELECT recipient_principal_public_id,recipient_display_name,recipient_normalized_email FROM delivery_share_recipient_members WHERE share_id=? AND share_version=? ORDER BY lower(recipient_display_name),recipient_principal_public_id").bind(shareId,audience.share_version).all<any>();
  return{workspaceId:audience.workspace_id,folderBindingId:audience.folder_binding_id,ownerScopeType:audience.owner_scope_type,ownerPublicId:audience.owner_public_id,directoryGenerationId:audience.directory_generation_id,audienceType:audience.audience_type,audiencePublicId:audience.audience_public_id,audienceDisplayName:audience.audience_display_name,recipients:members.results.map((row:any)=>({principalPublicId:row.recipient_principal_public_id,displayName:row.recipient_display_name,email:row.recipient_normalized_email}))};
}

export function shareAudienceSnapshotStatements(env:Env,shareId:string,version:number,audience:ShareAudienceSnapshot,staffId:string,guardChanges=false):D1PreparedStatement[]{
  const verb=guardChanges?"SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE changes()=1":"VALUES (?,?,?,?,?,?,?,?,?,?,?)";
  const parent=env.DELIVERY_DB.prepare(`INSERT INTO delivery_share_audience_snapshots(share_id,share_version,workspace_id,folder_binding_id,owner_scope_type,owner_public_id,directory_generation_id,audience_type,audience_public_id,audience_display_name,selected_by_staff_id) ${verb}`).bind(shareId,version,audience.workspaceId,audience.folderBindingId,audience.ownerScopeType,audience.ownerPublicId,audience.directoryGenerationId,audience.audienceType,audience.audiencePublicId,audience.audienceDisplayName,staffId);
  return[parent,...audience.recipients.map(member=>env.DELIVERY_DB.prepare(`INSERT INTO delivery_share_recipient_members(share_id,share_version,recipient_principal_public_id,recipient_display_name,recipient_normalized_email) SELECT ?,?,?,?,? WHERE changes()=1`).bind(shareId,version,member.principalPublicId,member.displayName,member.email))];
}
