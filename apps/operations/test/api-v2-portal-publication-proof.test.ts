import { describe, expect, it } from "vitest";
import {
  canonicalApiV2PortalPublicationProof,
  createApiV2PortalPublicationProofReceipt,
  parseApiV2PortalPublicationProof,
  parseApiV2PortalPublicationProofReceipt,
  sha256ApiV2PortalPublicationProof,
  verifyApiV2PortalPublicationProofReceipt,
} from "@ltds/shared/api-v2-portal-publication-proof";

const fixture = (overrides: Record<string, unknown> = {}) => ({
  protocol: "api-v2-portal-publication-proof",
  protocolVersion: 1,
  proofId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  action: "publish",
  proofRevision: 1,
  expectedRevision: 0,
  resultingRevision: 1,
  state: "active",
  source: {
    sourceId: "project-alpha:secondary",
    sourceInstanceId: "33333333-3333-4333-8333-333333333333",
    applicationId: "44444444-4444-4444-8444-444444444444",
    historyEpoch: "55555555-5555-4555-8555-555555555555",
    authorizationGeneration: 9,
  },
  workspace: { workspaceId: "workspace-01", rootType: "organization", rootPublicId: "org-01", sourceWorkspaceId: "source-workspace-01" },
  directory: {
    snapshotId: "66666666-6666-4666-8666-666666666666",
    generationId: "generation-01",
    checkpointId: "checkpoint-01",
    sourceGeneration: "12",
    sourceSequence: "98",
    pageCount: 2,
    itemCount: 3,
    complete: true,
    snapshotSha256: "a".repeat(64),
  },
  project: { publicId: "0123456789abcdef0123456789abcdef", revision: "7", projectionSha256: "b".repeat(64) },
  folder: { bindingId: "folder-binding-01", sourceVersion: "folder-v2", r2Prefix: "clients/acme/project/" },
  observedAt: "2030-01-02T03:04:05.678Z",
  verifiedUntil: "2030-01-02T04:04:05.678Z",
  ...overrides,
} as const);

const parsedFixture = () => {
  const proof = parseApiV2PortalPublicationProof(fixture());
  if (!proof) throw new Error("proof fixture must parse");
  return proof;
};

describe("API-v2 portal publication proof contract", () => {
  it("accepts a complete source-qualified proof and canonicalizes property order", () => {
    const proof = parsedFixture();
    expect(proof.source).toMatchObject({ sourceId: "project-alpha:secondary", authorizationGeneration: 9 });
    const shuffled = { ...fixture(), folder: fixture().folder, source: fixture().source };
    expect(canonicalApiV2PortalPublicationProof(shuffled)).toBe(canonicalApiV2PortalPublicationProof(proof));
  });

  it("requires exact CAS and action/state pairing", () => {
    expect(parseApiV2PortalPublicationProof({ ...fixture(), resultingRevision: 3 })).toBeNull();
    expect(parseApiV2PortalPublicationProof({ ...fixture(), action: "revoke", state: "active" })).toBeNull();
    expect(parseApiV2PortalPublicationProof({ ...fixture(), action: "suspend", state: "suspended" })).not.toBeNull();
  });

  it("requires ordered observed and verification times without claiming currentness", () => {
    expect(parseApiV2PortalPublicationProof({ ...fixture(), verifiedUntil: fixture().observedAt })).toBeNull();
    expect(parseApiV2PortalPublicationProof({ ...fixture(), observedAt: "2030-01-02T05:04:05.678Z" })).toBeNull();
    expect(parsedFixture().verifiedUntil).toBe("2030-01-02T04:04:05.678Z");
  });

  it("rejects unsafe prefixes, incomplete snapshots, unsafe numbers, and unknown fields", () => {
    for (const r2Prefix of ["/clients/acme/", "clients/../", "clients//project/", "clients/_ltds/"]) {
      expect(parseApiV2PortalPublicationProof({ ...fixture(), folder: { ...fixture().folder, r2Prefix } })).toBeNull();
    }
    expect(parseApiV2PortalPublicationProof({ ...fixture(), directory: { ...fixture().directory, complete: false } })).toBeNull();
    expect(parseApiV2PortalPublicationProof({ ...fixture(), proofRevision: Number.MAX_SAFE_INTEGER })).toBeNull();
    expect(parseApiV2PortalPublicationProof({ ...fixture(), extra: true })).toBeNull();
  });

  it("rejects accessors, non-plain objects, and symbol keys without invoking getters", () => {
    const hostile = fixture();
    Object.defineProperty(hostile, "operationId", { enumerable: true, configurable: true, get: () => { throw new Error("getter invoked"); } });
    expect(parseApiV2PortalPublicationProof(hostile)).toBeNull();
    const nonPlain = fixture();
    Object.setPrototypeOf(nonPlain, { hostile: true });
    expect(parseApiV2PortalPublicationProof(nonPlain)).toBeNull();
    const withSymbol = fixture();
    Object.defineProperty(withSymbol, Symbol("unknown"), { enumerable: true, value: true });
    expect(parseApiV2PortalPublicationProof(withSymbol)).toBeNull();
  });

  it("correlates receipt operation, target revision, source, and canonical proof hash", async () => {
    const proof = parsedFixture();
    const receipt = await createApiV2PortalPublicationProofReceipt(proof, "recorded");
    expect(parseApiV2PortalPublicationProofReceipt(receipt, proof)).toEqual(receipt);
    expect(await verifyApiV2PortalPublicationProofReceipt(receipt, proof)).toEqual(receipt);
    expect(receipt.proofSha256).toBe(await sha256ApiV2PortalPublicationProof(proof));
    expect(await verifyApiV2PortalPublicationProofReceipt({ ...receipt, proofSha256: "c".repeat(64) }, proof)).toBeNull();
    expect(parseApiV2PortalPublicationProofReceipt({ ...receipt, operationId: proof.proofId }, proof)).toBeNull();
    expect(parseApiV2PortalPublicationProofReceipt({ ...receipt, proof: { ...proof, source: { ...proof.source, historyEpoch: proof.source.applicationId } } }, proof)).toBeNull();
  });
});
