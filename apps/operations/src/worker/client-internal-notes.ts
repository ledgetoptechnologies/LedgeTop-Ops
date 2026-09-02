import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";
import type { Env, StaffPrincipal } from "./types";

type Environment = Pick<Env, "OPS_DB" | "DELIVERY_DB">;
type Database = Pick<D1Database, "prepare" | "batch">;
type Operation = "create" | "update" | "delete";
const contextVersion = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const noteId = z.string().uuid();
const clean = (maximum: number, minimum = 0) => z.string().min(minimum).max(maximum)
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));
export const createClientInternalNoteSchema = z.object({ expectedContextVersion: contextVersion,
  title: clean(160, 1), body: clean(12_000) }).strict();
export const updateClientInternalNoteSchema = z.object({ expectedContextVersion: contextVersion,
  expectedVersion: z.number().int().positive().safe(), title: clean(160, 1), body: clean(12_000) }).strict();
export const deleteClientInternalNoteSchema = z.object({ expectedContextVersion: contextVersion,
  expectedVersion: z.number().int().positive().safe() }).strict();

interface NoteRow { id: string; version: number; title: string; body: string; created_by: string; updated_by: string;
  created_at: string; updated_at: string }
interface RevisionRow { note_id: string; version: number; action: "created" | "updated" | "deleted"; actor_id: string; created_at: string }
interface ReceiptRow { operation_kind: Operation; request_fingerprint: string; source_id: string; root_namespace: string;
  root_kind: string; root_id: string; note_id: string; result_version: number; result_json: string }
export interface ClientInternalNote { id: string; version: number; title: string; body: string; createdBy: string;
  updatedBy: string; createdAt: string; updatedAt: string;
  revisions: Array<{ version: number; action: RevisionRow["action"]; actorId: string; createdAt: string }> }
export interface ClientInternalNotesWorkspace {
  canonicalRoot: ClientHubCollectionContext["canonicalRoot"]; contextVersion: string;
  notes: ClientInternalNote[]; capabilities: { canManageNotes: boolean };
}
export interface ClientInternalNoteMutationResult { noteId: string; version: number; deleted: boolean; replayed: boolean }

const db = (env: Environment): Database => env.OPS_DB.withSession("first-primary");
const changed = (): never => { throw new HTTPException(409, { message: "Client notes or workspace authority changed. Refresh before continuing." }); };
const normalize = (value: string) => value.normalize("NFC").trim();
function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HTTPException(400, { message });
  return parsed.data;
}
async function fingerprint(value: unknown): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function permissionSql(key: "team.view" | "client.notes.manage"): string {
  return `((EXISTS(SELECT 1 FROM staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key='${key}')
    OR EXISTS(SELECT 1 FROM local_staff_role_assignments assignment JOIN role_permissions permission ON permission.role_id=assignment.role_id
      WHERE assignment.staff_id=actor.id AND assignment.scope='global' AND permission.permission_key='${key}')
    OR EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id
      AND permission.permission_key='${key}' AND permission.scope='global' AND permission.effect='allow'))
    AND NOT EXISTS(SELECT 1 FROM staff_permission_overrides permission WHERE permission.staff_id=actor.id
      AND permission.permission_key='${key}' AND permission.scope='global' AND permission.effect='deny'))`;
}
async function allowed(database: Database, principal: StaffPrincipal, key: "team.view" | "client.notes.manage"): Promise<boolean> {
  return (await database.prepare(`SELECT ${permissionSql(key)} allowed FROM staff_users actor WHERE actor.id=? AND actor.status='active'`)
    .bind(principal.id).first<number>("allowed")) === 1;
}
function tuple(context: ClientHubCollectionContext): [string, string, string, string] {
  return [context.root.source_id, context.root.root_namespace, context.root.kind, context.root.public_id];
}
async function rootProof(env: Environment, context: ClientHubCollectionContext): Promise<string> {
  const root = context.root;
  if (root.root_namespace === "business") {
    const table = root.kind === "organization" ? "pa_organizations" : "pa_clients";
    const row = await db(env).prepare(`SELECT id,projection_source_id,active,last_sync_id FROM ${table}
      WHERE id=? AND projection_source_id=? AND active=1 ${root.kind === "standalone_client" ? "AND organization_id IS NULL" : ""}
      AND ${projectAlphaReadVisibleSql("projection_source_id")} LIMIT 1`).bind(root.public_id, root.source_id).first<Record<string, unknown>>();
    if (!row) throw new HTTPException(404, { message: "Client workspace is unavailable" });
    return JSON.stringify(row);
  }
  if (root.root_namespace === "account") {
    const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,status,project_alpha_source_id,
      project_alpha_client_id,project_alpha_organization_id,updated_at FROM client_accounts WHERE id=? LIMIT 1`)
      .bind(root.public_id).first<Record<string, unknown>>();
    if (!row || row.status === "closed") throw new HTTPException(404, { message: "Client workspace is unavailable" });
    return JSON.stringify(row);
  }
  if (!root.workspace_id) throw new HTTPException(404, { message: "Client workspace is unavailable" });
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT id,status,project_alpha_source_id,
    pa_organization_public_id,pa_client_public_id FROM portal_v2_workspaces WHERE id=? AND project_alpha_source_id=? LIMIT 1`)
    .bind(root.workspace_id, root.source_id).first<Record<string, unknown>>();
  if (!row || row.status === "closed") throw new HTTPException(404, { message: "Client workspace is unavailable" });
  return JSON.stringify(row);
}
async function prepare(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext,
  manage = false, expectedContext?: string): Promise<string> {
  if (!context.access.directory) throw new HTTPException(403, { message: "Client-directory access is required" });
  if (expectedContext !== undefined && expectedContext !== context.contextVersion) return changed();
  const database = db(env);
  const [canView, canManage, proof] = await Promise.all([allowed(database, principal, "team.view"),
    manage ? allowed(database, principal, "client.notes.manage") : Promise.resolve(true), rootProof(env, context)]);
  if (!canView) throw new HTTPException(403, { message: "Global team.view permission required" });
  if (!canManage) throw new HTTPException(403, { message: "Missing global permission: client.notes.manage" });
  const [currentView, currentManage, currentProof] = await Promise.all([allowed(database, principal, "team.view"),
    manage ? allowed(database, principal, "client.notes.manage") : Promise.resolve(true), rootProof(env, context)]);
  if (!currentView || !currentManage || proof !== currentProof) return changed();
  return proof;
}
function mapNote(row: NoteRow, revisions: RevisionRow[]): ClientInternalNote { return { id: row.id, version: row.version, title: row.title, body: row.body,
  createdBy: row.created_by, updatedBy: row.updated_by, createdAt: row.created_at, updatedAt: row.updated_at,
  revisions: revisions.filter(item => item.note_id === row.id).map(item => ({ version: item.version, action: item.action,
    actorId: item.actor_id, createdAt: item.created_at })) }; }
async function readRows(database: Database, context: ClientHubCollectionContext): Promise<{ notes: NoteRow[]; revisions: RevisionRow[] }> {
  const notes = (await database.prepare(`SELECT id,version,title,body,created_by,updated_by,created_at,updated_at FROM client_internal_notes
    WHERE source_id=? AND root_namespace=? AND root_kind=? AND root_id=? AND deleted_at IS NULL
    ORDER BY updated_at DESC,id LIMIT 100`).bind(...tuple(context)).all<NoteRow>()).results;
  if (!notes.length) return { notes, revisions: [] };
  const revisions = (await database.prepare(`SELECT note_id,version,action,actor_id,created_at FROM (
      SELECT note_id,version,action,actor_id,created_at,
        row_number() OVER(PARTITION BY note_id ORDER BY version DESC) revision_rank
      FROM client_internal_note_revisions WHERE source_id=? AND root_namespace=? AND root_kind=? AND root_id=?
        AND note_id IN (${notes.map(() => "?").join(",")})
    ) WHERE revision_rank<=20 ORDER BY note_id,version DESC`)
    .bind(...tuple(context), ...notes.map(note => note.id)).all<RevisionRow>()).results;
  return { notes, revisions };
}
export async function readClientInternalNotes(env: Environment, principal: StaffPrincipal,
  context: ClientHubCollectionContext): Promise<ClientInternalNotesWorkspace> {
  const firstProof = await prepare(env, principal, context), database = db(env), first = await readRows(database, context);
  const secondProof = await prepare(env, principal, context), second = await readRows(database, context);
  if (firstProof !== secondProof || JSON.stringify(first) !== JSON.stringify(second)) return changed();
  return { canonicalRoot: context.canonicalRoot, contextVersion: context.contextVersion,
    notes: second.notes.map(note => mapNote(note, second.revisions)),
    capabilities: { canManageNotes: await allowed(database, principal, "client.notes.manage") } };
}
async function receipt(database: Database, actorId: string, key: string): Promise<ReceiptRow | null> {
  return database.prepare(`SELECT operation_kind,request_fingerprint,source_id,root_namespace,root_kind,root_id,note_id,result_version,result_json
    FROM client_internal_note_mutations WHERE actor_id=? AND idempotency_key=?`).bind(actorId, key).first<ReceiptRow>();
}
function replayResult(saved: ReceiptRow, operation: Operation, requestFingerprint: string,
  context: ClientHubCollectionContext): ClientInternalNoteMutationResult {
  if (saved.operation_kind !== operation || saved.request_fingerprint !== requestFingerprint
    || JSON.stringify([saved.source_id,saved.root_namespace,saved.root_kind,saved.root_id]) !== JSON.stringify(tuple(context)))
    throw new HTTPException(409, { message: "This operation key was already used for a different client note change" });
  try {
    const result = JSON.parse(saved.result_json) as ClientInternalNoteMutationResult;
    if (result.noteId !== saved.note_id || result.version !== saved.result_version) throw new Error();
    return { ...result, replayed: true };
  } catch { throw new HTTPException(503, { message: "Saved client note operation requires administrative review" }); }
}
function mutationKey(value: string): string {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(value)) throw new HTTPException(400, { message: "A valid Idempotency-Key header is required" });
  return value;
}
async function runMutation(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext,
  operation: Operation, note: string, version: number, title: string, body: string, keyValue: string,
  expectedContext: string): Promise<ClientInternalNoteMutationResult> {
  const key = mutationKey(keyValue), canonical = { operation, root: tuple(context), note: operation === "create" ? null : note,
    version, title: operation === "delete" ? null : title, body: operation === "delete" ? null : body, expectedContext };
  const requestFingerprint = await fingerprint(canonical), database = db(env), saved = await receipt(database, principal.id, key);
  if (saved) { await prepare(env, principal, context, true, expectedContext); return replayResult(saved, operation, requestFingerprint, context); }
  await prepare(env, principal, context, true, expectedContext);
  if (operation === "delete") {
    const current = await database.prepare(`SELECT title,body FROM client_internal_notes WHERE id=? AND source_id=?
      AND root_namespace=? AND root_kind=? AND root_id=? AND version=? AND deleted_at IS NULL`).bind(note, ...tuple(context), version)
      .first<{ title: string; body: string }>();
    if (!current) return changed();
    title = current.title; body = current.body;
  }
  const nextVersion = operation === "create" ? 1 : version + 1, result = { noteId: note, version: nextVersion,
    deleted: operation === "delete", replayed: false }, scope = tuple(context), now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
  const permitted = `EXISTS(SELECT 1 FROM staff_users actor WHERE actor.id=? AND actor.status='active'
    AND ${permissionSql("team.view")} AND ${permissionSql("client.notes.manage")})`;
  const statements: D1PreparedStatement[] = [];
  if (operation === "create") statements.push(database.prepare(`INSERT INTO client_internal_notes
    (id,source_id,root_namespace,root_kind,root_id,version,title,body,created_by,updated_by)
    SELECT ?,?,?,?,?,1,?,?,?,? WHERE ${permitted}`).bind(note, ...scope, title, body, principal.id, principal.id, principal.id));
  else statements.push(database.prepare(`UPDATE client_internal_notes SET version=version+1,title=?,body=?,updated_by=?,
    updated_at=${now}${operation === "delete" ? `,deleted_at=${now}` : ""}
    WHERE id=? AND source_id=? AND root_namespace=? AND root_kind=? AND root_id=? AND version=? AND deleted_at IS NULL
      AND ${permitted}`).bind(title, body, principal.id, note, ...scope, version, principal.id));
  statements.push(database.prepare(`INSERT INTO client_internal_note_revisions
    (id,note_id,source_id,root_namespace,root_kind,root_id,version,action,title,body,actor_id)
    SELECT ?,id,source_id,root_namespace,root_kind,root_id,version,?,?,?,? FROM client_internal_notes
    WHERE id=? AND source_id=? AND root_namespace=? AND root_kind=? AND root_id=? AND version=?
      AND ${operation === "delete" ? "deleted_at IS NOT NULL" : "deleted_at IS NULL"}`)
    .bind(crypto.randomUUID(), operation === "create" ? "created" : operation === "update" ? "updated" : "deleted",
      title, body, principal.id, note, ...scope, nextVersion));
  statements.push(database.prepare(`INSERT INTO client_internal_note_mutations
    (actor_id,idempotency_key,operation_kind,request_fingerprint,source_id,root_namespace,root_kind,root_id,note_id,result_version,result_json)
    SELECT ?,?,?,?,?,?,?,?,?,?,? FROM client_internal_note_revisions revision
    WHERE revision.note_id=? AND revision.version=? AND revision.action=?`)
    .bind(principal.id, key, operation, requestFingerprint, ...scope, note, nextVersion, JSON.stringify(result), note, nextVersion,
      operation === "create" ? "created" : operation === "update" ? "updated" : "deleted"));
  try { await database.batch(statements); } catch (error) {
    const winner = await receipt(database, principal.id, key);
    if (winner) { await prepare(env, principal, context, true, expectedContext); return replayResult(winner, operation, requestFingerprint, context); }
    if (operation !== "create") {
      const currentVersion = await database.prepare(`SELECT version FROM client_internal_notes WHERE id=? AND source_id=?
        AND root_namespace=? AND root_kind=? AND root_id=? AND deleted_at IS NULL`).bind(note, ...scope).first<number>("version");
      if (currentVersion !== version) return changed();
    }
    throw error;
  }
  const committed = await receipt(database, principal.id, key);
  if (!committed) return changed();
  await prepare(env, principal, context, true, expectedContext);
  return { ...replayResult(committed, operation, requestFingerprint, context), replayed: false };
}
export async function createClientInternalNote(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext,
  raw: unknown, key: string): Promise<ClientInternalNoteMutationResult> {
  const input = parse(createClientInternalNoteSchema, raw, "Client note is invalid");
  const title = normalize(input.title); if (!title) throw new HTTPException(400, { message: "Client note title is required" });
  return runMutation(env, principal, context, "create", crypto.randomUUID(), 0, title, normalize(input.body), key, input.expectedContextVersion);
}
export async function updateClientInternalNote(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext,
  id: string, raw: unknown, key: string): Promise<ClientInternalNoteMutationResult> {
  if (!noteId.safeParse(id).success) throw new HTTPException(400, { message: "Client note identifier is invalid" });
  const input = parse(updateClientInternalNoteSchema, raw, "Client note update is invalid");
  const title = normalize(input.title); if (!title) throw new HTTPException(400, { message: "Client note title is required" });
  return runMutation(env, principal, context, "update", id, input.expectedVersion, title, normalize(input.body), key, input.expectedContextVersion);
}
export async function deleteClientInternalNote(env: Environment, principal: StaffPrincipal, context: ClientHubCollectionContext,
  id: string, raw: unknown, key: string): Promise<ClientInternalNoteMutationResult> {
  if (!noteId.safeParse(id).success) throw new HTTPException(400, { message: "Client note identifier is invalid" });
  const input = parse(deleteClientInternalNoteSchema, raw, "Client note deletion is invalid");
  return runMutation(env, principal, context, "delete", id, input.expectedVersion, "", "", key, input.expectedContextVersion);
}
