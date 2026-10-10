import {
  canonicalOperationsPortalNativeDeliveryAuthorityStatusRequest,
  parseOperationsPortalNativeDeliveryAuthorityCommand,
  parseOperationsPortalNativeDeliveryAuthorityReceipt,
  type OperationsPortalNativeDeliveryAuthorityBinding,
  type OperationsPortalNativeDeliveryAuthorityCommand,
  type OperationsPortalNativeDeliveryAuthorityReceipt,
} from "@ltds/shared/operations-portal-native-delivery-authority";
import { verifyOperationsPortalNativeDeliveryGrantForDispatch }
  from "./operations-portal-native-delivery-authority-reader";
import { claimOperationsPortalNativeDeliveryRecoveryInvocation,
  currentOperationsPortalNativeDeliveryRecoveryInvocation }
  from "./operations-portal-native-delivery-recovery-invocations";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const encoder = new TextEncoder();
const MAX_GRANT_ATTEMPTS = 8;
type OutboxRow = { operation_id: string; action: "delivery.grant" | "delivery.revoke";
  request_fingerprint: string; canonical_wire_json: string;
  state: string; attempt_count: number; claim_token: string | null };

export type OperationsPortalNativeDeliveryAuthorityDispatchEnv = Readonly<{
  OPS_DB: D1Database; ENVIRONMENT?: string; EXPECTED_HOST?: string;
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY?: OperationsPortalNativeDeliveryAuthorityBinding;
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED?: string;
}>;

async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function envelope(value: unknown): { receipt?: unknown; code?: string; retryable?: boolean } | null {
  if (typeof value !== "string" || encoder.encode(value).byteLength > 131_072) return null;
  let parsed: unknown; try { parsed = JSON.parse(value); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || JSON.stringify(parsed) !== value) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (record.ok === true && record.protocolVersion === 1 && keys.length === 3
    && keys.every(key => ["ok", "protocolVersion", "receipt"].includes(key)) && Object.hasOwn(record, "receipt"))
    return { receipt: record.receipt };
  if (record.ok === false && record.protocolVersion === 1 && keys.length === 4
    && keys.every(key => ["ok", "protocolVersion", "code", "retryable"].includes(key))
    && typeof record.code === "string" && /^[a-z][a-z0-9_]{0,79}$/u.test(record.code)
    && typeof record.retryable === "boolean") return { code: record.code, retryable: record.retryable };
  return null;
}
function readerInput(command: OperationsPortalNativeDeliveryAuthorityCommand) {
  return { authorityId: command.authority.authorityId, authorityRevision: Number(command.authority.resultingRevision),
    recipientBindingId: command.recipient.recipientBindingId, enrollmentIntentId: command.recipient.enrollmentIntentId,
    issuer: command.recipient.issuer,
    subject: command.recipient.subject, targetId: command.target.targetId, targetRevision: Number(command.target.targetRevision),
    targetClientRecordId: command.recipient.targetClientRecordId, clientAuthorityId: command.target.clientAuthorityId,
    workspaceId: command.target.workspaceId, homeOwnershipEpoch: Number(command.recipient.homeOwnershipEpoch),
    homeGrantRevision: Number(command.recipient.homeGrantRevision), homeGrantOperationId: command.recipient.homeGrantOperationId,
    homeRequestFingerprint: command.recipient.homeRequestFingerprint, publicationOperationId: command.publication.operationId,
    publicationId: command.publication.publicationId, publicationRevision: Number(command.publication.revision),
    publicationSourceSequence: Number(command.publication.sourceSequence), publicationSnapshotId: command.publication.snapshotId,
    publicationSnapshotSha256: command.publication.snapshotSha256, folderReservationId: command.resource.folderReservationId,
    folderReservationRevision: Number(command.resource.folderReservationRevision),
    clientFolderBindingId: command.resource.clientFolderBindingId, externalProjectId: command.resource.externalProjectId,
    projectVersion: Number(command.resource.projectVersion), opsFolderProjectId: command.resource.opsFolderProjectId,
    opsDivisionId: command.resource.opsDivisionId, feature: command.features[0]! };
}

async function currentGrantFresh(rootDatabase: D1Database, database: D1DatabaseSession,
  command: OperationsPortalNativeDeliveryAuthorityCommand) {
  if (!await verifyOperationsPortalNativeDeliveryGrantForDispatch(rootDatabase, readerInput(command))) return false;
  return Boolean(await database.prepare(`SELECT 1 FROM operations_portal_native_delivery_authority_commands command
    JOIN operations_portal_native_delivery_authorizations authorization ON authorization.operation_id=command.operation_id
    JOIN native_staff_admissions admission ON admission.staff_id=authorization.authorized_by_staff_id AND admission.active=1
      AND admission.bound_access_subject=authorization.authorized_access_subject
      AND admission.version=authorization.authorized_admission_version
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
      AND profile.login_email=authorization.authorized_email AND profile.version=authorization.authorized_profile_version
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
      AND generation.generation=authorization.authorized_grant_generation
    WHERE command.operation_id=? AND command.action='delivery.grant'
      AND authorization.authorized_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global') OR
          (role.role_id='role-division-manager' AND role.scope='division' AND role.division_id=command.ops_division_id)))
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow' AND permission.record_id=command.root_record_id)
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny' AND permission.record_id=command.root_record_id)
      AND (SELECT count(DISTINCT permission.permission_key) FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow'
          AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.create')
          AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=command.ops_division_id)))=3
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny'
          AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.create')
          AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=command.ops_division_id)))`)
    .bind(command.operationId).first());
}
async function committedRevoke(database: D1DatabaseSession, command: OperationsPortalNativeDeliveryAuthorityCommand) {
  return Boolean(await database.prepare(`SELECT 1 FROM operations_portal_native_delivery_authority_commands command
    JOIN operations_portal_native_delivery_authority_heads head ON head.authority_id=command.authority_id
      AND head.latest_operation_id=command.operation_id AND head.state='revoked'
      AND head.revision=command.resulting_revision
    JOIN operations_portal_native_delivery_authority_tombstones tombstone
      ON tombstone.operation_id=command.operation_id AND tombstone.authority_id=command.authority_id
    JOIN operations_portal_native_delivery_authority_commits committed ON committed.operation_id=command.operation_id
      AND committed.resulting_state='revoked'
    WHERE command.operation_id=? AND command.action='delivery.revoke'`).bind(command.operationId).first());
}
function delay(attempt: number) { return Math.min(3600, 5 * 2 ** Math.min(attempt, 9)); }
async function release(database: D1DatabaseSession, operationId: string, claim: string, attempt: number,
  code: string, dead = false) {
  await database.prepare(`UPDATE operations_portal_native_delivery_authority_outbox SET state=?,attempt_count=?,
    last_error_code=?,next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),claim_token=NULL,claim_until=NULL,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE operation_id=? AND state='dispatching' AND claim_token=?`)
    .bind(dead ? "dead" : "retry", attempt, code, `+${delay(attempt)} seconds`, operationId, claim).run();
}
async function acknowledge(database: D1DatabaseSession, row: OutboxRow, claim: string,
  receipt: OperationsPortalNativeDeliveryAuthorityReceipt) {
  const receiptJson = JSON.stringify(receipt), receiptHash = await sha256(receiptJson);
  try {
    await database.batch([
      database.prepare(`INSERT INTO operations_portal_native_delivery_authority_receipts
        (operation_id,receipt_sha256,receipt_json,acknowledged_claim_token) VALUES(?,?,?,?)`)
        .bind(row.operation_id, receiptHash, receiptJson, claim),
      database.prepare(`UPDATE operations_portal_native_delivery_authority_outbox SET state='acknowledged',
        acknowledged_claim_token=?,claim_token=NULL,claim_until=NULL,last_error_code=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operation_id=? AND state='dispatching' AND claim_token=?`).bind(claim, row.operation_id, claim),
    ]);
    return true;
  } catch { return false; }
}

export async function dispatchNextOperationsPortalNativeDeliveryAuthority(input: Readonly<{
  database: D1Database; binding: OperationsPortalNativeDeliveryAuthorityBinding; operationId?: string;
  recoveryInvocationId?: string;
}>): Promise<Readonly<{ operationId: string; state: "acknowledged" | "retry" | "dead" }> | null> {
  const database = input.database.withSession("first-primary");
  const operationId = input.operationId ?? await database.prepare(`SELECT operation_id
    FROM operations_portal_native_delivery_authority_outbox
    WHERE state IN ('pending','retry','dispatching') AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND (state<>'dispatching' OR claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ORDER BY created_at,operation_id LIMIT 1`).first<string>("operation_id");
  if (!operationId || !UUID.test(operationId)) return null;
  const prior = await database.prepare("SELECT 1 FROM operations_portal_native_delivery_authority_receipts WHERE operation_id=?")
    .bind(operationId).first();
  if (prior) return { operationId, state: "acknowledged" };
  const claim = crypto.randomUUID();
  if (input.recoveryInvocationId) {
    if (!await claimOperationsPortalNativeDeliveryRecoveryInvocation(database, {
      invocationId: input.recoveryInvocationId, operationId, claimToken: claim })) return null;
  } else {
    const claimed = await database.prepare(`UPDATE operations_portal_native_delivery_authority_outbox
      SET state='dispatching',claim_token=?,claim_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),
        attempt_count=attempt_count+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE operation_id=? AND state IN ('pending','retry','dispatching')
        AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND (state<>'dispatching' OR claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(claim, operationId).run();
    if (claimed.meta.changes !== 1) return null;
  }
  const row = await database.prepare(`SELECT outbox.operation_id,command.action,outbox.request_fingerprint,
      outbox.canonical_wire_json,outbox.state,outbox.attempt_count,outbox.claim_token
    FROM operations_portal_native_delivery_authority_outbox outbox
    JOIN operations_portal_native_delivery_authority_commands command ON command.operation_id=outbox.operation_id
    WHERE outbox.operation_id=? AND outbox.claim_token=?`)
    .bind(operationId, claim).first<OutboxRow>();
  if (!row) return null;
  let unknown: unknown; try { unknown = JSON.parse(row.canonical_wire_json); } catch { unknown = null; }
  const command = parseOperationsPortalNativeDeliveryAuthorityCommand(unknown);
  if (!command || await sha256(row.canonical_wire_json) !== row.request_fingerprint) {
    await release(database, operationId, claim, row.attempt_count, "stored_command_invalid", row.action !== "delivery.revoke");
    return { operationId, state: row.action === "delivery.revoke" ? "retry" : "dead" };
  }
  const statusJson = canonicalOperationsPortalNativeDeliveryAuthorityStatusRequest({
    protocol: command.protocol, protocolVersion: 1, operationId, requestFingerprint: row.request_fingerprint });
  let status: ReturnType<typeof envelope> = null;
  try { status = envelope(await input.binding.getNativeDeliveryAuthorityStatus(statusJson)); } catch { /* apply/retry below */ }
  const statusReceipt = parseOperationsPortalNativeDeliveryAuthorityReceipt(status?.receipt, command, row.request_fingerprint);
  if (statusReceipt) {
    if (await acknowledge(database, row, claim, statusReceipt)) return { operationId, state: "acknowledged" };
    await release(database, operationId, claim, row.attempt_count, "receipt_commit_failed");
    return { operationId, state: "retry" };
  }
  if (input.recoveryInvocationId && !await currentOperationsPortalNativeDeliveryRecoveryInvocation(database,
    input.recoveryInvocationId, operationId, claim)) {
    await release(database, operationId, claim, row.attempt_count, "recovery_invoker_stale");
    return { operationId, state: "retry" };
  }
  const fresh = command.action === "delivery.grant" ? input.recoveryInvocationId
    ? await verifyOperationsPortalNativeDeliveryGrantForDispatch(input.database, readerInput(command))
    : await currentGrantFresh(input.database, database, command) : await committedRevoke(database, command);
  if (!fresh) {
    const dead = command.action === "delivery.grant";
    await release(database, operationId, claim, row.attempt_count, "authorization_stale", dead);
    return { operationId, state: dead ? "dead" : "retry" };
  }
  if (input.recoveryInvocationId && !await currentOperationsPortalNativeDeliveryRecoveryInvocation(database,
    input.recoveryInvocationId, operationId, claim)) {
    await release(database, operationId, claim, row.attempt_count, "recovery_invoker_changed");
    return { operationId, state: "retry" };
  }
  let response: unknown;
  try { response = await input.binding.applyNativeDeliveryAuthority(row.canonical_wire_json); }
  catch { try { response = await input.binding.getNativeDeliveryAuthorityStatus(statusJson); } catch { response = null; } }
  let result = envelope(response);
  if (result?.code && result.retryable) {
    try { result = envelope(await input.binding.getNativeDeliveryAuthorityStatus(statusJson)); } catch { /* retry below */ }
  }
  const receipt = parseOperationsPortalNativeDeliveryAuthorityReceipt(result?.receipt, command, row.request_fingerprint);
  if (!receipt) {
    const dead = command.action === "delivery.grant" && (result?.retryable === false || row.attempt_count >= MAX_GRANT_ATTEMPTS);
    await release(database, operationId, claim, row.attempt_count, result?.code ?? "client_receipt_invalid", dead);
    return { operationId, state: dead ? "dead" : "retry" };
  }
  if (!await acknowledge(database, row, claim, receipt)) {
    await release(database, operationId, claim, row.attempt_count, "receipt_commit_failed");
    return { operationId, state: "retry" };
  }
  return { operationId, state: "acknowledged" };
}

export function dispatchStagedOperationsPortalNativeDeliveryAuthority(
  env: OperationsPortalNativeDeliveryAuthorityDispatchEnv, operationId?: string, recoveryInvocationId?: string,
) {
  if (env.ENVIRONMENT !== "staging" || env.EXPECTED_HOST !== "ops-staging.ledgetopdroneservices.com"
    || env.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED !== "true"
    || !env.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY) return Promise.resolve(null);
  return dispatchNextOperationsPortalNativeDeliveryAuthority({ database: env.OPS_DB,
    binding: env.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY, operationId, recoveryInvocationId });
}
