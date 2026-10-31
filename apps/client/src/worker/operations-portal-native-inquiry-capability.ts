import { configuredDeploymentOrigin } from "@ltds/shared/configured-deployment-origin";
import { canonicalOperationsPortalNativeInquiryCapabilityCommandV4, parseOperationsPortalNativeInquiryCapabilityCommandV4 }
  from "@ltds/shared/operations-portal-native-recipient-capabilities-v4";
import type { Env } from "./types";

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
type Config = Pick<Env, "DELIVERY_DB" | "ENVIRONMENT"> & Partial<Pick<Env,
  "EXPECTED_HOST" | "CLIENT_PORTAL_ORIGIN" | "CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST">> & {
  CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED?: string;
};
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (typeof value === "string") value = JSON.parse(value);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
    if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key)
      || !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}
function response(value: unknown): string { return JSON.stringify(value); }
async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function configured(env: Config): boolean {
  return env.CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED === "true"
    && configuredDeploymentOrigin({ environment: env.ENVIRONMENT, origin: env.CLIENT_PORTAL_ORIGIN,
      expectedHost: env.CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST ?? env.EXPECTED_HOST }) !== null;
}
async function baseIsCurrent(database: Pick<D1Database, "prepare">, command: NonNullable<ReturnType<
  typeof parseOperationsPortalNativeInquiryCapabilityCommandV4>>): Promise<boolean> {
  if (command.action !== "grant") return false;
  const rows = await database.prepare(`SELECT 1
    FROM operations_portal_native_recipient_authority_heads base
    JOIN operations_portal_native_authority_receipts receipt ON receipt.operation_id=base.latest_operation_id
      AND receipt.state='active' AND receipt.target_id=base.target_id
      AND receipt.recipient_binding_id=base.recipient_binding_id AND receipt.ownership_epoch=base.ownership_epoch
      AND receipt.grant_revision=base.grant_revision
    JOIN operations_portal_native_authority_commands base_command ON base_command.operation_id=receipt.operation_id
      AND base_command.request_fingerprint=receipt.request_fingerprint AND base_command.action='recipient.grant'
      AND base_command.target_id=base.target_id AND base_command.target_revision=?
      AND base_command.client_authority_id=? AND base_command.workspace_id=?
      AND base_command.recipient_binding_id=base.recipient_binding_id
      AND base_command.enrollment_intent_id=base.enrollment_intent_id
      AND base_command.target_client_record_id=base.target_client_record_id
      AND base_command.issuer=base.issuer AND base_command.subject=base.subject
      AND base_command.permissions_json='["operations.service_home.read"]'
    JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=base.target_id
      AND workspace.state='active' AND workspace.ownership_epoch=base.ownership_epoch
      AND workspace.target_revision=? AND workspace.client_authority_id=? AND workspace.workspace_id=?
    JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id
      AND publication.target_revision=workspace.target_revision AND publication.client_authority_id=workspace.client_authority_id
      AND publication.workspace_id=workspace.workspace_id AND publication.latest_operation_id=?
      AND publication.revision=? AND publication.source_sequence=? AND publication.snapshot_id=?
      AND publication.snapshot_sha256=?
    JOIN operations_portal_workspace_publication_receipts pub_receipt ON pub_receipt.operation_id=publication.latest_operation_id
      AND pub_receipt.resulting_revision=publication.revision AND pub_receipt.source_sequence=publication.source_sequence
      AND pub_receipt.snapshot_id=publication.snapshot_id AND pub_receipt.snapshot_sha256=publication.snapshot_sha256
    JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=publication.snapshot_id
      AND snapshot.operation_id=publication.latest_operation_id AND snapshot.target_id=publication.target_id
      AND snapshot.revision=publication.revision AND snapshot.source_sequence=publication.source_sequence
      AND snapshot.snapshot_sha256=publication.snapshot_sha256
    JOIN operations_portal_workspace_publication_history history ON history.operation_id=pub_receipt.operation_id
      AND history.target_id=publication.target_id AND history.revision=publication.revision
      AND history.source_sequence=publication.source_sequence AND history.snapshot_id=publication.snapshot_id
      AND history.snapshot_sha256=publication.snapshot_sha256
    JOIN json_each(snapshot.snapshot_json,'$.directoryRecords') member
    WHERE base.recipient_binding_id=? AND base.target_id=? AND base.enrollment_intent_id=?
      AND base.target_client_record_id=? AND base.issuer=? AND base.subject=?
      AND base.latest_operation_id=? AND base.ownership_epoch=? AND base.grant_revision=? AND base.state='active'
      AND base.permissions_json='["operations.service_home.read"]'
      AND (base.expires_at IS NULL OR datetime(?)<=datetime(base.expires_at))
      AND json_extract(member.value,'$.recordId')=base.target_client_record_id
      AND json_extract(member.value,'$.kind')='client'
      AND ((workspace.root_kind='organization' AND json_extract(member.value,'$.parentRecordId')=workspace.root_record_id)
        OR (workspace.root_kind='standalone_client' AND json_extract(member.value,'$.parentRecordId') IS NULL
          AND json_extract(member.value,'$.recordId')=workspace.root_record_id))`).bind(
    Number(command.target.targetRevision), command.target.clientAuthorityId, command.target.workspaceId,
    Number(command.target.targetRevision), command.target.clientAuthorityId, command.target.workspaceId,
    command.publication.operationId, Number(command.publication.revision), Number(command.publication.sourceSequence),
    command.publication.snapshotId, command.publication.snapshotSha256, command.recipient.recipientBindingId,
    command.target.targetId, command.recipient.enrollmentIntentId, command.target.targetClientRecordId,
    command.recipient.issuer, command.recipient.subject, command.baseAuthority.operationId,
      Number(command.baseAuthority.ownershipEpoch), Number(command.baseAuthority.grantRevision), command.expiresAt,
  ).first();
  return rows !== null;
}

export async function applyOperationsPortalNativeInquiryCapability(env: Config, raw: unknown): Promise<string> {
  if (!configured(env)) return response({ ok: false, protocolVersion: 1, code: "disabled", retryable: true });
  let document: unknown = raw;
  if (typeof raw === "string") { try { document = JSON.parse(raw); } catch { document = null; } }
  const command = parseOperationsPortalNativeInquiryCapabilityCommandV4(document);
  if (!command) return response({ ok: false, protocolVersion: 1, code: "invalid", retryable: false });
  const canonical = canonicalOperationsPortalNativeInquiryCapabilityCommandV4(command);
  if (typeof raw !== "string" || raw !== canonical) return response({ ok: false, protocolVersion: 1, code: "invalid", retryable: false });
  const database = env.DELIVERY_DB.withSession("first-primary"), fingerprint = await sha256(canonical);
  const prior = await database.prepare(`SELECT receipt.request_fingerprint,command.action,receipt.state,receipt.resulting_revision
    FROM operations_portal_native_inquiry_capability_receipts receipt
    JOIN operations_portal_native_inquiry_capability_commands command ON command.operation_id=receipt.operation_id
    WHERE receipt.operation_id=?`)
    .bind(command.operationId).first<{ request_fingerprint: string; action: string; state: string; resulting_revision: number }>();
  if (prior) return response(prior.request_fingerprint === fingerprint
    ? { ok: true, protocolVersion: 1, operationId: command.operationId, requestFingerprint: fingerprint,
      action: command.action, state: prior.state, revision: prior.resulting_revision, replayed: true }
    : { ok: false, protocolVersion: 1, code: "conflict", retryable: false });

  const existing = await database.prepare(`SELECT head.revision,head.state,head.latest_operation_id,head.base_operation_id,
      head.target_id,head.recipient_binding_id,grant.target_revision,grant.client_authority_id,grant.workspace_id,
      grant.target_client_record_id,grant.issuer,grant.subject,grant.publication_operation_id,grant.publication_revision,
      grant.publication_source_sequence,grant.publication_snapshot_id,grant.publication_snapshot_sha256
    FROM operations_portal_native_inquiry_capability_heads head
    JOIN operations_portal_native_inquiry_capability_commands grant ON grant.operation_id=head.latest_operation_id
      AND grant.action='grant'
    WHERE head.intent_id=?`).bind(command.recipient.enrollmentIntentId)
    .first<{ revision: number; state: string; latest_operation_id: string; base_operation_id: string; target_id: string;
      recipient_binding_id: string; target_revision: number; client_authority_id: string; workspace_id: string;
      target_client_record_id: string; issuer: string; subject: string; publication_operation_id: string;
      publication_revision: number; publication_source_sequence: number; publication_snapshot_id: string;
      publication_snapshot_sha256: string }>();
  if (command.action === "grant") {
    if (existing || command.transition.expectedRevision !== "0" || !await baseIsCurrent(database, command))
      return response({ ok: false, protocolVersion: 1, code: "conflict", retryable: false });
  } else if (!existing || !["prepared", "active"].includes(existing.state)
    || existing.revision !== Number(command.transition.expectedRevision)
    || existing.base_operation_id !== command.baseAuthority.operationId
    || existing.target_id !== command.target.targetId || existing.recipient_binding_id !== command.recipient.recipientBindingId
    || existing.target_revision !== Number(command.target.targetRevision)
    || existing.client_authority_id !== command.target.clientAuthorityId || existing.workspace_id !== command.target.workspaceId
    || existing.target_client_record_id !== command.target.targetClientRecordId
    || existing.issuer !== command.recipient.issuer || existing.subject !== command.recipient.subject
    || existing.publication_operation_id !== command.publication.operationId
    || existing.publication_revision !== Number(command.publication.revision)
    || existing.publication_source_sequence !== Number(command.publication.sourceSequence)
    || existing.publication_snapshot_id !== command.publication.snapshotId
    || existing.publication_snapshot_sha256 !== command.publication.snapshotSha256) {
    return response({ ok: false, protocolVersion: 1, code: "conflict", retryable: false });
  }
  if (Date.parse(command.actorProof.verifiedUntil) <= Date.now()
    || Date.parse(command.expiresAt) <= Date.now())
    return response({ ok: false, protocolVersion: 1, code: "stale", retryable: false });

  const values = [command.operationId, fingerprint, command.action, canonical, command.recipient.enrollmentIntentId,
    command.target.targetId, Number(command.target.targetRevision), command.target.clientAuthorityId, command.target.workspaceId,
    command.target.targetClientRecordId, command.recipient.recipientBindingId, command.recipient.issuer, command.recipient.subject,
    command.baseAuthority.operationId, Number(command.baseAuthority.ownershipEpoch), Number(command.baseAuthority.grantRevision),
    command.publication.operationId, Number(command.publication.revision), Number(command.publication.sourceSequence),
    command.publication.snapshotId, command.publication.snapshotSha256, Number(command.transition.expectedRevision),
    Number(command.transition.resultingRevision), command.permission, command.expiresAt, command.actorProof.staffId,
    command.actorProof.verifiedAccessSubject, Number(command.actorProof.admissionVersion), Number(command.actorProof.profileVersion),
    Number(command.actorProof.grantGeneration), command.actorProof.verifiedUntil, command.observedAt] as const;
  const resultState = command.action === "grant" ? "prepared" : "revoked";
  const currentRevision = Number(command.transition.resultingRevision);
  const statements = [database.prepare(`INSERT INTO operations_portal_native_inquiry_capability_commands
    (operation_id,request_fingerprint,action,canonical_command_json,intent_id,target_id,target_revision,client_authority_id,
     workspace_id,target_client_record_id,recipient_binding_id,issuer,subject,base_operation_id,base_ownership_epoch,
     base_grant_revision,publication_operation_id,publication_revision,publication_source_sequence,publication_snapshot_id,
     publication_snapshot_sha256,expected_revision,resulting_revision,permission,expires_at,actor_staff_id,actor_access_subject,
     actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until,observed_at)
    VALUES(${values.map(() => "?").join(",")})`).bind(...values),
    database.prepare(`INSERT INTO operations_portal_native_inquiry_capability_receipts
      (operation_id,request_fingerprint,state,resulting_revision) VALUES(?,?,?,?)`)
      .bind(command.operationId, fingerprint, resultState, currentRevision)];
  if (command.action === "grant") statements.push(database.prepare(`INSERT INTO operations_portal_native_inquiry_capability_heads
    (intent_id,target_id,recipient_binding_id,base_operation_id,base_ownership_epoch,base_grant_revision,revision,state,latest_operation_id)
    VALUES(?,?,?,?,?,?,1,'prepared',?)`).bind(command.recipient.enrollmentIntentId, command.target.targetId,
      command.recipient.recipientBindingId, command.baseAuthority.operationId, Number(command.baseAuthority.ownershipEpoch),
      Number(command.baseAuthority.grantRevision), command.operationId));
  else statements.push(database.prepare(`UPDATE operations_portal_native_inquiry_capability_heads
    SET revision=?,state='revoked',latest_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE intent_id=? AND revision=? AND state IN ('prepared','active')`)
    .bind(currentRevision, command.operationId, command.recipient.enrollmentIntentId,
      Number(command.transition.expectedRevision)));
  try { await database.batch(statements); }
  catch {
    const raced = await database.prepare(`SELECT request_fingerprint,state,resulting_revision
      FROM operations_portal_native_inquiry_capability_receipts WHERE operation_id=?`).bind(command.operationId)
      .first<{ request_fingerprint: string; state: string; resulting_revision: number }>();
    return response(raced?.request_fingerprint === fingerprint
      ? { ok: true, protocolVersion: 1, operationId: command.operationId, requestFingerprint: fingerprint,
        action: command.action, state: raced.state, revision: raced.resulting_revision, replayed: true }
      : { ok: false, protocolVersion: 1, code: "conflict", retryable: false });
  }
  return response({ ok: true, protocolVersion: 1, operationId: command.operationId,
    requestFingerprint: fingerprint, action: command.action, state: resultState, revision: currentRevision, replayed: false });
}

export async function closeOperationsPortalNativeInquiryCapability(env: Config, raw: unknown): Promise<string> {
  if (!configured(env)) return response({ ok: false, protocolVersion: 1, code: "disabled", retryable: true });
  const value = exact(raw, ["protocolVersion", "operationId", "requestFingerprint", "clientReceiptFingerprint",
    "operationsReceiptFingerprint", "closedAt"]);
  if (!value || value.protocolVersion !== 1 || typeof value.operationId !== "string" || !UUID4.test(value.operationId)
    || typeof value.requestFingerprint !== "string" || !SHA256.test(value.requestFingerprint)
    || typeof value.clientReceiptFingerprint !== "string" || !SHA256.test(value.clientReceiptFingerprint)
    || typeof value.operationsReceiptFingerprint !== "string" || !SHA256.test(value.operationsReceiptFingerprint)
    || typeof value.closedAt !== "string" || value.closedAt.length !== 24
    || !Number.isFinite(Date.parse(value.closedAt)) || new Date(value.closedAt).toISOString() !== value.closedAt
    ) return response({ ok: false, protocolVersion: 1, code: "invalid", retryable: false });
  const database = env.DELIVERY_DB.withSession("first-primary");
  const command = await database.prepare(`SELECT command.intent_id,command.base_operation_id,command.expires_at,
      command.target_revision,command.client_authority_id,command.workspace_id,command.target_id,command.target_client_record_id,
      command.recipient_binding_id,command.issuer,command.subject,command.base_ownership_epoch,command.base_grant_revision,
      command.publication_operation_id,command.publication_revision,command.publication_source_sequence,
      command.publication_snapshot_id,command.publication_snapshot_sha256
    FROM operations_portal_native_inquiry_capability_commands command
    JOIN operations_portal_native_inquiry_capability_receipts receipt ON receipt.operation_id=command.operation_id
      AND receipt.request_fingerprint=command.request_fingerprint AND receipt.state='prepared'
    JOIN operations_portal_native_inquiry_capability_heads head ON head.intent_id=command.intent_id
      AND head.latest_operation_id=command.operation_id AND head.state='prepared' AND head.revision=1
    WHERE command.operation_id=? AND command.action='grant' AND command.request_fingerprint=?`)
    .bind(value.operationId, value.requestFingerprint).first<Record<string, unknown>>();
  const storedCommand = command ? await database.prepare(
    "SELECT canonical_command_json FROM operations_portal_native_inquiry_capability_commands WHERE operation_id=?")
    .bind(value.operationId).first<string>("canonical_command_json") : null;
  let storedDocument: unknown = null;
  if (typeof storedCommand === "string") { try { storedDocument = JSON.parse(storedCommand); } catch { storedDocument = null; } }
  const migrationSafeCommand = command && parseOperationsPortalNativeInquiryCapabilityCommandV4(storedDocument);
  if (!command || !migrationSafeCommand || Date.parse(migrationSafeCommand.expiresAt) <= Date.now()
    || !await baseIsCurrent(database, migrationSafeCommand)) return response({ ok: false, protocolVersion: 1,
      code: "stale", retryable: false });
  const prior = await database.prepare(`SELECT request_fingerprint,client_receipt_fingerprint,operations_receipt_fingerprint
    FROM operations_portal_native_inquiry_capability_closures WHERE operation_id=?`).bind(value.operationId)
    .first<{ request_fingerprint: string; client_receipt_fingerprint: string; operations_receipt_fingerprint: string }>();
  if (prior) return response(prior.request_fingerprint === value.requestFingerprint
      && prior.client_receipt_fingerprint === value.clientReceiptFingerprint
      && prior.operations_receipt_fingerprint === value.operationsReceiptFingerprint
    ? { ok: true, protocolVersion: 1, operationId: value.operationId, requestFingerprint: value.requestFingerprint,
      state: "active", replayed: true }
    : { ok: false, protocolVersion: 1, code: "conflict", retryable: false });
  try {
    await database.batch([
      database.prepare(`INSERT INTO operations_portal_native_inquiry_capability_closures
        (operation_id,request_fingerprint,client_receipt_fingerprint,operations_receipt_fingerprint,resulting_state)
        VALUES(?,?,?,?,'active')`).bind(value.operationId, value.requestFingerprint,
          value.clientReceiptFingerprint, value.operationsReceiptFingerprint),
      database.prepare(`UPDATE operations_portal_native_inquiry_capability_heads SET state='active',
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE intent_id=? AND state='prepared' AND revision=1
          AND latest_operation_id=?`).bind(migrationSafeCommand.recipient.enrollmentIntentId, value.operationId),
    ]);
  } catch { return response({ ok: false, protocolVersion: 1, code: "conflict", retryable: false }); }
  return response({ ok: true, protocolVersion: 1, operationId: value.operationId,
    requestFingerprint: value.requestFingerprint, state: "active", replayed: false });
}

export async function readOperationsPortalNativeInquiryCapabilityStatus(env: Config, raw: unknown): Promise<string> {
  if (!configured(env)) return response({ ok: false, protocolVersion: 1, code: "disabled", retryable: true });
  const value = exact(raw, ["protocolVersion", "operationId"]);
  if (!value || value.protocolVersion !== 1 || typeof value.operationId !== "string" || !UUID4.test(value.operationId)
    ) return response({ ok: false, protocolVersion: 1, code: "invalid", retryable: false });
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT receipt.request_fingerprint,command.action,
      receipt.state,receipt.resulting_revision,closure.operations_receipt_fingerprint
    FROM operations_portal_native_inquiry_capability_receipts receipt
    JOIN operations_portal_native_inquiry_capability_commands command ON command.operation_id=receipt.operation_id
    LEFT JOIN operations_portal_native_inquiry_capability_closures closure ON closure.operation_id=receipt.operation_id
    WHERE receipt.operation_id=?`).bind(value.operationId)
    .first<{ request_fingerprint: string; action: string; state: string; resulting_revision: number; operations_receipt_fingerprint: string | null }>();
  return response(row ? { ok: true, protocolVersion: 1, operationId: value.operationId,
    requestFingerprint: row.request_fingerprint, action: row.action, state: row.state,
    revision: row.resulting_revision, operationsReceiptFingerprint: row.operations_receipt_fingerprint }
    : { ok: false, protocolVersion: 1, code: "not_found", retryable: false });
}
