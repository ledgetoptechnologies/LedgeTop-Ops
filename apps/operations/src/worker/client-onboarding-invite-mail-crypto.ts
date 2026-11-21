/** Unmounted, default-off mail envelope primitives. No transport or scheduler. */
const encoder = new TextEncoder();
const hex64 = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/;
const keyId = /^[A-Za-z0-9_-]{1,64}$/;
const deny = (): never => { throw Error("client_onboarding_invite_mail_denied"); };
const hex = (bytes: Uint8Array) => Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
function fromHex(value: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[a-f0-9]{2})+$/.test(value)) return deny();
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
async function digest(value: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
/** Conservative ASCII mailbox subset; preserve local-part case, lowercase only domain. */
export function normalizeInviteDeliveryAddress(value: unknown): string | null {
  if (typeof value !== "string" || !/^[\x20-\x7e]*$/.test(value)) return null;
  const address = value.trim();
  if (!address || address.length > 254 || /[^\x21-\x7e]/.test(address)) return null;
  const parts = address.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~.-]+$/.test(local)
    || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !domain || domain.length > 253) return null;
  const labels = domain.split(".");
  if (labels.length < 2 || labels.some(label => !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) return null;
  return `${local}@${domain.toLowerCase()}`;
}
export type InviteMailBinding = Readonly<{ commandId: string; invitationId: string; requestSha256: string;
  secretSha256: string; expiresAt: string; staffId: string; accessSubject: string }>;
export type InviteMailKeys = Readonly<{ encryptionKeyId: string; encryptionKeyHex: string;
  fingerprintKeyId: string; fingerprintKeyHex: string }>;
export type InviteMailKeyring = Readonly<{ activeEncryptionKeyId: string; activeFingerprintKeyId: string;
  encryptionKeys: Readonly<Record<string, string>>; fingerprintKeys: Readonly<Record<string, string>> }>;
export type InviteMailEnvelope = Readonly<{ keyId: string; fingerprintKeyId: string; recipientFingerprint: string;
  nonceHex: string; ciphertextHex: string; aadSha256: string }>;
function associatedData(value: InviteMailBinding): string {
  if (!value || typeof value.commandId !== "string" || !uuid.test(value.commandId)
    || typeof value.invitationId !== "string" || !uuid.test(value.invitationId)
    || typeof value.requestSha256 !== "string" || !hex64.test(value.requestSha256)
    || typeof value.secretSha256 !== "string" || !hex64.test(value.secretSha256)
    || typeof value.staffId !== "string" || !identifier.test(value.staffId) || typeof value.accessSubject !== "string" || !value.accessSubject
    || value.accessSubject.length > 512 || /[\u0000-\u001f\u007f]/.test(value.accessSubject)
    || typeof value.expiresAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.expiresAt)
    || !Number.isFinite(Date.parse(value.expiresAt)) || new Date(value.expiresAt).toISOString() !== value.expiresAt) return deny();
  return JSON.stringify(["client-onboarding-invite-mail-v1", value.commandId, value.invitationId,
    value.requestSha256, value.secretSha256, value.expiresAt, value.staffId, value.accessSubject]);
}
function snapshotBinding(value: unknown): InviteMailBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return deny();
  const names = ["commandId", "invitationId", "requestSha256", "secretSha256", "expiresAt", "staffId", "accessSubject"];
  const actual = Reflect.ownKeys(value);
  if (actual.length !== names.length || actual.some(name => typeof name !== "string" || !names.includes(name))) return deny();
  const copy: Record<string, string> = Object.create(null);
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (!property?.enumerable || !("value" in property) || typeof property.value !== "string") return deny();
    copy[name] = property.value;
  }
  associatedData(copy as unknown as InviteMailBinding);
  return Object.freeze(copy) as InviteMailBinding;
}
export function snapshotInviteMailEnvelope(value: unknown): InviteMailEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return deny();
  const names = ["keyId", "fingerprintKeyId", "recipientFingerprint", "nonceHex", "ciphertextHex", "aadSha256"];
  const actual = Reflect.ownKeys(value);
  if (actual.length !== names.length || actual.some(name => typeof name !== "string" || !names.includes(name))) return deny();
  const copy: Record<string, string> = Object.create(null);
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(value, name);
    if (!property?.enumerable || !("value" in property) || typeof property.value !== "string") return deny();
    copy[name] = property.value;
  }
  return Object.freeze(copy) as InviteMailEnvelope;
}
function validateKeys(keys: InviteMailKeys) {
  if (!keys || typeof keys.encryptionKeyId !== "string" || !keyId.test(keys.encryptionKeyId)
    || typeof keys.fingerprintKeyId !== "string" || !keyId.test(keys.fingerprintKeyId)
    || typeof keys.encryptionKeyHex !== "string" || !hex64.test(keys.encryptionKeyHex)
    || typeof keys.fingerprintKeyHex !== "string" || !hex64.test(keys.fingerprintKeyHex)
    || keys.encryptionKeyHex === keys.fingerprintKeyHex) return deny();
}
export function snapshotInviteMailKeys(value: unknown): InviteMailKeys {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return deny();
    const names = ["encryptionKeyId", "encryptionKeyHex", "fingerprintKeyId", "fingerprintKeyHex"];
    const actual = Reflect.ownKeys(value);
    if (actual.length !== names.length || actual.some(name => typeof name !== "string" || !names.includes(name))) return deny();
    const copy: Record<string, string> = Object.create(null);
    for (const name of names) {
      const property = Object.getOwnPropertyDescriptor(value, name);
      if (!property?.enumerable || !("value" in property) || typeof property.value !== "string") return deny();
      copy[name] = property.value;
    }
    validateKeys(copy as unknown as InviteMailKeys);
    return Object.freeze(copy) as InviteMailKeys;
  } catch { return deny(); }
}
/** Active keys are for new commands; retained IDs are used only for exact replay. */
export function snapshotInviteMailKeyring(value: unknown): InviteMailKeyring {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return deny();
    const names = ["activeEncryptionKeyId", "activeFingerprintKeyId", "encryptionKeys", "fingerprintKeys"];
    if (Reflect.ownKeys(value).length !== names.length || Reflect.ownKeys(value).some(name => typeof name !== "string" || !names.includes(name))) return deny();
    const read = (object: object, name: string): unknown => {
      const p = Object.getOwnPropertyDescriptor(object, name);
      if (!p?.enumerable || !("value" in p)) return deny();
      return p.value;
    };
    const activeEncryptionKeyId = read(value, "activeEncryptionKeyId"), activeFingerprintKeyId = read(value, "activeFingerprintKeyId");
    if (typeof activeEncryptionKeyId !== "string" || !keyId.test(activeEncryptionKeyId)
      || typeof activeFingerprintKeyId !== "string" || !keyId.test(activeFingerprintKeyId)) return deny();
    const map = (raw: unknown): Readonly<Record<string, string>> => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return deny();
      const entries = Reflect.ownKeys(raw);
      if (entries.length < 1 || entries.length > 8) return deny();
      const result: Record<string, string> = Object.create(null);
      for (const id of entries) {
        if (typeof id !== "string" || !keyId.test(id)) return deny();
        const material = read(raw,id);
        if (typeof material !== "string" || !hex64.test(material)) return deny();
        result[id] = material;
      }
      return Object.freeze(result);
    };
    const encryptionKeys = map(read(value,"encryptionKeys")), fingerprintKeys = map(read(value,"fingerprintKeys"));
    if (!Object.hasOwn(encryptionKeys,activeEncryptionKeyId) || !Object.hasOwn(fingerprintKeys,activeFingerprintKeyId)
      || Object.values(encryptionKeys).some(material => Object.values(fingerprintKeys).includes(material))) return deny();
    return Object.freeze({activeEncryptionKeyId,activeFingerprintKeyId,encryptionKeys,fingerprintKeys});
  } catch { return deny(); }
}
export function resolveInviteMailKeys(ring: InviteMailKeyring, encryptionKeyId: string, fingerprintKeyId: string): InviteMailKeys {
  const encryptionKeyHex = ring.encryptionKeys[encryptionKeyId], fingerprintKeyHex = ring.fingerprintKeys[fingerprintKeyId];
  if (!encryptionKeyHex || !fingerprintKeyHex) return deny();
  return snapshotInviteMailKeys({encryptionKeyId,encryptionKeyHex,fingerprintKeyId,fingerprintKeyHex});
}
async function fingerprint(recipient: string, material: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", fromHex(material), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`client-onboarding-recipient-v1:${recipient}`))));
}
export async function bindInviteMailDigest(baseRequestSha256: unknown, fingerprintKeyId: unknown,
  recipientFingerprint: unknown): Promise<string> {
  try {
    if (typeof baseRequestSha256 !== "string" || !hex64.test(baseRequestSha256)
      || typeof fingerprintKeyId !== "string" || !keyId.test(fingerprintKeyId)
      || typeof recipientFingerprint !== "string" || !hex64.test(recipientFingerprint)) return deny();
    return await digest(JSON.stringify(["client-onboarding-issuance-mail-v3",
      "email_once", baseRequestSha256, fingerprintKeyId, recipientFingerprint]));
  } catch { return deny(); }
}
/** Compose a versioned email-only digest from the existing canonical issuance digest. */
export async function inviteMailIntent(recipient: unknown, baseRequestSha256: unknown,
  fingerprintKeyId: unknown, fingerprintKeyHex: unknown): Promise<Readonly<{
    recipientFingerprintKeyId: string; recipientFingerprint: string; requestSha256: string;
  }>> {
  try {
    const address = normalizeInviteDeliveryAddress(recipient);
    if (!address || typeof baseRequestSha256 !== "string" || !hex64.test(baseRequestSha256)
      || typeof fingerprintKeyId !== "string" || !keyId.test(fingerprintKeyId)
      || typeof fingerprintKeyHex !== "string" || !hex64.test(fingerprintKeyHex)) return deny();
    const recipientFingerprint = await fingerprint(address, fingerprintKeyHex);
    const requestSha256 = await bindInviteMailDigest(baseRequestSha256, fingerprintKeyId, recipientFingerprint);
    return Object.freeze({ recipientFingerprintKeyId: fingerprintKeyId, recipientFingerprint, requestSha256 });
  } catch { return deny(); }
}
async function aes(material: string, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", fromHex(material), "AES-GCM", false, usage);
}
/** Mail purpose receives its own envelope; never call the staff reveal path. */
export async function sealInviteMail(recipient: unknown, secret: unknown, binding: InviteMailBinding,
  keys: InviteMailKeys): Promise<InviteMailEnvelope> {
  try {
    keys = snapshotInviteMailKeys(keys); binding = snapshotBinding(binding);
    const address = normalizeInviteDeliveryAddress(recipient); const aad = associatedData(binding);
    if (!address || typeof secret !== "string" || !hex64.test(secret)
      || await digest(`client-onboarding-invitation-v1:${binding.invitationId}:${secret}`) !== binding.secretSha256) return deny();
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const body = encoder.encode(JSON.stringify({ recipient: address, secret }));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: encoder.encode(aad) },
      await aes(keys.encryptionKeyHex, ["encrypt"]), body);
    return Object.freeze({ keyId: keys.encryptionKeyId, fingerprintKeyId: keys.fingerprintKeyId,
      recipientFingerprint: await fingerprint(address, keys.fingerprintKeyHex), nonceHex: hex(nonce),
      ciphertextHex: hex(new Uint8Array(ciphertext)), aadSha256: await digest(aad) });
  } catch { return deny(); }
}
/** Only the future fenced dispatcher may call this after its current-authority check. */
export async function openInviteMail(envelope: InviteMailEnvelope, binding: InviteMailBinding,
  keys: InviteMailKeys): Promise<Readonly<{ recipient: string; secret: string }>> {
  try {
    keys = snapshotInviteMailKeys(keys); binding = snapshotBinding(binding); envelope = snapshotInviteMailEnvelope(envelope);
    const aad = associatedData(binding);
    if (!envelope || envelope.keyId !== keys.encryptionKeyId || envelope.fingerprintKeyId !== keys.fingerprintKeyId
      || typeof envelope.recipientFingerprint !== "string" || !hex64.test(envelope.recipientFingerprint)
      || typeof envelope.nonceHex !== "string" || !/^[a-f0-9]{24}$/.test(envelope.nonceHex)
      || typeof envelope.ciphertextHex !== "string" || envelope.ciphertextHex.length < 32 || envelope.ciphertextHex.length > 2048
      || envelope.aadSha256 !== await digest(aad)) return deny();
    const clear = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(envelope.nonceHex), additionalData: encoder.encode(aad) },
      await aes(keys.encryptionKeyHex, ["decrypt"]), fromHex(envelope.ciphertextHex));
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(clear));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(",") !== "recipient,secret") return deny();
    const value = parsed as Record<string, unknown>; const address = normalizeInviteDeliveryAddress(value.recipient);
    if (!address || address !== value.recipient || typeof value.secret !== "string" || !hex64.test(value.secret)
      || await fingerprint(address, keys.fingerprintKeyHex) !== envelope.recipientFingerprint
      || await digest(`client-onboarding-invitation-v1:${binding.invitationId}:${value.secret}`) !== binding.secretSha256) return deny();
    return Object.freeze({ recipient: address, secret: value.secret });
  } catch { return deny(); }
}
