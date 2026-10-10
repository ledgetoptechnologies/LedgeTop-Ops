import { describe, expect, it } from "vitest";
import {
  canonicalVerifiedRecipientDeliveryAuthorityCommand,
  createVerifiedRecipientDeliveryAuthorityReceipt,
  parseVerifiedRecipientDeliveryAuthorityCommand,
  parseVerifiedRecipientDeliveryAuthorityReceipt,
  verifiedRecipientDeliveryAuthorityCapabilities,
} from "@ltds/shared/verified-recipient-delivery-authority";

const commandFixture = (overrides: Record<string, unknown> = {}) => ({
  protocol: "verified-recipient-delivery-authority",
  protocolVersion: 1,
  action: "upsert",
  operationId: "11111111-1111-4111-8111-111111111111",
  recipient: {
    recipientBindingId: "22222222-2222-4222-8222-222222222222",
    enrollmentIntentId: "33333333-3333-4333-8333-333333333333",
    enrollmentRevision: 4,
    issuer: "client-issuer-01",
    subject: "recipient-subject-01",
  },
  selection: {
    selectionId: "44444444-4444-4444-8444-444444444444",
    clientAuthorityId: "55555555-5555-4555-8555-555555555555",
    clientRecordId: "client-record-01",
    workspaceId: "workspace-01",
  },
  resource: {
    folderBindingId: "native-binding-folder-01",
    folderBindingSourceVersion: "source-v17",
    sourceId: "project-alpha:customer-01",
    projectPublicId: "project-public-01",
    projectSourceVersion: "project-source-v9",
    currentGenerationId: "generation-19",
  },
  homeAuthority: {
    ownershipEpoch: 1,
    grantRevision: 1,
    grantOperationId: "77777777-7777-4777-8777-777777777777",
  },
  authority: {
    authorityId: "66666666-6666-4666-8666-666666666666",
    expectedRevision: 0,
    resultingRevision: 1,
  },
  terms: {
    reasonCode: "verified_recipient_folder",
    expiresAt: null,
    accessTerms: {
      id: "terms-01",
      kind: "customer",
      mode: "until_revoked",
      reviewedExpiresAt: null,
      effectiveExpiresAt: null,
    },
  },
  ownerProof: {
    staffId: "staff-01",
    verifiedAccessSubject: "access-subject-01",
    admissionVersion: 6,
    profileVersion: 11,
    grantGeneration: 5,
    verifiedUntil: "2030-01-02T03:04:05.678Z",
  },
  ...overrides,
} as const);

const parsedFixture = () => {
  const parsed = parseVerifiedRecipientDeliveryAuthorityCommand(commandFixture());
  if (!parsed) throw new Error("fixture must satisfy the closed command contract");
  return parsed;
};

describe("verified recipient delivery authority contract", () => {
  it("accepts actual owner proof and derives only fixed capabilities", () => {
    const command = parsedFixture();
    expect(command.ownerProof).toMatchObject({ staffId: "staff-01", verifiedAccessSubject: "access-subject-01", grantGeneration: 5 });
    expect(verifiedRecipientDeliveryAuthorityCapabilities(command)).toEqual([
      { capability: "workspace.view", scopeType: "workspace", scopeId: "workspace-01" },
      { capability: "delivery.view", scopeType: "folder", scopeId: "native-binding-folder-01" },
    ]);
  });

  it("accepts customer until-revoked and collaborator project-end with distinct reviewed/effective expiry", () => {
    expect(parsedFixture().terms.accessTerms).toMatchObject({ kind: "customer", mode: "until_revoked", reviewedExpiresAt: null, effectiveExpiresAt: null });
    const projectEnd = parseVerifiedRecipientDeliveryAuthorityCommand({
      ...commandFixture(),
      terms: {
        reasonCode: "verified_recipient_folder",
        expiresAt: "2030-01-02T03:04:05.678Z",
        accessTerms: { id: "terms-02", kind: "collaborator", mode: "project_end", reviewedExpiresAt: null, effectiveExpiresAt: "2030-01-02T03:04:05.678Z" },
      },
    });
    expect(projectEnd?.terms.accessTerms).toMatchObject({ mode: "project_end", reviewedExpiresAt: null, effectiveExpiresAt: "2030-01-02T03:04:05.678Z" });
  });

  it("requires explicit revision CAS and permits revoke only after an existing revision", () => {
    const revoke = parseVerifiedRecipientDeliveryAuthorityCommand({
      ...commandFixture(),
      action: "revoke",
      authority: { ...commandFixture().authority, expectedRevision: 1, resultingRevision: 2 },
    });
    expect(revoke?.authority).toEqual({ authorityId: "66666666-6666-4666-8666-666666666666", expectedRevision: 1, resultingRevision: 2 });
    expect(parseVerifiedRecipientDeliveryAuthorityCommand({ ...commandFixture(), action: "revoke" })).toBeNull();
  });

  it("pins home grant lineage independently from the enrollment revision", () => {
    const command = parsedFixture();
    expect(command.recipient.enrollmentRevision).toBe(4);
    expect(command.homeAuthority.grantRevision).toBe(1);
    const receipt = createVerifiedRecipientDeliveryAuthorityReceipt(command, "recorded");
    expect(parseVerifiedRecipientDeliveryAuthorityReceipt({
      ...receipt,
      command: { ...command, homeAuthority: { ...command.homeAuthority, grantRevision: 4 } },
    }, command)).toBeNull();
    expect(parseVerifiedRecipientDeliveryAuthorityReceipt({
      ...receipt,
      command: { ...command, homeAuthority: { ...command.homeAuthority, grantOperationId: command.operationId } },
    }, command)).toBeNull();
  });

  it("creates receipts whose active allows and revoke affected scopes are disjoint", () => {
    const upsert = parsedFixture();
    const upsertReceipt = createVerifiedRecipientDeliveryAuthorityReceipt(upsert, "recorded");
    expect(upsertReceipt.capabilities).toHaveLength(2);
    expect(upsertReceipt.affectedScopes).toEqual([]);
    expect(parseVerifiedRecipientDeliveryAuthorityReceipt(upsertReceipt, upsert)).toEqual(upsertReceipt);

    const revoke = parseVerifiedRecipientDeliveryAuthorityCommand({ ...commandFixture(), action: "revoke", authority: { ...commandFixture().authority, expectedRevision: 1, resultingRevision: 2 } });
    if (!revoke) throw new Error("revoke fixture must parse");
    const revokeReceipt = createVerifiedRecipientDeliveryAuthorityReceipt(revoke, "replayed");
    expect(revokeReceipt.capabilities).toEqual([]);
    expect(revokeReceipt.affectedScopes).toEqual(upsertReceipt.capabilities);
    expect(parseVerifiedRecipientDeliveryAuthorityReceipt(revokeReceipt, revoke)).toEqual(revokeReceipt);
  });

  it("canonicalizes property order and reparses receipt commands", () => {
    const command = parsedFixture();
    const shuffled = {
      ownerProof: command.ownerProof,
      terms: command.terms,
      authority: command.authority,
      resource: command.resource,
      selection: command.selection,
      homeAuthority: command.homeAuthority,
      recipient: command.recipient,
      operationId: command.operationId,
      action: command.action,
      protocolVersion: 1,
      protocol: command.protocol,
    };
    const reparsed = parseVerifiedRecipientDeliveryAuthorityCommand(shuffled);
    expect(reparsed).not.toBeNull();
    expect(canonicalVerifiedRecipientDeliveryAuthorityCommand(reparsed!)).toBe(canonicalVerifiedRecipientDeliveryAuthorityCommand(command));
    expect(() => createVerifiedRecipientDeliveryAuthorityReceipt({ ...command, email: "person@example.test" } as never, "recorded")).toThrow("command_invalid");
  });

  it("rejects accessor descriptors without evaluating hostile getters", () => {
    const hostile = commandFixture();
    Object.defineProperty(hostile, "operationId", {
      configurable: true,
      enumerable: true,
      get: () => { throw new Error("getter must not run"); },
    });
    expect(parseVerifiedRecipientDeliveryAuthorityCommand(hostile)).toBeNull();
  });

  it("rejects non-plain prototypes and symbol own keys", () => {
    const nonPlain = commandFixture();
    Object.setPrototypeOf(nonPlain, { hostile: true });
    expect(parseVerifiedRecipientDeliveryAuthorityCommand(nonPlain)).toBeNull();

    const withSymbol = commandFixture();
    Object.defineProperty(withSymbol, Symbol("unknown"), { enumerable: true, value: true });
    expect(parseVerifiedRecipientDeliveryAuthorityCommand(withSymbol)).toBeNull();
  });

  it.each([
    ["unknown command key", () => ({ ...commandFixture(), email: "person@example.test" })],
    ["unknown recipient key", () => ({ ...commandFixture(), recipient: { ...commandFixture().recipient, email: "person@example.test" } })],
    ["malformed operation UUID", () => ({ ...commandFixture(), operationId: "not-a-uuid" })],
    ["wrong UUID version", () => ({ ...commandFixture(), operationId: "11111111-1111-5111-8111-111111111111" })],
    ["zero enrollment revision", () => ({ ...commandFixture(), recipient: { ...commandFixture().recipient, enrollmentRevision: 0 } })],
    ["missing independent home pin", () => ({ ...commandFixture(), homeAuthority: undefined })],
    ["zero home ownership epoch", () => ({ ...commandFixture(), homeAuthority: { ...commandFixture().homeAuthority, ownershipEpoch: 0 } })],
    ["zero home grant revision", () => ({ ...commandFixture(), homeAuthority: { ...commandFixture().homeAuthority, grantRevision: 0 } })],
    ["malformed home operation", () => ({ ...commandFixture(), homeAuthority: { ...commandFixture().homeAuthority, grantOperationId: "not-a-uuid" } })],
    ["extra home authority capability", () => ({ ...commandFixture(), homeAuthority: { ...commandFixture().homeAuthority, permission: "delivery.view" } })],
    ["non-positive generation", () => ({ ...commandFixture(), ownerProof: { ...commandFixture().ownerProof, grantGeneration: 0 } })],
    ["reason punctuation", () => ({ ...commandFixture(), terms: { ...commandFixture().terms, reasonCode: "verified/<recipient>" } })],
    ["reason unicode", () => ({ ...commandFixture(), terms: { ...commandFixture().terms, reasonCode: "verified_recipient_✓" } })],
    ["source-generation drift", () => ({ ...commandFixture(), resource: { ...commandFixture().resource, currentGenerationId: "" } })],
    ["noncanonical expiry", () => ({ ...commandFixture(), terms: { ...commandFixture().terms, expiresAt: "2030-01-02T03:04:05Z" } })],
    ["customer specific date", () => ({ ...commandFixture(), terms: { reasonCode: "verified_recipient_folder", expiresAt: "2030-01-02T03:04:05.678Z", accessTerms: { id: "terms", kind: "customer", mode: "specific_date", reviewedExpiresAt: "2030-01-02T03:04:05.678Z", effectiveExpiresAt: "2030-01-02T03:04:05.678Z" } } })],
    ["project-end reviewed expiry", () => ({ ...commandFixture(), terms: { reasonCode: "verified_recipient_folder", expiresAt: null, accessTerms: { id: "terms", kind: "collaborator", mode: "project_end", reviewedExpiresAt: "2030-01-02T03:04:05.678Z", effectiveExpiresAt: null } } })],
    ["CAS mismatch", () => ({ ...commandFixture(), authority: { ...commandFixture().authority, expectedRevision: 0, resultingRevision: 2 } })],
    ["missing owner staff identity", () => ({ ...commandFixture(), ownerProof: { ...commandFixture().ownerProof, staffId: "" } })],
    ["email identity substitute", () => ({ ...commandFixture(), recipient: { ...commandFixture().recipient, subject: undefined, email: "person@example.test" } })],
  ] as const)("rejects %s", (_name, build) => {
    expect(parseVerifiedRecipientDeliveryAuthorityCommand(build())).toBeNull();
  });

  it.each([
    ["capability widening", (receipt: ReturnType<typeof createVerifiedRecipientDeliveryAuthorityReceipt>) => ({ ...receipt, capabilities: [...receipt.capabilities, { capability: "directory.read", scopeType: "workspace", scopeId: "workspace-01" }] })],
    ["affected scope on upsert", (receipt: ReturnType<typeof createVerifiedRecipientDeliveryAuthorityReceipt>) => ({ ...receipt, affectedScopes: receipt.capabilities })],
    ["receipt revision drift", (receipt: ReturnType<typeof createVerifiedRecipientDeliveryAuthorityReceipt>) => ({ ...receipt, resultingRevision: receipt.resultingRevision + 1 })],
    ["receipt command drift", (receipt: ReturnType<typeof createVerifiedRecipientDeliveryAuthorityReceipt>) => ({ ...receipt, command: { ...receipt.command, email: "person@example.test" } })],
    ["receipt unknown key", (receipt: ReturnType<typeof createVerifiedRecipientDeliveryAuthorityReceipt>) => ({ ...receipt, email: "person@example.test" })],
  ] as const)("rejects %s", (_name, mutate) => {
    const command = parsedFixture();
    const receipt = createVerifiedRecipientDeliveryAuthorityReceipt(command, "recorded");
    expect(parseVerifiedRecipientDeliveryAuthorityReceipt(mutate(receipt), command)).toBeNull();
  });
});
