import { parseClientOnboardingFields } from "@ltds/shared";

export type ClientOnboardingSubmissionReceipt = Readonly<{
  invitationId: string; submissionId: string; fieldsSha256: string; state: "submitted";
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const denied = (): never => { throw Error("client_onboarding_submission_denied"); };

function record(value: unknown, names: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    copy[name] = descriptor.value;
  }
  return copy;
}
async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function hashClientOnboardingInvitationSecret(invitationId: unknown,
  invitationSecret: unknown): Promise<string> {
  if (typeof invitationId !== "string" || !UUID.test(invitationId)
    || typeof invitationSecret !== "string" || !SECRET.test(invitationSecret)) return denied();
  return sha256(`client-onboarding-invitation-v1:${invitationId}:${invitationSecret}`);
}
function resultRows(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return denied();
  const success = Object.getOwnPropertyDescriptor(value, "success")?.value;
  const results = Object.getOwnPropertyDescriptor(value, "results")?.value;
  if (success !== true || !Array.isArray(results)
    || Object.getPrototypeOf(results) !== Array.prototype || results.length > 1) return denied();
  const rows: Record<string, unknown>[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const item = Object.getOwnPropertyDescriptor(results, String(index));
    if (!item?.enumerable || !("value" in item)) return denied();
    const row = record(item.value, ["invitation_id", "submission_id", "fields_sha256"]);
    if (!row) return denied();
    rows.push(row);
  }
  return rows;
}

/** Atomically writes one immutable proposal, or recovers only an exact retry. */
export async function submitClientOnboarding(database: D1Database,
  rawInput: unknown): Promise<ClientOnboardingSubmissionReceipt> {
  try {
    const request = record(rawInput, ["invitationId", "invitationSecret", "submissionId", "fields"]);
    if (!request || typeof request.invitationId !== "string" || !UUID.test(request.invitationId)
      || typeof request.invitationSecret !== "string" || !SECRET.test(request.invitationSecret)
      || typeof request.submissionId !== "string" || !UUID.test(request.submissionId)) return denied();
    const fields = parseClientOnboardingFields(request.fields);
    const fieldsJson = JSON.stringify(fields);
    if (encoder.encode(fieldsJson).byteLength > 8192) return denied();
    const invitationId = request.invitationId;
    const submissionId = request.submissionId;
    const [secretSha256, fieldsSha256] = await Promise.all([
      hashClientOnboardingInvitationSecret(invitationId, request.invitationSecret),
      sha256(`client-onboarding-fields-v1:${fieldsJson}`),
    ]);
    const db = database.withSession("first-primary");
    const batch: unknown = await db.batch([
      db.prepare(`INSERT INTO client_onboarding_submissions
        (invitation_id,submission_id,fields_json,fields_sha256)
        SELECT invitation.invitation_id,?,?,? FROM client_onboarding_invitations invitation
        JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
        WHERE invitation.invitation_id=? AND invitation.secret_sha256=?
          AND invitation.state='pending' AND invitation.version=1
          AND invitation.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND NOT EXISTS(SELECT 1 FROM client_onboarding_submissions prior
            WHERE prior.invitation_id=invitation.invitation_id)
        ON CONFLICT DO NOTHING`).bind(submissionId, fieldsJson, fieldsSha256, invitationId, secretSha256),
      db.prepare(`SELECT submission.invitation_id,submission.submission_id,submission.fields_sha256
        FROM client_onboarding_submissions submission
        JOIN client_onboarding_invitations invitation ON invitation.invitation_id=submission.invitation_id
        JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
        WHERE invitation.invitation_id=? AND invitation.secret_sha256=?
          AND invitation.state='submitted' AND invitation.version=2
          AND submission.submission_id=? AND submission.fields_sha256=? LIMIT 2`)
        .bind(invitationId, secretSha256, submissionId, fieldsSha256),
    ]);
    if (!Array.isArray(batch) || batch.length !== 2) return denied();
    const rows = resultRows(batch[1]);
    if (rows.length !== 1 || rows[0]!.invitation_id !== invitationId
      || rows[0]!.submission_id !== submissionId || rows[0]!.fields_sha256 !== fieldsSha256) return denied();
    return Object.freeze({ invitationId, submissionId, fieldsSha256, state: "submitted" });
  } catch { return denied(); }
}
