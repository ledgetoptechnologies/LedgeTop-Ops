import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

export type NativeWorkforceTimeRecordCommand = Readonly<{
  commandId: string;
  entryId: string;
  beneficiaryStaffId: string;
  workDate: string;
  durationMinutes: number;
  context: Readonly<{ kind: "internal"; id: null } | { kind: "native_project"; id: string }>;
  description: string;
  changeReason: string;
}>;

export type NativeWorkforceTimeRecordReceipt = Readonly<{
  commandId: string;
  entryId: string;
  revision: 1;
  beneficiaryStaffId: string;
  replayed: boolean;
  createdAt: string;
}>;

export class NativeWorkforceTimeRecordDenied extends Error {}
export class NativeWorkforceTimeRecordConflict extends Error {}
export class NativeWorkforceTimeRecordOutcomeUnknown extends Error {}

type ReceiptRow = { command_id: unknown; entry_id: unknown; revision: unknown;
  request_sha256: unknown; actor_staff_id: unknown; actor_access_subject: unknown;
  beneficiary_staff_id: unknown; created_at: unknown };

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function plain(value: unknown): value is Record<string, unknown> {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return false;
    return Reflect.ownKeys(value).every(key => typeof key === "string"
      && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && "value" in Object.getOwnPropertyDescriptor(value, key)!);
  } catch { return false; }
}

function snapshot(input: NativeWorkforceTimeRecordCommand): NativeWorkforceTimeRecordCommand {
  if (!plain(input) || Object.keys(input).sort().join(",")
    !== "beneficiaryStaffId,changeReason,commandId,context,description,durationMinutes,entryId,workDate"
    || typeof input.commandId !== "string" || !ID.test(input.commandId)
    || typeof input.entryId !== "string" || !ID.test(input.entryId)
    || typeof input.beneficiaryStaffId !== "string" || !ID.test(input.beneficiaryStaffId)
    || typeof input.workDate !== "string" || !DATE.test(input.workDate)
    || Number.isNaN(Date.parse(`${input.workDate}T00:00:00.000Z`))
    || typeof input.durationMinutes !== "number" || !Number.isSafeInteger(input.durationMinutes)
    || input.durationMinutes < 1 || input.durationMinutes > 1440
    || typeof input.description !== "string" || input.description.length > 4000 || input.description.includes("\0")
    || typeof input.changeReason !== "string" || input.changeReason.length < 1
    || input.changeReason.length > 500 || input.changeReason !== input.changeReason.trim()
    || input.changeReason.includes("\0") || !plain(input.context)) throw new NativeWorkforceTimeRecordDenied();
  const keys = Object.keys(input.context).sort().join(",");
  if (keys !== "id,kind" || (input.context.kind !== "internal" && input.context.kind !== "native_project")
    || (input.context.kind === "internal" && input.context.id !== null)
    || (input.context.kind === "native_project" && (typeof input.context.id !== "string" || !ID.test(input.context.id))))
    throw new NativeWorkforceTimeRecordDenied();
  return Object.freeze({ commandId: input.commandId, entryId: input.entryId,
    beneficiaryStaffId: input.beneficiaryStaffId, workDate: input.workDate,
    durationMinutes: input.durationMinutes,
    context: Object.freeze(input.context.kind === "internal" ? { kind: "internal", id: null }
      : { kind: "native_project", id: input.context.id }),
    description: input.description, changeReason: input.changeReason });
}

async function digest(command: NativeWorkforceTimeRecordCommand, actorStaffId: string,
  actorAccessSubject: string, admissionVersion: number): Promise<string> {
  const canonical = JSON.stringify(["native-workforce-time-record-v1", actorStaffId,
    actorAccessSubject, admissionVersion, command.commandId, command.entryId,
    command.beneficiaryStaffId, command.workDate, command.durationMinutes,
    command.context.kind, command.context.id, command.description, command.changeReason]);
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function validReceipt(row: ReceiptRow | null, hash: string,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, command: NativeWorkforceTimeRecordCommand): row is ReceiptRow & {
    command_id: string; entry_id: string; revision: 1; beneficiary_staff_id: string; created_at: string;
  } {
  return !!row && row.command_id === command.commandId && row.entry_id === command.entryId
    && row.revision === 1 && row.request_sha256 === hash
    && row.actor_staff_id === actor.identity.staffId
    && row.actor_access_subject === actor.identity.verifiedAccessSubject
    && row.beneficiary_staff_id === command.beneficiaryStaffId
    && typeof row.created_at === "string";
}

async function receipt(database: D1Database, actor: AuthenticatedNativeStaffWithAdmissionVersion,
  command: NativeWorkforceTimeRecordCommand, hash: string): Promise<NativeWorkforceTimeRecordReceipt | null> {
  const row = await database.withSession("first-primary").prepare(`SELECT command_id,entry_id,revision,
      request_sha256,actor_staff_id,actor_access_subject,beneficiary_staff_id,created_at
    FROM native_workforce_time_record_receipts WHERE command_id=?`).bind(command.commandId).first<ReceiptRow>();
  if (!row) return null;
  if (!validReceipt(row, hash, actor, command)) throw new NativeWorkforceTimeRecordConflict();
  return Object.freeze({ commandId: row.command_id, entryId: row.entry_id, revision: 1,
    beneficiaryStaffId: row.beneficiary_staff_id, replayed: true, createdAt: row.created_at });
}

const AUTHORITY = `
  actor.active=1 AND actor.bound_access_subject=? AND actor.version=? AND beneficiary.active=1
  AND EXISTS (SELECT 1 FROM native_workforce_authority_grants allow_grant
    WHERE allow_grant.staff_id=actor.staff_id AND allow_grant.contract_version=1
      AND allow_grant.capability=? AND allow_grant.effect='allow' AND allow_grant.active=1
      AND ((?='internal' AND allow_grant.scope_kind='internal') OR (?='project' AND (
        (allow_grant.scope_kind='native_project' AND allow_grant.native_project_id=?) OR
        (allow_grant.scope_kind='business_area' AND json_array_length(project.scopes_json)>0 AND NOT EXISTS (SELECT 1 FROM json_each(project.scopes_json) s
          WHERE json_extract(s.value,'$.businessAreaId')<>allow_grant.business_area_id)) OR
        (allow_grant.scope_kind='division' AND json_array_length(project.scopes_json)>0 AND NOT EXISTS (SELECT 1 FROM json_each(project.scopes_json) s
          WHERE json_extract(s.value,'$.businessAreaId')<>allow_grant.business_area_id
             OR json_extract(s.value,'$.divisionId')<>allow_grant.division_id))))))
  AND NOT EXISTS (SELECT 1 FROM native_workforce_authority_grants deny_grant
    WHERE deny_grant.staff_id=actor.staff_id AND deny_grant.contract_version=1
      AND deny_grant.capability=? AND deny_grant.effect='deny' AND deny_grant.active=1
      AND ((?='internal' AND deny_grant.scope_kind='internal') OR (?='project' AND (
        (deny_grant.scope_kind='native_project' AND deny_grant.native_project_id=?) OR
        (deny_grant.scope_kind='business_area' AND EXISTS (SELECT 1 FROM json_each(project.scopes_json) s
          WHERE json_extract(s.value,'$.businessAreaId')=deny_grant.business_area_id)) OR
        (deny_grant.scope_kind='division' AND EXISTS (SELECT 1 FROM json_each(project.scopes_json) s
          WHERE json_extract(s.value,'$.businessAreaId')=deny_grant.business_area_id
            AND json_extract(s.value,'$.divisionId')=deny_grant.division_id))))))
  AND (?='internal' OR (project.external_project_id=? AND project.lifecycle='active'
    AND json_valid(project.scopes_json) AND json_type(project.scopes_json)='array'))
  AND (actor.staff_id=beneficiary.staff_id OR (EXISTS (SELECT 1
      FROM native_workforce_time_beneficiary_selection_delegations selection
      WHERE selection.actor_staff_id=actor.staff_id AND selection.beneficiary_staff_id=beneficiary.staff_id
        AND selection.contract_version=1 AND selection.effect='allow' AND selection.active=1)
    AND NOT EXISTS (SELECT 1 FROM native_workforce_time_beneficiary_selection_delegations selection
      WHERE selection.actor_staff_id=actor.staff_id AND selection.beneficiary_staff_id=beneficiary.staff_id
        AND selection.contract_version=1 AND selection.effect='deny' AND selection.active=1)))`;

function authorityBinds(actor: AuthenticatedNativeStaffWithAdmissionVersion,
  capability: "time.record.self" | "time.record.on_behalf", contextKind: "internal" | "project",
  projectId: string | null): unknown[] {
  return [actor.identity.verifiedAccessSubject, actor.admissionVersion, capability,
    contextKind, contextKind, projectId, capability, contextKind, contextKind, projectId,
    contextKind, projectId];
}

async function requireCurrentAuthority(database: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, command: NativeWorkforceTimeRecordCommand,
  capability: "time.record.self" | "time.record.on_behalf", contextKind: "internal" | "project",
  projectId: string | null): Promise<void> {
  let authorized: unknown;
  try {
    authorized = await database.withSession("first-primary").prepare(`SELECT 1 authorized
      FROM native_staff_admissions actor
      JOIN native_staff_admissions beneficiary ON beneficiary.staff_id=?
      LEFT JOIN operations_shared_projects project ON project.external_project_id=?
      WHERE actor.staff_id=? AND ${AUTHORITY} LIMIT 1`).bind(command.beneficiaryStaffId,
        projectId, actor.identity.staffId, ...authorityBinds(actor, capability, contextKind, projectId)).first();
  } catch { throw new NativeWorkforceTimeRecordOutcomeUnknown(); }
  if (!authorized) throw new NativeWorkforceTimeRecordDenied();
}

/** Records revision one only. Every authorization predicate is repeated in the
 * same transactional D1 batch as the entry, command, and immutable receipt. */
export async function recordNativeWorkforceTime(database: D1Database,
  authenticated: AuthenticatedNativeStaffWithAdmissionVersion,
  input: NativeWorkforceTimeRecordCommand): Promise<NativeWorkforceTimeRecordReceipt> {
  const command = snapshot(input);
  const actor = Object.freeze({ identity: Object.freeze({ ...authenticated.identity }),
    admissionVersion: authenticated.admissionVersion, verifiedUntil: authenticated.verifiedUntil });
  if (!Number.isSafeInteger(actor.admissionVersion) || actor.admissionVersion < 1)
    throw new NativeWorkforceTimeRecordDenied();
  const hash = await digest(command, actor.identity.staffId,
    actor.identity.verifiedAccessSubject, actor.admissionVersion);
  const contextKind = command.context.kind === "native_project" ? "project" : "internal";
  const projectId = command.context.id;
  const capability = command.beneficiaryStaffId === actor.identity.staffId
    ? "time.record.self" : "time.record.on_behalf";
  // Replays and collisions are still protected reads. These read fences are
  // not a D1 transaction; the second check below is the replay disclosure
  // linearization point, while the mutation itself remains batch-atomic.
  await requireCurrentAuthority(database, actor, command, capability, contextKind, projectId);
  const existing = await receipt(database, actor, command, hash);
  if (existing) {
    await requireCurrentAuthority(database, actor, command, capability, contextKind, projectId);
    return existing;
  }
  try {
    const results = await database.batch([
      database.prepare(`INSERT INTO native_workforce_time_entries(entry_id,beneficiary_staff_id,
          recorded_by_staff_id,recorded_by_access_subject)
        SELECT ?,beneficiary.staff_id,actor.staff_id,?
        FROM native_staff_admissions actor
        JOIN native_staff_admissions beneficiary ON beneficiary.staff_id=?
        LEFT JOIN operations_shared_projects project ON project.external_project_id=?
        WHERE actor.staff_id=? AND ${AUTHORITY}`).bind(command.entryId,
          actor.identity.verifiedAccessSubject, command.beneficiaryStaffId, projectId,
          actor.identity.staffId, ...authorityBinds(actor, capability, contextKind, projectId)),
      database.prepare(`INSERT INTO native_workforce_time_revisions(entry_id,revision,work_date,
        duration_minutes,context_kind,context_id,description,change_reason) VALUES(?,1,?,?,?,?,?,?)`)
        .bind(command.entryId, command.workDate, command.durationMinutes, contextKind, projectId,
          command.description, command.changeReason),
      database.prepare(`INSERT INTO native_workforce_commands(command_id,command_kind,actor_staff_id,
        actor_access_subject,resource_kind,resource_id,request_sha256)
        VALUES(?,'time.record',?,?,'time_entry',?,?)`).bind(command.commandId,
          actor.identity.staffId, actor.identity.verifiedAccessSubject, command.entryId, hash),
      database.prepare(`INSERT INTO native_workforce_time_record_receipts(command_id,entry_id,revision,
        request_sha256,actor_staff_id,actor_access_subject,beneficiary_staff_id)
        VALUES(?,?,1,?,?,?,?)`).bind(command.commandId, command.entryId, hash,
          actor.identity.staffId, actor.identity.verifiedAccessSubject, command.beneficiaryStaffId),
    ]);
    if (results.some(result => result.success !== true)) throw new Error("incomplete_batch");
  } catch {
    try {
      await requireCurrentAuthority(database, actor, command, capability, contextKind, projectId);
      const recovered = await receipt(database, actor, command, hash);
      if (recovered) {
        await requireCurrentAuthority(database, actor, command, capability, contextKind, projectId);
        return recovered;
      }
      const collision = await database.withSession("first-primary").prepare(`SELECT 1 found
        FROM native_workforce_commands WHERE command_id=? UNION ALL SELECT 1
        FROM native_workforce_time_entries WHERE entry_id=? LIMIT 1`).bind(command.commandId, command.entryId).first();
      if (collision) throw new NativeWorkforceTimeRecordConflict();
    } catch (error) {
      if (error instanceof NativeWorkforceTimeRecordConflict || error instanceof NativeWorkforceTimeRecordDenied
        || error instanceof NativeWorkforceTimeRecordOutcomeUnknown) throw error;
      throw new NativeWorkforceTimeRecordOutcomeUnknown();
    }
    throw new NativeWorkforceTimeRecordDenied();
  }
  const committed = await receipt(database, actor, command, hash);
  if (!committed) throw new NativeWorkforceTimeRecordOutcomeUnknown();
  await requireCurrentAuthority(database, actor, command, capability, contextKind, projectId);
  return Object.freeze({ ...committed, replayed: false });
}
