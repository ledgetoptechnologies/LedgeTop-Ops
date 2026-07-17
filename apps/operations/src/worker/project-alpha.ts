import type { Env } from "./types";

type Row = Record<string, unknown>;

const SNAPSHOT_COLLECTIONS = [
  "users",
  "business_units",
  "worker_business_units",
  "clients",
  "organizations",
  "projects",
  "project_assignments",
  "service_locations",
  "application_entitlements",
  "operations",
  "operation_assignments",
  "tasks",
  "calendar_events",
] as const;

type CollectionName = (typeof SNAPSHOT_COLLECTIONS)[number];
type SnapshotCollections = Record<CollectionName, Row[]>;

interface Snapshot extends SnapshotCollections {
  generated_at: string;
  has_more: boolean;
  next_page: number | null;
}

const APPLICATION_KEY = "ltds_ops";
const SUPPORTED_ROLES = new Set(["role-operator", "role-delivery-coordinator", "role-division-manager"]);

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function isTrue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function enabled(value: unknown): number {
  return isTrue(value) ? 1 : 0;
}

function sourceActive(row: Row): number {
  return row.active === false || row.active === 0 || row.is_active === false || row.is_active === 0 || isTrue(row.is_disabled) || isTrue(row.archived) || row.deleted_at ? 0 : 1;
}

function normalizedEmail(value: unknown): string | null {
  const email = text(value)?.trim().toLowerCase() ?? "";
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function businessUnitIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter((id): id is string => Boolean(id)))];
}

function emptyCollections(): SnapshotCollections {
  const collections = {} as SnapshotCollections;
  for (const key of SNAPSHOT_COLLECTIONS) collections[key] = [];
  return collections;
}

function validatePage(value: unknown): Snapshot {
  if (!value || typeof value !== "object") throw new Error("project-alpha-schema-root");
  const page = value as Partial<Snapshot>;
  for (const key of SNAPSHOT_COLLECTIONS) {
    if (!Array.isArray(page[key])) throw new Error(`project-alpha-schema-${key}`);
  }
  if (typeof page.has_more !== "boolean") throw new Error("project-alpha-schema-has-more");
  return page as Snapshot;
}

async function fetchCompleteSnapshot(env: Env): Promise<SnapshotCollections> {
  const result = emptyCollections();
  let pageNumber = 1;
  for (let pagesRead = 0; pagesRead < 1000; pagesRead += 1) {
    const url = new URL("/api/v1/ops/snapshot", env.PROJECT_ALPHA_BASE_URL);
    url.searchParams.set("page", String(pageNumber));
    url.searchParams.set("limit", "500");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${env.PROJECT_ALPHA_API_KEY}`, Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`project-alpha-http-${response.status}`);
    const page = validatePage(await response.json());
    for (const key of SNAPSHOT_COLLECTIONS) result[key].push(...page[key]);
    if (!page.has_more) return result;
    if (!page.next_page || page.next_page <= pageNumber) throw new Error("project-alpha-pagination");
    pageNumber = page.next_page;
  }
  throw new Error("project-alpha-page-limit");
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += 75) {
    await db.batch(statements.slice(index, index + 75));
  }
}

function projectionStatements(db: D1Database, data: SnapshotCollections, syncId: string): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const row of data.users) {
    const id = text(row.id);
    if (!id) continue;
    const email = normalizedEmail(row.email);
    const display = text(row.display_name) || text(row.username) || email || `User ${id}`;
    const isActive = sourceActive(row);
    statements.push(db.prepare(`INSERT INTO pa_users (id,email,display_name,role,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,role=excluded.role,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`)
      .bind(id, email, display, text(row.role), isActive, JSON.stringify(row), syncId));
    // Protected Owners are deliberately excluded from all PA-owned identity mutations.
    statements.push(db.prepare(`UPDATE staff_users SET email=COALESCE(?,email),display_name=?,status=?,provisioning_source='project-alpha',updated_at=datetime('now')
      WHERE project_alpha_user_id=? AND sync_protected=0`).bind(email, display, isActive ? "active" : "inactive", id));
    if (email) {
      statements.push(db.prepare(`UPDATE staff_users SET project_alpha_user_id=?,display_name=?,status=?,provisioning_source='project-alpha',updated_at=datetime('now')
        WHERE email=? COLLATE NOCASE AND project_alpha_user_id IS NULL AND sync_protected=0`)
        .bind(id, display, isActive ? "active" : "inactive", email));
      statements.push(db.prepare(`INSERT INTO staff_users (id,email,display_name,project_alpha_user_id,status,provisioning_source)
        SELECT ?,?,?,?,?, 'project-alpha' WHERE NOT EXISTS (SELECT 1 FROM staff_users WHERE project_alpha_user_id=? OR email=? COLLATE NOCASE)`)
        .bind(stableId("staff-pa", id), email, display, id, isActive ? "active" : "inactive", id, email));
    }
  }

  for (const row of data.business_units) {
    const id = text(row.id);
    if (!id) continue;
    const name = text(row.name) || `Business unit ${id}`;
    const code = text(row.code) || stableId("pa", id);
    const isActive = row.is_active === false || row.is_active === 0 ? 0 : 1;
    statements.push(db.prepare(`INSERT INTO pa_business_units (id,name,code,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,code=excluded.code,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`)
      .bind(id, name, text(row.code), isActive, JSON.stringify(row), syncId));
    statements.push(db.prepare(`UPDATE divisions SET name=?,code=?,active=?,updated_at=datetime('now') WHERE project_alpha_business_unit_id=?`)
      .bind(name, code, isActive, id));
    statements.push(db.prepare(`INSERT INTO divisions (id,name,code,project_alpha_business_unit_id,active)
      SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM divisions WHERE project_alpha_business_unit_id=?)`)
      .bind(stableId("division-pa", id), name, code, id, isActive, id));
  }

  for (const row of data.worker_business_units) {
    const userId = text(row.user_id), unitId = text(row.business_unit_id);
    if (!userId || !unitId) continue;
    statements.push(db.prepare(`INSERT INTO pa_worker_business_units (user_id,business_unit_id,is_lead,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id,business_unit_id) DO UPDATE SET is_lead=excluded.is_lead,active=1,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id`)
      .bind(userId, unitId, enabled(row.is_lead), 1, JSON.stringify(row), syncId));
  }

  for (const row of data.clients) {
    const id = text(row.id); if (!id) continue;
    statements.push(db.prepare(`INSERT INTO pa_clients (id,name,organization_id,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,organization_id=excluded.organization_id,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`)
      .bind(id, text(row.name) || `Client ${id}`, text(row.organization_id), sourceActive(row), JSON.stringify(row), syncId));
  }
  for (const row of data.organizations) {
    const id = text(row.id); if (!id) continue;
    statements.push(db.prepare(`INSERT INTO pa_organizations (id,name,active,payload_json,last_sync_id) VALUES (?,?,1,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=1,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`)
      .bind(id, text(row.name) || `Organization ${id}`, JSON.stringify(row), syncId));
  }
  for (const row of data.projects) {
    const id = text(row.id); if (!id) continue;
    statements.push(db.prepare(`INSERT INTO pa_projects (id,client_id,organization_id,name,status,start_date,end_date,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,organization_id=excluded.organization_id,name=excluded.name,status=excluded.status,start_date=excluded.start_date,end_date=excluded.end_date,active=1,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`)
      .bind(id, text(row.client_id), text(row.organization_id), text(row.name) || `Project ${id}`, text(row.status), text(row.start_date) || text(row.estimated_start), text(row.end_date) || text(row.estimated_end), 1, JSON.stringify(row), syncId));
  }
  for (const row of data.project_assignments) {
    const id = text(row.id), projectId = text(row.project_id), userId = text(row.user_id); if (!id || !projectId || !userId) continue;
    statements.push(db.prepare(`INSERT INTO pa_project_assignments (id,project_id,user_id,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,user_id=excluded.user_id,active=1,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id`)
      .bind(id, projectId, userId, 1, JSON.stringify(row), syncId));
  }
  for (const row of data.service_locations) {
    const id = text(row.id); if (!id) continue;
    statements.push(db.prepare(`INSERT INTO pa_service_locations (id,project_id,client_id,organization_id,name,latitude,longitude,active,payload_json,last_sync_id) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,client_id=excluded.client_id,organization_id=excluded.organization_id,name=excluded.name,latitude=excluded.latitude,longitude=excluded.longitude,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id`)
      .bind(id, text(row.project_id), text(row.client_id), text(row.organization_id), text(row.name), row.latitude ?? null, row.longitude ?? null, sourceActive(row), JSON.stringify(row), syncId));
  }

  for (const row of data.application_entitlements) {
    const id = text(row.id), userId = text(row.user_id), role = text(row.role_key);
    if (!id || !userId || !role || !SUPPORTED_ROLES.has(role) || text(row.application_key) !== APPLICATION_KEY) continue;
    const unitIds = businessUnitIds(row.business_unit_ids);
    statements.push(db.prepare(`INSERT INTO pa_application_entitlements (id,user_id,application_key,enabled,role_key,business_unit_ids_json,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?,1)
      ON CONFLICT(user_id) DO UPDATE SET application_key=excluded.application_key,enabled=excluded.enabled,role_key=excluded.role_key,business_unit_ids_json=excluded.business_unit_ids_json,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now')`)
      .bind(id, userId, APPLICATION_KEY, enabled(row.enabled), role, JSON.stringify(unitIds), JSON.stringify(row), syncId));
  }
  for (const row of data.operations) {
    const id = text(row.id), projectId = text(row.project_id), title = text(row.title), status = text(row.status);
    if (!id || !projectId || !title || !status) continue;
    statements.push(db.prepare(`INSERT INTO pa_operations (id,project_id,business_unit_id,title,status,scheduled_start_at,scheduled_end_at,location,notes,created_by_user_id,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,title=excluded.title,status=excluded.status,scheduled_start_at=excluded.scheduled_start_at,scheduled_end_at=excluded.scheduled_end_at,location=excluded.location,notes=excluded.notes,created_by_user_id=excluded.created_by_user_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now')`)
      .bind(id, projectId, text(row.business_unit_id), title, status, text(row.scheduled_start_at), text(row.scheduled_end_at), text(row.location), text(row.notes), text(row.created_by), JSON.stringify(row), syncId));
  }
  for (const row of data.operation_assignments) {
    const operationId = text(row.operation_id), userId = text(row.user_id); if (!operationId || !userId) continue;
    statements.push(db.prepare(`INSERT INTO pa_operation_assignments (operation_id,user_id,assignment_role,assigned_by_user_id,assigned_at,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,1)
      ON CONFLICT(operation_id,user_id) DO UPDATE SET assignment_role=excluded.assignment_role,assigned_by_user_id=excluded.assigned_by_user_id,assigned_at=excluded.assigned_at,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1`)
      .bind(operationId, userId, text(row.assignment_role), text(row.assigned_by), text(row.assigned_at), JSON.stringify(row), syncId));
  }
  for (const row of data.tasks) {
    const id = text(row.id), projectId = text(row.project_id), title = text(row.title), status = text(row.status); if (!id || !projectId || !title || !status) continue;
    statements.push(db.prepare(`INSERT INTO pa_tasks (id,operation_id,project_id,business_unit_id,assignee_user_id,title,status,due_at,notes,created_by_user_id,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET operation_id=excluded.operation_id,project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,assignee_user_id=excluded.assignee_user_id,title=excluded.title,status=excluded.status,due_at=excluded.due_at,notes=excluded.notes,created_by_user_id=excluded.created_by_user_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now')`)
      .bind(id, text(row.operation_id), projectId, text(row.business_unit_id), text(row.assignee_user_id), title, status, text(row.due_at), text(row.notes), text(row.created_by), JSON.stringify(row), syncId));
  }
  for (const row of data.calendar_events) {
    const sourceType = text(row.source_type), sourceId = text(row.source_id), title = text(row.title), startAt = text(row.start_at);
    if (!sourceType || !sourceId || !title || !startAt) continue;
    const id = `${sourceType}:${sourceId}`;
    statements.push(db.prepare(`INSERT INTO pa_calendar_events (id,source_type,source_id,title,start_at,end_at,all_day,project_id,business_unit_id,payload_json,last_sync_id,active) VALUES (?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,all_day=excluded.all_day,project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now')`)
      .bind(id, sourceType, sourceId, title, startAt, text(row.end_at), enabled(row.all_day), text(row.project_id), text(row.business_unit_id), JSON.stringify(row), syncId));
  }
  return statements;
}

function reconciliationStatements(db: D1Database, data: SnapshotCollections, syncId: string): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    ...["pa_users", "pa_business_units", "pa_worker_business_units", "pa_clients", "pa_organizations", "pa_projects", "pa_project_assignments", "pa_service_locations", "pa_application_entitlements", "pa_operations", "pa_operation_assignments", "pa_tasks", "pa_calendar_events"]
      .map((table) => db.prepare(`UPDATE ${table} SET active=0 WHERE last_sync_id<>?`).bind(syncId)),
    db.prepare(`UPDATE staff_users SET status='inactive',updated_at=datetime('now') WHERE provisioning_source='project-alpha' AND sync_protected=0
      AND (project_alpha_user_id NOT IN (SELECT id FROM pa_users WHERE active=1) OR project_alpha_user_id NOT IN (SELECT user_id FROM pa_application_entitlements WHERE active=1 AND enabled=1))`),
    db.prepare(`DELETE FROM staff_role_assignments WHERE staff_id IN (SELECT id FROM staff_users WHERE provisioning_source='project-alpha' AND sync_protected=0)`),
    db.prepare(`DELETE FROM staff_divisions WHERE staff_id IN (SELECT id FROM staff_users WHERE provisioning_source='project-alpha' AND sync_protected=0)`),
  ];

  for (const row of data.application_entitlements) {
    const userId = text(row.user_id), role = text(row.role_key);
    if (!userId || !role || !SUPPORTED_ROLES.has(role) || text(row.application_key) !== APPLICATION_KEY || !isTrue(row.enabled)) continue;
    // Empty scope intentionally creates no role or division assignments (fail closed).
    for (const unitId of businessUnitIds(row.business_unit_ids)) {
      statements.push(db.prepare(`INSERT OR IGNORE INTO staff_divisions (staff_id,division_id,is_primary)
        SELECT s.id,d.id,0 FROM staff_users s JOIN divisions d ON d.project_alpha_business_unit_id=? AND d.active=1
        WHERE s.project_alpha_user_id=? AND s.sync_protected=0 AND s.status='active'`).bind(unitId, userId));
      statements.push(db.prepare(`INSERT OR IGNORE INTO staff_role_assignments (id,staff_id,role_id,scope,division_id,scope_key)
        SELECT ?,s.id,?,'division',d.id,d.id FROM staff_users s JOIN divisions d ON d.project_alpha_business_unit_id=? AND d.active=1
        WHERE s.project_alpha_user_id=? AND s.sync_protected=0 AND s.status='active'`)
        .bind(stableId("pa-role", `${userId}-${role}-${unitId}`), role, unitId, userId));
    }
  }
  return statements;
}

export async function syncProjectAlpha(env: Env): Promise<{ status: "disabled" | "success"; records: number }> {
  if (!env.PROJECT_ALPHA_BASE_URL || !env.PROJECT_ALPHA_API_KEY) {
    await env.OPS_DB.prepare("UPDATE integration_health SET status='disabled',updated_at=datetime('now') WHERE integration='project-alpha'").run();
    return { status: "disabled", records: 0 };
  }
  const syncId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  await env.OPS_DB.batch([
    env.OPS_DB.prepare("INSERT INTO sync_runs (id,integration,status) VALUES (?,'project-alpha','running')").bind(runId),
    env.OPS_DB.prepare("UPDATE integration_health SET last_attempt_at=datetime('now'),updated_at=datetime('now') WHERE integration='project-alpha'"),
  ]);
  try {
    // Fetch and validate every page before touching projection data. A failed or partial
    // snapshot therefore leaves the last known good projection entirely intact.
    const data = await fetchCompleteSnapshot(env);
    const records = SNAPSHOT_COLLECTIONS.reduce((count, key) => count + data[key].length, 0);
    await runBatches(env.OPS_DB, projectionStatements(env.OPS_DB, data, syncId));
    await runBatches(env.OPS_DB, reconciliationStatements(env.OPS_DB, data, syncId));
    await env.OPS_DB.batch([
      env.OPS_DB.prepare("UPDATE sync_runs SET status='success',completed_at=datetime('now'),records_seen=? WHERE id=?").bind(records, runId),
      env.OPS_DB.prepare("UPDATE integration_health SET status='healthy',last_success_at=datetime('now'),last_error_code=NULL,updated_at=datetime('now') WHERE integration='project-alpha'"),
    ]);
    return { status: "success", records };
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : "unknown";
    await env.OPS_DB.batch([
      env.OPS_DB.prepare("UPDATE sync_runs SET status='failed',completed_at=datetime('now'),error_code=? WHERE id=?").bind(code, runId),
      env.OPS_DB.prepare("UPDATE integration_health SET status='error',last_error_code=?,updated_at=datetime('now') WHERE integration='project-alpha'").bind(code),
    ]);
    throw error;
  }
}
