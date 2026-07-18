import type { EntitlementEvent, Env } from "./types";

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
    if (enabled && event.entitlement.role_key !== "role-admin" && event.entitlement.business_unit_ids.length > 0) {
      const placeholders = event.entitlement.business_unit_ids.map(() => "?").join(",");
      await env.OPS_DB.prepare(`INSERT OR IGNORE INTO staff_divisions (staff_id,division_id,is_primary) SELECT ?,id,0 FROM divisions WHERE project_alpha_business_unit_id IN (${placeholders}) AND active=1`).bind(id,...event.entitlement.business_unit_ids).run();
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

export async function completeEvent(env: Env, event: EntitlementEvent): Promise<void> {
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
