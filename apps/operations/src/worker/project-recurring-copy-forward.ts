import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { clientHubBusinessProjectOwnership, clientHubBusinessProjectSourceProof } from "./client-hub-business-projects";
import { readClientHubBusinessProjectPolicy, type ClientHubBusinessProjectPolicy } from "./client-hub-project-policy";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import { PROJECT_MEMORY_SECTIONS, PROJECT_OPERATIONAL_CONTACT_ROLES,
  type ProjectMemorySection, type ProjectMemorySnapshot, type ProjectOperationalContactRole } from "./project-operational-memory";
import type { Env, StaffPrincipal } from "./types";

type Environment = Pick<Env, "OPS_DB">;
type Database = Pick<D1Database, "prepare" | "batch">;
const id = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
const proof = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const operationKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const versions = z.object({ sourceProjectRevision: id, destinationProjectRevision: id,
  sourceContactsVersion: z.number().int().min(0).safe(), destinationContactsVersion: z.number().int().min(0).safe(),
  sourceMemoryVersion: z.number().int().min(0).safe(), destinationMemoryVersion: z.number().int().min(0).safe() }).strict();
export const previewRecurringProjectCopySchema = z.object({
  expectedContextVersion: proof, sourceProjectId: id, destinationProjectId: id,
  selectedContactRoles: z.array(z.enum(PROJECT_OPERATIONAL_CONTACT_ROLES)).max(PROJECT_OPERATIONAL_CONTACT_ROLES.length),
  selectedMemorySections: z.array(z.enum(PROJECT_MEMORY_SECTIONS)).max(PROJECT_MEMORY_SECTIONS.length),
  conflictPolicy: z.enum(["keep_destination", "replace_source"]).default("keep_destination"), expected: versions,
}).strict().superRefine((value, issue) => {
  if (value.sourceProjectId === value.destinationProjectId) issue.addIssue({ code: "custom", message: "Source and destination must differ" });
  if (!value.selectedContactRoles.length && !value.selectedMemorySections.length)
    issue.addIssue({ code: "custom", message: "Select at least one contact role or memory section" });
  if (new Set(value.selectedContactRoles).size !== value.selectedContactRoles.length
    || new Set(value.selectedMemorySections).size !== value.selectedMemorySections.length)
    issue.addIssue({ code: "custom", message: "Selections must be unique" });
});
export const commitRecurringProjectCopySchema = previewRecurringProjectCopySchema.extend({
  previewFingerprint: digest, idempotencyKey: operationKey,
});
export type PreviewRecurringProjectCopyInput = z.infer<typeof previewRecurringProjectCopySchema>;
export type CommitRecurringProjectCopyInput = z.infer<typeof commitRecurringProjectCopySchema>;

interface ProjectRow { id: string; projection_source_id: string; client_id: string | null; organization_id: string | null;
  status: string | null; active: number; last_sync_id: string }
interface RootRow { last_sync_id: string }
interface ContactRow { id: string; contact_id: string; role: ProjectOperationalContactRole;
  preferred_contact_method: "email" | "phone" | "text" | null; instructions: string; sort_order: number }
interface OverlayState { contactsVersion: number; contacts: ContactRow[]; memoryVersion: number; memory: ProjectMemorySnapshot }
interface AuthorizedPair { source: ProjectRow; destination: ProjectRow; root: RootRow; policy: ClientHubBusinessProjectPolicy; sourceProof: string }
interface CopyPlan { input: PreviewRecurringProjectCopyInput; context: ClientHubCollectionContext; pair: AuthorizedPair; source: OverlayState; destination: OverlayState;
  contacts: ContactRow[]; memory: ProjectMemorySnapshot; contactsChanged: boolean; memoryChanged: boolean;
  contactConflicts: number; memoryConflicts: ProjectMemorySection[]; copiedContacts: number; copiedMemorySections: ProjectMemorySection[];
  sourceContactIds: string[]; fingerprint: string }
interface ReceiptRow { request_fingerprint: string; preview_fingerprint: string; projection_source_id: string;
  source_project_id: string; destination_project_id: string; result_json: string }

export interface RecurringProjectCopyPreview {
  fingerprint: string;
  source: { projectId: string; projectRevision: string; contactsVersion: number; memoryVersion: number };
  destination: { projectId: string; projectRevision: string; contactsVersion: number; memoryVersion: number };
  selection: { contactRoles: ProjectOperationalContactRole[]; memorySections: ProjectMemorySection[]; conflictPolicy: "keep_destination" | "replace_source" };
  changes: { contactsChanged: boolean; memoryChanged: boolean; copiedContacts: number;
    copiedMemorySections: ProjectMemorySection[]; contactConflicts: number; memoryConflicts: ProjectMemorySection[] };
}
export interface RecurringProjectCopyResult extends RecurringProjectCopyPreview { replayed: boolean;
  destination: RecurringProjectCopyPreview["destination"] & { contactsVersionAfter: number; memoryVersionAfter: number } }

const emptyMemory = (): ProjectMemorySnapshot => Object.fromEntries(PROJECT_MEMORY_SECTIONS.map(key => [key, ""])) as ProjectMemorySnapshot;
const database = (env: Environment): Database => env.OPS_DB.withSession("first-primary");
const unavailable = (): never => { throw new HTTPException(404, { message: "Recurring-project source or destination is unavailable" }); };
const changed = (): never => { throw new HTTPException(409, { message: "Project, permissions, contacts, or memory changed. Refresh the copy preview." }); };
function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value); if (!parsed.success) throw new HTTPException(400, { message }); return parsed.data;
}
async function sha(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function normalizedInput(input: PreviewRecurringProjectCopyInput): PreviewRecurringProjectCopyInput {
  return { ...input, selectedContactRoles: [...input.selectedContactRoles].sort(),
    selectedMemorySections: [...input.selectedMemorySections].sort() };
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
function rootKind(context: ClientHubCollectionContext): "organization" | "client" {
  return context.root.kind === "organization" ? "organization" : "client";
}
function rootOwnershipSql(context: ClientHubCollectionContext, alias: string, owner: string): { sql: string; values: unknown[] } {
  return context.root.kind === "organization"
    ? { sql: `(${alias}.organization_id=? OR (${alias}.organization_id IS NULL AND ${owner}.organization_id=?))`, values: [context.root.public_id, context.root.public_id] }
    : { sql: `${alias}.client_id=? AND ${alias}.organization_id IS NULL AND ${owner}.id IS NOT NULL AND ${owner}.organization_id IS NULL`, values: [context.root.public_id] };
}
async function rootRow(db: Database, context: ClientHubCollectionContext): Promise<RootRow | null> {
  const table = context.root.kind === "organization" ? "pa_organizations" : "pa_clients";
  return db.prepare(`SELECT last_sync_id FROM ${table} WHERE id=? AND projection_source_id=? AND active=1
    ${context.root.kind === "organization" ? "" : "AND organization_id IS NULL"}
    AND ${projectAlphaReadVisibleSql("projection_source_id")} LIMIT 1`).bind(context.root.public_id, context.root.source_id).first<RootRow>();
}
async function projectRow(db: Database, context: ClientHubCollectionContext, projectId: string,
  policy: ClientHubBusinessProjectPolicy): Promise<ProjectRow | null> {
  const owner = clientHubBusinessProjectOwnership(context);
  return db.prepare(`SELECT p.id,p.projection_source_id,p.client_id,p.organization_id,p.status,p.active,p.last_sync_id
    FROM pa_projects p LEFT JOIN pa_clients owner ON owner.id=p.client_id AND owner.projection_source_id=p.projection_source_id AND owner.active=1
    WHERE p.id=? AND p.active=1 AND (${owner.sql}) AND (${policy.filter.sql}) LIMIT 1`)
    .bind(projectId, ...owner.values, ...policy.filter.values).first<ProjectRow>();
}
async function permission(db: Database, actorId: string,
  key: "project.contacts.manage" | "project.memory.manage"): Promise<boolean> {
  return (await db.prepare(`SELECT ${globalPermissionSql(key)} allowed FROM staff_users actor
    WHERE actor.id=? AND actor.status='active'`).bind(actorId).first<number>("allowed")) === 1;
}
async function authorizePair(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext,
  input: Pick<PreviewRecurringProjectCopyInput, "expectedContextVersion" | "sourceProjectId" | "destinationProjectId" | "selectedContactRoles" | "selectedMemorySections">,
  options: { enforceExpectedContext?: boolean; enforceDestinationOpen?: boolean } = {}): Promise<AuthorizedPair> {
  const { enforceExpectedContext = true, enforceDestinationOpen = true } = options;
  if (context.root.root_namespace !== "business" || !context.root.source_id.startsWith("project-alpha:") || !context.access.directory) unavailable();
  if (enforceExpectedContext && context.contextVersion !== input.expectedContextVersion) changed();
  const db = database(env), policy = await readClientHubBusinessProjectPolicy(env as Env, principal);
  if (!policy.allowed) throw new HTTPException(403, { message: "Project-view permission is required" });
  const required = await Promise.all([
    input.selectedContactRoles.length ? permission(db, principal.id, "project.contacts.manage") : Promise.resolve(true),
    input.selectedMemorySections.length ? permission(db, principal.id, "project.memory.manage") : Promise.resolve(true),
  ]);
  if (!required[0]) throw new HTTPException(403, { message: "Missing global permission: project.contacts.manage" });
  if (!required[1]) throw new HTTPException(403, { message: "Missing global permission: project.memory.manage" });
  const sourceProof = await clientHubBusinessProjectSourceProof(env as Env, context);
  const [source, destination, root] = await Promise.all([
    projectRow(db, context, input.sourceProjectId, policy), projectRow(db, context, input.destinationProjectId, policy), rootRow(db, context),
  ]);
  if (!source || !destination || !root || source.id === destination.id)
    throw new HTTPException(404, { message: "Recurring-project source or destination is unavailable" });
  if (enforceDestinationOpen && (!destination.status || !["not_started", "active", "overdue"].includes(destination.status)))
    throw new HTTPException(409, { message: "The destination project is not open for copy-forward" });
  const [nextPolicy, nextProof, nextSource, nextDestination, nextRoot] = await Promise.all([
    readClientHubBusinessProjectPolicy(env as Env, principal), clientHubBusinessProjectSourceProof(env as Env, context),
    projectRow(db, context, source.id, policy), projectRow(db, context, destination.id, policy), rootRow(db, context),
  ]);
  if (!nextPolicy.allowed || nextPolicy.proof !== policy.proof || nextProof !== sourceProof || !nextSource || !nextDestination || !nextRoot
    || JSON.stringify(nextSource) !== JSON.stringify(source) || JSON.stringify(nextDestination) !== JSON.stringify(destination)
    || nextRoot.last_sync_id !== root.last_sync_id) changed();
  return { source, destination, root, policy, sourceProof };
}
function parseMemory(raw: string | null): ProjectMemorySnapshot {
  if (raw === null) return emptyMemory();
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (Object.keys(value).length !== PROJECT_MEMORY_SECTIONS.length
      || PROJECT_MEMORY_SECTIONS.some(key => typeof value[key] !== "string" || (value[key] as string).length > 12_000)) throw new Error();
    return value as ProjectMemorySnapshot;
  } catch { throw new HTTPException(503, { message: "Saved project memory requires administrative review" }); }
}
async function overlay(db: Database, context: ClientHubCollectionContext, projectId: string,
  selectedRoles: ProjectOperationalContactRole[]): Promise<OverlayState> {
  const source = context.root.source_id;
  const [contactSet, memory, contacts] = await Promise.all([
    db.prepare("SELECT version,root_record_kind,root_id FROM project_operational_contact_sets WHERE projection_source_id=? AND project_id=?")
      .bind(source, projectId).first<{ version: number; root_record_kind: string; root_id: string }>(),
    db.prepare("SELECT version,root_record_kind,root_id,snapshot_json FROM project_operational_memory WHERE projection_source_id=? AND project_id=?")
      .bind(source, projectId).first<{ version: number; root_record_kind: string; root_id: string; snapshot_json: string }>(),
    db.prepare(`SELECT assignment.id,assignment.contact_id,assignment.role,assignment.preferred_contact_method,
        assignment.instructions,assignment.sort_order
      FROM project_operational_contact_assignments assignment
      WHERE assignment.projection_source_id=? AND assignment.project_id=? ORDER BY assignment.sort_order,assignment.id`)
      .bind(source, projectId).all<ContactRow>(),
  ]);
  for (const item of [contactSet, memory]) if (item && (item.root_record_kind !== rootKind(context) || item.root_id !== context.root.public_id)) changed();
  const rows = contacts.results;
  if (selectedRoles.length) {
    const wanted = rows.filter(row => selectedRoles.includes(row.role));
    for (const item of wanted) {
      const live = await db.prepare(`SELECT 1 ok FROM pa_clients WHERE id=? AND projection_source_id=? AND active=1 AND
        ${context.root.kind === "organization" ? "organization_id=?" : "id=? AND organization_id IS NULL"}`)
        .bind(item.contact_id, source, context.root.public_id).first<number>("ok");
      if (live !== 1) changed();
    }
  }
  return { contactsVersion: contactSet?.version ?? 0, contacts: rows, memoryVersion: memory?.version ?? 0,
    memory: parseMemory(memory?.snapshot_json ?? null) };
}
function contactComparable(row: ContactRow): string {
  return JSON.stringify([row.contact_id, row.role, row.preferred_contact_method, row.instructions]);
}
async function buildPlan(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext,
  raw: unknown): Promise<CopyPlan> {
  const input = normalizedInput(parse(previewRecurringProjectCopySchema, raw, "Recurring-project copy request is invalid"));
  const pair = await authorizePair(env, principal, context, input), db = database(env);
  if (pair.source.last_sync_id !== input.expected.sourceProjectRevision
    || pair.destination.last_sync_id !== input.expected.destinationProjectRevision) changed();
  const [source, destination] = await Promise.all([
    overlay(db, context, pair.source.id, input.selectedContactRoles), overlay(db, context, pair.destination.id, []),
  ]);
  if (source.contactsVersion !== input.expected.sourceContactsVersion || destination.contactsVersion !== input.expected.destinationContactsVersion
    || source.memoryVersion !== input.expected.sourceMemoryVersion || destination.memoryVersion !== input.expected.destinationMemoryVersion) changed();

  const selectedSource = source.contacts.filter(row => input.selectedContactRoles.includes(row.role));
  const destinationByKey = new Map(destination.contacts.map(row => [`${row.contact_id}\u0000${row.role}`, row]));
  let contactConflicts = 0, copiedContacts = 0;
  for (const item of selectedSource) {
    const key = `${item.contact_id}\u0000${item.role}`, current = destinationByKey.get(key);
    if (!current) {
      destinationByKey.set(key, { ...item, id: `copy-${(await sha([pair.source.id, pair.destination.id, key])).slice(0, 40)}` });
      copiedContacts += 1;
    } else if (contactComparable(current) !== contactComparable(item)) {
      contactConflicts += 1;
      if (input.conflictPolicy === "replace_source") {
        // Copy-forward is additive even under explicit replacement: an empty
        // source field is absence of a reusable value, not an instruction to
        // erase useful destination context.
        const merged = { ...item, id: current.id,
          preferred_contact_method: item.preferred_contact_method ?? current.preferred_contact_method,
          instructions: item.instructions.trim() ? item.instructions : current.instructions };
        if (contactComparable(current) !== contactComparable(merged)) {
          destinationByKey.set(key, merged); copiedContacts += 1;
        }
      }
    }
  }
  const contacts = [...destinationByKey.values()].sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
    .map((row, index) => ({ ...row, sort_order: index }));
  const contactsChanged = JSON.stringify(contacts.map(contactComparable)) !== JSON.stringify(destination.contacts.map(contactComparable));
  const memory = { ...destination.memory }; const memoryConflicts: ProjectMemorySection[] = [], copiedMemorySections: ProjectMemorySection[] = [];
  for (const section of input.selectedMemorySections) {
    const sourceValue = source.memory[section]; if (!sourceValue) continue;
    const destinationValue = destination.memory[section];
    if (destinationValue === sourceValue) continue;
    if (destinationValue) {
      memoryConflicts.push(section); if (input.conflictPolicy === "keep_destination") continue;
    }
    memory[section] = sourceValue; copiedMemorySections.push(section);
  }
  const memoryChanged = JSON.stringify(memory) !== JSON.stringify(destination.memory);
  const sourceContactIds = [...new Set(selectedSource.map(row => row.contact_id))].sort();
  const fingerprint = await sha({ schemaVersion: 1, input, source: { project: pair.source.last_sync_id, contacts: source.contactsVersion,
    memory: source.memoryVersion }, destination: { project: pair.destination.last_sync_id, contacts: destination.contactsVersion,
    memory: destination.memoryVersion }, contacts: contacts.map(row => [row.id, contactComparable(row)]), memory,
    contactConflicts, memoryConflicts, copiedContacts, copiedMemorySections });
  const [currentPolicy, currentProof, currentSource, currentDestination, currentRoot] = await Promise.all([
    readClientHubBusinessProjectPolicy(env as Env, principal), clientHubBusinessProjectSourceProof(env as Env, context),
    projectRow(db, context, pair.source.id, pair.policy), projectRow(db, context, pair.destination.id, pair.policy), rootRow(db, context),
  ]);
  if (currentPolicy.proof !== pair.policy.proof || currentProof !== pair.sourceProof || !currentSource || !currentDestination || !currentRoot
    || currentSource.last_sync_id !== pair.source.last_sync_id || currentDestination.last_sync_id !== pair.destination.last_sync_id
    || currentRoot.last_sync_id !== pair.root.last_sync_id) changed();
  return { input, context, pair, source, destination, contacts, memory, contactsChanged, memoryChanged, contactConflicts,
    memoryConflicts, copiedContacts, copiedMemorySections, sourceContactIds, fingerprint };
}
function previewResult(plan: CopyPlan): RecurringProjectCopyPreview {
  return { fingerprint: plan.fingerprint,
    source: { projectId: plan.pair.source.id, projectRevision: plan.pair.source.last_sync_id,
      contactsVersion: plan.source.contactsVersion, memoryVersion: plan.source.memoryVersion },
    destination: { projectId: plan.pair.destination.id, projectRevision: plan.pair.destination.last_sync_id,
      contactsVersion: plan.destination.contactsVersion, memoryVersion: plan.destination.memoryVersion },
    selection: { contactRoles: plan.input.selectedContactRoles, memorySections: plan.input.selectedMemorySections,
      conflictPolicy: plan.input.conflictPolicy },
    changes: { contactsChanged: plan.contactsChanged, memoryChanged: plan.memoryChanged, copiedContacts: plan.copiedContacts,
      copiedMemorySections: plan.copiedMemorySections, contactConflicts: plan.contactConflicts, memoryConflicts: plan.memoryConflicts } };
}

export async function previewRecurringProjectCopy(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext, raw: unknown): Promise<RecurringProjectCopyPreview> {
  return previewResult(await buildPlan(env, principal, context, raw));
}

function operationFence(db: Database, plan: CopyPlan, principal: StaffPrincipal, kind: "contacts" | "memory",
  expectedVersion: number, deletes: number, inserts: number, idempotencyKey: string): D1PreparedStatement {
  const project = plan.pair.destination;
  return db.prepare(`INSERT INTO project_operational_write_fences(projection_source_id,project_id,actor_id,permission_key,record_kind,
      root_record_kind,root_id,root_last_sync_id,project_client_id,project_organization_id,project_status,project_last_sync_id,
      expected_version,current_writes,assignment_deletes,assignment_inserts,revision_writes,event_writes,mutation_writes,write_guard)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,1,1,0,CASE WHEN EXISTS(SELECT 1 FROM project_operational_live_copy_fences
      WHERE actor_id=? AND idempotency_key=?) THEN 1 ELSE 0 END)
    ON CONFLICT(projection_source_id,project_id) DO UPDATE SET actor_id=excluded.actor_id,permission_key=excluded.permission_key,
      record_kind=excluded.record_kind,root_record_kind=excluded.root_record_kind,root_id=excluded.root_id,
      root_last_sync_id=excluded.root_last_sync_id,project_client_id=excluded.project_client_id,
      project_organization_id=excluded.project_organization_id,project_status=excluded.project_status,
      project_last_sync_id=excluded.project_last_sync_id,expected_version=excluded.expected_version,current_writes=excluded.current_writes,
      assignment_deletes=excluded.assignment_deletes,assignment_inserts=excluded.assignment_inserts,
      revision_writes=excluded.revision_writes,event_writes=excluded.event_writes,mutation_writes=excluded.mutation_writes,
      write_guard=excluded.write_guard`)
    .bind(project.projection_source_id, project.id, principal.id,
      kind === "contacts" ? "project.contacts.manage" : "project.memory.manage", kind,
      rootKind(plan.context), plan.context.root.public_id, plan.pair.root.last_sync_id, project.client_id,
      project.organization_id, project.status, project.last_sync_id, expectedVersion, deletes, inserts,
      principal.id, idempotencyKey);
}

function copyFence(db: Database, plan: CopyPlan, principal: StaffPrincipal, idempotencyKey: string): D1PreparedStatement {
  const context = plan.context, sourceRoot = rootOwnershipSql(context, "source_project", "source_owner"),
    destinationRoot = rootOwnershipSql(context, "destination_project", "destination_owner");
  const needsContacts = plan.input.selectedContactRoles.length > 0, needsMemory = plan.input.selectedMemorySections.length > 0;
  const evaluatedGuard = `EXISTS(SELECT 1 FROM staff_users actor
    JOIN pa_projects source_project ON source_project.id=? AND source_project.projection_source_id=? AND source_project.active=1
      AND source_project.last_sync_id=?
    LEFT JOIN pa_clients source_owner ON source_owner.id=source_project.client_id
      AND source_owner.projection_source_id=source_project.projection_source_id AND source_owner.active=1
    JOIN pa_projects destination_project ON destination_project.id=? AND destination_project.projection_source_id=?
      AND destination_project.active=1 AND destination_project.status IN ('not_started','active','overdue')
      AND destination_project.last_sync_id=?
    LEFT JOIN pa_clients destination_owner ON destination_owner.id=destination_project.client_id
      AND destination_owner.projection_source_id=destination_project.projection_source_id AND destination_owner.active=1
    WHERE actor.id=? AND actor.status='active' AND ${globalPermissionSql("team.view")} AND ${globalPermissionSql("projects.view")}
      ${needsContacts ? `AND ${globalPermissionSql("project.contacts.manage")}` : ""}
      ${needsMemory ? `AND ${globalPermissionSql("project.memory.manage")}` : ""}
      AND (${sourceRoot.sql}) AND (${destinationRoot.sql})
      AND (${plan.pair.policy.filter.sql.replaceAll("p.", "source_project.")})
      AND (${plan.pair.policy.filter.sql.replaceAll("p.", "destination_project.")}))`;
  const guardValues: unknown[] = [plan.pair.source.id, context.root.source_id, plan.pair.source.last_sync_id,
    plan.pair.destination.id, context.root.source_id, plan.pair.destination.last_sync_id, principal.id,
    ...sourceRoot.values, ...destinationRoot.values, ...plan.pair.policy.filter.values, ...plan.pair.policy.filter.values];
  return db.prepare(`INSERT INTO project_operational_copy_fences(actor_id,idempotency_key,projection_source_id,
      source_project_id,destination_project_id,root_record_kind,root_id,root_last_sync_id,source_project_last_sync_id,
      destination_project_last_sync_id,source_contacts_version,destination_contacts_version,source_memory_version,
      destination_memory_version,requires_contacts,requires_memory,source_contact_ids_json,receipt_writes,write_guard)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,CASE WHEN ${evaluatedGuard} THEN 1 ELSE 0 END)`)
    .bind(principal.id, idempotencyKey, context.root.source_id, plan.pair.source.id, plan.pair.destination.id,
      rootKind(context), context.root.public_id, plan.pair.root.last_sync_id, plan.pair.source.last_sync_id,
      plan.pair.destination.last_sync_id, plan.source.contactsVersion, plan.destination.contactsVersion,
      plan.source.memoryVersion, plan.destination.memoryVersion, needsContacts ? 1 : 0, needsMemory ? 1 : 0,
      JSON.stringify(plan.sourceContactIds), ...guardValues);
}

function contactSnapshot(rows: ContactRow[]): string {
  return JSON.stringify({ schemaVersion: 1, assignments: rows.map(row => ({ id: row.id, contactId: row.contact_id,
    role: row.role, preferredContactMethod: row.preferred_contact_method, instructions: row.instructions,
    sortOrder: row.sort_order })) });
}

function contactStatements(db: Database, plan: CopyPlan, principal: StaffPrincipal, idempotencyKey: string): D1PreparedStatement[] {
  if (!plan.contactsChanged) return [];
  const source = plan.context.root.source_id, project = plan.pair.destination.id, before = plan.destination.contactsVersion,
    after = before + 1;
  const result: D1PreparedStatement[] = [operationFence(db, plan, principal, "contacts", before,
    plan.destination.contacts.length, plan.contacts.length, idempotencyKey)];
  if (before === 0) result.push(db.prepare(`INSERT INTO project_operational_contact_sets
    (projection_source_id,project_id,root_record_kind,root_id,version,created_by,updated_by) VALUES(?,?,?,?,1,?,?)`)
    .bind(source, project, rootKind(plan.context), plan.context.root.public_id, principal.id, principal.id));
  else result.push(db.prepare(`UPDATE project_operational_contact_sets SET version=version+1,updated_by=?,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE projection_source_id=? AND project_id=? AND version=?`)
    .bind(principal.id, source, project, before));
  result.push(db.prepare("DELETE FROM project_operational_contact_assignments WHERE projection_source_id=? AND project_id=?")
    .bind(source, project));
  for (const row of plan.contacts) result.push(db.prepare(`INSERT INTO project_operational_contact_assignments
    (id,projection_source_id,project_id,contact_id,role,preferred_contact_method,instructions,sort_order,created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(row.id, source, project, row.contact_id, row.role, row.preferred_contact_method,
    row.instructions, row.sort_order, principal.id));
  result.push(db.prepare(`INSERT INTO project_operational_contact_revisions
    (id,projection_source_id,project_id,version,snapshot_json,actor_id) VALUES(?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), source, project, after, contactSnapshot(plan.contacts), principal.id));
  result.push(db.prepare(`INSERT INTO project_operational_events
    (id,projection_source_id,project_id,actor_id,event_kind,result_version,details_json) VALUES(?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), source, project, principal.id, "contacts_saved", after,
      JSON.stringify({ assignmentCount: plan.contacts.length, copied: true })));
  result.push(db.prepare("DELETE FROM project_operational_write_fences WHERE projection_source_id=? AND project_id=?")
    .bind(source, project));
  return result;
}

function memoryStatements(db: Database, plan: CopyPlan, principal: StaffPrincipal, idempotencyKey: string): D1PreparedStatement[] {
  if (!plan.memoryChanged) return [];
  const source = plan.context.root.source_id, project = plan.pair.destination.id, before = plan.destination.memoryVersion,
    after = before + 1, snapshot = JSON.stringify(plan.memory);
  const result: D1PreparedStatement[] = [operationFence(db, plan, principal, "memory", before, 0, 0, idempotencyKey)];
  if (before === 0) result.push(db.prepare(`INSERT INTO project_operational_memory
    (projection_source_id,project_id,root_record_kind,root_id,version,snapshot_json,created_by,updated_by)
    VALUES(?,?,?,?,1,?,?,?)`).bind(source, project, rootKind(plan.context), plan.context.root.public_id, snapshot, principal.id, principal.id));
  else result.push(db.prepare(`UPDATE project_operational_memory SET version=version+1,snapshot_json=?,updated_by=?,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE projection_source_id=? AND project_id=? AND version=?`)
    .bind(snapshot, principal.id, source, project, before));
  result.push(db.prepare(`INSERT INTO project_operational_memory_revisions
    (id,projection_source_id,project_id,version,change_kind,snapshot_json,amendment_reason,actor_id)
    VALUES(?,?,?,?, 'saved',?,NULL,?)`).bind(crypto.randomUUID(), source, project, after, snapshot, principal.id));
  result.push(db.prepare(`INSERT INTO project_operational_events
    (id,projection_source_id,project_id,actor_id,event_kind,result_version,details_json) VALUES(?,?,?,?,?,?,?)`)
    .bind(crypto.randomUUID(), source, project, principal.id, "memory_saved", after,
      JSON.stringify({ sectionCount: PROJECT_MEMORY_SECTIONS.filter(key => Boolean(plan.memory[key])).length, copied: true })));
  result.push(db.prepare("DELETE FROM project_operational_write_fences WHERE projection_source_id=? AND project_id=?")
    .bind(source, project));
  return result;
}

function resultFor(plan: CopyPlan, replayed: boolean): RecurringProjectCopyResult {
  const preview = previewResult(plan);
  return { ...preview, replayed, destination: { ...preview.destination,
    contactsVersionAfter: plan.destination.contactsVersion + (plan.contactsChanged ? 1 : 0),
    memoryVersionAfter: plan.destination.memoryVersion + (plan.memoryChanged ? 1 : 0) } };
}

export async function commitRecurringProjectCopy(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext, raw: unknown): Promise<RecurringProjectCopyResult> {
  const input = parse(commitRecurringProjectCopySchema, raw, "Recurring-project copy commit is invalid");
  const requestFingerprint = await sha({ ...input, idempotencyKey: undefined });
  const db = database(env);
  const receipt = await db.prepare(`SELECT request_fingerprint,preview_fingerprint,projection_source_id,source_project_id,
      destination_project_id,result_json FROM project_operational_copy_receipts WHERE actor_id=? AND idempotency_key=?`)
    .bind(principal.id, input.idempotencyKey).first<ReceiptRow>();
  if (receipt) {
    if (receipt.request_fingerprint !== requestFingerprint || receipt.preview_fingerprint !== input.previewFingerprint
      || receipt.projection_source_id !== context.root.source_id || receipt.source_project_id !== input.sourceProjectId
      || receipt.destination_project_id !== input.destinationProjectId)
      throw new HTTPException(409, { message: "This operation key was already used for a different copy" });
    await authorizePair(env, principal, context, input, { enforceExpectedContext: false, enforceDestinationOpen: false });
    try { return { ...(JSON.parse(receipt.result_json) as RecurringProjectCopyResult), replayed: true }; }
    catch { throw new HTTPException(503, { message: "Saved copy receipt requires administrative review" }); }
  }
  const { previewFingerprint: _previewFingerprint, idempotencyKey: _idempotencyKey, ...previewInput } = input;
  const plan = await buildPlan(env, principal, context, previewInput);
  if (plan.fingerprint !== input.previewFingerprint) changed();
  const result = resultFor(plan, false), statements: D1PreparedStatement[] = [copyFence(db, plan, principal, input.idempotencyKey)];
  statements.push(...contactStatements(db, plan, principal, input.idempotencyKey));
  statements.push(...memoryStatements(db, plan, principal, input.idempotencyKey));
  statements.push(db.prepare(`INSERT INTO project_operational_copy_receipts(actor_id,idempotency_key,request_fingerprint,
    preview_fingerprint,projection_source_id,source_project_id,destination_project_id,root_record_kind,root_id,
    contact_roles_json,memory_sections_json,conflict_policy,source_contacts_version,destination_contacts_before,
    destination_contacts_after,source_memory_version,destination_memory_before,destination_memory_after,
    copied_contact_count,copied_memory_section_count,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(principal.id, input.idempotencyKey, requestFingerprint, input.previewFingerprint, context.root.source_id,
      plan.pair.source.id, plan.pair.destination.id, rootKind(context), context.root.public_id,
      JSON.stringify(plan.input.selectedContactRoles), JSON.stringify(plan.input.selectedMemorySections), plan.input.conflictPolicy,
      plan.source.contactsVersion, plan.destination.contactsVersion, result.destination.contactsVersionAfter,
      plan.source.memoryVersion, plan.destination.memoryVersion, result.destination.memoryVersionAfter,
      plan.copiedContacts, plan.copiedMemorySections.length, JSON.stringify(result)));
  statements.push(db.prepare("DELETE FROM project_operational_copy_fences WHERE actor_id=? AND idempotency_key=?")
    .bind(principal.id, input.idempotencyKey));
  try { await db.batch(statements); return result; }
  catch (error) {
    if (error instanceof Error && /current context|copy|constraint|version|unique|foreign key/i.test(error.message)) changed();
    throw error;
  }
}
