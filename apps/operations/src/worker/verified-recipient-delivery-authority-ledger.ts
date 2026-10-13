import {
  canonicalVerifiedRecipientDeliveryAuthorityCommand,
  parseVerifiedRecipientDeliveryAuthorityCommand,
  parseVerifiedRecipientDeliveryAuthorityReceipt,
  type VerifiedRecipientDeliveryAuthorityCommand,
  type VerifiedRecipientDeliveryAuthorityReceipt,
} from "@ltds/shared/verified-recipient-delivery-authority";

export type DeliveryAuthorityBridge = Readonly<{
  applyAuthority(command: VerifiedRecipientDeliveryAuthorityCommand): Promise<unknown>;
  getAuthorityStatus(command: VerifiedRecipientDeliveryAuthorityCommand): Promise<unknown>;
}>;
export type VerifiedRecipientDeliveryAuthorityDispatchEnv = Readonly<{
  ENVIRONMENT?: string; EXPECTED_HOST?: string;
  VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_DISPATCH_ENABLED?: string;
  VERIFIED_RECIPIENT_DELIVERY_AUTHORITY?: DeliveryAuthorityBridge;
  OPS_DB: D1Database; DELIVERY_DB: D1Database;
}>;
type ResourceProof = Readonly<{
  folderBindingId: string; workspaceId: string; sourceId: string; projectPublicId: string;
  folderBindingSourceVersion: string; projectSourceVersion: string; currentGenerationId: string;
  r2Prefix: string; publicationKind: "primary" | "secondary"; publicationVersion: number;
  opsProjectId: string; opsDivisionId: string;
}>;
type StoredCommandRow = {
  canonical_command_json: string; command_sha256: string; operation_fingerprint: string;
  resource_proof_json: string; resource_proof_sha256: string; action: "upsert" | "revoke";
};
type OutboxRow = StoredCommandRow & { operation_id: string; state: string; attempt_count: number };

const encoder = new TextEncoder();
const OPERATION_NAMESPACE = "verified-recipient-delivery-authority:v1:";
const MAX_ATTEMPTS = 12;

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
function canonicalProof(proof: ResourceProof): string { return JSON.stringify(proof); }
function denied(cause?: unknown): never { throw new Error("verified_recipient_delivery_authority_denied", { cause }); }
function bridgeEnvelope(value: unknown): { receipt?: unknown; code?: string; retryable?: boolean } | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const record = value as Record<string, unknown>;
    const descriptors = Object.getOwnPropertyDescriptors(record);
    if (Reflect.ownKeys(record).some(key => typeof key !== "string")
      || Object.values(descriptors).some(descriptor => !("value" in descriptor))) return null;
    if (record.ok === true && Object.keys(record).length === 2 && Object.hasOwn(record, "receipt"))
      return { receipt: record.receipt };
    const codes = ["disabled", "invalid", "conflict", "not_found", "temporarily-unavailable"];
    if (record.ok === false && record.protocol === "verified-recipient-delivery-authority" && record.protocolVersion === 1
      && typeof record.code === "string" && codes.includes(record.code) && typeof record.retryable === "boolean"
      && Object.keys(record).length === 5) return { code: record.code, retryable: record.retryable };
    return null;
  } catch { return null; }
}

async function currentResourceProof(
  opsDb: D1DatabaseSession, deliveryDb: D1DatabaseSession, command: VerifiedRecipientDeliveryAuthorityCommand,
): Promise<{ proof: ResourceProof; json: string; hash: string }> {
  const client = await deliveryDb.prepare(`SELECT folder.r2_prefix,
      CASE WHEN primary_receipt.binding_id IS NOT NULL THEN 'primary' ELSE 'secondary' END publication_kind,
      CASE WHEN primary_receipt.binding_id IS NOT NULL THEN primary_receipt.version ELSE authority.version END publication_version
    FROM portal_v2_folder_bindings folder
    JOIN portal_v2_workspaces workspace ON workspace.id=folder.workspace_id AND workspace.status='active'
    JOIN portal_v2_directory_checkpoints checkpoint ON checkpoint.workspace_id=workspace.id
      AND checkpoint.active_generation_id=?
    JOIN portal_v2_directory_generations generation ON generation.id=checkpoint.active_generation_id
      AND generation.workspace_id=workspace.id AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities project ON project.workspace_id=workspace.id AND project.generation_id=generation.id
      AND project.entity_type='project' AND project.public_id=? AND project.source_version=? AND project.active=1
    LEFT JOIN portal_primary_staff_bindings primary_receipt ON primary_receipt.binding_id=folder.id
      AND primary_receipt.workspace_id=workspace.id AND primary_receipt.source_id=workspace.project_alpha_source_id
      AND primary_receipt.project_public_id=project.public_id AND primary_receipt.project_source_version=project.source_version
      AND primary_receipt.directory_generation_id=generation.id AND primary_receipt.r2_prefix=folder.r2_prefix
      AND primary_receipt.state='active'
    LEFT JOIN portal_native_staff_bindings native_binding ON native_binding.binding_id=folder.id
      AND native_binding.workspace_id=workspace.id AND native_binding.source_id=workspace.project_alpha_source_id
      AND native_binding.project_public_id=project.public_id AND native_binding.r2_prefix=folder.r2_prefix
    LEFT JOIN pa_portal_source_authorities authority ON authority.source_id=native_binding.source_id
      AND authority.state='active'
    LEFT JOIN pa_portal_source_authority_revisions authority_revision ON authority_revision.source_id=authority.source_id
      AND authority_revision.revision=authority.active_revision
    WHERE folder.id=? AND folder.workspace_id=? AND folder.source_version=? AND folder.status='active'
      AND folder.revoked_at IS NULL AND folder.owner_scope_type='project' AND folder.owner_public_id=?
      AND workspace.project_alpha_source_id=? AND folder.r2_prefix IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM portal_v2_root_access_policies policy
        WHERE policy.projection_source_id=workspace.project_alpha_source_id AND policy.root_type=workspace.root_type
          AND policy.root_public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)
          AND policy.state='revoked')
      AND ((?='project-alpha:primary' AND primary_receipt.binding_id IS NOT NULL)
        OR (?<>'project-alpha:primary' AND native_binding.binding_id IS NOT NULL
          AND authority.source_id IS NOT NULL AND authority_revision.source_id IS NOT NULL))`)
    .bind(command.resource.currentGenerationId, command.resource.projectPublicId, command.resource.projectSourceVersion,
      command.resource.folderBindingId, command.selection.workspaceId, command.resource.folderBindingSourceVersion,
      command.resource.projectPublicId, command.resource.sourceId, command.resource.sourceId, command.resource.sourceId)
    .first<{ r2_prefix: string; publication_kind: "primary" | "secondary"; publication_version: number }>();
  if (!client || !Number.isSafeInteger(client.publication_version) || client.publication_version < 1) denied();
  const opsRows = await opsDb.prepare(`SELECT project.id ops_project_id,folder.division_id ops_division_id,folder.r2_prefix
    FROM pa_projects project JOIN project_folders folder ON folder.project_id=project.id
    WHERE project.projection_source_id=? AND project.active=1 AND json_valid(project.payload_json)
      AND json_extract(project.payload_json,'$.public_id')=? AND rtrim(folder.r2_prefix,'/')||'/'=?`)
    .bind(command.resource.sourceId, command.resource.projectPublicId, client.r2_prefix).all<{
      ops_project_id: string; ops_division_id: string; r2_prefix: string;
    }>();
  if (!opsRows.success || opsRows.results.length !== 1) denied();
  const ops = opsRows.results[0]!;
  const proof: ResourceProof = Object.freeze({
    folderBindingId: command.resource.folderBindingId, workspaceId: command.selection.workspaceId,
    sourceId: command.resource.sourceId, projectPublicId: command.resource.projectPublicId,
    folderBindingSourceVersion: command.resource.folderBindingSourceVersion,
    projectSourceVersion: command.resource.projectSourceVersion, currentGenerationId: command.resource.currentGenerationId,
    r2Prefix: ops.r2_prefix, publicationKind: client.publication_kind, publicationVersion: client.publication_version,
    opsProjectId: ops.ops_project_id, opsDivisionId: ops.ops_division_id,
  });
  const json = canonicalProof(proof);
  return { proof, json, hash: await sha256(json) };
}

async function priorResourceProof(db: D1DatabaseSession, command: VerifiedRecipientDeliveryAuthorityCommand) {
  const row = await db.prepare(`SELECT resource_proof_json,resource_proof_sha256 FROM verified_recipient_delivery_authority_heads
    WHERE authority_id=? AND state='active' AND revision=? AND recipient_binding_id=? AND folder_binding_id=?
      AND enrollment_intent_id=? AND enrollment_revision=? AND selection_id=? AND workspace_id=?`)
    .bind(command.authority.authorityId, command.authority.expectedRevision, command.recipient.recipientBindingId,
      command.resource.folderBindingId, command.recipient.enrollmentIntentId, command.recipient.enrollmentRevision,
      command.selection.selectionId, command.selection.workspaceId)
    .first<{ resource_proof_json: string; resource_proof_sha256: string }>();
  if (!row || await sha256(row.resource_proof_json) !== row.resource_proof_sha256) denied();
  const proof = JSON.parse(row.resource_proof_json) as ResourceProof;
  return { proof, json: row.resource_proof_json, hash: row.resource_proof_sha256 };
}

function commandBindings(command: VerifiedRecipientDeliveryAuthorityCommand, commandJson: string, commandHash: string,
  fingerprint: string, resource: { proof: ResourceProof; json: string; hash: string }): unknown[] {
  const access = command.terms.accessTerms;
  return [command.operationId, command.action, commandHash, fingerprint, commandJson,
    command.authority.authorityId, command.authority.expectedRevision, command.authority.resultingRevision,
    command.recipient.recipientBindingId, command.recipient.enrollmentIntentId, command.recipient.enrollmentRevision,
    command.recipient.issuer, command.recipient.subject, command.selection.selectionId,
    command.selection.clientAuthorityId, command.selection.clientRecordId, command.selection.workspaceId,
    command.homeAuthority.ownershipEpoch, command.homeAuthority.grantRevision, command.homeAuthority.grantOperationId,
    command.resource.folderBindingId, command.resource.folderBindingSourceVersion, command.resource.sourceId,
    command.resource.projectPublicId, command.resource.projectSourceVersion, command.resource.currentGenerationId,
    resource.proof.opsProjectId, resource.proof.opsDivisionId, resource.proof.r2Prefix, resource.hash, resource.json,
    command.terms.reasonCode, command.terms.expiresAt, access.id, access.kind, access.mode,
    access.reviewedExpiresAt, access.effectiveExpiresAt, command.ownerProof.staffId,
    command.ownerProof.verifiedAccessSubject, command.ownerProof.admissionVersion, command.ownerProof.profileVersion,
    command.ownerProof.grantGeneration, command.ownerProof.verifiedUntil];
}

async function identicalReplay(db: D1DatabaseSession, operationId: string, commandHash: string,
  fingerprint: string, resourceHash?: string) {
  const row = await db.prepare(`SELECT command_sha256,operation_fingerprint,resource_proof_sha256
    FROM verified_recipient_delivery_authority_commands WHERE operation_id=?`).bind(operationId)
    .first<{ command_sha256: string; operation_fingerprint: string; resource_proof_sha256: string }>();
  if (!row || row.command_sha256 !== commandHash || row.operation_fingerprint !== fingerprint
    || (resourceHash !== undefined && row.resource_proof_sha256 !== resourceHash)) denied();
  const state = await db.prepare("SELECT state FROM verified_recipient_delivery_authority_outbox WHERE operation_id=?")
    .bind(operationId).first<string>("state");
  if (!state) denied();
  return { operationId, state, replayed: true as const };
}

export async function enqueueVerifiedRecipientDeliveryAuthority(
  opsDatabase: D1Database, deliveryDatabase: D1Database, raw: unknown,
): Promise<Readonly<{ operationId: string; state: string; replayed: boolean }>> {
  const command = parseVerifiedRecipientDeliveryAuthorityCommand(raw);
  if (!command) denied();
  const opsDb = opsDatabase.withSession("first-primary");
  const deliveryDb = deliveryDatabase.withSession("first-primary");
  const commandJson = canonicalVerifiedRecipientDeliveryAuthorityCommand(command);
  const commandHash = await sha256(commandJson);
  const fingerprint = await sha256(OPERATION_NAMESPACE + commandJson);
  const priorOperation = await opsDb.prepare("SELECT 1 FROM verified_recipient_delivery_authority_commands WHERE operation_id=?")
    .bind(command.operationId).first();
  if (priorOperation) return identicalReplay(opsDb, command.operationId, commandHash, fingerprint);
  const resource = command.action === "upsert"
    ? await currentResourceProof(opsDb, deliveryDb, command)
    : await priorResourceProof(opsDb, command);
  const insert = opsDb.prepare(`INSERT INTO verified_recipient_delivery_authority_commands(
      operation_id,action,command_sha256,operation_fingerprint,canonical_command_json,authority_id,expected_revision,
      resulting_revision,recipient_binding_id,enrollment_intent_id,enrollment_revision,issuer,subject,selection_id,
      client_authority_id,client_record_id,workspace_id,home_ownership_epoch,home_grant_revision,home_grant_operation_id,
      folder_binding_id,folder_binding_source_version,source_id,project_public_id,project_source_version,current_generation_id,
      ops_project_id,ops_division_id,r2_prefix,resource_proof_sha256,resource_proof_json,reason_code,expires_at,access_terms_id,
      access_kind,access_mode,reviewed_expires_at,effective_expires_at,authorized_by_staff_id,authorized_access_subject,
      authorized_admission_version,authorized_profile_version,authorized_grant_generation,authorized_verified_until)
    VALUES(${new Array(44).fill("?").join(",")})`).bind(...commandBindings(command, commandJson, commandHash, fingerprint, resource));
  const headColumns = `authority_id,revision,state,latest_operation_id,recipient_binding_id,enrollment_intent_id,enrollment_revision,
    issuer,subject,selection_id,client_authority_id,client_record_id,workspace_id,home_ownership_epoch,home_grant_revision,
    home_grant_operation_id,folder_binding_id,folder_binding_source_version,source_id,project_public_id,project_source_version,
    current_generation_id,ops_project_id,ops_division_id,r2_prefix,resource_proof_sha256,resource_proof_json,reason_code,
    expires_at,access_terms_id,access_kind,access_mode,reviewed_expires_at,effective_expires_at`;
  const commandSelect = `authority_id,resulting_revision,CASE action WHEN 'upsert' THEN 'active' ELSE 'revoked' END,operation_id,
    recipient_binding_id,enrollment_intent_id,enrollment_revision,issuer,subject,selection_id,client_authority_id,client_record_id,
    workspace_id,home_ownership_epoch,home_grant_revision,home_grant_operation_id,folder_binding_id,folder_binding_source_version,
    source_id,project_public_id,project_source_version,current_generation_id,ops_project_id,ops_division_id,r2_prefix,
    resource_proof_sha256,resource_proof_json,reason_code,expires_at,access_terms_id,access_kind,access_mode,
    reviewed_expires_at,effective_expires_at`;
  const mutateHead = command.authority.expectedRevision === 0
    ? opsDb.prepare(`INSERT INTO verified_recipient_delivery_authority_heads(${headColumns}) SELECT ${commandSelect}
        FROM verified_recipient_delivery_authority_commands WHERE operation_id=?`).bind(command.operationId)
    : opsDb.prepare(`UPDATE verified_recipient_delivery_authority_heads SET (${headColumns})=(SELECT ${commandSelect}
        FROM verified_recipient_delivery_authority_commands WHERE operation_id=?) WHERE authority_id=? AND revision=? AND state='active'`)
      .bind(command.operationId, command.authority.authorityId, command.authority.expectedRevision);
  const statements: D1PreparedStatement[] = [insert, mutateHead];
  if (command.action === "revoke") statements.push(opsDb.prepare(`INSERT INTO verified_recipient_delivery_authority_tombstones
    (authority_id,operation_id,revision,recipient_binding_id,folder_binding_id) VALUES(?,?,?,?,?)`)
    .bind(command.authority.authorityId, command.operationId, command.authority.resultingRevision,
      command.recipient.recipientBindingId, command.resource.folderBindingId));
  statements.push(
    opsDb.prepare(`INSERT INTO verified_recipient_delivery_authority_commits(operation_id,authority_id,resulting_revision,resulting_state)
      VALUES(?,?,?,?)`).bind(command.operationId, command.authority.authorityId, command.authority.resultingRevision,
      command.action === "upsert" ? "active" : "revoked"),
    opsDb.prepare("INSERT INTO verified_recipient_delivery_authority_outbox(operation_id) VALUES(?)").bind(command.operationId),
    opsDb.prepare(`INSERT INTO verified_recipient_delivery_authority_audit
      (operation_id,action,operation_fingerprint,authorized_by_staff_id,authorized_grant_generation) VALUES(?,?,?,?,?)`)
      .bind(command.operationId, command.action === "upsert" ? "resource.intent.enqueued" : "resource.revoke.enqueued",
        fingerprint, command.ownerProof.staffId, command.ownerProof.grantGeneration),
  );
  try { await opsDb.batch(statements); }
  catch (error) {
    try { return await identicalReplay(opsDb, command.operationId, commandHash, fingerprint, resource.hash); }
    catch { denied(error); }
  }
  return { operationId: command.operationId, state: "pending", replayed: false };
}

async function currentUpsertFresh(opsDb: D1DatabaseSession, deliveryDb: D1DatabaseSession,
  command: VerifiedRecipientDeliveryAuthorityCommand, resourceHash: string): Promise<boolean> {
  try {
    const resource = await currentResourceProof(opsDb, deliveryDb, command);
    if (resource.hash !== resourceHash) return false;
  } catch { return false; }
  return Boolean(await opsDb.prepare(`SELECT 1 FROM verified_recipient_delivery_authority_commands command
    JOIN verified_recipient_delivery_authority_heads head ON head.authority_id=command.authority_id
      AND head.latest_operation_id=command.operation_id AND head.state='active'
    JOIN native_staff_admissions admission ON admission.staff_id=command.authorized_by_staff_id AND admission.active=1
      AND admission.bound_access_subject=command.authorized_access_subject AND admission.version=command.authorized_admission_version
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id AND profile.version=command.authorized_profile_version
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
      AND generation.generation=command.authorized_grant_generation
    JOIN client_portal_recipient_enrollment_intents intent ON intent.intent_id=command.enrollment_intent_id
      AND intent.state='active' AND intent.revision=command.enrollment_revision AND intent.binding_id=command.recipient_binding_id
      AND intent.grant_operation_id=command.home_grant_operation_id
    JOIN client_onboarding_recipient_identity_bindings recipient ON recipient.binding_id=intent.binding_id AND recipient.status='active'
      AND (recipient.expires_at IS NULL OR recipient.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    JOIN client_portal_authority_v2_outbox home ON home.operation_id=command.home_grant_operation_id
      AND home.state='acknowledged' AND home.protocol_version=3 AND home.desired_state='active'
      AND home.permissions_json='["operations.service_home.read"]'
    JOIN client_portal_authority_v2_outbox_receipts receipt ON receipt.operation_id=home.operation_id
      AND receipt.resulting_state='active' AND receipt.protocol_version=3
      AND receipt.ownership_epoch=command.home_ownership_epoch AND receipt.grant_revision=command.home_grant_revision
      AND receipt.permissions_json='["operations.service_home.read"]'
    WHERE command.operation_id=? AND command.action='upsert'
      AND command.authorized_verified_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_cancellations cancellation
        WHERE cancellation.intent_id=intent.intent_id)
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=command.authorized_by_staff_id
        AND role.role_id='role-owner' AND role.scope='global')
      AND EXISTS(SELECT 1 FROM native_directory_grants grant_row
        JOIN client_portal_workspace_binding_selections selection ON selection.selection_id=command.selection_id
        WHERE grant_row.staff_id=command.authorized_by_staff_id AND grant_row.permission='directory.portal_access.manage'
          AND grant_row.effect='allow' AND grant_row.active=1 AND (grant_row.scope_kind='global'
            OR (grant_row.scope_kind='resource' AND grant_row.resource_id=selection.record_id)))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny
        JOIN client_portal_workspace_binding_selections selection ON selection.selection_id=command.selection_id
        WHERE deny.staff_id=command.authorized_by_staff_id AND deny.permission='directory.portal_access.manage'
          AND deny.effect='deny' AND deny.active=1 AND (deny.scope_kind='global'
            OR (deny.scope_kind='resource' AND deny.resource_id=selection.record_id)
            OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=selection.record_id AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
            OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
              WHERE scope.record_id=selection.record_id AND scope.active=1 AND scope.division_id=deny.division_id))))
      AND (SELECT count(DISTINCT permission.permission_key) FROM verified_recipient_delivery_effective_permissions permission
        WHERE permission.staff_id=command.authorized_by_staff_id AND permission.effect='allow'
          AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.create')
          AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=command.ops_division_id)))=3
      AND NOT EXISTS(SELECT 1 FROM verified_recipient_delivery_effective_permissions permission
        WHERE permission.staff_id=command.authorized_by_staff_id AND permission.effect='deny'
          AND permission.permission_key IN ('projects.view','delivery.browse','delivery.share.create')
          AND (permission.scope='global' OR (permission.scope='division' AND permission.division_id=command.ops_division_id)))`)
    .bind(command.operationId).first());
}

async function exactCommittedRevoke(db: D1DatabaseSession, operationId: string): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT 1 FROM verified_recipient_delivery_authority_commands command
    JOIN verified_recipient_delivery_authority_heads head ON head.authority_id=command.authority_id
      AND head.latest_operation_id=command.operation_id AND head.state='revoked' AND head.revision=command.resulting_revision
    JOIN verified_recipient_delivery_authority_tombstones tombstone ON tombstone.operation_id=command.operation_id
      AND tombstone.authority_id=command.authority_id AND tombstone.revision=command.resulting_revision
    JOIN verified_recipient_delivery_authority_commits committed ON committed.operation_id=command.operation_id
      AND committed.authority_id=command.authority_id AND committed.resulting_state='revoked'
    WHERE command.operation_id=? AND command.action='revoke'`).bind(operationId).first());
}

function retryDelay(attempt: number) { return Math.min(3600, 5 * 2 ** Math.min(attempt, 9)); }
async function release(db: D1DatabaseSession, operationId: string, claim: string, attempt: number, code: string, dead = false) {
  await db.prepare(`UPDATE verified_recipient_delivery_authority_outbox SET state=?,attempt_count=?,last_error_code=?,
    next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ','now',?),claim_token=NULL,claim_until=NULL,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_id=? AND state='dispatching' AND claim_token=?`)
    .bind(dead ? "dead" : "retry", attempt, code, `+${retryDelay(attempt)} seconds`, operationId, claim).run();
}

async function acknowledgeReceipt(db: D1DatabaseSession, operationId: string, claim: string,
  receipt: VerifiedRecipientDeliveryAuthorityReceipt): Promise<boolean> {
  const receiptJson = JSON.stringify(receipt);
  const receiptHash = await sha256(receiptJson);
  try {
    await db.batch([
      db.prepare(`INSERT INTO verified_recipient_delivery_authority_receipts
        (operation_id,receipt_sha256,receipt_json,acknowledged_claim_token) VALUES(?,?,?,?)`)
        .bind(operationId, receiptHash, receiptJson, claim),
      db.prepare(`UPDATE verified_recipient_delivery_authority_outbox SET state='acknowledged',last_error_code=NULL,
        acknowledged_claim_token=?,claim_token=NULL,claim_until=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE operation_id=? AND state='dispatching' AND claim_token=?`).bind(claim, operationId, claim),
    ]);
    return true;
  } catch { return false; }
}

export async function dispatchNextVerifiedRecipientDeliveryAuthority(input: Readonly<{
  opsDatabase: D1Database; deliveryDatabase: D1Database; binding: DeliveryAuthorityBridge; operationId?: string;
}>): Promise<Readonly<{ operationId: string; state: string }> | null> {
  const db = input.opsDatabase.withSession("first-primary");
  const deliveryDb = input.deliveryDatabase.withSession("first-primary");
  const operationId = input.operationId ?? await db.prepare(`SELECT operation_id FROM verified_recipient_delivery_authority_outbox
    WHERE state IN ('pending','retry','dispatching') AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND (state<>'dispatching' OR claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    ORDER BY created_at,operation_id LIMIT 1`).first<string>("operation_id");
  if (!operationId) return null;
  const claim = crypto.randomUUID();
  const claimed = await db.prepare(`UPDATE verified_recipient_delivery_authority_outbox SET state='dispatching',
    claim_token=?,claim_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'),attempt_count=attempt_count+1,
    updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE operation_id=? AND state IN ('pending','retry','dispatching')
      AND next_attempt_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND (state<>'dispatching' OR claim_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))`).bind(claim, operationId).run();
  if (claimed.meta.changes !== 1) return null;
  const row = await db.prepare(`SELECT outbox.operation_id,outbox.state,outbox.attempt_count,command.*
    FROM verified_recipient_delivery_authority_outbox outbox
    JOIN verified_recipient_delivery_authority_commands command ON command.operation_id=outbox.operation_id
    WHERE outbox.operation_id=? AND outbox.claim_token=?`).bind(operationId, claim).first<OutboxRow>();
  if (!row) return null;
  let parsedStored: unknown;
  try { parsedStored = JSON.parse(row.canonical_command_json); }
  catch {
    await release(db, operationId, claim, row.attempt_count, "stored_command_invalid", row.action === "upsert");
    return { operationId, state: row.action === "upsert" ? "dead" : "retry" };
  }
  const command = parseVerifiedRecipientDeliveryAuthorityCommand(parsedStored);
  if (!command || await sha256(row.canonical_command_json) !== row.command_sha256) {
    // The command row is immutable and its stored action is the last trustworthy
    // discriminator when the canonical payload/hash has been corrupted. A
    // committed revoke must remain visible for retry/manual reconciliation until
    // Client acknowledges it; dead-lettering it would falsely drain the binding.
    const dead = row.action === "upsert";
    await release(db, operationId, claim, row.attempt_count, "stored_command_invalid", dead);
    return { operationId, state: dead ? "dead" : "retry" };
  }

  let statusEnvelope: ReturnType<typeof bridgeEnvelope>;
  try { statusEnvelope = bridgeEnvelope(await input.binding.getAuthorityStatus(command)); }
  catch {
    await release(db, operationId, claim, row.attempt_count, "client_status_unavailable");
    return { operationId, state: "retry" };
  }
  let statusReceipt: VerifiedRecipientDeliveryAuthorityReceipt | null = null;
  try { statusReceipt = parseVerifiedRecipientDeliveryAuthorityReceipt(statusEnvelope?.receipt, command); }
  catch { /* hostile or malformed status receipt */ }
  if (statusReceipt) {
    if (await acknowledgeReceipt(db, operationId, claim, statusReceipt)) return { operationId, state: "acknowledged" };
    await release(db, operationId, claim, row.attempt_count, "receipt_commit_failed");
    return { operationId, state: "retry" };
  }
  if (!statusEnvelope || statusEnvelope.code !== "not_found") {
    await release(db, operationId, claim, row.attempt_count, "client_status_invalid");
    return { operationId, state: "retry" };
  }
  const fresh = command.action === "upsert"
    ? await currentUpsertFresh(db, deliveryDb, command, row.resource_proof_sha256)
    : await exactCommittedRevoke(db, operationId);
  if (!fresh) {
    await release(db, operationId, claim, row.attempt_count, "freshness_denied", command.action === "upsert");
    return { operationId, state: command.action === "upsert" ? "dead" : "retry" };
  }
  let rawEnvelope: unknown;
  try { rawEnvelope = await input.binding.applyAuthority(command); }
  catch {
    try { rawEnvelope = await input.binding.getAuthorityStatus(command); }
    catch { rawEnvelope = null; }
  }
  let envelope = bridgeEnvelope(rawEnvelope);
  if (envelope?.code && envelope.retryable) {
    try { envelope = bridgeEnvelope(await input.binding.getAuthorityStatus(command)); } catch { /* retry below */ }
  }
  let receipt: VerifiedRecipientDeliveryAuthorityReceipt | null = null;
  try { receipt = parseVerifiedRecipientDeliveryAuthorityReceipt(envelope?.receipt, command); }
  catch { /* hostile bridge value is an invalid receipt */ }
  if (!receipt) {
    // A committed revoke is the deny-first recovery path and must remain
    // dispatchable until Client has durably acknowledged it. Attempt caps may
    // dead-letter creates/renewals, never a committed revoke.
    const dead = command.action === "upsert" && (envelope?.retryable === false || row.attempt_count >= MAX_ATTEMPTS);
    await release(db, operationId, claim, row.attempt_count, envelope?.code ?? "client_receipt_invalid", dead);
    return { operationId, state: dead ? "dead" : "retry" };
  }
  if (!await acknowledgeReceipt(db, operationId, claim, receipt)) {
    await release(db, operationId, claim, row.attempt_count, "receipt_commit_failed");
    return { operationId, state: "retry" };
  }
  return { operationId, state: "acknowledged" };
}

export function dispatchStagedVerifiedRecipientDeliveryAuthority(
  env: VerifiedRecipientDeliveryAuthorityDispatchEnv, operationId?: string,
) {
  if (env.ENVIRONMENT !== "staging" || env.EXPECTED_HOST !== "ops-staging.ledgetopdroneservices.com"
    || env.VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_DISPATCH_ENABLED !== "true"
    || !env.VERIFIED_RECIPIENT_DELIVERY_AUTHORITY) return Promise.resolve(null);
  return dispatchNextVerifiedRecipientDeliveryAuthority({ opsDatabase: env.OPS_DB, deliveryDatabase: env.DELIVERY_DB,
    binding: env.VERIFIED_RECIPIENT_DELIVERY_AUTHORITY, operationId });
}

export type VerifiedRecipientDeliveryAuthorityDrainStatus = Readonly<{
  authorityId: string; folderBindingId: string; revision: number; state: "active" | "revoked";
  latestOperationId: string; clientReceiptAcknowledged: boolean;
}>;
export async function listVerifiedRecipientDeliveryAuthoritiesForEnrollment(
  database: D1Database, recipientBindingId: string,
): Promise<readonly VerifiedRecipientDeliveryAuthorityDrainStatus[]> {
  const rows = await database.withSession("first-primary").prepare(`SELECT head.authority_id,head.folder_binding_id,
      head.revision,head.state,head.latest_operation_id,
      CASE WHEN outbox.state='acknowledged' AND receipt.operation_id IS NOT NULL THEN 1 ELSE 0 END acknowledged
    FROM verified_recipient_delivery_authority_heads head
    LEFT JOIN verified_recipient_delivery_authority_outbox outbox ON outbox.operation_id=head.latest_operation_id
    LEFT JOIN verified_recipient_delivery_authority_receipts receipt ON receipt.operation_id=outbox.operation_id
    WHERE head.recipient_binding_id=? ORDER BY head.authority_id`).bind(recipientBindingId).all<{
      authority_id: string; folder_binding_id: string; revision: number; state: "active" | "revoked";
      latest_operation_id: string; acknowledged: number;
    }>();
  if (!rows.success) denied();
  return rows.results.map(row => Object.freeze({ authorityId: row.authority_id, folderBindingId: row.folder_binding_id,
    revision: row.revision, state: row.state, latestOperationId: row.latest_operation_id,
    clientReceiptAcknowledged: row.acknowledged === 1 }));
}
