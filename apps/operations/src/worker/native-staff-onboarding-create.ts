import { Buffer } from "node:buffer";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { isNativeAccessSubject } from "./native-access-subject";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/u;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/u;
const HEX = /^[0-9a-f]+$/u;
const encoder = new TextEncoder();
const denied = (): never => { throw new Error("native_staff_onboarding_create_denied"); };

export type NativeStaffHandoffKeyring = Readonly<{ activeKeyId: string; keys: Readonly<Record<string, string>> }>;
export type NativeStaffOnboardingCreateReceipt = Readonly<{
  commandId: string; onboardingId: string; proposedStaffId: string; resultVersion: 1; replayed: boolean;
  state: "pending" | "claimed" | "approved" | "cancelled" | "expired";
}>;
export type NativeStaffOnboardingRevelation = Readonly<{
  commandId: string; onboardingId: string; proposedStaffId: string; expiresAt: string; invitationSecret: string;
}>;

function record(value: unknown, names: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const own = Reflect.ownKeys(value);
  if (own.length !== names.length || own.some(key => typeof key !== "string" || !names.includes(key))) return null;
  const output: Record<string, unknown> = Object.create(null);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    output[name] = descriptor.value;
  }
  return output;
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)) return false;
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
async function sha256(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(value))).toString("hex");
}
export function snapshotNativeStaffHandoffKeyring(value: unknown): NativeStaffHandoffKeyring {
  const ring = record(value, ["activeKeyId", "keys"]);
  if (!ring || typeof ring.activeKeyId !== "string" || !KEY_ID.test(ring.activeKeyId)
    || !ring.keys || typeof ring.keys !== "object" || Array.isArray(ring.keys)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(ring.keys))) throw Error("native_staff_handoff_keyring_unavailable");
  const names = Reflect.ownKeys(ring.keys);
  if (names.length < 1 || names.length > 8) throw Error("native_staff_handoff_keyring_unavailable");
  const keys: Record<string, string> = Object.create(null);
  for (const name of names) {
    if (typeof name !== "string" || !KEY_ID.test(name)) throw Error("native_staff_handoff_keyring_unavailable");
    const descriptor = Object.getOwnPropertyDescriptor(ring.keys, name);
    if (!descriptor?.enumerable || !("value" in descriptor) || !HEX.test(String(descriptor.value)) || String(descriptor.value).length !== 64)
      throw Error("native_staff_handoff_keyring_unavailable");
    keys[name] = descriptor.value as string;
  }
  if (!Object.hasOwn(keys, ring.activeKeyId)) throw Error("native_staff_handoff_keyring_unavailable");
  return Object.freeze({ activeKeyId: ring.activeKeyId, keys: Object.freeze(keys) });
}
async function aesKey(id: string, ring: NativeStaffHandoffKeyring, usage: KeyUsage): Promise<CryptoKey> {
  const hex = ring.keys[id];
  if (!hex || hex.length !== 64 || !HEX.test(hex)) throw Error();
  return crypto.subtle.importKey("raw", Buffer.from(hex, "hex"), "AES-GCM", false, [usage]);
}
function aad(commandId: string, onboardingId: string, staffId: string, actorId: string, subject: string, requestHash: string): string {
  return JSON.stringify(["native-staff-onboarding-handoff-v1", commandId, onboardingId, staffId, actorId, subject, requestHash]);
}
function actor(value: unknown): AuthenticatedNativeStaffWithAdmissionVersion | null {
  const row = record(value, ["identity", "admissionVersion", "verifiedUntil"]);
  const identity = row && record(row.identity, ["kind", "staffId", "verifiedAccessSubject", "email", "displayName", "profileVersion"]);
  if (!row || !identity || identity.kind !== "native" || typeof identity.staffId !== "string" || !ID.test(identity.staffId)
    || !isNativeAccessSubject(identity.verifiedAccessSubject) || typeof identity.email !== "string"
    || identity.email !== identity.email.trim().toLowerCase() || typeof identity.displayName !== "string"
    || !Number.isSafeInteger(identity.profileVersion) || Number(identity.profileVersion) < 1
    || !Number.isSafeInteger(row.admissionVersion) || Number(row.admissionVersion) < 1
    || !instant(row.verifiedUntil) || Date.parse(row.verifiedUntil) <= Date.now()) return null;
  return row as unknown as AuthenticatedNativeStaffWithAdmissionVersion;
}
function normalize(raw: unknown, authenticated: AuthenticatedNativeStaffWithAdmissionVersion, now: number) {
  const row = record(raw, ["commandId", "loginEmail", "displayName", "expiresAt", "reason"]);
  if (!row || typeof row.commandId !== "string" || !UUID.test(row.commandId)
    || typeof row.loginEmail !== "string" || row.loginEmail !== row.loginEmail.trim().toLowerCase()
    || row.loginEmail.length < 3 || row.loginEmail.length > 254 || row.loginEmail.indexOf("@") <= 0 || /[\p{C}\s]/u.test(row.loginEmail)
    || typeof row.displayName !== "string" || row.displayName !== row.displayName.trim() || !row.displayName
    || Array.from(row.displayName).length > 160 || /\p{C}/u.test(row.displayName)
    || !instant(row.expiresAt) || Date.parse(row.expiresAt) < now + 60_000 || Date.parse(row.expiresAt) > now + 7 * 86400_000
    || typeof row.reason !== "string" || row.reason !== row.reason.trim() || !row.reason
    || Array.from(row.reason).length > 500 || /\p{C}/u.test(row.reason)) return null;
  return Object.freeze({ commandId: row.commandId, loginEmail: row.loginEmail, displayName: row.displayName,
    expiresAt: row.expiresAt, reason: row.reason, actorStaffId: authenticated.identity.staffId,
    actorAccessSubject: authenticated.identity.verifiedAccessSubject });
}

/** Creates a pending invitation only. ACL arrays are empty by design in this
 * first slice; 0073 requires global create authority for that empty scope. */
export async function createNativeStaffOnboarding(database: D1Database, raw: unknown,
  authenticatedRaw: unknown, keyringRaw: unknown): Promise<NativeStaffOnboardingCreateReceipt> {
  try {
    const authenticated = actor(authenticatedRaw);
    if (!authenticated) return denied();
    const keyring = snapshotNativeStaffHandoffKeyring(keyringRaw);
    const input = normalize(raw, authenticated, Date.now());
    if (!input) return denied();
    const requestHash = await sha256(JSON.stringify(["native-staff-onboarding-create-v1", input]));
    const db = database.withSession("first-primary");
    const replay = await db.prepare(`SELECT command.command_id,command.target_onboarding_id,command.target_proposed_staff_id,pending.state
      FROM native_staff_management_commands command JOIN native_staff_onboarding_create_authority authority
        ON authority.command_id=command.command_id
      JOIN native_staff_pending_onboarding pending ON pending.onboarding_id=command.target_onboarding_id
        AND pending.proposed_staff_id=command.target_proposed_staff_id
      WHERE command.command_id=? AND command.request_sha256=? AND command.actor_staff_id=?
        AND command.actor_access_subject=? AND command.capability='staff.onboarding.create'
        AND command.target_kind='onboarding' AND command.result_version=1
        AND EXISTS(SELECT 1 FROM native_staff_onboarding_handoffs handoff WHERE handoff.command_id=command.command_id)`)
      .bind(input.commandId, requestHash, input.actorStaffId, input.actorAccessSubject).first<Record<string, unknown>>();
    if (replay) {
      if (typeof replay.target_onboarding_id !== "string" || typeof replay.target_proposed_staff_id !== "string"
        || !["pending", "claimed", "approved", "cancelled", "expired"].includes(String(replay.state))) return denied();
      return Object.freeze({ commandId: input.commandId, onboardingId: replay.target_onboarding_id,
        proposedStaffId: replay.target_proposed_staff_id, resultVersion: 1, replayed: true,
        state: replay.state as NativeStaffOnboardingCreateReceipt["state"] });
    }

    const onboardingId = crypto.randomUUID();
    const proposedStaffId = `staff-${crypto.randomUUID()}`;
    const secretBytes = new Uint8Array(32); crypto.getRandomValues(secretBytes);
    const invitationSecret = Buffer.from(secretBytes).toString("hex");
    const invitationSecretSha256 = await sha256(invitationSecret);
    const proposal = { memberships: [], directoryGrants: [], managementGrants: [] };
    const proposalJson = JSON.stringify(proposal), proposalSha256 = await sha256(proposalJson);
    const result = { contractVersion: 1, capability: "staff.onboarding.create", onboardingId, proposedStaffId,
      loginEmail: input.loginEmail, displayName: input.displayName, expiresAt: input.expiresAt, proposal,
      proposalSha256, invitationSecretSha256, resultVersion: 1 };
    const resultJson = JSON.stringify(result), resultSha256 = await sha256(resultJson);
    const createdAt = new Date().toISOString();
    const nonce = new Uint8Array(12); crypto.getRandomValues(nonce);
    const authenticatedData = aad(input.commandId, onboardingId, proposedStaffId, input.actorStaffId,
      input.actorAccessSubject, requestHash);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(authenticatedData) },
      await aesKey(keyring.activeKeyId, keyring, "encrypt"), encoder.encode(invitationSecret));
    const statements = [
      db.prepare(`INSERT INTO native_staff_management_fences(target_kind,target_onboarding_id,target_proposed_staff_id,
        command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
        expected_version,result_version,reason,display_name,result_json,result_sha256,mutation_writes,created_at)
        VALUES('onboarding',?,?,?,?,1,'staff.onboarding.create',?,?,NULL,0,1,?,NULL,?,?,1,?)`)
        .bind(onboardingId, proposedStaffId, input.commandId, requestHash, input.actorStaffId,
          input.actorAccessSubject, input.reason, resultJson, resultSha256, createdAt),
      db.prepare(`INSERT INTO native_staff_pending_onboarding(onboarding_id,proposed_staff_id,login_email,display_name,
        invitation_secret_sha256,expires_at,state,version,proposal_json,proposal_sha256,created_by_staff_id,created_by_subject,
        reason,created_at) VALUES(?,?,?,?,?,?,'pending',1,?,?,?,?,?,?)`)
        .bind(onboardingId, proposedStaffId, input.loginEmail, input.displayName, invitationSecretSha256,
          input.expiresAt, proposalJson, proposalSha256, input.actorStaffId, input.actorAccessSubject, input.reason, createdAt),
      db.prepare(`INSERT INTO native_staff_management_commands(target_kind,target_onboarding_id,target_proposed_staff_id,
        command_id,request_sha256,contract_version,capability,actor_staff_id,actor_access_subject,target_staff_id,
        expected_version,result_version,reason,display_name,result_json,result_sha256)
        SELECT target_kind,target_onboarding_id,target_proposed_staff_id,command_id,request_sha256,contract_version,
          capability,actor_staff_id,actor_access_subject,target_staff_id,expected_version,result_version,reason,
          display_name,result_json,result_sha256 FROM native_staff_management_fences WHERE command_id=?`)
        .bind(input.commandId),
      db.prepare(`INSERT INTO native_staff_onboarding_handoffs(command_id,onboarding_id,proposed_staff_id,actor_staff_id,
        actor_access_subject,request_sha256,secret_sha256,expires_at,key_id,nonce_hex,ciphertext_hex,aad_sha256)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(input.commandId, onboardingId, proposedStaffId, input.actorStaffId,
        input.actorAccessSubject, requestHash, invitationSecretSha256, input.expiresAt, keyring.activeKeyId,
        Buffer.from(nonce).toString("hex"), Buffer.from(ciphertext).toString("hex"), await sha256(authenticatedData)),
    ];
    const batch: unknown = await db.batch(statements);
    if (!Array.isArray(batch) || batch.length !== statements.length
      || batch.some(item => !item || typeof item !== "object" || (item as { success?: unknown }).success !== true)) return denied();
    if (Date.parse(authenticated.verifiedUntil) <= Date.now()) return denied();
    return Object.freeze({ commandId: input.commandId, onboardingId, proposedStaffId, resultVersion: 1,
      replayed: false, state: "pending" });
  } catch { return denied(); }
}

export async function revealNativeStaffOnboarding(database: D1Database, commandId: string,
  authenticatedRaw: unknown, keyringRaw: unknown): Promise<NativeStaffOnboardingRevelation> {
  try {
    const authenticated = actor(authenticatedRaw);
    const ring = snapshotNativeStaffHandoffKeyring(keyringRaw);
    if (!authenticated || !UUID.test(commandId)) return denied();
    const db = database.withSession("first-primary"), identity = authenticated.identity;
    const row = await db.prepare(`SELECT handoff.command_id,handoff.onboarding_id,handoff.proposed_staff_id,
      handoff.actor_staff_id,handoff.actor_access_subject,handoff.request_sha256,handoff.secret_sha256,
      handoff.expires_at,handoff.key_id,handoff.nonce_hex,handoff.ciphertext_hex,handoff.aad_sha256
      FROM native_staff_onboarding_handoffs handoff JOIN native_staff_onboarding_create_authority authority
        ON authority.command_id=handoff.command_id JOIN native_staff_pending_onboarding pending
        ON pending.onboarding_id=handoff.onboarding_id AND pending.proposed_staff_id=handoff.proposed_staff_id
      WHERE handoff.command_id=? AND handoff.actor_staff_id=? AND handoff.actor_access_subject=?
        AND pending.state='pending' AND pending.version=1 AND pending.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .bind(commandId, identity.staffId, identity.verifiedAccessSubject).first<Record<string, unknown>>();
    if (!row || typeof row.onboarding_id !== "string" || typeof row.proposed_staff_id !== "string"
      || typeof row.request_sha256 !== "string" || typeof row.secret_sha256 !== "string"
      || typeof row.expires_at !== "string" || typeof row.key_id !== "string" || typeof row.nonce_hex !== "string"
      || typeof row.ciphertext_hex !== "string" || typeof row.aad_sha256 !== "string") return denied();
    const authenticatedData = aad(commandId, row.onboarding_id, row.proposed_staff_id,
      identity.staffId, identity.verifiedAccessSubject, row.request_sha256);
    if (await sha256(authenticatedData) !== row.aad_sha256 || !HEX.test(row.nonce_hex) || row.nonce_hex.length !== 24
      || !HEX.test(row.ciphertext_hex) || row.ciphertext_hex.length !== 160) return denied();
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(row.nonce_hex, "hex"),
      additionalData: encoder.encode(authenticatedData) }, await aesKey(row.key_id, ring, "decrypt"), Buffer.from(row.ciphertext_hex, "hex"));
    const invitationSecret = new TextDecoder("utf-8", { fatal: true }).decode(clear);
    if (!/^[0-9a-f]{64}$/u.test(invitationSecret) || await sha256(invitationSecret) !== row.secret_sha256
      || Date.parse(authenticated.verifiedUntil) <= Date.now()) return denied();
    const revealId = crypto.randomUUID();
    const audit = await db.prepare(`INSERT INTO native_staff_onboarding_reveal_audit(reveal_id,command_id,actor_staff_id,actor_access_subject)
      VALUES(?,?,?,?)`).bind(revealId, commandId, identity.staffId, identity.verifiedAccessSubject).run();
    if (audit.success !== true || audit.meta.changes !== 1) return denied();
    return Object.freeze({ commandId, onboardingId: row.onboarding_id, proposedStaffId: row.proposed_staff_id,
      expiresAt: row.expires_at, invitationSecret });
  } catch { return denied(); }
}
