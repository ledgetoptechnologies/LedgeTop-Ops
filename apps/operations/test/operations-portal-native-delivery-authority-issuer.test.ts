import { describe, expect, it, vi } from "vitest";
import { issueOperationsPortalNativeDeliveryAuthority }
  from "../src/worker/operations-portal-native-delivery-authority-issuer";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand }
  from "@ltds/shared/operations-portal-native-delivery-authority";

const id = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;
const encoder = new TextEncoder();
const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))]
  .map(byte => byte.toString(16).padStart(2, "0")).join("");
const expiry = () => new Date(Date.now() + 86_400_000).toISOString();
const verified = () => new Date(Date.now() + 3_600_000).toISOString();
const owner = (staffId = "staff:owner") => ({ identity: { kind: "native" as const, staffId,
  verifiedAccessSubject: `access|${staffId}`, email: `${staffId.replace(":", "-")}@example.test`, displayName: "Owner",
  profileVersion: 8 }, admissionVersion: 7, verifiedUntil: verified() });

function wire(expiresAt: string) {
  return { protocol: "operations-portal-native-delivery-authority" as const, protocolVersion: 1 as const,
    permissionSchemaVersion: 3 as const, action: "delivery.grant" as const, operationId: id(1),
    authority: { authorityId: id(2), expectedRevision: "0", resultingRevision: "1" },
    target: { targetId: id(3), targetRevision: "1", clientAuthorityId: id(4), workspaceId: "workspace",
      rootKind: "organization" as const, rootRecordId: "root" },
    recipient: { recipientBindingId: id(5), enrollmentIntentId: id(6), targetClientRecordId: "client",
      issuer: "https://tenant.cloudflareaccess.com", subject: "recipient", homeOwnershipEpoch: "1",
      homeGrantRevision: "1", homeGrantOperationId: id(7), homeRequestFingerprint: "a".repeat(64) },
    publication: { operationId: id(8), publicationId: id(9), revision: "1", sourceSequence: "1",
      snapshotId: id(10), snapshotSha256: "b".repeat(64) },
    resource: { folderReservationId: id(11), folderReservationRevision: "1", clientFolderBindingId: "binding",
      externalProjectId: "project", projectVersion: "1", opsFolderProjectId: "ops-project", opsDivisionId: "division",
      selectedR2Prefix: "projects/selected/", baseR2Prefix: "projects/", baseMatchMethod: "manual",
      baseConfirmedBy: "staff:confirm", baseConfirmedAt: "2026-09-30 12:00:00" },
    features: ["folder.list", "file.download"] as const, expiresAt, reasonCode: "explicit share",
    observedAt: "2026-09-30T12:00:00.000Z" };
}

async function replayDatabase(expiresAt: string, original = owner()) {
  const command = wire(expiresAt);
  const operationFingerprint = await digest(JSON.stringify({ action: "delivery.grant", operationId: id(1),
    authorityId: id(2), recipientBindingId: id(5), folderReservationId: id(11), expectedRevision: 0,
    features: command.features, expiresAt, reasonCode: "explicit share", expectedCandidateFingerprint: null }));
  const prepare = vi.fn((sql: string) => ({ bind: (..._values: unknown[]) => ({ first: async () => {
    if (sql.includes("SELECT generation FROM")) return 4;
    if (sql.startsWith("SELECT 1 FROM operations_portal_native_delivery_authority_commands")) return { present: 1 };
    if (sql.includes("authorization.authorized_by_staff_id")) return { canonical_command_json:
      canonicalOperationsPortalNativeDeliveryAuthorityCommand(command), operation_fingerprint: operationFingerprint,
      authorized_by_staff_id: original.identity.staffId,
      authorized_access_subject: original.identity.verifiedAccessSubject };
    if (sql.includes("FROM native_staff_admissions admission")) return { authorized: 1 };
    if (sql.includes("FROM operations_portal_native_delivery_authority_commits")) return { committed: 1 };
    if (sql.includes("FROM operations_portal_native_recipient_labels")) return "recipient@example.test";
    return null;
  } }) }));
  return { database: { withSession: () => ({ prepare }) } as unknown as D1Database, prepare };
}

describe("operations native delivery issuer replay", () => {
  it("replays stable business fields with a fresh verifiedUntil that is not fingerprinted", async () => {
    const expiresAt = expiry(), currentOwner = owner(), fake = await replayDatabase(expiresAt, currentOwner);
    currentOwner.verifiedUntil = new Date(Date.now() + 7_200_000).toISOString();
    await expect(issueOperationsPortalNativeDeliveryAuthority(fake.database, { operationId: id(1), authorityId: id(2),
      recipientBindingId: id(5), folderReservationId: id(11), expectedRevision: 0,
      features: ["folder.list", "file.download"], expiresAt, reasonCode: "explicit share", owner: currentOwner }))
      .resolves.toMatchObject({ replayed: true, review: { authorityId: id(2), revision: 1, state: "active",
        recipientLabel: "recipient@example.test", latestOperationId: id(1) } });
  });

  it("rejects a different manager identity or modified stable body on replay", async () => {
    const expiresAt = expiry(), original = owner(), fake = await replayDatabase(expiresAt, original);
    await expect(issueOperationsPortalNativeDeliveryAuthority(fake.database, { operationId: id(1), authorityId: id(2),
      recipientBindingId: id(5), folderReservationId: id(11), expectedRevision: 0,
      features: ["folder.list", "file.download"], expiresAt, reasonCode: "explicit share", owner: owner("staff:other") }))
      .rejects.toThrow("authority_denied");
    await expect(issueOperationsPortalNativeDeliveryAuthority(fake.database, { operationId: id(1), authorityId: id(2),
      recipientBindingId: id(5), folderReservationId: id(11), expectedRevision: 0,
      features: ["folder.list", "file.download"], expiresAt, reasonCode: "modified share", owner: original }))
      .rejects.toThrow("authority_denied");
  });
});
