import type { EntitlementEvent, Env, IntegrationEvent, ProjectionEvent } from "./types";

export type ProjectionResult = "applied" | "duplicate" | "ignored";

function staffId(userId: string): string { return `staff-pa-${userId.replace(/[^a-zA-Z0-9_-]/g, "-")}`; }

export async function applyEntitlementEvent(env: Env, event: EntitlementEvent, payloadHash: string): Promise<ProjectionResult> {
  const receipt = await env.OPS_DB.prepare("SELECT payload_hash,status FROM integration_event_receipts WHERE event_id=?").bind(event.event_id).first<{ payload_hash: string; status: string }>();
  if (receipt) {
    if (receipt.payload_hash !== payloadHash) throw new Error("event-id-conflict");
    if (receipt.status === "completed" || receipt.status === "ignored") return "duplicate";
  } else {
    await env.OPS_DB.prepare(`INSERT INTO integration_event_receipts (event_id,integration,event_type,user_id,occurred_at,payload_hash,status) VALUES (?,'project-alpha',?,?,?,?, 'pending')`)
      .bind(event.event_id,event.event_type,event.user.id,event.occurred_at,payloadHash).run();
  }

  const latest = await env.OPS_DB.prepare("SELECT last_event_at FROM pa_application_entitlements WHERE user_id=?").bind(event.user.id).first<{ last_event_at: string | null }>();
  if (latest?.last_event_at && (Date.parse(event.occurred_at) < Date.parse(latest.last_event_at) || (!receipt && Date.parse(event.occurred_at) === Date.parse(latest.last_event_at)))) {
    await env.OPS_DB.prepare("UPDATE integration_event_receipts SET status='ignored',processed_at=datetime('now'),last_error=NULL WHERE event_id=?").bind(event.event_id).run();
    return "ignored";
  }

  const enabled = event.entitlement.enabled && event.user.active && event.event_type !== "application_entitlement.revoked";
  const syncMarker = `event:${event.event_id}`;
  await env.OPS_DB.batch([
    env.OPS_DB.prepare(`INSERT INTO pa_users (id,email,display_name,role,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`).bind(event.user.id,event.user.email,event.user.display_name,null,event.user.active?1:0,JSON.stringify(event.user),syncMarker),
    env.OPS_DB.prepare(`INSERT INTO pa_application_entitlements (id,user_id,application_key,enabled,role_key,business_unit_ids_json,payload_json,last_event_at,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?,?,1) ON CONFLICT(user_id) DO UPDATE SET application_key=excluded.application_key,enabled=excluded.enabled,role_key=excluded.role_key,business_unit_ids_json=excluded.business_unit_ids_json,payload_json=excluded.payload_json,last_event_at=excluded.last_event_at,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now')`).bind(`entitlement-${event.user.id}`,event.user.id,event.entitlement.application_key,enabled?1:0,event.entitlement.role_key,JSON.stringify(event.entitlement.business_unit_ids),JSON.stringify(event.entitlement),event.occurred_at,syncMarker),
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
    const oversightUnitIds = event.entitlement.oversight_business_unit_ids ?? event.entitlement.business_unit_ids;
    if (enabled && event.entitlement.role_key !== "role-admin" && oversightUnitIds.length > 0) {
      const placeholders = oversightUnitIds.map(() => "?").join(",");
      await env.OPS_DB.prepare(`INSERT OR IGNORE INTO staff_divisions (staff_id,division_id,is_primary) SELECT ?,id,0 FROM divisions WHERE project_alpha_business_unit_id IN (${placeholders}) AND active=1`).bind(id,...oversightUnitIds).run();
    }
    if (enabled && event.entitlement.role_key === "role-admin") {
      await env.OPS_DB.prepare("INSERT OR IGNORE INTO staff_role_assignments (id,staff_id,role_id,scope,division_id,scope_key) VALUES (?,?,'role-admin','global',NULL,'global')")
        .bind(`assignment-pa-${event.user.id}-global`,id).run();
    } else if (enabled) {
      await env.OPS_DB.prepare("INSERT OR IGNORE INTO staff_role_assignments (id,staff_id,role_id,scope,division_id,scope_key) VALUES (?,?,'role-operator','assigned',NULL,'assigned')")
        .bind(`assignment-pa-${event.user.id}-assigned`,id).run();
    }
  }
  return "applied";
}

function value(data: Record<string,unknown>, key: string): string | null { const current=data[key];return current===null||current===undefined?null:String(current); }
function requiredValue(data: Record<string,unknown>, key: string): string {
  const current=value(data,key)?.trim();
  if(!current)throw new Error(`projection-data-${key}-required`);
  return current;
}

export async function applyProjectionEvent(env: Env, event: ProjectionEvent, payloadHash: string): Promise<ProjectionResult> {
  const receipt=await env.OPS_DB.prepare("SELECT payload_hash,status FROM integration_event_receipts WHERE event_id=?").bind(event.event_id).first<{payload_hash:string;status:string}>();
  if(receipt){if(receipt.payload_hash!==payloadHash)throw new Error("event-id-conflict");if(receipt.status==="completed"||receipt.status==="ignored")return "duplicate";}
  else await env.OPS_DB.prepare("INSERT INTO integration_event_receipts (event_id,integration,event_type,user_id,occurred_at,payload_hash,status) VALUES (?,'project-alpha',?,?,?,?, 'pending')").bind(event.event_id,event.event_type,value(event.projection.data,"user_id")??event.projection.entity_id,event.occurred_at,payloadHash).run();
  const latest=await env.OPS_DB.prepare("SELECT source_updated_at FROM pa_projection_entity_versions WHERE entity_type=? AND entity_id=?").bind(event.projection.entity_type,event.projection.entity_id).first<{source_updated_at:string}>();
  if(latest&&Date.parse(event.projection.source_updated_at)<=Date.parse(latest.source_updated_at)){await env.OPS_DB.prepare("UPDATE integration_event_receipts SET status='ignored',processed_at=datetime('now') WHERE event_id=?").bind(event.event_id).run();return "ignored";}
  const data=event.projection.data,active=event.projection.action==="upsert"?1:0,marker=`event:${event.event_id}`;
  const statements:D1PreparedStatement[]=[];
  if(event.projection.entity_type==="business_unit") {
    const name=value(data,"name")??`Business unit ${event.projection.entity_id}`,code=value(data,"code")??`pa-${event.projection.entity_id}`;
    statements.push(
      env.OPS_DB.prepare(`INSERT INTO pa_business_units (id,name,code,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,code=excluded.code,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`).bind(event.projection.entity_id,name,code,active,JSON.stringify(data),marker),
      env.OPS_DB.prepare(`INSERT INTO divisions (id,name,code,project_alpha_business_unit_id,active) VALUES (?,?,?,?,?) ON CONFLICT(project_alpha_business_unit_id) DO UPDATE SET name=excluded.name,code=excluded.code,active=excluded.active,updated_at=datetime('now')`).bind(`division-pa-${event.projection.entity_id}`,name,code,event.projection.entity_id,active),
    );
  } else if(event.projection.entity_type==="project") {
    const businessUnitId=value(data,"business_unit_id");
    statements.push(
      env.OPS_DB.prepare(`INSERT INTO pa_projects (id,client_id,organization_id,business_unit_id,name,status,start_date,end_date,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,organization_id=excluded.organization_id,business_unit_id=excluded.business_unit_id,name=excluded.name,status=excluded.status,start_date=excluded.start_date,end_date=excluded.end_date,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`).bind(event.projection.entity_id,value(data,"client_id"),value(data,"organization_id"),businessUnitId,value(data,"name")??`Project ${event.projection.entity_id}`,value(data,"status"),value(data,"start_date")??value(data,"estimated_start"),value(data,"end_date")??value(data,"estimated_end"),active,JSON.stringify(data),marker),
      env.OPS_DB.prepare(`UPDATE pa_operations SET business_unit_id=?,active=CASE WHEN ?=0 THEN 0 ELSE active END,updated_at=datetime('now') WHERE project_id=?`).bind(businessUnitId,active,event.projection.entity_id),
      env.OPS_DB.prepare(`UPDATE pa_tasks SET business_unit_id=?,active=CASE WHEN ?=0 THEN 0 ELSE active END,updated_at=datetime('now') WHERE project_id=?`).bind(businessUnitId,active,event.projection.entity_id),
      env.OPS_DB.prepare(`UPDATE pa_calendar_events SET business_unit_id=?,active=CASE WHEN ?=0 THEN 0 ELSE active END,updated_at=datetime('now') WHERE project_id=?`).bind(businessUnitId,active,event.projection.entity_id),
    );
  } else if(event.projection.entity_type==="project_assignment") {
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_project_assignments (id,project_id,user_id,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,user_id=excluded.user_id,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id`).bind(event.projection.entity_id,requiredValue(data,"project_id"),requiredValue(data,"user_id"),active,JSON.stringify(data),marker));
  } else if(event.projection.entity_type==="operation") {
    const projectId=requiredValue(data,"project_id"),businessUnitId=value(data,"business_unit_id"),title=value(data,"title")??"Operation",scheduledStart=value(data,"scheduled_start_at");
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_operations (id,project_id,business_unit_id,title,status,scheduled_start_at,scheduled_end_at,location,notes,created_by_user_id,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,title=excluded.title,status=excluded.status,scheduled_start_at=excluded.scheduled_start_at,scheduled_end_at=excluded.scheduled_end_at,location=excluded.location,notes=excluded.notes,created_by_user_id=excluded.created_by_user_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=excluded.active,updated_at=datetime('now')`).bind(event.projection.entity_id,projectId,businessUnitId,title,value(data,"status")??"draft",scheduledStart,value(data,"scheduled_end_at"),value(data,"location"),value(data,"notes"),value(data,"created_by"),JSON.stringify(data),marker,active));
    if(active&&scheduledStart) statements.push(env.OPS_DB.prepare(`INSERT INTO pa_calendar_events (id,source_type,source_id,title,start_at,end_at,all_day,project_id,business_unit_id,payload_json,last_sync_id,active) VALUES (?,'operation',?,?,?,?,0,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now')`).bind(`operation:${event.projection.entity_id}`,event.projection.entity_id,title,scheduledStart,value(data,"scheduled_end_at"),projectId,businessUnitId,JSON.stringify(data),marker));
    else statements.push(env.OPS_DB.prepare("UPDATE pa_calendar_events SET active=0,updated_at=datetime('now') WHERE id=?").bind(`operation:${event.projection.entity_id}`));
  } else if(event.projection.entity_type==="operation_assignment") {
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_operation_assignments (operation_id,user_id,assignment_role,assigned_by_user_id,assigned_at,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(operation_id,user_id) DO UPDATE SET assignment_role=excluded.assignment_role,assigned_by_user_id=excluded.assigned_by_user_id,assigned_at=excluded.assigned_at,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=excluded.active`).bind(requiredValue(data,"operation_id"),requiredValue(data,"user_id"),value(data,"assignment_role"),value(data,"assigned_by"),value(data,"assigned_at"),JSON.stringify(data),marker,active));
  } else if(event.projection.entity_type==="task") {
    const projectId=requiredValue(data,"project_id"),businessUnitId=value(data,"business_unit_id"),title=value(data,"title")??"Task",dueAt=value(data,"due_at");
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_tasks (id,operation_id,project_id,business_unit_id,assignee_user_id,title,status,due_at,notes,created_by_user_id,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET operation_id=excluded.operation_id,project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,assignee_user_id=excluded.assignee_user_id,title=excluded.title,status=excluded.status,due_at=excluded.due_at,notes=excluded.notes,created_by_user_id=excluded.created_by_user_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=excluded.active,updated_at=datetime('now')`).bind(event.projection.entity_id,value(data,"operation_id"),projectId,businessUnitId,value(data,"assignee_user_id"),title,value(data,"status")??"todo",dueAt,value(data,"notes"),value(data,"created_by"),JSON.stringify(data),marker,active));
    if(active&&dueAt) statements.push(env.OPS_DB.prepare(`INSERT INTO pa_calendar_events (id,source_type,source_id,title,start_at,end_at,all_day,project_id,business_unit_id,payload_json,last_sync_id,active) VALUES (?,'task',?,?,?,?,0,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now')`).bind(`task:${event.projection.entity_id}`,event.projection.entity_id,title,dueAt,dueAt,projectId,businessUnitId,JSON.stringify(data),marker));
    else statements.push(env.OPS_DB.prepare("UPDATE pa_calendar_events SET active=0,updated_at=datetime('now') WHERE id=?").bind(`task:${event.projection.entity_id}`));
  } else if(event.projection.entity_type==="task_assignment") {
    statements.push(env.OPS_DB.prepare(`INSERT INTO pa_task_assignments (task_id,user_id,assigned_by_user_id,assigned_at,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id,user_id) DO UPDATE SET assigned_by_user_id=excluded.assigned_by_user_id,assigned_at=excluded.assigned_at,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=excluded.active`).bind(requiredValue(data,"task_id"),requiredValue(data,"user_id"),value(data,"assigned_by"),value(data,"assigned_at"),JSON.stringify(data),marker,active));
  }
  if(statements.length)await env.OPS_DB.batch(statements);
  await env.OPS_DB.prepare(`INSERT INTO pa_projection_entity_versions (entity_type,entity_id,source_updated_at,event_id) VALUES (?,?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET source_updated_at=excluded.source_updated_at,event_id=excluded.event_id,updated_at=datetime('now')`).bind(event.projection.entity_type,event.projection.entity_id,event.projection.source_updated_at,event.event_id).run();
  return "applied";
}

export async function completeEvent(env: Env, event: IntegrationEvent): Promise<void> {
  await env.OPS_DB.batch([
    env.OPS_DB.prepare("UPDATE integration_event_receipts SET status='completed',processed_at=datetime('now'),last_error=NULL WHERE event_id=?").bind(event.event_id),
    env.OPS_DB.prepare("UPDATE integration_reconciliation SET last_event_at=?,last_access_success_at=datetime('now'),last_access_error=NULL,updated_at=datetime('now') WHERE integration='project-alpha'").bind(event.occurred_at),
  ]);
}

export async function recordAccessFailure(env: Env, eventId: string, error: string): Promise<void> {
  await env.OPS_DB.batch([
    env.OPS_DB.prepare("UPDATE integration_event_receipts SET last_error=? WHERE event_id=?").bind(error.slice(0,500),eventId),
    env.OPS_DB.prepare("UPDATE integration_reconciliation SET last_access_attempt_at=datetime('now'),last_access_error=?,updated_at=datetime('now') WHERE integration='project-alpha'").bind(error.slice(0,500)),
  ]);
}
