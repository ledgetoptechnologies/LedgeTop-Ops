import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { businessContactChannels, businessContactChannelsSql } from "./client-business-contact";
import { clientHubBusinessProjectOwnership, clientHubBusinessProjectSourceProof } from "./client-hub-business-projects";
import { readClientHubBusinessProjectPolicy, type ClientHubBusinessProjectPolicy } from "./client-hub-project-policy";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import type { Env, StaffPrincipal } from "./types";

type Environment = Pick<Env, "OPS_DB">;
type Database = Pick<D1Database, "prepare" | "batch">;
export const PROJECT_OPERATIONAL_CONTACT_ROLES = ["project_contact", "site_contact"] as const;
export const PROJECT_MEMORY_SECTIONS = ["plan", "actualOutcome", "deviationsAndReasons", "observations", "problems",
  "successes", "recommendations", "nextTimeRequests"] as const;
export type ProjectOperationalContactRole = typeof PROJECT_OPERATIONAL_CONTACT_ROLES[number];
export type ProjectMemorySection = typeof PROJECT_MEMORY_SECTIONS[number];

const identifier = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const contextVersion = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const instructions = z.string().max(4000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const memoryText = z.string().max(12_000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
const memorySchema = z.object(Object.fromEntries(PROJECT_MEMORY_SECTIONS.map(key => [key, memoryText])) as Record<ProjectMemorySection, typeof memoryText>).strict();
const contactInputSchema = z.object({ contactId: identifier, role: z.enum(PROJECT_OPERATIONAL_CONTACT_ROLES),
  preferredContactMethod: z.enum(["email", "phone", "text"]).nullable().default(null), instructions: instructions.default("") }).strict();
export const saveProjectOperationalContactsSchema = z.object({ expectedContextVersion: contextVersion,
  expectedVersion: z.number().int().min(0).safe(), idempotencyKey,
  assignments: z.array(contactInputSchema).max(100) }).strict().superRefine((value, issue) => {
    const keys = value.assignments.map(item => JSON.stringify([item.contactId, item.role]));
    if (new Set(keys).size !== keys.length) issue.addIssue({ code: "custom", message: "Each contact may have each role only once" });
  });
export const saveProjectMemorySchema = z.object({ expectedContextVersion: contextVersion,
  expectedVersion: z.number().int().min(0).safe(), idempotencyKey, memory: memorySchema,
  amendmentReason: z.string().min(1).max(1000).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)).nullable().optional() }).strict();
export type SaveProjectOperationalContactsInput = z.infer<typeof saveProjectOperationalContactsSchema>;
export type SaveProjectMemoryInput = z.infer<typeof saveProjectMemorySchema>;
export type ProjectMemorySnapshot = z.infer<typeof memorySchema>;

interface ProjectRow {
  id: string; projection_source_id: string; client_id: string | null; organization_id: string | null;
  status: string | null; active: number; last_sync_id: string;
}
interface RootRow { id: string; projection_source_id: string; organization_id: string | null; active: number; last_sync_id: string }
interface PreparedProject {
  context: ClientHubCollectionContext; project: ProjectRow; root: RootRow;
  policy: ClientHubBusinessProjectPolicy; sourceProof: string;
}
interface ContactSetRow { version: number; root_record_kind: "organization" | "client"; root_id: string; updated_at: string }
interface ContactAssignmentRow {
  id: string; contact_id: string; role: ProjectOperationalContactRole; preferred_contact_method: "email" | "phone" | "text" | null;
  instructions: string; sort_order: number; contact_name: string | null; email: string | null; phone: string | null;
}
interface MemoryRow { version: number; root_record_kind: "organization" | "client"; root_id: string; snapshot_json: string; updated_at: string }
interface ReceiptRow {
  operation_kind: "contacts_save" | "memory_save"; request_fingerprint: string; projection_source_id: string;
  project_id: string; result_version: number; result_json: string;
}
export interface ProjectOperationalContact {
  id: string; role: ProjectOperationalContactRole; preferredContactMethod: "email" | "phone" | "text" | null;
  instructions: string; sortOrder: number; availability: "available" | "unavailable";
  contact: { id: string; displayName: string; email: string | null; phone: string | null } | null;
}
export interface ProjectOperationalWorkspace {
  canonicalRoot: ClientHubCollectionContext["canonicalRoot"]; contextVersion: string;
  project: { id: string; sourceId: string; status: string | null };
  contacts: { version: number; assignments: ProjectOperationalContact[]; revisions: Array<{ version: number; actorId: string; createdAt: string }> };
  memory: { version: number; snapshot: ProjectMemorySnapshot; revisions: Array<{ version: number; changeKind: "saved" | "post_completion_amendment"; amendmentReason: string | null; actorId: string; createdAt: string }> };
  capabilities: { canManageContacts: boolean; canManageMemory: boolean };
}
export interface ProjectOperationalMutationResult {
  sourceId: string; projectId: string; version: number; replayed: boolean;
}

const emptyMemory = (): ProjectMemorySnapshot => Object.fromEntries(PROJECT_MEMORY_SECTIONS.map(key => [key, ""])) as ProjectMemorySnapshot;
const db = (env: Environment): Database => env.OPS_DB.withSession("first-primary");
const unavailable = (): never => { throw new HTTPException(404, { message: "Business project is unavailable" }); };
const changed = (): never => { throw new HTTPException(409, { message: "Project ownership, permissions, or operational records changed. Refresh before continuing." }); };
const ownershipChanged = (): never => { throw new HTTPException(409, { message: "Project ownership changed. Stored operational details require an audited administrator reset or transfer before they can be used." }); };
const normalize = (value: string): string => value.normalize("NFC").trim();
async function fingerprint(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HTTPException(400, { message });
  return parsed.data;
}
function globalPermissionSql(permission: "team.view" | "projects.view" | "project.contacts.manage" | "project.memory.manage"): string {
  return `((EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key='${permission}')
    OR EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key='${permission}')
    OR EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id
      AND permission.permission_key='${permission}' AND permission.scope='global' AND permission.effect='allow'))
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id
      AND permission.permission_key='${permission}' AND permission.scope='global' AND permission.effect='deny'))`;
}
function rootRecordKind(context: ClientHubCollectionContext): "organization" | "client" {
  return context.root.kind === "organization" ? "organization" : "client";
}
function validateContext(context: ClientHubCollectionContext, expected?: string): void {
  if (context.root.root_namespace !== "business" || !context.root.source_id.startsWith("project-alpha:")) return unavailable();
  if (!context.access.directory) throw new HTTPException(403, { message: "Client-directory access is required" });
  if (expected !== undefined && expected !== context.contextVersion) return changed();
}
async function projectRow(database: Database, context: ClientHubCollectionContext, projectId: string,
  policy: ClientHubBusinessProjectPolicy): Promise<ProjectRow | null> {
  const owner = clientHubBusinessProjectOwnership(context);
  return database.prepare(`SELECT p.id,p.projection_source_id,p.client_id,p.organization_id,p.status,p.active,p.last_sync_id
    FROM pa_projects p LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
    WHERE p.id=? AND (${owner.sql}) AND (${policy.filter.sql}) LIMIT 1`)
    .bind(projectId, ...owner.values, ...policy.filter.values).first<ProjectRow>();
}
async function rootRow(database: Database, context: ClientHubCollectionContext): Promise<RootRow | null> {
  const table = context.root.kind === "organization" ? "pa_organizations" : "pa_clients";
  return database.prepare(`SELECT id,projection_source_id,${context.root.kind === "organization" ? "NULL" : "organization_id"} organization_id,
      active,last_sync_id FROM ${table} WHERE id=? AND projection_source_id=? AND active=1
      ${context.root.kind === "organization" ? "" : "AND organization_id IS NULL"}
      AND ${projectAlphaReadVisibleSql("projection_source_id")} LIMIT 1`)
    .bind(context.root.public_id, context.root.source_id).first<RootRow>();
}
async function prepareProject(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext,
  projectId: string, manage?: "project.contacts.manage" | "project.memory.manage", expectedContextVersion?: string): Promise<PreparedProject> {
  validateContext(context, expectedContextVersion);
  if (!identifier.safeParse(projectId).success) throw new HTTPException(400, { message: "Project identifier is invalid" });
  const database = db(env), policy = await readClientHubBusinessProjectPolicy(env as Env, principal);
  if (!policy.allowed) throw new HTTPException(403, { message: "Project-view permission is required" });
  if (manage) {
    const permission = await database.prepare(`SELECT ${globalPermissionSql(manage)} allowed FROM staff_users actor
      WHERE actor.id=? AND actor.status='active'`).bind(principal.id).first<number>("allowed");
    if (permission !== 1) throw new HTTPException(403, { message: `Missing global permission: ${manage}` });
  }
  const sourceProof = await clientHubBusinessProjectSourceProof(env as Env, context);
  const [project, root] = await Promise.all([projectRow(database, context, projectId, policy), rootRow(database, context)]);
  if (!project || !root) return unavailable();
  const [currentPolicy, currentSource] = await Promise.all([
    readClientHubBusinessProjectPolicy(env as Env, principal), clientHubBusinessProjectSourceProof(env as Env, context),
  ]);
  const [current, currentRoot] = await Promise.all([projectRow(database, context, projectId, currentPolicy), rootRow(database, context)]);
  if (!currentPolicy.allowed || currentPolicy.proof !== policy.proof || currentSource !== sourceProof
    || !current || !currentRoot || JSON.stringify(current) !== JSON.stringify(project)
    || JSON.stringify(currentRoot) !== JSON.stringify(root)) return changed();
  return { context, project, root, policy, sourceProof };
}
function projectGuard(prepared: PreparedProject, principal: StaffPrincipal,
  permission: "project.contacts.manage" | "project.memory.manage", expectedVersion: number,
  table: "project_operational_contact_sets" | "project_operational_memory", contacts: string[] = []): { sql: string; values: unknown[] } {
  const { context, project, root, policy } = prepared, owner = clientHubBusinessProjectOwnership(context);
  const values: unknown[] = [principal.id, project.id, ...owner.values, ...policy.filter.values,
    project.projection_source_id, project.client_id, project.organization_id, project.status, project.last_sync_id];
  let sql = `EXISTS(SELECT 1 FROM staff_users actor WHERE actor.id=? AND actor.status='active'
      AND ${globalPermissionSql("team.view")} AND ${globalPermissionSql("projects.view")} AND ${globalPermissionSql(permission)})
    AND EXISTS(SELECT 1 FROM pa_projects p LEFT JOIN pa_clients owner ON owner.id=p.client_id
      AND owner.projection_source_id=p.projection_source_id AND owner.active=1
      WHERE p.id=? AND (${owner.sql}) AND (${policy.filter.sql}) AND p.projection_source_id=?
      AND p.client_id IS ? AND p.organization_id IS ? AND p.status IS ? AND p.last_sync_id=?)`;
  if (context.root.kind === "organization") {
    sql += ` AND EXISTS(SELECT 1 FROM pa_organizations root WHERE root.id=? AND root.projection_source_id=? AND root.active=1
      AND root.last_sync_id=? AND ${projectAlphaReadVisibleSql("root.projection_source_id")})`;
    values.push(context.root.public_id, context.root.source_id, root.last_sync_id);
  } else {
    sql += ` AND EXISTS(SELECT 1 FROM pa_clients root WHERE root.id=? AND root.projection_source_id=? AND root.active=1
      AND root.organization_id IS NULL AND root.last_sync_id=? AND ${projectAlphaReadVisibleSql("root.projection_source_id")})`;
    values.push(context.root.public_id, context.root.source_id, root.last_sync_id);
  }
  sql += expectedVersion === 0
    ? ` AND NOT EXISTS(SELECT 1 FROM ${table} current WHERE current.projection_source_id=? AND current.project_id=?)`
    : ` AND EXISTS(SELECT 1 FROM ${table} current WHERE current.projection_source_id=? AND current.project_id=? AND current.version=?)`;
  values.push(project.projection_source_id, project.id, ...(expectedVersion === 0 ? [] : [expectedVersion]));
  if (contacts.length) {
    sql += ` AND NOT EXISTS(SELECT 1 FROM json_each(?) wanted WHERE NOT EXISTS(SELECT 1 FROM pa_clients contact
      WHERE contact.id=wanted.value AND contact.projection_source_id=? AND contact.active=1
      AND ${context.root.kind === "organization" ? "contact.organization_id=?" : "contact.id=? AND contact.organization_id IS NULL"}))`;
    values.push(JSON.stringify(contacts), project.projection_source_id, context.root.public_id);
  }
  return { sql, values };
}
function guardedFence(database: Database, prepared: PreparedProject, principal: StaffPrincipal,
  permission: "project.contacts.manage" | "project.memory.manage", recordKind: "contacts" | "memory",
  expectedVersion: number, assignmentDeletes: number, assignmentInserts: number,
  guard: { sql: string; values: unknown[] }): D1PreparedStatement {
  const { context, project, root } = prepared;
  return database.prepare(`INSERT INTO project_operational_write_fences
      (projection_source_id,project_id,actor_id,permission_key,record_kind,root_record_kind,root_id,root_last_sync_id,
       project_client_id,project_organization_id,project_status,project_last_sync_id,expected_version,
       current_writes,assignment_deletes,assignment_inserts,revision_writes,event_writes,mutation_writes,write_guard)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,1,1,1,CASE WHEN ${guard.sql} THEN 1 ELSE 0 END)
    ON CONFLICT(projection_source_id,project_id) DO UPDATE SET actor_id=excluded.actor_id,
      permission_key=excluded.permission_key,record_kind=excluded.record_kind,root_record_kind=excluded.root_record_kind,
      root_id=excluded.root_id,root_last_sync_id=excluded.root_last_sync_id,project_client_id=excluded.project_client_id,
      project_organization_id=excluded.project_organization_id,project_status=excluded.project_status,
      project_last_sync_id=excluded.project_last_sync_id,expected_version=excluded.expected_version,
      current_writes=excluded.current_writes,assignment_deletes=excluded.assignment_deletes,
      assignment_inserts=excluded.assignment_inserts,revision_writes=excluded.revision_writes,
      event_writes=excluded.event_writes,mutation_writes=excluded.mutation_writes,write_guard=excluded.write_guard`)
    .bind(project.projection_source_id, project.id, principal.id, permission, recordKind, rootRecordKind(context), context.root.public_id,
      root.last_sync_id, project.client_id, project.organization_id, project.status, project.last_sync_id, expectedVersion,
      assignmentDeletes, assignmentInserts, ...guard.values);
}
async function currentReceipt(database: Database, actorId: string, key: string): Promise<ReceiptRow | null> {
  return database.prepare(`SELECT operation_kind,request_fingerprint,projection_source_id,project_id,result_version,result_json
    FROM project_operational_mutations WHERE actor_id=? AND idempotency_key=?`).bind(actorId, key).first<ReceiptRow>();
}
function receiptResult(receipt: ReceiptRow): Omit<ProjectOperationalMutationResult, "replayed"> {
  try {
    const value = JSON.parse(receipt.result_json) as Record<string, unknown>;
    if (value.sourceId !== receipt.projection_source_id || value.projectId !== receipt.project_id || value.version !== receipt.result_version) throw new Error();
    return { sourceId: receipt.projection_source_id, projectId: receipt.project_id, version: receipt.result_version };
  } catch { throw new HTTPException(503, { message: "Saved project operation requires administrative review" }); }
}
async function replay(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext, projectId: string,
  expectedKind: ReceiptRow["operation_kind"], expectedFingerprint: string, receipt: ReceiptRow,
  permission: "project.contacts.manage" | "project.memory.manage"): Promise<ProjectOperationalMutationResult> {
  if (receipt.operation_kind !== expectedKind || receipt.request_fingerprint !== expectedFingerprint
    || receipt.projection_source_id !== context.root.source_id || receipt.project_id !== projectId)
    throw new HTTPException(409, { message: "This operation key was already used for a different project change" });
  await prepareProject(env, principal, context, projectId, permission);
  return { ...receiptResult(receipt), replayed: true };
}
function contactSnapshot(assignments: Array<{ id: string; contactId: string; role: ProjectOperationalContactRole;
  preferredContactMethod: "email" | "phone" | "text" | null; instructions: string; sortOrder: number }>) {
  return { schemaVersion: 1, assignments };
}
function parseMemory(value: string | null): ProjectMemorySnapshot {
  if (value === null) return emptyMemory();
  try { return parse(memorySchema, JSON.parse(value), "Saved project memory is invalid"); }
  catch (error) { if (error instanceof HTTPException) throw new HTTPException(503, { message: "Saved project memory requires administrative review" }); throw error; }
}
function assertOverlayRoot(context: ClientHubCollectionContext,
  value: Pick<ContactSetRow, "root_record_kind" | "root_id"> | null | undefined): void {
  if (value && (value.root_record_kind !== rootRecordKind(context) || value.root_id !== context.root.public_id)) ownershipChanged();
}

/** Staff-only operational overlay. It does not create or mutate Alpha contacts,
 * billing roles, portal identities, grants, recipients, or notifications. */
export async function readProjectOperationalWorkspace(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string): Promise<ProjectOperationalWorkspace> {
  const prepared = await prepareProject(env, principal, context, projectId), database = db(env), source = prepared.project.projection_source_id;
  const metadata = async () => Promise.all([
    database.prepare(`SELECT version,root_record_kind,root_id,updated_at FROM project_operational_contact_sets
      WHERE projection_source_id=? AND project_id=?`).bind(source, projectId).first<ContactSetRow>(),
    database.prepare(`SELECT version,root_record_kind,root_id,updated_at FROM project_operational_memory
      WHERE projection_source_id=? AND project_id=?`).bind(source, projectId).first<Omit<MemoryRow, "snapshot_json">>(),
  ]);
  const firstMetadata = await metadata();
  assertOverlayRoot(context, firstMetadata[0]); assertOverlayRoot(context, firstMetadata[1]);
  const read = async () => {
    const [rows, memory, contactRevisions, memoryRevisions] = await Promise.all([
      database.prepare(`SELECT assignment.id,assignment.contact_id,assignment.role,assignment.preferred_contact_method,
          assignment.instructions,assignment.sort_order,contact.name contact_name,${businessContactChannelsSql("contact.payload_json")}
        FROM project_operational_contact_assignments assignment
        LEFT JOIN pa_clients contact ON contact.id=assignment.contact_id AND contact.projection_source_id=assignment.projection_source_id
          AND contact.active=1 AND ${context.root.kind === "organization" ? "contact.organization_id=?" : "contact.id=? AND contact.organization_id IS NULL"}
        WHERE assignment.projection_source_id=? AND assignment.project_id=? ORDER BY assignment.sort_order,assignment.id`)
        .bind(context.root.public_id, source, projectId).all<ContactAssignmentRow>(),
      database.prepare(`SELECT version,root_record_kind,root_id,snapshot_json,updated_at FROM project_operational_memory WHERE projection_source_id=? AND project_id=?`)
        .bind(source, projectId).first<MemoryRow>(),
      database.prepare(`SELECT version,actor_id,created_at FROM project_operational_contact_revisions
        WHERE projection_source_id=? AND project_id=? ORDER BY version DESC LIMIT 50`).bind(source, projectId)
        .all<{ version: number; actor_id: string; created_at: string }>(),
      database.prepare(`SELECT version,change_kind,amendment_reason,actor_id,created_at FROM project_operational_memory_revisions
        WHERE projection_source_id=? AND project_id=? ORDER BY version DESC LIMIT 50`).bind(source, projectId)
        .all<{ version: number; change_kind: "saved" | "post_completion_amendment"; amendment_reason: string | null; actor_id: string; created_at: string }>(),
    ]);
    return { rows: rows.results, memory, contactRevisions: contactRevisions.results, memoryRevisions: memoryRevisions.results };
  };
  const first = await read(), current = await prepareProject(env, principal, context, projectId);
  const secondMetadata = await metadata();
  assertOverlayRoot(context, secondMetadata[0]); assertOverlayRoot(context, secondMetadata[1]);
  const second = await read();
  if (current.policy.proof !== prepared.policy.proof || current.sourceProof !== prepared.sourceProof
    || JSON.stringify(current.project) !== JSON.stringify(prepared.project)
    || JSON.stringify(current.root) !== JSON.stringify(prepared.root)
    || JSON.stringify(secondMetadata) !== JSON.stringify(firstMetadata) || JSON.stringify(second) !== JSON.stringify(first)) return changed();
  const manage = async (permission: "project.contacts.manage" | "project.memory.manage") => (await database.prepare(`SELECT
    ${globalPermissionSql(permission)} allowed FROM staff_users actor WHERE actor.id=? AND actor.status='active'`).bind(principal.id).first<number>("allowed")) === 1;
  const [canManageContacts, canManageMemory] = await Promise.all([manage("project.contacts.manage"), manage("project.memory.manage")]);
  return {
    canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion,
    project: { id: projectId, sourceId: source, status: prepared.project.status },
    contacts: { version: firstMetadata[0]?.version ?? 0, assignments: first.rows.map(row => ({ id: row.id, role: row.role,
      preferredContactMethod: row.preferred_contact_method, instructions: row.instructions, sortOrder: row.sort_order,
      availability: row.contact_name === null ? "unavailable" : "available", contact: row.contact_name === null ? null
        : { id: row.contact_id, displayName: row.contact_name, ...businessContactChannels(row) } })),
      revisions: first.contactRevisions.map(row => ({ version: row.version, actorId: row.actor_id, createdAt: row.created_at })) },
    memory: { version: first.memory?.version ?? 0, snapshot: parseMemory(first.memory?.snapshot_json ?? null),
      revisions: first.memoryRevisions.map(row => ({ version: row.version, changeKind: row.change_kind,
        amendmentReason: row.amendment_reason, actorId: row.actor_id, createdAt: row.created_at })) },
    capabilities: { canManageContacts, canManageMemory },
  };
}

export async function saveProjectOperationalContacts(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string, raw: unknown): Promise<ProjectOperationalMutationResult> {
  const input = parse(saveProjectOperationalContactsSchema, raw, "Operational contacts are invalid");
  const assignments = input.assignments.map(item => ({ ...item, instructions: normalize(item.instructions) }));
  const canonical = { sourceId: context.root.source_id, rootKind: context.root.kind, rootId: context.root.public_id,
    projectId, expectedContextVersion: input.expectedContextVersion, expectedVersion: input.expectedVersion, assignments };
  const requestFingerprint = await fingerprint(canonical), database = db(env);
  const saved = await currentReceipt(database, principal.id, input.idempotencyKey);
  if (saved) return replay(env, principal, context, projectId, "contacts_save", requestFingerprint, saved, "project.contacts.manage");
  const prepared = await prepareProject(env, principal, context, projectId, "project.contacts.manage", input.expectedContextVersion);
  const source = prepared.project.projection_source_id;
  const currentSet = await database.prepare(`SELECT version,root_record_kind,root_id,updated_at FROM project_operational_contact_sets
    WHERE projection_source_id=? AND project_id=?`).bind(source, projectId).first<ContactSetRow>();
  assertOverlayRoot(context, currentSet);
  if ((currentSet?.version ?? 0) !== input.expectedVersion) return changed();
  const currentAssignments = (await database.prepare(`SELECT id,contact_id,role FROM project_operational_contact_assignments
    WHERE projection_source_id=? AND project_id=?`).bind(source, projectId).all<{ id: string; contact_id: string; role: ProjectOperationalContactRole }>()).results;
  const contactIds = [...new Set(assignments.map(item => item.contactId))];
  if (contactIds.length) {
    const valid = await database.prepare(`SELECT count(*) count FROM pa_clients contact WHERE contact.projection_source_id=? AND contact.active=1
      AND ${context.root.kind === "organization" ? "contact.organization_id=?" : "contact.id=? AND contact.organization_id IS NULL"}
      AND contact.id IN (${contactIds.map(() => "?").join(",")})`).bind(source, context.root.public_id, ...contactIds).first<number>("count");
    if (valid !== contactIds.length) throw new HTTPException(409, { message: "One or more contacts moved or are unavailable. Refresh before saving." });
  }
  const version = input.expectedVersion + 1, ids = new Map(currentAssignments.map(row => [JSON.stringify([row.contact_id, row.role]), row.id]));
  const snapshotAssignments = assignments.map((item, sortOrder) => ({ id: ids.get(JSON.stringify([item.contactId, item.role])) ?? crypto.randomUUID(),
    contactId: item.contactId, role: item.role, preferredContactMethod: item.preferredContactMethod, instructions: item.instructions, sortOrder }));
  const snapshot = JSON.stringify(contactSnapshot(snapshotAssignments));
  const guard = projectGuard(prepared, principal, "project.contacts.manage", input.expectedVersion, "project_operational_contact_sets", contactIds);
  const rootKind = rootRecordKind(context), result = { sourceId: source, projectId, version };
  const statements: D1PreparedStatement[] = [guardedFence(database, prepared, principal,
    "project.contacts.manage", "contacts", input.expectedVersion, currentAssignments.length, snapshotAssignments.length, guard)];
  if (input.expectedVersion === 0) statements.push(database.prepare(`INSERT INTO project_operational_contact_sets
    (projection_source_id,project_id,root_record_kind,root_id,version,created_by,updated_by) VALUES(?,?,?,?,1,?,?)`)
    .bind(source, projectId, rootKind, context.root.public_id, principal.id, principal.id));
  else statements.push(database.prepare(`UPDATE project_operational_contact_sets SET version=version+1,updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE projection_source_id=? AND project_id=? AND version=?`).bind(principal.id, source, projectId, input.expectedVersion));
  statements.push(database.prepare(`DELETE FROM project_operational_contact_assignments WHERE projection_source_id=? AND project_id=?`).bind(source, projectId));
  for (const item of snapshotAssignments) statements.push(database.prepare(`INSERT INTO project_operational_contact_assignments
    (id,projection_source_id,project_id,contact_id,role,preferred_contact_method,instructions,sort_order,created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(item.id, source, projectId, item.contactId, item.role, item.preferredContactMethod, item.instructions, item.sortOrder, principal.id));
  statements.push(database.prepare(`INSERT INTO project_operational_contact_revisions
      (id,projection_source_id,project_id,version,snapshot_json,actor_id) VALUES(?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), source, projectId, version, snapshot, principal.id),
    database.prepare(`INSERT INTO project_operational_events(id,projection_source_id,project_id,actor_id,event_kind,result_version,details_json)
      VALUES(?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), source, projectId, principal.id, "contacts_saved", version,
      JSON.stringify({ schemaVersion: 1, assignmentCount: snapshotAssignments.length })),
    database.prepare(`INSERT INTO project_operational_mutations(actor_id,idempotency_key,operation_kind,request_fingerprint,projection_source_id,project_id,result_version,result_json)
      VALUES(?,?,?,?,?,?,?,?)`).bind(principal.id, input.idempotencyKey, "contacts_save", requestFingerprint, source, projectId, version, JSON.stringify(result)),
    database.prepare(`DELETE FROM project_operational_write_fences WHERE projection_source_id=? AND project_id=?`).bind(source, projectId));
  try { await database.batch(statements); }
  catch (error) {
    const winner = await currentReceipt(database, principal.id, input.idempotencyKey);
    if (winner) return replay(env, principal, context, projectId, "contacts_save", requestFingerprint, winner, "project.contacts.manage");
    if (error instanceof Error && /current context|project_operational_current_context|CHECK constraint failed|version|UNIQUE|FOREIGN KEY|contact set/i.test(error.message)) return changed();
    throw new HTTPException(503, { message: "Operational contacts could not be saved. Retry with the same operation key." });
  }
  return { ...result, replayed: false };
}

export async function saveProjectMemory(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext, projectId: string, raw: unknown): Promise<ProjectOperationalMutationResult> {
  const input = parse(saveProjectMemorySchema, raw, "Project memory is invalid");
  const memory = Object.fromEntries(PROJECT_MEMORY_SECTIONS.map(key => [key, normalize(input.memory[key])])) as ProjectMemorySnapshot;
  const amendmentReason = input.amendmentReason === undefined || input.amendmentReason === null ? null : normalize(input.amendmentReason);
  const canonical = { sourceId: context.root.source_id, rootKind: context.root.kind, rootId: context.root.public_id,
    projectId, expectedContextVersion: input.expectedContextVersion, expectedVersion: input.expectedVersion, memory, amendmentReason };
  const requestFingerprint = await fingerprint(canonical), database = db(env);
  const saved = await currentReceipt(database, principal.id, input.idempotencyKey);
  if (saved) return replay(env, principal, context, projectId, "memory_save", requestFingerprint, saved, "project.memory.manage");
  const prepared = await prepareProject(env, principal, context, projectId, "project.memory.manage", input.expectedContextVersion);
  const nowTerminal = new Set(["completed", "cancelled"]).has(prepared.project.status ?? "");
  if (nowTerminal && !amendmentReason) throw new HTTPException(409, { message: "A reason is required for a post-completion project-memory amendment" });
  if (!nowTerminal && amendmentReason) throw new HTTPException(400, { message: "An amendment reason is only used after a project is completed or cancelled" });
  const source = prepared.project.projection_source_id;
  const currentMemory = await database.prepare(`SELECT version,root_record_kind,root_id,updated_at FROM project_operational_memory
    WHERE projection_source_id=? AND project_id=?`).bind(source, projectId).first<Omit<MemoryRow, "snapshot_json">>();
  assertOverlayRoot(context, currentMemory);
  if ((currentMemory?.version ?? 0) !== input.expectedVersion) return changed();
  const version = input.expectedVersion + 1, snapshot = JSON.stringify(memory), rootKind = rootRecordKind(context);
  const guard = projectGuard(prepared, principal, "project.memory.manage", input.expectedVersion, "project_operational_memory");
  const result = { sourceId: source, projectId, version }, changeKind = nowTerminal ? "post_completion_amendment" : "saved";
  const statements: D1PreparedStatement[] = [guardedFence(database, prepared, principal,
    "project.memory.manage", "memory", input.expectedVersion, 0, 0, guard)];
  if (input.expectedVersion === 0) statements.push(database.prepare(`INSERT INTO project_operational_memory
    (projection_source_id,project_id,root_record_kind,root_id,version,snapshot_json,created_by,updated_by) VALUES(?,?,?,?,1,?,?,?)`)
    .bind(source, projectId, rootKind, context.root.public_id, snapshot, principal.id, principal.id));
  else statements.push(database.prepare(`UPDATE project_operational_memory SET version=version+1,snapshot_json=?,updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE projection_source_id=? AND project_id=? AND version=?`).bind(snapshot, principal.id, source, projectId, input.expectedVersion));
  statements.push(database.prepare(`INSERT INTO project_operational_memory_revisions
      (id,projection_source_id,project_id,version,change_kind,snapshot_json,amendment_reason,actor_id) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), source, projectId, version, changeKind, snapshot, amendmentReason, principal.id),
    database.prepare(`INSERT INTO project_operational_events(id,projection_source_id,project_id,actor_id,event_kind,result_version,details_json)
      VALUES(?,?,?,?,?,?,?)`).bind(crypto.randomUUID(), source, projectId, principal.id, nowTerminal ? "memory_amended" : "memory_saved", version,
      JSON.stringify({ schemaVersion: 1, sectionCount: PROJECT_MEMORY_SECTIONS.filter(key => memory[key] !== "").length })),
    database.prepare(`INSERT INTO project_operational_mutations(actor_id,idempotency_key,operation_kind,request_fingerprint,projection_source_id,project_id,result_version,result_json)
      VALUES(?,?,?,?,?,?,?,?)`).bind(principal.id, input.idempotencyKey, "memory_save", requestFingerprint, source, projectId, version, JSON.stringify(result)),
    database.prepare(`DELETE FROM project_operational_write_fences WHERE projection_source_id=? AND project_id=?`).bind(source, projectId));
  try { await database.batch(statements); }
  catch (error) {
    const winner = await currentReceipt(database, principal.id, input.idempotencyKey);
    if (winner) return replay(env, principal, context, projectId, "memory_save", requestFingerprint, winner, "project.memory.manage");
    if (error instanceof Error && /current context|project_operational_current_context|CHECK constraint failed|version|UNIQUE|FOREIGN KEY|project memory/i.test(error.message)) return changed();
    throw new HTTPException(503, { message: "Project memory could not be saved. Retry with the same operation key." });
  }
  return { ...result, replayed: false };
}
