import { z } from 'zod';
import type { Env } from '../types';
import { validateRelativePath } from '../files';
import type { OperationsPortalNativeDeliveryAuthorityCommand } from '@ltds/shared/operations-portal-native-delivery-authority';

const PURPOSE = 'operations-native-delivery-resource-v1';
const PREFIX = 'ond1_';
const TTL_MS = 15 * 60_000;
const MAX_ENCODED = 8192;
const encoder = new TextEncoder();
const positive = z.string().regex(/^[1-9][0-9]*$/).refine(value => Number.isSafeInteger(Number(value)));
const bounded = (maximum: number) => z.string().min(1).max(maximum)
  .refine(value => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const schema = z.object({
  v: z.literal(1), kind: z.enum(['folder', 'file', 'cursor']),
  authorityId: z.string().uuid(), authorityRevision: positive,
  recipientBindingId: z.string().uuid(), enrollmentIntentId: z.string().uuid(), targetClientRecordId: bounded(191),
  issuer: bounded(512), subject: bounded(512), targetId: z.string().uuid(), targetRevision: positive,
  clientAuthorityId: z.string().uuid(), workspaceId: bounded(200),
  homeOwnershipEpoch: positive, homeGrantRevision: positive, homeGrantOperationId: z.string().uuid(),
  homeRequestFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  publicationId: z.string().uuid(), publicationOperationId: z.string().uuid(), publicationRevision: positive,
  publicationSourceSequence: positive,
  snapshotId: z.string().uuid(), snapshotSha256: z.string().regex(/^[a-f0-9]{64}$/),
  folderReservationId: z.string().uuid(), folderReservationRevision: positive,
  clientFolderBindingId: bounded(200), externalProjectId: bounded(191), projectVersion: positive,
  path: z.string().max(1024), etag: bounded(256).optional(),
  after: bounded(1024).optional(), entryKind: z.enum(['folder', 'file', 'delivery']).optional(),
  expires: z.number().int().positive().refine(Number.isSafeInteger),
}).strict().superRefine((value, ctx) => {
  const folderPath = value.kind !== 'file';
  const bare = folderPath && value.path.endsWith('/') ? value.path.slice(0, -1) : value.path;
  try {
    if (value.path !== '' && (validateRelativePath(bare) !== bare || (folderPath && !value.path.endsWith('/'))))
      ctx.addIssue({ code: 'custom', message: 'Invalid resource path' });
    if (value.kind === 'file' && value.path === '') ctx.addIssue({ code: 'custom', message: 'Missing file path' });
  } catch { ctx.addIssue({ code: 'custom', message: 'Invalid resource path' }); }
  if ((value.kind === 'file') !== (value.etag !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Invalid content version' });
  if (value.kind !== 'cursor' && (value.after !== undefined || value.entryKind !== undefined))
    ctx.addIssue({ code: 'custom', message: 'Unexpected cursor state' });
  if (value.kind === 'cursor' && ((value.after === undefined) !== (value.entryKind === undefined)))
    ctx.addIssue({ code: 'custom', message: 'Incomplete cursor state' });
});

export type OperationsNativeDeliveryHandle = z.infer<typeof schema>;
type KeyEnv = Pick<Env, 'DELIVERY_SESSION_SECRET' | 'DELIVERY_PREVIOUS_SESSION_SECRET'>;
function base64(bytes: Uint8Array): string {
  let raw = ''; for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
}
async function key(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('operations-native-delivery-handle-unavailable');
  return crypto.subtle.importKey('raw', await crypto.subtle.digest('SHA-256', encoder.encode(`${PURPOSE}\0${secret}`)),
    { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
function live(expiry: number, now: number): boolean { return expiry > now && expiry <= now + TTL_MS; }

/** Exact local command comparison only; this does not replace the fresh Ops
 * authorization RPC or prove that the stored command is the current head. */
export function operationsNativeDeliveryHandleMatchesCommand(value: OperationsNativeDeliveryHandle,
  command: OperationsPortalNativeDeliveryAuthorityCommand): boolean {
  return command.action === 'delivery.grant' && command.expiresAt !== null
    && value.expires <= Date.parse(command.expiresAt)
    && value.authorityId === command.authority.authorityId && value.authorityRevision === command.authority.resultingRevision
    && value.recipientBindingId === command.recipient.recipientBindingId && value.enrollmentIntentId === command.recipient.enrollmentIntentId
    && value.targetClientRecordId === command.recipient.targetClientRecordId
    && value.issuer === command.recipient.issuer && value.subject === command.recipient.subject
    && value.targetId === command.target.targetId && value.targetRevision === command.target.targetRevision
    && value.clientAuthorityId === command.target.clientAuthorityId && value.workspaceId === command.target.workspaceId
    && value.homeOwnershipEpoch === command.recipient.homeOwnershipEpoch && value.homeGrantRevision === command.recipient.homeGrantRevision
    && value.homeGrantOperationId === command.recipient.homeGrantOperationId && value.homeRequestFingerprint === command.recipient.homeRequestFingerprint
    && value.publicationId === command.publication.publicationId && value.publicationOperationId === command.publication.operationId
    && value.publicationRevision === command.publication.revision && value.publicationSourceSequence === command.publication.sourceSequence
    && value.snapshotId === command.publication.snapshotId && value.snapshotSha256 === command.publication.snapshotSha256
    && value.folderReservationId === command.resource.folderReservationId && value.folderReservationRevision === command.resource.folderReservationRevision
    && value.clientFolderBindingId === command.resource.clientFolderBindingId && value.externalProjectId === command.resource.externalProjectId
    && value.projectVersion === command.resource.projectVersion;
}

/** A handle is an encrypted selector, never an authorization grant. The caller
 * must independently revalidate the person, home, publication and delivery pins
 * before index/R2 access and final byte handoff. No storage prefix is carried. */
export async function encodeOperationsNativeDeliveryHandle(env: KeyEnv, input: OperationsNativeDeliveryHandle): Promise<string> {
  const value = schema.parse(input);
  if (!live(value.expires, Date.now())) throw new Error('operations-native-delivery-handle-invalid');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(PREFIX) },
    await key(env.DELIVERY_SESSION_SECRET ?? ''), encoder.encode(JSON.stringify(value))));
  const bytes = new Uint8Array(iv.length + encrypted.length); bytes.set(iv); bytes.set(encrypted, iv.length);
  const result = `${PREFIX}${base64(bytes)}`;
  if (result.length > MAX_ENCODED) throw new Error('operations-native-delivery-handle-invalid');
  return result;
}

export async function decodeOperationsNativeDeliveryHandle(env: KeyEnv, input: string): Promise<OperationsNativeDeliveryHandle | null> {
  if (input.length > MAX_ENCODED || !/^ond1_[A-Za-z0-9_-]+$/u.test(input)) return null;
  const raw = input.slice(PREFIX.length); let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
    if (bytes.length < 29 || base64(bytes) !== raw) return null;
  } catch { return null; }
  for (const secret of [env.DELIVERY_SESSION_SECRET, env.DELIVERY_PREVIOUS_SESSION_SECRET]) {
    if (!secret || secret.length < 32) continue;
    try {
      const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: encoder.encode(PREFIX) },
        await key(secret), bytes.slice(12));
      const result = schema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
      if (!result.success || !live(result.data.expires, Date.now())) return null;
      return result.data;
    } catch { /* Unknown key, another protocol or tampering is never accepted. */ }
  }
  return null;
}
