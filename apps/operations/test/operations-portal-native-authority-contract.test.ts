import { describe, expect, it } from "vitest";
import { canonicalOperationsPortalNativeAuthorityCommand, parseOperationsPortalNativeAuthorityCommand,
  sha256OperationsPortalNativeAuthorityCommand } from "@ltds/shared/operations-portal-native-authority";

const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const fixture = () => ({ protocol: "operations-portal-native-authority", protocolVersion: 1,
  permissionSchemaVersion: 3, action: "recipient.grant", operationId: id(1),
  target: { targetId: id(2), targetRevision: "1", clientAuthorityId: id(3), workspaceId: "ops/workspace/example",
    rootKind: "organization", rootRecordId: "ops/org/example" },
  recipient: { recipientBindingId: id(4), enrollmentIntentId: id(5), targetClientRecordId: "ops/client/example",
    issuer: "https://example.cloudflareaccess.com", subject: "individual-subject" },
  expected: { ownershipEpoch: "0", grantRevision: "0" }, resulting: { ownershipEpoch: "1", grantRevision: "1" },
  permissions: ["operations.service_home.read"], expiresAt: null,
  publication: { operationId: id(6), publicationId: id(7), revision: "1", sourceSequence: "1", snapshotId: id(8),
    snapshotSha256: "a".repeat(64), requestFingerprint: "b".repeat(64) },
  actorProof: { staffId: "owner", verifiedAccessSubject: "owner-subject", admissionVersion: "1",
    profileVersion: "1", grantGeneration: "1", verifiedUntil: "2030-01-01T01:00:00.000Z" },
  observedAt: "2030-01-01T00:00:00.000Z" });

describe("closed Ops-native recipient authority protocol", () => {
  it("copies and canonicalizes without inferring membership, billing, requests or files", async () => {
    const raw = fixture(), parsed = parseOperationsPortalNativeAuthorityCommand(raw);
    expect(parsed?.permissions).toEqual(["operations.service_home.read"]);
    expect(parsed?.protocolVersion).toBe(1);
    expect(parsed?.permissionSchemaVersion).toBe(3);
    const before = canonicalOperationsPortalNativeAuthorityCommand(raw);
    expect(canonicalOperationsPortalNativeAuthorityCommand(Object.fromEntries(Object.entries(raw).reverse()))).toBe(before);
    expect(await sha256OperationsPortalNativeAuthorityCommand(raw)).toMatch(/^[0-9a-f]{64}$/);
    raw.recipient.subject = "different-subject";
    raw.permissions.push("delivery.view");
    expect(parsed?.recipient?.subject).toBe("individual-subject");
    expect(parsed?.permissions).toEqual(["operations.service_home.read"]);
    expect(Object.isFrozen(parsed?.target)).toBe(true);
  });
  it("accepts a later principal at the same epoch and deny-only revocation without a publication", () => {
    const later = fixture(); later.expected.ownershipEpoch = "4"; later.resulting.ownershipEpoch = "4";
    expect(parseOperationsPortalNativeAuthorityCommand(later)).not.toBeNull();
    const revoke = { ...later, action: "recipient.revoke", expected: { ownershipEpoch: "4", grantRevision: "1" },
      resulting: { ownershipEpoch: "4", grantRevision: "2" }, permissions: [], publication: null };
    expect(parseOperationsPortalNativeAuthorityCommand(revoke)?.action).toBe("recipient.revoke");
    expect(parseOperationsPortalNativeAuthorityCommand({ ...revoke, permissions: ["operations.service_home.read"] })).toBeNull();
    const workspace = { ...revoke, action: "workspace.revoke", recipient: null,
      expected: { ownershipEpoch: "4", grantRevision: null }, resulting: { ownershipEpoch: "5", grantRevision: null } };
    expect(parseOperationsPortalNativeAuthorityCommand(workspace)?.recipient).toBeNull();
  });
  it.each([
    (x: ReturnType<typeof fixture>) => ({ ...x, protocol: "operations-authority-v3" }),
    (x: ReturnType<typeof fixture>) => ({ ...x, protocolVersion: 3 }),
    (x: ReturnType<typeof fixture>) => ({ ...x, owner: true }),
    (x: ReturnType<typeof fixture>) => ({ ...x, publication: null }),
    (x: ReturnType<typeof fixture>) => ({ ...x, permissions: ["delivery.view"] }),
    (x: ReturnType<typeof fixture>) => ({ ...x, permissions: ["operations.service_home.read", "operations.service_home.read"] }),
    (x: ReturnType<typeof fixture>) => ({ ...x, resulting: { ownershipEpoch: "2", grantRevision: "1" } }),
    (x: ReturnType<typeof fixture>) => ({ ...x, expected: { ownershipEpoch: "00", grantRevision: "0" } }),
    (x: ReturnType<typeof fixture>) => ({ ...x, expected: { ownershipEpoch: "0", grantRevision: "9007199254740992" } }),
    (x: ReturnType<typeof fixture>) => ({ ...x, recipient: { ...x.recipient, issuer: "https://example.cloudflareaccess.com/" } }),
    (x: ReturnType<typeof fixture>) => ({ ...x, recipient: { ...x.recipient, email: "not-an-identity@example.invalid" } }),
    (x: ReturnType<typeof fixture>) => ({ ...x, target: { ...x.target, rootKind: "standalone_client" } }),
    (x: ReturnType<typeof fixture>) => ({ ...x, expiresAt: "2029-12-31T23:59:59.000Z" }),
    (x: ReturnType<typeof fixture>) => ({ ...x, actorProof: { ...x.actorProof, verifiedUntil: "2030-01-01T00:00:00.000Z" } }),
    (x: ReturnType<typeof fixture>) => ({ ...x, actorProof: { ...x.actorProof, verifiedAccessSubject: " owner-subject " } }),
  ])("rejects malformed, ambiguous or broadened command %#", change => {
    expect(parseOperationsPortalNativeAuthorityCommand(change(fixture()))).toBeNull();
  });
  it("never evaluates permission or identity property getters", () => {
    let reads = 0;
    const raw = fixture();
    Object.defineProperty(raw.recipient, "subject", { enumerable: true, get() { reads++; throw Error("must not evaluate"); } });
    expect(parseOperationsPortalNativeAuthorityCommand(raw)).toBeNull();
    expect(reads).toBe(0);
    const array = fixture();
    Object.defineProperty(array.permissions, "0", { enumerable: true, get() { reads++; return "operations.service_home.read"; } });
    expect(parseOperationsPortalNativeAuthorityCommand(array)).toBeNull();
    expect(reads).toBe(0);
    expect(parseOperationsPortalNativeAuthorityCommand(new Proxy({}, { ownKeys() { throw Error("hostile"); } }))).toBeNull();
    expect(parseOperationsPortalNativeAuthorityCommand({ ...fixture(), action: { toString() { reads++; return "recipient.grant"; } } })).toBeNull();
    expect(reads).toBe(0);
  });
  it("rejects hidden fields, sparse permissions, malformed Unicode and oversized identity", () => {
    const hidden = fixture(); Object.defineProperty(hidden.target, "owner", { value: true });
    expect(parseOperationsPortalNativeAuthorityCommand(hidden)).toBeNull();
    const sparse = fixture(); sparse.permissions = new Array(1);
    expect(parseOperationsPortalNativeAuthorityCommand(sparse)).toBeNull();
    const unicode = fixture(); unicode.target.rootRecordId = "bad\ud800";
    expect(parseOperationsPortalNativeAuthorityCommand(unicode)).toBeNull();
    const oversized = fixture(); oversized.recipient.subject = "x".repeat(513);
    expect(parseOperationsPortalNativeAuthorityCommand(oversized)).toBeNull();
  });
  it("keeps historical consent/actor expiry separate from entitlement policy", () => {
    const raw = fixture(); raw.observedAt = "2020-01-01T00:00:00.000Z"; raw.actorProof.verifiedUntil = "2020-01-01T00:05:00.000Z";
    expect(parseOperationsPortalNativeAuthorityCommand(raw)?.expiresAt).toBeNull();
    const standalone = fixture(); standalone.target.rootKind = "standalone_client";
    standalone.target.rootRecordId = standalone.recipient.targetClientRecordId;
    expect(parseOperationsPortalNativeAuthorityCommand(standalone)).not.toBeNull();
  });
});
