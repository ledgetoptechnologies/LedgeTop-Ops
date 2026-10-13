import { hashClientOnboardingInvitationSecret } from "./client-onboarding-submissions";
import { isNativeAccessSubject } from "./native-access-subject";
import type { AuthenticatedNativeStaff } from "./native-staff-auth";

export type ClientOnboardingProposedScope = Readonly<{ businessAreaId: string; divisionId: string | null }>;
export type ClientOnboardingIssuanceReceipt = Readonly<{
  invitationId: string; expiresAt: string; requestSha256: string; state: "pending" | "submitted";
}>;
export type ClientOnboardingEncryptedHandoff = Readonly<{
  keyId: string; nonceHex: string; ciphertextHex: string; aadSha256: string;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const HEX = /^[0-9a-f]+$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const encoder = new TextEncoder();
const MAX_INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const denied = (): never => { throw Error("client_onboarding_issuance_denied"); };
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
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function dense(value: unknown): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 128
    || Reflect.ownKeys(value).length !== value.length + 1) return null;
  return value.map((_, index) => Object.getOwnPropertyDescriptor(value, String(index))?.value);
}
async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
async function evidence(raw: unknown) {
  const envelope = record(raw, ["authenticatedNativeStaff", "request"]);
  const auth = envelope && record(envelope.authenticatedNativeStaff, ["identity", "verifiedUntil"]);
  const actor = auth && record(auth.identity,
    ["kind", "staffId", "verifiedAccessSubject", "email", "displayName", "profileVersion"]);
  const request = envelope && record(envelope.request,
    ["commandId", "invitationId", "invitationSecret", "expiresAt", "targetClientRecordId", "scopes"]);
  if (!auth || !actor || !request || actor.kind !== "native" || typeof actor.staffId !== "string" || !ID.test(actor.staffId)
    || !isNativeAccessSubject(actor.verifiedAccessSubject) || typeof actor.email !== "string"
    || actor.email !== actor.email.trim().toLowerCase() || actor.email.length < 3 || actor.email.length > 254
    || typeof actor.profileVersion !== "number" || !Number.isSafeInteger(actor.profileVersion) || actor.profileVersion < 1
    || !instant(auth.verifiedUntil) || Date.parse(auth.verifiedUntil) <= Date.now()
    || typeof request.commandId !== "string" || !UUID.test(request.commandId)
    || typeof request.invitationId !== "string" || !UUID.test(request.invitationId)
    || typeof request.invitationSecret !== "string" || !SECRET.test(request.invitationSecret)
    || !instant(request.expiresAt) || Date.parse(request.expiresAt) <= Date.now()
    || Date.parse(request.expiresAt) > Date.now() + MAX_INVITATION_LIFETIME_MS
    || (request.targetClientRecordId !== null && (typeof request.targetClientRecordId !== "string" || !ID.test(request.targetClientRecordId)))) return denied();
  let scopes: ClientOnboardingProposedScope[] | null = null;
  if (request.targetClientRecordId === null) {
    const rawScopes = dense(request.scopes);
    if (!rawScopes?.length) return denied();
    scopes = rawScopes.map(item => {
      const row = record(item, ["businessAreaId", "divisionId"]);
      if (!row || typeof row.businessAreaId !== "string" || !ID.test(row.businessAreaId)
        || (row.divisionId !== null && (typeof row.divisionId !== "string" || !ID.test(row.divisionId)))) return denied();
      return { businessAreaId: row.businessAreaId, divisionId: row.divisionId as string | null };
    });
    if (new Set(scopes.map(scope => `${scope.businessAreaId}\0${scope.divisionId ?? ""}`)).size !== scopes.length) return denied();
    scopes.sort((a, b) => `${a.businessAreaId}\0${a.divisionId ?? ""}`.localeCompare(`${b.businessAreaId}\0${b.divisionId ?? ""}`));
  } else if (request.scopes !== null) return denied();
  const scopesJson = scopes === null ? null : JSON.stringify(scopes);
  if (scopesJson && encoder.encode(scopesJson).byteLength > 8192) return denied();
  const input = { staffId: actor.staffId, subject: actor.verifiedAccessSubject, email: actor.email,
    profileVersion: actor.profileVersion, verifiedUntil: auth.verifiedUntil, commandId: request.commandId,
    invitationId: request.invitationId, invitationSecret: request.invitationSecret, expiresAt: request.expiresAt,
    targetClientRecordId: request.targetClientRecordId, scopesJson } as const;
  const [secretSha256, requestSha256] = await Promise.all([
    hashClientOnboardingInvitationSecret(input.invitationId, input.invitationSecret),
    sha256(`client-onboarding-issue-v1:${JSON.stringify({ commandId: input.commandId,
      invitationId: input.invitationId, expiresAt: input.expiresAt, targetClientRecordId: input.targetClientRecordId,
      scopesJson: input.scopesJson, staffId: input.staffId, subject: input.subject })}`),
  ]);
  return { input, secretSha256, requestSha256 };
}
function handoff(value: unknown): ClientOnboardingEncryptedHandoff | null {
  const row = record(value, ["keyId", "nonceHex", "ciphertextHex", "aadSha256"]);
  if (!row || typeof row.keyId !== "string" || !KEY_ID.test(row.keyId)
    || typeof row.nonceHex !== "string" || row.nonceHex.length !== 24 || !HEX.test(row.nonceHex)
    || typeof row.ciphertextHex !== "string" || row.ciphertextHex.length !== 160 || !HEX.test(row.ciphertextHex)
    || typeof row.aadSha256 !== "string" || row.aadSha256.length !== 64 || !HEX.test(row.aadSha256)) return null;
  return row as ClientOnboardingEncryptedHandoff;
}
export async function clientOnboardingIssuanceEvidence(raw: unknown) {
  try {
    const { input, secretSha256, requestSha256 } = await evidence(raw);
    return Object.freeze({ commandId: input.commandId, invitationId: input.invitationId,
      staffId: input.staffId, subject: input.subject, expiresAt: input.expiresAt,
      targetClientRecordId: input.targetClientRecordId, scopesJson: input.scopesJson,
      secretSha256, requestSha256 });
  } catch { return denied(); }
}
export async function issueClientOnboardingInvitation(database: D1Database, raw: unknown,
  encrypted?: ClientOnboardingEncryptedHandoff): Promise<ClientOnboardingIssuanceReceipt> {
  try {
    const { input, secretSha256, requestSha256 } = await evidence(raw);
    const encryptedRow = encrypted === undefined ? null : handoff(encrypted);
    if (encrypted !== undefined && !encryptedRow) return denied();
    const db = database.withSession("first-primary");
    const statements = [
      db.prepare(`INSERT INTO client_onboarding_invitations
        (invitation_id,secret_sha256,issued_by,bound_access_subject,expires_at,target_client_record_id,state,version)
        SELECT ?,?,?,?,?,?,'pending',1 WHERE ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND NOT EXISTS(SELECT 1 FROM client_onboarding_invitations WHERE invitation_id=?)`)
        .bind(input.invitationId, secretSha256, input.staffId, input.subject, input.expiresAt,
          input.targetClientRecordId, input.verifiedUntil, input.invitationId),
      db.prepare(`INSERT INTO client_onboarding_issuance_commands
        (invitation_id,command_id,request_sha256,scopes_json,issuer_admission_version,issuer_profile_version,issuer_email,verified_until)
        SELECT invitation_id,?,?,?,(SELECT version FROM native_staff_admissions WHERE staff_id=issued_by),?,?,?
        FROM client_onboarding_invitations WHERE invitation_id=? AND changes()=1`)
        .bind(input.commandId, requestSha256, input.scopesJson, input.profileVersion, input.email,
          input.verifiedUntil, input.invitationId),
    ];
    if (encryptedRow) statements.push(db.prepare(`INSERT INTO client_onboarding_handoffs
      (command_id,invitation_id,actor_staff_id,actor_access_subject,request_sha256,secret_sha256,
       expires_at,key_id,nonce_hex,ciphertext_hex,aad_sha256)
       SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(
         SELECT 1 FROM client_onboarding_handoffs WHERE command_id=? AND invitation_id=?
           AND request_sha256=? AND secret_sha256=? AND key_id=? AND nonce_hex=?
           AND ciphertext_hex=? AND aad_sha256=?)`)
      .bind(input.commandId, input.invitationId, input.staffId, input.subject, requestSha256, secretSha256,
        input.expiresAt, encryptedRow.keyId, encryptedRow.nonceHex, encryptedRow.ciphertextHex, encryptedRow.aadSha256,
        input.commandId, input.invitationId, requestSha256, secretSha256, encryptedRow.keyId,
        encryptedRow.nonceHex, encryptedRow.ciphertextHex, encryptedRow.aadSha256));
    statements.push(db.prepare(`SELECT invitation.invitation_id,invitation.expires_at,command.request_sha256,invitation.state
      FROM client_onboarding_invitations invitation
      JOIN client_onboarding_issuance_commands command ON command.invitation_id=invitation.invitation_id
      JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
      WHERE command.command_id=? AND command.request_sha256=? AND invitation.secret_sha256=?
        ${encryptedRow ? "AND EXISTS(SELECT 1 FROM client_onboarding_handoffs h WHERE h.command_id=command.command_id)" : ""}`)
      .bind(input.commandId, requestSha256, secretSha256));
    const results = await db.batch(statements);
    const row = results.at(-1)?.results?.[0] as Record<string, unknown> | undefined;
    if (!row || row.invitation_id !== input.invitationId || row.expires_at !== input.expiresAt
      || row.request_sha256 !== requestSha256 || (row.state !== "pending" && row.state !== "submitted")) return denied();
    return Object.freeze({ invitationId: input.invitationId, expiresAt: input.expiresAt,
      requestSha256, state: row.state });
  } catch { return denied(); }
}
