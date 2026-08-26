import type { Env } from "./types";
import { PRIMARY_PROJECT_ALPHA_SOURCE, createProjectAlphaSourceContext, mapProjectAlphaSourceRow,
  prepareProjectAlphaSourceRecords, projectAlphaSourceReferences,
  type ProjectAlphaSourceContext, type ProjectAlphaSourceMap } from "./project-alpha-source";

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
  "task_assignments",
  "calendar_events",
] as const;

type CollectionName = (typeof SNAPSHOT_COLLECTIONS)[number];
type SnapshotCollections = Record<CollectionName, Row[]>;
type CollectionFingerprints = Record<CollectionName, string>;
type ProjectionEntityType = "business_unit"|"client"|"organization"|"project"|"project_assignment"|"operation"|"operation_assignment"|"task"|"task_assignment";

interface Snapshot extends SnapshotCollections {
  generated_at: string;
  has_more: boolean;
  next_page: number | null;
}

const SUPPORTED_ROLES = new Set(["role-admin", "role-operator", "role-delivery-coordinator", "role-division-manager"]);
const SNAPSHOT_MAX_PAGES = 100;
const SNAPSHOT_MAX_RECORDS = 50_000;
const SNAPSHOT_MAX_PAGE_BYTES = 4 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 10_000;
const SNAPSHOT_FETCH_ATTEMPTS = 3;
const PROJECTION_LEASE_DURATION = "+10 minutes";

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

function membershipActive(row: Row): number {
  const end = text(row.ends_at)?.trim();
  if (!end) return 1;
  const timestamp = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(end) ? `${end.replace(" ", "T")}Z` : end);
  return Number.isFinite(timestamp) && timestamp > Date.now() ? 1 : 0;
}

function configuredApplicationKey(value: string): string {
  const key = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(key)) throw new Error("project-alpha-application-key-invalid");
  return key;
}

function snapshotBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("project-alpha-base-url-invalid"); }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password) {
    throw new Error("project-alpha-base-url-invalid");
  }
  return url;
}

function normalizedEmail(value: unknown): string | null {
  const email = text(value)?.trim().toLowerCase() ?? "";
  return email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function emptyCollections(): SnapshotCollections {
  const collections = {} as SnapshotCollections;
  for (const key of SNAPSHOT_COLLECTIONS) collections[key] = [];
  return collections;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

async function collectionFingerprints(data: SnapshotCollections): Promise<CollectionFingerprints> {
  const result = {} as CollectionFingerprints;
  for (const collection of SNAPSHOT_COLLECTIONS) {
    // Sort canonical rows so pagination and source query order do not cause writes.
    const canonical = data[collection].map(canonicalJson).sort().join("\n");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
    result[collection] = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return result;
}

async function changedCollections(db: D1Database, fingerprints: CollectionFingerprints, source: ProjectAlphaSourceContext): Promise<Set<CollectionName>> {
  const previous = await db.prepare("SELECT collection,fingerprint FROM pa_projection_fingerprints WHERE projection_source_id=?").bind(source.sourceId).all<{ collection: string; fingerprint: string }>();
  const byCollection = new Map(previous.results.map((row) => [row.collection, row.fingerprint]));
  return new Set(SNAPSHOT_COLLECTIONS.filter((collection) => byCollection.get(collection) !== fingerprints[collection]));
}

const VERSIONED_COLLECTIONS: ReadonlyArray<[CollectionName,ProjectionEntityType]> = [
  ["business_units","business_unit"],["clients","client"],["organizations","organization"],["projects","project"],
  ["project_assignments","project_assignment"],["operations","operation"],["operation_assignments","operation_assignment"],
  ["tasks","task"],["task_assignments","task_assignment"],
];

function snapshotEntityId(collection:CollectionName,row:Row):string|null {
  if(collection==="operation_assignments"){
    const operationId=text(row.operation_id),userId=text(row.user_id);
    return operationId&&userId?`${operationId}:${userId}`:null;
  }
  if(collection==="task_assignments"){
    const taskId=text(row.task_id),userId=text(row.user_id);
    return taskId&&userId?`${taskId}:${userId}`:null;
  }
  return text(row.id);
}

function snapshotMappingRow(collection: CollectionName, row: Row): Row {
  // The legacy calendar key is the source tuple, even when an export has an id.
  // Derive it before mapping references so existing primary URLs stay unchanged.
  return collection === "calendar_events" && text(row.source_type) && text(row.source_id)
    ? { ...row, id: `${text(row.source_type)}:${text(row.source_id)}` } : row;
}

async function preserveNewerIncrementalRows(db:D1Database,data:SnapshotCollections,generatedAt:string,source:ProjectAlphaSourceContext):Promise<SnapshotCollections>{
  const versions=await db.prepare("SELECT entity_type,entity_id,source_updated_at FROM pa_projection_entity_versions WHERE projection_source_id=?").bind(source.sourceId).all<{entity_type:string;entity_id:string;source_updated_at:string}>();
  const entitlementVersions=await db.prepare("SELECT user_id,last_event_at FROM pa_application_entitlements WHERE projection_source_id=? AND last_event_at IS NOT NULL").bind(source.sourceId).all<{user_id:string;last_event_at:string}>();
  const latest=new Map(versions.results.map((row)=>[`${row.entity_type}:${row.entity_id}`,Date.parse(row.source_updated_at)]));
  const latestEntitlement=new Map(entitlementVersions.results.map((row)=>[row.user_id,Date.parse(row.last_event_at)]));
  const protectedData={...data} as SnapshotCollections;
  protectedData.users=data.users.filter((row)=>(latestEntitlement.get(text(row.id)??"")??-Infinity)<=Date.parse(text(row.updated_at)??generatedAt));
  protectedData.application_entitlements=data.application_entitlements.filter((row)=>(latestEntitlement.get(text(row.user_id)??"")??-Infinity)<=Date.parse(text(row.updated_at)??generatedAt));
  for(const [collection,entityType] of VERSIONED_COLLECTIONS){
    protectedData[collection]=data[collection].filter((row)=>{
      const entityId=snapshotEntityId(collection,row);
      if(!entityId)return true;
      const snapshotTimestamp=Date.parse(text(row.updated_at)??generatedAt);
      const projectedTimestamp=latest.get(`${entityType}:${entityId}`);
      return projectedTimestamp===undefined||!Number.isFinite(projectedTimestamp)||projectedTimestamp<=snapshotTimestamp;
    });
  }
  return protectedData;
}

function validatePage(value: unknown): Snapshot {
  if (!value || typeof value !== "object") throw new Error("project-alpha-schema-root");
  const page = value as Partial<Snapshot>;
  for (const key of SNAPSHOT_COLLECTIONS) {
    if (!Array.isArray(page[key])) throw new Error(`project-alpha-schema-${key}`);
  }
  if(typeof page.generated_at!=="string"||!Number.isFinite(Date.parse(page.generated_at)))throw new Error("project-alpha-schema-generated-at");
  if (typeof page.has_more !== "boolean") throw new Error("project-alpha-schema-has-more");
  return page as Snapshot;
}

function retryableSnapshotResponse(response: Response): boolean { return response.status === 429 || response.status >= 500; }
async function retryDelay(milliseconds: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve,milliseconds)); }

async function fetchSnapshotPage(url: URL, connection: ProjectAlphaSourceConnection, beforeAttempt?:()=>Promise<void>): Promise<Response> {
  let lastError: unknown;
  for(let attempt=1;attempt<=SNAPSHOT_FETCH_ATTEMPTS;attempt+=1){
    try {
      await beforeAttempt?.();
      const response=await fetch(url,{headers:{Authorization:`Bearer ${connection.apiKey}`,Accept:"application/json"},signal:AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS),redirect:"error"});
      if(!retryableSnapshotResponse(response)||attempt===SNAPSHOT_FETCH_ATTEMPTS)return response;
      lastError=new Error(`project-alpha-http-${response.status}`);
      await response.body?.cancel();
    } catch(error) {
      lastError=error;
      if(attempt===SNAPSHOT_FETCH_ATTEMPTS)break;
    }
    await retryDelay(50*2**(attempt-1));
  }
  throw new Error(`project-alpha-network:${lastError instanceof Error?lastError.message:"unknown"}`);
}

async function fetchCompleteSnapshot(connection: ProjectAlphaSourceConnection, beforeAttempt?:()=>Promise<void>): Promise<{data:SnapshotCollections;generatedAt:string}> {
  const result = emptyCollections();
  const baseUrl = snapshotBaseUrl(connection.baseUrl);
  let pageNumber = 1;
  let records=0;
  let generatedAt="";
  let generatedAtTimestamp=-Infinity;
  for (let pagesRead = 0; pagesRead < SNAPSHOT_MAX_PAGES; pagesRead += 1) {
    const url = new URL("/api/v1/ops/snapshot", baseUrl);
    url.searchParams.set("page", String(pageNumber));
    url.searchParams.set("limit", "500");
    const response = await fetchSnapshotPage(url,connection,beforeAttempt);
    if (!response.ok) throw new Error(`project-alpha-http-${response.status}`);
    const declaredBytes=Number(response.headers.get("content-length")??0);
    if(declaredBytes>SNAPSHOT_MAX_PAGE_BYTES)throw new Error("project-alpha-page-too-large");
    const bytes=await response.arrayBuffer();
    if(bytes.byteLength>SNAPSHOT_MAX_PAGE_BYTES)throw new Error("project-alpha-page-too-large");
    const page = validatePage(JSON.parse(new TextDecoder().decode(bytes)));
    const pageGeneratedAt=Date.parse(page.generated_at);
    if(pageGeneratedAt>generatedAtTimestamp){generatedAtTimestamp=pageGeneratedAt;generatedAt=page.generated_at;}
    for (const key of SNAPSHOT_COLLECTIONS) {
      records+=page[key].length;
      if(records>SNAPSHOT_MAX_RECORDS)throw new Error("project-alpha-record-limit");
      result[key].push(...page[key]);
    }
    if (!page.has_more) return {data:result,generatedAt};
    if (!page.next_page || page.next_page <= pageNumber) throw new Error("project-alpha-pagination");
    pageNumber = page.next_page;
  }
  throw new Error("project-alpha-page-limit");
}

async function claimSnapshotLease(db: D1Database, owner: string, source: ProjectAlphaSourceContext): Promise<void> {
  const claimed=await db.prepare(`INSERT INTO pa_projection_entity_leases (entity_type,entity_id,owner_event_id,lease_until,projection_source_id)
    VALUES ('integration_projection','project-alpha',?,datetime('now',?),?)
    ON CONFLICT(projection_source_id,entity_type,entity_id) DO UPDATE SET owner_event_id=excluded.owner_event_id,lease_until=excluded.lease_until,updated_at=datetime('now')
    WHERE datetime(pa_projection_entity_leases.lease_until)<=datetime('now') RETURNING owner_event_id`)
    .bind(owner,PROJECTION_LEASE_DURATION,source.sourceId).first<{owner_event_id:string}>();
  if(claimed?.owner_event_id!==owner)throw new Error("project-alpha-sync-busy");
}

async function releaseSnapshotLease(db: D1Database, owner: string, source: ProjectAlphaSourceContext): Promise<void> {
  await db.prepare("DELETE FROM pa_projection_entity_leases WHERE entity_type='integration_projection' AND entity_id='project-alpha' AND owner_event_id=? AND projection_source_id=?").bind(owner,source.sourceId).run();
}

async function refreshSnapshotLease(db:D1Database,owner:string,source:ProjectAlphaSourceContext):Promise<void>{
  const refreshed=await db.prepare(`UPDATE pa_projection_entity_leases SET lease_until=datetime('now',?),updated_at=datetime('now')
    WHERE entity_type='integration_projection' AND entity_id='project-alpha' AND owner_event_id=? AND projection_source_id=? RETURNING owner_event_id`)
    .bind(PROJECTION_LEASE_DURATION,owner,source.sourceId).first<{owner_event_id:string}>();
  if(refreshed?.owner_event_id!==owner)throw new Error("project-alpha-sync-lease-lost");
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[], beforeBatch?:()=>Promise<void>): Promise<void> {
  for (let index = 0; index < statements.length; index += 75) {
    await beforeBatch?.();
    await db.batch(statements.slice(index, index + 75));
  }
}

function projectionStatements(db: D1Database, data: SnapshotCollections, syncId: string, changed: ReadonlySet<CollectionName>, applicationKey: string, generatedAt: string, source: ProjectAlphaSourceContext, ids: ProjectAlphaSourceMap): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (changed.has("users")) for (const raw of data.users) {
    const row = mapProjectAlphaSourceRow("users", raw, ids);
    const id = text(row.id);
    if (!id) continue;
    const email = normalizedEmail(row.email);
    const display = text(row.display_name) || text(row.username) || email || `User ${id}`;
    const isActive = sourceActive(row);
    statements.push(db.prepare(`INSERT INTO pa_users (id,email,display_name,role,active,payload_json,last_sync_id,projection_source_id) VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,role=excluded.role,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`)
      .bind(id, email, display, text(row.role), isActive, JSON.stringify(raw), syncId, source.sourceId));
    if (!source.staffAuthority) continue;
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

  if (changed.has("business_units")) for (const raw of data.business_units) {
    const row = mapProjectAlphaSourceRow("business_units", raw, ids);
    const id = text(row.id);
    if (!id) continue;
    const name = text(row.name) || `Business unit ${id}`;
    const code = text(row.code) || stableId("pa", id);
    const isActive = row.is_active === false || row.is_active === 0 ? 0 : 1;
    statements.push(db.prepare(`INSERT INTO pa_business_units (id,name,code,active,payload_json,last_sync_id,projection_source_id) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,code=excluded.code,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`)
      .bind(id, name, text(row.code), isActive, JSON.stringify(raw), syncId, source.sourceId));
    if (!source.staffAuthority) continue;
    statements.push(db.prepare(`UPDATE divisions SET name=?,code=?,active=?,updated_at=datetime('now') WHERE project_alpha_business_unit_id=?`)
      .bind(name, code, isActive, id));
    statements.push(db.prepare(`INSERT INTO divisions (id,name,code,project_alpha_business_unit_id,active)
      SELECT ?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM divisions WHERE project_alpha_business_unit_id=?)`)
      .bind(stableId("division-pa", id), name, code, id, isActive, id));
  }

  if (changed.has("worker_business_units")) for (const raw of data.worker_business_units) {
    const row = mapProjectAlphaSourceRow("worker_business_units", raw, ids);
    const userId = text(row.user_id), unitId = text(row.business_unit_id);
    if (!userId || !unitId) continue;
    statements.push(db.prepare(`INSERT INTO pa_worker_business_units (user_id,business_unit_id,is_lead,active,payload_json,last_sync_id,projection_source_id) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(user_id,business_unit_id) DO UPDATE SET is_lead=excluded.is_lead,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id`)
      .bind(userId, unitId, enabled(row.is_lead), membershipActive(row), JSON.stringify(raw), syncId, source.sourceId));
  }

  if (changed.has("clients")) for (const raw of data.clients) {
    const row = mapProjectAlphaSourceRow("clients", raw, ids);
    const id = text(row.id); if (!id) continue;
    statements.push(db.prepare(`INSERT INTO pa_clients (id,name,organization_id,active,payload_json,last_sync_id,projection_source_id) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,organization_id=excluded.organization_id,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`)
      .bind(id, text(row.name) || `Client ${text(raw.id)}`, text(row.organization_id), sourceActive(row), JSON.stringify(raw), syncId, source.sourceId));
  }
  if (changed.has("organizations")) for (const raw of data.organizations) {
    const row = mapProjectAlphaSourceRow("organizations", raw, ids);
    const id = text(row.id); if (!id) continue;
    statements.push(db.prepare(`INSERT INTO pa_organizations (id,name,active,payload_json,last_sync_id,projection_source_id) VALUES (?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`)
      .bind(id, text(row.name) || `Organization ${text(raw.id)}`, sourceActive(row), JSON.stringify(raw), syncId, source.sourceId));
  }
  if (changed.has("projects")) for (const raw of data.projects) {
    const row = mapProjectAlphaSourceRow("projects", raw, ids);
    const id = text(row.id); if (!id) continue;
    statements.push(db.prepare(`INSERT INTO pa_projects (id,client_id,organization_id,business_unit_id,manager_user_id,name,status,start_date,end_date,active,payload_json,last_sync_id,projection_source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET client_id=excluded.client_id,organization_id=excluded.organization_id,business_unit_id=excluded.business_unit_id,manager_user_id=excluded.manager_user_id,name=excluded.name,status=excluded.status,start_date=excluded.start_date,end_date=excluded.end_date,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')`)
      .bind(id, text(row.client_id), text(row.organization_id), text(row.business_unit_id), text(row.manager_user_id), text(row.name) || `Project ${text(raw.id)}`, text(row.status), text(row.start_date) || text(row.estimated_start), text(row.end_date) || text(row.estimated_end), sourceActive(row), JSON.stringify(raw), syncId, source.sourceId));
  }
  if (changed.has("project_assignments")) for (const raw of data.project_assignments) {
    const row = mapProjectAlphaSourceRow("project_assignments", raw, ids);
    const id = text(row.id), projectId = text(row.project_id), userId = text(row.user_id); if (!id || !projectId || !userId) continue;
    statements.push(db.prepare(`INSERT INTO pa_project_assignments (id,project_id,user_id,active,payload_json,last_sync_id,projection_source_id) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,user_id=excluded.user_id,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id`)
      .bind(id, projectId, userId, membershipActive(row), JSON.stringify(raw), syncId, source.sourceId));
  }
  if (changed.has("service_locations")) for (const raw of data.service_locations) {
    const row = mapProjectAlphaSourceRow("service_locations", raw, ids);
    const id = text(row.id); if (!id) continue;
    statements.push(db.prepare(`INSERT INTO pa_service_locations (id,project_id,client_id,organization_id,name,latitude,longitude,active,payload_json,last_sync_id,projection_source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,client_id=excluded.client_id,organization_id=excluded.organization_id,name=excluded.name,latitude=excluded.latitude,longitude=excluded.longitude,active=excluded.active,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id`)
      .bind(id, text(row.project_id), text(row.client_id), text(row.organization_id), text(row.name), row.latitude ?? null, row.longitude ?? null, sourceActive(row), JSON.stringify(raw), syncId, source.sourceId));
  }

  if (source.staffAuthority && changed.has("application_entitlements")) for (const raw of data.application_entitlements) {
    const row = mapProjectAlphaSourceRow("application_entitlements", raw, ids);
    const id = text(row.id), userId = text(row.user_id), role = text(row.role_key);
    if (!id || !userId || !role || !SUPPORTED_ROLES.has(role) || text(row.application_key) !== applicationKey) continue;
    statements.push(db.prepare(`INSERT INTO pa_application_entitlements (id,user_id,application_key,enabled,role_key,business_unit_ids_json,payload_json,last_event_at,last_sync_id,active,projection_source_id) VALUES (?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(user_id) DO UPDATE SET application_key=excluded.application_key,enabled=excluded.enabled,role_key=excluded.role_key,business_unit_ids_json=excluded.business_unit_ids_json,payload_json=excluded.payload_json,last_event_at=excluded.last_event_at,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now')
      WHERE pa_application_entitlements.last_event_at IS NULL OR datetime(pa_application_entitlements.last_event_at)<=datetime(excluded.last_event_at)`)
      .bind(id, userId, applicationKey, enabled(row.enabled), role, "[]", JSON.stringify(raw), generatedAt, syncId, source.sourceId));
  }
  if (changed.has("operations")) for (const raw of data.operations) {
    const row = mapProjectAlphaSourceRow("operations", raw, ids);
    const id = text(row.id), projectId = text(row.project_id), title = text(row.title), status = text(row.status);
    if (!id || !projectId || !title || !status) continue;
    statements.push(db.prepare(`INSERT INTO pa_operations (id,project_id,business_unit_id,title,status,scheduled_start_at,scheduled_end_at,location,notes,created_by_user_id,payload_json,last_sync_id,active,projection_source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,title=excluded.title,status=excluded.status,scheduled_start_at=excluded.scheduled_start_at,scheduled_end_at=excluded.scheduled_end_at,location=excluded.location,notes=excluded.notes,created_by_user_id=excluded.created_by_user_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now')`)
      .bind(id, projectId, text(row.business_unit_id), title, status, text(row.scheduled_start_at), text(row.scheduled_end_at), text(row.location), text(row.notes), text(row.created_by), JSON.stringify(raw), syncId, source.sourceId));
  }
  if (changed.has("operation_assignments")) for (const raw of data.operation_assignments) {
    const row = mapProjectAlphaSourceRow("operation_assignments", raw, ids);
    const operationId = text(row.operation_id), userId = text(row.user_id); if (!operationId || !userId) continue;
    statements.push(db.prepare(`INSERT INTO pa_operation_assignments (operation_id,user_id,assignment_role,assigned_by_user_id,assigned_at,payload_json,last_sync_id,active,projection_source_id) VALUES (?,?,?,?,?,?,?,1,?)
      ON CONFLICT(operation_id,user_id) DO UPDATE SET assignment_role=excluded.assignment_role,assigned_by_user_id=excluded.assigned_by_user_id,assigned_at=excluded.assigned_at,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1`)
      .bind(operationId, userId, text(row.assignment_role), text(row.assigned_by), text(row.assigned_at), JSON.stringify(raw), syncId, source.sourceId));
  }
  if (changed.has("tasks")) for (const raw of data.tasks) {
    const row = mapProjectAlphaSourceRow("tasks", raw, ids);
    const id = text(row.id), projectId = text(row.project_id), title = text(row.title), status = text(row.status); if (!id || !projectId || !title || !status) continue;
    statements.push(db.prepare(`INSERT INTO pa_tasks (id,operation_id,project_id,business_unit_id,assignee_user_id,title,status,due_at,notes,created_by_user_id,payload_json,last_sync_id,active,projection_source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET operation_id=excluded.operation_id,project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,assignee_user_id=excluded.assignee_user_id,title=excluded.title,status=excluded.status,due_at=excluded.due_at,notes=excluded.notes,created_by_user_id=excluded.created_by_user_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now')`)
      .bind(id, text(row.operation_id), projectId, text(row.business_unit_id), text(row.assignee_user_id), title, status, text(row.due_at), text(row.notes), text(row.created_by), JSON.stringify(raw), syncId, source.sourceId));
  }
  if (changed.has("task_assignments")) for (const raw of data.task_assignments) {
    const row = mapProjectAlphaSourceRow("task_assignments", raw, ids);
    const taskId = text(row.task_id), userId = text(row.user_id); if (!taskId || !userId) continue;
    statements.push(db.prepare(`INSERT INTO pa_task_assignments (task_id,user_id,assigned_by_user_id,assigned_at,payload_json,last_sync_id,active,projection_source_id) VALUES (?,?,?,?,?,?,1,?)
      ON CONFLICT(task_id,user_id) DO UPDATE SET assigned_by_user_id=excluded.assigned_by_user_id,assigned_at=excluded.assigned_at,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1`)
      .bind(taskId,userId,text(row.assigned_by),text(row.assigned_at),JSON.stringify(raw),syncId,source.sourceId));
  }
  if (changed.has("calendar_events")) for (const raw of data.calendar_events) {
    const row = mapProjectAlphaSourceRow("calendar_events", snapshotMappingRow("calendar_events",raw), ids);
    const sourceType = text(row.source_type), sourceId = text(row.source_id), title = text(row.title), startAt = text(row.start_at);
    if (!sourceType || !sourceId || !title || !startAt) continue;
    const id = text(row.id);
    if (!id) continue;
    statements.push(db.prepare(`INSERT INTO pa_calendar_events (id,source_type,source_id,title,start_at,end_at,all_day,project_id,business_unit_id,payload_json,last_sync_id,active,projection_source_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,all_day=excluded.all_day,project_id=excluded.project_id,business_unit_id=excluded.business_unit_id,payload_json=excluded.payload_json,last_sync_id=excluded.last_sync_id,active=1,updated_at=datetime('now')`)
      .bind(id, sourceType, sourceId, title, startAt, text(row.end_at), enabled(row.all_day), text(row.project_id), text(row.business_unit_id), JSON.stringify(raw), syncId, source.sourceId));
  }
  return statements;
}

interface CurrentPortalProjectionState {
  clients: Array<{ id: string; active: number }>;
  organizations: Array<{ id: string; active: number }>;
  projects: Array<{ id: string; client_id: string | null; organization_id: string | null; active: number }>;
}

async function currentPortalProjectionState(env: Env): Promise<CurrentPortalProjectionState> {
  const [clients, organizations, projects] = await Promise.all([
    env.OPS_DB.prepare("SELECT id,active FROM pa_clients WHERE projection_source_id='project-alpha:primary'").all<{ id: string; active: number }>(),
    env.OPS_DB.prepare("SELECT id,active FROM pa_organizations WHERE projection_source_id='project-alpha:primary'").all<{ id: string; active: number }>(),
    env.OPS_DB.prepare("SELECT id,client_id,organization_id,active FROM pa_projects WHERE projection_source_id='project-alpha:primary'").all<{ id: string; client_id: string | null; organization_id: string | null; active: number }>(),
  ]);
  return { clients: clients.results, organizations: organizations.results, projects: projects.results };
}

async function clientPortalProjectionStatements(env: Env, data: SnapshotCollections, changed: ReadonlySet<CollectionName>): Promise<D1PreparedStatement[]> {
  const db = env.DELIVERY_DB;
  const statements: D1PreparedStatement[] = [];
  const portalChanged = changed.has("clients") || changed.has("organizations") || changed.has("projects");
  // The filtered snapshot intentionally omits entities protected by a newer
  // webhook. Use the already-reconciled OPS_DB projection as the authoritative
  // active set so an omission cannot be misread as a portal deletion.
  const current = portalChanged ? await currentPortalProjectionState(env) : { clients: [], organizations: [], projects: [] };
  if (changed.has("clients")) for (const row of data.clients) {
    const id = text(row.id), name = text(row.name);
    if (id && name) statements.push(db.prepare("UPDATE client_accounts SET display_name=?,project_alpha_organization_id=?,status=?,updated_at=datetime('now') WHERE project_alpha_source_id='project-alpha:primary' AND project_alpha_client_id=?")
      .bind(name, text(row.organization_id), sourceActive(row) ? "active" : "suspended", id));
  }
  if (changed.has("organizations")) for (const row of data.organizations) {
    const id = text(row.id), name = text(row.name);
    if (id && name) statements.push(db.prepare("UPDATE client_accounts SET display_name=?,status=?,updated_at=datetime('now') WHERE project_alpha_source_id='project-alpha:primary' AND project_alpha_organization_id=? AND project_alpha_client_id IS NULL")
      .bind(name, sourceActive(row) ? "active" : "suspended", id));
  }
  if (changed.has("projects")) {
    const clients = new Map(data.clients.map(row => [text(row.id), text(row.name)]));
    const organizations = new Map(data.organizations.map(row => [text(row.id), text(row.name)]));
    for (const row of data.projects) {
      const id = text(row.id), projectName = text(row.name);
      if (!id || !projectName) continue;
      const clientName = clients.get(text(row.client_id)) || organizations.get(text(row.organization_id)) || "Client";
      statements.push(db.prepare(`UPDATE projects SET client_name=?,project_name=?,status=?,summary=?,site_address=?,service_address=?,
        project_contact_name=?,project_contact_email=?,project_contact_phone=?,next_milestone=?,source_updated_at=?,
        updated_at=datetime('now'),active=? WHERE project_alpha_source_id='project-alpha:primary' AND project_alpha_project_id=?`)
        .bind(clientName, projectName, text(row.status), text(row.summary) || text(row.description), text(row.site_address),
          text(row.service_address), text(row.project_contact_name), normalizedEmail(row.project_contact_email),
          text(row.project_contact_phone), text(row.next_milestone), text(row.updated_at), sourceActive(row), id));
    }
  }
  if (changed.has("clients")) {
    const activeClientIds = current.clients.filter(row => row.active === 1).map(row => row.id);
    statements.push(db.prepare(`UPDATE client_accounts SET status='suspended',updated_at=datetime('now')
      WHERE project_alpha_source_id='project-alpha:primary' AND project_alpha_client_id IS NOT NULL AND project_alpha_client_id NOT IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(activeClientIds)));
  }
  if (changed.has("organizations")) {
    const activeOrganizationIds = current.organizations.filter(row => row.active === 1).map(row => row.id);
    statements.push(db.prepare(`UPDATE client_accounts SET status='suspended',updated_at=datetime('now')
      WHERE project_alpha_source_id='project-alpha:primary' AND project_alpha_client_id IS NULL AND project_alpha_organization_id IS NOT NULL
        AND project_alpha_organization_id NOT IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(activeOrganizationIds)));
  }
  if (changed.has("projects")) {
    const activeProjectIds = current.projects.filter(row => row.active === 1).map(row => row.id);
    // A source may legitimately have more records than D1's bind-parameter
    // budget. One exact JSON relation also handles an empty active set safely.
    statements.push(db.prepare(`UPDATE projects SET active=0,updated_at=datetime('now')
      WHERE project_alpha_source_id='project-alpha:primary' AND project_alpha_project_id IS NOT NULL AND project_alpha_project_id NOT IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(activeProjectIds)));
  }

  if (portalChanged) {
    const activeClients = new Set(current.clients.filter(row => row.active === 1).map(row => row.id));
    const activeOrganizations = new Set(current.organizations.filter(row => row.active === 1).map(row => row.id));
    for (const row of current.projects) {
      const projectId = row.id;
      const clientId = row.client_id && activeClients.has(row.client_id) ? row.client_id : null;
      const organizationId = row.organization_id && activeOrganizations.has(row.organization_id) ? row.organization_id : null;
      const active = row.active === 1 ? 1 : 0;
      const invalidAccounts = `SELECT g.account_id FROM client_project_grants g
        JOIN client_accounts a ON a.id=g.account_id
        JOIN projects p ON p.id=g.project_id
        WHERE p.project_alpha_source_id='project-alpha:primary' AND p.project_alpha_project_id=?
          AND COALESCE(a.project_alpha_source_id,'project-alpha:primary')='project-alpha:primary' AND g.revoked_at IS NULL AND NOT
          (?=1 AND a.status='active' AND ((? IS NOT NULL AND a.project_alpha_client_id IS ?)
            OR (g.can_request_service=0 AND ? IS NOT NULL AND a.project_alpha_organization_id IS ?)))`;
      const invalidValues = [projectId, active, clientId, clientId, organizationId, organizationId];
      for (const table of ["client_folder_associations", "client_delivery_grants", "client_member_project_grants"] as const) {
        statements.push(db.prepare(`UPDATE ${table} SET revoked_at=COALESCE(revoked_at,datetime('now'))
          WHERE project_id IN (SELECT id FROM projects WHERE project_alpha_source_id='project-alpha:primary' AND project_alpha_project_id=?) AND revoked_at IS NULL
            AND account_id IN (${invalidAccounts})`).bind(projectId, ...invalidValues));
      }
      statements.push(db.prepare(`UPDATE client_project_grants SET revoked_at=COALESCE(revoked_at,datetime('now'))
        WHERE project_id IN (SELECT id FROM projects WHERE project_alpha_source_id='project-alpha:primary' AND project_alpha_project_id=?) AND revoked_at IS NULL
          AND account_id IN (${invalidAccounts})`).bind(projectId, ...invalidValues));
    }
    for (const table of ["client_folder_associations", "client_delivery_grants", "client_member_project_grants", "client_project_grants"] as const) {
      statements.push(db.prepare(`UPDATE ${table} SET revoked_at=COALESCE(revoked_at,datetime('now'))
        WHERE project_id IN (SELECT id FROM projects WHERE project_alpha_source_id='project-alpha:primary' AND project_alpha_project_id IS NOT NULL AND active=0) AND revoked_at IS NULL`));
    }
    statements.push(db.prepare(`UPDATE client_folder_associations SET revoked_at=COALESCE(revoked_at,datetime('now'))
      WHERE scope_type='client' AND revoked_at IS NULL AND account_id IN (SELECT id FROM client_accounts WHERE COALESCE(project_alpha_source_id,'project-alpha:primary')='project-alpha:primary' AND status<>'active')`));
  }
  return statements;
}

function reconciliationStatements(db: D1Database, data: SnapshotCollections, syncId: string, changed: ReadonlySet<CollectionName>, applicationKey: string, generatedAt: string, source: ProjectAlphaSourceContext): D1PreparedStatement[] {
  const tables: Record<CollectionName, string> = {
    users: "pa_users", business_units: "pa_business_units", worker_business_units: "pa_worker_business_units",
    clients: "pa_clients", organizations: "pa_organizations", projects: "pa_projects",
    project_assignments: "pa_project_assignments", service_locations: "pa_service_locations",
    application_entitlements: "pa_application_entitlements", operations: "pa_operations",
    operation_assignments: "pa_operation_assignments", tasks: "pa_tasks", task_assignments: "pa_task_assignments", calendar_events: "pa_calendar_events",
  };
  const entityTypes=new Map<CollectionName,ProjectionEntityType>(VERSIONED_COLLECTIONS);
  const statements: D1PreparedStatement[] = SNAPSHOT_COLLECTIONS
    .filter((collection) => changed.has(collection) && (source.staffAuthority || collection !== "application_entitlements"))
    .map((collection) => {
      const entityType=entityTypes.get(collection);
      if(collection==="application_entitlements")return db.prepare(`UPDATE pa_application_entitlements SET active=0 WHERE last_sync_id<>? AND active<>0 AND projection_source_id=?
        AND (last_event_at IS NULL OR datetime(last_event_at)<=datetime(?))`).bind(syncId,source.sourceId,generatedAt);
      if(collection==="users")return db.prepare(`UPDATE pa_users SET active=0 WHERE last_sync_id<>? AND active<>0 AND projection_source_id=?
        AND NOT EXISTS (SELECT 1 FROM pa_application_entitlements e WHERE e.user_id=pa_users.id AND e.projection_source_id=pa_users.projection_source_id AND datetime(e.last_event_at)>datetime(?))`).bind(syncId,source.sourceId,generatedAt);
      if(!entityType)return db.prepare(`UPDATE ${tables[collection]} SET active=0 WHERE last_sync_id<>? AND active<>0 AND projection_source_id=?`).bind(syncId,source.sourceId);
      return db.prepare(`UPDATE ${tables[collection]} SET active=0 WHERE last_sync_id<>? AND active<>0 AND projection_source_id=?
        AND NOT (last_sync_id LIKE 'event:%' AND EXISTS (
          SELECT 1 FROM pa_projection_entity_versions v WHERE v.entity_type=? AND v.projection_source_id=${tables[collection]}.projection_source_id AND v.event_id=substr(${tables[collection]}.last_sync_id,7)
            AND datetime(v.source_updated_at)>datetime(?)
        ))`).bind(syncId,source.sourceId,entityType,generatedAt);
    });

  // Business ingestion is not a grant to manage local staff, divisions or Access.
  if (!source.staffAuthority) return statements;

  const authorizationChanged = changed.has("users") || changed.has("business_units") || changed.has("application_entitlements");
  // Reconcile a legacy PA-managed staff row by its verified PA email on every
  // snapshot.  A historical PA identity may have been retired and replaced
  // while retaining the same sign-in email; limiting the association repair to
  // changed snapshot collections leaves that row permanently inactive once the
  // snapshots have stabilized.  Never replace an identity that still has an
  // active entitlement for this application, and never touch protected staff.
  statements.push(db.prepare(`UPDATE staff_users AS s
    SET project_alpha_user_id=(
      SELECT u.id FROM pa_users u
      JOIN pa_application_entitlements e ON e.user_id=u.id
      WHERE lower(u.email)=lower(s.email)
        AND u.projection_source_id='project-alpha:primary' AND e.projection_source_id='project-alpha:primary'
        AND u.active=1 AND e.active=1 AND e.enabled=1 AND e.application_key=?
      ORDER BY u.id LIMIT 1
    ), status='active', provisioning_source='project-alpha', updated_at=datetime('now')
    WHERE s.provisioning_source='project-alpha' AND s.sync_protected=0
      AND EXISTS (
        SELECT 1 FROM pa_users u
        JOIN pa_application_entitlements e ON e.user_id=u.id
        WHERE lower(u.email)=lower(s.email)
          AND u.projection_source_id='project-alpha:primary' AND e.projection_source_id='project-alpha:primary'
          AND u.active=1 AND e.active=1 AND e.enabled=1 AND e.application_key=?
      )
      AND (s.project_alpha_user_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM pa_application_entitlements current_entitlement
        WHERE current_entitlement.user_id=s.project_alpha_user_id
          AND current_entitlement.projection_source_id='project-alpha:primary'
          AND current_entitlement.active=1 AND current_entitlement.enabled=1
          AND current_entitlement.application_key=?
      ))`).bind(applicationKey, applicationKey, applicationKey));
  if (!authorizationChanged) return statements;

  statements.push(
    db.prepare(`UPDATE staff_users
      SET status=CASE WHEN project_alpha_user_id IN (
        SELECT e.user_id FROM pa_application_entitlements e
        JOIN pa_users u ON u.id=e.user_id
        WHERE e.active=1 AND e.enabled=1 AND u.active=1 AND e.projection_source_id='project-alpha:primary' AND u.projection_source_id='project-alpha:primary'
      ) THEN 'active' ELSE 'inactive' END,
      updated_at=datetime('now')
      WHERE provisioning_source='project-alpha' AND sync_protected=0`),
    db.prepare(`DELETE FROM staff_role_assignments WHERE staff_id IN (SELECT id FROM staff_users WHERE provisioning_source='project-alpha' AND sync_protected=0)`),
    db.prepare(`DELETE FROM staff_divisions WHERE staff_id IN (SELECT id FROM staff_users WHERE provisioning_source='project-alpha' AND sync_protected=0)`),
  );

  statements.push(
    db.prepare(`INSERT OR IGNORE INTO staff_role_assignments (id,staff_id,role_id,scope,division_id,scope_key)
      SELECT 'pa-role-'||replace(e.user_id,':','-')||'-role-admin-global',s.id,'role-admin','global',NULL,'global'
      FROM pa_application_entitlements e JOIN staff_users s ON s.project_alpha_user_id=e.user_id
      WHERE e.active=1 AND e.enabled=1 AND e.projection_source_id='project-alpha:primary' AND e.application_key=? AND e.role_key='role-admin' AND s.sync_protected=0 AND s.status='active'`).bind(applicationKey),
    db.prepare(`INSERT OR IGNORE INTO staff_role_assignments (id,staff_id,role_id,scope,division_id,scope_key)
      SELECT 'pa-role-'||replace(e.user_id,':','-')||'-role-operator-assigned',s.id,'role-operator','assigned',NULL,'assigned'
      FROM pa_application_entitlements e JOIN staff_users s ON s.project_alpha_user_id=e.user_id
      WHERE e.active=1 AND e.enabled=1 AND e.projection_source_id='project-alpha:primary' AND e.application_key=? AND e.role_key<>'role-admin' AND s.sync_protected=0 AND s.status='active'`).bind(applicationKey),
  );
  return statements;
}

function fingerprintStatements(db: D1Database, fingerprints: CollectionFingerprints, changed: ReadonlySet<CollectionName>, syncId: string, source: ProjectAlphaSourceContext): D1PreparedStatement[] {
  return SNAPSHOT_COLLECTIONS.filter((collection) => changed.has(collection)).map((collection) => db.prepare(`
    INSERT INTO pa_projection_fingerprints (collection,fingerprint,last_sync_id,projection_source_id) VALUES (?,?,?,?)
    ON CONFLICT(projection_source_id,collection) DO UPDATE SET fingerprint=excluded.fingerprint,last_sync_id=excluded.last_sync_id,updated_at=datetime('now')
  `).bind(collection, fingerprints[collection], syncId, source.sourceId));
}

function snapshotVersionStatements(db:D1Database,data:SnapshotCollections,changed:ReadonlySet<CollectionName>,syncId:string,generatedAt:string,source:ProjectAlphaSourceContext):D1PreparedStatement[]{
  const statements:D1PreparedStatement[]=[];
  for(const [collection,entityType] of VERSIONED_COLLECTIONS){
    if(!changed.has(collection))continue;
    for(const row of data[collection]){
      const entityId=snapshotEntityId(collection,row);
      if(!entityId)continue;
      const candidate=text(row.updated_at)??generatedAt;
      const sourceUpdatedAt=Number.isFinite(Date.parse(candidate))?candidate:generatedAt;
      statements.push(db.prepare(`INSERT INTO pa_projection_entity_versions (entity_type,entity_id,source_updated_at,event_id,projection_source_id) VALUES (?,?,?,?,?)
        ON CONFLICT(projection_source_id,entity_type,entity_id) DO UPDATE SET source_updated_at=excluded.source_updated_at,event_id=excluded.event_id,updated_at=datetime('now')
        WHERE datetime(pa_projection_entity_versions.source_updated_at)<=datetime(excluded.source_updated_at)`)
        .bind(entityType,entityId,sourceUpdatedAt,`snapshot:${syncId}`,source.sourceId));
    }
  }
  return statements;
}

export interface ProjectAlphaSyncResult {
  status: "disabled" | "success";
  records: number;
  changedCollections: CollectionName[];
}

/** A server-selected connection, never a request body or a URL query selector. */
export interface ProjectAlphaSourceConnection {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly applicationKey: string;
}

export async function syncProjectAlpha(env: Env): Promise<ProjectAlphaSyncResult> {
  if (!env.PROJECT_ALPHA_BASE_URL || !env.PROJECT_ALPHA_API_KEY) {
    await env.OPS_DB.prepare("UPDATE integration_health SET status='disabled',updated_at=datetime('now') WHERE integration='project-alpha' AND projection_source_id='project-alpha:primary'").run();
    return { status: "disabled", records: 0, changedCollections: [] };
  }
  return syncProjectAlphaForSource(env, PRIMARY_PROJECT_ALPHA_SOURCE, {
    baseUrl: env.PROJECT_ALPHA_BASE_URL, apiKey: env.PROJECT_ALPHA_API_KEY, applicationKey: env.APPLICATION_KEY,
  });
}

/** Internal source-scoped ingestion. No secondary public receiver/configuration is
 * enabled here. A future registry must bind this context to an authenticated
 * producer before calling it; credentials never fall back to the primary Env. */
export async function syncProjectAlphaForSource(env: Env, context: ProjectAlphaSourceContext,
  connection: ProjectAlphaSourceConnection): Promise<ProjectAlphaSyncResult> {
  const source = createProjectAlphaSourceContext(context.sourceId);
  const applicationKey = configuredApplicationKey(connection.applicationKey);
  snapshotBaseUrl(connection.baseUrl);
  if (typeof connection.apiKey !== "string" || !connection.apiKey.trim()) throw new Error("project-alpha-api-key-required");
  const syncId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const leaseOwner=`snapshot:${runId}`;
  let leaseClaimed=false;
  await env.OPS_DB.prepare("INSERT INTO integration_health(integration,status,projection_source_id) VALUES('project-alpha','unknown',?) ON CONFLICT(projection_source_id,integration) DO NOTHING").bind(source.sourceId).run();
  const circuit=await env.OPS_DB.prepare("SELECT circuit_open_until FROM integration_health WHERE integration='project-alpha' AND projection_source_id=?").bind(source.sourceId).first<{circuit_open_until:string|null}>();
  if(circuit?.circuit_open_until&&Date.parse(`${circuit.circuit_open_until.replace(" ","T")}Z`)>Date.now())throw new Error("project-alpha-circuit-open");
  await env.OPS_DB.batch([
    env.OPS_DB.prepare("INSERT INTO sync_runs (id,integration,status,projection_source_id) VALUES (?,'project-alpha','running',?)").bind(runId,source.sourceId),
    env.OPS_DB.prepare("UPDATE integration_health SET last_attempt_at=datetime('now'),updated_at=datetime('now') WHERE integration='project-alpha' AND projection_source_id=?").bind(source.sourceId),
  ]);
  try {
    if (source.staffAuthority && !env.DELIVERY_DB) throw new Error("delivery-db-binding-required");
    await claimSnapshotLease(env.OPS_DB,leaseOwner,source);
    leaseClaimed=true;
    // Fetch and validate every page before touching projection data. A failed or partial
    // snapshot therefore leaves the last known good projection entirely intact.
    const refreshLease=()=>refreshSnapshotLease(env.OPS_DB,leaseOwner,source);
    const snapshot = await fetchCompleteSnapshot(connection,refreshLease);
    await refreshLease();
    // Project Alpha uses OFFSET pagination and assigns generated_at per page.
    // Require two complete, byte-bounded passes to produce identical logical
    // collection fingerprints before any projection or deactivation is allowed.
    const firstFingerprints=await collectionFingerprints(snapshot.data);
    const stableSnapshot=await fetchCompleteSnapshot(connection,refreshLease);
    await refreshLease();
    const stableFingerprints=await collectionFingerprints(stableSnapshot.data);
    if(SNAPSHOT_COLLECTIONS.some((collection)=>firstFingerprints[collection]!==stableFingerprints[collection]))throw new Error("project-alpha-snapshot-unstable");
    if(Date.parse(stableSnapshot.generatedAt)<Date.parse(snapshot.generatedAt))throw new Error("project-alpha-snapshot-time-regressed");
    const {data:fetchedData,generatedAt}=stableSnapshot;
    const records = SNAPSHOT_COLLECTIONS.reduce((count, key) => count + fetchedData[key].length, 0);
    const fingerprints = stableFingerprints;
    const fingerprintChanged = await changedCollections(env.OPS_DB, fingerprints,source);
    const changed = new Set(fingerprintChanged);
    // These collections contain time-bounded memberships. Re-evaluate them on
    // every daily recovery even when the source payload fingerprint is unchanged.
    changed.add("worker_business_units");
    changed.add("project_assignments");
    const data=await preserveNewerIncrementalRows(env.OPS_DB,fetchedData,generatedAt,source);
    const refs = SNAPSHOT_COLLECTIONS.filter(collection => source.staffAuthority || collection !== "application_entitlements")
      .flatMap(collection => data[collection].flatMap(row => projectAlphaSourceReferences(collection,snapshotMappingRow(collection,row))));
    await refreshLease();
    const ids = await prepareProjectAlphaSourceRecords(env.OPS_DB,source,refs);
    await runBatches(env.OPS_DB, projectionStatements(env.OPS_DB, data, syncId, changed, applicationKey,generatedAt,source,ids),refreshLease);
    await runBatches(env.OPS_DB, reconciliationStatements(env.OPS_DB, data, syncId, changed, applicationKey,generatedAt,source),refreshLease);
    await refreshLease();
    // Legacy Delivery references are still primary-owned. A business source
    // cannot update account eligibility, project grants or delivery mappings.
    if (source.sourceId === PRIMARY_PROJECT_ALPHA_SOURCE.sourceId)
      await runBatches(env.DELIVERY_DB, await clientPortalProjectionStatements(env, data, changed),refreshLease);
    // Commit source fingerprints only after the idempotent portal projection.
    // If DELIVERY_DB is unavailable, the next run must retry the same changed
    // collections instead of falsely reporting a healthy but stale portal.
    await runBatches(env.OPS_DB,snapshotVersionStatements(env.OPS_DB,data,changed,syncId,generatedAt,source),refreshLease);
    await runBatches(env.OPS_DB, fingerprintStatements(env.OPS_DB, fingerprints, fingerprintChanged, syncId,source),refreshLease);
    await env.OPS_DB.batch([
      env.OPS_DB.prepare("UPDATE sync_runs SET status='success',completed_at=datetime('now'),records_seen=? WHERE id=? AND projection_source_id=?").bind(records, runId,source.sourceId),
      env.OPS_DB.prepare("UPDATE integration_health SET status='healthy',last_success_at=datetime('now'),last_error_code=NULL,consecutive_failures=0,circuit_open_until=NULL,updated_at=datetime('now') WHERE integration='project-alpha' AND projection_source_id=?").bind(source.sourceId),
    ]);
    return { status: "success", records, changedCollections: [...changed] };
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : "unknown";
    await env.OPS_DB.batch([
      env.OPS_DB.prepare("UPDATE sync_runs SET status='failed',completed_at=datetime('now'),error_code=? WHERE id=? AND projection_source_id=?").bind(code, runId,source.sourceId),
      env.OPS_DB.prepare(`UPDATE integration_health SET status='error',last_error_code=?,
        circuit_open_until=CASE WHEN consecutive_failures+1>=3 THEN datetime('now','+5 minutes') ELSE circuit_open_until END,
        consecutive_failures=consecutive_failures+1,updated_at=datetime('now') WHERE integration='project-alpha' AND projection_source_id=?`).bind(code,source.sourceId),
    ]);
    throw error;
  } finally {
    if(leaseClaimed)await releaseSnapshotLease(env.OPS_DB,leaseOwner,source);
  }
}
