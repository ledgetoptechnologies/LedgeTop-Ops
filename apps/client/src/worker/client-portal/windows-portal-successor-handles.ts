import { z } from "zod";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand, parseOperationsPortalNativeDeliveryAuthorityCommand,
  sha256OperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";
import { isHiddenKey, validateRelativePath } from "../files";
import type { Env } from "../types";
import type { VerifiedClientPrincipal } from "./types";
import type { WindowsPortalSuccessorContext } from "./windows-portal-successor-authorization";

const PREFIX = "wsp1_", PURPOSE = "windows-portal-publication-successor-file-v1";
const TTL = 900_000, MAX_ENCODED = 8192, MAX_PLAIN = 6000;
const encoder = new TextEncoder();
type KeyEnv = Pick<Env, "DELIVERY_SESSION_SECRET" | "DELIVERY_PREVIOUS_SESSION_SECRET">;
type Principal = Pick<VerifiedClientPrincipal, "issuer" | "subject">;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const uuid = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const positive = z.number().int().positive().refine(Number.isSafeInteger);
const bounded = (max: number) => z.string().min(1).max(max)
  .refine(v => v.trim() === v && !/[\u0000-\u001f\u007f]/u.test(v));
const publication = z.object({ operationId: uuid, publicationId: uuid, revision: positive, sourceSequence: positive,
  snapshotId: uuid, snapshotSha256: hash }).strict().refine(p => p.revision === p.sourceSequence);
const file = z.object({ path: z.string().min(1).max(1024).refine(path => {
  try { return validateRelativePath(path) === path && !isHiddenKey(path) && encoder.encode(path).byteLength <= 4096; }
  catch { return false; }
}), etag: z.string().max(256).regex(/^"[\x21\x23-\x7e]+"$/u), providerVersion: bounded(256), sha256: hash,
  size: z.number().int().nonnegative().max(2 ** 40).refine(Number.isSafeInteger) }).strict();
const schema = file.extend({ v: z.literal(1), authorityId: uuid, originalGrantFingerprint: hash,
  issuer: bounded(512), subject: bounded(512), current: publication,
  chainSha256: hash, publicationCount: positive.max(64), expires: positive }).strict();

export type WindowsPortalSuccessorFilePins = z.infer<typeof file>;
/** Private encrypted selector claims. Never serialize these fields as a browser DTO.
 * Decoding proves format/integrity only, never current authorization or audit admission. */
export type WindowsPortalSuccessorHandle = z.infer<typeof schema>;

function invalid(): never { throw new Error("windows-successor-handle-invalid"); }
function expiry(value: number, now: number): boolean {
  return Number.isSafeInteger(value) && value > now && value <= now + TTL;
}
function humanExpiry(value: number): boolean { return Number.isSafeInteger(value) && value > Date.now() && value <= 253_402_300_799_999; }
function base64(bytes: Uint8Array): string {
  let raw = ""; for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
async function key(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 4096) return invalid();
  return crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", encoder.encode(`${PURPOSE}\0${secret}`)),
    { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
function same(a: z.infer<typeof publication>, b: z.infer<typeof publication>): boolean {
  return Object.entries(a).every(([k, v]) => b[k as keyof typeof b] === v);
}
async function contextSnapshot(context: WindowsPortalSuccessorContext, principal: Principal, verifiedUntil: number) {
  if (context.kind !== "windows-portal-successor-v1" || !humanExpiry(verifiedUntil)) return invalid();
  // Snapshot caller-owned nested objects and person before the cryptographic await.
  const canonical = canonicalOperationsPortalNativeDeliveryAuthorityCommand(context.originalGrant);
  const grant = parseOperationsPortalNativeDeliveryAuthorityCommand(JSON.parse(canonical));
  const fingerprint = context.originalRequestFingerprint, prefix = context.selectedR2Prefix;
  const person = z.object({ issuer: bounded(512), subject: bounded(512) }).strict().parse({ issuer: principal.issuer, subject: principal.subject });
  const continuity = z.object({ grantOperationId: uuid, grantFingerprint: hash, first: publication, current: publication,
    publicationCount: positive.max(64), chainSha256: hash }).strict().parse(context.continuity);
  if (!grant || grant.action !== "delivery.grant" || !grant.features.includes("file.download") || !grant.expiresAt
    || grant.recipient.issuer !== person.issuer || grant.recipient.subject !== person.subject || prefix !== grant.resource.selectedR2Prefix
    || isHiddenKey(prefix) || continuity.grantOperationId !== grant.operationId || continuity.grantFingerprint !== fingerprint) return invalid();
  const first = publication.parse({ operationId: grant.publication.operationId, publicationId: grant.publication.publicationId,
    revision: Number(grant.publication.revision), sourceSequence: Number(grant.publication.sourceSequence),
    snapshotId: grant.publication.snapshotId, snapshotSha256: grant.publication.snapshotSha256 });
  if (!same(first, continuity.first) || continuity.current.sourceSequence < first.sourceSequence
    || continuity.publicationCount !== continuity.current.sourceSequence - first.sourceSequence + 1) return invalid();
  const grantExpiry = Date.parse(grant.expiresAt);
  if (!Number.isSafeInteger(grantExpiry) || grantExpiry <= Date.now()
    || await sha256OperationsPortalNativeDeliveryAuthorityCommand(grant) !== fingerprint) return invalid();
  return { grant, fingerprint, person, continuity, grantExpiry, verifiedUntil };
}

/** All expiry arguments/claims are epoch milliseconds. Fresh authorization is a caller prerequisite. */
export async function encodeWindowsPortalSuccessorHandle(env: KeyEnv, context: WindowsPortalSuccessorContext,
  principal: Principal, verifiedUntil: number, pins: WindowsPortalSuccessorFilePins): Promise<string> {
  const secret = env.DELIVERY_SESSION_SECRET;
  const selected = file.parse(pins);
  const bound = await contextSnapshot(context, principal, verifiedUntil);
  const now = Date.now(), expires = Math.min(now + TTL, bound.grantExpiry, bound.verifiedUntil);
  if (!expiry(expires, now)) return invalid();
  const value = schema.parse({ ...selected, v: 1, authorityId: bound.grant.authority.authorityId,
    originalGrantFingerprint: bound.fingerprint, ...bound.person, current: bound.continuity.current,
    chainSha256: bound.continuity.chainSha256, publicationCount: bound.continuity.publicationCount, expires });
  const bytes = encoder.encode(JSON.stringify(value)); if (bytes.byteLength > MAX_PLAIN) return invalid();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(PREFIX) }, await key(secret ?? ""), bytes));
  const combined = new Uint8Array(iv.length + encrypted.length); combined.set(iv); combined.set(encrypted, iv.length);
  const token = PREFIX + base64(combined); if (token.length > MAX_ENCODED || expires <= Date.now()) return invalid();
  return token;
}

export async function decodeWindowsPortalSuccessorHandle(env: KeyEnv, token: string): Promise<WindowsPortalSuccessorHandle | null> {
  try {
    if (typeof token !== "string" || token.length > MAX_ENCODED || !/^wsp1_[A-Za-z0-9_-]+$/u.test(token)) return null;
    const raw = token.slice(PREFIX.length), bytes = Uint8Array.from(atob(raw.replace(/-/gu, "+").replace(/_/gu, "/")), c => c.charCodeAt(0));
    if (bytes.length < 29 || bytes.length > MAX_PLAIN + 28 || base64(bytes) !== raw) return null;
    const secrets = [env.DELIVERY_SESSION_SECRET, env.DELIVERY_PREVIOUS_SESSION_SECRET];
    for (const secret of secrets) {
      if (!secret || secret.length < 32 || secret.length > 4096) continue;
      try {
        const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: encoder.encode(PREFIX) }, await key(secret), bytes.slice(12));
        if (plain.byteLength > MAX_PLAIN) return null;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(plain), parsed: unknown = JSON.parse(text);
        // Encoder emits canonical JSON; this also rejects duplicate keys/escaped aliases before schema parsing.
        if (JSON.stringify(parsed) !== text) return null;
        const value = schema.safeParse(parsed);
        if (!value.success || !expiry(value.data.expires, Date.now())) return null;
        return Object.freeze({ ...value.data, current: Object.freeze(value.data.current) });
      } catch { /* Wrong key, purpose, malformed claims or tampering is never admitted. */ }
    }
    return null;
  } catch { return null; }
}

/** Local exact comparison only. Call fresh authorizer and mandatory audit at every content boundary. */
export async function windowsPortalSuccessorHandleMatchesContext(handle: WindowsPortalSuccessorHandle,
  context: WindowsPortalSuccessorContext, principal: Principal, verifiedUntil: number): Promise<boolean> {
  try {
    const selected = schema.parse(handle), bound = await contextSnapshot(context, principal, verifiedUntil);
    return expiry(selected.expires, Date.now()) && selected.expires <= bound.grantExpiry && selected.expires <= bound.verifiedUntil
      && selected.authorityId === bound.grant.authority.authorityId && selected.originalGrantFingerprint === bound.fingerprint
      && selected.issuer === bound.person.issuer && selected.subject === bound.person.subject
      && same(selected.current, bound.continuity.current) && selected.chainSha256 === bound.continuity.chainSha256
      && selected.publicationCount === bound.continuity.publicationCount;
  } catch { return false; }
}
