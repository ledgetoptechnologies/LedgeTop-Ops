import { canonicalOperationsPortalNativeInquiryCapabilityCommandV4, parseOperationsPortalNativeInquiryCapabilityCommandV4 }
  from "@ltds/shared/operations-portal-native-recipient-capabilities-v4";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { dispatchOperationsNativeInquiryCapability, prepareOperationsNativeInquiryCapability,
  type OperationsNativeInquiryCapabilityEnv } from "./operations-portal-native-inquiry-capability-dispatch";

type Owner = AuthenticatedNativeStaffWithAdmissionVersion;
type Action = "grant" | "revoke";
type Pins = { intent_id: string; permission_schema_version: number; requested_permissions_json: string;
  state: string; expires_at: string; recipient_binding_id: string; issuer: string; subject: string;
  grant_operation_id: string; target_id: string; target_revision: number; target_client_record_id: string;
  client_authority_id: string; workspace_id: string; ownership_epoch: number; grant_revision: number;
  publication_operation_id: string; publication_revision: number; source_sequence: number;
  snapshot_id: string; snapshot_sha256: string };
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

async function operationId(namespace: string, source: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${namespace}\n${source}`))).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Deterministic operation IDs make the multi-ledger workflow recoverable after
 * a lost HTTP response; the original v3 grant/revoke IDs remain unchanged. */
export async function operationsNativeInquiryCapabilityOperationId(action: Action, baseOperationId: string) {
  if (!UUID4.test(baseOperationId)) throw new Error("operations_portal_native_recipient_denied");
  return operationId(`operations-native-recipient-inquiry-${action}-v1`, baseOperationId);
}

async function currentPins(env: OperationsNativeInquiryCapabilityEnv, intentId: string): Promise<Pins | null> {
  return env.OPS_DB.withSession("first-primary").prepare(`SELECT intent.intent_id,intent.permission_schema_version,
      intent.requested_permissions_json,intent.state,intent.expires_at,intent.recipient_binding_id,
      intent.access_issuer issuer,intent.access_subject subject,intent.grant_operation_id,
      base.target_id,workspace.target_revision,base.target_client_record_id,workspace.client_authority_id,
      workspace.workspace_id,base.ownership_epoch,base.grant_revision,publication.latest_operation_id publication_operation_id,
      publication.publication_revision,publication.source_sequence,publication.snapshot_id,publication.snapshot_sha256
    FROM operations_portal_native_recipient_intents intent
    JOIN operations_portal_native_recipient_authority_heads base ON base.enrollment_intent_id=intent.intent_id
      AND base.recipient_binding_id=intent.recipient_binding_id AND base.permission_schema_version=3
      AND base.permissions_json='["operations.service_home.read"]' AND base.state='active'
    JOIN operations_portal_native_workspace_authority_heads workspace ON workspace.target_id=base.target_id
      AND workspace.state='active' AND workspace.ownership_epoch=base.ownership_epoch
    JOIN operations_portal_workspace_reservation_heads target ON target.target_id=workspace.target_id
      AND target.state='active' AND target.revision=workspace.target_revision
    JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=base.target_id
      AND publication.target_revision=workspace.target_revision AND publication.client_authority_id=workspace.client_authority_id
      AND publication.workspace_id=workspace.workspace_id
    JOIN operations_portal_workspace_publication_receipts publication_receipt
      ON publication_receipt.operation_id=publication.latest_operation_id
      AND publication_receipt.resulting_revision=publication.publication_revision
      AND publication_receipt.source_sequence=publication.source_sequence
      AND publication_receipt.snapshot_id=publication.snapshot_id
      AND publication_receipt.snapshot_sha256=publication.snapshot_sha256
    JOIN operations_portal_native_authority_receipts base_receipt ON base_receipt.operation_id=base.latest_operation_id
      AND base_receipt.resulting_state='active' AND base_receipt.recipient_binding_id=base.recipient_binding_id
      AND base_receipt.ownership_epoch=base.ownership_epoch AND base_receipt.grant_revision=base.grant_revision
    WHERE intent.intent_id=? AND intent.permission_schema_version=4
      AND intent.requested_permissions_json='["operations.request.create","operations.service_home.read"]'
      AND intent.state='active' AND intent.recipient_binding_id IS NOT NULL
      AND intent.access_issuer IS NOT NULL AND intent.access_subject IS NOT NULL
      AND intent.grant_operation_id=base.latest_operation_id
      AND base_receipt.operation_id=intent.grant_operation_id
      AND intent.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')`).bind(intentId).first<Pins>();
}

async function commandFor(env: OperationsNativeInquiryCapabilityEnv, action: Action, operation: string,
  pins: Pins, owner: Owner): Promise<string> {
  const generation = await env.OPS_DB.withSession("first-primary").prepare(
    "SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
    .bind(owner.identity.staffId).first<number>("generation");
  if (!Number.isSafeInteger(generation) || generation === null || generation < 1) throw new Error("stale");
  const observedAt = new Date().toISOString();
  const document = { protocol: "operations-portal-native-inquiry-capability", protocolVersion: 1,
    permissionSchemaVersion: 4, action, operationId: operation,
    target: { targetId: pins.target_id, targetRevision: String(pins.target_revision),
      clientAuthorityId: pins.client_authority_id, workspaceId: pins.workspace_id,
      targetClientRecordId: pins.target_client_record_id },
    recipient: { recipientBindingId: pins.recipient_binding_id, enrollmentIntentId: pins.intent_id,
      issuer: pins.issuer, subject: pins.subject },
    baseAuthority: { operationId: pins.grant_operation_id, ownershipEpoch: String(pins.ownership_epoch),
      grantRevision: String(pins.grant_revision) },
    publication: { operationId: pins.publication_operation_id, revision: String(pins.publication_revision),
      sourceSequence: String(pins.source_sequence), snapshotId: pins.snapshot_id, snapshotSha256: pins.snapshot_sha256 },
    transition: action === "grant" ? { expectedRevision: "0", resultingRevision: "1" }
      : { expectedRevision: "1", resultingRevision: "2" }, permission: "operations.request.create",
    expiresAt: pins.expires_at,
    actorProof: { staffId: owner.identity.staffId, verifiedAccessSubject: owner.identity.verifiedAccessSubject,
      admissionVersion: String(owner.admissionVersion), profileVersion: String(owner.identity.profileVersion),
      grantGeneration: String(generation), verifiedUntil: owner.verifiedUntil }, observedAt };
  return canonicalOperationsPortalNativeInquiryCapabilityCommandV4(document);
}

export async function ensureOperationsNativeRecipientInquiryCapability(env: OperationsNativeInquiryCapabilityEnv,
  intentId: string, baseOperationId: string, action: Action, owner: Owner) {
  const companionId = await operationsNativeInquiryCapabilityOperationId(action, baseOperationId);
  const db = env.OPS_DB.withSession("first-primary");
  const capabilitySchema = await db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table'
    AND name='operations_portal_native_inquiry_capability_commands'`).first<number>();
  if (!capabilitySchema && action === "revoke") return { ok: true as const, action, state: "revoked", skipped: true };
  const prior = await db.prepare(`SELECT command.operation_id FROM operations_portal_native_inquiry_capability_commands command
    JOIN operations_portal_native_inquiry_capability_outbox outbox ON outbox.operation_id=command.operation_id
    WHERE command.operation_id=? AND command.intent_id=? AND command.action=?`).bind(companionId, intentId, action).first();
  if (!prior && action === "revoke") {
    const intent = await db.prepare(`SELECT grant_operation_id FROM operations_portal_native_recipient_intents
      WHERE intent_id=? AND permission_schema_version=4`).bind(intentId).first<{ grant_operation_id: string | null }>();
    if (!intent?.grant_operation_id) return { ok: true as const, action, state: "revoked", skipped: true };
    const grantId = await operationsNativeInquiryCapabilityOperationId("grant", intent.grant_operation_id);
    const grant = await db.prepare(`SELECT canonical_command_json FROM operations_portal_native_inquiry_capability_commands
      WHERE operation_id=? AND intent_id=? AND action='grant'`).bind(grantId, intentId).first<string>("canonical_command_json");
    if (!grant) return { ok: true as const, action, state: "revoked", skipped: true };
    const existingHead = await db.prepare(`SELECT state FROM operations_portal_native_inquiry_capability_heads
      WHERE intent_id=?`).bind(intentId).first<string>("state");
    if (!existingHead) {
      // Reconcile a possibly ambiguous grant before closing it. The grant is
      // never considered effective until its own dual receipt closes.
      const grantPrepared = await dispatchOperationsNativeInquiryCapability(env, grantId);
      if (!grantPrepared.ok) {
        const nowHead = await db.prepare(`SELECT state FROM operations_portal_native_inquiry_capability_heads
          WHERE intent_id=?`).bind(intentId).first<string>("state");
        if (!nowHead && grantPrepared.code === "capability_not_found")
          return { ok: true as const, action, state: "revoked", skipped: true };
        if (!nowHead) return grantPrepared;
      }
    }
    const priorRevoke = await db.prepare(`SELECT command.operation_id FROM operations_portal_native_inquiry_capability_commands command
      JOIN operations_portal_native_inquiry_capability_outbox outbox ON outbox.operation_id=command.operation_id
      WHERE command.operation_id=? AND command.intent_id=? AND command.action='revoke'`).bind(companionId, intentId).first();
    if (!priorRevoke) {
      let stored: unknown = null;
      try { stored = JSON.parse(grant); } catch { stored = null; }
      const original = parseOperationsPortalNativeInquiryCapabilityCommandV4(stored);
      if (!original) return { ok: false as const, code: "stored_command_invalid", retryable: false };
      const generation = await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?")
        .bind(owner.identity.staffId).first<number>("generation");
      if (!Number.isSafeInteger(generation) || generation === null || generation < 1)
        return { ok: false as const, code: "stale", retryable: false };
      const document = { ...original, action: "revoke" as const, operationId: companionId,
        transition: { expectedRevision: "1", resultingRevision: "2" },
        actorProof: { staffId: owner.identity.staffId, verifiedAccessSubject: owner.identity.verifiedAccessSubject,
          admissionVersion: String(owner.admissionVersion), profileVersion: String(owner.identity.profileVersion),
          grantGeneration: String(generation), verifiedUntil: owner.verifiedUntil }, observedAt: new Date().toISOString() };
      const prepared = await prepareOperationsNativeInquiryCapability(env,
        canonicalOperationsPortalNativeInquiryCapabilityCommandV4(document));
      if (!prepared.ok) return prepared;
    }
    return dispatchOperationsNativeInquiryCapability(env, companionId);
  }
  if (!prior) {
    const pins = await currentPins(env, intentId);
    if (!pins) return { ok: false as const, code: "stale", retryable: false };
    const prepared = await prepareOperationsNativeInquiryCapability(env, await commandFor(env, action, companionId, pins, owner));
    if (!prepared.ok) return prepared;
  }
  return dispatchOperationsNativeInquiryCapability(env, companionId);
}
