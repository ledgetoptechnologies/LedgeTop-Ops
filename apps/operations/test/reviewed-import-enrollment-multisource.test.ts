import { describe, expect, it } from "vitest";
import { resolveReviewedImportEnrollmentDestinations } from "../src/worker/reviewed-import-enrollment-destinations";

const recordId = "synthetic-imported-client";
const sources = [
  {
    sourceId: "project-alpha:primary", sourceInstanceId: "11111111-1111-4111-8111-111111111111",
    applicationId: "22222222-2222-4222-8222-222222222222", historyEpoch: "33333333-3333-4333-8333-333333333333",
    baseUrl: "https://pa-primary.example.test", externalId: "primary-client", publicId: "a".repeat(32),
  },
  {
    sourceId: "project-alpha:secondary", sourceInstanceId: "44444444-4444-4444-8444-444444444444",
    applicationId: "55555555-5555-4555-8555-555555555555", historyEpoch: "66666666-6666-4666-8666-666666666666",
    baseUrl: "https://pa-secondary.example.test", externalId: "secondary-client", publicId: "b".repeat(32),
  },
] as const;

function environment(missingSource?: string) {
  const database = {
    withSession: () => database,
    prepare: (sql: string) => ({
      bind: (...parameters: unknown[]) => ({
        first: async () => sql.includes("FROM operations_directory_records")
          ? { kind: "client", version: 1 }
          : sql.includes("FROM effective_native_directory_enrollments") ? null : null,
        all: async () => {
          if (!sql.includes("FROM project_alpha_active_directory_mappings")) throw Error("unexpected query");
          const source = sources.find(item => item.sourceId === parameters[2]);
          if (!source || source.sourceId === missingSource) return { results: [] };
          return { results: [{ sourceId: source.sourceId, sourceInstanceUUID: source.sourceInstanceId,
            applicationUUID: source.applicationId, historyEpoch: source.historyEpoch,
            externalCanonicalId: source.externalId, origin: source.baseUrl, activationVersion: 1,
            publicId: source.publicId }] };
        },
      }),
    }),
  } as unknown as D1Database;
  return {
    OPS_DB: database,
    PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: Object.fromEntries(sources.map(source => [
      source.sourceId, { sourceId: source.sourceId, enabled: true, baseUrl: source.baseUrl,
        apiKey: "synthetic-test-only", sourceInstanceId: source.sourceInstanceId,
        applicationId: source.applicationId, historyEpoch: source.historyEpoch },
    ])) }),
  };
}

describe("reviewed import enrollment with two explicitly selected PA sources", () => {
  it("resolves both distinct activated acquisitions in stable source order", async () => {
    const result = await resolveReviewedImportEnrollmentDestinations(environment(), {
      recordId, kind: "client", expectedRecordVersion: 1, expectedEnrollmentVersion: 0,
      sourceIds: [sources[1].sourceId, sources[0].sourceId],
    });
    expect(result).toEqual({ status: "resolved", destinations: sources.map(source => ({
      sourceId: source.sourceId, sourceInstanceUUID: source.sourceInstanceId,
      applicationUUID: source.applicationId, historyEpoch: source.historyEpoch,
      externalCanonicalId: source.externalId, origin: source.baseUrl,
    })) });
  });

  it("fails closed if either selected source lacks its exact acquired mapping", async () => {
    const result = await resolveReviewedImportEnrollmentDestinations(environment(sources[1].sourceId), {
      recordId, kind: "client", expectedRecordVersion: 1, expectedEnrollmentVersion: 0,
      sourceIds: sources.map(source => source.sourceId),
    });
    expect(result).toEqual({ status: "conflict", reason: "source_authority_unavailable" });
  });
});
