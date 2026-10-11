import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand as canonical,
  canonicalOperationsPortalNativeDeliveryAuthorityStatusRequest,
  sha256OperationsPortalNativeDeliveryAuthorityCommand,
  type OperationsPortalNativeDeliveryAuthorityCommand } from '@ltds/shared/operations-portal-native-delivery-authority';
import { sha256OperationsPortalWorkspaceSnapshot, type OperationsPortalWorkspacePublication }
  from '@ltds/shared/operations-portal-workspace-publication';
import { consumeOperationsPortalWorkspacePublication } from '../src/worker/operations-portal-workspace-publications';
import { applyOperationsPortalNativeRecipientAuthority } from '../src/worker/operations-portal-native-recipient-authority';
import { applyOperationsPortalNativeDeliveryAuthority as apply, cancelOperationsPortalNativeDeliveryAuthority as cancel,
  readOperationsPortalNativeDeliveryAuthorityDisposition as disposition, readOperationsPortalNativeDeliveryAuthorityStatus as status }
  from '../src/worker/operations-portal-native-delivery-authority';
import { splitD1MigrationStatements } from './helpers/d1-migrations';
import { authorizeNativeOperationsDelivery, type NativeOperationsDeliveryAuthorizationRequest }
  from '../src/worker/client-portal/operations-native-delivery-authorization';
import { createOperationsNativeDeliveryRouter } from '../src/worker/client-portal/operations-native-delivery-routes';
import type { Env } from '../src/worker/types';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const issuer = 'https://synthetic.cloudflareaccess.com', subject = 'synthetic-recipient';
const actor = { staffId: 'synthetic-owner', verifiedAccessSubject: 'synthetic-owner-subject', admissionVersion: '1',
  profileVersion: '1', grantGeneration: '1', verifiedUntil: new Date(Date.now() + 3600_000).toISOString() };
function publication(): OperationsPortalWorkspacePublication {
  return { protocol: 'operations-portal-workspace-publication', protocolVersion: 1, action: 'publish',
    publicationId: id(1), operationId: id(2), expectedRevision: '0', resultingRevision: '1',
    target: { targetId: id(3), targetRevision: '1', clientAuthorityId: id(4), workspaceId: 'synthetic-workspace',
      rootKind: 'standalone_client', rootRecordId: 'synthetic-client' },
    snapshot: { snapshotId: id(5), checkpointId: id(6), sourceSequence: '1', complete: true,
      counts: { directoryRecords: 1, projects: 1, folderReservations: 1, recipientAuthorityHeads: 0, deliveryAuthorityHeads: 0 },
      snapshotSha256: '0'.repeat(64),
      directoryRecords: [{ recordId: 'synthetic-client', kind: 'client', version: '1', parentRecordId: null,
        relationshipVersion: '1', displayName: 'Synthetic Client', externalFences: [] }],
      projects: [{ externalProjectId: 'synthetic-project', version: '1', name: 'Synthetic Project', lifecycle: 'active',
        plannedStart: null, plannedEnd: null, completedAt: null, archived: true, archivedAt: new Date().toISOString(), overdueWarning: false,
        published: true, organizationRecordId: null, clientRecordId: 'synthetic-client', externalFence: null }],
      folderReservations: [{ reservationId: id(7), externalProjectId: 'synthetic-project', opsFolderProjectId: 'synthetic-physical-project',
        divisionId: 'synthetic-division', clientFolderBindingId: 'synthetic-folder', bindingVersion: '1', r2Prefix: 'synthetic/photos/', state: 'active' }],
      recipientAuthorityHeads: [], deliveryAuthorityHeads: [] }, actorProof: actor, observedAt: new Date().toISOString() };
}

describe('Operations-native delivery consumer with real forward schemas and producers', () => {
  let runtime: Miniflare, db: D1Database, bucket: R2Bucket, published: OperationsPortalWorkspacePublication, homeFingerprint: string;
  const env = () => ({ DELIVERY_DB: db, ENVIRONMENT: 'staging', CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: 'true',
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED: 'true' });
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: '2026-08-06', script: 'export default {}',
      d1Databases: { DELIVERY_DB: crypto.randomUUID() }, r2Buckets: { DATA_BUCKET: crypto.randomUUID() } });
    // Test-only adapter between independently generated Miniflare/platform declarations.
    db = await runtime.getD1Database('DELIVERY_DB') as unknown as D1Database;
    bucket = await runtime.getR2Bucket('DATA_BUCKET') as unknown as R2Bucket;
    await db.batch(splitD1MigrationStatements(readFileSync(new URL('../migrations/0008_trash_tombstones.sql', import.meta.url), 'utf8'))
      .map(statement => db.prepare(statement)));
    for (const name of ['0223_operations_portal_workspace_publications.sql', '0224_operations_portal_native_recipient_authority.sql',
      '0225_operations_portal_workspace_publication_cancellations.sql', '0226_operations_portal_native_workspace_cleanup.sql',
      '0227_operations_portal_native_delivery_authority.sql', '0228_operations_portal_native_content_start_audit.sql']) {
      const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
      await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    }
    // Storage-index fixtures only; all authorization tables and writes above
    // use the actual reviewed forward schemas and producer implementations.
    const object = await bucket.put('synthetic/photos/photo.jpg', new Uint8Array(42), { httpMetadata: { contentType: 'image/jpeg' } });
    expect(object).not.toBeNull();
    await db.batch([
      db.prepare('CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT,size INTEGER,uploaded_at TEXT,content_type TEXT,media_kind TEXT)'),
      db.prepare("INSERT INTO file_index VALUES('synthetic/photos/photo.jpg',?,42,?,'image/jpeg','image')").bind(object!.etag, new Date().toISOString()),
      db.prepare("INSERT INTO file_index VALUES('synthetic/photos/nested/photo.jpg','fixture-etag',42,?,'image/jpeg','image')").bind(new Date().toISOString()),
      db.prepare("INSERT INTO file_index VALUES('synthetic/photos/_ltds/hidden.jpg','fixture-etag',42,?,'image/jpeg','image')").bind(new Date().toISOString()),
      db.prepare("INSERT INTO file_index VALUES('another-client/photo.jpg','fixture-etag',42,?,'image/jpeg','image')").bind(new Date().toISOString()),
    ]);
    published = publication();
    published = { ...published, snapshot: { ...published.snapshot, snapshotSha256: await sha256OperationsPortalWorkspaceSnapshot(published) } };
    const receipt = await consumeOperationsPortalWorkspacePublication(db, published);
    const home = { protocol: 'operations-portal-native-authority', protocolVersion: 1, permissionSchemaVersion: 3,
      action: 'recipient.grant', operationId: id(8), target: published.target,
      recipient: { recipientBindingId: id(9), enrollmentIntentId: id(10), targetClientRecordId: 'synthetic-client', issuer, subject },
      expected: { ownershipEpoch: '0', grantRevision: '0' }, resulting: { ownershipEpoch: '1', grantRevision: '1' },
      permissions: ['operations.service_home.read'], expiresAt: null,
      publication: { operationId: published.operationId, publicationId: published.publicationId, revision: '1', sourceSequence: '1',
        snapshotId: published.snapshot.snapshotId, snapshotSha256: published.snapshot.snapshotSha256, requestFingerprint: receipt.requestFingerprint },
      actorProof: actor, observedAt: new Date().toISOString() };
    const granted = JSON.parse(await applyOperationsPortalNativeRecipientAuthority({ DELIVERY_DB: db, ENVIRONMENT: 'staging',
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: 'true' }, JSON.stringify(home)));
    expect(granted.ok).toBe(true); homeFingerprint = granted.requestFingerprint;
  }, 120_000);
  afterAll(async () => { await runtime?.dispose(); });
  function grant(): OperationsPortalNativeDeliveryAuthorityCommand {
    return { protocol: 'operations-portal-native-delivery-authority', protocolVersion: 1, permissionSchemaVersion: 3,
      action: 'delivery.grant', operationId: id(11), authority: { authorityId: id(12), expectedRevision: '0', resultingRevision: '1' },
      target: published.target, recipient: { recipientBindingId: id(9), enrollmentIntentId: id(10), targetClientRecordId: 'synthetic-client',
        issuer, subject, homeOwnershipEpoch: '1', homeGrantRevision: '1', homeGrantOperationId: id(8), homeRequestFingerprint: homeFingerprint },
      publication: { operationId: published.operationId, publicationId: published.publicationId, revision: '1', sourceSequence: '1',
        snapshotId: published.snapshot.snapshotId, snapshotSha256: published.snapshot.snapshotSha256 },
      resource: { folderReservationId: id(7), folderReservationRevision: '1', clientFolderBindingId: 'synthetic-folder',
        externalProjectId: 'synthetic-project', projectVersion: '1', opsFolderProjectId: 'synthetic-physical-project', opsDivisionId: 'synthetic-division',
        selectedR2Prefix: 'synthetic/photos/', baseR2Prefix: 'synthetic/', baseMatchMethod: 'manual', baseConfirmedBy: 'synthetic-owner',
        baseConfirmedAt: new Date().toISOString() }, features: ['folder.list', 'file.metadata', 'file.preview', 'file.download'],
      expiresAt: new Date(Date.now() + 3600_000).toISOString(), reasonCode: 'synthetic-acceptance', observedAt: new Date().toISOString() };
  }
  async function applyInitialLegacyGrant(command: OperationsPortalNativeDeliveryAuthorityCommand) {
    const wire = canonical(command), fingerprint = await sha256OperationsPortalNativeDeliveryAuthorityCommand(command);
    await db.batch([
      db.prepare(`INSERT INTO operations_portal_native_delivery_commands
        (operation_id,request_fingerprint,action,authority_id,recipient_binding_id,folder_reservation_id,target_id,
         expected_revision,resulting_revision,canonical_command_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .bind(command.operationId, fingerprint, command.action, command.authority.authorityId,
          command.recipient.recipientBindingId, command.resource.folderReservationId, command.target.targetId, 0, 1, wire),
      db.prepare(`INSERT INTO operations_portal_native_delivery_heads
        (authority_id,recipient_binding_id,folder_reservation_id,target_id,revision,state,latest_operation_id)
        VALUES(?,?,?,?,1,'active',?)`).bind(command.authority.authorityId, command.recipient.recipientBindingId,
          command.resource.folderReservationId, command.target.targetId, command.operationId),
      db.prepare(`INSERT INTO operations_portal_native_delivery_history
        (operation_id,authority_id,revision,state,request_fingerprint) VALUES(?,?,1,'active',?)`)
        .bind(command.operationId, command.authority.authorityId, fingerprint),
      db.prepare(`INSERT INTO operations_portal_native_delivery_receipts
        (operation_id,request_fingerprint,action,authority_id,recipient_binding_id,folder_reservation_id,resulting_revision,resulting_state)
        VALUES(?,?,?,?,?,?,1,'active')`).bind(command.operationId, fingerprint, command.action,
          command.authority.authorityId, command.recipient.recipientBindingId, command.resource.folderReservationId),
    ]);
    return { ok: true, protocolVersion: 1, receipt: { protocol: command.protocol, protocolVersion: 1, status: 'recorded',
      operationId: command.operationId, requestFingerprint: fingerprint, action: command.action,
      authorityId: command.authority.authorityId, recipientBindingId: command.recipient.recipientBindingId,
      folderReservationId: command.resource.folderReservationId, resultingRevision: '1', resultingState: 'active' } };
  }
  it('is default-off and production-off before database work', async () => {
    const inactive = { DELIVERY_DB: {} as D1Database, ENVIRONMENT: 'production',
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: 'true', CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED: 'true' };
    expect(JSON.parse(await apply(inactive, '{}'))).toMatchObject({ ok: false, code: 'disabled' });
    expect(JSON.parse(await status(inactive, '{}'))).toMatchObject({ ok: false, code: 'disabled' });
    expect(JSON.parse(await apply({ ...inactive, ENVIRONMENT: 'staging', CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: undefined }, '{}')))
      .toMatchObject({ ok: false, code: 'disabled' });
  });
  it('rejects wrong person, folder, snapshot, project and expiry with atomic rollback', async () => {
    const value = grant();
    const variants = [
      { ...value, recipient: { ...value.recipient, subject: 'other-person' } },
      { ...value, resource: { ...value.resource, folderReservationRevision: '2' } },
      { ...value, publication: { ...value.publication, snapshotSha256: 'f'.repeat(64) } },
      { ...value, resource: { ...value.resource, projectVersion: '2' } },
      { ...value, expiresAt: new Date(Date.now() - 60_000).toISOString() },
      { ...value, expiresAt: new Date(Date.now() + 31 * 86400_000).toISOString() },
    ];
    for (const candidate of variants) {
      let wire: string;
      try { wire = canonical(candidate); } catch { wire = JSON.stringify(candidate); }
      expect(JSON.parse(await apply(env(), wire)).ok).toBe(false);
      expect(await db.prepare('SELECT count(*) n FROM operations_portal_native_delivery_commands').first('n')).toBe(0);
      expect(await db.prepare('SELECT count(*) n FROM operations_portal_native_delivery_receipts').first('n')).toBe(0);
    }
  });
  it('allows explicitly shared archived history, replays exactly, rejects retargeting and revokes after upstream drift', async () => {
    const value = grant(), wire = canonical(value), first = await applyInitialLegacyGrant(value);
    expect(first).toMatchObject({ ok: true, receipt: { status: 'recorded', authorityId: id(12), resultingRevision: '1', resultingState: 'active' } });
    expect(await db.prepare('SELECT count(*) n FROM operations_portal_native_delivery_live_heads').first('n')).toBe(1);
    let privateReads = 0;
    // Transport stand-in returns the exact supported server proof. Actual Ops
    // physical-folder joins are independently covered by its issuer/reader suite.
    const reader = { async readNativeDeliveryAuthorization(input: NativeOperationsDeliveryAuthorizationRequest) {
      privateReads++; const { feature: _feature, ...pins } = input;
      return JSON.stringify({ ok: true, protocolVersion: 1, authorization: { ...pins,
        selectedR2Prefix: value.resource.selectedR2Prefix, expiresAt: value.expiresAt, features: value.features } });
    } };
    const readEnv = { ...env(), CLIENT_PORTAL_ORIGIN: 'https://client-staging.ledgetopdroneservices.com',
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: 'true', OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: reader };
    expect(await authorizeNativeOperationsDelivery(readEnv, { issuer, subject }, id(12), 'folder.list')).toMatchObject({ ok: true });
    const callsBeforeWrongPerson = privateReads;
    expect(await authorizeNativeOperationsDelivery(readEnv, { issuer, subject: 'another-person' }, id(12), 'folder.list')).toEqual({ ok: false, code: 'denied' });
    expect(privateReads).toBe(callsBeforeWrongPerson);
    const portalOrigin = 'https://client-staging.ledgetopdroneservices.com';
    const portalEnv = { ...readEnv, CLIENT_PORTAL_ENABLED: 'true', CLIENT_PORTAL_ORIGIN: portalOrigin, DELIVERY_SESSION_SECRET: 's'.repeat(48),
      DATA_BUCKET: bucket, CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED: 'true',
      CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET: 'synthetic-separate-audit-key-32-bytes-minimum' };
    const router = createOperationsNativeDeliveryRouter({ resolvePrincipal: async () => ({ issuer, subject, email: 'synthetic@example.test' }) });
    // Test-only structural full Env adapter: unrelated Worker bindings are not used.
    const discovery = await router.fetch(new Request(`${portalOrigin}/deliveries`), portalEnv as unknown as Env);
    expect(discovery.status).toBe(200);
    const deliveries = await discovery.json() as { items: Array<{ id: string; displayName: string }> };
    expect(deliveries.items).toHaveLength(1); expect(deliveries.items[0]!.displayName).toBe('Synthetic Project');
    const folderUrl = `${portalOrigin}/folders/${encodeURIComponent(deliveries.items[0]!.id)}`;
    const listing = await router.fetch(new Request(folderUrl), portalEnv as unknown as Env);
    expect(listing.status).toBe(200);
    const contents = await listing.json() as { files: Array<{ id: string; name: string }>; folders: Array<{ name: string }> };
    expect(contents.files.map(file => file.name)).toEqual(['photo.jpg']); expect(contents.folders.map(folder => folder.name)).toEqual(['nested']);
    expect(JSON.stringify(contents)).not.toContain('synthetic/photos/');
    expect((await router.fetch(new Request(`${portalOrigin}/files/${encodeURIComponent(contents.files[0]!.id)}`), portalEnv as unknown as Env)).status).toBe(200);
    const downloadUrl = `${portalOrigin}/files/${encodeURIComponent(contents.files[0]!.id)}/download`;
    const download = await router.fetch(new Request(downloadUrl), portalEnv as unknown as Env);
    expect(download.status).toBe(200); expect(new Uint8Array(await download.arrayBuffer())).toEqual(new Uint8Array(42));
    expect(await db.prepare("SELECT count(*) n FROM operations_portal_native_content_start_events WHERE action='file.download_requested'").first('n')).toBe(1);
    const ranged = await router.fetch(new Request(downloadUrl, { headers: { Range: 'bytes=0-1' } }), portalEnv as unknown as Env);
    expect(ranged.status).toBe(206); expect(ranged.headers.get('Content-Range')).toBe('bytes 0-1/42');
    expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(new Uint8Array(2));
    const noAudit = await router.fetch(new Request(downloadUrl), { ...portalEnv, CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET: undefined } as unknown as Env);
    expect(noAudit.status).toBe(503); expect(await noAudit.text()).not.toContain('synthetic/photos/');
    expect(JSON.parse(await apply(env(), wire))).toMatchObject({ ok: true, receipt: { status: 'duplicate' } });
    expect(JSON.parse(await apply(env(), canonical({ ...value, reasonCode: 'altered' })))).toMatchObject({ ok: false, code: 'conflict' });
    const request = canonicalOperationsPortalNativeDeliveryAuthorityStatusRequest({ protocol: value.protocol, protocolVersion: 1,
      operationId: value.operationId, requestFingerprint: first.receipt.requestFingerprint });
    expect(JSON.parse(await status(env(), request))).toMatchObject({ ok: true, receipt: { status: 'duplicate' } });
    const retarget = { ...value, operationId: id(13), authority: { ...value.authority, expectedRevision: '1', resultingRevision: '2' },
      recipient: { ...value.recipient, subject: 'other-person' } };
    expect(JSON.parse(await apply(env(), canonical(retarget))).ok).toBe(false);
    const next = { ...published, operationId: id(14), publicationId: id(15), expectedRevision: '1', resultingRevision: '2',
      snapshot: { ...published.snapshot, snapshotId: id(16), checkpointId: id(17), sourceSequence: '2', snapshotSha256: '0'.repeat(64) } };
    const drifted = { ...next, snapshot: { ...next.snapshot, snapshotSha256: await sha256OperationsPortalWorkspaceSnapshot(next) } };
    await consumeOperationsPortalWorkspacePublication(db, drifted);
    expect(await db.prepare('SELECT count(*) n FROM operations_portal_native_delivery_locally_authorized_commands').first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM operations_portal_native_delivery_live_heads').first('n')).toBe(0);
    const beforeDriftedRead = privateReads;
    expect(await authorizeNativeOperationsDelivery(readEnv, { issuer, subject }, id(12), 'folder.list')).toEqual({ ok: false, code: 'denied' });
    expect((await router.fetch(new Request(folderUrl), portalEnv as unknown as Env)).status).toBe(404);
    expect((await router.fetch(new Request(downloadUrl), portalEnv as unknown as Env)).status).toBe(404);
    expect(privateReads).toBe(beforeDriftedRead);
    const revoke = { ...value, action: 'delivery.revoke' as const, operationId: id(18),
      authority: { ...value.authority, expectedRevision: '1', resultingRevision: '2' }, features: [], expiresAt: null };
    expect(JSON.parse(await apply(env(), canonical(revoke)))).toMatchObject({ ok: true, receipt: { resultingState: 'revoked', resultingRevision: '2' } });
    expect(JSON.parse(await apply(env(), canonical(revoke)))).toMatchObject({ ok: true, receipt: { status: 'duplicate' } });
    expect(await db.prepare("SELECT state FROM operations_portal_native_delivery_heads WHERE authority_id=?").bind(id(12)).first('state')).toBe('revoked');
    expect(await db.prepare('SELECT count(*) n FROM operations_portal_native_delivery_live_heads').first('n')).toBe(0);
    const retainedBefore = await db.prepare(`SELECT
      (SELECT json_group_array(json_object('authority_id',authority_id,'recipient_binding_id',recipient_binding_id,
        'folder_reservation_id',folder_reservation_id,'target_id',target_id,'revision',revision,'state',state,
        'latest_operation_id',latest_operation_id)) FROM operations_portal_native_delivery_heads) heads,
      (SELECT json_group_array(json_object('operation_id',operation_id,'request_fingerprint',request_fingerprint,
        'action',action,'authority_id',authority_id,'recipient_binding_id',recipient_binding_id,
        'folder_reservation_id',folder_reservation_id,'resulting_revision',resulting_revision,
        'resulting_state',resulting_state)) FROM operations_portal_native_delivery_receipts) receipts,
      (SELECT json_group_array(json_object('operation_id',operation_id,'authority_id',authority_id,'revision',revision,
        'state',state,'request_fingerprint',request_fingerprint)) FROM operations_portal_native_delivery_history) history`)
      .first<Record<string, unknown>>();
    const triggersBefore = (await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'operations_native_delivery_%' ORDER BY name")
      .all<{ name: string }>()).results.map(row => row.name);
    const regrantSql = readFileSync(new URL('../migrations/0229_operations_portal_native_delivery_regrant.sql', import.meta.url), 'utf8');
    await db.batch(splitD1MigrationStatements(regrantSql).map(statement => db.prepare(statement)));
    const cancellationSql = readFileSync(new URL('../migrations/0230_operations_portal_native_delivery_terminal_cancellations.sql', import.meta.url), 'utf8');
    await db.batch(splitD1MigrationStatements(cancellationSql).map(statement => db.prepare(statement)));
    const committedCancellationRequest = JSON.stringify({ protocol: value.protocol, protocolVersion: 1,
      command: value, requestFingerprint: first.receipt.requestFingerprint });
    const cancellationEnv = { ...env(), CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_CANCELLATION_ENABLED: 'true' };
    expect(JSON.parse(await disposition(cancellationEnv, committedCancellationRequest))).toMatchObject({ ok: true,
      disposition: 'committed', receipt: { operationId: value.operationId } });
    expect(JSON.parse(await cancel(cancellationEnv, committedCancellationRequest))).toMatchObject({ ok: true,
      disposition: 'committed', receipt: { operationId: value.operationId } });
    const retainedAfter = await db.prepare(`SELECT
      (SELECT json_group_array(json_object('authority_id',authority_id,'recipient_binding_id',recipient_binding_id,
        'folder_reservation_id',folder_reservation_id,'target_id',target_id,'revision',revision,'state',state,
        'latest_operation_id',latest_operation_id)) FROM operations_portal_native_delivery_heads) heads,
      (SELECT json_group_array(json_object('operation_id',operation_id,'request_fingerprint',request_fingerprint,
        'action',action,'authority_id',authority_id,'recipient_binding_id',recipient_binding_id,
        'folder_reservation_id',folder_reservation_id,'resulting_revision',resulting_revision,
        'resulting_state',resulting_state)) FROM operations_portal_native_delivery_receipts) receipts,
      (SELECT json_group_array(json_object('operation_id',operation_id,'authority_id',authority_id,'revision',revision,
        'state',state,'request_fingerprint',request_fingerprint)) FROM operations_portal_native_delivery_history) history`)
      .first<Record<string, unknown>>();
    expect(retainedAfter).toEqual(retainedBefore);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    const triggersAfter = (await db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'operations_native_delivery_%' ORDER BY name")
      .all<{ name: string }>()).results.map(row => row.name);
    expect(triggersAfter).toEqual([...triggersBefore,
      'operations_native_delivery_replacement_delete', 'operations_native_delivery_replacement_grant_guard',
      'operations_native_delivery_replacement_insert', 'operations_native_delivery_replacement_update',
      'operations_native_delivery_cancellation_delete', 'operations_native_delivery_cancellation_insert',
      'operations_native_delivery_cancellation_update', 'operations_native_delivery_cancelled_command_insert'].sort());
    const replacement = { ...value, operationId: id(19), authority: { authorityId: id(20), expectedRevision: '0', resultingRevision: '1' },
      publication: { operationId: drifted.operationId, publicationId: drifted.publicationId, revision: '2', sourceSequence: '2',
        snapshotId: drifted.snapshot.snapshotId, snapshotSha256: drifted.snapshot.snapshotSha256 } };
    const revokedLineage = await db.prepare(`SELECT command.operation_id,command.request_fingerprint command_fingerprint,
      receipt.request_fingerprint receipt_fingerprint,receipt.action,receipt.recipient_binding_id,
      receipt.folder_reservation_id,head.latest_operation_id
      FROM operations_portal_native_delivery_heads head
      JOIN operations_portal_native_delivery_commands command ON command.operation_id=head.latest_operation_id
      JOIN operations_portal_native_delivery_receipts receipt ON receipt.operation_id=command.operation_id
      WHERE head.authority_id=?`).bind(id(12)).first<Record<string, unknown>>();
    expect(revokedLineage).toMatchObject({ operation_id: id(18), action: 'delivery.revoke',
        recipient_binding_id: id(9), folder_reservation_id: id(7), latest_operation_id: id(18),
        command_fingerprint: expect.any(String), receipt_fingerprint: expect.any(String) });
    expect(revokedLineage?.command_fingerprint).toBe(revokedLineage?.receipt_fingerprint);
    expect(await db.prepare(`SELECT count(*) n FROM operations_portal_native_delivery_heads prior
      JOIN operations_portal_native_delivery_commands revoke_command ON revoke_command.operation_id=prior.latest_operation_id
      JOIN operations_portal_native_delivery_history revoke_history ON revoke_history.operation_id=revoke_command.operation_id
      JOIN operations_portal_native_delivery_receipts revoke_receipt ON revoke_receipt.operation_id=revoke_command.operation_id
      WHERE prior.authority_id=? AND prior.state='revoked' AND prior.recipient_binding_id=?
       AND prior.folder_reservation_id=? AND prior.target_id=? AND revoke_command.action='delivery.revoke'
       AND revoke_command.request_fingerprint=revoke_receipt.request_fingerprint
       AND revoke_receipt.action='delivery.revoke' AND revoke_receipt.recipient_binding_id=?
       AND revoke_receipt.folder_reservation_id=? AND revoke_history.request_fingerprint=revoke_receipt.request_fingerprint`)
      .bind(id(12), id(9), id(7), published.target.targetId, id(9), id(7)).first('n')).toBe(1);
    const forged = { ...replacement, operationId: id(23), authority: { authorityId: id(24), expectedRevision: '0', resultingRevision: '1' } };
    const forgedWire = canonical(forged), forgedFingerprint = await sha256OperationsPortalNativeDeliveryAuthorityCommand(forged);
    await db.prepare(`INSERT INTO operations_portal_native_delivery_commands
      (operation_id,request_fingerprint,action,authority_id,recipient_binding_id,folder_reservation_id,target_id,
       expected_revision,resulting_revision,canonical_command_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(forged.operationId, forgedFingerprint, forged.action, forged.authority.authorityId,
        forged.recipient.recipientBindingId, forged.resource.folderReservationId, forged.target.targetId, 0, 1, forgedWire).run();
    const replacementInsert = (priorOperationId: string, priorFingerprint: string) => db.prepare(`INSERT INTO operations_portal_native_delivery_replacements
      (new_authority_id,grant_operation_id,prior_authority_id,prior_revoke_operation_id,recipient_binding_id,
       folder_reservation_id,target_id,prior_revoke_fingerprint) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(forged.authority.authorityId, forged.operationId, id(12), priorOperationId, id(9), id(7),
        published.target.targetId, priorFingerprint);
    await expect(replacementInsert(id(11), String(revokedLineage?.receipt_fingerprint)).run()).rejects.toThrow();
    await expect(replacementInsert(id(18), String(first.receipt.requestFingerprint)).run()).rejects.toThrow();
    expect(await db.prepare('SELECT count(*) n FROM operations_portal_native_delivery_replacements').first('n')).toBe(0);
    expect(JSON.parse(await apply(env(), canonical(replacement)))).toMatchObject({ ok: true,
      receipt: { status: 'recorded', authorityId: id(20), resultingRevision: '1', resultingState: 'active' } });
    expect(await db.prepare('SELECT count(*) n FROM operations_portal_native_delivery_replacements').first('n')).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM operations_portal_native_delivery_heads WHERE state='revoked'").first('n')).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM operations_portal_native_delivery_heads WHERE state='active'").first('n')).toBe(1);
    const competing = { ...replacement, operationId: id(21), authority: { authorityId: id(22), expectedRevision: '0', resultingRevision: '1' } };
    expect(JSON.parse(await apply(env(), canonical(competing)))).toMatchObject({ ok: false, code: 'conflict' });
    expect(JSON.parse(await apply(env(), canonical(replacement)))).toMatchObject({ ok: true, receipt: { status: 'duplicate' } });
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    await expect(db.prepare('DELETE FROM operations_portal_native_delivery_heads').run()).rejects.toThrow();
  });
  it('records only an expired never-materialized grant cancellation and blocks delayed apply', async () => {
    const command = { ...grant(), operationId: id(30), authority: { authorityId: id(31), expectedRevision: '0', resultingRevision: '1' },
      resource: { ...grant().resource, folderReservationId: id(32) }, observedAt: new Date(Date.now() - 120_000).toISOString(),
      expiresAt: new Date(Date.now() - 60_000).toISOString() };
    const request = { protocol: command.protocol, protocolVersion: 1 as const, command,
      requestFingerprint: await sha256OperationsPortalNativeDeliveryAuthorityCommand(command) };
    const raw = JSON.stringify(request), cancellationEnv = { ...env(), CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_CANCELLATION_ENABLED: 'true' };
    expect(JSON.parse(await disposition(cancellationEnv, raw))).toMatchObject({ ok: true, disposition: 'not-found' });
    for (const poisonedTimestamp of ['zzzz', new Date(Date.now() + 60_000).toISOString()]) {
      await expect(db.prepare(`INSERT INTO operations_portal_native_delivery_cancellations
        (operation_id,request_fingerprint,authority_id,target_id,recipient_binding_id,folder_reservation_id,
         canonical_request_json,cancelled_at) VALUES(?,?,?,?,?,?,?,?)`)
        .bind(command.operationId,request.requestFingerprint,command.authority.authorityId,command.target.targetId,
          command.recipient.recipientBindingId,command.resource.folderReservationId,raw,poisonedTimestamp).run())
        .rejects.toThrow('cancellation denied');
    }
    expect(JSON.parse(await cancel(cancellationEnv, raw))).toMatchObject({ ok: true, disposition: 'cancelled',
      cancellation: { operationId: id(30), authorityId: id(31), replayed: false } });
    expect(JSON.parse(await cancel(cancellationEnv, raw))).toMatchObject({ ok: true, disposition: 'cancelled',
      cancellation: { replayed: true } });
    expect(JSON.parse(await apply(env(), canonical(command)))).toMatchObject({ ok: false, code: 'conflict' });
    expect(await db.prepare('SELECT count(*) n FROM operations_portal_native_delivery_commands WHERE operation_id=?').bind(id(30)).first('n')).toBe(0);
    await expect(db.prepare('DELETE FROM operations_portal_native_delivery_cancellations WHERE operation_id=?').bind(id(30)).run()).rejects.toThrow();
  });
});
