import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { businessContactChannels, businessContactChannelsSql } from "./client-business-contact";
import { clientHubBusinessProjectSourceProof } from "./client-hub-business-projects";
import { isBusinessProjectionSource } from "./client-hub-source";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import type { Env, StaffPrincipal } from "./types";

type Environment = Pick<Env, "OPS_DB">;
type Database = Pick<D1Database, "prepare" | "batch">;
export const ORGANIZATION_OPERATIONAL_CONTACT_ROLES = ["primary_operational", "delivery"] as const;
export type OrganizationOperationalContactRole = typeof ORGANIZATION_OPERATIONAL_CONTACT_ROLES[number];

const identifier = z.string().min(1).max(512).regex(/^[^\u0000-\u001f\u007f]+$/);
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/);
const contextVersion = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const assignmentSchema = z.object({ contactId: identifier, role: z.enum(ORGANIZATION_OPERATIONAL_CONTACT_ROLES) }).strict();
export const saveOrganizationOperationalContactsSchema = z.object({
  expectedContextVersion: contextVersion,
  expectedVersion: z.number().int().min(0).safe(),
  idempotencyKey,
  assignments: z.array(assignmentSchema).max(100),
}).strict().superRefine((value, issue) => {
  const keys = value.assignments.map(item => JSON.stringify([item.contactId, item.role]));
  if (new Set(keys).size !== keys.length)
    issue.addIssue({ code: "custom", message: "Each contact may have each organization role only once" });
  if (value.assignments.filter(item => item.role === "primary_operational").length > 1)
    issue.addIssue({ code: "custom", message: "An organization may have only one primary operational contact" });
});
export type SaveOrganizationOperationalContactsInput = z.infer<typeof saveOrganizationOperationalContactsSchema>;

interface RootRow { id: string; projection_source_id: string; active: number; last_sync_id: string }
interface PreparedOrganization { context: ClientHubCollectionContext; root: RootRow; sourceProof: string }
interface ContactSetRow { version: number; updated_at: string }
interface AssignmentRow {
  id: string; contact_id: string; role: OrganizationOperationalContactRole; sort_order: number;
  contact_name: string | null; email: string | null; phone: string | null;
}
interface ReceiptRow {
  operation_kind: "contacts_save"; request_fingerprint: string; projection_source_id: string;
  organization_id: string; result_version: number; result_json: string;
}
export interface OrganizationOperationalContact {
  id: string; role: OrganizationOperationalContactRole; sortOrder: number; availability: "available" | "unavailable";
  contact: { id: string; displayName: string; email: string | null; phone: string | null } | null;
}
export interface OrganizationOperationalContactsWorkspace {
  canonicalRoot: ClientHubCollectionContext["canonicalRoot"]; contextVersion: string;
  organization: { id: string; sourceId: string; revision: string };
  contacts: { version: number; assignments: OrganizationOperationalContact[];
    revisions: Array<{ version: number; actorId: string; createdAt: string }> };
  capabilities: { canManageOrganizationContacts: boolean };
}
export interface OrganizationOperationalContactsMutationResult {
  sourceId: string; organizationId: string; version: number; replayed: boolean;
}

const db = (env: Environment): Database => env.OPS_DB.withSession("first-primary");
const unavailable = (): never => { throw new HTTPException(404, { message: "Organization operational contacts are unavailable" }); };
const changed = (): never => { throw new HTTPException(409, { message: "Organization, contacts, permissions, or operational records changed. Refresh before continuing." }); };
function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HTTPException(400, { message });
  return parsed.data;
}
async function fingerprint(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function globalPermissionSql(permission: "team.view" | "organization.contacts.manage"): string {
  return `((EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key='${permission}')
    OR EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key='${permission}')
    OR EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id
      AND permission.permission_key='${permission}' AND permission.scope='global' AND permission.effect='allow'))
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id
      AND permission.permission_key='${permission}' AND permission.scope='global' AND permission.effect='deny'))`;
}
function validateContext(context: ClientHubCollectionContext, expected?: string): void {
  if (context.root.root_namespace !== "business" || context.root.kind !== "organization"
    || !isBusinessProjectionSource(context.root.source_id)) return unavailable();
  if (!context.access.directory) throw new HTTPException(403, { message: "Client-directory access is required" });
  if (expected !== undefined && expected !== context.contextVersion) return changed();
}
async function rootRow(database: Database, context: ClientHubCollectionContext): Promise<RootRow | null> {
  return database.prepare(`SELECT id,projection_source_id,active,last_sync_id FROM pa_organizations
    WHERE id=? AND projection_source_id=? AND active=1 AND ${projectAlphaReadVisibleSql("projection_source_id")} LIMIT 1`)
    .bind(context.root.public_id, context.root.source_id).first<RootRow>();
}
async function permission(database: Database, principal: StaffPrincipal, key: "team.view" | "organization.contacts.manage"): Promise<boolean> {
  return (await database.prepare(`SELECT ${globalPermissionSql(key)} allowed FROM staff_users actor
    WHERE actor.id=? AND actor.status='active'`).bind(principal.id).first<number>("allowed")) === 1;
}
async function prepareOrganization(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext,
  manage = false, expectedContextVersion?: string): Promise<PreparedOrganization> {
  validateContext(context, expectedContextVersion);
  const database = db(env);
  const [canView, canManage, sourceProof, root] = await Promise.all([
    permission(database, principal, "team.view"),
    manage ? permission(database, principal, "organization.contacts.manage") : Promise.resolve(true),
    clientHubBusinessProjectSourceProof(env as Env, context), rootRow(database, context),
  ]);
  if (!canView) throw new HTTPException(403, { message: "Global team.view permission required" });
  if (!canManage) throw new HTTPException(403, { message: "Missing global permission: organization.contacts.manage" });
  if (!root) return unavailable();
  const [currentCanView, currentCanManage, currentSourceProof, currentRoot] = await Promise.all([
    permission(database, principal, "team.view"),
    manage ? permission(database, principal, "organization.contacts.manage") : Promise.resolve(true),
    clientHubBusinessProjectSourceProof(env as Env, context), rootRow(database, context),
  ]);
  if (!currentCanView || !currentCanManage || currentSourceProof !== sourceProof || !currentRoot
    || JSON.stringify(currentRoot) !== JSON.stringify(root)) return changed();
  return { context, root, sourceProof };
}
async function currentReceipt(database: Database, actorId: string, key: string): Promise<ReceiptRow | null> {
  return database.prepare(`SELECT operation_kind,request_fingerprint,projection_source_id,organization_id,result_version,result_json
    FROM organization_operational_mutations WHERE actor_id=? AND idempotency_key=?`).bind(actorId, key).first<ReceiptRow>();
}
function receiptResult(receipt: ReceiptRow): Omit<OrganizationOperationalContactsMutationResult, "replayed"> {
  try {
    const value = JSON.parse(receipt.result_json) as Record<string, unknown>;
    if (value.sourceId !== receipt.projection_source_id || value.organizationId !== receipt.organization_id
      || value.version !== receipt.result_version) throw new Error();
    return { sourceId: receipt.projection_source_id, organizationId: receipt.organization_id, version: receipt.result_version };
  } catch { throw new HTTPException(503, { message: "Saved organization contact operation requires administrative review" }); }
}
async function replay(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext,
  expectedContextVersion: string, expectedFingerprint: string,
  receipt: ReceiptRow): Promise<OrganizationOperationalContactsMutationResult> {
  if (receipt.operation_kind !== "contacts_save" || receipt.request_fingerprint !== expectedFingerprint
    || receipt.projection_source_id !== context.root.source_id || receipt.organization_id !== context.root.public_id)
    throw new HTTPException(409, { message: "This operation key was already used for a different organization contact change" });
  await prepareOrganization(env, principal, context, true, expectedContextVersion);
  return { ...receiptResult(receipt), replayed: true };
}

/** Staff-only operational roles. These records never grant portal, delivery,
 * viewer, billing, mail, notification, or Project Alpha authority. */
export async function readOrganizationOperationalContacts(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext): Promise<OrganizationOperationalContactsWorkspace> {
  const prepared = await prepareOrganization(env, principal, context), database = db(env);
  const source = prepared.root.projection_source_id, organizationId = prepared.root.id;
  const read = async () => {
    const [set, assignments, revisions] = await Promise.all([
      database.prepare(`SELECT version,updated_at FROM organization_operational_contact_sets
        WHERE projection_source_id=? AND organization_id=?`).bind(source, organizationId).first<ContactSetRow>(),
      database.prepare(`SELECT assignment.id,assignment.contact_id,assignment.role,assignment.sort_order,
        contact.name contact_name,${businessContactChannelsSql("contact.payload_json")}
        FROM organization_operational_contact_assignments assignment
        LEFT JOIN pa_clients contact ON contact.id=assignment.contact_id
        AND contact.projection_source_id=assignment.projection_source_id AND contact.organization_id=assignment.organization_id
        AND contact.active=1
        WHERE assignment.projection_source_id=? AND assignment.organization_id=?
        ORDER BY assignment.sort_order,assignment.id`).bind(source, organizationId).all<AssignmentRow>(),
      database.prepare(`SELECT version,actor_id,created_at FROM organization_operational_contact_revisions
        WHERE projection_source_id=? AND organization_id=? ORDER BY version DESC LIMIT 50`)
        .bind(source, organizationId).all<{ version: number; actor_id: string; created_at: string }>(),
    ]);
    return { set, assignments: assignments.results, revisions: revisions.results };
  };
  const first = await read(), current = await prepareOrganization(env, principal, context), second = await read();
  if (current.sourceProof !== prepared.sourceProof || JSON.stringify(current.root) !== JSON.stringify(prepared.root)
    || JSON.stringify(second) !== JSON.stringify(first)) return changed();
  const canManageOrganizationContacts = await permission(database, principal, "organization.contacts.manage");
  const finalContext = await prepareOrganization(env, principal, context), final = await read();
  if (finalContext.sourceProof !== prepared.sourceProof || JSON.stringify(finalContext.root) !== JSON.stringify(prepared.root)
    || JSON.stringify(final) !== JSON.stringify(second)) return changed();
  return {
    canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion,
    organization: { id: organizationId, sourceId: source, revision: prepared.root.last_sync_id },
    contacts: { version: final.set?.version ?? 0,
      assignments: final.assignments.map(row => ({ id: row.id, role: row.role, sortOrder: row.sort_order,
        availability: row.contact_name === null ? "unavailable" : "available",
        contact: row.contact_name === null ? null : { id: row.contact_id, displayName: row.contact_name, ...businessContactChannels(row) } })),
      revisions: final.revisions.map(row => ({ version: row.version, actorId: row.actor_id, createdAt: row.created_at })) },
    capabilities: { canManageOrganizationContacts },
  };
}

export async function saveOrganizationOperationalContacts(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext, raw: unknown): Promise<OrganizationOperationalContactsMutationResult> {
  const input = parse(saveOrganizationOperationalContactsSchema, raw, "Organization operational contacts are invalid");
  const canonical = { sourceId: context.root.source_id, rootId: context.root.public_id,
    expectedContextVersion: input.expectedContextVersion, expectedVersion: input.expectedVersion, assignments: input.assignments };
  const requestFingerprint = await fingerprint(canonical), database = db(env);
  const saved = await currentReceipt(database, principal.id, input.idempotencyKey);
  if (saved) return replay(env, principal, context, input.expectedContextVersion, requestFingerprint, saved);
  const prepared = await prepareOrganization(env, principal, context, true, input.expectedContextVersion);
  const source = prepared.root.projection_source_id, organizationId = prepared.root.id;
  const currentSet = await database.prepare(`SELECT version,updated_at FROM organization_operational_contact_sets
    WHERE projection_source_id=? AND organization_id=?`).bind(source, organizationId).first<ContactSetRow>();
  if ((currentSet?.version ?? 0) !== input.expectedVersion) return changed();
  const currentAssignments = (await database.prepare(`SELECT id,contact_id,role FROM organization_operational_contact_assignments
    WHERE projection_source_id=? AND organization_id=?`).bind(source, organizationId)
    .all<{ id: string; contact_id: string; role: OrganizationOperationalContactRole }>()).results;
  const contactIds = [...new Set(input.assignments.map(item => item.contactId))];
  if (contactIds.length) {
    const valid = await database.prepare(`SELECT count(*) count FROM pa_clients contact
      WHERE contact.projection_source_id=? AND contact.organization_id=? AND contact.active=1
        AND contact.id IN (${contactIds.map(() => "?").join(",")})`)
      .bind(source, organizationId, ...contactIds).first<number>("count");
    if (valid !== contactIds.length)
      throw new HTTPException(409, { message: "One or more contacts moved or are unavailable. Refresh before saving." });
  }
  const version = input.expectedVersion + 1;
  const ids = new Map(currentAssignments.map(row => [JSON.stringify([row.contact_id, row.role]), row.id]));
  const assignments = input.assignments.map((item, sortOrder) => ({ ...item, sortOrder,
    id: ids.get(JSON.stringify([item.contactId, item.role])) ?? crypto.randomUUID() }));
  const snapshot = JSON.stringify({ schemaVersion: 1, assignments });
  const result = { sourceId: source, organizationId, version };
  const guardValues: unknown[] = [principal.id, organizationId, source, prepared.root.last_sync_id,
    source, organizationId, ...(input.expectedVersion === 0 ? [] : [input.expectedVersion]),
    JSON.stringify(contactIds), source, organizationId];
  const guardSql = `EXISTS(SELECT 1 FROM staff_users actor WHERE actor.id=? AND actor.status='active'
      AND ${globalPermissionSql("team.view")} AND ${globalPermissionSql("organization.contacts.manage")})
    AND EXISTS(SELECT 1 FROM pa_organizations organization WHERE organization.id=? AND organization.projection_source_id=?
      AND organization.active=1 AND organization.last_sync_id=? AND ${projectAlphaReadVisibleSql("organization.projection_source_id")})
    AND ${input.expectedVersion === 0
      ? "NOT EXISTS(SELECT 1 FROM organization_operational_contact_sets current WHERE current.projection_source_id=? AND current.organization_id=?)"
      : "EXISTS(SELECT 1 FROM organization_operational_contact_sets current WHERE current.projection_source_id=? AND current.organization_id=? AND current.version=?)"}
    AND NOT EXISTS(SELECT 1 FROM json_each(?) wanted WHERE typeof(wanted.value)<>'text'
      OR NOT EXISTS(SELECT 1 FROM pa_clients contact WHERE contact.id=wanted.value AND contact.projection_source_id=?
        AND contact.organization_id=? AND contact.active=1))`;
  const fence = database.prepare(`INSERT INTO organization_operational_write_fences
      (projection_source_id,organization_id,actor_id,organization_last_sync_id,expected_version,contact_ids_json,
       current_writes,assignment_deletes,assignment_inserts,revision_writes,event_writes,mutation_writes,write_guard)
    VALUES(?,?,?,?,?,?,1,?,?,1,1,1,CASE WHEN ${guardSql} THEN 1 ELSE 0 END)
    ON CONFLICT(projection_source_id,organization_id) DO UPDATE SET actor_id=excluded.actor_id,
      organization_last_sync_id=excluded.organization_last_sync_id,expected_version=excluded.expected_version,
      contact_ids_json=excluded.contact_ids_json,current_writes=excluded.current_writes,
      assignment_deletes=excluded.assignment_deletes,assignment_inserts=excluded.assignment_inserts,
      revision_writes=excluded.revision_writes,event_writes=excluded.event_writes,
      mutation_writes=excluded.mutation_writes,write_guard=excluded.write_guard`)
    .bind(source, organizationId, principal.id, prepared.root.last_sync_id, input.expectedVersion, JSON.stringify(contactIds),
      currentAssignments.length, assignments.length, ...guardValues);
  const statements: D1PreparedStatement[] = [fence];
  if (input.expectedVersion === 0) statements.push(database.prepare(`INSERT INTO organization_operational_contact_sets
    (projection_source_id,organization_id,version,created_by,updated_by) VALUES(?,?,1,?,?)`)
    .bind(source, organizationId, principal.id, principal.id));
  else statements.push(database.prepare(`UPDATE organization_operational_contact_sets
    SET version=version+1,updated_by=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE projection_source_id=? AND organization_id=? AND version=?`)
    .bind(principal.id, source, organizationId, input.expectedVersion));
  statements.push(database.prepare(`DELETE FROM organization_operational_contact_assignments
    WHERE projection_source_id=? AND organization_id=?`).bind(source, organizationId));
  for (const item of assignments) statements.push(database.prepare(`INSERT INTO organization_operational_contact_assignments
    (id,projection_source_id,organization_id,contact_id,role,sort_order,created_by) VALUES(?,?,?,?,?,?,?)`)
    .bind(item.id, source, organizationId, item.contactId, item.role, item.sortOrder, principal.id));
  const primaryCount = assignments.filter(item => item.role === "primary_operational").length;
  const deliveryCount = assignments.filter(item => item.role === "delivery").length;
  statements.push(
    database.prepare(`INSERT INTO organization_operational_contact_revisions
      (id,projection_source_id,organization_id,version,snapshot_json,actor_id) VALUES(?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), source, organizationId, version, snapshot, principal.id),
    database.prepare(`INSERT INTO organization_operational_events
      (id,projection_source_id,organization_id,actor_id,event_kind,result_version,details_json) VALUES(?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(), source, organizationId, principal.id, "contacts_saved", version,
        JSON.stringify({ schemaVersion: 1, primaryOperationalCount: primaryCount, deliveryCount })),
    database.prepare(`INSERT INTO organization_operational_mutations
      (actor_id,idempotency_key,operation_kind,request_fingerprint,projection_source_id,organization_id,result_version,result_json)
      VALUES(?,?,?,?,?,?,?,?)`).bind(principal.id, input.idempotencyKey, "contacts_save", requestFingerprint,
      source, organizationId, version, JSON.stringify(result)),
    database.prepare(`DELETE FROM organization_operational_write_fences WHERE projection_source_id=? AND organization_id=?`)
      .bind(source, organizationId),
  );
  try { await database.batch(statements); }
  catch (error) {
    const winner = await currentReceipt(database, principal.id, input.idempotencyKey);
    if (winner) return replay(env, principal, context, input.expectedContextVersion, requestFingerprint, winner);
    if (error instanceof Error && /organization operational|current context|CHECK constraint failed|version|UNIQUE|FOREIGN KEY|contact set/i.test(error.message)) return changed();
    throw new HTTPException(503, { message: "Organization operational contacts could not be saved. Retry with the same operation key." });
  }
  await prepareOrganization(env, principal, context, true);
  return { ...result, replayed: false };
}
