import {
  canonicalVerifiedRecipientDeliveryAuthorityCommand,
  createVerifiedRecipientDeliveryAuthorityReceipt,
  parseVerifiedRecipientDeliveryAuthorityCommand,
  parseVerifiedRecipientDeliveryAuthorityReceipt,
  type VerifiedRecipientDeliveryAuthorityReceipt,
  type VerifiedRecipientDeliveryAuthorityCommand,
} from "@ltds/shared/verified-recipient-delivery-authority";
import type { Env } from "./types";

export const VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_FLAG =
  "CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED" as const;
export const VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_FLAG =
  "CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED" as const;

type Config = Pick<Env, "DELIVERY_DB"> & {
  CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED?: string;
  CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED?: string;
};
type ReceiptRow = {
  operation_id: string;
  request_fingerprint: string;
  request_json: string;
  authority_id: string;
  client_record_id: string;
  action: "upsert" | "revoke";
  expected_revision: number;
  resulting_revision: number;
  resulting_state: "active" | "revoked";
};
export type VerifiedRecipientDeliveryAuthorityResult = VerifiedRecipientDeliveryAuthorityReceipt;

const receiptColumns = "operation_id,request_fingerprint,request_json,authority_id,client_record_id,action,expected_revision,resulting_revision,resulting_state";
const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function fingerprint(command: VerifiedRecipientDeliveryAuthorityCommand): Promise<{ json: string; hash: string }> {
  const json = canonicalVerifiedRecipientDeliveryAuthorityCommand(command);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
  return { json, hash: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("") };
}

function result(row: ReceiptRow, command: VerifiedRecipientDeliveryAuthorityCommand, replayed: boolean): VerifiedRecipientDeliveryAuthorityResult {
  const receipt = createVerifiedRecipientDeliveryAuthorityReceipt(command, replayed ? "replayed" : "recorded");
  const parsed = parseVerifiedRecipientDeliveryAuthorityReceipt(receipt, command);
  if (!parsed || parsed.operationId !== row.operation_id || parsed.resultingState !== row.resulting_state
    || parsed.expectedRevision !== row.expected_revision || parsed.resultingRevision !== row.resulting_revision)
    throw new Error("verified-recipient-delivery-authority-receipt-invalid");
  return parsed;
}

function ownerProofFresh(command: VerifiedRecipientDeliveryAuthorityCommand): boolean {
  const until = Date.parse(command.ownerProof.verifiedUntil);
  return Number.isFinite(until) && until > Date.now();
}

async function existingReceipt(database: D1DatabaseSession, command: VerifiedRecipientDeliveryAuthorityCommand,
  request: { json: string; hash: string }): Promise<VerifiedRecipientDeliveryAuthorityResult | null> {
  const row = await database.prepare(`SELECT ${receiptColumns}
    FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=?`)
    .bind(command.operationId).first<ReceiptRow>();
  if (!row) return null;
  if (row.request_fingerprint !== request.hash || row.request_json !== request.json
    || row.authority_id !== command.authority.authorityId || row.client_record_id !== command.selection.clientRecordId
    || row.action !== command.action
    || row.expected_revision !== command.authority.expectedRevision
    || row.resulting_revision !== command.authority.resultingRevision
    || row.resulting_state !== (command.action === "upsert" ? "active" : "revoked"))
    throw new Error("verified-recipient-delivery-authority-operation-conflict");
  return result(row, command, true);
}

async function currentUpsertProof(database: D1DatabaseSession, command: VerifiedRecipientDeliveryAuthorityCommand): Promise<boolean> {
  const row = await database.prepare(`SELECT 1 ok
    FROM portal_operations_workspace_authority_heads workspace_head
    JOIN portal_client_authority_workspace_binding_receipts binding_receipt
      ON binding_receipt.operation_id=workspace_head.binding_operation_id
    JOIN portal_client_authority_workspace_bindings binding
      ON binding.operation_id=binding_receipt.operation_id
    JOIN portal_v2_workspaces workspace
      ON workspace.id=workspace_head.workspace_id AND workspace.status='active'
    JOIN portal_operations_principal_grant_heads grant_head
      ON grant_head.workspace_id=workspace_head.workspace_id
      AND grant_head.client_authority_id=workspace_head.client_authority_id
      AND grant_head.issuer=? AND grant_head.subject=?
    JOIN portal_operations_authority_v2_receipts home_receipt
      ON home_receipt.operation_id=grant_head.last_operation_id
      AND home_receipt.operation_id=?
      AND home_receipt.client_authority_id=grant_head.client_authority_id
      AND home_receipt.workspace_id=grant_head.workspace_id
      AND home_receipt.issuer=grant_head.issuer AND home_receipt.subject=grant_head.subject
      AND home_receipt.ownership_epoch=grant_head.ownership_epoch
      AND home_receipt.grant_revision=grant_head.grant_revision
      AND home_receipt.resulting_state='active' AND home_receipt.protocol_version=3
      AND home_receipt.permissions_json='["operations.service_home.read"]'
    JOIN portal_v2_folder_bindings folder
      ON folder.id=? AND folder.workspace_id=workspace.id
      AND folder.source_version=? AND folder.status='active' AND folder.revoked_at IS NULL
      AND folder.owner_scope_type='project' AND folder.owner_public_id=?
    JOIN portal_v2_directory_checkpoints checkpoint
      ON checkpoint.workspace_id=workspace.id AND checkpoint.active_generation_id=?
    JOIN portal_v2_directory_generations generation
      ON generation.id=checkpoint.active_generation_id AND generation.workspace_id=workspace.id
      AND generation.status='active' AND generation.complete=1
    JOIN portal_v2_directory_entities project
      ON project.workspace_id=workspace.id AND project.generation_id=generation.id
      AND project.entity_type='project' AND project.public_id=?
      AND project.source_version=? AND project.active=1
    LEFT JOIN portal_project_access_deadlines deadline
      ON deadline.access_terms_id=?
    JOIN portal_project_access_terms terms
      ON terms.id=? AND terms.workspace_id=workspace.id
      AND terms.source_id=workspace.project_alpha_source_id
      AND terms.project_public_id=project.public_id
      AND terms.kind=? AND terms.mode=?
      AND terms.expires_at IS ?
      AND (CASE WHEN terms.mode='project_end' THEN deadline.deadline_at ELSE terms.expires_at END) IS ?
    WHERE workspace_head.workspace_id=? AND workspace_head.client_authority_id=?
      AND workspace_head.binding_operation_id=? AND binding_receipt.operation_id=?
      AND workspace_head.ownership_epoch=? AND workspace_head.state='active'
      AND binding_receipt.client_authority_id=? AND binding_receipt.workspace_id=?
      AND binding.state='inactive' AND binding.revision=1
      AND grant_head.ownership_epoch=? AND grant_head.grant_revision=?
      AND grant_head.last_operation_id=? AND grant_head.state='active'
      AND workspace.project_alpha_source_id=?
      AND NOT EXISTS(SELECT 1 FROM portal_v2_root_access_policies root_policy
        WHERE root_policy.projection_source_id=workspace.project_alpha_source_id
          AND root_policy.root_type=workspace.root_type
          AND root_policy.root_public_id=COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id)
          AND root_policy.state='revoked')
      AND (EXISTS(SELECT 1 FROM portal_primary_staff_bindings primary_binding
        WHERE primary_binding.binding_id=folder.id AND primary_binding.workspace_id=workspace.id
          AND primary_binding.source_id=? AND primary_binding.owner_scope_type='project'
          AND primary_binding.project_public_id=project.public_id
          AND primary_binding.directory_generation_id=generation.id
          AND primary_binding.project_source_version=project.source_version
          AND primary_binding.state='active')
        OR EXISTS(SELECT 1 FROM portal_native_staff_bindings native_binding
          JOIN pa_portal_source_authorities source_authority
            ON source_authority.source_id=native_binding.source_id AND source_authority.state='active'
          JOIN pa_portal_source_authority_revisions source_revision
            ON source_revision.source_id=source_authority.source_id
            AND source_revision.revision=source_authority.active_revision
          JOIN portal_native_staff_grants native_grant
            ON native_grant.binding_id=native_binding.binding_id AND native_grant.source_id=native_binding.source_id
            AND native_grant.state='active'
          JOIN portal_native_staff_grant_events publication
            ON publication.grant_id=native_grant.grant_id AND publication.authorization_id=native_grant.authorization_id
            AND publication.action='published'
          JOIN portal_v2_authenticated_delivery_grants published_grant
            ON published_grant.id=native_grant.grant_id AND published_grant.workspace_id=native_binding.workspace_id
            AND published_grant.folder_binding_id=folder.id AND published_grant.binding_source_version=folder.source_version
            AND published_grant.status='active' AND published_grant.revoked_at IS NULL
          WHERE native_binding.binding_id=folder.id AND native_binding.workspace_id=workspace.id
            AND native_binding.source_id=? AND native_binding.project_public_id=project.public_id))
      AND (terms.mode='until_revoked'
        OR (terms.mode='specific_date' AND datetime(terms.expires_at)>datetime('now'))
        OR (terms.mode='project_end' AND ((deadline.deadline_at IS NOT NULL AND datetime(deadline.deadline_at)>datetime('now'))
          OR (deadline.deadline_at IS NULL AND EXISTS(SELECT 1 FROM portal_project_access_current_lifecycle lifecycle
            WHERE lifecycle.workspace_id=terms.workspace_id AND lifecycle.source_id=terms.source_id
              AND lifecycle.project_public_id=terms.project_public_id AND lifecycle.lifecycle_status='active')))))
    LIMIT 1`).bind(
      command.recipient.issuer, command.recipient.subject, command.homeAuthority.grantOperationId,
      command.resource.folderBindingId, command.resource.folderBindingSourceVersion, command.resource.projectPublicId,
      command.resource.currentGenerationId, command.resource.projectPublicId, command.resource.projectSourceVersion,
      command.terms.accessTerms.id, command.terms.accessTerms.id, command.terms.accessTerms.kind,
      command.terms.accessTerms.mode, command.terms.accessTerms.reviewedExpiresAt,
      command.terms.accessTerms.effectiveExpiresAt, command.selection.workspaceId,
      command.selection.clientAuthorityId, command.selection.selectionId, command.selection.selectionId,
      command.homeAuthority.ownershipEpoch, command.selection.clientAuthorityId, command.selection.workspaceId,
      command.homeAuthority.ownershipEpoch, command.homeAuthority.grantRevision,
      command.homeAuthority.grantOperationId, command.resource.sourceId,
      command.resource.sourceId, command.resource.sourceId).first<{ ok: number }>();
  return row?.ok === 1;
}

async function exactHead(database: D1DatabaseSession, command: VerifiedRecipientDeliveryAuthorityCommand): Promise<boolean> {
  const row = await database.prepare(`SELECT 1 ok FROM portal_verified_recipient_delivery_authority_heads
    WHERE authority_id=? AND workspace_id=? AND client_authority_id=? AND selection_id=? AND client_record_id=?
      AND recipient_binding_id=? AND enrollment_intent_id=? AND enrollment_revision=?
      AND issuer=? AND subject=? AND home_ownership_epoch=? AND home_grant_revision=?
      AND home_grant_operation_id=? AND folder_binding_id=? AND folder_binding_source_version=?
      AND source_id=? AND project_public_id=? AND project_source_version=? AND current_generation_id=?
      AND access_terms_id=? AND access_terms_kind=? AND access_terms_mode=?
      AND reviewed_expires_at IS ? AND effective_expires_at IS ? AND expires_at IS ?
      AND reason_code=? AND authority_revision=? AND state='active'`).bind(
    command.authority.authorityId, command.selection.workspaceId, command.selection.clientAuthorityId,
    command.selection.selectionId, command.selection.clientRecordId, command.recipient.recipientBindingId, command.recipient.enrollmentIntentId,
    command.recipient.enrollmentRevision, command.recipient.issuer, command.recipient.subject,
    command.homeAuthority.ownershipEpoch, command.homeAuthority.grantRevision, command.homeAuthority.grantOperationId,
    command.resource.folderBindingId, command.resource.folderBindingSourceVersion, command.resource.sourceId,
    command.resource.projectPublicId, command.resource.projectSourceVersion, command.resource.currentGenerationId,
    command.terms.accessTerms.id, command.terms.accessTerms.kind, command.terms.accessTerms.mode,
    command.terms.accessTerms.reviewedExpiresAt, command.terms.accessTerms.effectiveExpiresAt,
    command.terms.expiresAt, command.terms.reasonCode,
    command.authority.expectedRevision).first<{ ok: number }>();
  return row?.ok === 1;
}

export async function applyVerifiedRecipientDeliveryAuthority(
  env: Config, raw: unknown,
): Promise<VerifiedRecipientDeliveryAuthorityResult> {
  if (env.CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_WRITER_ENABLED !== "true")
    throw new Error("verified-recipient-delivery-authority-writer-disabled");
  const command = parseVerifiedRecipientDeliveryAuthorityCommand(raw);
  if (!command || !operationId.test(command.operationId)) throw new Error("verified-recipient-delivery-authority-invalid");
  const request = await fingerprint(command);
  const database = env.DELIVERY_DB.withSession("first-primary");
  const prior = await existingReceipt(database, command, request);
  if (prior) return prior;
  if (command.action === "upsert") {
    if (!ownerProofFresh(command)) throw new Error("verified-recipient-delivery-authority-owner-proof-expired");
    if (!await currentUpsertProof(database, command))
      throw new Error("verified-recipient-delivery-authority-current-proof-missing");
  }
  if (command.action === "revoke" && !await exactHead(database, command))
    throw new Error("verified-recipient-delivery-authority-cas-conflict");

  const insertValues = [command.authority.authorityId, command.selection.workspaceId, command.selection.clientAuthorityId,
    command.selection.selectionId, command.selection.clientRecordId, command.recipient.recipientBindingId, command.recipient.enrollmentIntentId,
    command.recipient.enrollmentRevision, command.recipient.issuer, command.recipient.subject,
    command.homeAuthority.ownershipEpoch, command.homeAuthority.grantRevision, command.homeAuthority.grantOperationId,
    command.resource.folderBindingId, command.resource.folderBindingSourceVersion, command.resource.sourceId,
    command.resource.projectPublicId, command.resource.projectSourceVersion, command.resource.currentGenerationId,
    command.terms.accessTerms.id, command.terms.accessTerms.kind, command.terms.accessTerms.mode,
    command.terms.accessTerms.reviewedExpiresAt, command.terms.accessTerms.effectiveExpiresAt, command.terms.expiresAt,
    command.terms.reasonCode, command.ownerProof.staffId, command.ownerProof.verifiedAccessSubject,
    command.ownerProof.admissionVersion, command.ownerProof.profileVersion, command.ownerProof.grantGeneration,
    command.ownerProof.verifiedUntil, command.operationId, request.hash, command.ownerProof.staffId,
    command.ownerProof.verifiedAccessSubject, command.ownerProof.admissionVersion, command.ownerProof.profileVersion,
    command.ownerProof.grantGeneration, command.ownerProof.verifiedUntil, command.authority.resultingRevision,
    command.action === "upsert" ? "active" : "revoked", command.operationId];
  const statements = command.authority.expectedRevision === 0
    ? [database.prepare(`INSERT INTO portal_verified_recipient_delivery_authority_heads
      (authority_id,workspace_id,client_authority_id,selection_id,client_record_id,recipient_binding_id,enrollment_intent_id,enrollment_revision,issuer,subject,
       home_ownership_epoch,home_grant_revision,home_grant_operation_id,folder_binding_id,folder_binding_source_version,source_id,project_public_id,
       project_source_version,current_generation_id,access_terms_id,access_terms_kind,access_terms_mode,reviewed_expires_at,effective_expires_at,
       expires_at,reason_code,owner_staff_id,owner_access_subject,owner_admission_version,owner_profile_version,owner_grant_generation,
       owner_verified_until,created_operation_id,created_request_fingerprint,created_by_staff_id,created_by_access_subject,
       created_by_admission_version,created_by_profile_version,created_by_grant_generation,created_by_verified_until,
       authority_revision,state,last_operation_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(...insertValues),]
    : command.action === "upsert"
      ? [database.prepare(`UPDATE portal_verified_recipient_delivery_authority_heads SET
      home_ownership_epoch=?,home_grant_revision=?,home_grant_operation_id=?,folder_binding_id=?,folder_binding_source_version=?,
      source_id=?,project_public_id=?,project_source_version=?,current_generation_id=?,access_terms_id=?,access_terms_kind=?,access_terms_mode=?,
      reviewed_expires_at=?,effective_expires_at=?,expires_at=?,reason_code=?,owner_staff_id=?,owner_access_subject=?,
      owner_admission_version=?,owner_profile_version=?,owner_grant_generation=?,owner_verified_until=?,authority_revision=?,state=?,last_operation_id=?,
      revoked_at=CASE WHEN ?='revoked' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE authority_id=? AND authority_revision=? AND state='active'
        AND workspace_id=? AND client_authority_id=? AND selection_id=? AND client_record_id=?
        AND recipient_binding_id=? AND enrollment_intent_id=? AND enrollment_revision=? AND issuer=? AND subject=?
        AND folder_binding_id=? AND source_id=? AND project_public_id=?`)
      .bind(command.homeAuthority.ownershipEpoch,command.homeAuthority.grantRevision,command.homeAuthority.grantOperationId,
        command.resource.folderBindingId,command.resource.folderBindingSourceVersion,command.resource.sourceId,
        command.resource.projectPublicId,command.resource.projectSourceVersion,command.resource.currentGenerationId,
        command.terms.accessTerms.id,command.terms.accessTerms.kind,command.terms.accessTerms.mode,
        command.terms.accessTerms.reviewedExpiresAt,command.terms.accessTerms.effectiveExpiresAt,command.terms.expiresAt,command.terms.reasonCode,
        command.ownerProof.staffId,command.ownerProof.verifiedAccessSubject,command.ownerProof.admissionVersion,
        command.ownerProof.profileVersion,command.ownerProof.grantGeneration,command.ownerProof.verifiedUntil,
        command.authority.resultingRevision, command.action === "upsert" ? "active" : "revoked", command.operationId,
        command.action === "upsert" ? "active" : "revoked", command.authority.authorityId, command.authority.expectedRevision,
        command.selection.workspaceId,command.selection.clientAuthorityId,command.selection.selectionId,command.selection.clientRecordId,
        command.recipient.recipientBindingId,command.recipient.enrollmentIntentId,command.recipient.enrollmentRevision,
        command.recipient.issuer,command.recipient.subject,command.resource.folderBindingId,
        command.resource.sourceId,command.resource.projectPublicId),]
      : [database.prepare(`UPDATE portal_verified_recipient_delivery_authority_heads SET
      authority_revision=?,state='revoked',last_operation_id=?,revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE authority_id=? AND authority_revision=? AND state='active'
        AND workspace_id=? AND client_authority_id=? AND selection_id=? AND client_record_id=?
        AND recipient_binding_id=? AND enrollment_intent_id=? AND enrollment_revision=? AND issuer=? AND subject=?
        AND home_ownership_epoch=? AND home_grant_revision=? AND home_grant_operation_id=?
        AND folder_binding_id=? AND folder_binding_source_version=? AND source_id=? AND project_public_id=?
        AND project_source_version=? AND current_generation_id=? AND access_terms_id=? AND access_terms_kind=?
        AND access_terms_mode=? AND reviewed_expires_at IS ? AND effective_expires_at IS ? AND expires_at IS ?
        AND reason_code=?`)
      .bind(command.authority.resultingRevision,command.operationId,command.authority.authorityId,
        command.authority.expectedRevision,command.selection.workspaceId,command.selection.clientAuthorityId,
        command.selection.selectionId,command.selection.clientRecordId,command.recipient.recipientBindingId,
        command.recipient.enrollmentIntentId,command.recipient.enrollmentRevision,command.recipient.issuer,
        command.recipient.subject,command.homeAuthority.ownershipEpoch,command.homeAuthority.grantRevision,
        command.homeAuthority.grantOperationId,command.resource.folderBindingId,command.resource.folderBindingSourceVersion,
        command.resource.sourceId,command.resource.projectPublicId,command.resource.projectSourceVersion,
        command.resource.currentGenerationId,command.terms.accessTerms.id,command.terms.accessTerms.kind,
        command.terms.accessTerms.mode,command.terms.accessTerms.reviewedExpiresAt,
        command.terms.accessTerms.effectiveExpiresAt,command.terms.expiresAt,command.terms.reasonCode),];
  statements.push(database.prepare(`INSERT INTO portal_verified_recipient_delivery_authority_audit
    (operation_id,request_fingerprint,request_json,authority_id,client_record_id,action,expected_revision,resulting_revision,resulting_state,
     actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(command.operationId,request.hash,request.json,command.authority.authorityId,
      command.selection.clientRecordId,command.action,command.authority.expectedRevision,command.authority.resultingRevision,
      command.action === "upsert" ? "active" : "revoked",command.ownerProof.staffId,
      command.ownerProof.verifiedAccessSubject,command.ownerProof.admissionVersion,command.ownerProof.profileVersion,
      command.ownerProof.grantGeneration,command.ownerProof.verifiedUntil));
  statements.push(database.prepare(`INSERT INTO portal_verified_recipient_delivery_authority_receipts
    (operation_id,request_fingerprint,request_json,authority_id,client_record_id,action,expected_revision,resulting_revision,resulting_state)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(command.operationId,request.hash,request.json,command.authority.authorityId,command.selection.clientRecordId,command.action,
      command.authority.expectedRevision,command.authority.resultingRevision,command.action === "upsert" ? "active" : "revoked"));
  try { await database.batch(statements); }
  catch (error) {
    const raced = await existingReceipt(database, command, request);
    if (raced) return raced;
    if (/constraint|verified-recipient|FOREIGN KEY|UNIQUE/i.test(String(error)))
      throw new Error("verified-recipient-delivery-authority-cas-conflict");
    throw error;
  }
  const committed = await database.prepare(`SELECT ${receiptColumns}
    FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=?`)
    .bind(command.operationId).first<ReceiptRow>();
  if (!committed) throw new Error("verified-recipient-delivery-authority-receipt-missing");
  return result(committed, command, false);
}

export async function getVerifiedRecipientDeliveryAuthorityStatus(
  env: Config, raw: unknown,
): Promise<VerifiedRecipientDeliveryAuthorityResult | null> {
  if (env.CLIENT_PORTAL_VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_STATUS_ENABLED !== "true")
    throw new Error("verified-recipient-delivery-authority-status-disabled");
  const command = parseVerifiedRecipientDeliveryAuthorityCommand(raw);
  if (!command || !operationId.test(command.operationId)) throw new Error("verified-recipient-delivery-authority-invalid");
  const database = env.DELIVERY_DB.withSession("first-primary");
  const row = await database.prepare(`SELECT ${receiptColumns}
    FROM portal_verified_recipient_delivery_authority_receipts WHERE operation_id=?`).bind(command.operationId).first<ReceiptRow>();
  if (!row) return null;
  const request = await fingerprint(command);
  if (row.request_fingerprint !== request.hash || row.request_json !== request.json
    || row.authority_id !== command.authority.authorityId || row.client_record_id !== command.selection.clientRecordId
    || row.action !== command.action || row.expected_revision !== command.authority.expectedRevision
    || row.resulting_revision !== command.authority.resultingRevision
    || row.resulting_state !== (command.action === "upsert" ? "active" : "revoked"))
    throw new Error("verified-recipient-delivery-authority-operation-conflict");
  return result(row, command, true);
}
