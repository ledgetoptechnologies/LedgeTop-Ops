import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { NativeWorkforceTimeRecordConflict as Conflict, NativeWorkforceTimeRecordDenied as Denied,
  NativeWorkforceTimeRecordOutcomeUnknown as Unknown } from "./native-workforce-time-record";

export type TimeSubmitCommand = Readonly<{ commandId: string; entryId: string; expectedRevision: number }>;
export type TimeReviewCommand = Readonly<{ commandId: string; reviewId: string; entryId: string;
  expectedRevision: number; decision: "approved" | "returned"; reason: string }>;
export type TimeTransitionReceipt = Readonly<{ commandId: string; entryId: string; revision: number;
  action: "submitted" | "approved" | "returned"; replayed: boolean; createdAt: string }>;

const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).every(key =>
      typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true
      && "value" in Object.getOwnPropertyDescriptor(value, key)!);
}
function base(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!plain(value) || Object.keys(value).sort().join(",") !== keys.sort().join(",")
    || typeof value.commandId !== "string" || !ID.test(value.commandId)
    || typeof value.entryId !== "string" || !ID.test(value.entryId)
    || typeof value.expectedRevision !== "number" || !Number.isSafeInteger(value.expectedRevision)
    || value.expectedRevision < 1 || value.expectedRevision > Number.MAX_SAFE_INTEGER - 1) throw new Denied();
}
function submitInput(value: unknown): TimeSubmitCommand {
  base(value, ["commandId", "entryId", "expectedRevision"]);
  return Object.freeze({ commandId: value.commandId as string, entryId: value.entryId as string,
    expectedRevision: value.expectedRevision as number });
}
function reviewInput(value: unknown): TimeReviewCommand {
  base(value, ["commandId", "reviewId", "entryId", "expectedRevision", "decision", "reason"]);
  if (typeof value.reviewId !== "string" || !ID.test(value.reviewId)
    || (value.decision !== "approved" && value.decision !== "returned")
    || typeof value.reason !== "string" || value.reason.length < 1 || value.reason.length > 500
    || value.reason !== value.reason.trim() || value.reason.includes("\0")) throw new Denied();
  return Object.freeze({ commandId: value.commandId as string, reviewId: value.reviewId,
    entryId: value.entryId as string, expectedRevision: value.expectedRevision as number,
    decision: value.decision, reason: value.reason });
}
async function hash(parts: unknown[]): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify(["native-workforce-time-transition-v1", ...parts]))));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

const SCOPE = `EXISTS (SELECT 1 FROM native_workforce_authority_grants allow_grant
    WHERE allow_grant.staff_id=actor.staff_id AND allow_grant.contract_version=1
      AND allow_grant.capability=? AND allow_grant.effect='allow' AND allow_grant.active=1
      AND ((revision.context_kind='internal' AND allow_grant.scope_kind='internal')
        OR (revision.context_kind='project' AND ((allow_grant.scope_kind='native_project' AND allow_grant.native_project_id=revision.context_id)
          OR (allow_grant.scope_kind='business_area' AND json_array_length(project.scopes_json)>0 AND NOT EXISTS
            (SELECT 1 FROM json_each(project.scopes_json) s WHERE json_extract(s.value,'$.businessAreaId')<>allow_grant.business_area_id))
          OR (allow_grant.scope_kind='division' AND json_array_length(project.scopes_json)>0 AND NOT EXISTS
            (SELECT 1 FROM json_each(project.scopes_json) s WHERE json_extract(s.value,'$.businessAreaId')<>allow_grant.business_area_id
              OR json_extract(s.value,'$.divisionId')<>allow_grant.division_id))))))
  AND NOT EXISTS (SELECT 1 FROM native_workforce_authority_grants deny_grant
    WHERE deny_grant.staff_id=actor.staff_id AND deny_grant.contract_version=1
      AND deny_grant.capability=? AND deny_grant.effect='deny' AND deny_grant.active=1
      AND ((revision.context_kind='internal' AND deny_grant.scope_kind='internal')
        OR (revision.context_kind='project' AND ((deny_grant.scope_kind='native_project' AND deny_grant.native_project_id=revision.context_id)
          OR (deny_grant.scope_kind='business_area' AND EXISTS (SELECT 1 FROM json_each(project.scopes_json) s
            WHERE json_extract(s.value,'$.businessAreaId')=deny_grant.business_area_id))
          OR (deny_grant.scope_kind='division' AND EXISTS (SELECT 1 FROM json_each(project.scopes_json) s
            WHERE json_extract(s.value,'$.businessAreaId')=deny_grant.business_area_id
              AND json_extract(s.value,'$.divisionId')=deny_grant.division_id))))))
  AND (revision.context_kind='internal' OR (revision.context_kind='project' AND project.lifecycle='active'
    AND json_valid(project.scopes_json) AND json_type(project.scopes_json)='array'))`;

async function authorized(db: D1Database, auth: AuthenticatedNativeStaffWithAdmissionVersion,
  entryId: string, revisionNumber: number, capability: "time.submit" | "time.review",
  independent: boolean, requiredStatus: "draft" | "submitted" | "reviewed" | "returned" | "post_submit" | "any"): Promise<void> {
  let row;
  try { row = await db.withSession("first-primary").prepare(`SELECT 1 authorized
    FROM native_workforce_time_entries entry
    JOIN native_workforce_time_revisions revision ON revision.entry_id=entry.entry_id AND revision.revision=?
    JOIN native_staff_admissions actor ON actor.staff_id=? AND actor.active=1 AND actor.bound_access_subject=? AND actor.version=?
    JOIN native_staff_admissions beneficiary ON beneficiary.staff_id=entry.beneficiary_staff_id AND beneficiary.active=1
    LEFT JOIN operations_shared_projects project ON project.external_project_id=revision.context_id
    WHERE entry.entry_id=? AND entry.current_revision=? AND (?='any'
      OR ?='post_submit' AND entry.workflow_status IN ('submitted','reviewed','returned')
      OR entry.workflow_status=?)
      AND (?=0 AND actor.staff_id=entry.beneficiary_staff_id OR ?=1 AND actor.staff_id<>entry.beneficiary_staff_id)
      AND ${SCOPE} LIMIT 1`).bind(revisionNumber, auth.identity.staffId,
      auth.identity.verifiedAccessSubject, auth.admissionVersion, entryId, revisionNumber,
      requiredStatus, requiredStatus, requiredStatus,
      independent ? 1 : 0, independent ? 1 : 0, capability, capability).first(); }
  catch { throw new Unknown(); }
  if (!row) throw new Denied();
}

async function submitReceipt(db: D1Database, auth: AuthenticatedNativeStaffWithAdmissionVersion,
  input: TimeSubmitCommand, requestHash: string): Promise<TimeTransitionReceipt | null> {
  const row = await db.withSession("first-primary").prepare(`SELECT command_id,entry_id,revision,request_sha256,
    actor_staff_id,actor_access_subject,created_at FROM native_workforce_time_submit_receipts WHERE command_id=?`)
    .bind(input.commandId).first<Record<string, unknown>>();
  if (!row) return null;
  if (row.entry_id !== input.entryId || row.revision !== input.expectedRevision || row.request_sha256 !== requestHash
    || row.actor_staff_id !== auth.identity.staffId || row.actor_access_subject !== auth.identity.verifiedAccessSubject)
    throw new Conflict();
  return Object.freeze({ commandId: input.commandId, entryId: input.entryId, revision: input.expectedRevision,
    action: "submitted", replayed: true, createdAt: String(row.created_at) });
}

async function reviewReceipt(db: D1Database, auth: AuthenticatedNativeStaffWithAdmissionVersion,
  input: TimeReviewCommand, requestHash: string): Promise<TimeTransitionReceipt | null> {
  const row = await db.withSession("first-primary").prepare(`SELECT command_id,review_id,entry_id,revision,decision,
    request_sha256,actor_staff_id,actor_access_subject,created_at FROM native_workforce_time_review_receipts WHERE command_id=?`)
    .bind(input.commandId).first<Record<string, unknown>>();
  if (!row) return null;
  if (row.review_id !== input.reviewId || row.entry_id !== input.entryId || row.revision !== input.expectedRevision
    || row.decision !== input.decision || row.request_sha256 !== requestHash || row.actor_staff_id !== auth.identity.staffId
    || row.actor_access_subject !== auth.identity.verifiedAccessSubject) throw new Conflict();
  return Object.freeze({ commandId: input.commandId, entryId: input.entryId, revision: input.expectedRevision,
    action: input.decision, replayed: true, createdAt: String(row.created_at) });
}

export async function submitNativeWorkforceTime(db: D1Database,
  auth: AuthenticatedNativeStaffWithAdmissionVersion, value: unknown): Promise<TimeTransitionReceipt> {
  const input = submitInput(value), requestHash = await hash([auth.identity.staffId,
    auth.identity.verifiedAccessSubject, auth.admissionVersion, input.commandId, input.entryId, input.expectedRevision]);
  // A completed receipt is readable only while the same scoped submit authority remains current.
  let hasPrior: unknown;
  try { hasPrior = await db.withSession("first-primary").prepare(
    "SELECT 1 found FROM native_workforce_time_submit_receipts WHERE command_id=?").bind(input.commandId).first(); }
  catch { throw new Unknown(); }
  await authorized(db, auth, input.entryId, input.expectedRevision, "time.submit", false, hasPrior ? "post_submit" : "draft");
  const prior = await submitReceipt(db, auth, input, requestHash);
  if (prior) {
    await authorized(db, auth, input.entryId, input.expectedRevision, "time.submit", false, "post_submit");
    return prior;
  }
  try {
    await db.batch([
      db.prepare(`INSERT INTO native_workforce_time_submissions(entry_id,revision,submitted_by_staff_id,submitted_by_access_subject)
        SELECT entry.entry_id,revision.revision,actor.staff_id,?
        FROM native_workforce_time_entries entry JOIN native_workforce_time_revisions revision
          ON revision.entry_id=entry.entry_id AND revision.revision=?
        JOIN native_staff_admissions actor ON actor.staff_id=? AND actor.active=1 AND actor.bound_access_subject=? AND actor.version=?
        JOIN native_staff_admissions beneficiary ON beneficiary.staff_id=entry.beneficiary_staff_id AND beneficiary.active=1
        LEFT JOIN operations_shared_projects project ON project.external_project_id=revision.context_id
        WHERE entry.entry_id=? AND entry.current_revision=? AND entry.workflow_status='draft'
          AND actor.staff_id=entry.beneficiary_staff_id AND ${SCOPE}`).bind(auth.identity.verifiedAccessSubject,
          input.expectedRevision, auth.identity.staffId, auth.identity.verifiedAccessSubject, auth.admissionVersion,
          input.entryId, input.expectedRevision, "time.submit", "time.submit"),
      db.prepare(`INSERT INTO native_workforce_commands(command_id,command_kind,actor_staff_id,actor_access_subject,
        resource_kind,resource_id,request_sha256) VALUES(?,'time.submit',?,?,'time_entry',?,?)`)
        .bind(input.commandId, auth.identity.staffId, auth.identity.verifiedAccessSubject, input.entryId, requestHash),
      db.prepare(`INSERT INTO native_workforce_time_submit_receipts(command_id,entry_id,revision,request_sha256,
        actor_staff_id,actor_access_subject,beneficiary_staff_id) SELECT ?,?,?,?, ?,?,entry.beneficiary_staff_id
        FROM native_workforce_time_entries entry WHERE entry.entry_id=?`).bind(input.commandId, input.entryId,
          input.expectedRevision, requestHash, auth.identity.staffId, auth.identity.verifiedAccessSubject, input.entryId),
    ]);
  } catch {
    try {
      await authorized(db, auth, input.entryId, input.expectedRevision, "time.submit", false, "any");
      const recovered = await submitReceipt(db, auth, input, requestHash);
      if (recovered) { await authorized(db, auth, input.entryId, input.expectedRevision, "time.submit", false, "post_submit"); return recovered; }
      const collision = await db.withSession("first-primary").prepare(`SELECT 1 found FROM native_workforce_commands WHERE command_id=?
        UNION ALL SELECT 1 FROM native_workforce_time_submissions WHERE entry_id=? AND revision=? LIMIT 1`)
        .bind(input.commandId, input.entryId, input.expectedRevision).first();
      if (collision) throw new Conflict();
      throw new Denied();
    } catch (error) {
      if (error instanceof Denied || error instanceof Conflict || error instanceof Unknown) throw error;
      throw new Unknown();
    }
  }
  const committed = await submitReceipt(db, auth, input, requestHash);
  if (!committed) throw new Unknown();
  await authorized(db, auth, input.entryId, input.expectedRevision, "time.submit", false, "submitted");
  return Object.freeze({ ...committed, replayed: false });
}

export async function reviewNativeWorkforceTime(db: D1Database,
  auth: AuthenticatedNativeStaffWithAdmissionVersion, value: unknown): Promise<TimeTransitionReceipt> {
  const input = reviewInput(value), finalStatus = input.decision === "approved" ? "reviewed" : "returned";
  const requestHash = await hash([auth.identity.staffId, auth.identity.verifiedAccessSubject, auth.admissionVersion,
    input.commandId, input.reviewId, input.entryId, input.expectedRevision, input.decision, input.reason]);
  let hasPrior: unknown;
  try { hasPrior = await db.withSession("first-primary").prepare(
    "SELECT 1 found FROM native_workforce_time_review_receipts WHERE command_id=?").bind(input.commandId).first(); }
  catch { throw new Unknown(); }
  await authorized(db, auth, input.entryId, input.expectedRevision, "time.review", true, hasPrior ? finalStatus : "submitted");
  const prior = await reviewReceipt(db, auth, input, requestHash);
  if (prior) {
    await authorized(db, auth, input.entryId, input.expectedRevision, "time.review", true, finalStatus);
    return prior;
  }
  try {
    await db.batch([
      db.prepare(`INSERT INTO native_workforce_time_reviews(review_id,entry_id,revision,reviewer_staff_id,
        reviewer_access_subject,decision,reason) SELECT ?,entry.entry_id,revision.revision,actor.staff_id,?,?,?
        FROM native_workforce_time_entries entry JOIN native_workforce_time_revisions revision
          ON revision.entry_id=entry.entry_id AND revision.revision=?
        JOIN native_staff_admissions actor ON actor.staff_id=? AND actor.active=1 AND actor.bound_access_subject=? AND actor.version=?
        JOIN native_staff_admissions beneficiary ON beneficiary.staff_id=entry.beneficiary_staff_id AND beneficiary.active=1
        LEFT JOIN operations_shared_projects project ON project.external_project_id=revision.context_id
        WHERE entry.entry_id=? AND entry.current_revision=? AND entry.workflow_status='submitted'
          AND actor.staff_id<>entry.beneficiary_staff_id AND ${SCOPE}`).bind(input.reviewId,
          auth.identity.verifiedAccessSubject, input.decision, input.reason, input.expectedRevision,
          auth.identity.staffId, auth.identity.verifiedAccessSubject, auth.admissionVersion, input.entryId,
          input.expectedRevision, "time.review", "time.review"),
      db.prepare(`INSERT INTO native_workforce_commands(command_id,command_kind,actor_staff_id,actor_access_subject,
        resource_kind,resource_id,request_sha256) VALUES(?,'time.review',?,?,'time_entry',?,?)`)
        .bind(input.commandId, auth.identity.staffId, auth.identity.verifiedAccessSubject, input.entryId, requestHash),
      db.prepare(`INSERT INTO native_workforce_time_review_receipts(command_id,review_id,entry_id,revision,decision,
        request_sha256,actor_staff_id,actor_access_subject,beneficiary_staff_id)
        SELECT ?,?,?,?,?,?,?,?,entry.beneficiary_staff_id FROM native_workforce_time_entries entry WHERE entry.entry_id=?`)
        .bind(input.commandId, input.reviewId, input.entryId, input.expectedRevision, input.decision, requestHash,
          auth.identity.staffId, auth.identity.verifiedAccessSubject, input.entryId),
    ]);
  } catch {
    try {
      await authorized(db, auth, input.entryId, input.expectedRevision, "time.review", true, "any");
      const recovered = await reviewReceipt(db, auth, input, requestHash);
      if (recovered) { await authorized(db, auth, input.entryId, input.expectedRevision, "time.review", true, finalStatus); return recovered; }
      const collision = await db.withSession("first-primary").prepare(`SELECT 1 found FROM native_workforce_commands WHERE command_id=?
        UNION ALL SELECT 1 FROM native_workforce_time_reviews WHERE review_id=? OR (entry_id=? AND revision=?) LIMIT 1`)
        .bind(input.commandId, input.reviewId, input.entryId, input.expectedRevision).first();
      if (collision) throw new Conflict();
      throw new Denied();
    } catch (error) {
      if (error instanceof Denied || error instanceof Conflict || error instanceof Unknown) throw error;
      throw new Unknown();
    }
  }
  const committed = await reviewReceipt(db, auth, input, requestHash);
  if (!committed) throw new Unknown();
  await authorized(db, auth, input.entryId, input.expectedRevision, "time.review", true, finalStatus);
  return Object.freeze({ ...committed, replayed: false });
}
