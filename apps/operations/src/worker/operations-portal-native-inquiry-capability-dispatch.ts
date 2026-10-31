import { canonicalOperationsPortalNativeInquiryCapabilityCommandV4,
  parseOperationsPortalNativeInquiryCapabilityCommandV4 } from "@ltds/shared/operations-portal-native-recipient-capabilities-v4";

const HASH = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
export interface OperationsNativeInquiryCapabilityBinding {
  applyNativeInquiryCapability?: (commandJson: string) => unknown;
  closeNativeInquiryCapability?: (closureJson: string) => unknown;
  getNativeInquiryCapabilityStatus?: (statusJson: string) => unknown;
}
type ReadyOperationsNativeInquiryCapabilityBinding = Required<OperationsNativeInquiryCapabilityBinding>;
export type OperationsNativeInquiryCapabilityEnv = Readonly<{
  OPS_DB: D1Database;
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY?: OperationsNativeInquiryCapabilityBinding;
  OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED?: string;
}>;
type Command = NonNullable<ReturnType<typeof parseOperationsPortalNativeInquiryCapabilityCommandV4>>;
type CommandRow = { operation_id: string; request_fingerprint: string; canonical_command_json: string;
  state: string; attempts: number };
type Result = { ok: true; protocolVersion: 1; operationId: string; requestFingerprint: string;
  action: "grant" | "revoke"; state: string; revision?: number; replayed?: boolean } |
  { ok: false; protocolVersion: 1; code: string; retryable: boolean };
const fail = (code: string, retryable = false): Result => ({ ok: false, protocolVersion: 1, code, retryable });
async function hash(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map(value => value.toString(16).padStart(2, "0")).join("");
}
function exactObject(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value === "string") value = JSON.parse(value);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
    if (names.some(key => typeof key !== "string" || !descriptors[key] || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(names.map(key => [key as string, descriptors[key as string]!.value]));
  } catch { return null; }
}
function rpcResult(value: unknown, expectedAction: "grant" | "revoke", operationId: string,
  requestFingerprint: string): Extract<Result, { ok: true }> | null {
  const result = exactObject(value);
  if (!result || result.ok !== true || result.protocolVersion !== 1 || result.operationId !== operationId
    || result.requestFingerprint !== requestFingerprint || result.action !== expectedAction
    || typeof result.state !== "string") return null;
  if (expectedAction === "grant" && result.state !== "prepared" && result.state !== "active") return null;
  if (expectedAction === "revoke" && result.state !== "revoked") return null;
  return result as unknown as Extract<Result, { ok: true }>;
}
async function applyWithStatus(binding: ReadyOperationsNativeInquiryCapabilityBinding, command: Command,
  requestFingerprint: string): Promise<Extract<Result, { ok: true }> | null> {
  let responseValue: unknown = null;
  try { responseValue = await binding.applyNativeInquiryCapability(canonicalOperationsPortalNativeInquiryCapabilityCommandV4(command)); }
  catch { /* reconcile an ambiguous response from the durable Client receipt */ }
  const applied = rpcResult(responseValue, command.action, command.operationId, requestFingerprint);
  if (applied) return applied;
  try {
    const status = exactObject(await binding.getNativeInquiryCapabilityStatus(JSON.stringify({ protocolVersion: 1,
      operationId: command.operationId })));
    const expectedState = command.action === "grant" ? "prepared" : "revoked";
    if (!status || status.ok !== true || status.protocolVersion !== 1 || status.operationId !== command.operationId
      || status.requestFingerprint !== requestFingerprint || status.action !== command.action || status.state !== expectedState) return null;
    return { ok: true, protocolVersion: 1, operationId: command.operationId, requestFingerprint,
      action: command.action, state: expectedState, replayed: true };
  } catch { return null; }
}
async function grantStatusWithoutApply(binding: ReadyOperationsNativeInquiryCapabilityBinding, command: Command,
  requestFingerprint: string): Promise<"not_found" | Extract<Result, { ok: true }> | null> {
  try {
    const status = exactObject(await binding.getNativeInquiryCapabilityStatus(JSON.stringify({ protocolVersion: 1,
      operationId: command.operationId })));
    if (status?.ok === false && status.code === "not_found") return "not_found";
    if (!status || status.ok !== true || status.protocolVersion !== 1 || status.operationId !== command.operationId
      || status.requestFingerprint !== requestFingerprint || status.action !== "grant"
      || (status.state !== "prepared" && status.state !== "active")) return null;
    return { ok: true, protocolVersion: 1, operationId: command.operationId, requestFingerprint,
      action: "grant", state: status.state, replayed: true };
  } catch { return null; }
}
async function closeWithStatus(binding: ReadyOperationsNativeInquiryCapabilityBinding, closureJson: string,
  operationId: string, requestFingerprint: string, operationsReceiptFingerprint: string): Promise<boolean> {
  try {
    const closed = exactObject(await binding.closeNativeInquiryCapability(closureJson));
    if (closed?.ok === true && closed.operationId === operationId && closed.requestFingerprint === requestFingerprint
      && closed.state === "active") return true;
  } catch { /* reconcile an ambiguous closure response */ }
  try {
    const status = exactObject(await binding.getNativeInquiryCapabilityStatus(JSON.stringify({ protocolVersion: 1, operationId })));
    return status?.ok === true && status.operationId === operationId && status.requestFingerprint === requestFingerprint
      && status.state === "prepared" && status.operationsReceiptFingerprint === operationsReceiptFingerprint;
  } catch { return false; }
}

/** Persist a separately consented capability command. This helper is not
 * mounted on a public route; the caller must already have current native-owner
 * authentication. SQL triggers repeat all immutable target/base/publication
 * pins before accepting a grant. */
export async function prepareOperationsNativeInquiryCapability(env: OperationsNativeInquiryCapabilityEnv,
  raw: unknown): Promise<Result> {
  let document: unknown = raw;
  if (typeof raw === "string") { try { document = JSON.parse(raw); } catch { document = null; } }
  const command = parseOperationsPortalNativeInquiryCapabilityCommandV4(document);
  if (!command) return fail("invalid");
  // The feature switch gates creation of request.create authority. Explicit
  // owner revocation remains available as a safety operation after shutdown.
  if (command.action === "grant" && env.OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED !== "true") return fail("disabled", true);
  const canonical = canonicalOperationsPortalNativeInquiryCapabilityCommandV4(command);
  if (typeof raw !== "string" || raw !== canonical) return fail("invalid");
  const db = env.OPS_DB.withSession("first-primary"), fingerprint = await hash(canonical);
  const existingCommand = await db.prepare(`SELECT command.request_fingerprint,outbox.state
    FROM operations_portal_native_inquiry_capability_commands command
    JOIN operations_portal_native_inquiry_capability_outbox outbox ON outbox.operation_id=command.operation_id
    WHERE command.operation_id=?`).bind(command.operationId)
    .first<{ request_fingerprint: string; state: string }>();
  if (existingCommand) return existingCommand.request_fingerprint === fingerprint
    ? { ok: true, protocolVersion: 1, operationId: command.operationId, requestFingerprint: fingerprint,
      action: command.action, state: existingCommand.state, replayed: true }
    : fail("conflict");
  const prior = await db.prepare(`SELECT request_fingerprint,state FROM operations_portal_native_inquiry_capability_receipts
    WHERE operation_id=?`).bind(command.operationId).first<{ request_fingerprint: string; state: string }>();
  if (prior) return prior.request_fingerprint === fingerprint
    ? { ok: true, protocolVersion: 1, operationId: command.operationId, requestFingerprint: fingerprint,
      action: command.action, state: prior.state, replayed: true }
    : fail("conflict");
  const actorCurrent = await db.prepare(`SELECT 1
    FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
      AND profile.version=?
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
      AND generation.generation=?
    JOIN operations_portal_workspace_reservation_heads target ON target.target_id=?
      AND target.state='active'
    JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=target.target_id
      AND workspace.target_revision=target.revision AND workspace.root_record_id=target.root_record_id
      AND workspace.state='active' AND workspace.target_revision=? AND workspace.client_authority_id=? AND workspace.workspace_id=?
    WHERE admission.staff_id=? AND admission.bound_access_subject=? AND admission.version=? AND admission.active=1
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND ((role.role_id IN ('role-owner','role-admin') AND role.scope='global')
          OR (role.role_id='role-division-manager' AND role.scope='division'
            AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=target.root_record_id AND scope.active=1 AND scope.division_id=role.division_id))))
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='allow' AND permission.record_id=target.root_record_id)
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_portal_permissions permission
        WHERE permission.staff_id=admission.staff_id AND permission.effect='deny' AND permission.record_id=target.root_record_id)
      AND ? > strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
    .bind(Number(command.actorProof.profileVersion), Number(command.actorProof.grantGeneration), command.target.targetId,
      Number(command.target.targetRevision), command.target.clientAuthorityId, command.target.workspaceId,
      command.actorProof.staffId, command.actorProof.verifiedAccessSubject,
      Number(command.actorProof.admissionVersion), command.actorProof.verifiedUntil).first();
  if (!actorCurrent) return fail("stale");
  const expected = Number(command.transition.expectedRevision), resulting = Number(command.transition.resultingRevision);
  const values = [command.operationId, command.recipient.enrollmentIntentId, command.action, fingerprint, canonical,
    command.target.targetId, Number(command.target.targetRevision), command.target.clientAuthorityId,
    command.target.workspaceId, command.target.targetClientRecordId, command.recipient.recipientBindingId,
    command.recipient.issuer, command.recipient.subject, command.baseAuthority.operationId,
    Number(command.baseAuthority.ownershipEpoch), Number(command.baseAuthority.grantRevision),
    command.publication.operationId, Number(command.publication.revision), Number(command.publication.sourceSequence),
    command.publication.snapshotId, command.publication.snapshotSha256, expected, resulting, "operations.request.create",
    command.expiresAt, command.actorProof.staffId, command.actorProof.verifiedAccessSubject,
    Number(command.actorProof.admissionVersion), Number(command.actorProof.profileVersion),
    Number(command.actorProof.grantGeneration), command.actorProof.verifiedUntil, command.observedAt];
  try {
    const statements = [db.prepare(`INSERT INTO operations_portal_native_inquiry_capability_commands
      (operation_id,intent_id,action,request_fingerprint,canonical_command_json,target_id,target_revision,client_authority_id,
       workspace_id,target_client_record_id,recipient_binding_id,issuer,subject,base_operation_id,base_ownership_epoch,
       base_grant_revision,publication_operation_id,publication_revision,publication_source_sequence,publication_snapshot_id,
       publication_snapshot_sha256,expected_revision,resulting_revision,permission,expires_at,actor_staff_id,
       actor_access_subject,actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until,observed_at)
      VALUES(${values.map(() => "?").join(",")})`).bind(...values),
      db.prepare(`INSERT INTO operations_portal_native_inquiry_capability_outbox(operation_id) VALUES(?)`).bind(command.operationId)];
    await db.batch(statements);
  } catch { return fail("conflict"); }
  return { ok: true, protocolVersion: 1, operationId: command.operationId, requestFingerprint: fingerprint,
    action: command.action, state: "prepared", replayed: false };
}

/** Deliver a frozen companion command and close the two-sided receipt chain.
 * Replaying this function reconciles ambiguous RPC results from durable state. */
export async function dispatchOperationsNativeInquiryCapability(env: OperationsNativeInquiryCapabilityEnv,
  operationId: string): Promise<Result> {
  const binding = env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY;
  if (!binding || typeof binding.applyNativeInquiryCapability !== "function"
    || typeof binding.closeNativeInquiryCapability !== "function"
    || typeof binding.getNativeInquiryCapabilityStatus !== "function") return fail("unavailable", true);
  const readyBinding: ReadyOperationsNativeInquiryCapabilityBinding = { applyNativeInquiryCapability: binding.applyNativeInquiryCapability,
    closeNativeInquiryCapability: binding.closeNativeInquiryCapability,
    getNativeInquiryCapabilityStatus: binding.getNativeInquiryCapabilityStatus };
  const db = env.OPS_DB.withSession("first-primary");
  const row = await db.prepare(`SELECT command.operation_id,command.request_fingerprint,command.canonical_command_json,
      outbox.state,outbox.attempts FROM operations_portal_native_inquiry_capability_commands command
    JOIN operations_portal_native_inquiry_capability_outbox outbox ON outbox.operation_id=command.operation_id
    WHERE command.operation_id=?`).bind(operationId).first<CommandRow>();
  if (!row || !HASH.test(row.request_fingerprint)) return fail("not_found");
  let commandDocument: unknown = null;
  try { commandDocument = JSON.parse(row.canonical_command_json); } catch { commandDocument = null; }
  const command = parseOperationsPortalNativeInquiryCapabilityCommandV4(commandDocument);
  if (!command) return fail("stored_command_invalid");
  if (canonicalOperationsPortalNativeInquiryCapabilityCommandV4(command) !== row.canonical_command_json) return fail("stored_command_noncanonical");
  if (await hash(row.canonical_command_json) !== row.request_fingerprint) return fail("stored_command_fingerprint_mismatch");
  const intentState = command.action === "grant" ? await db.prepare(`SELECT state FROM operations_portal_native_recipient_intents
    WHERE intent_id=? AND permission_schema_version=4`).bind(command.recipient.enrollmentIntentId).first<string>("state") : null;
  if (command.action === "grant" && intentState === null) return fail("stale");
  const revocationStarted = intentState === "revoking" || intentState === "revoked";
  if (command.action === "grant" && !revocationStarted
    && env.OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED !== "true") return fail("disabled", true);
  const priorClosure = await db.prepare(`SELECT request_fingerprint FROM operations_portal_native_inquiry_capability_closures
    WHERE operation_id=?`).bind(operationId).first<string>("request_fingerprint");
  if (priorClosure === row.request_fingerprint) return { ok: true, protocolVersion: 1, operationId,
    requestFingerprint: row.request_fingerprint, action: command.action, state: "active", replayed: true };
  if (command.action === "revoke") {
    const priorRevoke = await db.prepare(`SELECT receipt.request_fingerprint FROM operations_portal_native_inquiry_capability_receipts receipt
      JOIN operations_portal_native_inquiry_capability_heads head ON head.latest_operation_id=receipt.operation_id
        AND head.intent_id=? AND head.state='revoked' AND head.revision=?
      WHERE receipt.operation_id=? AND receipt.request_fingerprint=? AND receipt.state='revoked'`)
      .bind(command.recipient.enrollmentIntentId, Number(command.transition.resultingRevision), operationId,
        row.request_fingerprint).first<string>("request_fingerprint");
    if (priorRevoke === row.request_fingerprint) return { ok: true, protocolVersion: 1, operationId,
      requestFingerprint: row.request_fingerprint, action: "revoke", state: "revoked", replayed: true };
  }
  if (command.action === "grant") {
    const clientPrepared = revocationStarted
      ? await grantStatusWithoutApply(readyBinding, command, row.request_fingerprint)
      : env.OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED === "true"
        ? await applyWithStatus(readyBinding, command, row.request_fingerprint) : null;
    if (clientPrepared === "not_found") return fail("capability_not_found");
    if (!clientPrepared) return fail("client_unavailable", true);
    const operationsReceiptFingerprint = await hash(`${operationId}\n${row.request_fingerprint}\n${clientPrepared.requestFingerprint}\nprepared`);
    try {
      await db.batch([
        db.prepare(`INSERT INTO operations_portal_native_inquiry_capability_receipts
          (operation_id,request_fingerprint,client_receipt_fingerprint,operations_receipt_fingerprint,state)
          VALUES(?,?,?,?, 'prepared') ON CONFLICT(operation_id) DO NOTHING`)
          .bind(operationId, row.request_fingerprint, clientPrepared.requestFingerprint, operationsReceiptFingerprint),
        db.prepare(`INSERT INTO operations_portal_native_inquiry_capability_history
          (operation_id,intent_id,action,expected_revision,resulting_revision,resulting_state,request_fingerprint)
          VALUES(?,?,?,?,?,'prepared',?) ON CONFLICT(operation_id) DO NOTHING`)
          .bind(operationId, command.recipient.enrollmentIntentId, command.action,
            Number(command.transition.expectedRevision), Number(command.transition.resultingRevision), row.request_fingerprint),
        db.prepare(`INSERT INTO operations_portal_native_inquiry_capability_heads
          (intent_id,target_id,recipient_binding_id,base_operation_id,base_ownership_epoch,base_grant_revision,
           revision,state,latest_operation_id) VALUES(?,?,?,?,?,?,1,'prepared',?) ON CONFLICT(intent_id) DO NOTHING`)
          .bind(command.recipient.enrollmentIntentId, command.target.targetId, command.recipient.recipientBindingId,
            command.baseAuthority.operationId, Number(command.baseAuthority.ownershipEpoch),
            Number(command.baseAuthority.grantRevision), operationId),
        db.prepare(`UPDATE operations_portal_native_inquiry_capability_outbox SET state='prepared',attempts=attempts+1,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_id=?`).bind(operationId),
      ]);
    } catch { return fail("receipt_conflict"); }
    const currentIntentState = await db.prepare(`SELECT state FROM operations_portal_native_recipient_intents
      WHERE intent_id=? AND permission_schema_version=4`).bind(command.recipient.enrollmentIntentId).first<string>("state");
    if (currentIntentState !== "active") return fail("revocation_pending", true);
    if (env.OPERATIONS_PORTAL_NATIVE_INQUIRY_CAPABILITY_ENABLED !== "true") return fail("disabled", true);
    const closureJson = JSON.stringify({ protocolVersion: 1, operationId, requestFingerprint: row.request_fingerprint,
      clientReceiptFingerprint: clientPrepared.requestFingerprint, operationsReceiptFingerprint, closedAt: new Date().toISOString() });
    if (!await closeWithStatus(readyBinding, closureJson, operationId, row.request_fingerprint, operationsReceiptFingerprint))
      return fail("client_closure_pending", true);
    try {
      await db.batch([
        db.prepare(`INSERT INTO operations_portal_native_inquiry_capability_closures
          (operation_id,request_fingerprint,client_receipt_fingerprint,operations_receipt_fingerprint,resulting_state)
          VALUES(?,?,?,?,'active') ON CONFLICT(operation_id) DO NOTHING`)
          .bind(operationId, row.request_fingerprint, clientPrepared.requestFingerprint, operationsReceiptFingerprint),
        db.prepare(`UPDATE operations_portal_native_inquiry_capability_history SET resulting_state='active'
          WHERE operation_id=? AND resulting_state='prepared'`).bind(operationId),
        db.prepare(`UPDATE operations_portal_native_inquiry_capability_heads SET state='active',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE intent_id=? AND latest_operation_id=?
            AND revision=1 AND state='prepared'`).bind(command.recipient.enrollmentIntentId, operationId),
        db.prepare(`UPDATE operations_portal_native_inquiry_capability_outbox SET state='acknowledged',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_id=?`).bind(operationId),
      ]);
    } catch { return fail("operations_closure_pending", true); }
    return { ok: true, protocolVersion: 1, operationId, requestFingerprint: row.request_fingerprint,
      action: "grant", state: "active", replayed: false };
  }
  const clientRevoked = await applyWithStatus(readyBinding, command, row.request_fingerprint);
  if (!clientRevoked) return fail("client_unavailable", true);
  const operationsReceiptFingerprint = await hash(`${operationId}\n${row.request_fingerprint}\n${clientRevoked.requestFingerprint}\nrevoked`);
  try {
    await db.batch([
      db.prepare(`INSERT INTO operations_portal_native_inquiry_capability_receipts
        (operation_id,request_fingerprint,client_receipt_fingerprint,operations_receipt_fingerprint,state)
        VALUES(?,?,?,?, 'revoked') ON CONFLICT(operation_id) DO NOTHING`)
        .bind(operationId, row.request_fingerprint, clientRevoked.requestFingerprint, operationsReceiptFingerprint),
      db.prepare(`INSERT INTO operations_portal_native_inquiry_capability_history
        (operation_id,intent_id,action,expected_revision,resulting_revision,resulting_state,request_fingerprint)
        VALUES(?,?,?,?,?,'revoked',?) ON CONFLICT(operation_id) DO NOTHING`)
        .bind(operationId, command.recipient.enrollmentIntentId, command.action,
          Number(command.transition.expectedRevision), Number(command.transition.resultingRevision), row.request_fingerprint),
      db.prepare(`UPDATE operations_portal_native_inquiry_capability_heads SET revision=?,state='revoked',latest_operation_id=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE intent_id=? AND revision=? AND state IN ('prepared','active')`)
        .bind(Number(command.transition.resultingRevision), operationId, command.recipient.enrollmentIntentId,
          Number(command.transition.expectedRevision)),
      db.prepare(`UPDATE operations_portal_native_inquiry_capability_outbox SET state='revoked',attempts=attempts+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_id=?`).bind(operationId),
    ]);
  } catch { return fail("receipt_conflict"); }
  return { ok: true, protocolVersion: 1, operationId, requestFingerprint: row.request_fingerprint,
    action: "revoke", state: "revoked", replayed: clientRevoked.replayed === true };
}
