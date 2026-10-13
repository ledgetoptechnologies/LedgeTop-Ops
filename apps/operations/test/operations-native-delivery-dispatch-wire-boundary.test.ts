import { describe, expect, it, vi } from 'vitest';
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand,
  parseOperationsPortalNativeDeliveryAuthorityCommand,
  sha256OperationsPortalNativeDeliveryAuthorityCommand }
  from '@ltds/shared/operations-portal-native-delivery-authority';
import { dispatchNextOperationsPortalNativeDeliveryAuthority }
  from '../src/worker/operations-portal-native-delivery-authority-dispatch';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function fixture() {
  const command = parseOperationsPortalNativeDeliveryAuthorityCommand({
    protocol: 'operations-portal-native-delivery-authority', protocolVersion: 1, permissionSchemaVersion: 3,
    action: 'delivery.revoke', operationId: id(1),
    authority: { authorityId: id(2), expectedRevision: '1', resultingRevision: '2' },
    target: { targetId: id(3), targetRevision: '2', clientAuthorityId: id(4), workspaceId: 'synthetic-workspace',
      rootKind: 'organization', rootRecordId: 'synthetic-root' },
    recipient: { recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: 'synthetic-client',
      issuer: 'https://synthetic.cloudflareaccess.com', subject: 'synthetic-recipient', homeOwnershipEpoch: '1',
      homeGrantRevision: '3', homeGrantOperationId: id(7), homeRequestFingerprint: 'a'.repeat(64) },
    publication: { operationId: id(8), publicationId: id(9), revision: '4', sourceSequence: '4',
      snapshotId: id(10), snapshotSha256: 'b'.repeat(64) },
    resource: { folderReservationId: id(11), folderReservationRevision: '5', clientFolderBindingId: 'synthetic-binding',
      externalProjectId: 'synthetic-project', projectVersion: '6', opsFolderProjectId: 'synthetic-ops-project',
      opsDivisionId: 'synthetic-division', selectedR2Prefix: 'projects/synthetic/selected/',
      baseR2Prefix: 'projects/synthetic/', baseMatchMethod: 'manual', baseConfirmedBy: 'synthetic-manager',
      baseConfirmedAt: '2026-09-30T12:00:00.000Z' },
    features: [], expiresAt: null, reasonCode: 'synthetic revoke', observedAt: '2026-09-30T12:00:00.000Z',
  });
  if (!command) throw new Error('Invalid synthetic command');
  const wire = canonicalOperationsPortalNativeDeliveryAuthorityCommand(command);
  const hash = await sha256OperationsPortalNativeDeliveryAuthorityCommand(command);
  const receipt = { protocol: command.protocol, protocolVersion: 1, status: 'recorded', operationId: command.operationId,
    requestFingerprint: hash, action: command.action, authorityId: command.authority.authorityId,
    recipientBindingId: command.recipient.recipientBindingId, folderReservationId: command.resource.folderReservationId,
    resultingRevision: command.authority.resultingRevision, resultingState: 'revoked' };
  const releases: unknown[][] = [];
  const batches: unknown[] = [];
  const prepare = (sql: string) => ({ bind: (...values: unknown[]) => ({
    first: async () => {
      if (sql.startsWith('SELECT 1 FROM operations_portal_native_delivery_authority_receipts')) return null;
      if (sql.includes('SELECT outbox.operation_id,command.action')) return { operation_id: command.operationId,
        action: command.action, request_fingerprint: hash, canonical_wire_json: wire,
        state: 'dispatching', attempt_count: 1, claim_token: values[1] };
      if (sql.includes('operations_portal_native_delivery_authority_tombstones')) return 1;
      return null;
    },
    run: async () => {
      if (sql.includes('SET state=?')) releases.push(values);
      return { meta: { changes: 1 } };
    },
  }) });
  // This is a transport/correlation unit fixture. Actual D1 guards, identity,
  // and command ownership are independently tested by the populated-D1 suite.
  const database = { withSession: () => ({ prepare,
    batch: async (statements: unknown[]) => { batches.push(statements); return []; },
  }) } as unknown as D1Database;
  return { command, wire, hash, receipt, database, releases, batches };
}

describe('native delivery dispatcher closed wire boundary', () => {
  it('acknowledges only a primitive exact correlated receipt', async () => {
    const f = await fixture();
    const status = vi.fn(async (_request: string) => JSON.stringify({ ok: true, protocolVersion: 1, receipt: f.receipt }));
    const apply = vi.fn();
    await expect(dispatchNextOperationsPortalNativeDeliveryAuthority({ database: f.database,
      operationId: f.command.operationId, binding: { getNativeDeliveryAuthorityStatus: status,
        applyNativeDeliveryAuthority: apply } })).resolves.toEqual({ operationId: f.command.operationId,
      state: 'acknowledged' });
    expect(f.batches).toHaveLength(1);
    expect(f.releases).toHaveLength(0);
    expect(apply).not.toHaveBeenCalled();
    expect(JSON.parse(status.mock.calls[0]![0] as string)).toMatchObject({
      operationId: f.command.operationId, requestFingerprint: f.hash });
  });

  it.each(['object', 'extra-envelope', 'extra-receipt', 'duplicate-key', 'wrong-operation',
    'wrong-authority', 'wrong-recipient', 'wrong-folder', 'wrong-fingerprint', 'wrong-revision'])(
    'does not acknowledge %s and retries only the exact stored revoke', async kind => {
      const f = await fixture();
      const receipt = { ...f.receipt };
      if (kind === 'wrong-operation') receipt.operationId = id(91);
      if (kind === 'wrong-authority') receipt.authorityId = id(92);
      if (kind === 'wrong-recipient') receipt.recipientBindingId = id(93);
      if (kind === 'wrong-folder') receipt.folderReservationId = id(94);
      if (kind === 'wrong-fingerprint') receipt.requestFingerprint = 'c'.repeat(64);
      if (kind === 'wrong-revision') receipt.resultingRevision = '3';
      const envelope = { ok: true, protocolVersion: 1, receipt };
      let result: unknown = JSON.stringify(envelope);
      if (kind === 'object') result = envelope;
      if (kind === 'extra-envelope') result = JSON.stringify({ ...envelope, owner: true });
      if (kind === 'extra-receipt') result = JSON.stringify({ ...envelope, receipt: { ...receipt, owner: true } });
      if (kind === 'duplicate-key') result = String(result).replace('"ok":true', '"ok":true,"ok":true');
      const status = vi.fn(async () => result), apply = vi.fn(async () => result);
      await expect(dispatchNextOperationsPortalNativeDeliveryAuthority({ database: f.database,
        operationId: f.command.operationId, binding: { getNativeDeliveryAuthorityStatus: status,
          applyNativeDeliveryAuthority: apply } })).resolves.toEqual({ operationId: f.command.operationId, state: 'retry' });
      expect(f.batches).toHaveLength(0);
      expect(apply).toHaveBeenCalledExactlyOnceWith(f.wire);
      expect(f.releases[0]?.[2]).toBe('client_receipt_invalid');
    });

  it.each(['SELECT private_client_data FROM credentials', 'x'.repeat(200), 'private\nprovider\nmessage'])(
    'does not persist unbounded or free-text RPC diagnostics: %s', async code => {
      const f = await fixture();
      const result = JSON.stringify({ ok: false, protocolVersion: 1, code, retryable: false });
      await dispatchNextOperationsPortalNativeDeliveryAuthority({ database: f.database,
        operationId: f.command.operationId, binding: { getNativeDeliveryAuthorityStatus: vi.fn(async () => result),
          applyNativeDeliveryAuthority: vi.fn(async () => result) } });
      expect(f.batches).toHaveLength(0);
      expect(f.releases[0]?.[2]).toBe('client_receipt_invalid');
    });
});
