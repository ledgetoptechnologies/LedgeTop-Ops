import type {
  ClientPortalServiceMetadataRequestV1,
  ClientPortalServiceMetadataResultV1,
  ClientPortalServiceMetadataV1,
} from "../../../../packages/shared/src/client-portal-service-metadata";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_SERVICES = 100;
const requestKeys = ["protocolVersion", "authorityId", "workspaceId", "ownershipEpoch", "grantRevision", "issuer", "subject"] as const;

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value
    && !value.includes("\0");
}

function parseRequest(value: unknown): ClientPortalServiceMetadataRequestV1 | null {
  if (!value || typeof value !== "object") return null;
  let descriptors: PropertyDescriptorMap;
  try {
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Reflect.ownKeys(value).some(key => typeof key !== "string")) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch { return null; }
  const keys = Object.keys(descriptors);
  if (keys.length !== requestKeys.length || keys.some(key => !requestKeys.includes(key as typeof requestKeys[number])
    || !("value" in descriptors[key]!))) return null;
  const request = Object.fromEntries(keys.map(key => [key, descriptors[key]!.value])) as Record<string, unknown>;
  if (request.protocolVersion !== 1 || typeof request.authorityId !== "string" || !UUID.test(request.authorityId)
    || !boundedText(request.workspaceId, 200) || !boundedText(request.issuer, 512) || !boundedText(request.subject, 512)
    || typeof request.ownershipEpoch !== "number" || !Number.isSafeInteger(request.ownershipEpoch) || request.ownershipEpoch < 1
    || typeof request.grantRevision !== "number" || !Number.isSafeInteger(request.grantRevision) || request.grantRevision < 1) return null;
  return { protocolVersion: 1, authorityId: request.authorityId, workspaceId: request.workspaceId,
    ownershipEpoch: request.ownershipEpoch, grantRevision: request.grantRevision,
    issuer: request.issuer, subject: request.subject };
}

type ServiceRow = { service_id: string | null; provider_id: string | null; display_name: string | null; revision: number | null };
const failure = (code: "invalid_request" | "denied" | "overflow"): ClientPortalServiceMetadataResultV1 =>
  ({ ok: false, protocolVersion: 1, code });

export const clientPortalServiceMetadataQuery = `WITH matching_authority AS (
  SELECT authority_receipt.operation_id,identity.target_client_record_id customer_record_id
  FROM client_portal_authority_v2_outbox_receipts authority_receipt
  JOIN client_portal_authority_v2_outbox authority_outbox
    ON authority_outbox.operation_id=authority_receipt.operation_id AND authority_outbox.state='acknowledged'
  JOIN client_portal_workspace_binding_outbox_receipts binding_receipt
    ON binding_receipt.operation_id=authority_outbox.binding_operation_id
  JOIN client_portal_workspace_binding_outbox binding_outbox
    ON binding_outbox.operation_id=binding_receipt.operation_id AND binding_outbox.state='acknowledged'
  JOIN client_portal_workspace_binding_selections selection
    ON selection.selection_id=binding_receipt.operation_id
  JOIN client_onboarding_recipient_identity_bindings identity
    ON identity.binding_id=authority_outbox.recipient_binding_id
  WHERE authority_receipt.client_authority_id=? AND authority_receipt.workspace_id=?
    AND authority_receipt.ownership_epoch=? AND authority_receipt.grant_revision=?
    AND authority_receipt.issuer=? AND authority_receipt.subject=? AND authority_receipt.resulting_state='active'
    AND authority_outbox.client_authority_id=authority_receipt.client_authority_id
    AND authority_outbox.workspace_id=authority_receipt.workspace_id
    AND authority_outbox.issuer=authority_receipt.issuer AND authority_outbox.subject=authority_receipt.subject
    AND binding_receipt.client_authority_id=authority_receipt.client_authority_id
    AND binding_receipt.workspace_id=authority_receipt.workspace_id
    AND binding_receipt.state='inactive' AND binding_receipt.revision=1
    AND selection.client_authority_id=binding_receipt.client_authority_id
    AND selection.workspace_id=binding_receipt.workspace_id
    AND identity.access_issuer=authority_receipt.issuer AND identity.access_subject=authority_receipt.subject
    AND identity.status='active'
    AND (identity.expires_at IS NULL OR identity.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    AND NOT EXISTS(SELECT 1 FROM client_portal_recipient_enrollment_intents enrollment_intent
      WHERE enrollment_intent.binding_id=identity.binding_id
        AND enrollment_intent.state IN ('revoking','revoked'))
    AND (selection.record_id=identity.target_client_record_id OR
      (selection.root_type='organization' AND EXISTS(
        SELECT 1 FROM operations_directory_client_organizations relation
        WHERE relation.client_record_id=identity.target_client_record_id
          AND relation.organization_record_id=selection.record_id)))
    AND NOT EXISTS(SELECT 1 FROM client_portal_authority_v2_outbox newer
      WHERE newer.workspace_id=authority_receipt.workspace_id
        AND newer.issuer=authority_receipt.issuer AND newer.subject=authority_receipt.subject
        AND (newer.expected_ownership_epoch>authority_receipt.ownership_epoch OR
          (newer.expected_ownership_epoch=authority_receipt.ownership_epoch
            AND newer.expected_grant_revision>=authority_receipt.grant_revision)))
), exact_authority AS (
  SELECT min(customer_record_id) customer_record_id FROM matching_authority HAVING count(*)=1
)
SELECT definition.service_id,definition.provider_id,definition.display_name,enrollment.revision
FROM exact_authority authority
LEFT JOIN operations_customer_service_enrollments enrollment
  ON enrollment.customer_record_id=authority.customer_record_id AND enrollment.state='active'
LEFT JOIN operations_service_definitions definition ON definition.service_id=enrollment.service_id
ORDER BY definition.service_id LIMIT ?`;

export const nativeClientPortalServiceMetadataQuery = `WITH matching_authority AS (
  SELECT recipient.recipient_binding_id,recipient.target_client_record_id customer_record_id
  FROM operations_portal_native_recipient_authority_heads recipient
  JOIN operations_portal_native_recipient_intents intent
    ON intent.intent_id=recipient.enrollment_intent_id AND intent.state='active'
      AND intent.recipient_binding_id=recipient.recipient_binding_id
      AND intent.grant_operation_id=recipient.latest_operation_id
      AND intent.access_issuer=recipient.issuer AND intent.access_subject=recipient.subject
  JOIN operations_portal_native_workspace_authority_heads workspace
    ON workspace.target_id=recipient.target_id AND workspace.state='active'
      AND workspace.ownership_epoch=recipient.ownership_epoch
  JOIN operations_portal_workspace_reservation_heads target
    ON target.target_id=workspace.target_id AND target.state='active'
      AND target.revision=workspace.target_revision
      AND target.client_authority_id=workspace.client_authority_id AND target.workspace_id=workspace.workspace_id
      AND target.root_kind=workspace.root_kind AND target.root_record_id=workspace.root_record_id
  JOIN operations_portal_native_authority_commands command
    ON command.operation_id=recipient.latest_operation_id AND command.action='recipient.grant'
      AND command.target_id=workspace.target_id AND command.target_revision=workspace.target_revision
      AND command.client_authority_id=workspace.client_authority_id AND command.workspace_id=workspace.workspace_id
      AND command.recipient_binding_id=recipient.recipient_binding_id
      AND command.enrollment_intent_id=intent.intent_id AND command.target_client_record_id=recipient.target_client_record_id
      AND command.issuer=recipient.issuer AND command.subject=recipient.subject
      AND command.resulting_ownership_epoch=recipient.ownership_epoch
      AND command.resulting_grant_revision=recipient.grant_revision
      AND command.permission_schema_version=3 AND command.permissions_json=recipient.permissions_json
  JOIN operations_portal_native_authority_outbox outbox
    ON outbox.operation_id=command.operation_id AND outbox.state='acknowledged'
  JOIN operations_portal_native_authority_receipts receipt
    ON receipt.operation_id=outbox.operation_id AND receipt.request_fingerprint=outbox.request_fingerprint
      AND receipt.target_id=workspace.target_id AND receipt.client_authority_id=workspace.client_authority_id
      AND receipt.workspace_id=workspace.workspace_id AND receipt.recipient_binding_id=recipient.recipient_binding_id
      AND receipt.enrollment_intent_id=intent.intent_id AND receipt.issuer=recipient.issuer AND receipt.subject=recipient.subject
      AND receipt.ownership_epoch=recipient.ownership_epoch AND receipt.grant_revision=recipient.grant_revision
      AND receipt.resulting_state='active' AND receipt.permission_schema_version=3
      AND receipt.permissions_json=recipient.permissions_json
  JOIN client_onboarding_recipient_identity_bindings identity
    ON identity.binding_id=recipient.recipient_binding_id AND identity.status='active'
      AND identity.target_client_record_id=recipient.target_client_record_id
      AND identity.access_issuer=recipient.issuer AND identity.access_subject=recipient.subject
      AND (identity.expires_at IS NULL OR datetime(identity.expires_at)>datetime('now'))
  JOIN operations_directory_client_organizations relation
    ON relation.client_record_id=recipient.target_client_record_id
      AND relation.relationship_version=intent.target_relationship_version
  WHERE workspace.client_authority_id=? AND workspace.workspace_id=?
    AND recipient.ownership_epoch=? AND recipient.grant_revision=? AND recipient.issuer=? AND recipient.subject=?
    AND recipient.state='active' AND recipient.permission_schema_version=3
    AND recipient.permissions_json='["operations.service_home.read"]'
    AND (recipient.expires_at IS NULL OR datetime(recipient.expires_at)>datetime('now'))
    AND ((workspace.root_kind='organization' AND relation.organization_record_id=workspace.root_record_id)
      OR (workspace.root_kind='standalone_client' AND recipient.target_client_record_id=workspace.root_record_id
        AND relation.organization_record_id IS NULL))
), exact_authority AS (
  SELECT min(customer_record_id) customer_record_id FROM matching_authority HAVING count(*)=1
)
SELECT definition.service_id,definition.provider_id,definition.display_name,enrollment.revision
FROM exact_authority authority
LEFT JOIN operations_customer_service_enrollments enrollment
  ON enrollment.customer_record_id=authority.customer_record_id AND enrollment.state='active'
LEFT JOIN operations_service_definitions definition ON definition.service_id=enrollment.service_id
ORDER BY definition.service_id LIMIT ?`;

/**
 * Reads descriptive service metadata for one already-authorized portal principal.
 * This is not content authorization and intentionally returns no PA identifiers,
 * URLs, content grants, organization-wide service inheritance, or mutation power.
 */
export async function readClientPortalServiceMetadata(db: D1Database,
  raw: unknown, nativeAuthority = false): Promise<ClientPortalServiceMetadataResultV1> {
  const request = parseRequest(raw);
  if (!request) return failure("invalid_request");
  try {
    const session = db.withSession("first-primary");
    // Protocol selection is server configuration, never a caller-controlled field.
    // Missing native evidence fails closed without consulting historical grants.
    const rows = await session.prepare(nativeAuthority ? nativeClientPortalServiceMetadataQuery : clientPortalServiceMetadataQuery).bind(request.authorityId, request.workspaceId,
      request.ownershipEpoch, request.grantRevision, request.issuer, request.subject, MAX_SERVICES + 2).all<ServiceRow>();
    if (!rows.success || rows.results.length === 0) return failure("denied");
    if (rows.results.length > MAX_SERVICES + 1) return failure("overflow");
    const services: ClientPortalServiceMetadataV1[] = [];
    for (const row of rows.results) {
      if (row.service_id === null && row.provider_id === null && row.display_name === null && row.revision === null) continue;
      if (!boundedText(row.service_id, 191) || !boundedText(row.provider_id, 128)
        || !boundedText(row.display_name, 160) || !Number.isSafeInteger(row.revision) || row.revision === null || row.revision < 1) return failure("denied");
      services.push({ serviceId: row.service_id, providerId: row.provider_id,
        displayLabel: row.display_name, revision: row.revision });
    }
    if (services.length > MAX_SERVICES) return failure("overflow");
    return { ok: true, protocolVersion: 1, services };
  } catch { return failure("denied"); }
}
