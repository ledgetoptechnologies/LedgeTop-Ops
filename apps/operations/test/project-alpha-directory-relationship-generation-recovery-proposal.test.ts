import { describe, expect, it } from "vitest";
import {
  planDirectoryRelationshipGenerationRecovery,
  type DirectoryRelationshipGenerationRecoveryProof,
} from "../src/worker/project-alpha-directory-relationship-generation-recovery-proposal";

const predecessor = {
  commandId: "10000000-0000-4000-8000-000000000001",
  expectedClientRevision: "12",
  expectedAuthorizationGeneration: "52",
  expectedCurrentOrganizationPublicId: null,
  organization: { externalId: "organization/exact", publicId: "a".repeat(32), expectedRevision: "7" },
} as const;
const source = {
  sourceId: "project-alpha:source-a",
  sourceInstanceId: "20000000-0000-4000-8000-000000000002",
  applicationId: "30000000-0000-4000-8000-000000000003",
  historyEpoch: "40000000-0000-4000-8000-000000000004",
  destinationOrigin: "https://source-a.example.test",
} as const;
const proof: DirectoryRelationshipGenerationRecoveryProof = {
  predecessorCommandId: predecessor.commandId,
  successorCommandId: "10000000-0000-4000-8000-000000000002",
  action: "assign",
  predecessorState: "terminal",
  predecessorHttpStatus: 409,
  predecessorSource: source,
  observedSource: { ...source },
  clientPublicId: "b".repeat(32),
  observedClientPublicId: "b".repeat(32),
  observedClientRevision: "12",
  observedCurrentOrganizationPublicId: null,
  observedOrganizationBindingExternalId: "organization/exact",
  observedOrganizationPublicId: "a".repeat(32),
  observedOrganizationRevision: "7",
  observedOrganizationBindingStatus: "active",
  observedAuthorizationGeneration: "53",
};

describe("Directory relationship generation recovery proposal", () => {
  it("preserves the predecessor shape and changes only command ID and generation", () => {
    const before = JSON.stringify(predecessor);
    const planned = planDirectoryRelationshipGenerationRecovery(predecessor, proof);
    expect(planned).toEqual({ ...predecessor, commandId: proof.successorCommandId,
      expectedAuthorizationGeneration: proof.observedAuthorizationGeneration });
    expect(JSON.stringify(predecessor)).toBe(before);
    expect(planned?.organization).toEqual(predecessor.organization);
    expect(planned?.organization).not.toBe(predecessor.organization);
  });

  it.each([
    ["remove", { action: "remove" }],
    ["move", { action: "move" }],
    ["nonterminal", { predecessorState: "pending" }],
    ["non-409", { predecessorHttpStatus: 400 }],
    ["bad predecessor ID", { predecessorCommandId: "bad" }],
    ["bad successor ID", { successorCommandId: "bad" }],
    ["bad client public ID", { clientPublicId: "bad", observedClientPublicId: "bad" }],
    ["bad source identity", { predecessorSource: { ...source, sourceInstanceId: "bad" }, observedSource: { ...source, sourceInstanceId: "bad" } }],
    ["reused command ID", { successorCommandId: predecessor.commandId }],
    ["unchanged generation", { observedAuthorizationGeneration: "52" }],
    ["decreased generation", { observedAuthorizationGeneration: "51" }],
    ["noncanonical generation", { observedAuthorizationGeneration: "053" }],
    ["overflow generation", { observedAuthorizationGeneration: "9223372036854775808" }],
    ["exhausted generation", { observedAuthorizationGeneration: "9223372036854775807" }],
  ])("rejects %s", (_label, change) => {
    expect(planDirectoryRelationshipGenerationRecovery(predecessor,
      { ...proof, ...change } as DirectoryRelationshipGenerationRecoveryProof)).toBeNull();
  });

  it("rejects a case-only reuse of the predecessor UUID", () => {
    const uppercasePredecessor = { ...predecessor, commandId: predecessor.commandId.toUpperCase() };
    expect(planDirectoryRelationshipGenerationRecovery(uppercasePredecessor, {
      ...proof,
      predecessorCommandId: uppercasePredecessor.commandId,
      successorCommandId: predecessor.commandId,
    })).toBeNull();
  });

  it.each([
    "http://source-a.example.test",
    "ftp://source-a.example.test",
    "file:///source-a",
    "null",
    "https://user:secret@source-a.example.test",
  ])("rejects non-canonical or credential-bearing origin %s", destinationOrigin => {
    const changed = { ...source, destinationOrigin };
    expect(planDirectoryRelationshipGenerationRecovery(predecessor,
      { ...proof, predecessorSource: changed, observedSource: changed })).toBeNull();
  });

  it("accepts the largest usable generation", () => {
    const prior = { ...predecessor, expectedAuthorizationGeneration: "9223372036854775805" };
    expect(planDirectoryRelationshipGenerationRecovery(prior,
      { ...proof, observedAuthorizationGeneration: "9223372036854775806" }))
      .toMatchObject({ expectedAuthorizationGeneration: "9223372036854775806" });
  });

  it("accepts a recovery from generation zero to a higher generation", () => {
    const prior = { ...predecessor, expectedAuthorizationGeneration: "0" };
    expect(planDirectoryRelationshipGenerationRecovery(prior,
      { ...proof, observedAuthorizationGeneration: "2" }))
      .toMatchObject({ expectedAuthorizationGeneration: "2" });
  });

  it.each([
    ["source", { observedSource: { ...source, sourceId: "project-alpha:other" } }],
    ["instance", { observedSource: { ...source, sourceInstanceId: "90000000-0000-4000-8000-000000000009" } }],
    ["application", { observedSource: { ...source, applicationId: "90000000-0000-4000-8000-000000000009" } }],
    ["history epoch", { observedSource: { ...source, historyEpoch: "90000000-0000-4000-8000-000000000009" } }],
    ["origin", { observedSource: { ...source, destinationOrigin: "https://other.example.test" } }],
  ])("rejects %s evidence disagreement", (_label, change) => {
    expect(planDirectoryRelationshipGenerationRecovery(predecessor,
      { ...proof, ...change } as DirectoryRelationshipGenerationRecoveryProof)).toBeNull();
  });

  it.each([
    ["already-applied parent", { observedCurrentOrganizationPublicId: predecessor.organization.publicId }],
    ["wrong parent", { observedCurrentOrganizationPublicId: "c".repeat(32) }],
    ["wrong client", { observedClientPublicId: "c".repeat(32) }],
    ["client revision drift", { observedClientRevision: "13" }],
    ["wrong organization", { observedOrganizationPublicId: "c".repeat(32) }],
    ["wrong organization binding external ID", { observedOrganizationBindingExternalId: "organization/other" }],
    ["organization revision drift", { observedOrganizationRevision: "8" }],
    ["inactive organization binding", { observedOrganizationBindingStatus: "tombstoned" }],
  ])("rejects %s", (_label, change) => {
    expect(planDirectoryRelationshipGenerationRecovery(predecessor,
      { ...proof, ...change } as DirectoryRelationshipGenerationRecoveryProof)).toBeNull();
  });

  it("rejects a predecessor that fails the existing relationship transport validator", () => {
    expect(planDirectoryRelationshipGenerationRecovery({ ...predecessor, unexpected: true } as typeof predecessor,
      proof)).toBeNull();
  });
});
