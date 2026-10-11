import { describe, expect, it } from "vitest";
import { nativeProjectPrepareSchema, nativeProjectSubmitSchema } from "../src/worker/client-hub-native-project-management";

const commandId = "11111111-1111-4111-8111-111111111111";
const externalProjectId = "22222222-2222-4222-8222-222222222222";
const project = { name: "Native project", description: null, estimatedStart: null, estimatedEnd: null };
const prepared = { sourceId: "project-alpha:secondary", expectedApplicationId: "33333333-3333-4333-8333-333333333333",
  operation: "create", scopes: [], local: { expectedLocalVersion: 0, expectedLocalProjectionSha256: null },
  directory: { organizationRecordId: "org-record", clientRecordId: null }, command: { commandId, externalId: externalProjectId,
    expectedAuthorizationGeneration: "7", project, organization: { externalId: "org-external", expectedPublicId: "a".repeat(32),
      expectedRevision: "9", expectedProjectionSha256: "b".repeat(64) }, client: null } };

describe("Client Hub native project request boundaries", () => {
  it("accepts only browser project intent during preparation", () => {
    const value = { expectedContextVersion: "context", commandId, externalProjectId, scopes: [], project };
    expect(nativeProjectPrepareSchema.safeParse(value).success).toBe(true);
    for (const injected of [{ ...value, sourceId: "project-alpha:other" }, { ...value, organizationRecordId: "other" },
      { ...value, actor: { staffId: "other" } }, { ...value, expectedApplicationId: prepared.expectedApplicationId }])
      expect(nativeProjectPrepareSchema.safeParse(injected).success).toBe(false);
  });

  it("requires one exact frozen create request for submission", () => {
    expect(nativeProjectSubmitSchema.safeParse({ expectedContextVersion: "context", request: prepared }).success).toBe(true);
    expect(nativeProjectSubmitSchema.safeParse({ expectedContextVersion: "context", request: { ...prepared,
      directory: { ...prepared.directory, clientRecordId: "injected-client" } } }).success).toBe(false);
    expect(nativeProjectSubmitSchema.safeParse({ expectedContextVersion: "context", request: { ...prepared, extra: true } }).success).toBe(false);
  });

  it("requires the complete frozen compare-and-swap envelope for updates", () => {
    const update = { sourceId: prepared.sourceId, expectedApplicationId: prepared.expectedApplicationId,
      operation: "update", scopes: [], local: { expectedLocalVersion: 2, expectedLocalProjectionSha256: "c".repeat(64) },
      command: { commandId, externalId: externalProjectId, expectedAuthorizationGeneration: "7",
        expectedPublicId: "d".repeat(32), expectedRevision: "2", expectedProjectionSha256: "e".repeat(64), project } };
    expect(nativeProjectPrepareSchema.safeParse({ expectedContextVersion: "context", operation: "update", commandId,
      externalProjectId, scopes: [], project }).success).toBe(true);
    expect(nativeProjectSubmitSchema.safeParse({ expectedContextVersion: "context", request: update }).success).toBe(true);
    const legacyId = "ops/project-acceptance-20261008-portal-1";
    expect(nativeProjectPrepareSchema.safeParse({ expectedContextVersion: "context", operation: "update", commandId,
      externalProjectId: legacyId, scopes: [], project }).success).toBe(true);
    expect(nativeProjectSubmitSchema.safeParse({ expectedContextVersion: "context", request: {
      ...update, command: { ...update.command, externalId: legacyId } } }).success).toBe(true);
    expect(nativeProjectPrepareSchema.safeParse({ expectedContextVersion: "context", operation: "create", commandId,
      externalProjectId: legacyId, scopes: [], project }).success).toBe(false);
    expect(nativeProjectPrepareSchema.safeParse({ expectedContextVersion: "context", operation: "update", commandId,
      externalProjectId: `bad\u0000id`, scopes: [], project }).success).toBe(false);
    for (const invalid of [
      { ...update, local: { ...update.local, expectedLocalVersion: 0 } },
      { ...update, command: { ...update.command, expectedRevision: undefined } },
      { ...update, directory: prepared.directory },
    ]) expect(nativeProjectSubmitSchema.safeParse({ expectedContextVersion: "context", request: invalid }).success).toBe(false);
  });
});
