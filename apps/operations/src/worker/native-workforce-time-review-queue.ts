import { Buffer } from "node:buffer";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { NativeWorkforceTimeRecordDenied as Denied,
  NativeWorkforceTimeRecordOutcomeUnknown as Unknown } from "./native-workforce-time-record";
import { NATIVE_WORKFORCE_TIME_SCOPE_SQL } from "./native-workforce-time-transitions";

export type NativeWorkforceTimeReviewQueueItem = Readonly<{
  entryId: string; revision: number; beneficiaryStaffId: string; workDate: string;
  durationMinutes: number; context: Readonly<{ kind: "internal"; id: null } | { kind: "native_project"; id: string }>;
}>;
export type NativeWorkforceTimeReviewQueuePage = Readonly<{
  items: readonly NativeWorkforceTimeReviewQueueItem[]; nextCursor: string | null; limit: number;
}>;

type Cursor = Readonly<{ v: 1; after: readonly [string, string] }>;
type Row = { entry_id: unknown; revision: unknown; beneficiary_staff_id: unknown; work_date: unknown;
  duration_minutes: unknown; context_kind: unknown; context_id: unknown; attested_at: unknown };
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

async function cursorKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([
    "native-workforce-time-review-queue-cursor-key-v1", secret])));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encode(secret: string, auth: AuthenticatedNativeStaffWithAdmissionVersion, cursor: Cursor): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(JSON.stringify(["native-workforce-time-review-queue-cursor-aad-v1",
    auth.identity.staffId, auth.identity.verifiedAccessSubject, auth.admissionVersion]));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad },
    await cursorKey(secret), new TextEncoder().encode(JSON.stringify(cursor)));
  return `${Buffer.from(nonce).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`;
}

async function decode(secret: string, token: string, auth: AuthenticatedNativeStaffWithAdmissionVersion): Promise<Cursor> {
  try {
    if (token.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw Error();
    const [nonceToken, encryptedToken] = token.split(".") as [string, string];
    const nonce = Buffer.from(nonceToken, "base64url"), encrypted = Buffer.from(encryptedToken, "base64url");
    if (nonce.length !== 12 || encrypted.length < 17) throw Error();
    const aad = new TextEncoder().encode(JSON.stringify(["native-workforce-time-review-queue-cursor-aad-v1",
      auth.identity.staffId, auth.identity.verifiedAccessSubject, auth.admissionVersion]));
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: aad },
      await cursorKey(secret), encrypted);
    const value = JSON.parse(new TextDecoder().decode(plaintext)) as Cursor;
    if (value.v !== 1 || Object.keys(value).sort().join(",") !== "after,v"
      || !Array.isArray(value.after) || value.after.length !== 2 || !ISO.test(value.after[0]) || !ID.test(value.after[1])) throw Error();
    return value;
  } catch { throw new Denied(); }
}

export async function listNativeWorkforceTimeReviewQueue(database: D1Database,
  auth: AuthenticatedNativeStaffWithAdmissionVersion, secret: string,
  input: Readonly<{ limit?: number; cursor?: string }> = {}): Promise<NativeWorkforceTimeReviewQueuePage> {
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25 || secret.length < 32) throw new Denied();
  const cursor = input.cursor ? await decode(secret, input.cursor, auth) : null;
  let rows: Row[];
  try {
    rows = (await database.withSession("first-primary").prepare(`SELECT entry.entry_id,revision.revision,
        entry.beneficiary_staff_id,revision.work_date,revision.duration_minutes,revision.context_kind,
        revision.context_id,submission.attested_at
      FROM native_workforce_time_entries entry
      JOIN native_workforce_time_revisions revision ON revision.entry_id=entry.entry_id AND revision.revision=entry.current_revision
      JOIN native_workforce_time_submissions submission ON submission.entry_id=entry.entry_id AND submission.revision=revision.revision
      JOIN native_staff_admissions actor ON actor.staff_id=? AND actor.active=1 AND actor.bound_access_subject=? AND actor.version=?
      JOIN native_staff_admissions beneficiary ON beneficiary.staff_id=entry.beneficiary_staff_id AND beneficiary.active=1
      LEFT JOIN operations_shared_projects project ON project.external_project_id=revision.context_id
      WHERE entry.workflow_status='submitted' AND actor.staff_id<>entry.beneficiary_staff_id
        AND (revision.context_kind='internal' OR (revision.context_kind='project' AND project.lifecycle='active'
          AND json_valid(project.scopes_json) AND json_type(project.scopes_json)='array'))
        AND ${NATIVE_WORKFORCE_TIME_SCOPE_SQL}
        AND (? IS NULL OR submission.attested_at>? OR (submission.attested_at=? AND entry.entry_id>?))
      ORDER BY submission.attested_at,entry.entry_id LIMIT ?`).bind(auth.identity.staffId,
        auth.identity.verifiedAccessSubject, auth.admissionVersion, "time.review", "time.review", cursor?.after[0] ?? null,
        cursor?.after[0] ?? "", cursor?.after[0] ?? "", cursor?.after[1] ?? "", limit + 1).all<Row>()).results;
  } catch { throw new Unknown(); }
  const selected = rows.slice(0, limit);
  const items = selected.map(row => {
    if (typeof row.entry_id !== "string" || !ID.test(row.entry_id) || !Number.isSafeInteger(row.revision)
      || typeof row.beneficiary_staff_id !== "string" || !ID.test(row.beneficiary_staff_id)
      || typeof row.work_date !== "string" || typeof row.duration_minutes !== "number"
      || typeof row.attested_at !== "string" || !ISO.test(row.attested_at)
      || (row.context_kind !== "internal" && row.context_kind !== "project")
      || (row.context_kind === "internal" ? row.context_id !== null : typeof row.context_id !== "string")) throw new Unknown();
    return Object.freeze({ entryId: row.entry_id, revision: row.revision as number,
      beneficiaryStaffId: row.beneficiary_staff_id, workDate: row.work_date,
      durationMinutes: row.duration_minutes, context: Object.freeze(row.context_kind === "internal"
        ? { kind: "internal" as const, id: null } : { kind: "native_project" as const, id: row.context_id as string }) });
  });
  const last = selected.at(-1);
  const nextCursor = rows.length > limit && last && typeof last.attested_at === "string" && ISO.test(last.attested_at)
    ? await encode(secret, auth, { v: 1, after: [last.attested_at, last.entry_id as string] }) : null;
  return Object.freeze({ items: Object.freeze(items), nextCursor, limit });
}
