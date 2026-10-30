import { describe, expect, it } from "vitest";
import {
  encodeOperationsPortalNativeRecipientCapabilities,
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_HOME_PERMISSION as HOME,
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_INQUIRY_PERMISSION as INQUIRY,
  operationsPortalNativeRecipientPermissionSchema,
  parseOperationsPortalNativeRecipientCapabilities,
  parseOperationsPortalNativeRecipientCapabilitiesJson,
  parseOperationsPortalNativeRecipientIssueRequest,
} from "../../../packages/shared/src/operations-portal-native-recipient-capabilities-v4";

const issue = {
  operationId: "a0000000-0000-4000-8000-000000000001",
  targetId: "a0000000-0000-4000-8000-000000000002",
  targetClientRecordId: "client-17",
  expiresAt: "2026-10-31T12:00:00.000Z",
};

describe("unactivated Operations recipient capability schema v4", () => {
  it("keeps the exact legacy issue body home-only and labels it v3", () => {
    expect(parseOperationsPortalNativeRecipientIssueRequest(issue)).toEqual({
      ...issue, permissions: [HOME], permissionSchemaVersion: 3, legacyShape: true,
    });
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue, ignored: true })).toBeNull();
  });

  it("requires an explicit canonical permission set in the new issue body", () => {
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue, permissions: [HOME] })).toEqual({
      ...issue, permissions: [HOME], permissionSchemaVersion: 3, legacyShape: false,
    });
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue,
      permissions: [INQUIRY, HOME] })).toEqual({ ...issue, permissions: [INQUIRY, HOME],
      permissionSchemaVersion: 4, legacyShape: false });
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue, permissions: [] })).toBeNull();
    expect(parseOperationsPortalNativeRecipientIssueRequest({ ...issue, permissions: [INQUIRY] })).toBeNull();
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
});
