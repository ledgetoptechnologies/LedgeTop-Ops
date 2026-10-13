import type { Env } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const encoder = new TextEncoder();
type Action = "recipient.grant" | "recipient.revoke" | "workspace.revoke";
type State = "active" | "revoked";
type Command = Readonly<{
  protocol: "operations-portal-native-authority"; protocolVersion: 1; permissionSchemaVersion: 3;
  action: Action; operationId: string;
  target: Readonly<{ targetId: string; targetRevision: string; clientAuthorityId: string; workspaceId: string;
    rootKind: "organization" | "standalone_client"; rootRecordId: string }>;
  recipient: Readonly<{ recipientBindingId: string; enrollmentIntentId: string; targetClientRecordId: string;
    issuer: string; subject: string }> | null;
  expected: Readonly<{ ownershipEpoch: string; grantRevision: string | null }>;
  resulting: Readonly<{ ownershipEpoch: string; grantRevision: string | null }>;
  permissions: readonly [] | readonly ["operations.service_home.read"];
  expiresAt: string | null;
  publication: null | Readonly<{ operationId: string; publicationId: string; revision: string; sourceSequence: string;
    snapshotId: string; snapshotSha256: string; requestFingerprint: string }>;
  actorProof: Readonly<{ staffId: string; verifiedAccessSubject: string; admissionVersion: string;
    profileVersion: string; grantGeneration: string; verifiedUntil: string }>;
  observedAt: string;
}>;
type ReceiptRow = { request_fingerprint: string; action: Action; target_id: string;
  recipient_binding_id: string | null; ownership_epoch: number; grant_revision: number | null; state: State };
type WorkspaceHead = { target_revision: number; client_authority_id: string; workspace_id: string;
  root_kind: "organization" | "standalone_client"; root_record_id: string; ownership_epoch: number; state: State };
type RecipientHead = { target_id: string; enrollment_intent_id: string; target_client_record_id: string;
  issuer: string; subject: string; ownership_epoch: number; grant_revision: number; state: State };

function exact(input: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input), names = Reflect.ownKeys(descriptors);
    if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key)
      || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}
function bounded(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
function positive(value: unknown, zero = false): value is string {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)
    && (zero || value !== "0") && Number.isSafeInteger(Number(value));
}
async function sha256(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function parseCanonical(raw: unknown): { command: Command; canonical: string } | null {
  if (typeof raw !== "string" || encoder.encode(raw).byteLength > 32_768) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const value = exact(parsed, ["protocol", "protocolVersion", "permissionSchemaVersion", "action", "operationId",
    "target", "recipient", "expected", "resulting", "permissions", "expiresAt", "publication", "actorProof", "observedAt"]);
  const target = exact(value?.target, ["targetId", "targetRevision", "clientAuthorityId", "workspaceId", "rootKind", "rootRecordId"]);
  const recipient = value?.recipient === null ? null
    : exact(value?.recipient, ["recipientBindingId", "enrollmentIntentId", "targetClientRecordId", "issuer", "subject"]);
  const expected = exact(value?.expected, ["ownershipEpoch", "grantRevision"]);
  const resulting = exact(value?.resulting, ["ownershipEpoch", "grantRevision"]);
  const actor = exact(value?.actorProof, ["staffId", "verifiedAccessSubject", "admissionVersion", "profileVersion", "grantGeneration", "verifiedUntil"]);
  const publication = value?.publication === null ? null : exact(value?.publication,
    ["operationId", "publicationId", "revision", "sourceSequence", "snapshotId", "snapshotSha256", "requestFingerprint"]);
  if (!value || value.protocol !== "operations-portal-native-authority" || value.protocolVersion !== 1
    || value.permissionSchemaVersion !== 3 || (value.action !== "recipient.grant" && value.action !== "recipient.revoke"
      && value.action !== "workspace.revoke")
    || typeof value.operationId !== "string" || !UUID.test(value.operationId) || !target || !expected || !resulting
    || typeof target.targetId !== "string" || !UUID.test(target.targetId)
    || !positive(target.targetRevision) || typeof target.clientAuthorityId !== "string" || !UUID.test(target.clientAuthorityId)
    || !bounded(target.workspaceId, 200) || (target.rootKind !== "organization" && target.rootKind !== "standalone_client")
    || !bounded(target.rootRecordId, 191) || !positive(expected.ownershipEpoch, true)
    || !positive(resulting.ownershipEpoch)
    || (value.action === "workspace.revoke" ? (recipient !== null || expected.grantRevision !== null
      || resulting.grantRevision !== null || Number(expected.ownershipEpoch) < 1
      || Number(resulting.ownershipEpoch) !== Number(expected.ownershipEpoch) + 1)
      : (!recipient || typeof recipient.recipientBindingId !== "string" || !UUID.test(recipient.recipientBindingId)
        || typeof recipient.enrollmentIntentId !== "string" || !UUID.test(recipient.enrollmentIntentId)
        || !bounded(recipient.targetClientRecordId, 191) || !bounded(recipient.issuer) || !bounded(recipient.subject)
        || !positive(expected.grantRevision, true) || !positive(resulting.grantRevision)
        || Number(resulting.grantRevision) !== Number(expected.grantRevision) + 1))
    || (value.action === "recipient.grant" && !((Number(expected.ownershipEpoch) === 0 && Number(resulting.ownershipEpoch) === 1)
      || Number(resulting.ownershipEpoch) === Number(expected.ownershipEpoch)))
    || (value.action === "recipient.revoke" && (Number(expected.ownershipEpoch) < 1
      || resulting.ownershipEpoch !== expected.ownershipEpoch || Number(expected.grantRevision) < 1))
    || !Array.isArray(value.permissions) || (value.action === "recipient.grant"
      ? value.permissions.length !== 1 || value.permissions[0] !== "operations.service_home.read"
      : value.permissions.length !== 0)
    || value.expiresAt !== null || !actor || !bounded(actor.staffId, 191) || !bounded(actor.verifiedAccessSubject)
    || !positive(actor.admissionVersion) || !positive(actor.profileVersion) || !positive(actor.grantGeneration)
    || !instant(actor.verifiedUntil) || !instant(value.observedAt) || Date.parse(actor.verifiedUntil) <= Date.parse(value.observedAt)
    || (value.action === "recipient.grant" ? !publication : publication !== null)
    || (publication && (typeof publication.operationId !== "string" || !UUID.test(publication.operationId)
      || typeof publication.publicationId !== "string" || !UUID.test(publication.publicationId)
      || !positive(publication.revision) || !positive(publication.sourceSequence)
      || typeof publication.snapshotId !== "string" || !UUID.test(publication.snapshotId)
      || typeof publication.snapshotSha256 !== "string" || !SHA256.test(publication.snapshotSha256)
      || typeof publication.requestFingerprint !== "string" || !SHA256.test(publication.requestFingerprint)))) return null;
  if (JSON.stringify(parsed) !== raw) return null;
  return { command: parsed as Command, canonical: raw };
}
function response(value: unknown): string { return JSON.stringify(value); }
function result(operationId: string, row: ReceiptRow, replayed: boolean) {
  return { ok: true as const, protocolVersion: 1 as const, status: replayed ? "duplicate" as const : "recorded" as const,
    operationId, requestFingerprint: row.request_fingerprint, action: row.action, targetId: row.target_id,
    recipientBindingId: row.recipient_binding_id, ownershipEpoch: row.ownership_epoch,
    grantRevision: row.grant_revision, state: row.state, replayed };
}

export async function applyOperationsPortalNativeRecipientAuthority(
  env: Pick<Env, "DELIVERY_DB" | "ENVIRONMENT"> & { CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED?: string }, raw: unknown,
): Promise<string> {
  if (env.ENVIRONMENT !== "staging" || env.CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED !== "true")
    return response({ ok: false, protocolVersion: 1, code: "disabled", retryable: true });
  const parsed = parseCanonical(raw);
  if (!parsed) return response({ ok: false, protocolVersion: 1, code: "invalid", retryable: false });
  const { command, canonical } = parsed, fingerprint = await sha256(canonical);
  const database = env.DELIVERY_DB.withSession("first-primary");
  const prior = await database.prepare(`SELECT request_fingerprint,action,target_id,recipient_binding_id,
      ownership_epoch,grant_revision,state FROM operations_portal_native_authority_receipts WHERE operation_id=?`)
    .bind(command.operationId).first<ReceiptRow>();
  if (prior) return response(prior.request_fingerprint === fingerprint
    ? result(command.operationId, prior, true)
    : { ok: false, protocolVersion: 1, code: "conflict", retryable: false });
  const targetRevision = Number(command.target.targetRevision), expectedEpoch = Number(command.expected.ownershipEpoch);
  const resultingEpoch = Number(command.resulting.ownershipEpoch), expectedGrant = command.expected.grantRevision === null
    ? null : Number(command.expected.grantRevision), resultingGrant = command.resulting.grantRevision === null
    ? null : Number(command.resulting.grantRevision), permissions = JSON.stringify(command.permissions);
  const workspace = await database.prepare(`SELECT target_revision,client_authority_id,workspace_id,root_kind,root_record_id,
      ownership_epoch,state FROM operations_portal_native_workspace_authority_heads WHERE target_id=?`)
    .bind(command.target.targetId).first<WorkspaceHead>();
  if (workspace ? workspace.state !== "active" || workspace.target_revision !== targetRevision
      || workspace.client_authority_id !== command.target.clientAuthorityId || workspace.workspace_id !== command.target.workspaceId
      || workspace.root_kind !== command.target.rootKind || workspace.root_record_id !== command.target.rootRecordId
      || workspace.ownership_epoch !== expectedEpoch
    : command.action !== "recipient.grant" || expectedEpoch !== 0 || resultingEpoch !== 1 || expectedGrant !== 0)
    return response({ ok: false, protocolVersion: 1, code: "conflict", retryable: false });
  const recipient = command.recipient ? await database.prepare(`SELECT target_id,enrollment_intent_id,target_client_record_id,
      issuer,subject,ownership_epoch,grant_revision,state FROM operations_portal_native_recipient_authority_heads
      WHERE recipient_binding_id=?`).bind(command.recipient.recipientBindingId).first<RecipientHead>() : null;
  if (command.action === "recipient.grant" ? recipient !== null
    : command.action === "recipient.revoke" ? !recipient || !command.recipient
      || recipient.target_id !== command.target.targetId
      || recipient.enrollment_intent_id !== command.recipient.enrollmentIntentId
      || recipient.target_client_record_id !== command.recipient.targetClientRecordId
      || recipient.issuer !== command.recipient.issuer || recipient.subject !== command.recipient.subject
      || recipient.ownership_epoch !== resultingEpoch || recipient.grant_revision !== expectedGrant || recipient.state !== "active"
    : !workspace || Boolean(await database.prepare(`SELECT 1 FROM operations_portal_native_recipient_authority_heads
        WHERE target_id=? AND state<>'revoked' LIMIT 1`).bind(command.target.targetId).first()))
    return response({ ok: false, protocolVersion: 1, code: "conflict", retryable: false });
  const statements: D1PreparedStatement[] = [database.prepare(`INSERT INTO operations_portal_native_authority_commands
    (operation_id,request_fingerprint,action,target_id,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,
     recipient_binding_id,enrollment_intent_id,target_client_record_id,issuer,subject,expected_ownership_epoch,
     expected_grant_revision,resulting_ownership_epoch,resulting_grant_revision,permissions_json,expires_at,
     publication_operation_id,publication_id,publication_revision,publication_source_sequence,publication_snapshot_id,
     publication_snapshot_sha256,publication_request_fingerprint,actor_staff_id,actor_access_subject,actor_admission_version,
     actor_profile_version,actor_grant_generation,actor_verified_until,observed_at,canonical_command_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(command.operationId, fingerprint,
      command.action, command.target.targetId, targetRevision, command.target.clientAuthorityId, command.target.workspaceId,
      command.target.rootKind, command.target.rootRecordId, command.recipient?.recipientBindingId ?? null,
      command.recipient?.enrollmentIntentId ?? null, command.recipient?.targetClientRecordId ?? null,
      command.recipient?.issuer ?? null, command.recipient?.subject ?? null, expectedEpoch, expectedGrant,
      resultingEpoch, resultingGrant, permissions, null,
      command.publication?.operationId ?? null, command.publication?.publicationId ?? null,
      command.publication ? Number(command.publication.revision) : null,
      command.publication ? Number(command.publication.sourceSequence) : null, command.publication?.snapshotId ?? null,
      command.publication?.snapshotSha256 ?? null, command.publication?.requestFingerprint ?? null,
      command.actorProof.staffId, command.actorProof.verifiedAccessSubject, Number(command.actorProof.admissionVersion),
      Number(command.actorProof.profileVersion), Number(command.actorProof.grantGeneration), command.actorProof.verifiedUntil,
      command.observedAt, canonical)];
  if (!workspace) statements.push(database.prepare(`INSERT INTO operations_portal_native_workspace_authority_heads
    (target_id,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,ownership_epoch,state,latest_operation_id)
    VALUES(?,?,?,?,?,?,1,'active',?)`).bind(command.target.targetId, targetRevision, command.target.clientAuthorityId,
      command.target.workspaceId, command.target.rootKind, command.target.rootRecordId, command.operationId));
  if (command.action === "workspace.revoke") statements.push(database.prepare(`UPDATE
      operations_portal_native_workspace_authority_heads SET state='revoked',ownership_epoch=?,latest_operation_id=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE target_id=? AND state='active' AND ownership_epoch=?`)
    .bind(resultingEpoch, command.operationId, command.target.targetId, expectedEpoch));
  else statements.push(command.action === "recipient.grant"
    ? database.prepare(`INSERT INTO operations_portal_native_recipient_authority_heads
      (recipient_binding_id,target_id,enrollment_intent_id,target_client_record_id,issuer,subject,ownership_epoch,
       grant_revision,state,permissions_json,expires_at,latest_operation_id) VALUES(?,?,?,?,?,?,?,1,'active',?,NULL,?)`)
      .bind(command.recipient!.recipientBindingId, command.target.targetId, command.recipient!.enrollmentIntentId,
        command.recipient!.targetClientRecordId, command.recipient!.issuer, command.recipient!.subject, resultingEpoch,
        permissions, command.operationId)
    : database.prepare(`UPDATE operations_portal_native_recipient_authority_heads SET state='revoked',grant_revision=?,
      permissions_json='[]',latest_operation_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE recipient_binding_id=? AND target_id=? AND ownership_epoch=? AND grant_revision=? AND state='active'`)
      .bind(resultingGrant, command.operationId, command.recipient!.recipientBindingId, command.target.targetId,
        resultingEpoch, expectedGrant));
  statements.push(database.prepare(`INSERT INTO operations_portal_native_authority_history
      (operation_id,action,target_id,recipient_binding_id,ownership_epoch,grant_revision,state,request_fingerprint)
      VALUES(?,?,?,?,?,?,?,?)`).bind(command.operationId, command.action, command.target.targetId,
        command.recipient?.recipientBindingId ?? null, resultingEpoch, resultingGrant,
        command.action === "recipient.grant" ? "active" : "revoked", fingerprint),
    database.prepare(`INSERT INTO operations_portal_native_authority_receipts
      (operation_id,request_fingerprint,action,target_id,recipient_binding_id,ownership_epoch,grant_revision,state)
      VALUES(?,?,?,?,?,?,?,?)`).bind(command.operationId, fingerprint, command.action, command.target.targetId,
        command.recipient?.recipientBindingId ?? null, resultingEpoch, resultingGrant,
        command.action === "recipient.grant" ? "active" : "revoked"));
  try { await database.batch(statements); }
  catch {
    const raced = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT request_fingerprint,action,target_id,
      recipient_binding_id,ownership_epoch,grant_revision,state FROM operations_portal_native_authority_receipts WHERE operation_id=?`)
      .bind(command.operationId).first<ReceiptRow>();
    return response(raced && raced.request_fingerprint === fingerprint
      ? result(command.operationId, raced, true)
      : { ok: false, protocolVersion: 1, code: "conflict", retryable: false });
  }
  return response(result(command.operationId, { request_fingerprint: fingerprint, action: command.action,
    target_id: command.target.targetId, recipient_binding_id: command.recipient?.recipientBindingId ?? null,
    ownership_epoch: resultingEpoch, grant_revision: resultingGrant,
    state: command.action === "recipient.grant" ? "active" : "revoked" }, false));
}

export async function readOperationsPortalNativeRecipientAuthorityStatus(
  env: Pick<Env, "DELIVERY_DB" | "ENVIRONMENT"> & { CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED?: string }, raw: unknown,
): Promise<string> {
  if (env.ENVIRONMENT !== "staging" || env.CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED !== "true")
    return response({ ok: false, protocolVersion: 1, code: "disabled", retryable: true });
  if (typeof raw !== "string" || encoder.encode(raw).byteLength > 1024) return response({ ok: false, protocolVersion: 1, code: "invalid", retryable: false });
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { return response({ ok: false, protocolVersion: 1, code: "invalid", retryable: false }); }
  const value = exact(parsed, ["protocolVersion", "operationId"]);
  if (!value || value.protocolVersion !== 1 || typeof value.operationId !== "string" || !UUID.test(value.operationId)
    || JSON.stringify(parsed) !== raw) return response({ ok: false, protocolVersion: 1, code: "invalid", retryable: false });
  const row = await env.DELIVERY_DB.withSession("first-primary").prepare(`SELECT request_fingerprint,action,target_id,
      recipient_binding_id,ownership_epoch,grant_revision,state FROM operations_portal_native_authority_receipts WHERE operation_id=?`)
    .bind(value.operationId).first<ReceiptRow>();
  return response(row ? { ...result(value.operationId, row, false), status: "recorded" as const }
    : { ok: false, protocolVersion: 1, code: "not_found", retryable: false });
}
