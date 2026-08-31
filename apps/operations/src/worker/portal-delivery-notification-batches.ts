import { HTTPException } from "hono/http-exception";
import { createCatalogSourceContext, PRIMARY_ALPHA_SOURCE_ID } from "@ltds/shared";
import { d1TablesPresent } from "./schema-readiness";
import { sendNotificationMail } from "./mailer";
import { resolveProjectAlphaDeliveryPrincipalProof } from "./share-recipients";
import type { Env } from "./types";

export const NATIVE_NOTIFICATION_TABLES = ["portal_delivery_notification_batches", "portal_delivery_notification_items", "portal_delivery_notification_controls"] as const;
export type NativeNotificationStatus = "pending" | "processing" | "sent" | "cancelled" | "suppressed" | "failed";
export interface NativeNotificationIdentity {
  source_id: string; workspace_id: string; folder_binding_id: string; binding_source_version: string;
  principal_public_id: string; principal_source_version: string; owner_scope_type: "organization" | "department" | "client" | "project";
  owner_public_id: string; r2_prefix: string;
}
export interface NativeBatch extends NativeNotificationIdentity {
  id: string; revision: number; status: NativeNotificationStatus; eligible_at: string; attempt_count: number;
  sealed_at: string | null; lease_token: string | null; lease_expires_at: string | null;
  dispatch_fingerprint: string | null; published_recipient_email: string | null; published_at: string | null; delivered_at: string | null;
  last_error: string | null; created_at: string; updated_at: string;
}
export interface NativeBindingFacts { workspace_name: string; owner_name: string; generation_id: string }
export type NativeWriteGuard = { sql: string; bindings: (string | number | null)[] };

export const nativeDeliveryNotificationsReady = (env: Env) => d1TablesPresent(env.DELIVERY_DB, NATIVE_NOTIFICATION_TABLES);
export async function nativeNotificationHash(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value)))].map(v=>v.toString(16).padStart(2,"0")).join("");
}
function bindingGuard(row:NativeNotificationIdentity,requireActiveSource:boolean):NativeWriteGuard{
  const sourceAuthority=!requireActiveSource||row.source_id===PRIMARY_ALPHA_SOURCE_ID?"1":`EXISTS(
    SELECT 1 FROM pa_portal_source_authorities authority
    JOIN pa_portal_source_authority_revisions revision ON revision.source_id=authority.source_id
      AND revision.revision=authority.active_revision
    WHERE authority.source_id=workspace.project_alpha_source_id AND authority.state='active')`;
  return { sql: `EXISTS(SELECT 1 FROM portal_v2_folder_bindings binding
    JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.status='active'
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities owner ON owner.workspace_id=workspace.id AND owner.generation_id=generation.id
      AND owner.entity_type=binding.owner_scope_type AND owner.public_id=binding.owner_public_id
      AND owner.active=1 AND owner.source_version=binding.source_version
    WHERE workspace.project_alpha_source_id=? AND (${sourceAuthority})
      AND workspace.id=? AND binding.id=? AND binding.source_version=? AND binding.owner_scope_type=?
      AND binding.owner_public_id=? AND binding.r2_prefix=?
      AND binding.status='active' AND binding.revoked_at IS NULL)`,
    bindings: [row.source_id,row.workspace_id,row.folder_binding_id,row.binding_source_version,row.owner_scope_type,row.owner_public_id,row.r2_prefix] };
}
export function nativeBindingGuard(row: NativeNotificationIdentity): NativeWriteGuard {
  return bindingGuard(row,true);
}
export async function readNativeBinding(env: Env,row: NativeNotificationIdentity): Promise<NativeBindingFacts|null> {
  // Staff history follows connector read visibility. Suspending ingestion must
  // stop future publication without erasing already-projected audit records.
  const guard=bindingGuard(row,false);
  return env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT workspace.display_name workspace_name,owner.display_name owner_name,
    checkpoint.active_generation_id generation_id FROM portal_v2_workspaces workspace
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
    JOIN portal_v2_directory_entities owner ON owner.workspace_id=workspace.id AND owner.generation_id=checkpoint.active_generation_id
      AND owner.entity_type=? AND owner.public_id=? WHERE workspace.id=? AND ${guard.sql}`)
    .bind(row.owner_scope_type,row.owner_public_id,row.workspace_id,...guard.bindings).first<NativeBindingFacts>();
}

const stageTarget = `SELECT outbox.id,receipt.project_alpha_source_id source_id,grant_row.workspace_id,grant_row.folder_binding_id,
  grant_row.binding_source_version,grant_row.grant_version,outbox.principal_public_id,outbox.principal_source_version,
  binding.owner_scope_type,binding.owner_public_id,binding.r2_prefix
  FROM project_alpha_delivery_portal_notification_outbox outbox
  JOIN project_alpha_delivery_intent_receipts receipt ON receipt.receipt_id=outbox.receipt_id AND receipt.access_mode='portal' AND receipt.resource_id=outbox.grant_id
  JOIN project_alpha_delivery_portal_grants grant_row ON grant_row.id=outbox.grant_id
    AND grant_row.audience_type='principal' AND grant_row.audience_public_id=outbox.principal_public_id
    AND grant_row.audience_source_version=outbox.principal_source_version
  JOIN portal_v2_workspaces workspace ON workspace.id=grant_row.workspace_id AND workspace.project_alpha_source_id=receipt.project_alpha_source_id
  JOIN portal_v2_folder_bindings binding ON binding.id=grant_row.folder_binding_id AND binding.workspace_id=workspace.id
  WHERE outbox.id=?1 AND outbox.event_type='granted' AND outbox.status='pending' AND outbox.attempt_count=0 AND outbox.lease_expires_at IS NULL
    AND NOT EXISTS(SELECT 1 FROM portal_delivery_notification_items item WHERE item.outbox_id=outbox.id)`;
const sameBatch = `batch.source_id=target.source_id AND batch.workspace_id=target.workspace_id
  AND batch.folder_binding_id=target.folder_binding_id AND batch.binding_source_version=target.binding_source_version
  AND batch.principal_public_id=target.principal_public_id AND batch.principal_source_version=target.principal_source_version`;

/** Append after the intent's outbox INSERT in the SAME D1 transaction. No
 * recipient lookup/selection or grant mutation occurs here. The item trigger
 * and old-row transition make adoption mutually exclusive with direct claims. */
export function stagePortalDeliveryNotificationStatements(db: Pick<D1Database,"prepare">,outboxId: string): D1PreparedStatement[] {
  const token=crypto.randomUUID(),id=crypto.randomUUID();
  return [
    db.prepare(`WITH target AS (${stageTarget}) UPDATE portal_delivery_notification_batches AS batch
      SET sealed_at=datetime('now'),revision=revision+1,updated_at=datetime('now')
      WHERE batch.status='pending' AND batch.sealed_at IS NULL AND EXISTS(SELECT 1 FROM target WHERE ${sameBatch})
      AND (SELECT count(*) FROM portal_delivery_notification_items item WHERE item.batch_id=batch.id)>=50`).bind(outboxId),
    db.prepare(`WITH target AS (${stageTarget}) INSERT INTO portal_delivery_notification_batches
      (id,source_id,workspace_id,folder_binding_id,binding_source_version,principal_public_id,principal_source_version,owner_scope_type,owner_public_id,r2_prefix)
      SELECT ?2,source_id,workspace_id,folder_binding_id,binding_source_version,principal_public_id,principal_source_version,owner_scope_type,owner_public_id,r2_prefix FROM target WHERE 1
      ON CONFLICT(source_id,workspace_id,folder_binding_id,binding_source_version,principal_public_id,principal_source_version)
        WHERE status='pending' AND sealed_at IS NULL DO NOTHING`).bind(outboxId,id),
    db.prepare(`WITH target AS (${stageTarget}) INSERT INTO portal_delivery_notification_items(outbox_id,batch_id,grant_version,staging_token)
      SELECT target.id,batch.id,target.grant_version,?2 FROM target JOIN portal_delivery_notification_batches batch ON ${sameBatch}
      WHERE batch.status='pending' AND batch.sealed_at IS NULL`).bind(outboxId,token),
    db.prepare(`UPDATE portal_delivery_notification_batches SET eligible_at=datetime('now','+5 minutes'),revision=revision+1,updated_at=datetime('now')
      WHERE status='pending' AND sealed_at IS NULL AND id IN(SELECT batch_id FROM portal_delivery_notification_items WHERE staging_token=?)`).bind(token),
    db.prepare(`UPDATE project_alpha_delivery_portal_notification_outbox SET status='suppressed',last_error='native-batch-staged',updated_at=datetime('now')
      WHERE id=? AND status='pending' AND attempt_count=0 AND lease_expires_at IS NULL
      AND EXISTS(SELECT 1 FROM portal_delivery_notification_items item WHERE item.outbox_id=project_alpha_delivery_portal_notification_outbox.id)`).bind(outboxId),
  ];
}
const SOURCE_AUTHORITY_TABLES = ["pa_portal_source_authorities","pa_portal_source_authority_revisions"] as const;
const SOURCE_READY_INDEXES = ["idx_portal_delivery_notification_source_pending","idx_portal_delivery_notification_source_processing",
  "idx_portal_delivery_notification_pending_exhausted","idx_portal_delivery_notification_processing_exhausted"] as const;
async function sourceReadyIndexesPresent(env:Env):Promise<boolean>{
  const placeholders=SOURCE_READY_INDEXES.map(()=>"?").join(",");
  const row=await env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT count(*) count FROM sqlite_master WHERE type='index' AND name IN (${placeholders})`,
  ).bind(...SOURCE_READY_INDEXES).first<{count:number}>();
  return Number(row?.count||0)===SOURCE_READY_INDEXES.length;
}
async function registeredNotificationSources(env:Env):Promise<string[]> {
  if(!await d1TablesPresent(env.DELIVERY_DB,SOURCE_AUTHORITY_TABLES))return [PRIMARY_ALPHA_SOURCE_ID];
  const registered=await env.DELIVERY_DB.withSession("first-primary")
    .prepare("SELECT source_id FROM pa_portal_source_authorities WHERE source_id<>? ORDER BY source_id LIMIT 31")
    .bind(PRIMARY_ALPHA_SOURCE_ID)
    .all<{source_id:string}>();
  return [PRIMARY_ALPHA_SOURCE_ID,...registered.results.map(row=>row.source_id)];
}
export async function scheduledNotificationSources(env:Env,lane:"staged"|"direct"):Promise<string[]>{
  const sources=await registeredNotificationSources(env);
  const column=lane==="staged"?"staged_last_source_id":"direct_last_source_id";
  const cursor=await env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT ${column} value FROM portal_delivery_notification_scheduler WHERE id='source-round-robin'`,
  ).first<string>("value");
  if(!cursor)return sources;
  const position=sources.indexOf(cursor);
  return position<0?sources:[...sources.slice(position+1),...sources.slice(0,position+1)];
}
export async function advanceNotificationSourceSchedule(env:Env,lane:"staged"|"direct",sourceId:string):Promise<void>{
  const column=lane==="staged"?"staged_last_source_id":"direct_last_source_id";
  await env.DELIVERY_DB.prepare(`UPDATE portal_delivery_notification_scheduler
    SET ${column}=?,revision=revision+1,updated_at=datetime('now') WHERE id='source-round-robin'`).bind(sourceId).run();
}
export async function adoptPortalDeliveryNotifications(env: Env): Promise<number> {
  const db=env.DELIVERY_DB.withSession("first-primary");
  // Adoption is a one-way upgrade bridge for primary rows created before the
  // native batch schema existed. Registered-source writes were introduced
  // after this schema and stage in the same D1 transaction, so they never
  // enter this legacy backlog. Keep the recovery scan globally indexed and
  // bounded instead of pretending a receipt join is a source-ready index.
  const rows=await db.prepare(`SELECT outbox.id FROM project_alpha_delivery_portal_notification_outbox outbox
    JOIN project_alpha_delivery_intent_receipts receipt ON receipt.receipt_id=outbox.receipt_id
      AND receipt.project_alpha_source_id='${PRIMARY_ALPHA_SOURCE_ID}'
    WHERE outbox.event_type='granted' AND outbox.status='pending' AND outbox.attempt_count=0 AND outbox.lease_expires_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM portal_delivery_notification_items item WHERE item.outbox_id=outbox.id)
    ORDER BY outbox.created_at,outbox.id LIMIT 20`).all<{id:string}>();
  if(rows.results.length)await db.batch(rows.results.flatMap(row=>stagePortalDeliveryNotificationStatements(db,row.id)));
  return rows.results.length;
}

function liveItemsSql():string { return `SELECT DISTINCT grant_row.id,grant_row.grant_version,grant_row.expires_at
  FROM portal_delivery_notification_items item
  JOIN project_alpha_delivery_portal_notification_outbox outbox ON outbox.id=item.outbox_id
  JOIN project_alpha_delivery_intent_receipts receipt ON receipt.receipt_id=outbox.receipt_id AND receipt.access_mode='portal' AND receipt.resource_id=outbox.grant_id
  JOIN project_alpha_delivery_portal_grants grant_row ON grant_row.id=outbox.grant_id
  WHERE item.batch_id=? AND grant_row.grant_version=item.grant_version AND grant_row.status='active' AND grant_row.revoked_at IS NULL
    AND (grant_row.expires_at IS NULL OR datetime(grant_row.expires_at)>datetime('now'))
    AND receipt.project_alpha_source_id=? AND grant_row.workspace_id=? AND grant_row.folder_binding_id=?
    AND grant_row.binding_source_version=? AND grant_row.audience_public_id=? AND grant_row.audience_source_version=?
  ORDER BY grant_row.id LIMIT 51`; }
export async function authorizePortalDeliveryNotificationBatch(env:Env,row:NativeBatch):Promise<{
  recipientEmail:string; recipientIdentity:string; binding:NativeBindingFacts; guard:NativeWriteGuard; authorityFingerprint:string;
}|null>{
  if(env.CLIENT_PORTAL_HIERARCHY_V2_ENABLED!=="true"||env.AUTHENTICATED_DELIVERY_GRANTS_ENABLED!=="true")return null;
  const binding=await readNativeBinding(env,row);if(!binding)return null;
  let proof: Awaited<ReturnType<typeof resolveProjectAlphaDeliveryPrincipalProof>>;
  try { proof=await resolveProjectAlphaDeliveryPrincipalProof(env,row.r2_prefix,row.principal_public_id,row.principal_source_version,row.binding_source_version,createCatalogSourceContext(row.source_id)); }
  catch(error){if(error instanceof HTTPException)return null;throw error;}
  if(proof.audience.workspaceId!==row.workspace_id||proof.audience.folderBindingId!==row.folder_binding_id
    ||proof.audience.directoryGenerationId!==binding.generation_id)return null;
  const args=[row.id,row.source_id,row.workspace_id,row.folder_binding_id,row.binding_source_version,row.principal_public_id,row.principal_source_version];
  const items=(await env.DELIVERY_DB.withSession("first-primary").prepare(liveItemsSql()).bind(...args).all<{id:string;grant_version:number;expires_at:string|null}>()).results;
  if(!items.length||items.length>50)return null;
  const itemFacts=JSON.stringify(items),bindingGuard=nativeBindingGuard(row);
  const guard={sql:`${bindingGuard.sql} AND ${proof.guard.sql}
    AND (SELECT json_group_array(json_object('id',id,'grant_version',grant_version,'expires_at',expires_at)) FROM (${liveItemsSql()}))=?`,
    bindings:[...bindingGuard.bindings,...proof.guard.bindings,...args,itemFacts]};
  return {recipientEmail:proof.identity.email,recipientIdentity:JSON.stringify(proof.identity),binding,guard,
    authorityFingerprint:await nativeNotificationHash(JSON.stringify([row.source_id,row.workspace_id,row.folder_binding_id,row.binding_source_version,
      row.principal_public_id,row.principal_source_version,row.owner_scope_type,row.owner_public_id,row.r2_prefix,proof.identity,items]))};
}

const escapeHtml=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
async function finish(env:Env,row:NativeBatch,status:"sent"|"suppressed"|"pending"|"failed",reason:string|null):Promise<void>{
  await env.DELIVERY_DB.batch([
    env.DELIVERY_DB.prepare(`UPDATE portal_delivery_notification_batches SET status=?,revision=revision+1,
      eligible_at=CASE WHEN ?='pending' THEN datetime('now',?) ELSE eligible_at END,
      delivered_at=CASE WHEN ?='sent' THEN datetime('now') ELSE delivered_at END,
      lease_token=NULL,lease_expires_at=NULL,last_error=?,updated_at=datetime('now')
      WHERE id=? AND status='processing' AND lease_token=?`).bind(status,status,`+${2**row.attempt_count*5} minutes`,status,reason,row.id,row.lease_token),
    env.DELIVERY_DB.prepare(`INSERT INTO audit_log(actor_type,actor_id,action,entity_type,entity_id,details_json)
      SELECT 'system','native-delivery-notifier',?,'portal_delivery_notification_batch',?,? WHERE changes()=1`)
      .bind(`portal.delivery.notification.${status}`,row.id,JSON.stringify({attempt:row.attempt_count,reason})),
  ]);
}
export async function processPortalDeliveryNotificationBatches(env:Env):Promise<number>{
  if(!await nativeDeliveryNotificationsReady(env))return 0;
  await adoptPortalDeliveryNotifications(env);
  const sourceIndexesReady=await sourceReadyIndexesPresent(env);
  const exhausted=sourceIndexesReady?(await Promise.all([
    env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id FROM portal_delivery_notification_batches
      INDEXED BY idx_portal_delivery_notification_pending_exhausted
      WHERE status='pending' AND attempt_count>=3 AND eligible_at<=datetime('now')
      ORDER BY eligible_at,created_at,id LIMIT 50`).all<{id:string}>(),
    env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id FROM portal_delivery_notification_batches
      INDEXED BY idx_portal_delivery_notification_processing_exhausted
      WHERE status='processing' AND attempt_count>=3 AND lease_expires_at<=datetime('now')
      ORDER BY lease_expires_at,created_at,id LIMIT 50`).all<{id:string}>(),
  ])).flatMap(result=>result.results):[];
  if(exhausted.length)await env.DELIVERY_DB.batch(exhausted.map(row=>env.DELIVERY_DB.prepare(`UPDATE portal_delivery_notification_batches
    SET status='failed',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,last_error='attempts-exhausted',updated_at=datetime('now')
    WHERE id=? AND attempt_count>=3 AND ((status='processing' AND datetime(lease_expires_at)<=datetime('now'))
      OR (status='pending' AND datetime(eligible_at)<=datetime('now')))` ).bind(row.id)));
  const db=env.DELIVERY_DB.withSession("first-primary");
  const candidates:NativeBatch[]=[];
  if(!sourceIndexesReady){
    // Safe deploy-before-migration compatibility. The bounded fair selector
    // becomes active as soon as migration 0182 creates its source indexes.
    const authoritiesReady=await d1TablesPresent(env.DELIVERY_DB,SOURCE_AUTHORITY_TABLES);
    const compatibleSource=authoritiesReady?"1":`source_id='${PRIMARY_ALPHA_SOURCE_ID}'`;
    candidates.push(...(await db.prepare(`SELECT * FROM portal_delivery_notification_batches WHERE attempt_count<3 AND ${compatibleSource}
      AND ((status='pending' AND datetime(eligible_at)<=datetime('now'))
      OR (status='processing' AND datetime(lease_expires_at)<=datetime('now'))) ORDER BY created_at,id LIMIT 10`)
      .all<NativeBatch>()).results);
  }else{
    // Suspended sources remain in this bounded set so already-staged work can
    // be terminally suppressed by the final authority guard. The authority
    // table itself caps registered sources at 31; primary makes at most 32.
    const sources=await scheduledNotificationSources(env,"staged");
    const groups=(await Promise.all(sources.map(async source=>{
      const rows=await db.prepare(`SELECT * FROM (
          SELECT * FROM portal_delivery_notification_batches INDEXED BY idx_portal_delivery_notification_source_pending
          WHERE source_id=?1 AND status='pending' AND attempt_count<3 AND eligible_at<=datetime('now')
          ORDER BY eligible_at,created_at,id LIMIT 10
        ) UNION ALL SELECT * FROM (
          SELECT * FROM portal_delivery_notification_batches INDEXED BY idx_portal_delivery_notification_source_processing
          WHERE source_id=?1 AND status='processing' AND attempt_count<3 AND lease_expires_at<=datetime('now')
          ORDER BY lease_expires_at,created_at,id LIMIT 10
        )`).bind(source).all<NativeBatch>();
      return rows.results.sort((left,right)=>left.created_at.localeCompare(right.created_at)||left.id.localeCompare(right.id));
    })));
    for(let rank=0;rank<20&&candidates.length<10;rank++){
      const round=groups.flatMap(group=>group[rank]?[group[rank]!]:[]);
      candidates.push(...round.slice(0,10-candidates.length));
    }
    const lastSource=candidates.at(-1)?.source_id;
    if(lastSource)await advanceNotificationSourceSchedule(env,"staged",lastSource);
  }
  let processed=0;
  for(const row of candidates){
    const token=crypto.randomUUID();
    const claim=await env.DELIVERY_DB.prepare(`UPDATE portal_delivery_notification_batches SET status='processing',revision=revision+1,
      attempt_count=attempt_count+1,sealed_at=COALESCE(sealed_at,datetime('now')),lease_token=?,lease_expires_at=datetime('now','+15 minutes'),updated_at=datetime('now')
      WHERE id=? AND revision=? AND attempt_count<3 AND ((status='pending' AND datetime(eligible_at)<=datetime('now'))
      OR (status='processing' AND datetime(lease_expires_at)<=datetime('now')))` ).bind(token,row.id,row.revision).run();
    if(!claim.meta.changes)continue;
    processed++;row.lease_token=token;row.attempt_count++;
    try{
      const auth=await authorizePortalDeliveryNotificationBatch(env,row);
      if(!auth){await finish(env,row,'suppressed','no-longer-eligible');continue;}
      const url=new URL('/portal/deliveries',env.DELIVERY_BASE_URL);url.searchParams.set('workspace',row.workspace_id);
      const mail={to:auth.recipientEmail,fromName:'LTDS Client Delivery',subject:'Delivery available in your portal',
        text:`A delivery is available in your LTDS portal.\n\nOpen the portal: ${url.href}`,
        html:`<p>A delivery is available in your LTDS portal.</p><p><a href="${escapeHtml(url.href)}">Open the portal</a></p>`,messageIdKey:`native-batch-${row.id}`};
      const fingerprint=await nativeNotificationHash(JSON.stringify([auth.authorityFingerprint,mail]));
      if(row.dispatch_fingerprint&&row.dispatch_fingerprint!==fingerprint){await finish(env,row,'suppressed','publication-context-changed');continue;}
      const publish=await env.DELIVERY_DB.prepare(`UPDATE portal_delivery_notification_batches
        SET dispatch_fingerprint=COALESCE(dispatch_fingerprint,?),published_recipient_email=COALESCE(published_recipient_email,?),published_at=COALESCE(published_at,datetime('now')),updated_at=datetime('now')
        WHERE id=? AND status='processing' AND lease_token=? AND datetime(lease_expires_at)>datetime('now')
        AND (dispatch_fingerprint IS NULL OR dispatch_fingerprint=?) AND ${auth.guard.sql}`)
        .bind(fingerprint,auth.recipientEmail,row.id,token,fingerprint,...auth.guard.bindings).run();
      if(!publish.meta.changes){await finish(env,row,'suppressed','publication-context-changed');continue;}
      // Provider submission is outside D1; a lost acknowledgement retains the
      // same sealed content/Message-ID. Never promise exactly-once SMTP mail.
      await sendNotificationMail(env,mail);
      await finish(env,row,'sent',null);
    }catch(error){
      await finish(env,row,row.attempt_count>=3?'failed':'pending','delivery-attempt-failed');
    }
  }
  return processed;
}
