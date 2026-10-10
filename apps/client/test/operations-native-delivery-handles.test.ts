import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeOperationsNativeDeliveryHandle as decode, encodeOperationsNativeDeliveryHandle as encode,
  operationsNativeDeliveryHandleMatchesCommand as matches,
  type OperationsNativeDeliveryHandle } from '../src/worker/client-portal/operations-native-delivery-handles';
import { decodeNativePortalHandle, encodeNativePortalHandle } from '../src/worker/client-portal/native-portal-handles';
import type { OperationsPortalNativeDeliveryAuthorityCommand } from '@ltds/shared/operations-portal-native-delivery-authority';

const env = { DELIVERY_SESSION_SECRET: 'synthetic-primary-key-for-local-handle-tests-only' };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function handle(): OperationsNativeDeliveryHandle {
  return { v: 1, kind: 'file', authorityId: id(1), authorityRevision: '2', recipientBindingId: id(2), enrollmentIntentId: id(9),
    targetClientRecordId: 'client-one', issuer: 'https://access.synthetic.invalid', subject: 'synthetic-person',
    targetId: id(3), targetRevision: '1', clientAuthorityId: id(10), workspaceId: 'workspace-one', homeOwnershipEpoch: '1',
    homeGrantRevision: '1', homeGrantOperationId: id(4), homeRequestFingerprint: 'b'.repeat(64),
    publicationId: id(5), publicationOperationId: id(6), publicationRevision: '3', publicationSourceSequence: '2',
    snapshotId: id(7), snapshotSha256: 'a'.repeat(64),
    folderReservationId: id(8), folderReservationRevision: '1', clientFolderBindingId: 'folder-one',
    externalProjectId: 'project-one', projectVersion: '4', path: 'Photos/photo.jpg', etag: 'version-one', expires: Date.now() + 60_000 };
}
afterEach(() => vi.useRealTimers());
function command(value: OperationsNativeDeliveryHandle): OperationsPortalNativeDeliveryAuthorityCommand {
  return { protocol: 'operations-portal-native-delivery-authority', protocolVersion: 1, permissionSchemaVersion: 3,
    action: 'delivery.grant', operationId: id(11), authority: { authorityId: value.authorityId, expectedRevision: '1', resultingRevision: value.authorityRevision },
    target: { targetId: value.targetId, targetRevision: value.targetRevision, clientAuthorityId: value.clientAuthorityId,
      workspaceId: value.workspaceId, rootKind: 'standalone_client', rootRecordId: value.targetClientRecordId },
    recipient: { recipientBindingId: value.recipientBindingId, enrollmentIntentId: value.enrollmentIntentId,
      targetClientRecordId: value.targetClientRecordId, issuer: value.issuer, subject: value.subject,
      homeOwnershipEpoch: value.homeOwnershipEpoch, homeGrantRevision: value.homeGrantRevision, homeGrantOperationId: value.homeGrantOperationId,
      homeRequestFingerprint: value.homeRequestFingerprint },
    publication: { operationId: value.publicationOperationId, publicationId: value.publicationId, revision: value.publicationRevision,
      sourceSequence: value.publicationSourceSequence, snapshotId: value.snapshotId, snapshotSha256: value.snapshotSha256 },
    resource: { folderReservationId: value.folderReservationId, folderReservationRevision: value.folderReservationRevision,
      clientFolderBindingId: value.clientFolderBindingId, externalProjectId: value.externalProjectId, projectVersion: value.projectVersion,
      opsFolderProjectId: 'project-one', opsDivisionId: 'division-one', selectedR2Prefix: 'synthetic/photos/', baseR2Prefix: 'synthetic/',
      baseMatchMethod: 'manual', baseConfirmedBy: 'synthetic-owner', baseConfirmedAt: new Date().toISOString() },
    features: ['folder.list', 'file.metadata', 'file.preview', 'file.download'], expiresAt: new Date(value.expires).toISOString(),
    reasonCode: 'synthetic-test', observedAt: new Date().toISOString() };
}
describe('Operations-native encrypted resource selectors', () => {
  it('round trips all authority pins without exposing the person or resource path', async () => {
    const value = handle(), encoded = await encode(env, value);
    expect(encoded).toMatch(/^ond1_/); expect(encoded).not.toContain(value.subject); expect(encoded).not.toContain(value.path);
    expect(await decode(env, encoded)).toEqual(value);
  });
  it('uses a fresh nonce for repeated selectors', async () => {
    const value = handle(); expect(await encode(env, value)).not.toBe(await encode(env, value));
  });
  it('accepts the explicitly retained previous key and rejects unrelated keys', async () => {
    const encoded = await encode(env, handle()), rotated = { DELIVERY_SESSION_SECRET: 'another-synthetic-current-key-for-tests-only',
      DELIVERY_PREVIOUS_SESSION_SECRET: env.DELIVERY_SESSION_SECRET };
    expect(await decode(rotated, encoded)).not.toBeNull();
    expect(await decode({ DELIVERY_SESSION_SECRET: rotated.DELIVERY_SESSION_SECRET }, encoded)).toBeNull();
  });
  it('rejects expiry even when ciphertext is valid', async () => {
    vi.useFakeTimers(); const value = handle(), encoded = await encode(env, value);
    vi.setSystemTime(value.expires); expect(await decode(env, encoded)).toBeNull();
  });
  it('refuses issuance beyond fifteen minutes or at the current time', async () => {
    await expect(encode(env, { ...handle(), expires: Date.now() + 16 * 60_000 })).rejects.toThrow();
    await expect(encode(env, { ...handle(), expires: Date.now() })).rejects.toThrow();
  });
  it('rejects altered ciphertext and noncanonical encoding', async () => {
    const encoded = await encode(env, handle()), at = 40;
    expect(await decode(env, encoded.slice(0, at) + (encoded[at] === 'A' ? 'B' : 'A') + encoded.slice(at + 1))).toBeNull();
    expect(await decode(env, `${encoded}=`)).toBeNull();
    expect(await decode(env, 'ond1_' + 'A'.repeat(8192))).toBeNull();
  });
  it('cannot be confused with the existing PA-native protocol', async () => {
    const encoded = await encode(env, handle()); expect(await decodeNativePortalHandle(env, encoded)).toBeNull();
    expect(await decodeNativePortalHandle(env, encoded.replace(/^ond1_/u, 'np1_'))).toBeNull();
    const legacy = await encodeNativePortalHandle(env, { v: 1, kind: 'file', sourceId: 'project-alpha:primary', workspaceId: 'workspace',
      identityId: 'person', contextVersion: 'a'.repeat(64), bindingId: 'binding', bindingVersion: '1', grantId: 'grant', grantVersion: 1,
      bindingProof: 'b'.repeat(64), path: 'photo.jpg', etag: 'one', expires: Date.now() + 60_000 });
    expect(await decode(env, legacy)).toBeNull(); expect(await decode(env, legacy.replace(/^np1_/u, 'ond1_'))).toBeNull();
  });
  it.each(['../secret', '/absolute', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'a\u0000b'])('rejects unsafe path %s', async path => {
    await expect(encode(env, { ...handle(), path })).rejects.toThrow();
  });
  it('requires file ETag and rejects cursor state on file selectors', async () => {
    await expect(encode(env, { ...handle(), etag: undefined })).rejects.toThrow();
    await expect(encode(env, { ...handle(), after: 'next', entryKind: 'file' })).rejects.toThrow();
  });
  it('accepts a root folder and a complete bounded cursor', async () => {
    const root = { ...handle(), kind: 'folder' as const, path: '', etag: undefined };
    expect(await decode(env, await encode(env, root))).toEqual(root);
    const cursor = { ...root, kind: 'cursor' as const, after: 'photo.jpg', entryKind: 'file' as const };
    expect(await decode(env, await encode(env, cursor))).toEqual(cursor);
  });
  it('requires safe positive revisions and exact fields; storage prefixes cannot be embedded', async () => {
    await expect(encode(env, { ...handle(), authorityRevision: '9007199254740992' })).rejects.toThrow();
    await expect(encode(env, { ...handle(), homeOwnershipEpoch: '0' })).rejects.toThrow();
    await expect(encode(env, Object.assign(handle(), { selectedR2Prefix: 'private/' }))).rejects.toThrow();
  });
  it('compares every frozen pin to the exact stored delivery command', () => {
    const value = handle(), current = command(value);
    expect(matches(value, current)).toBe(true);
    const pins = ['authorityId', 'authorityRevision', 'recipientBindingId', 'enrollmentIntentId', 'targetClientRecordId', 'issuer', 'subject',
      'targetId', 'targetRevision', 'clientAuthorityId', 'workspaceId', 'homeOwnershipEpoch', 'homeGrantRevision', 'homeGrantOperationId',
      'homeRequestFingerprint', 'publicationId', 'publicationOperationId', 'publicationRevision', 'publicationSourceSequence',
      'snapshotId', 'snapshotSha256', 'folderReservationId', 'folderReservationRevision', 'clientFolderBindingId', 'externalProjectId', 'projectVersion'] as const;
    for (const pin of pins) expect(matches({ ...value, [pin]: `${value[pin]}-changed` }, current), pin).toBe(false);
    expect(matches(value, { ...current, action: 'delivery.revoke', expiresAt: null, features: [] })).toBe(false);
    expect(matches({ ...value, expires: value.expires + 1 }, current)).toBe(false);
  });
});
