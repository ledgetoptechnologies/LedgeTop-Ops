import { describe, expect, it } from "vitest";
import {
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS,
  canonicalOperationsPortalWorkspacePublication,
  parseOperationsPortalWorkspacePublication,
  sha256OperationsPortalWorkspacePublication,
  sha256OperationsPortalWorkspaceSnapshot,
  verifyOperationsPortalWorkspacePublication,
} from "@ltds/shared/operations-portal-workspace-publication";

const zeroHash = "0".repeat(64);

const rawFixture = () => ({
  protocol: "operations-portal-workspace-publication",
  protocolVersion: 1,
  action: "publish",
  publicationId: "11111111-1111-4111-8111-111111111111",
  operationId: "22222222-2222-4222-8222-222222222222",
  expectedRevision: "0",
  resultingRevision: "1",
  target: {
    targetId: "33333333-3333-4333-8333-333333333333",
    targetRevision: "4",
    clientAuthorityId: "44444444-4444-4444-8444-444444444444",
    workspaceId: "workspace-acme",
    rootKind: "organization",
    rootRecordId: "ops-org-acme",
  },
  snapshot: {
    snapshotId: "55555555-5555-4555-8555-555555555555",
    checkpointId: "66666666-6666-4666-8666-666666666666",
    sourceSequence: "9",
    complete: true,
    counts: {
      directoryRecords: 2,
      projects: 1,
      folderReservations: 1,
      recipientAuthorityHeads: 1,
      deliveryAuthorityHeads: 1,
    },
    snapshotSha256: zeroHash,
    directoryRecords: [
      {
        recordId: "ops-client-acme-primary",
        kind: "client",
        version: "8",
        parentRecordId: "ops-org-acme",
        relationshipVersion: "3",
        displayName: "Acme Primary Client",
        externalFences: [],
      },
      {
        recordId: "ops-org-acme",
        kind: "organization",
        version: "12",
        parentRecordId: null,
        relationshipVersion: null,
        displayName: "Acme Organization",
        externalFences: [{
          sourceId: "project-alpha:secondary",
          sourceInstanceId: "77777777-7777-4777-8777-777777777777",
          applicationId: "88888888-8888-4888-8888-888888888888",
          historyEpoch: "99999999-9999-4999-8999-999999999999",
          authorizationGeneration: "9007199254740993",
          publicId: "abcdef0123456789abcdef0123456789",
          revision: "18",
          projectionSha256: "a".repeat(64),
        }],
      },
    ],
    projects: [{
      externalProjectId: "ops-project-airfield",
      version: "7",
      name: "Airfield Survey",
      lifecycle: "active",
      plannedStart: "2030-01-01",
      plannedEnd: "2030-06-30",
      completedAt: null,
      archived: false,
      archivedAt: null,
      overdueWarning: false,
      published: true,
      organizationRecordId: "ops-org-acme",
      clientRecordId: "ops-client-acme-primary",
      externalFence: {
        sourceId: "project-alpha:secondary",
        sourceInstanceId: "77777777-7777-4777-8777-777777777777",
        applicationId: "88888888-8888-4888-8888-888888888888",
        historyEpoch: "99999999-9999-4999-8999-999999999999",
        authorizationGeneration: "9007199254740993",
        publicId: "0123456789abcdef0123456789abcdef",
        revision: "22",
        projectionSha256: "b".repeat(64),
      },
    }],
    folderReservations: [{
      reservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      externalProjectId: "ops-project-airfield",
      opsFolderProjectId: "folder-project-airfield",
      divisionId: "division-survey",
      clientFolderBindingId: "folder-binding-airfield",
      bindingVersion: "2",
      r2Prefix: "clients/acme/airfield/",
      state: "active",
    }],
    recipientAuthorityHeads: [{
      recipientBindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      enrollmentIntentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      targetClientRecordId: "ops-client-acme-primary",
      clientAuthorityId: "44444444-4444-4444-8444-444444444444",
      workspaceId: "workspace-acme",
      issuer: "https://access.example.test",
      subject: "opaque-subject-01",
      enrollmentRevision: "3",
      ownershipEpoch: "2",
      grantRevision: "5",
      state: "active",
      lastOperationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      protocolVersion: 3,
      permissions: ["operations.service_home.read"],
    }],
    deliveryAuthorityHeads: [{
      authorityId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      authorityRevision: "4",
      state: "active",
      lastOperationId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      clientAuthorityId: "44444444-4444-4444-8444-444444444444",
      workspaceId: "workspace-acme",
      recipientBindingId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      enrollmentIntentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      homeOwnershipEpoch: "2",
      homeGrantRevision: "5",
      folderReservationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      folderBindingId: "folder-binding-airfield",
      expiresAt: "2030-02-01T00:00:00.000Z",
    }],
  },
  actorProof: {
    staffId: "staff-owner-01",
    verifiedAccessSubject: "opaque-staff-subject",
    admissionVersion: "4",
    profileVersion: "6",
    grantGeneration: "11",
    verifiedUntil: "2030-01-01T02:00:00.000Z",
  },
  observedAt: "2030-01-01T01:00:00.000Z",
});

async function signedFixture() {
  const value = rawFixture();
  value.snapshot.snapshotSha256 = await sha256OperationsPortalWorkspaceSnapshot(value);
  return value;
}

function clone<T>(value: T): T { return structuredClone(value); }

function generatedUuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

describe("Operations portal workspace publication contract", () => {
  it("accepts and verifies a complete Ops-owned topology without making it an authorization result", async () => {
    const value = await signedFixture();
    const publication = await verifyOperationsPortalWorkspacePublication(value);
    expect(publication).not.toBeNull();
    expect(publication?.target).toMatchObject({ rootRecordId: "ops-org-acme", rootKind: "organization" });
    expect(publication?.snapshot.directoryRecords.map(record => record.recordId))
      .toEqual(["ops-client-acme-primary", "ops-org-acme"]);
    expect(publication?.snapshot.recipientAuthorityHeads[0]?.permissions).toEqual(["operations.service_home.read"]);
  });

  it("sorts every repeated set before canonical serialization and hashing", async () => {
    const first = await signedFixture();
    const shuffled = clone(first);
    shuffled.snapshot.directoryRecords.reverse();
    expect(canonicalOperationsPortalWorkspacePublication(shuffled))
      .toBe(canonicalOperationsPortalWorkspacePublication(first));
    expect(await sha256OperationsPortalWorkspacePublication(shuffled))
      .toBe(await sha256OperationsPortalWorkspacePublication(first));
    expect(await verifyOperationsPortalWorkspacePublication(shuffled)).not.toBeNull();
  });

  it("requires an exact complete root/direct-client closure", async () => {
    const value = await signedFixture();
    const transitive = clone(value);
    transitive.snapshot.directoryRecords[0]!.parentRecordId = "some-intermediate-client";
    expect(parseOperationsPortalWorkspacePublication(transitive)).toBeNull();

    const standaloneWithChild = clone(value);
    standaloneWithChild.target.rootKind = "standalone_client";
    standaloneWithChild.target.rootRecordId = "ops-client-acme-primary";
    expect(parseOperationsPortalWorkspacePublication(standaloneWithChild)).toBeNull();

    const missingRoot = clone(value);
    missingRoot.snapshot.directoryRecords.shift();
    missingRoot.snapshot.counts.directoryRecords = 1;
    expect(parseOperationsPortalWorkspacePublication(missingRoot)).toBeNull();
  });

  it("requires projects to belong to the explicit root closure", async () => {
    const value = await signedFixture();
    const foreignOrganization = clone(value);
    foreignOrganization.snapshot.projects[0]!.organizationRecordId = "ops-org-other";
    expect(parseOperationsPortalWorkspacePublication(foreignOrganization)).toBeNull();

    const unknownClient = clone(value);
    unknownClient.snapshot.projects[0]!.clientRecordId = "ops-client-other";
    expect(parseOperationsPortalWorkspacePublication(unknownClient)).toBeNull();

    const ownerless = clone(value) as unknown as { snapshot: { projects: Array<{
      organizationRecordId: string | null; clientRecordId: string | null;
    }> } };
    ownerless.snapshot.projects[0]!.organizationRecordId = null;
    ownerless.snapshot.projects[0]!.clientRecordId = null;
    expect(parseOperationsPortalWorkspacePublication(ownerless)).toBeNull();
  });

  it("keeps PA data optional and limited to strict shared-record freshness fences", async () => {
    const value = await signedFixture();
    const noFence = clone(value) as unknown as { snapshot: {
      directoryRecords: Array<{ externalFences: Array<Record<string, unknown>> }>;
      projects: Array<{ externalFence: Record<string, unknown> | null }>;
    } };
    noFence.snapshot.directoryRecords[1]!.externalFences = [];
    noFence.snapshot.projects[0]!.externalFence = null;
    expect(parseOperationsPortalWorkspacePublication(noFence)).not.toBeNull();

    const wrongSource = clone(value);
    wrongSource.snapshot.projects[0]!.externalFence!.sourceId = "identity-provider:primary";
    expect(parseOperationsPortalWorkspacePublication(wrongSource)).toBeNull();

    const identitySmuggling = clone(value) as unknown as { snapshot: { projects: Array<{ externalFence: Record<string, unknown> }> } };
    identitySmuggling.snapshot.projects[0]!.externalFence.principalId = "not-allowed";
    expect(parseOperationsPortalWorkspacePublication(identitySmuggling)).toBeNull();
  });

  it("accepts one Ops customer unified across two PA instances and rejects a duplicate scoped tuple", async () => {
    const value = await signedFixture();
    type MutableFence = typeof value.snapshot.directoryRecords[1]["externalFences"][number];
    type MutableDirectoryFences = { snapshot: { directoryRecords: Array<{ externalFences: MutableFence[] }> } };
    const sourceQualified = clone(value) as unknown as MutableDirectoryFences;
    sourceQualified.snapshot.directoryRecords[1]!.externalFences.push({
      ...clone(sourceQualified.snapshot.directoryRecords[1]!.externalFences[0]!),
      sourceId: "project-alpha:primary",
      sourceInstanceId: "12121212-1212-4121-8121-121212121212",
    });
    const parsed = parseOperationsPortalWorkspacePublication(sourceQualified);
    expect(parsed).not.toBeNull();
    expect(parsed?.snapshot.directoryRecords.find(record => record.recordId === "ops-org-acme")?.externalFences
      .map(fence => fence.sourceId)).toEqual(["project-alpha:primary", "project-alpha:secondary"]);

    const duplicateTuple = clone(value) as unknown as MutableDirectoryFences;
    duplicateTuple.snapshot.directoryRecords[1]!.externalFences.push(
      clone(duplicateTuple.snapshot.directoryRecords[1]!.externalFences[0]!),
    );
    expect(parseOperationsPortalWorkspacePublication(duplicateTuple)).toBeNull();
  });

  it("preserves all signed-int64 versions as canonical decimal strings", async () => {
    const value = await signedFixture();
    value.expectedRevision = "9223372036854775806";
    value.resultingRevision = "9223372036854775807";
    value.target.targetRevision = "9223372036854775807";
    value.snapshot.directoryRecords[0]!.version = "9223372036854775807";
    value.snapshot.projects[0]!.externalFence!.authorizationGeneration = "9223372036854775807";
    expect(parseOperationsPortalWorkspacePublication(value)?.resultingRevision).toBe("9223372036854775807");

    for (const invalid of [9, "09", "1e3", "-1", "9223372036854775808"]) {
      const malformed = clone(value) as unknown as { target: { targetRevision: unknown } };
      malformed.target.targetRevision = invalid;
      expect(parseOperationsPortalWorkspacePublication(malformed)).toBeNull();
    }
  });

  it("requires exact normalized prefixes and unique permanent bindings", async () => {
    const value = await signedFixture();
    for (const prefix of ["/clients/acme/", "clients//acme/", "clients/../acme/", "dump/acme/",
      "clients/acme/*/", "clients\\acme\\", "clients/acme"]) {
      const malformed = clone(value);
      malformed.snapshot.folderReservations[0]!.r2Prefix = prefix;
      expect(parseOperationsPortalWorkspacePublication(malformed)).toBeNull();
    }

    const duplicate = clone(value);
    duplicate.snapshot.folderReservations.push(clone(duplicate.snapshot.folderReservations[0]!));
    duplicate.snapshot.counts.folderReservations = 2;
    expect(parseOperationsPortalWorkspacePublication(duplicate)).toBeNull();

    const unpublishedOwner = clone(value);
    unpublishedOwner.snapshot.projects[0]!.published = false;
    expect(parseOperationsPortalWorkspacePublication(unpublishedOwner)).toBeNull();
  });

  it("allows explicit ancestor and descendant reservations under one Ops base without inferred prefix authority", async () => {
    const value = await signedFixture();
    const second = {
      ...clone(value.snapshot.folderReservations[0]!),
      reservationId: "abababab-abab-4bab-8bab-abababababab",
      clientFolderBindingId: "folder-binding-airfield-photos",
      r2Prefix: "clients/acme/airfield/photos/",
    };
    value.snapshot.folderReservations.push(second);
    value.snapshot.counts.folderReservations = 2;
    const parsed = parseOperationsPortalWorkspacePublication(value);
    expect(parsed).not.toBeNull();
    expect(parsed?.snapshot.folderReservations.map(folder => folder.opsFolderProjectId))
      .toEqual(["folder-project-airfield", "folder-project-airfield"]);
  });

  it("uses exact issuer/subject head references and rejects inferred identity metadata", async () => {
    const value = await signedFixture();
    const extraEmail = clone(value) as unknown as { snapshot: { recipientAuthorityHeads: Array<Record<string, unknown>> } };
    extraEmail.snapshot.recipientAuthorityHeads[0]!.email = "person@example.test";
    expect(parseOperationsPortalWorkspacePublication(extraEmail)).toBeNull();

    const mismatchedAuthority = clone(value);
    mismatchedAuthority.snapshot.recipientAuthorityHeads[0]!.clientAuthorityId = "12121212-1212-4121-8121-121212121212";
    expect(parseOperationsPortalWorkspacePublication(mismatchedAuthority)).toBeNull();

    const wildcardPermission = clone(value) as unknown as { snapshot: { recipientAuthorityHeads: Array<{ permissions: string[] }> } };
    wildcardPermission.snapshot.recipientAuthorityHeads[0]!.permissions = ["*"];
    expect(parseOperationsPortalWorkspacePublication(wildcardPermission)).toBeNull();
  });

  it("requires active delivery heads to reference the exact active recipient, enrollment, home revision, and folder", async () => {
    const value = await signedFixture();
    const wrongEnrollment = clone(value);
    wrongEnrollment.snapshot.deliveryAuthorityHeads[0]!.enrollmentIntentId = "12121212-1212-4121-8121-121212121212";
    expect(parseOperationsPortalWorkspacePublication(wrongEnrollment)).toBeNull();

    const staleHome = clone(value);
    staleHome.snapshot.deliveryAuthorityHeads[0]!.homeGrantRevision = "4";
    expect(parseOperationsPortalWorkspacePublication(staleHome)).toBeNull();

    const revokedRecipient = clone(value);
    revokedRecipient.snapshot.recipientAuthorityHeads[0]!.state = "revoked";
    revokedRecipient.snapshot.recipientAuthorityHeads[0]!.permissions = [];
    expect(parseOperationsPortalWorkspacePublication(revokedRecipient)).toBeNull();

    const expired = clone(value);
    expired.snapshot.deliveryAuthorityHeads[0]!.expiresAt = expired.observedAt;
    expect(parseOperationsPortalWorkspacePublication(expired)).toBeNull();
  });

  it("retains historical home pins on revoked delivery heads", async () => {
    const value = await signedFixture();
    const historicalRevoke = clone(value);
    historicalRevoke.snapshot.deliveryAuthorityHeads[0]!.state = "revoked";
    historicalRevoke.snapshot.deliveryAuthorityHeads[0]!.homeOwnershipEpoch = "1";
    historicalRevoke.snapshot.deliveryAuthorityHeads[0]!.homeGrantRevision = "2";
    historicalRevoke.snapshot.deliveryAuthorityHeads[0]!.expiresAt = "2029-12-01T00:00:00.000Z";
    expect(parseOperationsPortalWorkspacePublication(historicalRevoke)).not.toBeNull();

    const wrongEnrollment = clone(historicalRevoke);
    wrongEnrollment.snapshot.deliveryAuthorityHeads[0]!.enrollmentIntentId =
      "12121212-1212-4121-8121-121212121212";
    expect(parseOperationsPortalWorkspacePublication(wrongEnrollment)).toBeNull();
  });

  it("enforces declared counts, duplicate rejection, and a hard canonical byte bound", async () => {
    const value = await signedFixture();
    const wrongCount = clone(value);
    wrongCount.snapshot.counts.projects = 2;
    expect(parseOperationsPortalWorkspacePublication(wrongCount)).toBeNull();

    const duplicateRecord = clone(value);
    duplicateRecord.snapshot.directoryRecords.push(clone(duplicateRecord.snapshot.directoryRecords[0]!));
    duplicateRecord.snapshot.counts.directoryRecords = 3;
    expect(parseOperationsPortalWorkspacePublication(duplicateRecord)).toBeNull();

    const oversized = clone(value);
    const recipients = Array.from({ length: OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.recipientAuthorityHeads }, (_, index) => ({
      ...clone(value.snapshot.recipientAuthorityHeads[0]!),
      recipientBindingId: generatedUuid(10_000 + index * 3),
      enrollmentIntentId: generatedUuid(10_001 + index * 3),
      lastOperationId: generatedUuid(10_002 + index * 3),
      issuer: `issuer-${index}-` + "x".repeat(500 - String(index).length),
      subject: `subject-${index}-` + "y".repeat(499 - String(index).length),
    }));
    const deliveries = Array.from({ length: OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.deliveryAuthorityHeads }, (_, index) => {
      const recipient = recipients[index % recipients.length]!;
      return {
        ...clone(value.snapshot.deliveryAuthorityHeads[0]!),
        authorityId: generatedUuid(50_000 + index * 2),
        lastOperationId: generatedUuid(50_001 + index * 2),
        recipientBindingId: recipient.recipientBindingId,
        enrollmentIntentId: recipient.enrollmentIntentId,
      };
    });
    oversized.snapshot.recipientAuthorityHeads = recipients;
    oversized.snapshot.deliveryAuthorityHeads = deliveries;
    oversized.snapshot.counts.recipientAuthorityHeads = recipients.length;
    oversized.snapshot.counts.deliveryAuthorityHeads = deliveries.length;
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength)
      .toBeGreaterThan(OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.canonicalBytes);
    expect(parseOperationsPortalWorkspacePublication(oversized)).toBeNull();
  });

  it("detects content tampering through the declared canonical snapshot hash", async () => {
    const value = await signedFixture();
    expect(await verifyOperationsPortalWorkspacePublication(value)).not.toBeNull();
    const tampered = clone(value);
    tampered.snapshot.projects[0]!.name = "Different safe project name";
    expect(parseOperationsPortalWorkspacePublication(tampered)).not.toBeNull();
    expect(await verifyOperationsPortalWorkspacePublication(tampered)).toBeNull();
  });

  it("rejects extra fields, accessors, invalid action, and expired actor proof", async () => {
    const value = await signedFixture();
    expect(parseOperationsPortalWorkspacePublication({ ...value, route: "/publish" })).toBeNull();
    expect(parseOperationsPortalWorkspacePublication({ ...value, action: "revoke" })).toBeNull();
    expect(parseOperationsPortalWorkspacePublication({ ...value, actorProof: { ...value.actorProof, verifiedUntil: value.observedAt } })).toBeNull();

    const accessor = clone(value) as Record<string, unknown>;
    Object.defineProperty(accessor, "protocol", { enumerable: true, get: () => "operations-portal-workspace-publication" });
    expect(parseOperationsPortalWorkspacePublication(accessor)).toBeNull();
  });

  it("fails closed on oversized, sparse, accessor, and hostile proxy arrays without invoking getters", async () => {
    const value = await signedFixture();
    const oversized = clone(value) as unknown as { snapshot: { projects: unknown[] } };
    oversized.snapshot.projects = new Array(OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.projects + 1).fill({});
    expect(() => parseOperationsPortalWorkspacePublication(oversized)).not.toThrow();
    expect(parseOperationsPortalWorkspacePublication(oversized)).toBeNull();

    const sparse = clone(value) as unknown as { snapshot: { directoryRecords: unknown[] } };
    sparse.snapshot.directoryRecords = new Array(2);
    expect(() => parseOperationsPortalWorkspacePublication(sparse)).not.toThrow();
    expect(parseOperationsPortalWorkspacePublication(sparse)).toBeNull();

    let invoked = false;
    const accessorArray: unknown[] = [];
    Object.defineProperty(accessorArray, "0", { enumerable: true, get: () => { invoked = true; throw new Error("must-not-run"); } });
    accessorArray.length = 1;
    const accessor = clone(value) as unknown as { snapshot: { projects: unknown[] } };
    accessor.snapshot.projects = accessorArray;
    expect(() => parseOperationsPortalWorkspacePublication(accessor)).not.toThrow();
    expect(invoked).toBe(false);

    const hostile = clone(value) as unknown as { snapshot: { projects: unknown[] } };
    hostile.snapshot.projects = new Proxy([], { get(_target, property) {
      if (property === "length") throw new Error("hostile-length");
      return undefined;
    } });
    expect(() => parseOperationsPortalWorkspacePublication(hostile)).not.toThrow();
    expect(parseOperationsPortalWorkspacePublication(hostile)).toBeNull();
  });

  it("copies data descriptors without looking up array methods on an untrusted proxy", async () => {
    const value = await signedFixture();
    let mapLookupInvoked = false;
    const projects = clone(value.snapshot.projects);
    const hostileMethods = new Proxy(projects, {
      get(target, property, receiver) {
        if (property === "map") {
          mapLookupInvoked = true;
          throw new Error("untrusted-map-lookup");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const proxied = clone(value) as unknown as { snapshot: { projects: unknown[] } };
    proxied.snapshot.projects = hostileMethods;
    expect(() => parseOperationsPortalWorkspacePublication(proxied)).not.toThrow();
    expect(parseOperationsPortalWorkspacePublication(proxied)).not.toBeNull();
    expect(mapLookupInvoked).toBe(false);
  });

  it("copies top-level data descriptors without property gets on an untrusted object proxy", async () => {
    const value = await signedFixture();
    let getInvoked = false;
    const hostileTopLevel = new Proxy(value, {
      get() {
        getInvoked = true;
        throw new Error("untrusted-top-level-get");
      },
    });
    expect(() => parseOperationsPortalWorkspacePublication(hostileTopLevel)).not.toThrow();
    expect(parseOperationsPortalWorkspacePublication(hostileTopLevel)).not.toBeNull();
    expect(getInvoked).toBe(false);
  });

  it("copies nested data descriptors without property gets on an untrusted object proxy", async () => {
    const value = await signedFixture();
    let getInvoked = false;
    const target = new Proxy(value.target, {
      get() {
        getInvoked = true;
        throw new Error("untrusted-nested-get");
      },
    });
    const hostileNested = clone(value) as unknown as { target: unknown };
    hostileNested.target = target;
    expect(() => parseOperationsPortalWorkspacePublication(hostileNested)).not.toThrow();
    expect(parseOperationsPortalWorkspacePublication(hostileNested)).not.toBeNull();
    expect(getInvoked).toBe(false);
  });
});
