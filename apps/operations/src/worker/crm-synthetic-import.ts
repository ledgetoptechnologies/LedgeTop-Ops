import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { hasPermission } from "./acl";
import { readBoundedJson } from "./bounded-json";
import type { Env, StaffPrincipal } from "./types";

const SOURCE_SYSTEM = "hermes-crm-fixture" as const;
const SOURCE_SCHEMA = "hermes-crm.v1" as const;
const ROUTE_SCHEMA = "ops.crm.synthetic-import.v1" as const;
const MAX_BODY_BYTES = 256 * 1024;
const id = z.number().int().positive().safe();
const text = (max = 4000) => z.string().max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Invalid control character");
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
});
const utcInstant = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/)
  .refine(value => dateOnly.safeParse(value.slice(0, 10)).success && !Number.isNaN(Date.parse(value)));
const dateTimeValue = text(80).refine(value => dateOnly.safeParse(value).success
  || (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?$/.test(value)
    && dateOnly.safeParse(value.slice(0, 10)).success && !Number.isNaN(Date.parse(value))));
const optionalText = (max = 4000) => text(max).nullable().optional();
const optionalDate = dateOnly.nullable().optional();
const optionalDateTime = dateTimeValue.nullable().optional();
const bool = z.boolean().nullable().optional();
const scalarEvidence = z.union([text(2000), z.number().finite(), z.boolean(), z.null()]);
const cacheKeys = new Set(["last_contacted_date", "follow_up_date", "draft_created_date", "last_response_date"]);

const contactFields = {
  id, company_name: text(4096), location: optionalText(4096), contact_name: optionalText(4096), email: optionalText(2048),
  phone: optionalText(512), website: optionalText(4096), has_website: z.union([z.literal(-1), z.literal(0), z.literal(1), z.null()]).optional(),
  website_opportunity: bool, status: optionalText(512), contact_type: optionalText(512), sport: optionalText(512),
  priority: optionalText(512), contact_method: optionalText(512), notes: optionalText(16000), outreach_paused: bool, skip_auto_research: bool,
  manual_contact_date: optionalDate, manual_contact_notes: optionalText(4000),
  created_at: optionalDateTime, updated_at: optionalDateTime,
};
const contactSchema = z.object(contactFields).catchall(scalarEvidence).superRefine((value, ctx) => {
  for (const key of Object.keys(value)) {
    if (!(key in contactFields) && !cacheKeys.has(key) && !/^last_response_[a-z0-9_]{1,64}$/i.test(key))
      ctx.addIssue({ code: "custom", message: "Unsupported contact field", path: [key] });
  }
  for (const key of ["last_contacted_date", "follow_up_date", "draft_created_date", "last_response_date"]) {
    const cacheValue = value[key];
    if (cacheValue !== undefined && cacheValue !== null && (typeof cacheValue !== "string" || !dateOnly.safeParse(cacheValue).success))
      ctx.addIssue({ code: "custom", message: "Legacy cache dates must retain date-only precision", path: [key] });
  }
});

const contactLogSchema = z.object({
  id, contact_id: id.nullable().optional(), log_date: dateOnly, log_type: text(512), direction: optionalText(512), subject: optionalText(4096),
  notes: optionalText(8000), source: optionalText(512), account: optionalText(128),
  external_message_id: optionalText(512), external_draft_id: optionalText(512), external_thread_id: optionalText(512),
  channel: optionalText(512), outcome: optionalText(512), occurred_at: utcInstant.nullable().optional(),
  matched_email: optionalText(320), participant_role: optionalText(100), idempotency_key: optionalText(128),
  effects_mode: optionalText(100), created_at: optionalText(80),
}).strict();

const followupSchema = z.object({
  id, contact_id: id.nullable().optional(), follow_up_date: optionalDateTime, method: optionalText(512), notes: optionalText(16000), completed: bool,
  source: optionalText(512), action_kind: optionalText(512), responsibility: optionalText(512),
  origin_event_id: id.nullable().optional(), completed_at: optionalDateTime,
  completion_reason: optionalText(4000), created_at: optionalDateTime, updated_at: optionalDateTime,
}).strict();

const interactionSchema = z.object({
  id, contact_id: id.nullable().optional(), interaction_date: optionalDateTime, type: optionalText(512), notes: optionalText(16000),
}).strict();
const statusHistorySchema = z.object({
  id, contact_id: id.nullable().optional(), old_status: optionalText(512), new_status: text(512), changed_at: optionalDateTime,
  changed_by: optionalText(512), notes: optionalText(16000),
}).strict();

const importSchema = z.object({
  schema: z.literal(ROUTE_SCHEMA), fixtureOnly: z.literal(true), sourceSystem: z.literal(SOURCE_SYSTEM),
  contacts: z.array(contactSchema).max(100), contact_log: z.array(contactLogSchema).max(100),
  followups: z.array(followupSchema).max(100), interactions: z.array(interactionSchema).max(100),
  status_history: z.array(statusHistorySchema).max(100), reviewedMappings: z.tuple([]),
}).strict().superRefine((value, ctx) => {
  const collections = [
    ["contacts", value.contacts], ["contact_log", value.contact_log], ["followups", value.followups],
    ["interactions", value.interactions], ["status_history", value.status_history],
  ] as const;
  if (collections.every(([, rows]) => rows.length === 0)) ctx.addIssue({ code: "custom", message: "Empty import", path: [] });
  if (collections.reduce((total, [, rows]) => total + rows.length, 0) > 50)
    ctx.addIssue({ code: "custom", message: "Import exceeds the 50-row synthetic batch limit", path: [] });
  for (const [table, rows] of collections) {
    const seen = new Set<number>();
    for (const [index, row] of rows.entries()) {
      if (seen.has(row.id)) ctx.addIssue({ code: "custom", message: "Duplicate source ID", path: [table, index, "id"] });
      seen.add(row.id);
    }
  }
});

type ImportRequest = z.infer<typeof importSchema>;
type CrmApp = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
type TableName = "crm_contacts" | "crm_contact_logs" | "crm_followups" | "crm_interactions" | "crm_status_history";
type SourceTable = "contacts" | "contact_log" | "followups" | "interactions" | "status_history";
type AnyRow = Record<string, string | number | boolean | null | undefined>;
type ExistingRow = { source_record_id: number; source_sha256: string };
type Counts = { contacts: number; contact_log: number; followups: number; interactions: number; status_history: number };

const tableNames: Record<SourceTable, TableName> = {
  contacts: "crm_contacts", contact_log: "crm_contact_logs", followups: "crm_followups",
  interactions: "crm_interactions", status_history: "crm_status_history",
};
const emptyCounts = (): Counts => ({ contacts: 0, contact_log: 0, followups: 0, interactions: 0, status_history: 0 });
const digest = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, "0")).join("");
};

function databaseRow(table: SourceTable, row: AnyRow): Record<string, unknown> {
  const common = { source_system: SOURCE_SYSTEM, source_table: table, source_record_id: row.id };
  if (table === "contacts") {
    const evidence = Object.fromEntries(Object.entries(row).filter(([key]) => cacheKeys.has(key) || key.startsWith("last_response_")));
    return { ...common, ...row, source_sha256: "", legacy_cache_evidence_json: Object.keys(evidence).length ? JSON.stringify(evidence) : null };
  }
  const contactIdentity = row.contact_id == null ? { contact_source_system: null, contact_source_table: null }
    : { contact_source_system: SOURCE_SYSTEM, contact_source_table: "contacts" };
  if (table === "contact_log") return { ...common, ...row, ...contactIdentity, source_sha256: "" };
  if (table === "followups") return { ...common, ...row, ...contactIdentity, source_sha256: "",
    origin_source_system: row.origin_event_id == null ? null : SOURCE_SYSTEM,
    origin_source_table: row.origin_event_id == null ? null : "contact_log" };
  if (table === "interactions") return { ...common, ...row, ...contactIdentity, source_sha256: "" };
  return { ...common, ...row, ...contactIdentity, source_sha256: "" };
}

function fieldEntries(table: SourceTable, row: Record<string, unknown>): [string, unknown][] {
  const fields: Record<SourceTable, string[]> = {
    contacts: ["source_system", "source_table", "source_record_id", "source_sha256", "import_batch_id", "company_name", "location", "contact_name", "email", "phone", "website", "has_website", "website_opportunity", "status", "contact_type", "sport", "priority", "contact_method", "notes", "outreach_paused", "skip_auto_research", "manual_contact_date", "manual_contact_notes", "legacy_cache_evidence_json", "created_at", "updated_at"],
    contact_log: ["source_system", "source_table", "source_record_id", "source_sha256", "import_batch_id", "contact_source_system", "contact_source_table", "contact_id", "log_date", "log_type", "direction", "subject", "notes", "source", "account", "external_message_id", "external_draft_id", "external_thread_id", "channel", "outcome", "occurred_at", "matched_email", "participant_role", "idempotency_key", "effects_mode", "created_at"],
    followups: ["source_system", "source_table", "source_record_id", "source_sha256", "import_batch_id", "contact_source_system", "contact_source_table", "contact_id", "follow_up_date", "method", "notes", "completed", "source", "action_kind", "responsibility", "origin_source_system", "origin_source_table", "origin_event_id", "completed_at", "completion_reason", "created_at", "updated_at"],
    interactions: ["source_system", "source_table", "source_record_id", "source_sha256", "import_batch_id", "contact_source_system", "contact_source_table", "contact_id", "interaction_date", "type", "notes"],
    status_history: ["source_system", "source_table", "source_record_id", "source_sha256", "import_batch_id", "contact_source_system", "contact_source_table", "contact_id", "old_status", "new_status", "changed_at", "changed_by", "notes"],
  };
  return fields[table].map(key => [key, row[key] ?? null]);
}

function inputRows(input: ImportRequest): Record<SourceTable, AnyRow[]> {
  return { contacts: input.contacts as AnyRow[], contact_log: input.contact_log as AnyRow[], followups: input.followups as AnyRow[],
    interactions: input.interactions as AnyRow[], status_history: input.status_history as AnyRow[] };
}

async function requireCrmOwner(env: Env, principal: StaffPrincipal): Promise<void> {
  const allowed = await hasPermission(env, principal, "crm.import.manage");
  if (!allowed) throw new HTTPException(403, { message: "crm_owner_required" });
  const owner = await env.OPS_DB.withSession("first-primary").prepare(`SELECT 1 ok FROM staff_users actor
    JOIN staff_role_assignments assignment ON assignment.staff_id=actor.id
      AND assignment.role_id='role-owner' AND assignment.scope='global'
    WHERE actor.id=? AND actor.status='active'` ).bind(principal.id).first();
  if (!owner) throw new HTTPException(403, { message: "crm_owner_required" });
}

function requireEnabled(env: Env): void {
  const environment = (env.ENVIRONMENT || "").toLowerCase();
  if (env.CRM_SYNTHETIC_IMPORT_ENABLED !== "true" || !["test", "local", "development"].includes(environment))
    throw new HTTPException(404, { message: "crm_synthetic_unavailable" });
}

async function shaRow(table: SourceTable, row: AnyRow): Promise<string> {
  return digest({ sourceSystem: SOURCE_SYSTEM, sourceTable: table, row });
}

async function readExisting(db: D1Database, table: SourceTable, ids: number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const sqlTable = tableNames[table];
  const rows = await db.prepare(`SELECT source_record_id,source_sha256 FROM ${sqlTable}
    WHERE source_system=? AND source_table=? AND source_record_id IN (${ids.map(() => "?").join(",")})`)
    .bind(SOURCE_SYSTEM, table, ...ids).all<ExistingRow>();
  return new Map(rows.results.map(row => [row.source_record_id, row.source_sha256]));
}

async function validateReferences(db: D1Database, rows: Record<SourceTable, AnyRow[]>): Promise<void> {
  const contacts = new Set(rows.contacts.map(row => Number(row.id)));
  const existingContacts = await readExisting(db, "contacts", [...new Set([
    ...rows.contact_log.map(row => Number(row.contact_id)), ...rows.followups.map(row => Number(row.contact_id)),
    ...rows.interactions.map(row => Number(row.contact_id)), ...rows.status_history.map(row => Number(row.contact_id)),
  ].filter(value => value > 0))]);
  for (const table of ["contact_log", "followups", "interactions", "status_history"] as const) {
    for (const row of rows[table]) if (row.contact_id != null
      && !contacts.has(Number(row.contact_id)) && !existingContacts.has(Number(row.contact_id)))
      throw new HTTPException(409, { message: "crm_source_reference_missing" });
  }
  const incomingLogs = new Map(rows.contact_log.map(row => [Number(row.id), row.contact_id == null ? null : Number(row.contact_id)]));
  const referencedLogIds = [...new Set(rows.followups.map(row => Number(row.origin_event_id)).filter(value => value > 0))];
  const existingLogs = new Map<number, number | null>();
  if (referencedLogIds.length) {
    const found = await db.prepare(`SELECT source_record_id,contact_id FROM crm_contact_logs
      WHERE source_system=? AND source_table='contact_log' AND source_record_id IN (${referencedLogIds.map(() => "?").join(",")})`)
      .bind(SOURCE_SYSTEM, ...referencedLogIds).all<{ source_record_id: number; contact_id: number | null }>();
    for (const log of found.results) existingLogs.set(log.source_record_id, log.contact_id);
  }
  for (const row of rows.followups) if (row.origin_event_id != null) {
    const logContact = incomingLogs.has(Number(row.origin_event_id)) ? incomingLogs.get(Number(row.origin_event_id))
      : existingLogs.get(Number(row.origin_event_id));
    if (logContact === undefined) throw new HTTPException(409, { message: "crm_source_reference_missing" });
    if (row.contact_id != null && logContact != null && Number(row.contact_id) !== logContact)
      throw new HTTPException(409, { message: "crm_source_reference_mismatch" });
  }
}

async function importRows(env: Env, principal: StaffPrincipal, input: ImportRequest, key: string) {
  const db = env.OPS_DB.withSession("first-primary");
  const allRows = inputRows(input);
  await validateReferences(db, allRows);
  const requestSha = await digest(input);
  const existingReceipt = await db.prepare(`SELECT request_sha256,receipt_json FROM crm_import_batches
    WHERE actor_id=? AND idempotency_key=?`).bind(principal.id, key).first<{ request_sha256: string; receipt_json: string }>();
  if (existingReceipt) {
    if (existingReceipt.request_sha256 !== requestSha) throw new HTTPException(409, { message: "crm_idempotency_conflict" });
    return { receipt: JSON.parse(existingReceipt.receipt_json), replayed: true };
  }

  const fresh: Record<SourceTable, { row: AnyRow; digest: string }[]> = {
    contacts: [], contact_log: [], followups: [], interactions: [], status_history: [],
  };
  const unchanged = emptyCounts();
  for (const table of Object.keys(allRows) as SourceTable[]) {
    const rows = allRows[table];
    const existing = await readExisting(db, table, rows.map(row => Number(row.id)));
    for (const row of rows) {
      const rowSha = await shaRow(table, row);
      const previous = existing.get(Number(row.id));
      if (previous && previous !== rowSha) throw new HTTPException(409, { message: "crm_source_identity_conflict" });
      if (previous) unchanged[table]++;
      else fresh[table].push({ row, digest: rowSha });
    }
  }

  const inserted = { contacts: fresh.contacts.length, contact_log: fresh.contact_log.length, followups: fresh.followups.length,
    interactions: fresh.interactions.length, status_history: fresh.status_history.length };
  const batchId = crypto.randomUUID();
  const receipt = { schema: "ops.crm.synthetic-import-receipt.v1", batchId, sourceSystem: SOURCE_SYSTEM,
    inputCounts: Object.fromEntries(Object.entries(allRows).map(([table, rows]) => [table, rows.length])), insertedCounts: inserted,
    unchangedCounts: unchanged };
  const stmts: D1PreparedStatement[] = [db.prepare(`INSERT INTO crm_import_batches(
      id,actor_id,source_system,source_schema_version,dataset_kind,idempotency_key,request_sha256,
      contacts_inserted,contact_logs_inserted,followups_inserted,interactions_inserted,status_history_inserted,state,receipt_json)
    VALUES(?,?,'hermes-crm-fixture','hermes-crm.v1','synthetic',?,?,?,?,?,?,?,'committing',?)`)
    .bind(batchId, principal.id, key, requestSha, inserted.contacts, inserted.contact_log, inserted.followups,
      inserted.interactions, inserted.status_history, JSON.stringify(receipt))];
  for (const table of Object.keys(fresh) as SourceTable[]) {
    for (const item of fresh[table]) {
      const shaped = databaseRow(table, item.row);
      shaped.source_sha256 = item.digest;
      shaped.import_batch_id = batchId;
      const fields = fieldEntries(table, shaped);
      stmts.push(db.prepare(`INSERT INTO ${tableNames[table]}(${fields.map(([field]) => field).join(",")})
        VALUES(${fields.map(() => "?").join(",")})`).bind(...fields.map(([, value]) => value)));
    }
  }
  stmts.push(db.prepare("UPDATE crm_import_batches SET state='committed' WHERE id=? AND state='committing'").bind(batchId));
  try {
    await db.batch(stmts);
  } catch (error) {
    const concurrentReceipt = await db.prepare(`SELECT request_sha256,receipt_json FROM crm_import_batches
      WHERE actor_id=? AND idempotency_key=?`).bind(principal.id, key).first<{ request_sha256: string; receipt_json: string }>();
    if (concurrentReceipt) {
      if (concurrentReceipt.request_sha256 !== requestSha) throw new HTTPException(409, { message: "crm_idempotency_conflict" });
      return { receipt: JSON.parse(concurrentReceipt.receipt_json), replayed: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/unique constraint|crm_import_owner_required|crm_import_batch_commit_invalid|foreign key constraint/i.test(message))
      throw new HTTPException(409, { message: "crm_import_conflict" });
    throw new HTTPException(503, { message: "crm_import_unavailable" });
  }
  return { receipt, replayed: false };
}

const readTables = {
  contacts: "crm_contacts", contact_log: "crm_contact_logs", followups: "crm_followups",
  interactions: "crm_interactions", status_history: "crm_status_history",
} as const;
type ReadKind = keyof typeof readTables;
const selectFields: Record<ReadKind, string> = {
  contacts: "source_system,source_table,source_record_id,company_name,location,contact_name,email,phone,website,has_website,website_opportunity,status,contact_type,sport,priority,contact_method,notes,outreach_paused,skip_auto_research,manual_contact_date,manual_contact_notes,legacy_cache_evidence_json,created_at,updated_at,imported_at",
  contact_log: "source_system,source_table,source_record_id,contact_id,log_date,log_type,direction,subject,notes,source,account,external_message_id,external_draft_id,external_thread_id,channel,outcome,occurred_at,matched_email,participant_role,idempotency_key,effects_mode,created_at,imported_at",
  followups: "source_system,source_table,source_record_id,contact_id,follow_up_date,method,notes,completed,source,action_kind,responsibility,origin_event_id,completed_at,completion_reason,created_at,updated_at,imported_at",
  interactions: "source_system,source_table,source_record_id,contact_id,interaction_date,type,notes,imported_at",
  status_history: "source_system,source_table,source_record_id,contact_id,old_status,new_status,changed_at,changed_by,notes,imported_at",
};

async function readRows(env: Env, principal: StaffPrincipal, kind: ReadKind, url: URL) {
  requireEnabled(env);
  await requireCrmOwner(env, principal);
  const limitValue = Number(url.searchParams.get("limit") ?? "50");
  const afterValue = url.searchParams.get("after");
  const contactValue = url.searchParams.get("contact_id");
  if (!Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100
    || url.searchParams.size > 2 || (afterValue !== null && (!/^\d+$/.test(afterValue) || Number(afterValue) < 1))
    || (afterValue !== null && !Number.isSafeInteger(Number(afterValue)))
    || (contactValue !== null && (!/^\d+$/.test(contactValue) || Number(contactValue) < 1 || !Number.isSafeInteger(Number(contactValue)))))
    throw new HTTPException(400, { message: "crm_query_invalid" });
  const table = readTables[kind];
  const where = ["source_system=?", "source_table=?", "EXISTS(SELECT 1 FROM crm_import_batches batch WHERE batch.id=" + table + ".import_batch_id AND batch.state='committed')"];
  const values: unknown[] = [SOURCE_SYSTEM, kind];
  if (afterValue !== null) { where.push("source_record_id>?"); values.push(Number(afterValue)); }
  if (contactValue !== null && kind !== "contacts") { where.push("contact_id=?"); values.push(Number(contactValue)); }
  const rows = await env.OPS_DB.withSession("first-primary").prepare(`SELECT ${selectFields[kind]} FROM ${table}
    WHERE ${where.join(" AND ")} ORDER BY source_record_id LIMIT ?`).bind(...values, limitValue + 1).all<Record<string, unknown>>();
  await requireCrmOwner(env, principal);
  const page = rows.results.slice(0, limitValue);
  return { items: page, page: { nextAfter: rows.results.length > limitValue ? page.at(-1)?.source_record_id ?? null : null } };
}

export function registerCrmSyntheticImportRoutes(app: CrmApp): void {
  app.post("/api/admin/crm/synthetic/import", async c => {
    requireEnabled(c.env);
    const principal = c.get("principal");
    await requireCrmOwner(c.env, principal);
    let parsed: unknown;
    try { parsed = await readBoundedJson(c.req.raw, MAX_BODY_BYTES, "CRM import"); }
    catch (error) {
      if (error instanceof HTTPException && error.status === 413)
        throw new HTTPException(413, { message: "crm_body_too_large" });
      if (error instanceof HTTPException) throw new HTTPException(400, { message: "crm_body_invalid" });
      throw error;
    }
    const result = importSchema.safeParse(parsed);
    if (!result.success) throw new HTTPException(400, { message: "crm_contract_invalid" });
    const key = c.req.header("Idempotency-Key") ?? "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new HTTPException(400, { message: "crm_idempotency_key_required" });
    const importResult = await importRows(c.env, principal, result.data, key);
    if (importResult.replayed) c.header("Idempotency-Replayed", "true");
    return c.json(importResult.receipt, importResult.replayed ? 200 : 201);
  });
  for (const kind of Object.keys(readTables) as ReadKind[]) {
    app.get(`/api/admin/crm/synthetic/${kind.replaceAll("_", "-")}`, async c => {
      const result = await readRows(c.env, c.get("principal"), kind, new URL(c.req.url));
      c.header("Cache-Control", "private, no-store");
      c.header("Pragma", "no-cache");
      return c.json({ schema: "ops.crm.synthetic-read.v1", sourceSystem: SOURCE_SYSTEM, ...result });
    });
  }
}
