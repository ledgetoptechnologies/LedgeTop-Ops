import { describe, expect, it } from "vitest";
import {
  canonicalOperationsPortalNativeInquiryCapabilityCommandV4,
  encodeOperationsPortalNativeRecipientCapabilities,
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_HOME_PERMISSION as HOME,
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_INQUIRY_PERMISSION as INQUIRY,
  operationsPortalNativeRecipientPermissionSchema,
  parseOperationsPortalNativeRecipientCapabilities,
  parseOperationsPortalNativeRecipientCapabilitiesJson,
  parseOperationsPortalNativeRecipientIssueRequest,
  parseOperationsPortalNativeInquiryCapabilityCommandV4,
} from "../../../packages/shared/src/operations-portal-native-recipient-capabilities-v4";

const issue = {
  operationId: "a0000000-0000-4000-8000-000000000001",
  targetId: "a0000000-0000-4000-8000-000000000002",
  targetClientRecordId: "client-17",
  expiresAt: "2026-10-31T12:00:00.000Z",
};
const now = Date.parse("2026-10-30T12:00:00.000Z");
const capability = {
  protocol: "operations-portal-native-inquiry-capability", protocolVersion: 1, permissionSchemaVersion: 4,
  action: "grant", operationId: "a0000000-0000-4000-8000-000000000003",
  target: { targetId: "a0000000-0000-4000-8000-000000000002", targetRevision: "1",
    clientAuthorityId: "a0000000-0000-4000-8000-000000000004", workspaceId: "ops-workspace",
    targetClientRecordId: "client-17" },
  recipient: { recipientBindingId: "a0000000-0000-4000-8000-000000000005",
    enrollmentIntentId: "a0000000-0000-4000-8000-000000000006",
    issuer: "https://tenant.cloudflareaccess.com", subject: "access|user-17" },
  baseAuthority: { operationId: "a0000000-0000-4000-8000-000000000007", ownershipEpoch: "1", grantRevision: "1" },
  publication: { operationId: "a0000000-0000-4000-8000-000000000008", revision: "1", sourceSequence: "1",
    snapshotId: "a0000000-0000-4000-8000-000000000009", snapshotSha256: "a".repeat(64) },
  transition: { expectedRevision: "0", resultingRevision: "1" }, permission: INQUIRY,
  expiresAt: "2026-10-31T12:00:00.000Z",
  actorProof: { staffId: "staff-17", verifiedAccessSubject: "staff|17", admissionVersion: "1",
    profileVersion: "1", grantGeneration: "1", verifiedUntil: "2026-10-30T13:00:00.000Z" },
  observedAt: "2026-10-30T12:00:00.000Z",
};

describe("unactivated Operations recipient capability schema v4", () => {
  it("keeps the exact legacy issue body home-only and labels it v3", () => {
    expect(parseOperationsPortalNativeRecipientIssueRequest(issue, now)).toEqual({
      ...issue, permissions: [HOME], permissionSchemaVersion: 3, legacyShape: true,
    });
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue, ignored: true }, now)).toBeNull();
  });

  it("requires an explicit canonical permission set in the new issue body", () => {
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue, permissions: [HOME] }, now)).toEqual({
      ...issue, permissions: [HOME], permissionSchemaVersion: 3, legacyShape: false,
    });
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue,
      permissions: [INQUIRY, HOME] }, now)).toEqual({ ...issue, permissions: [INQUIRY, HOME],
      permissionSchemaVersion: 4, legacyShape: false });
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue, permissions: [] }, now)).toBeNull();
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue, permissions: [INQUIRY] }, now)).toBeNull();
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue, expiresAt: "2026-10-30T11:59:59.999Z" }, now)).toBeNull();
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue, expiresAt: "2026-11-06T12:00:00.001Z" }, now)).toBeNull();
  });

  it("enforces exact version, action, ordering and duplicate-free capability sets", () => {
    expect(parseOperationsPortalNativeRecipientCapabilities(3, "recipient.grant", [HOME])).toEqual([HOME]);
    expect(parseOperationsPortalNativeRecipientCapabilities(3, "recipient.grant", [INQUIRY, HOME])).toBeNull();
    expect(parseOperationsPortalNativeRecipientCapabilities(4, "recipient.grant", [HOME])).toBeNull();
    expect(parseOperationsPortalNativeRecipientCapabilities(4, "recipient.grant", [INQUIRY, HOME]))
      .toEqual([INQUIRY, HOME]);
    expect(parseOperationsPortalNativeRecipientCapabilities(4, "recipient.grant", [HOME, INQUIRY])).toBeNull();
    expect(parseOperationsPortalNativeRecipientCapabilities(4, "recipient.grant", [INQUIRY, HOME, HOME])).toBeNull();
    expect(parseOperationsPortalNativeRecipientCapabilities(4, "recipient.grant", [HOME, "operations.unknown"]))
      .toBeNull();
    expect(parseOperationsPortalNativeRecipientCapabilities(4, "recipient.revoke", [])).toEqual([]);
    expect(parseOperationsPortalNativeRecipientCapabilities(3, "recipient.revoke", [HOME])).toBeNull();
    expect(parseOperationsPortalNativeRecipientCapabilities(5, "recipient.grant", [HOME])).toBeNull();
  });

  it("rejects sparse, accessor-backed, extended and non-array permission values", () => {
    const sparse = new Array(2); sparse[1] = HOME;
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => HOME });
    Object.defineProperty(accessor, "length", { value: 1 });
    const extended = [HOME] as string[] & { extra?: string };
    extended.extra = "operations.unknown";
    for (const input of [sparse, accessor, extended, HOME, null, { 0: HOME, length: 1 }])
      expect(parseOperationsPortalNativeRecipientCapabilities(4, "recipient.grant", input)).toBeNull();
  });

  it("fails closed on proxies without invoking array element getters", () => {
    const throwingProxy = new Proxy([], { ownKeys: () => { throw new Error("trap"); } });
    const revoked = Proxy.revocable([HOME], {}); revoked.revoke();
    let getterCalled = false;
    const getterArray: unknown[] = [];
    Object.defineProperty(getterArray, "0", { enumerable: true, get: () => { getterCalled = true; return HOME; } });
    Object.defineProperty(getterArray, "length", { value: 1 });
    expect(parseOperationsPortalNativeRecipientCapabilities(3, "recipient.grant", throwingProxy)).toBeNull();
    expect(parseOperationsPortalNativeRecipientCapabilities(3, "recipient.grant", revoked.proxy)).toBeNull();
    expect(parseOperationsPortalNativeRecipientCapabilities(3, "recipient.grant", getterArray)).toBeNull();
    expect(getterCalled).toBe(false);
  });

  it("encodes only canonical values and parses bounded JSON without widening", () => {
    expect(operationsPortalNativeRecipientPermissionSchema([HOME])).toBe(3);
    expect(operationsPortalNativeRecipientPermissionSchema([INQUIRY, HOME])).toBe(4);
    expect(operationsPortalNativeRecipientPermissionSchema([HOME, INQUIRY])).toBeNull();
    expect(encodeOperationsPortalNativeRecipientCapabilities(4, "recipient.grant", [INQUIRY, HOME]))
      .toBe('["operations.request.create","operations.service_home.read"]');
    expect(encodeOperationsPortalNativeRecipientCapabilities(3, "recipient.grant", [INQUIRY, HOME])).toBeNull();
    expect(parseOperationsPortalNativeRecipientCapabilitiesJson(4, "recipient.grant",
      '["operations.request.create","operations.service_home.read"]')).toEqual([INQUIRY, HOME]);
    expect(parseOperationsPortalNativeRecipientCapabilitiesJson(4, "recipient.grant",
      '["operations.service_home.read","operations.request.create"]')).toBeNull();
    expect(parseOperationsPortalNativeRecipientCapabilitiesJson(4, "recipient.grant", "x".repeat(257))).toBeNull();
  });

  it("canonicalizes companion request.create commands with exact parent and publication pins", () => {
    const parsed = parseOperationsPortalNativeInquiryCapabilityCommandV4(capability);
    expect(parsed).toMatchObject(capability);
    expect(canonicalOperationsPortalNativeInquiryCapabilityCommandV4(capability)).toBe(JSON.stringify(parsed));
    expect(parseOperationsPortalNativeInquiryCapabilityCommandV4({ ...capability, permission: HOME })).toBeNull();
    expect(parseOperationsPortalNativeInquiryCapabilityCommandV4({ ...capability, permissionSchemaVersion: 3 })).toBeNull();
    expect(parseOperationsPortalNativeInquiryCapabilityCommandV4({ ...capability,
      baseAuthority: { ...capability.baseAuthority, ownershipEpoch: "0" } })).toBeNull();
    expect(parseOperationsPortalNativeInquiryCapabilityCommandV4({ ...capability,
      transition: { expectedRevision: "1", resultingRevision: "3" } })).toBeNull();
    expect(parseOperationsPortalNativeInquiryCapabilityCommandV4({ ...capability, expiresAt: capability.observedAt })).toBeNull();
    expect(parseOperationsPortalNativeInquiryCapabilityCommandV4({ ...capability, unreviewed: true })).toBeNull();
    let getterCalled = false;
    const getterCommand = { ...capability };
    Object.defineProperty(getterCommand, "action", { enumerable: true, get: () => {
      getterCalled = true; return "grant";
    } });
    const revoked = Proxy.revocable({ ...capability }, {}); revoked.revoke();
    expect(parseOperationsPortalNativeInquiryCapabilityCommandV4(getterCommand)).toBeNull();
    expect(parseOperationsPortalNativeInquiryCapabilityCommandV4(revoked.proxy)).toBeNull();
    expect(getterCalled).toBe(false);
  });
});
