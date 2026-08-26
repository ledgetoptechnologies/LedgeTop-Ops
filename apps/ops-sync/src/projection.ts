import type { EntitlementEvent, Env, IntegrationEvent, ProjectionEvent } from "./types";
import {
  PRIMARY_PROJECT_ALPHA_SOURCE,
  createProjectAlphaSourceContext,
  mapProjectAlphaSourceRow,
  prepareProjectAlphaSourceRecords,
  projectAlphaSourceReferences,
  type ProjectAlphaSourceContext,
} from "../../operations/src/worker/project-alpha-source";

export type ProjectionResult = "applied" | "duplicate" | "ignored";

function staffId(userId: string): string { return `staff-pa-${userId.replace(/[^a-zA-Z0-9_-]/g, "-")}`; }

const PROJECTION_LEASE_DURATION = "+10 minutes";
const GLOBAL_PROJECTION_ENTITY_TYPE = "integration_projection";
const GLOBAL_PROJECTION_ENTITY_ID = "project-alpha";

async function claimGlobalProjection(env: Env, source: ProjectAlphaSourceContext, ownerEventId: string): Promise<void> {
  const claimed = await env.OPS_DB.prepare(`INSERT INTO pa_projection_entity_leases (projection_source_id,entity_type,entity_id,owner_event_id,lease_until)
    VALUES (?,?,?,?,datetime('now',?))
    ON CONFLICT(projection_source_id,entity_type,entity_id) DO UPDATE SET owner_event_id=excluded.owner_event_id,lease_until=excluded.lease_until,updated_at=datetime('now')
    WHERE datetime(pa_projection_entity_leases.lease_until)<=datetime('now')
    RETURNING owner_event_id`)
    .bind(source.sourceId,GLOBAL_PROJECTION_ENTITY_TYPE,GLOBAL_PROJECTION_ENTITY_ID,ownerEventId,PROJECTION_LEASE_DURATION)
    .first<{owner_event_id:string}>();
  if(claimed?.owner_event_id!==ownerEventId)throw new Error("projection-global-busy");
}

async function releaseGlobalProjection(env: Env, source: ProjectAlphaSourceContext, ownerEventId: string): Promise<void> {
  await env.OPS_DB.prepare("DELETE FROM pa_projection_entity_leases WHERE projection_source_id=? AND entity_type=? AND entity_id=? AND owner_event_id=?")
    .bind(source.sourceId,GLOBAL_PROJECTION_ENTITY_TYPE,GLOBAL_PROJECTION_ENTITY_ID,ownerEventId).run();
}

async function refreshGlobalProjection(env:Env,source:ProjectAlphaSourceContext,ownerEventId:string):Promise<void>{
  const refreshed=await env.OPS_DB.prepare(`UPDATE pa_projection_entity_leases SET lease_until=datetime('now',?),updated_at=datetime('now')
    WHERE projection_source_id=? AND entity_type=? AND entity_id=? AND owner_event_id=? RETURNING owner_event_id`)
    .bind(PROJECTION_LEASE_DURATION,source.sourceId,GLOBAL_PROJECTION_ENTITY_TYPE,GLOBAL_PROJECTION_ENTITY_ID,ownerEventId)
    .first<{owner_event_id:string}>();
  if(refreshed?.owner_event_id!==ownerEventId)throw new Error("projection-global-lease-lost");
}

async function applyEntitlementEventLocked(env: Env, source: ProjectAlphaSourceContext, event: EntitlementEvent, payloadHash: string): Promise<ProjectionResult> {
  const receipt = await env.OPS_DB.prepare("SELECT payload_hash,status FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?").bind(source.sourceId,event.event_id).first<{ payload_hash: string; status: string }>();
  if (receipt) {
    if (receipt.payload_hash !== payloadHash) throw new Error("event-id-conflict");
    if (receipt.status === "completed" || receipt.status === "ignored") return "duplicate";
  } else {
    await env.OPS_DB.prepare(`INSERT INTO integration_event_receipts (projection_source_id,event_id,integration,event_type,user_id,occurred_at,payload_hash,status) VALUES (?,?,'project-alpha',?,?,?,?, 'pending')`)
      .bind(source.sourceId,event.event_id,event.event_type,event.user.id,event.occurred_at,payloadHash).run();
  }

  const ids = await prepareProjectAlphaSourceRecords(env.OPS_DB,source,[
    {kind:"user",externalId:event.user.id},
    {kind:"application_entitlement",externalId:`entitlement-${event.user.id}`},
  ]);
  const userId = ids.get("user",event.user.id);
  const entitlementId = ids.get("application_entitlement",`entitlement-${event.user.id}`);
  const latest = await env.OPS_DB.prepare("SELECT last_event_at FROM pa_application_entitlements WHERE projection_source_id=? AND user_id=?").bind(source.sourceId,userId).first<{ last_event_at: string | null }>();
  if (latest?.last_event_at && (Date.parse(event.occurred_at) < Date.parse(latest.last_event_at) || (!receipt && Date.parse(event.occurred_at) === Date.parse(latest.last_event_at)))) {
    await env.OPS_DB.prepare("UPDATE integration_event_receipts SET status='ignored',processed_at=datetime('now'),last_error=NULL WHERE projection_source_id=? AND event_id=?").bind(source.sourceId,event.event_id).run();
    return "ignored";
  }

  const enabled = event.entitlement.enabled && event.user.active && event.event_type !== "application_entitlement.revoked";
  const syncMarker = `event:${event.event_id}`;
  await env.OPS_DB.batch([
    env.OPS_DB.prepare(`INSERT INTO pa_users (projection_source_id,id,email,display_name,role,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now') WHERE pa_users.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,userId,event.user.email,event.user.display_name,null,event.user.active?1:0,JSON.stringify(event.user),syncMarker),
    env.OPS_DB.prepare(`INSERT INTO pa_application_entitlements (projection_source_id,id,user_id,application_key,enabled,role_key,business_unit_ids_json,payload_json,last_event_at,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?,?,?,1) ON CONFLICT(user_id) DO UPDATE SET application_key=excluded.application_key,enabled=excluded.enabled,role_key=excluded.role_key,business_unit_ids_json=excluded.business_unit_ids_json,payload_json=excluded.payload_json,last_event_at=excluded.last_event_at,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now') WHERE pa_application_entitlements.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,entitlementId,userId,event.entitlement.application_key,enabled?1:0,event.entitlement.role_key,JSON.stringify(event.entitlement.business_unit_ids),JSON.stringify(event.entitlement),event.occurred_at,syncMarker),
  ]);

  const protectedStaff = await env.OPS_DB.prepare("SELECT id FROM staff_users WHERE lower(email)=? AND sync_protected=1").bind(event.user.email).first<{ id: string }>();
  if (!protectedStaff) {
    const existing = await env.OPS_DB.prepare("SELECT id FROM staff_users WHERE project_alpha_user_id=? OR lower(email)=? ORDER BY CASE WHEN project_alpha_user_id=? THEN 0 ELSE 1 END LIMIT 1").bind(event.user.id,event.user.email,event.user.id).first<{ id: string }>();
    const id = existing?.id ?? staffId(event.user.id);
    await env.OPS_DB.batch([
      env.OPS_DB.prepare(`INSERT INTO staff_users (id,email,display_name,project_alpha_user_id,status,provisioning_source) VALUES (?,?,?,?,?,'project-alpha') ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,project_alpha_user_id=excluded.project_alpha_user_id,status=excluded.status,provisioning_source='project-alpha',access_subject=CASE WHEN excluded.status='inactive' THEN NULL ELSE access_subject END,updated_at=datetime('now')`).bind(id,event.user.email,event.user.display_name,event.user.id,enabled?"active":"inactive"),
      env.OPS_DB.prepare("DELETE FROM staff_role_assignments WHERE staff_id=? AND role_id<>'role-owner'").bind(id),
      env.OPS_DB.prepare("DELETE FROM staff_divisions WHERE staff_id=?").bind(id),
    ]);
    if (enabled) {
      const roleKey = event.entitlement.role_key;
      if (roleKey === "role-admin") {
        await env.OPS_DB.prepare("INSERT INTO staff_role_assignments (id,staff_id,role_id,scope,division_id,scope_key) VALUES (?,?,'role-admin','global',NULL,'global') ON CONFLICT(id) DO NOTHING")
          .bind(`assignment-pa-${event.user.id}-global`,id).run();
      } else {
        // Keep incremental authorization identical to daily recovery: PA
        // assignments grant visibility; non-admin entitlement labels do not.
        await env.OPS_DB.prepare("INSERT INTO staff_role_assignments (id,staff_id,role_id,scope,division_id,scope_key) VALUES (?,?,'role-operator','assigned',NULL,'assigned') ON CONFLICT(id) DO NOTHING")
          .bind(`assignment-pa-${event.user.id}-assigned`,id).run();
      }
    }
  }
  return "applied";
}

export async function applyEntitlementEvent(env: Env, event: EntitlementEvent, payloadHash: string): Promise<ProjectionResult> {
  return applyEntitlementEventForSource(env,PRIMARY_PROJECT_ALPHA_SOURCE,event,payloadHash);
}

export async function applyEntitlementEventForSource(env: Env, source: ProjectAlphaSourceContext, event: EntitlementEvent, payloadHash: string): Promise<ProjectionResult> {
  source=createProjectAlphaSourceContext(source.sourceId);
  // Staff authority is unresolved for additional producers. Reject before even
  // reserving a lease/receipt; their ordinary users remain snapshot business data.
  if(!source.staffAuthority)throw new Error("projection-source-authority-unsupported");
  await claimGlobalProjection(env,source,event.event_id);
  let processingError: unknown;
  try { return await applyEntitlementEventLocked(env,source,event,payloadHash); }
  catch(error) { processingError=error; throw error; }
  finally {
    try { await releaseGlobalProjection(env,source,event.event_id); }
    catch(releaseError) { if(!processingError)throw releaseError; }
  }
}

function value(data: Record<string,unknown>, key: string): string | null { const current=data[key];return current===null||current===undefined?null:String(current); }
function requiredValue(data: Record<string,unknown>, key: string): string {
  const current=value(data,key)?.trim();
  if(!current)throw new Error(`projection-data-${key}-required`);
  return current;
}

const projectionCollections = {
  client:"clients",organization:"organizations",project:"projects",project_assignment:"project_assignments",
  business_unit:"business_units",operation:"operations",operation_assignment:"operation_assignments",
  task:"tasks",task_assignment:"task_assignments",
} as const;

async function applyPortalProjection(env: Env, event: ProjectionEvent, active: number): Promise<void> {
  if (event.projection.entity_type !== "client" && event.projection.entity_type !== "organization" && event.projection.entity_type !== "project") return;
  const db = env.DELIVERY_DB;
  if (!db) throw new Error("delivery-db-binding-required");
  const data = event.projection.data;
  const id = event.projection.entity_id;
  if (event.projection.entity_type === "client") {
    const name = value(data, "name") ?? `Client ${id}`;
    await db.batch([
      db.prepare(`UPDATE client_accounts SET display_name=?,project_alpha_organization_id=?,status=CASE WHEN ?=0 THEN 'suspended' ELSE 'active' END,updated_at=datetime('now') WHERE project_alpha_client_id=?`).bind(name,value(data,"organization_id"),active,id),
      db.prepare(`UPDATE projects SET client_name=?,updated_at=datetime('now') WHERE id IN (SELECT g.project_id FROM client_project_grants g JOIN client_accounts a ON a.id=g.account_id WHERE a.project_alpha_client_id=? AND g.revoked_at IS NULL)`).bind(name,id),
    ]);
  } else if (event.projection.entity_type === "organization") {
    const name = value(data, "name") ?? `Organization ${id}`;
    await db.batch([
      db.prepare(`UPDATE client_accounts SET display_name=?,status=CASE WHEN ?=0 THEN 'suspended' ELSE 'active' END,updated_at=datetime('now') WHERE project_alpha_organization_id=? AND project_alpha_client_id IS NULL`).bind(name,active,id),
      db.prepare(`UPDATE projects SET client_name=?,updated_at=datetime('now') WHERE id IN (SELECT g.project_id FROM client_project_grants g JOIN client_accounts a ON a.id=g.account_id WHERE a.project_alpha_organization_id=? AND a.project_alpha_client_id IS NULL AND g.revoked_at IS NULL)`).bind(name,id),
    ]);
  } else if (event.projection.entity_type === "project") {
    await db.prepare(`UPDATE projects SET project_name=?,status=?,summary=?,source_updated_at=?,active=?,updated_at=datetime('now') WHERE project_alpha_project_id=?`)
      .bind(value(data,"name")??`Project ${id}`,value(data,"status"),value(data,"description"),event.projection.source_updated_at,active,id).run();
  }
}

async function reconcilePortalProjectionAccess(env: Env, source: ProjectAlphaSourceContext, ownerEventId: string): Promise<void> {
  const db = env.DELIVERY_DB;
  if (!db) throw new Error("delivery-db-binding-required");
  const [projects, clients, organizations] = await Promise.all([
    env.OPS_DB.prepare("SELECT id,client_id,organization_id,active FROM pa_projects WHERE projection_source_id=?").bind(source.sourceId).all<{id:string;client_id:string|null;organization_id:string|null;active:number}>(),
    env.OPS_DB.prepare("SELECT id FROM pa_clients WHERE projection_source_id=? AND active=1").bind(source.sourceId).all<{id:string}>(),
    env.OPS_DB.prepare("SELECT id FROM pa_organizations WHERE projection_source_id=? AND active=1").bind(source.sourceId).all<{id:string}>(),
  ]);
  const activeClients=new Set(clients.results.map(row=>row.id));
  const activeOrganizations=new Set(organizations.results.map(row=>row.id));
  const statements:D1PreparedStatement[]=[];
  for(const project of projects.results){
    const clientId=project.client_id&&activeClients.has(project.client_id)?project.client_id:null;
    const organizationId=project.organization_id&&activeOrganizations.has(project.organization_id)?project.organization_id:null;
    const invalidAccounts=`SELECT g.account_id FROM client_project_grants g
      JOIN client_accounts a ON a.id=g.account_id
      JOIN projects p ON p.id=g.project_id
      WHERE p.project_alpha_project_id=? AND g.revoked_at IS NULL AND NOT
        (?=1 AND a.status='active' AND ((? IS NOT NULL AND a.project_alpha_client_id IS ?)
          OR (g.can_request_service=0 AND ? IS NOT NULL AND a.project_alpha_organization_id IS ?)))`;
    const invalidValues=[project.id,project.active,clientId,clientId,organizationId,organizationId];
    for(const table of ["client_folder_associations","client_delivery_grants","client_member_project_grants"] as const){
      statements.push(db.prepare(`UPDATE ${table} SET revoked_at=COALESCE(revoked_at,datetime('now'))
        WHERE project_id IN (SELECT id FROM projects WHERE project_alpha_project_id=?) AND revoked_at IS NULL
          AND account_id IN (${invalidAccounts})`).bind(project.id,...invalidValues));
    }
    statements.push(db.prepare(`UPDATE client_project_grants SET revoked_at=COALESCE(revoked_at,datetime('now'))
      WHERE project_id IN (SELECT id FROM projects WHERE project_alpha_project_id=?) AND revoked_at IS NULL
        AND account_id IN (${invalidAccounts})`).bind(project.id,...invalidValues));
  }
  statements.push(db.prepare(`UPDATE client_folder_associations SET revoked_at=COALESCE(revoked_at,datetime('now'))
    WHERE scope_type='client' AND revoked_at IS NULL AND account_id IN (SELECT id FROM client_accounts WHERE status<>'active')`));
  for(let index=0;index<statements.length;index+=75){
    await refreshGlobalProjection(env,source,ownerEventId);
    await db.batch(statements.slice(index,index+75));
  }
}

async function claimProjectionEntity(env: Env, source: ProjectAlphaSourceContext, event: ProjectionEvent): Promise<void> {
  const claimed = await env.OPS_DB.prepare(`INSERT INTO pa_projection_entity_leases (projection_source_id,entity_type,entity_id,owner_event_id,lease_until)
    VALUES (?,?,?,?,datetime('now',?))
    ON CONFLICT(projection_source_id,entity_type,entity_id) DO UPDATE SET
      owner_event_id=excluded.owner_event_id,
      lease_until=excluded.lease_until,
      updated_at=datetime('now')
    WHERE datetime(pa_projection_entity_leases.lease_until)<=datetime('now')
    RETURNING owner_event_id`)
    .bind(source.sourceId,event.projection.entity_type,event.projection.entity_id,event.event_id,PROJECTION_LEASE_DURATION)
    .first<{owner_event_id:string}>();
  if(claimed?.owner_event_id!==event.event_id)throw new Error("projection-entity-busy");
}

async function refreshProjectionEntityLease(env: Env, source: ProjectAlphaSourceContext, event: ProjectionEvent): Promise<void> {
  await refreshGlobalProjection(env,source,event.event_id);
  const refreshed = await env.OPS_DB.prepare(`UPDATE pa_projection_entity_leases
    SET lease_until=datetime('now',?),updated_at=datetime('now')
    WHERE projection_source_id=? AND entity_type=? AND entity_id=? AND owner_event_id=?
    RETURNING owner_event_id`)
    .bind(PROJECTION_LEASE_DURATION,source.sourceId,event.projection.entity_type,event.projection.entity_id,event.event_id)
    .first<{owner_event_id:string}>();
  if(refreshed?.owner_event_id!==event.event_id)throw new Error("projection-entity-lease-lost");
}

async function releaseProjectionEntity(env: Env, source: ProjectAlphaSourceContext, event: ProjectionEvent): Promise<void> {
  await env.OPS_DB.prepare("DELETE FROM pa_projection_entity_leases WHERE projection_source_id=? AND entity_type=? AND entity_id=? AND owner_event_id=?")
    .bind(source.sourceId,event.projection.entity_type,event.projection.entity_id,event.event_id).run();
}

async function applyProjectionEventLocked(env: Env, source: ProjectAlphaSourceContext, event: ProjectionEvent, payloadHash: string): Promise<ProjectionResult> {
  const receipt=await env.OPS_DB.prepare("SELECT payload_hash,status FROM integration_event_receipts WHERE projection_source_id=? AND event_id=?").bind(source.sourceId,event.event_id).first<{payload_hash:string;status:string}>();
  if(receipt){if(receipt.payload_hash!==payloadHash)throw new Error("event-id-conflict");if(receipt.status==="completed"||receipt.status==="ignored")return "duplicate";}
  else await env.OPS_DB.prepare("INSERT INTO integration_event_receipts (projection_source_id,event_id,integration,event_type,user_id,occurred_at,payload_hash,status) VALUES (?,?,'project-alpha',?,?,?,?, 'pending')").bind(source.sourceId,event.event_id,event.event_type,value(event.projection.data,"user_id")??event.projection.entity_id,event.occurred_at,payloadHash).run();
  await claimProjectionEntity(env,source,event);
  let processingError:unknown;
  try {
    const latest=await env.OPS_DB.prepare("SELECT source_updated_at,event_id FROM pa_projection_entity_versions WHERE projection_source_id=? AND entity_type=? AND entity_id=?").bind(source.sourceId,event.projection.entity_type,event.projection.entity_id).first<{source_updated_at:string;event_id:string}>();
    if(latest&&Date.parse(event.projection.source_updated_at)<=Date.parse(latest.source_updated_at)){
      // A prior attempt can finish both projections and advance the entity marker
      // before its receipt/reconciliation acknowledgement. Let the handler finish
      // that same pending event instead of permanently misclassifying it as stale.
      if(receipt?.status==="pending"&&latest.event_id===event.event_id)return "applied";
      await env.OPS_DB.prepare("UPDATE integration_event_receipts SET status='ignored',processed_at=datetime('now') WHERE projection_source_id=? AND event_id=?").bind(source.sourceId,event.event_id).run();return "ignored";
    }
    const rawData=event.projection.data,active=event.projection.action==="upsert"?1:0,marker=`event:${event.event_id}`;
    const collection = projectionCollections[event.projection.entity_type];
    const row = {...rawData,id:event.projection.entity_id};
    const references = projectAlphaSourceReferences(collection,row);
    const calendarExternalId = `${event.projection.entity_type}:${event.projection.entity_id}`;
    if(event.projection.entity_type==="operation"||event.projection.entity_type==="task")
      references.push({kind:"calendar_event",externalId:calendarExternalId});
    const ids=await prepareProjectAlphaSourceRecords(env.OPS_DB,source,references);
    const data=mapProjectAlphaSourceRow(collection,row,ids);
    const localId=requiredValue(data,"id");
    const rawJson=JSON.stringify(rawData);
    const calendarId=(event.projection.entity_type==="operation"||event.projection.entity_type==="task")
      ?ids.get("calendar_event",calendarExternalId):null;
    const statements:D1PreparedStatement[]=[];
    if(event.projection.entity_type==="client") {
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_clients (projection_source_id,id,name,organization_id,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,organization_id=excluded.organization_id,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now') WHERE pa_clients.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,localId,value(data,"name")??`Client ${event.projection.entity_id}`,value(data,"organization_id"),active,rawJson,marker));
  } else if(event.projection.entity_type==="organization") {
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_organizations (projection_source_id,id,name,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now') WHERE pa_organizations.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,localId,value(data,"name")??`Organization ${event.projection.entity_id}`,active,rawJson,marker));
  } else if(event.projection.entity_type==="business_unit") {
    const name=value(data,"name")??`Business unit ${event.projection.entity_id}`,code=value(data,"code")??`pa-${event.projection.entity_id}`;
    statements.push(
      env.OPS_DB.prepare(`INSERT INTO pa_business_units (projection_source_id,id,name,code,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,code=excluded.code,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now') WHERE pa_business_units.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,localId,name,code,active,rawJson,marker),
    );
    if(source.staffAuthority)statements.push(env.OPS_DB.prepare(`INSERT INTO divisions (id,name,code,project_alpha_business_unit_id,active) VALUES (?,?,?,?,?) ON CONFLICT(project_alpha_business_unit_id) DO UPDATE SET name=excluded.name,code=excluded.code,active=excluded.active,updated_at=datetime('now')`).bind(`division-pa-${event.projection.entity_id}`,name,code,localId,active));
  } else if(event.projection.entity_type==="project") {
    const businessUnitId=value(data,"business_unit_id");
    statements.push(
      env.OPS_DB.prepare(`INSERT INTO pa_projects (projection_source_id,id,client_id,organization_id,business_unit_id,manager_user_id,name,status,start_date,end_date,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,organization_id=excluded.organization_id,business_unit_id=excluded.business_unit_id,manager_user_id=excluded.manager_user_id,name=excluded.name,status=excluded.status,start_date=excluded.start_date,end_date=excluded.end_date,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now') WHERE pa_projects.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,localId,value(data,"client_id"),value(data,"organization_id"),businessUnitId,value(data,"manager_user_id"),value(data,"name")??`Project ${event.projection.entity_id}`,value(data,"status"),value(data,"start_date")??value(data,"estimated_start"),value(data,"end_date")??value(data,"estimated_end"),active,rawJson,marker),
      env.OPS_DB.prepare(`UPDATE pa_operations SET business_unit_id=?,active=CASE WHEN ?=0 THEN 0 ELSE active END,updated_at=datetime('now') WHERE projection_source_id=? AND project_id=?`).bind(businessUnitId,active,source.sourceId,localId),
      env.OPS_DB.prepare(`UPDATE pa_tasks SET business_unit_id=?,active=CASE WHEN ?=0 THEN 0 ELSE active END,updated_at=datetime('now') WHERE projection_source_id=? AND project_id=?`).bind(businessUnitId,active,source.sourceId,localId),
      env.OPS_DB.prepare(`UPDATE pa_calendar_events SET business_unit_id=?,active=CASE WHEN ?=0 THEN 0 ELSE active END,updated_at=datetime('now') WHERE projection_source_id=? AND project_id=?`).bind(businessUnitId,active,source.sourceId,localId),
    );
  } else if(event.projection.entity_type==="project_assignment") {
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_project_assignments (projection_source_id,id,project_id,user_id,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,user_id=excluded.user_id,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id WHERE pa_project_assignments.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,localId,requiredValue(data,"project_id"),requiredValue(data,"user_id"),active,rawJson,marker));
  } else if(event.projection.entity_type==="operation") {
    const projectId=requiredValue(data,"project_id"),businessUnitId=value(data,"business_unit_id"),title=value(data,"title")??"Operation",scheduledStart=value(data,"scheduled_start_at");
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_operations (projection_source_id,id,project_id,business_unit_id,title,status,scheduled_start_at,scheduled_end_at,location,notes,created_by_user_id,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,title=excluded.title,status=excluded.status,scheduled_start_at=excluded.scheduled_start_at,scheduled_end_at=excluded.scheduled_end_at,location=excluded.location,notes=excluded.notes,created_by_user_id=excluded.created_by_user_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=excluded.active,updated_at=datetime('now') WHERE pa_operations.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,localId,projectId,businessUnitId,title,value(data,"status")??"draft",scheduledStart,value(data,"scheduled_end_at"),value(data,"location"),value(data,"notes"),value(data,"created_by"),rawJson,marker,active));
    if(active&&scheduledStart) statements.push(env.OPS_DB.prepare(`INSERT INTO pa_calendar_events (projection_source_id,id,source_type,source_id,title,start_at,end_at,all_day,project_id,business_unit_id,payload_json,last_sync_id,active) VALUES (?,?,'operation',?,?,?,?,0,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now') WHERE pa_calendar_events.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,calendarId,localId,title,scheduledStart,value(data,"scheduled_end_at"),projectId,businessUnitId,rawJson,marker));
    else statements.push(env.OPS_DB.prepare("UPDATE pa_calendar_events SET active=0,updated_at=datetime('now') WHERE projection_source_id=? AND id=?").bind(source.sourceId,calendarId));
  } else if(event.projection.entity_type==="operation_assignment") {
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_operation_assignments (projection_source_id,operation_id,user_id,assignment_role,assigned_by_user_id,assigned_at,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(operation_id,user_id) DO UPDATE SET assignment_role=excluded.assignment_role,assigned_by_user_id=excluded.assigned_by_user_id,assigned_at=excluded.assigned_at,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=excluded.active WHERE pa_operation_assignments.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,requiredValue(data,"operation_id"),requiredValue(data,"user_id"),value(data,"assignment_role"),value(data,"assigned_by"),value(data,"assigned_at"),rawJson,marker,active));
  } else if(event.projection.entity_type==="task") {
    const projectId=requiredValue(data,"project_id"),businessUnitId=value(data,"business_unit_id"),title=value(data,"title")??"Task",dueAt=value(data,"due_at");
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_tasks (projection_source_id,id,operation_id,project_id,business_unit_id,assignee_user_id,title,status,due_at,notes,created_by_user_id,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET operation_id=excluded.operation_id,project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,assignee_user_id=excluded.assignee_user_id,title=excluded.title,status=excluded.status,due_at=excluded.due_at,notes=excluded.notes,created_by_user_id=excluded.created_by_user_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=excluded.active,updated_at=datetime('now') WHERE pa_tasks.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,localId,value(data,"operation_id"),projectId,businessUnitId,value(data,"assignee_user_id"),title,value(data,"status")??"todo",dueAt,value(data,"notes"),value(data,"created_by"),rawJson,marker,active));
    if(active&&dueAt) statements.push(env.OPS_DB.prepare(`INSERT INTO pa_calendar_events (projection_source_id,id,source_type,source_id,title,start_at,end_at,all_day,project_id,business_unit_id,payload_json,last_sync_id,active) VALUES (?,?,'task',?,?,?,?,0,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now') WHERE pa_calendar_events.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,calendarId,localId,title,dueAt,dueAt,projectId,businessUnitId,rawJson,marker));
    else statements.push(env.OPS_DB.prepare("UPDATE pa_calendar_events SET active=0,updated_at=datetime('now') WHERE projection_source_id=? AND id=?").bind(source.sourceId,calendarId));
  } else if(event.projection.entity_type==="task_assignment") {
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_task_assignments (projection_source_id,task_id,user_id,assigned_by_user_id,assigned_at,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(task_id,user_id) DO UPDATE SET assigned_by_user_id=excluded.assigned_by_user_id,assigned_at=excluded.assigned_at,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=excluded.active WHERE pa_task_assignments.projection_source_id=excluded.projection_source_id`).bind(source.sourceId,requiredValue(data,"task_id"),requiredValue(data,"user_id"),value(data,"assigned_by"),value(data,"assigned_at"),rawJson,marker,active));
    }
    await refreshProjectionEntityLease(env,source,event);
    if(statements.length)await env.OPS_DB.batch(statements);
    // Keep a failed portal write retryable: the source version is advanced only
    // after DELIVERY_DB has accepted its idempotent projection.
    await refreshProjectionEntityLease(env,source,event);
    // Delivery projections are still primary-only; a secondary data projection
    // must not update or revoke an existing primary client account's grants.
    if(source.sourceId===PRIMARY_PROJECT_ALPHA_SOURCE.sourceId){
      await applyPortalProjection(env,event,active);
      if(event.projection.entity_type==="client"||event.projection.entity_type==="organization"||event.projection.entity_type==="project")await reconcilePortalProjectionAccess(env,source,event.event_id);
    }
    await refreshProjectionEntityLease(env,source,event);
    await env.OPS_DB.prepare(`INSERT INTO pa_projection_entity_versions (projection_source_id,entity_type,entity_id,source_updated_at,event_id) VALUES (?,?,?,?,?) ON CONFLICT(projection_source_id,entity_type,entity_id) DO UPDATE SET source_updated_at=excluded.source_updated_at,event_id=excluded.event_id,updated_at=datetime('now')`).bind(source.sourceId,event.projection.entity_type,event.projection.entity_id,event.projection.source_updated_at,event.event_id).run();
    return "applied";
  } catch(error) {
    processingError=error;
    throw error;
  } finally {
    try{await releaseProjectionEntity(env,source,event);}catch(releaseError){if(!processingError)throw releaseError;}
  }
}

export async function applyProjectionEvent(env: Env, event: ProjectionEvent, payloadHash: string): Promise<ProjectionResult> {
  return applyProjectionEventForSource(env,PRIMARY_PROJECT_ALPHA_SOURCE,event,payloadHash);
}

export async function applyProjectionEventForSource(env: Env, source: ProjectAlphaSourceContext, event: ProjectionEvent, payloadHash: string): Promise<ProjectionResult> {
  source=createProjectAlphaSourceContext(source.sourceId);
  await claimGlobalProjection(env,source,event.event_id);
  let processingError: unknown;
  try { return await applyProjectionEventLocked(env,source,event,payloadHash); }
  catch(error) { processingError=error; throw error; }
  finally {
    try { await releaseGlobalProjection(env,source,event.event_id); }
    catch(releaseError) { if(!processingError)throw releaseError; }
  }
}

export async function completeEvent(env: Env, event: IntegrationEvent, preserveError = false, source: ProjectAlphaSourceContext = PRIMARY_PROJECT_ALPHA_SOURCE): Promise<void> {
  source=createProjectAlphaSourceContext(source.sourceId);
  await env.OPS_DB.batch([
    env.OPS_DB.prepare("UPDATE integration_event_receipts SET status='completed',processed_at=datetime('now'),last_error=CASE WHEN ?=1 THEN last_error ELSE NULL END WHERE projection_source_id=? AND event_id=?").bind(preserveError?1:0,source.sourceId,event.event_id),
    env.OPS_DB.prepare(`INSERT INTO integration_reconciliation(projection_source_id,integration,last_event_at) VALUES (?,'project-alpha',?)
      ON CONFLICT(projection_source_id,integration) DO UPDATE SET last_event_at=excluded.last_event_at,updated_at=datetime('now')`).bind(source.sourceId,event.occurred_at),
  ]);
}

export async function recordAccessSuccess(env: Env): Promise<void> {
  await env.OPS_DB.prepare("UPDATE integration_reconciliation SET last_access_attempt_at=datetime('now'),last_access_success_at=datetime('now'),last_access_error=NULL,access_consecutive_failures=0,access_circuit_open_until=NULL,updated_at=datetime('now') WHERE projection_source_id=? AND integration='project-alpha'").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).run();
}

export async function accessCircuitIsOpen(env: Env): Promise<boolean> {
  const row=await env.OPS_DB.prepare("SELECT access_circuit_open_until FROM integration_reconciliation WHERE projection_source_id=? AND integration='project-alpha'").bind(PRIMARY_PROJECT_ALPHA_SOURCE.sourceId).first<{access_circuit_open_until:string|null}>();
  if(!row?.access_circuit_open_until)return false;
  const timestamp=Date.parse(`${row.access_circuit_open_until.replace(" ","T")}Z`);
  return Number.isFinite(timestamp)&&timestamp>Date.now();
}

export async function recordAccessFailure(env: Env, eventId: string | null, error: string): Promise<void> {
  const safeError = error.slice(0, 500);
  const statements = [
    env.OPS_DB.prepare(`UPDATE integration_reconciliation SET
      last_access_attempt_at=datetime('now'),last_access_error=?,
      access_circuit_open_until=CASE WHEN access_consecutive_failures+1>=3 THEN datetime('now','+5 minutes') ELSE access_circuit_open_until END,
      access_consecutive_failures=access_consecutive_failures+1,updated_at=datetime('now')
      WHERE projection_source_id=? AND integration='project-alpha'`).bind(safeError,PRIMARY_PROJECT_ALPHA_SOURCE.sourceId),
  ];
  if (eventId) {
    statements.unshift(env.OPS_DB.prepare("UPDATE integration_event_receipts SET last_error=? WHERE projection_source_id=? AND event_id=?").bind(safeError,PRIMARY_PROJECT_ALPHA_SOURCE.sourceId,eventId));
  }
  await env.OPS_DB.batch(statements);
}

export async function recordEventFailure(env: Env, eventId: string, error: string, source: ProjectAlphaSourceContext = PRIMARY_PROJECT_ALPHA_SOURCE): Promise<void> {
  source=createProjectAlphaSourceContext(source.sourceId);
  await env.OPS_DB.prepare("UPDATE integration_event_receipts SET last_error=? WHERE projection_source_id=? AND event_id=? AND status='pending'")
    .bind(error.slice(0,500),source.sourceId,eventId).run();
}
