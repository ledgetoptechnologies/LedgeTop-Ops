import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { clientOnboardingIssuanceEvidence, issueClientOnboardingInvitation,
  type ClientOnboardingIssuanceReceipt, type ClientOnboardingProposedScope } from "./client-onboarding-issuance";
import { hashClientOnboardingInvitationSecret } from "./client-onboarding-submissions";
import { isNativeAccessSubject } from "./native-access-subject";
import type { AuthenticatedNativeStaff } from "./native-staff-auth";
import { assertCurrentStaffLogin, snapshotStaffLoginProof } from "./staff-login-bindings";
import type { VerifiedInviteTarget } from "./client-onboarding-target-choices";
import { inviteMailIntent, normalizeInviteDeliveryAddress, openInviteMail, sealInviteMail, snapshotInviteMailKeyring, resolveInviteMailKeys,
  type InviteMailEnvelope, type InviteMailKeyring } from "./client-onboarding-invite-mail-crypto";

export type ClientOnboardingKeyring = Readonly<{ activeKeyId: string; keys: Readonly<Record<string, string>> }>;
export type ClientOnboardingRevelation = Readonly<{
  commandId: string; invitationId: string; expiresAt: string; invitationSecret: string;
}>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX = /^[0-9a-f]+$/;
const encoder = new TextEncoder();
const MAX_INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const issueDenied = (): never => { throw Error("client_onboarding_handoff_issue_denied"); };
const revealDenied = (): never => { throw Error("client_onboarding_handoff_reveal_denied"); };
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
const hex = (value: unknown, length: number): value is string => typeof value === "string"
  && value.length === length && HEX.test(value);
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function denseArray(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1) return null;
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    copy.push(descriptor.value);
  }
  return copy;
}
async function sha256(value: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest("SHA-256", encoder.encode(value))).toString("hex");
}
function same(left: string, right: string): boolean {
  return hex(left, 64) && hex(right, 64) && timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}
function actor(value: unknown): AuthenticatedNativeStaff | null {
  const hasLogin = value !== null && typeof value === "object" && Object.hasOwn(value, "verifiedLogin");
  const wrapper = record(value, hasLogin ? ["identity", "verifiedUntil", "verifiedLogin"] : ["identity", "verifiedUntil"]);
  const identity = wrapper && record(wrapper.identity,
    ["kind", "staffId", "verifiedAccessSubject", "email", "displayName", "profileVersion"]);
  if (!wrapper || !identity || identity.kind !== "native" || typeof identity.staffId !== "string" || !ID.test(identity.staffId)
    || !isNativeAccessSubject(identity.verifiedAccessSubject) || typeof identity.email !== "string"
    || identity.email !== identity.email.trim().toLowerCase() || typeof identity.displayName !== "string"
    || !identity.displayName.trim() || typeof identity.profileVersion !== "number"
    || !Number.isSafeInteger(identity.profileVersion) || identity.profileVersion < 1
    || !instant(wrapper.verifiedUntil) || Date.parse(wrapper.verifiedUntil) <= Date.now()) return null;
  const login = hasLogin ? snapshotStaffLoginProof(wrapper.verifiedLogin) : undefined;
  if (login !== undefined && (!login || login.kind !== "alternate" || login.staffId !== identity.staffId
    || login.canonicalEmail !== identity.email || login.canonicalSubject !== identity.verifiedAccessSubject
    || login.expiresAt * 1000 < Date.parse(wrapper.verifiedUntil))) return null;
  return { identity: identity as AuthenticatedNativeStaff["identity"], verifiedUntil: wrapper.verifiedUntil,
    ...(login ? { verifiedLogin: login } : {}) };
}
function baseRequest(value: unknown) {
  const keys = ["commandId", "expiresAt", "targetClientRecordId", "scopes"];
  const legacy = record(value, keys);
  const row = legacy ?? record(value, [...keys, "destinationIntent"]);
  if (!row || typeof row.commandId !== "string" || !UUID.test(row.commandId)
    || !instant(row.expiresAt) || Date.parse(row.expiresAt) <= Date.now()
    || Date.parse(row.expiresAt) > Date.now() + MAX_INVITATION_LIFETIME_MS
    || (row.targetClientRecordId !== null && (typeof row.targetClientRecordId !== "string" || !ID.test(row.targetClientRecordId)))) return null;
  if (row.targetClientRecordId !== null && row.scopes !== null) return null;
  const rawScopes = denseArray(row.scopes, 128);
  if (row.targetClientRecordId === null && (!rawScopes || rawScopes.length < 1 || rawScopes.length > 128)) return null;
  const scopes = row.scopes === null ? null : rawScopes!.map((item: unknown) => {
    const scope = record(item, ["businessAreaId", "divisionId"]);
    if (!scope || typeof scope.businessAreaId !== "string" || !ID.test(scope.businessAreaId)
      || (scope.divisionId !== null && (typeof scope.divisionId !== "string" || !ID.test(scope.divisionId)))) throw Error();
    return Object.freeze({ businessAreaId: scope.businessAreaId, divisionId: scope.divisionId as string | null });
  }) as ClientOnboardingProposedScope[] | null;
  if (scopes && new Set(scopes.map(scope => `${scope.businessAreaId}\0${scope.divisionId ?? ""}`)).size !== scopes.length) return null;
  return { commandId: row.commandId, expiresAt: row.expiresAt,
    targetClientRecordId: row.targetClientRecordId as string | null, scopes,
    ...(!legacy ? { destinationIntent: row.destinationIntent } : {}) };
}
export function snapshotClientOnboardingKeyring(value: unknown): ClientOnboardingKeyring {
  const ring = record(value, ["activeKeyId", "keys"]);
  if (!ring || typeof ring.activeKeyId !== "string" || !KEY_ID.test(ring.activeKeyId)
    || !ring.keys || typeof ring.keys !== "object" || Array.isArray(ring.keys)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(ring.keys))) throw Error("client_onboarding_keyring_unavailable");
  const names = Reflect.ownKeys(ring.keys);
  if (names.length < 1 || names.length > 8) throw Error("client_onboarding_keyring_unavailable");
  const keys: Record<string, string> = Object.create(null);
  for (const name of names) {
    if (typeof name !== "string" || !KEY_ID.test(name)) throw Error("client_onboarding_keyring_unavailable");
    const descriptor = Object.getOwnPropertyDescriptor(ring.keys, name);
    if (!descriptor?.enumerable || !("value" in descriptor) || !hex(descriptor.value, 64)) throw Error("client_onboarding_keyring_unavailable");
    keys[name] = descriptor.value;
  }
  if (!Object.hasOwn(keys, ring.activeKeyId)) throw Error("client_onboarding_keyring_unavailable");
  return Object.freeze({ activeKeyId: ring.activeKeyId, keys: Object.freeze(keys) });
}
function aad(commandId: string, invitationId: string, staffId: string, subject: string, requestSha256: string): string {
  return JSON.stringify(["client-onboarding-handoff-v1", commandId, invitationId, staffId, subject, requestSha256]);
}
async function aesKey(id: string, ring: ClientOnboardingKeyring): Promise<CryptoKey> {
  const material = ring.keys[id];
  if (!hex(material, 64)) throw Error();
  return crypto.subtle.importKey("raw", Buffer.from(material, "hex"), "AES-GCM", false, ["encrypt", "decrypt"]);
}
type HandoffRow = Record<"command_id" | "invitation_id" | "actor_staff_id" | "actor_access_subject"
  | "request_sha256" | "secret_sha256" | "expires_at" | "key_id" | "nonce_hex" | "ciphertext_hex" | "aad_sha256", string>;
function parseRow(value: unknown): HandoffRow | null {
  const names = ["command_id", "invitation_id", "actor_staff_id", "actor_access_subject", "request_sha256",
    "secret_sha256", "expires_at", "key_id", "nonce_hex", "ciphertext_hex", "aad_sha256"];
  const row = record(value, names);
  if (!row || typeof row.command_id !== "string" || !UUID.test(row.command_id)
    || typeof row.invitation_id !== "string" || !UUID.test(row.invitation_id)
    || typeof row.actor_staff_id !== "string" || !ID.test(row.actor_staff_id)
    || !isNativeAccessSubject(row.actor_access_subject) || !hex(row.request_sha256, 64)
    || !hex(row.secret_sha256, 64) || !instant(row.expires_at) || typeof row.key_id !== "string"
    || !KEY_ID.test(row.key_id) || !hex(row.nonce_hex, 24) || !hex(row.ciphertext_hex, 160)
    || !hex(row.aad_sha256, 64)) return null;
  return row as HandoffRow;
}
async function decrypt(row: HandoffRow, ring: ClientOnboardingKeyring): Promise<string> {
  const authenticatedData = aad(row.command_id, row.invitation_id, row.actor_staff_id,
    row.actor_access_subject, row.request_sha256);
  if (!same(await sha256(authenticatedData), row.aad_sha256)) throw Error();
  const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(row.nonce_hex, "hex"),
    additionalData: encoder.encode(authenticatedData) }, await aesKey(row.key_id, ring), Buffer.from(row.ciphertext_hex, "hex"));
  const secret = new TextDecoder("utf-8", { fatal: true }).decode(clear);
  if (!hex(secret, 64) || !same(await hashClientOnboardingInvitationSecret(row.invitation_id, secret), row.secret_sha256)) throw Error();
  return secret;
}
export async function issueClientOnboardingWithHandoff(database: D1Database, raw: unknown,
  keyring: ClientOnboardingKeyring, targets?: readonly VerifiedInviteTarget[]): Promise<ClientOnboardingIssuanceReceipt> {
  try {
    const ring = snapshotClientOnboardingKeyring(keyring);
    const envelope = record(raw, ["authenticatedNativeStaff", "request"]);
    const authenticated = envelope && actor(envelope.authenticatedNativeStaff);
    const base = envelope && baseRequest(envelope.request);
    if (!authenticated || !base) throw Error();
    if (authenticated.verifiedLogin && !await assertCurrentStaffLogin(database, authenticated.verifiedLogin)) throw Error();
    const find = async () => parseRow(await database.withSession("first-primary").prepare(`SELECT command_id,invitation_id,
      actor_staff_id,actor_access_subject,request_sha256,secret_sha256,expires_at,key_id,nonce_hex,ciphertext_hex,aad_sha256
      FROM client_onboarding_handoffs WHERE command_id=? AND actor_staff_id=? AND actor_access_subject=?`)
      .bind(base.commandId, authenticated.identity.staffId, authenticated.identity.verifiedAccessSubject).first());
    const replay = async (row: HandoffRow | null) => {
      if (!row || row.expires_at !== base.expiresAt) throw Error();
      const secret = await decrypt(row, ring);
      const full = { authenticatedNativeStaff: authenticated, request: { ...base,
        invitationId: row.invitation_id, invitationSecret: secret } };
      const evidence = await clientOnboardingIssuanceEvidence(full, targets);
      if (!same(evidence.requestSha256, row.request_sha256) || !same(evidence.secretSha256, row.secret_sha256)) throw Error();
      return issueClientOnboardingInvitation(database, full, { keyId: row.key_id, nonceHex: row.nonce_hex,
        ciphertextHex: row.ciphertext_hex, aadSha256: row.aad_sha256 }, targets);
    };
    const existing = await find();
    if (existing) return await replay(existing);
    const invitationId = crypto.randomUUID();
    const bytes = new Uint8Array(32); crypto.getRandomValues(bytes);
    const invitationSecret = Buffer.from(bytes).toString("hex");
    const full = { authenticatedNativeStaff: authenticated, request: { ...base, invitationId, invitationSecret } };
    const evidence = await clientOnboardingIssuanceEvidence(full, targets);
    const authenticatedData = aad(base.commandId, invitationId, authenticated.identity.staffId,
      authenticated.identity.verifiedAccessSubject, evidence.requestSha256);
    const nonce = new Uint8Array(12); crypto.getRandomValues(nonce);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce,
      additionalData: encoder.encode(authenticatedData) }, await aesKey(ring.activeKeyId, ring), encoder.encode(invitationSecret));
    try {
      return await issueClientOnboardingInvitation(database, full, { keyId: ring.activeKeyId,
        nonceHex: Buffer.from(nonce).toString("hex"), ciphertextHex: Buffer.from(ciphertext).toString("hex"),
        aadSha256: await sha256(authenticatedData) }, targets);
    } catch { return await replay(await find()); }
  } catch { return issueDenied(); }
}

export function assertInviteMailKeyringsDisjoint(handoff: ClientOnboardingKeyring, mail: InviteMailKeyring): void {
  const encryption = Object.values(mail.encryptionKeys), fingerprint = Object.values(mail.fingerprintKeys);
  if (Object.values(handoff.keys).some(value => encryption.includes(value) || fingerprint.includes(value))) throw Error();
}

/** Unmounted email issuance. The caller must enforce its default-off feature gate and current scope authority. */
export async function issueClientOnboardingMailWithHandoff(database: D1Database, raw: unknown,
  keyring: ClientOnboardingKeyring, recipient: unknown, mailKeys: InviteMailKeyring): Promise<Readonly<{
    invitationId: string; expiresAt: string; requestSha256: string; state: "pending" | "submitted";
    mailStatus: "queued" | "sent" | "failed" | "unknown";
  }>> {
  try {
    const ring = snapshotClientOnboardingKeyring(keyring), mailRing = snapshotInviteMailKeyring(mailKeys), address = normalizeInviteDeliveryAddress(recipient);
    const envelope = record(raw, ["authenticatedNativeStaff", "request"]);
    const authenticated = envelope && actor(envelope.authenticatedNativeStaff), base = envelope && baseRequest(envelope.request);
    if (!authenticated || !base || !address || base.targetClientRecordId !== null) throw Error();
    assertInviteMailKeyringsDisjoint(ring, mailRing);
    if (authenticated.verifiedLogin && !await assertCurrentStaffLogin(database, authenticated.verifiedLogin)) throw Error();
    const db = database.withSession("first-primary");
    const find = async () => parseRow(await db.prepare(`SELECT handoff.command_id,handoff.invitation_id,
      handoff.actor_staff_id,handoff.actor_access_subject,handoff.request_sha256,handoff.secret_sha256,handoff.expires_at,
      handoff.key_id,handoff.nonce_hex,handoff.ciphertext_hex,handoff.aad_sha256
      FROM client_onboarding_handoffs handoff JOIN client_onboarding_live_issuances live ON live.invitation_id=handoff.invitation_id
      WHERE handoff.command_id=? AND handoff.actor_staff_id=? AND handoff.actor_access_subject=?`)
      .bind(base.commandId,authenticated.identity.staffId,authenticated.identity.verifiedAccessSubject).first());
    const replay = async (row: HandoffRow | null) => {
      if (!row || row.expires_at !== base.expiresAt || Date.parse(row.expires_at) <= Date.now()) throw Error();
      const secret = await decrypt(row,ring);
      const full = { authenticatedNativeStaff: authenticated, request: { ...base, invitationId: row.invitation_id, invitationSecret: secret } };
      const saved = await db.prepare(`SELECT mail.key_id,mail.recipient_fingerprint_key_id,mail.recipient_fingerprint,
        mail.nonce_hex,mail.ciphertext_hex,mail.aad_sha256,mail.state,invitation.state invitation_state
        FROM client_onboarding_invite_mail_outbox mail JOIN client_onboarding_invitations invitation ON invitation.invitation_id=mail.invitation_id
        WHERE mail.command_id=? AND mail.invitation_id=? AND mail.request_sha256=? AND mail.expires_at=?`)
        .bind(row.command_id,row.invitation_id,row.request_sha256,row.expires_at).first<Record<string, unknown>>();
      if (!saved || typeof saved.key_id !== "string" || typeof saved.recipient_fingerprint_key_id !== "string"
        || (saved.invitation_state !== "pending" && saved.invitation_state !== "submitted")) throw Error();
      const keys = resolveInviteMailKeys(mailRing,saved.key_id,saved.recipient_fingerprint_key_id);
      const ordinary = await clientOnboardingIssuanceEvidence(full);
      const intent = await inviteMailIntent(address,ordinary.requestSha256,keys.fingerprintKeyId,keys.fingerprintKeyHex);
      const evidence = await clientOnboardingIssuanceEvidence(full,undefined,
        { fingerprintKeyId: intent.recipientFingerprintKeyId, recipientFingerprint: intent.recipientFingerprint });
      if (!same(evidence.requestSha256,row.request_sha256) || !same(evidence.secretSha256,row.secret_sha256)) throw Error();
      const stored = { keyId:saved.key_id,fingerprintKeyId:saved.recipient_fingerprint_key_id,
        recipientFingerprint:saved.recipient_fingerprint,nonceHex:saved.nonce_hex,ciphertextHex:saved.ciphertext_hex,aadSha256:saved.aad_sha256 } as InviteMailEnvelope;
      const binding = { commandId:row.command_id,invitationId:row.invitation_id,requestSha256:row.request_sha256,
        secretSha256:row.secret_sha256,expiresAt:row.expires_at,staffId:row.actor_staff_id,accessSubject:row.actor_access_subject };
      const clear = await openInviteMail(stored,binding,keys);
      if (clear.recipient !== address || !same(clear.secret,secret)) throw Error();
      const mailStatus = saved.state === "pending" || saved.state === "claimed" ? "queued"
        : saved.state === "sent" ? "sent" : saved.state === "failed" || saved.state === "suppressed" ? "failed"
          : saved.state === "attempted" || saved.state === "unknown" ? "unknown" : null;
      if (!mailStatus) throw Error();
      if (authenticated.verifiedLogin && !await assertCurrentStaffLogin(database,authenticated.verifiedLogin)) throw Error();
      return Object.freeze({ invitationId:row.invitation_id,expiresAt:row.expires_at,requestSha256:row.request_sha256,
        state:saved.invitation_state as "pending" | "submitted",mailStatus });
    };
    const existing = await find();
    if (existing) return await replay(existing);
    const invitationId = crypto.randomUUID(), secretBytes = crypto.getRandomValues(new Uint8Array(32));
    const secret = Buffer.from(secretBytes).toString("hex");
    const full = { authenticatedNativeStaff:authenticated,request:{ ...base,invitationId,invitationSecret:secret } };
    const keys = resolveInviteMailKeys(mailRing,mailRing.activeEncryptionKeyId,mailRing.activeFingerprintKeyId);
    const ordinary = await clientOnboardingIssuanceEvidence(full);
    const intent = await inviteMailIntent(address,ordinary.requestSha256,keys.fingerprintKeyId,keys.fingerprintKeyHex);
    const evidence = await clientOnboardingIssuanceEvidence(full,undefined,
      { fingerprintKeyId:intent.recipientFingerprintKeyId,recipientFingerprint:intent.recipientFingerprint });
    const binding = { commandId:base.commandId,invitationId,requestSha256:evidence.requestSha256,secretSha256:evidence.secretSha256,
      expiresAt:base.expiresAt,staffId:authenticated.identity.staffId,accessSubject:authenticated.identity.verifiedAccessSubject };
    const mail = await sealInviteMail(address,secret,binding,keys);
    if (mail.recipientFingerprint !== intent.recipientFingerprint || mail.fingerprintKeyId !== intent.recipientFingerprintKeyId) throw Error();
    const authenticatedData = aad(base.commandId,invitationId,authenticated.identity.staffId,authenticated.identity.verifiedAccessSubject,evidence.requestSha256);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name:"AES-GCM",iv:nonce,additionalData:encoder.encode(authenticatedData) },
      await aesKey(ring.activeKeyId,ring),encoder.encode(secret));
    try {
      await issueClientOnboardingInvitation(database,full,{ keyId:ring.activeKeyId,nonceHex:Buffer.from(nonce).toString("hex"),
        ciphertextHex:Buffer.from(ciphertext).toString("hex"),aadSha256:await sha256(authenticatedData) },undefined,mail);
      return await replay(await find());
    } catch { return await replay(await find()); }
  } catch { return issueDenied(); }
}
export async function revealClientOnboardingSecret(database: D1Database, raw: unknown,
  keyring: ClientOnboardingKeyring): Promise<ClientOnboardingRevelation> {
  try {
    const ring = snapshotClientOnboardingKeyring(keyring);
    const envelope = record(raw, ["authenticatedNativeStaff", "commandId"]);
    const authenticated = envelope && actor(envelope.authenticatedNativeStaff);
    if (!authenticated || typeof envelope?.commandId !== "string" || !UUID.test(envelope.commandId)) throw Error();
    if (authenticated.verifiedLogin && !await assertCurrentStaffLogin(database, authenticated.verifiedLogin)) throw Error();
    const identity = authenticated.identity;
    const db = database.withSession("first-primary");
    // Old databases do not have the mail table. If installed, both the read
    // and the atomic consumption write reject mail-mode commands.
    const mailInstalled = Boolean(await db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='client_onboarding_invite_mail_outbox'").first());
    const mailGuard = mailInstalled ? "AND NOT EXISTS(SELECT 1 FROM client_onboarding_invite_mail_outbox mail WHERE mail.command_id=handoff.command_id)" : "";
    const row = parseRow(await db.prepare(`SELECT handoff.command_id,handoff.invitation_id,handoff.actor_staff_id,
      handoff.actor_access_subject,handoff.request_sha256,handoff.secret_sha256,handoff.expires_at,handoff.key_id,
      handoff.nonce_hex,handoff.ciphertext_hex,handoff.aad_sha256 FROM client_onboarding_handoffs handoff
      JOIN client_onboarding_invitations invitation ON invitation.invitation_id=handoff.invitation_id
      JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
      JOIN native_staff_profiles profile ON profile.staff_id=handoff.actor_staff_id AND profile.version=? AND profile.login_email=?
      WHERE handoff.command_id=? AND handoff.actor_staff_id=? AND handoff.actor_access_subject=?
        AND invitation.state='pending' AND invitation.version=1 ${mailGuard}`).bind(identity.profileVersion, identity.email,
          envelope.commandId, identity.staffId, identity.verifiedAccessSubject).first());
    if (!row || Date.parse(row.expires_at) <= Date.now()) throw Error();
    const invitationSecret = await decrypt(row, ring);
    if (authenticated.verifiedLogin && !await assertCurrentStaffLogin(database, authenticated.verifiedLogin)) throw Error();
    const revealId = crypto.randomUUID();
    const results = await db.batch([
      db.prepare(`INSERT INTO client_onboarding_reveal_consumptions
        (command_id,reveal_id,actor_staff_id,actor_access_subject,auth_verified_until)
        SELECT handoff.command_id,?,?,?,? FROM client_onboarding_handoffs handoff
        JOIN client_onboarding_invitations invitation ON invitation.invitation_id=handoff.invitation_id
        JOIN client_onboarding_live_issuances live ON live.invitation_id=invitation.invitation_id
        JOIN native_staff_profiles profile ON profile.staff_id=handoff.actor_staff_id AND profile.version=? AND profile.login_email=?
        WHERE handoff.command_id=? AND handoff.actor_staff_id=? AND handoff.actor_access_subject=?
          AND invitation.state='pending' AND invitation.version=1 ${mailGuard}
          AND NOT EXISTS(SELECT 1 FROM client_onboarding_reveal_consumptions consumed
            WHERE consumed.command_id=handoff.command_id)`)
        .bind(revealId, identity.staffId, identity.verifiedAccessSubject, authenticated.verifiedUntil,
          identity.profileVersion, identity.email, row.command_id, identity.staffId, identity.verifiedAccessSubject),
      db.prepare(`INSERT INTO client_onboarding_reveal_audit
        (reveal_id,command_id,actor_staff_id,actor_access_subject,auth_verified_until)
        SELECT ?,consumed.command_id,consumed.actor_staff_id,consumed.actor_access_subject,consumed.auth_verified_until
        FROM client_onboarding_reveal_consumptions consumed
        WHERE consumed.command_id=? AND consumed.reveal_id=? AND consumed.actor_staff_id=?
          AND consumed.actor_access_subject=?`)
        .bind(revealId, row.command_id, revealId, identity.staffId, identity.verifiedAccessSubject),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) throw Error();
    if (authenticated.verifiedLogin && !await assertCurrentStaffLogin(database, authenticated.verifiedLogin)) throw Error();
    return Object.freeze({ commandId: row.command_id, invitationId: row.invitation_id,
      expiresAt: row.expires_at, invitationSecret });
  } catch { return revealDenied(); }
}
