import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Env, StaffPrincipal } from "./types";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const CURSOR_TTL_MS = 30 * 60_000;
const text = z.string().max(200).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const identifier = z.string().max(128).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
const resultSchema = z.enum(["all", "succeeded", "failed", "denied"]);
const cursorSchema = z.object({
  v: z.literal(1),
  policy: z.string().length(43),
  filters: z.string().length(43),
  highWaterId: z.number().int().nonnegative().safe(),
  after: z.tuple([z.string().min(1).max(64), z.number().int().positive().safe()]),
  expiresAt: z.number().int().positive(),
}).strict();

export interface AdminAuditQuery {
  actor?: string;
  action?: string;
  category?: string;
  entity?: string;
  division?: string;
  result?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
}

interface Filters {
  actor: string;
  action: string;
  category: string;
  entity: string;
  division: string;
  result: z.infer<typeof resultSchema>;
  from: string;
  to: string;
  toExclusive: boolean;
  limit: number;
}

interface AuditRow {
  id: number;
  actor_type: unknown;
  actor_id: unknown;
  actor_email: unknown;
  actor_display_name: unknown;
  action: unknown;
  entity_type: unknown;
  entity_id: unknown;
  division_id: unknown;
  created_at: unknown;
}

const resultSql = `CASE
  WHEN lower(action) LIKE '%.failed' OR lower(action) LIKE '%.failure' OR lower(action) LIKE '%.error' THEN 'failed'
  WHEN lower(action) LIKE '%.denied' OR lower(action) LIKE '%.rejected' THEN 'denied'
  ELSE 'succeeded' END`;

function b64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function unb64(value: string): ArrayBuffer {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0)).buffer as ArrayBuffer;
}

async function digest(value: unknown): Promise<string> {
  return b64(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))));
}

async function cursorKey(env: Env): Promise<CryptoKey> {
  if (!env.OPERATIONS_SESSION_SECRET || env.OPERATIONS_SESSION_SECRET.length < 32)
    throw new Error("Administrative audit cursor configuration unavailable");
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`admin-audit:v1:${env.OPERATIONS_SESSION_SECRET}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encodeCursor(env: Env, actor: StaffPrincipal, value: z.infer<typeof cursorSchema>): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
    additionalData: new TextEncoder().encode(`admin-audit:${actor.id}`) }, await cursorKey(env),
  new TextEncoder().encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(new Uint8Array(encrypted))}`;
}

function changed(): never {
  throw new HTTPException(409, { message: "Audit filters or permissions changed. Start a new audit search" });
}

async function decodeCursor(env: Env, actor: StaffPrincipal, token: string): Promise<z.infer<typeof cursorSchema>> {
  try {
    if (token.length > 2048) throw new Error();
    const parts = token.split(".");
    if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/u.test(part))) throw new Error();
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(parts[0]!),
      additionalData: new TextEncoder().encode(`admin-audit:${actor.id}`) }, await cursorKey(env), unb64(parts[1]!));
    return cursorSchema.parse(JSON.parse(new TextDecoder().decode(decrypted)));
  } catch {
    throw new HTTPException(400, { message: "Audit cursor is invalid" });
  }
}

function normalizedText(value: string | undefined, schema = text): string {
  const parsed = schema.safeParse((value ?? "").normalize("NFC").trim());
  if (!parsed.success) throw new HTTPException(400, { message: "Audit filter is invalid" });
  return parsed.data;
}

function dateFilter(value: string | undefined, end: boolean): { value: string; exclusive: boolean } {
  const normalized = normalizedText(value, z.string().max(40).refine(item => !/[\u0000-\u001f\u007f]/.test(item)));
  if (!normalized) return { value: "", exclusive: false };
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(normalized);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(normalized))
    throw new HTTPException(400, { message: "Audit date filter is invalid" });
  const date = new Date(dateOnly ? `${normalized}T00:00:00.000Z` : normalized);
  if (!Number.isFinite(date.getTime()) || (dateOnly && date.toISOString().slice(0, 10) !== normalized))
    throw new HTTPException(400, { message: "Audit date filter is invalid" });
  if (dateOnly && end) date.setUTCDate(date.getUTCDate() + 1);
  return { value: date.toISOString(), exclusive: dateOnly && end };
}

function filters(query: AdminAuditQuery): Filters {
  const parsedResult = resultSchema.safeParse(query.result ?? "all");
  const limit = query.limit === undefined ? PAGE_SIZE : Number(query.limit);
  if (!parsedResult.success || !Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)
    throw new HTTPException(400, { message: "Audit filter is invalid" });
  const from = dateFilter(query.from, false), to = dateFilter(query.to, true);
  if (from.value && to.value && new Date(from.value).getTime() >= new Date(to.value).getTime())
    throw new HTTPException(400, { message: "Audit date range is invalid" });
  return {
    actor: normalizedText(query.actor).toLocaleLowerCase("en-US"),
    action: normalizedText(query.action, identifier),
    category: normalizedText(query.category, identifier).toLocaleLowerCase("en-US"),
    entity: normalizedText(query.entity).toLocaleLowerCase("en-US"),
    division: normalizedText(query.division, identifier),
    result: parsedResult.data,
    from: from.value,
    to: to.value,
    toExclusive: to.exclusive,
    limit,
  };
}

interface AuditPolicy { proof: string; deniedDivisions: string[] }
async function policy(session: D1DatabaseSession, actor: StaffPrincipal): Promise<AuditPolicy> {
  const rows = await session.prepare(`SELECT source,effect,scope,division_id FROM (
    SELECT 'role' source,'allow' effect,a.scope,a.division_id FROM staff_role_assignments a
      JOIN role_permissions p ON p.role_id=a.role_id WHERE a.staff_id=? AND p.permission_key='audit.view'
    UNION ALL SELECT 'role','allow',a.scope,a.division_id FROM local_staff_role_assignments a
      JOIN role_permissions p ON p.role_id=a.role_id WHERE a.staff_id=? AND p.permission_key='audit.view'
    UNION ALL SELECT 'override',effect,scope,division_id FROM staff_permission_overrides
      WHERE staff_id=? AND permission_key='audit.view'
  ) ORDER BY source,effect,scope,coalesce(division_id,'')`).bind(actor.id, actor.id, actor.id)
    .all<{source:string;effect:string;scope:string;division_id:string|null}>();
  const denied = rows.results.some(row => row.source === "override" && row.effect === "deny" && row.scope === "global");
  const allowed = rows.results.some(row => row.effect === "allow" && row.scope === "global");
  if (denied || !allowed) throw new HTTPException(403, { message: "Global audit.view permission required" });
  const deniedDivisions = [...new Set(rows.results.filter(row => row.source === "override" && row.effect === "deny"
    && row.scope === "division" && row.division_id).map(row => row.division_id!))].sort();
  return { proof: await digest([actor.id, rows.results.map(row => [row.source, row.effect, row.scope, row.division_id])]), deniedDivisions };
}

function sqlFilters(value: Filters, deniedDivisions: string[]): { clauses: string[]; bindings: unknown[] } {
  const clauses = ["id<=?", "datetime(created_at) IS NOT NULL"];
  const bindings: unknown[] = [];
  if (value.actor) {
    clauses.push(`(instr(lower(coalesce(actor_id,'')),?)>0 OR instr(lower(coalesce(actor_email,'')),?)>0
      OR instr(lower(coalesce(actor_display_name,'')),?)>0 OR instr(lower(actor_type),?)>0)`);
    bindings.push(value.actor, value.actor, value.actor, value.actor);
  }
  if (value.action) { clauses.push("action=?"); bindings.push(value.action); }
  if (value.category) { clauses.push("(lower(action)=? OR instr(lower(action),? || '.')=1)"); bindings.push(value.category, value.category); }
  if (value.entity) {
    clauses.push("(instr(lower(coalesce(entity_type,'')),?)>0 OR instr(lower(coalesce(entity_id,'')),?)>0)");
    bindings.push(value.entity, value.entity);
  }
  if (value.division === "none") clauses.push("division_id IS NULL");
  else if (value.division) { clauses.push("division_id=?"); bindings.push(value.division); }
  if (value.result !== "all") { clauses.push(`${resultSql}=?`); bindings.push(value.result); }
  if (value.from) { clauses.push("datetime(created_at)>=datetime(?)"); bindings.push(value.from); }
  if (value.to) { clauses.push(`datetime(created_at)${value.toExclusive ? "<" : "<="}datetime(?)`); bindings.push(value.to); }
  if (deniedDivisions.length) {
    clauses.push(`(division_id IS NULL OR division_id NOT IN (${deniedDivisions.map(() => "?").join(",")}))`);
    bindings.push(...deniedDivisions);
  }
  return { clauses, bindings };
}

function safeString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
}

function event(row: AuditRow) {
  if (!Number.isSafeInteger(row.id) || row.id <= 0) return null;
  const actorType = safeString(row.actor_type, 32);
  const action = safeString(row.action, 128);
  const occurredAt = safeString(row.created_at, 64);
  if (!actorType || !["staff", "integration", "system"].includes(actorType) || !action || !occurredAt || !Number.isFinite(Date.parse(occurredAt.replace(" ", "T") + (/[zZ]|[+-]\d\d:\d\d$/u.test(occurredAt) ? "" : "Z")))) return null;
  const lowered = action.toLocaleLowerCase("en-US");
  const result = /\.(?:failed|failure|error)$/u.test(lowered) ? "failed" : /\.(?:denied|rejected)$/u.test(lowered) ? "denied" : "succeeded";
  return {
    id: String(row.id),
    actor: { type: actorType, id: safeString(row.actor_id, 256), email: safeString(row.actor_email, 320),
      displayName: safeString(row.actor_display_name, 256) },
    action,
    category: action.includes(".") ? action.slice(0, action.indexOf(".")) : action,
    resource: { type: safeString(row.entity_type, 128), id: safeString(row.entity_id, 512) },
    divisionId: safeString(row.division_id, 128),
    result,
    occurredAt,
  };
}

export async function listAdminAuditEvents(env: Env, actor: StaffPrincipal, query: AdminAuditQuery = {}) {
  const value = filters(query);
  const session = env.OPS_DB.withSession("first-primary");
  const initialPolicy = await policy(session, actor);
  const filterProof = await digest(value);
  const decoded = query.cursor ? await decodeCursor(env, actor, query.cursor) : null;
  if (decoded && (decoded.filters !== filterProof || decoded.policy !== initialPolicy.proof || decoded.expiresAt < Date.now())) changed();
  const highWaterId = decoded?.highWaterId ?? Number((await session.prepare("SELECT coalesce(max(id),0) high_water FROM audit_events").first<number>("high_water")) ?? 0);
  if (!Number.isSafeInteger(highWaterId) || highWaterId < 0) throw new Error("Administrative audit high-water mark is invalid");
  const built = sqlFilters(value, initialPolicy.deniedDivisions); built.bindings.unshift(highWaterId);
  if (decoded) {
    built.clauses.push("(created_at<? OR (created_at=? AND id<?))");
    built.bindings.push(decoded.after[0], decoded.after[0], decoded.after[1]);
  }
  const rows = await session.prepare(`SELECT id,actor_type,actor_id,actor_email,actor_display_name,action,
    entity_type,entity_id,division_id,created_at FROM audit_events WHERE ${built.clauses.join(" AND ")}
    ORDER BY created_at DESC,id DESC LIMIT ?`).bind(...built.bindings, value.limit + 1).all<AuditRow>();
  const page = rows.results.slice(0, value.limit);
  const currentPolicy = await policy(session, actor);
  if (currentPolicy.proof !== initialPolicy.proof) changed();
  const last = page.at(-1);
  const nextCursor = last && rows.results.length > value.limit
    ? await encodeCursor(env, actor, { v: 1, policy: initialPolicy.proof, filters: filterProof, highWaterId,
      after: [String(last.created_at), last.id], expiresAt: decoded?.expiresAt ?? Date.now() + CURSOR_TTL_MS }) : null;
  return { events: page.map(event).filter((item): item is NonNullable<ReturnType<typeof event>> => item !== null),
    nextCursor, highWaterId: String(highWaterId), filters: value };
}
