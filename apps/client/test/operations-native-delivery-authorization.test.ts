import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand as canonical, sha256OperationsPortalNativeDeliveryAuthorityCommand as fingerprint,
  type OperationsPortalNativeDeliveryAuthorityCommand } from '@ltds/shared/operations-portal-native-delivery-authority';
import { authorizeNativeOperationsDelivery as authorize, type NativeOperationsDeliveryAuthorizationEnv,
  type NativeOperationsDeliveryAuthorizationRequest } from '../src/worker/client-portal/operations-native-delivery-authorization';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const principal = { issuer: 'https://synthetic.cloudflareaccess.com', subject: 'synthetic-recipient' };
function command(): OperationsPortalNativeDeliveryAuthorityCommand {
  return { protocol: 'operations-portal-native-delivery-authority', protocolVersion: 1, permissionSchemaVersion: 3,
    action: 'delivery.grant', operationId: id(1), authority: { authorityId: id(2), expectedRevision: '0', resultingRevision: '1' },
    target: { targetId: id(3), targetRevision: '1', clientAuthorityId: id(4), workspaceId: 'synthetic-workspace', rootKind: 'standalone_client', rootRecordId: 'synthetic-client' },
    recipient: { recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: 'synthetic-client', ...principal,
      homeOwnershipEpoch: '1', homeGrantRevision: '1', homeGrantOperationId: id(7), homeRequestFingerprint: 'a'.repeat(64) },
    publication: { operationId: id(8), publicationId: id(9), revision: '1', sourceSequence: '1', snapshotId: id(10), snapshotSha256: 'b'.repeat(64) },
    resource: { folderReservationId: id(11), folderReservationRevision: '1', clientFolderBindingId: 'synthetic-folder', externalProjectId: 'synthetic-project',
      projectVersion: '1', opsFolderProjectId: 'synthetic-physical-project', opsDivisionId: 'synthetic-division', selectedR2Prefix: 'synthetic/photos/',
      baseR2Prefix: 'synthetic/', baseMatchMethod: 'manual', baseConfirmedBy: 'synthetic-owner', baseConfirmedAt: new Date().toISOString() },
    features: ['folder.list', 'file.metadata', 'file.preview', 'file.download'], expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    reasonCode: 'synthetic-acceptance', observedAt: new Date().toISOString() };
}
function proof(value: OperationsPortalNativeDeliveryAuthorityCommand) {
  return { authorityId: value.authority.authorityId, authorityRevision: 1, recipientBindingId: value.recipient.recipientBindingId,
    enrollmentIntentId: value.recipient.enrollmentIntentId, issuer: value.recipient.issuer, subject: value.recipient.subject,
    targetId: value.target.targetId, targetRevision: 1, targetClientRecordId: value.recipient.targetClientRecordId,
    clientAuthorityId: value.target.clientAuthorityId, workspaceId: value.target.workspaceId, clientFolderBindingId: value.resource.clientFolderBindingId,
    folderReservationId: value.resource.folderReservationId, folderReservationRevision: 1, externalProjectId: value.resource.externalProjectId,
    projectVersion: 1, publicationOperationId: value.publication.operationId, publicationId: value.publication.publicationId,
    publicationRevision: 1, publicationSourceSequence: 1, publicationSnapshotId: value.publication.snapshotId, publicationSnapshotSha256: value.publication.snapshotSha256,
    homeOwnershipEpoch: 1, homeGrantRevision: 1, homeGrantOperationId: value.recipient.homeGrantOperationId,
    homeRequestFingerprint: value.recipient.homeRequestFingerprint, opsFolderProjectId: value.resource.opsFolderProjectId,
    opsDivisionId: value.resource.opsDivisionId, selectedR2Prefix: value.resource.selectedR2Prefix,
    expiresAt: value.expiresAt, features: value.features };
}
describe('native Operations delivery authorization adapter', () => {
  let value: OperationsPortalNativeDeliveryAuthorityCommand;
  let row: { canonical_command_json: string; request_fingerprint: string } | null;
  let response: unknown;
  let env: NativeOperationsDeliveryAuthorizationEnv;
  const first = vi.fn(), bind = vi.fn(), prepare = vi.fn(), withSession = vi.fn(), rpc = vi.fn();
  beforeEach(async () => {
    vi.clearAllMocks(); value = command(); row = { canonical_command_json: canonical(value), request_fingerprint: await fingerprint(value) };
    response = JSON.stringify({ ok: true, protocolVersion: 1, authorization: proof(value) });
    first.mockImplementation(async () => row); bind.mockImplementation(() => ({ first })); prepare.mockImplementation(() => ({ bind }));
    withSession.mockImplementation(() => ({ prepare })); rpc.mockImplementation(async () => response);
    // Test-only structural adapter; no production binding is weakened/cast.
    const db = { withSession } as unknown as D1Database;
    env = { DELIVERY_DB: db, ENVIRONMENT: 'staging', CLIENT_PORTAL_ORIGIN: 'https://client-staging.ledgetopdroneservices.com',
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: 'true', OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: { readNativeDeliveryAuthorization: rpc } };
  });
  afterEach(() => vi.useRealTimers());
  it('requires staging, the exact primary client origin and the enabled flag before any DB/RPC work', async () => {
    for (const override of [{ ENVIRONMENT: 'production' }, { CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: undefined },
      { CLIENT_PORTAL_ORIGIN: undefined }, { CLIENT_PORTAL_ORIGIN: 'https://portal-staging.ledgetoptechnologies.com' }]) {
      expect(await authorize({ ...env, ...override }, principal, id(2), 'folder.list')).toEqual({ ok: false, code: 'disabled' });
    }
    expect(withSession).not.toHaveBeenCalled(); expect(rpc).not.toHaveBeenCalled();
  });
  it('requires a private binding, current local view, exact person and feature', async () => {
    expect(await authorize({ ...env, OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: undefined }, principal, id(2), 'folder.list'))
      .toEqual({ ok: false, code: 'unavailable' });
    row = null; expect(await authorize(env, principal, id(2), 'folder.list')).toEqual({ ok: false, code: 'denied' });
    row = { canonical_command_json: canonical(value), request_fingerprint: await fingerprint(value) };
    expect(await authorize(env, { ...principal, subject: 'forged-person' }, id(2), 'folder.list')).toEqual({ ok: false, code: 'denied' });
    value = { ...value, features: ['folder.list'] }; row = { canonical_command_json: canonical(value), request_fingerprint: await fingerprint(value) };
    expect(await authorize(env, principal, id(2), 'file.download')).toEqual({ ok: false, code: 'denied' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('requires canonical local command bytes and their SHA-256 fingerprint', async () => {
    row!.request_fingerprint = 'c'.repeat(64);
    expect(await authorize(env, principal, id(2), 'folder.list')).toEqual({ ok: false, code: 'unavailable' });
    row = { canonical_command_json: JSON.stringify(value, null, 2), request_fingerprint: await fingerprint(value) };
    expect(await authorize(env, principal, id(2), 'folder.list')).toEqual({ ok: false, code: 'unavailable' });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('sends every private pin and checks the primary local view again after RPC', async () => {
    const result = await authorize(env, principal, id(2), 'file.download');
    expect(result).toMatchObject({ ok: true, context: { selectedR2Prefix: 'synthetic/photos/', command: value } });
    expect(first).toHaveBeenCalledTimes(2); expect(withSession).toHaveBeenNthCalledWith(1, 'first-primary');
    expect(prepare.mock.calls[0]![0]).toContain('operations_portal_native_delivery_live_heads');
    expect(bind).toHaveBeenCalledWith(id(2), principal.issuer, principal.subject);
    const request: NativeOperationsDeliveryAuthorizationRequest = rpc.mock.calls[0]![0];
    expect(Object.keys(request)).toEqual(['authorityId', 'authorityRevision', 'recipientBindingId', 'enrollmentIntentId', 'issuer', 'subject',
      'targetId', 'targetRevision', 'targetClientRecordId', 'clientAuthorityId', 'workspaceId', 'homeOwnershipEpoch', 'homeGrantRevision',
      'homeGrantOperationId', 'homeRequestFingerprint', 'publicationOperationId', 'publicationId', 'publicationRevision',
      'publicationSourceSequence', 'publicationSnapshotId', 'publicationSnapshotSha256', 'folderReservationId', 'folderReservationRevision',
      'clientFolderBindingId', 'externalProjectId', 'projectVersion', 'opsFolderProjectId', 'opsDivisionId', 'feature']);
    expect(request).toMatchObject({ issuer: principal.issuer, subject: principal.subject,
      homeRequestFingerprint: 'a'.repeat(64), publicationSourceSequence: 1, opsDivisionId: 'synthetic-division', feature: 'file.download' });
  });
  it.each(Object.keys(proof(command())))('rejects a mismatched private proof field: %s', async key => {
    response = JSON.stringify({ ok: true, protocolVersion: 1, authorization: { ...proof(value), [key]: key === 'features' ? ['folder.list'] : 'wrong' } });
    expect(await authorize(env, principal, id(2), 'file.download')).toEqual({ ok: false, code: 'unavailable' });
    expect(first).toHaveBeenCalledTimes(1);
  });
  it.each(['object', 'oversized', 'whitespace', 'unknown', 'extra-proof', 'bad-version'])('rejects malformed RPC wire: %s', async variant => {
    const valid = { ok: true, protocolVersion: 1, authorization: proof(value) };
    response = variant === 'object' ? valid : variant === 'oversized' ? ' '.repeat(16_385) : variant === 'whitespace' ? JSON.stringify(valid, null, 2)
      : variant === 'unknown' ? JSON.stringify({ ...valid, extra: true }) : variant === 'extra-proof'
        ? JSON.stringify({ ...valid, authorization: { ...proof(value), owner: true } }) : JSON.stringify({ ...valid, protocolVersion: 2 });
    expect(await authorize(env, principal, id(2), 'folder.list')).toEqual({ ok: false, code: 'unavailable' });
  });
  it('honors explicit remote denial and fails closed on a transport error', async () => {
    response = JSON.stringify({ ok: false, protocolVersion: 1, code: 'denied' });
    expect(await authorize(env, principal, id(2), 'folder.list')).toEqual({ ok: false, code: 'denied' });
    rpc.mockRejectedValue(new Error('private transient detail'));
    expect(await authorize(env, principal, id(2), 'folder.list')).toEqual({ ok: false, code: 'unavailable' });
  });
  it('rejects revoke or publication replacement while RPC is in flight', async () => {
    rpc.mockImplementation(async () => { row = null; return response; });
    expect(await authorize(env, principal, id(2), 'folder.list')).toEqual({ ok: false, code: 'denied' });
    expect(first).toHaveBeenCalledTimes(2);
  });
  it('bounds a hung private proof and never accepts a late result', async () => {
    vi.useFakeTimers(); rpc.mockImplementation(() => new Promise(() => {}));
    const result = authorize(env, principal, id(2), 'folder.list');
    // Crypto digest resolves outside the fake timer queue.
    while (!rpc.mock.calls.length) await vi.waitFor(() => expect(rpc).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(1501);
    expect(await result).toEqual({ ok: false, code: 'unavailable' }); expect(first).toHaveBeenCalledTimes(1);
  });
});
