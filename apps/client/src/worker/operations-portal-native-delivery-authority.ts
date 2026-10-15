import { canonicalOperationsPortalNativeDeliveryAuthorityCommand,
  canonicalOperationsPortalNativeDeliveryCancellationRequest,
  canonicalOperationsPortalNativeDeliveryAuthorityStatusRequest,
  parseOperationsPortalNativeDeliveryAuthorityCommand, parseOperationsPortalNativeDeliveryAuthorityStatusRequest,
  parseOperationsPortalNativeDeliveryAuthorityReceipt, sha256OperationsPortalNativeDeliveryAuthorityCommand,
  parseOperationsPortalNativeDeliveryCancellationRequest, type OperationsPortalNativeDeliveryAuthorityCommand, type OperationsPortalNativeDeliveryAuthorityReceipt,
} from '@ltds/shared/operations-portal-native-delivery-authority';

import { nativeDeliveryDeploymentEnabled, type NativeDeliveryDeploymentEnv } from './operations-native-delivery-deployment';

type DeliveryWriterEnv = NativeDeliveryDeploymentEnv & Readonly<{ DELIVERY_DB: D1Database; ENVIRONMENT?: string;
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED?: string;
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED?: string;
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_CANCELLATION_ENABLED?: string }>;
type ReceiptRow = { operation_id: string; request_fingerprint: string; action: 'delivery.grant' | 'delivery.revoke';
  authority_id: string; recipient_binding_id: string; folder_reservation_id: string; resulting_revision: number;
  resulting_state: 'active' | 'revoked' };
type ReplacementTip = { authority_id: string; operation_id: string; request_fingerprint: string };
const encoder = new TextEncoder();
const failure = (code: string, retryable = false) => JSON.stringify({ ok: false, protocolVersion: 1, code, retryable });
function result(row: ReceiptRow, duplicate: boolean): OperationsPortalNativeDeliveryAuthorityReceipt {
  return { protocol: 'operations-portal-native-delivery-authority', protocolVersion: 1,
    status: duplicate ? 'duplicate' : 'recorded', operationId: row.operation_id, requestFingerprint: row.request_fingerprint,
    action: row.action, authorityId: row.authority_id, recipientBindingId: row.recipient_binding_id,
    folderReservationId: row.folder_reservation_id, resultingRevision: String(row.resulting_revision), resultingState: row.resulting_state };
}
const success = (receipt: OperationsPortalNativeDeliveryAuthorityReceipt) => JSON.stringify({ ok: true, protocolVersion: 1, receipt });
async function prior(db: D1DatabaseSession, operationId: string): Promise<ReceiptRow | null> {
  return db.prepare(`SELECT operation_id,request_fingerprint,action,authority_id,recipient_binding_id,
    folder_reservation_id,resulting_revision,resulting_state FROM operations_portal_native_delivery_receipts WHERE operation_id=?`)
    .bind(operationId).first<ReceiptRow>();
}
function parseCommand(raw: unknown): OperationsPortalNativeDeliveryAuthorityCommand | null {
  if (typeof raw !== 'string' || encoder.encode(raw).byteLength > 65536) return null;
  try {
    const value = parseOperationsPortalNativeDeliveryAuthorityCommand(JSON.parse(raw));
    return value && canonicalOperationsPortalNativeDeliveryAuthorityCommand(value) === raw ? value : null;
  } catch { return null; }
}

/** Atomic private consumer only. Persistence does not grant index/R2 access:
 * readers must verify current heads, home/publication and the live Ops proof. */
export async function applyOperationsPortalNativeDeliveryAuthority(env: DeliveryWriterEnv, raw: unknown): Promise<string> {
  if (!nativeDeliveryDeploymentEnabled(env, 'rpc') || env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED !== 'true')
    return failure('disabled', true);
  const command = parseCommand(raw);
  if (!command) return failure('invalid');
  const canonical = canonicalOperationsPortalNativeDeliveryAuthorityCommand(command);
  const fingerprint = await sha256OperationsPortalNativeDeliveryAuthorityCommand(command);
  const db = env.DELIVERY_DB.withSession('first-primary');
  const state = command.action === 'delivery.grant' ? 'active' : 'revoked';
  const expected = Number(command.authority.expectedRevision), revision = Number(command.authority.resultingRevision);
  try {
    const existing = await prior(db, command.operationId);
    if (existing) {
      const receipt = parseOperationsPortalNativeDeliveryAuthorityReceipt(result(existing, true), command, fingerprint);
      return receipt ? success(receipt) : failure('conflict');
    }
    const insert = db.prepare(`INSERT INTO operations_portal_native_delivery_commands
      (operation_id,request_fingerprint,action,authority_id,recipient_binding_id,folder_reservation_id,target_id,
       expected_revision,resulting_revision,canonical_command_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
      .bind(command.operationId, fingerprint, command.action, command.authority.authorityId,
        command.recipient.recipientBindingId, command.resource.folderReservationId, command.target.targetId,
        expected, revision, canonical);
    const tips = expected === 0 ? await db.prepare(`SELECT head.authority_id,receipt.operation_id,receipt.request_fingerprint
      FROM operations_portal_native_delivery_heads head
      JOIN operations_portal_native_delivery_commands command ON command.operation_id=head.latest_operation_id
      JOIN operations_portal_native_delivery_history history ON history.operation_id=command.operation_id
      JOIN operations_portal_native_delivery_receipts receipt ON receipt.operation_id=command.operation_id
      WHERE head.recipient_binding_id=? AND head.folder_reservation_id=? AND head.target_id=? AND head.state='revoked'
        AND command.action='delivery.revoke' AND command.authority_id=head.authority_id
        AND command.resulting_revision=head.revision AND history.authority_id=head.authority_id
        AND history.revision=head.revision AND history.state='revoked'
        AND history.request_fingerprint=receipt.request_fingerprint AND receipt.authority_id=head.authority_id
        AND receipt.resulting_revision=head.revision AND receipt.resulting_state='revoked'
        AND NOT EXISTS(SELECT 1 FROM operations_portal_native_delivery_replacements replacement
          WHERE replacement.prior_authority_id=head.authority_id OR replacement.prior_revoke_operation_id=head.latest_operation_id)
      LIMIT 2`).bind(command.recipient.recipientBindingId, command.resource.folderReservationId,
        command.target.targetId).all<ReplacementTip>() : { results: [] as ReplacementTip[] };
    if (tips.results.length > 1) return failure('conflict');
    const tip = tips.results[0];
    const head = expected === 0
      ? db.prepare(`INSERT INTO operations_portal_native_delivery_heads
        (authority_id,recipient_binding_id,folder_reservation_id,target_id,revision,state,latest_operation_id) VALUES(?,?,?,?,?,?,?)`)
        .bind(command.authority.authorityId, command.recipient.recipientBindingId, command.resource.folderReservationId,
          command.target.targetId, revision, state, command.operationId)
      : db.prepare(`UPDATE operations_portal_native_delivery_heads SET revision=?,state=?,latest_operation_id=?
          WHERE authority_id=? AND recipient_binding_id=? AND folder_reservation_id=? AND target_id=? AND revision=? AND state='active'`)
        .bind(revision, state, command.operationId, command.authority.authorityId, command.recipient.recipientBindingId,
          command.resource.folderReservationId, command.target.targetId, expected);
    const replacement = tip ? db.prepare(`INSERT INTO operations_portal_native_delivery_replacements
      (new_authority_id,grant_operation_id,prior_authority_id,prior_revoke_operation_id,recipient_binding_id,
       folder_reservation_id,target_id,prior_revoke_fingerprint) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(command.authority.authorityId, command.operationId, tip.authority_id, tip.operation_id,
        command.recipient.recipientBindingId, command.resource.folderReservationId, command.target.targetId,
        tip.request_fingerprint) : null;
    await db.batch([insert, ...(replacement ? [replacement] : []), head,
      db.prepare(`INSERT INTO operations_portal_native_delivery_history
        (operation_id,authority_id,revision,state,request_fingerprint) VALUES(?,?,?,?,?)`)
        .bind(command.operationId, command.authority.authorityId, revision, state, fingerprint),
      db.prepare(`INSERT INTO operations_portal_native_delivery_receipts
        (operation_id,request_fingerprint,action,authority_id,recipient_binding_id,folder_reservation_id,resulting_revision,resulting_state)
        VALUES(?,?,?,?,?,?,?,?)`).bind(command.operationId, fingerprint, command.action, command.authority.authorityId,
          command.recipient.recipientBindingId, command.resource.folderReservationId, revision, state),
    ]);
    const saved = await prior(db, command.operationId);
    const receipt = saved && parseOperationsPortalNativeDeliveryAuthorityReceipt(result(saved, false), command, fingerprint);
    return receipt ? success(receipt) : failure('unavailable', true);
  } catch (error) {
    try {
      const saved = await prior(env.DELIVERY_DB.withSession('first-primary'), command.operationId);
      if (saved) {
        const receipt = parseOperationsPortalNativeDeliveryAuthorityReceipt(result(saved, true), command, fingerprint);
        return receipt ? success(receipt) : failure('conflict');
      }
    } catch { return failure('unavailable', true); }
    // A rejected guard/constraint is a concrete denial; operational failures
    // remain uncertain and retryable. Never expose database/provider messages.
    return error instanceof Error && /SQLITE_CONSTRAINT|native delivery .*mismatch|native delivery head requires/u.test(error.message)
      ? failure('conflict') : failure('unavailable', true);
  }
}

export async function readOperationsPortalNativeDeliveryAuthorityStatus(env: DeliveryWriterEnv, raw: unknown): Promise<string> {
  if (!nativeDeliveryDeploymentEnabled(env, 'rpc') || env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED !== 'true')
    return failure('disabled', true);
  if (typeof raw !== 'string' || encoder.encode(raw).byteLength > 2048) return failure('invalid');
  let request;
  try { request = parseOperationsPortalNativeDeliveryAuthorityStatusRequest(JSON.parse(raw));
    if (!request || canonicalOperationsPortalNativeDeliveryAuthorityStatusRequest(request) !== raw) return failure('invalid');
  } catch { return failure('invalid'); }
  try {
    const saved = await prior(env.DELIVERY_DB.withSession('first-primary'), request.operationId);
    if (!saved) return failure('not_found');
    const receipt = parseOperationsPortalNativeDeliveryAuthorityReceipt(result(saved, true), undefined, request.requestFingerprint);
    return receipt ? success(receipt) : failure('conflict');
  } catch { return failure('unavailable', true); }
}

export async function readOperationsPortalNativeDeliveryAuthorityDisposition(env: DeliveryWriterEnv, raw: unknown): Promise<string> {
  if (!nativeDeliveryDeploymentEnabled(env, 'rpc') || env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_CANCELLATION_ENABLED !== 'true') return failure('disabled', true);
  let request;
  try { request = parseOperationsPortalNativeDeliveryCancellationRequest(JSON.parse(String(raw)));
    if (!request || canonicalOperationsPortalNativeDeliveryCancellationRequest(request) !== raw) return failure('invalid'); }
  catch { return failure('invalid'); }
  if (await sha256OperationsPortalNativeDeliveryAuthorityCommand(request.command) !== request.requestFingerprint) return failure('invalid');
  const receipt = await prior(env.DELIVERY_DB.withSession('first-primary'), request.command.operationId);
  if (receipt) return JSON.stringify({ ok: true, protocolVersion: 1, disposition: 'committed', receipt: result(receipt, true) });
  const cancellation = await env.DELIVERY_DB.prepare(`SELECT * FROM operations_portal_native_delivery_cancellations WHERE operation_id=?`)
    .bind(request.command.operationId).first<Record<string, unknown>>();
  if (!cancellation) return JSON.stringify({ ok: true, protocolVersion: 1, disposition: 'not-found' });
  return JSON.stringify({ ok: true, protocolVersion: 1, disposition: 'cancelled', cancellation: {
    protocol: request.protocol, protocolVersion: 1, status: 'cancelled', operationId: cancellation.operation_id,
    requestFingerprint: cancellation.request_fingerprint, authorityId: cancellation.authority_id, targetId: cancellation.target_id,
    recipientBindingId: cancellation.recipient_binding_id, folderReservationId: cancellation.folder_reservation_id,
    expectedRevision: '0', resultingRevision: '1', cancelledAt: cancellation.cancelled_at, replayed: true } });
}

export async function cancelOperationsPortalNativeDeliveryAuthority(env: DeliveryWriterEnv, raw: unknown): Promise<string> {
  if (!nativeDeliveryDeploymentEnabled(env, 'rpc') || env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_CANCELLATION_ENABLED !== 'true') return failure('disabled', true);
  let request;
  try { request = parseOperationsPortalNativeDeliveryCancellationRequest(JSON.parse(String(raw)));
    if (!request || canonicalOperationsPortalNativeDeliveryCancellationRequest(request) !== raw) return failure('invalid'); }
  catch { return failure('invalid'); }
  if (await sha256OperationsPortalNativeDeliveryAuthorityCommand(request.command) !== request.requestFingerprint) return failure('invalid');
  const before = JSON.parse(await readOperationsPortalNativeDeliveryAuthorityDisposition(env, raw as string));
  if (before.disposition === 'committed' || before.disposition === 'cancelled') return JSON.stringify(before);
  const command = request.command;
  let inserted = false;
  try { const result = await env.DELIVERY_DB.prepare(`INSERT INTO operations_portal_native_delivery_cancellations
    (operation_id,request_fingerprint,authority_id,target_id,recipient_binding_id,folder_reservation_id,canonical_request_json)
    VALUES(?,?,?,?,?,?,?)`).bind(command.operationId, request.requestFingerprint, command.authority.authorityId,
      command.target.targetId, command.recipient.recipientBindingId, command.resource.folderReservationId, raw).run();
    inserted = result.meta.changes === 1; }
  catch { /* Resolve the concurrent committed/cancelled winner below. */ }
  const resolved = JSON.parse(await readOperationsPortalNativeDeliveryAuthorityDisposition(env, raw as string));
  if (inserted && resolved.disposition === 'cancelled') resolved.cancellation.replayed = false;
  return JSON.stringify(resolved);
}
