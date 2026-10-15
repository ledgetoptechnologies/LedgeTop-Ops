import { describe, expect, it } from "vitest";
import { freezeRecoveryAuthorizationAttempt, usableRelationshipRecoveryCapability }
  from "../src/client/DirectoryRelationshipRecoveryReview";

const review = { reviewId: "10000000-0000-4000-8000-000000000001", recordId: "client/root",
  sourceId: "project-alpha:staging", predecessorCommandId: "20000000-0000-4000-8000-000000000002",
  evidenceSha256: "a".repeat(64), clientRevision: "7", organizationRevision: "9", organizationRecordId: "org/root",
  remoteParentPublicId: null, observedAuthorizationGeneration: "12", expiresAt: "2026-10-10T01:00:00.000Z" } as const;

describe("relationship recovery review UI contracts", () => {
  it("accepts only the explicit unique server capability", () => {
    expect(usableRelationshipRecoveryCapability({ available: true, status: "needs_review", sourceIds: ["project-alpha:staging"] })).toBe(true);
    for (const value of [null, { available: false, status: "needs_review", sourceIds: ["project-alpha:staging"] },
      { available: true, sourceIds: ["project-alpha:staging"] }, { available: true, status: "settled", sourceIds: ["project-alpha:staging"] },
      { available: true, status: "needs_review", sourceIds: [] },
      { available: true, status: "needs_review", sourceIds: ["project-alpha:staging", "project-alpha:staging"] },
      { available: true, status: "needs_review", sourceIds: ["https://arbitrary.example.test"] },
      { available: true, status: "needs_review", sourceIds: ["project-alpha:staging"], extra: true }])
      expect(usableRelationshipRecoveryCapability(value)).toBe(false);
  });

  it("freezes IDs, URL, evidence digest, and trimmed reason for byte-identical retries", () => {
    const generated = ["30000000-0000-4000-8000-000000000003", "40000000-0000-4000-8000-000000000004"];
    const attempt = freezeRecoveryAuthorizationAttempt(review.recordId, review, "  Reviewed exact evidence  ", () => generated.shift()!);
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(attempt).toEqual({ authorizationId: "30000000-0000-4000-8000-000000000003",
      successorCommandId: "40000000-0000-4000-8000-000000000004",
      path: "/api/client-hub/directory/standalone-clients/client%2Froot/relationship-generation-recovery/reviews/10000000-0000-4000-8000-000000000001/authorize",
      body: JSON.stringify({ evidenceSha256: "a".repeat(64), authorizationId: "30000000-0000-4000-8000-000000000003",
        successorCommandId: "40000000-0000-4000-8000-000000000004", reason: "Reviewed exact evidence" }) });
  });
});
