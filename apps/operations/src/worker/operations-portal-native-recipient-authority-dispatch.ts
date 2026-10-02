import { finalizeOperationsPortalNativeRecipientTransport } from "./operations-portal-native-recipient-authority";
import { dispatchOperationsPortalNativeWorkspaceCleanup, materializeOperationsPortalNativeWorkspaceCleanup }
  from "./operations-portal-native-workspace-cleanup-dispatch";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
const MAX_ATTEMPTS = 8;
type Action = "recipient.grant" | "recipient.revoke";
type CommandRow = { operation_id: string; action: Action; target_id: string; target_revision: number;
  client_authority_id: string; workspace_id: string; root_kind: "organization" | "standalone_client";
  root_record_id: string; recipient_binding_id: string; enrollment_intent_id: string; target_client_record_id: string;
  issuer: string; subject: string; expected_ownership_epoch: number; resulting_ownership_epoch: number;
  expected_grant_revision: number; resulting_grant_revision: number; permissions_json: string; expires_at: string | null;
  authorized_by_staff_id: string; authorized_access_subject: string; authorized_admission_version: number;
  authorized_profile_version: number; authorized_grant_generation: number; authorized_verified_until: string;
  observed_at: string };
type PublicationRow = { operation_id: string; publication_id: string; resulting_revision: number; source_sequence: number;
  snapshot_id: string; snapshot_sha256: string; operation_fingerprint: string };
type PublicationPins = { publication_operation_id: string | null; publication_id: string | null;
  publication_revision: number | null; publication_source_sequence: number | null;
  publication_snapshot_id: string | null; publication_snapshot_sha256: string | null };
type OutboxRow = CommandRow & { request_fingerprint: string; canonical_wire_json: string; state: string;
  attempts: number; lease_token: string | null };
type RpcSuccess = { ok: true; protocolVersion: 1; status: "recorded" | "duplicate"; operationId: string;
  requestFingerprint: string; action: Action; targetId: string; recipientBindingId: string;
  ownershipEpoch: number; grantRevision: number; state: "active" | "revoked"; replayed: boolean };
type RpcFailure = { ok: false; protocolVersion: 1; code: string; retryable: boolean };

export interface OperationsPortalNativeRecipientAuthorityBinding {
  applyNativeAuthority(canonicalCommandJson: string): Promise<unknown>;
  getNativeAuthorityStatus(canonicalStatusRequestJson: string): Promise<unknown>;
}
export type OperationsPortalNativeRecipientAuthorityDispatchEnv = Readonly<{
  OPS_DB: D1Database;
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY?: OperationsPortalNativeRecipientAuthorityBinding;
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED?: string;
}>;

function exact(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input), names = Reflect.ownKeys(descriptors);
    if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key)
      || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}
async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function canonical(row: CommandRow, publication: PublicationRow | null): string {
  return JSON.stringify({ protocol: "operations-portal-native-authority", protocolVersion: 1, permissionSchemaVersion: 3,
    action: row.action, operationId: row.operation_id,
    target: { targetId: row.target_id, targetRevision: String(row.target_revision),
      clientAuthorityId: row.client_authority_id, workspaceId: row.workspace_id,
      rootKind: row.root_kind, rootRecordId: row.root_record_id },
    recipient: { recipientBindingId: row.recipient_binding_id, enrollmentIntentId: row.enrollment_intent_id,
      targetClientRecordId: row.target_client_record_id, issuer: row.issuer, subject: row.subject },
    expected: { ownershipEpoch: String(row.expected_ownership_epoch), grantRevision: String(row.expected_grant_revision) },
    resulting: { ownershipEpoch: String(row.resulting_ownership_epoch), grantRevision: String(row.resulting_grant_revision) },
    permissions: JSON.parse(row.permissions_json) as unknown, expiresAt: row.expires_at,
    publication: publication ? { operationId: publication.operation_id, publicationId: publication.publication_id,
      revision: String(publication.resulting_revision), sourceSequence: String(publication.source_sequence),
      snapshotId: publication.snapshot_id, snapshotSha256: publication.snapshot_sha256,
      requestFingerprint: publication.operation_fingerprint } : null,
    actorProof: { staffId: row.authorized_by_staff_id, verifiedAccessSubject: row.authorized_access_subject,
      admissionVersion: String(row.authorized_admission_version), profileVersion: String(row.authorized_profile_version),
      grantGeneration: String(row.authorized_grant_generation), verifiedUntil: row.authorized_verified_until },
    observedAt: row.observed_at });
}
async function command(database: Pick<D1Database, "prepare">, operationId: string): Promise<CommandRow | null> {
  return database.prepare(`SELECT operation_id,action,target_id,target_revision,client_authority_id,workspace_id,root_kind,
      root_record_id,recipient_binding_id,enrollment_intent_id,target_client_record_id,issuer,subject,
      expected_ownership_epoch,resulting_ownership_epoch,expected_grant_revision,resulting_grant_revision,
      permissions_json,expires_at,authorized_by_staff_id,authorized_access_subject,authorized_admission_version,
      authorized_profile_version,authorized_grant_generation,authorized_verified_until,observed_at
    FROM operations_portal_native_authority_commands WHERE operation_id=?`).bind(operationId).first<CommandRow>();
}
async function currentPublication(database: Pick<D1Database, "prepare">, row: CommandRow): Promise<PublicationRow | null> {
  return database.prepare(`SELECT receipt.operation_id,receipt.publication_id,receipt.resulting_revision,
      receipt.source_sequence,receipt.snapshot_id,receipt.snapshot_sha256,receipt.operation_fingerprint
    FROM operations_portal_workspace_publication_receipts receipt
    JOIN operations_portal_workspace_publication_commands publication ON publication.operation_id=receipt.operation_id
      AND publication.publication_id=receipt.publication_id
      AND publication.operation_fingerprint=receipt.operation_fingerprint
      AND publication.target_id=receipt.target_id AND publication.resulting_revision=receipt.resulting_revision
      AND publication.source_sequence=receipt.source_sequence AND publication.snapshot_id=receipt.snapshot_id
      AND publication.snapshot_sha256=receipt.snapshot_sha256
    JOIN operations_portal_workspace_publication_heads head ON head.target_id=receipt.target_id
      AND head.latest_operation_id=receipt.operation_id AND head.publication_revision=receipt.resulting_revision
      AND head.source_sequence=receipt.source_sequence AND head.snapshot_id=receipt.snapshot_id
      AND head.checkpoint_id=publication.checkpoint_id AND head.snapshot_sha256=receipt.snapshot_sha256
    JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=receipt.snapshot_id
      AND snapshot.checkpoint_id=publication.checkpoint_id AND snapshot.target_id=receipt.target_id
      AND snapshot.source_sequence=receipt.source_sequence AND snapshot.snapshot_sha256=receipt.snapshot_sha256
    JOIN json_each(snapshot.snapshot_json,'$.directoryRecords') member
    WHERE head.target_id=? AND head.target_revision=? AND head.client_authority_id=? AND head.workspace_id=?
      AND head.root_kind=? AND head.root_record_id=?
      AND json_extract(member.value,'$.recordId')=? AND json_extract(member.value,'$.kind')='client'
      AND ((head.root_kind='organization' AND json_extract(member.value,'$.parentRecordId')=head.root_record_id)
        OR (head.root_kind='standalone_client' AND json_extract(member.value,'$.parentRecordId') IS NULL
          AND json_extract(member.value,'$.recordId')=head.root_record_id))`)
    .bind(row.target_id, row.target_revision, row.client_authority_id, row.workspace_id, row.root_kind,
      row.root_record_id, row.target_client_record_id).first<PublicationRow>();
}
async function frozenPublication(database: Pick<D1Database, "prepare">, row: CommandRow, pins: PublicationPins) {
  if (!pins.publication_operation_id || !pins.publication_id || !pins.publication_revision
    || !pins.publication_source_sequence || !pins.publication_snapshot_id || !pins.publication_snapshot_sha256) return null;
  return database.prepare(`SELECT receipt.operation_id,receipt.publication_id,receipt.resulting_revision,
      receipt.source_sequence,receipt.snapshot_id,receipt.snapshot_sha256,receipt.operation_fingerprint
    FROM operations_portal_workspace_publication_receipts receipt
    JOIN operations_portal_workspace_publication_commands publication ON publication.operation_id=receipt.operation_id
      AND publication.publication_id=receipt.publication_id
      AND publication.operation_fingerprint=receipt.operation_fingerprint
      AND publication.target_id=receipt.target_id AND publication.resulting_revision=receipt.resulting_revision
      AND publication.source_sequence=receipt.source_sequence AND publication.snapshot_id=receipt.snapshot_id
      AND publication.snapshot_sha256=receipt.snapshot_sha256
    JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=receipt.snapshot_id
      AND snapshot.checkpoint_id=publication.checkpoint_id AND snapshot.target_id=receipt.target_id
      AND snapshot.source_sequence=receipt.source_sequence AND snapshot.snapshot_sha256=receipt.snapshot_sha256
    JOIN json_each(snapshot.snapshot_json,'$.directoryRecords') member
    WHERE receipt.operation_id=? AND receipt.publication_id=? AND receipt.resulting_revision=?
      AND receipt.source_sequence=? AND receipt.snapshot_id=? AND receipt.snapshot_sha256=?
      AND publication.target_id=? AND publication.target_revision=? AND publication.client_authority_id=?
      AND publication.workspace_id=? AND publication.root_kind=? AND publication.root_record_id=?
      AND json_extract(member.value,'$.recordId')=? AND json_extract(member.value,'$.kind')='client'
      AND ((publication.root_kind='organization' AND json_extract(member.value,'$.parentRecordId')=publication.root_record_id)
        OR (publication.root_kind='standalone_client' AND json_extract(member.value,'$.parentRecordId') IS NULL
          AND json_extract(member.value,'$.recordId')=publication.root_record_id))`)
    .bind(pins.publication_operation_id, pins.publication_id, pins.publication_revision,
      pins.publication_source_sequence, pins.publication_snapshot_id, pins.publication_snapshot_sha256,
      row.target_id, row.target_revision, row.client_authority_id, row.workspace_id, row.root_kind,
      row.root_record_id, row.target_client_record_id).first<PublicationRow>();
}

export async function materializeOperationsPortalNativeRecipientAuthority(
  database: D1Database, operationId: string,
): Promise<{ operationId: string; requestFingerprint: string; replayed: boolean }> {
  if (!UUID.test(operationId)) throw new Error("operations_portal_native_authority_denied");
  const session = database.withSession("first-primary"), row = await command(session, operationId);
  if (!row) return materializeOperationsPortalNativeWorkspaceCleanup(database, operationId);
  const prior = await session.prepare(`SELECT request_fingerprint,canonical_wire_json,publication_operation_id,
      publication_id,publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256
    FROM operations_portal_native_authority_outbox WHERE operation_id=?`).bind(operationId)
    .first<{ request_fingerprint: string; canonical_wire_json: string } & PublicationPins>();
  if (prior) {
    const publication = row.action === "recipient.grant" ? await frozenPublication(session, row, prior) : null;
    const exactWire = canonical(row, publication);
    const unexpectedRevokePins = row.action === "recipient.revoke" && (prior.publication_operation_id !== null
      || prior.publication_id !== null || prior.publication_revision !== null || prior.publication_source_sequence !== null
      || prior.publication_snapshot_id !== null || prior.publication_snapshot_sha256 !== null);
    if (row.action === "recipient.grant" && !publication || unexpectedRevokePins || exactWire !== prior.canonical_wire_json
      || await sha256(exactWire) !== prior.request_fingerprint)
      throw new Error("operations_portal_native_authority_operation_conflict");
    return { operationId, requestFingerprint: prior.request_fingerprint, replayed: true };
  }
  const publication = row.action === "recipient.grant" ? await currentPublication(session, row) : null;
  if (row.action === "recipient.grant" && !publication) throw new Error("operations_portal_native_authority_publication_stale");
  const wire = canonical(row, publication), fingerprint = await sha256(wire);
  try {
    await session.prepare(`INSERT INTO operations_portal_native_authority_outbox
      (operation_id,request_fingerprint,canonical_wire_json,publication_operation_id,publication_id,
       publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256)
      VALUES(?,?,?,?,?,?,?,?,?)`).bind(operationId, fingerprint, wire, publication?.operation_id ?? null,
      publication?.publication_id ?? null, publication?.resulting_revision ?? null, publication?.source_sequence ?? null,
      publication?.snapshot_id ?? null, publication?.snapshot_sha256 ?? null).run();
  } catch {
    const raced = await session.prepare(`SELECT request_fingerprint,canonical_wire_json FROM operations_portal_native_authority_outbox
      WHERE operation_id=?`).bind(operationId).first<{ request_fingerprint: string; canonical_wire_json: string }>();
    if (!raced || raced.request_fingerprint !== fingerprint || raced.canonical_wire_json !== wire)
      throw new Error("operations_portal_native_authority_operation_conflict");
    return { operationId, requestFingerprint: fingerprint, replayed: true };
  }
  return { operationId, requestFingerprint: fingerprint, replayed: false };
}

function parseRpc(raw: unknown): RpcSuccess | RpcFailure | null {
  if (typeof raw !== "string" || encoder.encode(raw).byteLength > 4096) return null;
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return null; }
  const failure = exact(parsed, ["ok", "protocolVersion", "code", "retryable"]);
  if (failure && failure.ok === false && failure.protocolVersion === 1 && typeof failure.code === "string"
    && typeof failure.retryable === "boolean" && JSON.stringify(parsed) === raw) return parsed as RpcFailure;
  const success = exact(parsed, ["ok", "protocolVersion", "status", "operationId", "requestFingerprint", "action",
    "targetId", "recipientBindingId", "ownershipEpoch", "grantRevision", "state", "replayed"]);
  if (!success || success.ok !== true || success.protocolVersion !== 1
    || (success.status !== "recorded" && success.status !== "duplicate")
    || typeof success.operationId !== "string" || !UUID.test(success.operationId)
    || typeof success.requestFingerprint !== "string" || !SHA256.test(success.requestFingerprint)
    || (success.action !== "recipient.grant" && success.action !== "recipient.revoke")
    || typeof success.targetId !== "string" || !UUID.test(success.targetId)
    || typeof success.recipientBindingId !== "string" || !UUID.test(success.recipientBindingId)
    || !Number.isSafeInteger(success.ownershipEpoch) || Number(success.ownershipEpoch) < 1
    || !Number.isSafeInteger(success.grantRevision) || Number(success.grantRevision) < 1
    || (success.state !== "active" && success.state !== "revoked") || typeof success.replayed !== "boolean"
    || JSON.stringify(parsed) !== raw) return null;
  return parsed as RpcSuccess;
}
function matches(receipt: RpcSuccess, row: OutboxRow): boolean {
  return receipt.operationId === row.operation_id && receipt.requestFingerprint === row.request_fingerprint
    && receipt.action === row.action && receipt.targetId === row.target_id
    && receipt.recipientBindingId === row.recipient_binding_id
    && receipt.ownershipEpoch === row.resulting_ownership_epoch
    && receipt.grantRevision === row.resulting_grant_revision
    && receipt.state === (row.action === "recipient.grant" ? "active" : "revoked");
}

export async function dispatchOperationsPortalNativeRecipientAuthority(
  env: OperationsPortalNativeRecipientAuthorityDispatchEnv, operationId: string, recoveryInvocationId?: string,
): Promise<{ status: "disabled" | "idle" | "acknowledged" | "retry" | "rejected"; operationId?: string; code?: string }> {
  if (env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED !== "true") return { status: "disabled" };
  if (!UUID.test(operationId)) return { status: "idle" };
  const cleanup = await env.OPS_DB.withSession("first-primary").prepare(`SELECT 1
    FROM operations_portal_native_workspace_cleanup_commands WHERE operation_id=?`).bind(operationId).first();
  if (cleanup) return dispatchOperationsPortalNativeWorkspaceCleanup(env, operationId, recoveryInvocationId);
  if (!env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY) return { status: "retry", operationId, code: "configuration" };
  const session = env.OPS_DB.withSession("first-primary");
  const acknowledged = await session.prepare(`SELECT 1 FROM operations_portal_native_authority_receipts WHERE operation_id=?`)
    .bind(operationId).first();
  if (acknowledged) {
    await finalizeOperationsPortalNativeRecipientTransport(env.OPS_DB, { intentId: (await command(session, operationId))!.enrollment_intent_id,
      transportOperationId: operationId });
    return { status: "acknowledged", operationId };
  }
  const lease = crypto.randomUUID(), now = Date.now();
  await session.prepare(`UPDATE operations_portal_native_authority_outbox SET state='claimed',lease_token=?,
      lease_expires_at=?,attempts=attempts+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE operation_id=? AND attempts<? AND ((state='pending' AND available_at<=?)
      OR (state='claimed' AND lease_expires_at<=?))`).bind(lease, now + 120_000, operationId, MAX_ATTEMPTS, now, now).run();
  const row = await session.prepare(`SELECT command.operation_id,command.action,command.target_id,command.target_revision,
      command.client_authority_id,command.workspace_id,command.root_kind,command.root_record_id,command.recipient_binding_id,
      command.enrollment_intent_id,command.target_client_record_id,command.issuer,command.subject,
      command.expected_ownership_epoch,command.resulting_ownership_epoch,command.expected_grant_revision,
      command.resulting_grant_revision,command.permissions_json,command.expires_at,command.authorized_by_staff_id,
      command.authorized_access_subject,command.authorized_admission_version,command.authorized_profile_version,
      command.authorized_grant_generation,command.authorized_verified_until,command.observed_at,outbox.request_fingerprint,
      outbox.canonical_wire_json,outbox.state,outbox.attempts,outbox.lease_token
    FROM operations_portal_native_authority_outbox outbox
    JOIN operations_portal_native_authority_commands command ON command.operation_id=outbox.operation_id
    WHERE outbox.operation_id=? AND outbox.state='claimed' AND outbox.lease_token=?`).bind(operationId, lease).first<OutboxRow>();
  if (!row) return { status: "idle" };
  let receipt: RpcSuccess | RpcFailure | null = null, ambiguous = false;
  if (row.action === "recipient.grant") {
    const current = await session.prepare(`SELECT 1 FROM operations_portal_native_recipient_operations operation
      JOIN operations_portal_native_recipient_live_owner_authority live ON live.operation_id=operation.operation_id
      JOIN operations_portal_native_recipient_intents intent ON intent.intent_id=operation.intent_id
      JOIN client_onboarding_recipient_identity_bindings binding ON binding.binding_id=intent.recipient_binding_id
      JOIN operations_portal_native_authority_outbox authority_outbox ON authority_outbox.operation_id=operation.operation_id
      JOIN operations_portal_workspace_publication_receipts publication_receipt
        ON publication_receipt.operation_id=authority_outbox.publication_operation_id
        AND publication_receipt.publication_id=authority_outbox.publication_id
        AND publication_receipt.resulting_revision=authority_outbox.publication_revision
        AND publication_receipt.source_sequence=authority_outbox.publication_source_sequence
        AND publication_receipt.snapshot_id=authority_outbox.publication_snapshot_id
        AND publication_receipt.snapshot_sha256=authority_outbox.publication_snapshot_sha256
      JOIN operations_portal_workspace_publication_heads publication_head
        ON publication_head.target_id=intent.target_id
        AND publication_head.latest_operation_id=publication_receipt.operation_id
        AND publication_head.publication_revision=publication_receipt.resulting_revision
        AND publication_head.source_sequence=publication_receipt.source_sequence
        AND publication_head.snapshot_id=publication_receipt.snapshot_id
        AND publication_head.snapshot_sha256=publication_receipt.snapshot_sha256
      WHERE operation.operation_id=? AND operation.action='confirm' AND intent.state='confirming'
        AND intent.grant_operation_id=operation.operation_id AND binding.status='active'
        AND binding.access_issuer=intent.access_issuer AND binding.access_subject=intent.access_subject`)
      .bind(operationId).first();
    if (!current) {
      try { receipt = parseRpc(await env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY.getNativeAuthorityStatus(
        JSON.stringify({ protocolVersion: 1, operationId }))); } catch { receipt = null; }
      if (receipt?.ok === true && matches(receipt, row)) {
        // The exact command already committed remotely. Reconcile it without
        // applying stale authority again after local owner/publication drift.
      } else {
      await session.prepare(`UPDATE operations_portal_native_authority_outbox SET state='pending',available_at=?,last_error=?,
        lease_token=NULL,lease_expires_at=NULL WHERE operation_id=? AND state='claimed' AND lease_token=?`)
        .bind(now + 300_000, "authorization-stale", operationId, lease).run();
      return { status: "retry", operationId, code: "authorization-stale" };
      }
    }
  }
  if (!receipt) {
    try { receipt = parseRpc(await env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY.applyNativeAuthority(row.canonical_wire_json)); }
    catch { ambiguous = true; }
    if (!receipt || receipt.ok === false && receipt.retryable) ambiguous = true;
    if (ambiguous) {
      try { receipt = parseRpc(await env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY.getNativeAuthorityStatus(
        JSON.stringify({ protocolVersion: 1, operationId }))); } catch { receipt = null; }
    }
  }
  if (receipt?.ok === true && matches(receipt, row)) {
    try {
      await session.batch([
        session.prepare(`UPDATE operations_portal_native_authority_outbox SET state='acknowledged',lease_token=NULL,
          lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE operation_id=? AND state='claimed' AND lease_token=?`).bind(operationId, lease),
        session.prepare(`INSERT INTO operations_portal_native_authority_receipts
          (operation_id,request_fingerprint,target_id,client_authority_id,workspace_id,recipient_binding_id,
           enrollment_intent_id,issuer,subject,ownership_epoch,grant_revision,resulting_state,permission_schema_version,permissions_json)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,3,?)`).bind(operationId, row.request_fingerprint, row.target_id,
          row.client_authority_id, row.workspace_id, row.recipient_binding_id, row.enrollment_intent_id,
          row.issuer, row.subject, row.resulting_ownership_epoch, row.resulting_grant_revision,
          row.action === "recipient.grant" ? "active" : "revoked", row.permissions_json),
      ]);
      await finalizeOperationsPortalNativeRecipientTransport(env.OPS_DB,
        { intentId: row.enrollment_intent_id, transportOperationId: operationId });
      return { status: "acknowledged", operationId };
    } catch {
      const saved = await session.prepare("SELECT 1 FROM operations_portal_native_authority_receipts WHERE operation_id=?")
        .bind(operationId).first();
      if (saved) {
        await finalizeOperationsPortalNativeRecipientTransport(env.OPS_DB,
          { intentId: row.enrollment_intent_id, transportOperationId: operationId });
        return { status: "acknowledged", operationId };
      }
    }
  }
  const rejected = receipt?.ok === false && !receipt.retryable;
  await session.prepare(`UPDATE operations_portal_native_authority_outbox SET state='pending',available_at=?,last_error=?,
      lease_token=NULL,lease_expires_at=NULL WHERE operation_id=? AND state='claimed' AND lease_token=?`)
    .bind(now + (rejected ? 300_000 : 30_000), receipt?.ok === false ? receipt.code : "transport-ambiguous",
      operationId, lease).run();
  return { status: rejected ? "rejected" : "retry", operationId,
    code: receipt?.ok === false ? receipt.code : "transport-ambiguous" };
}
