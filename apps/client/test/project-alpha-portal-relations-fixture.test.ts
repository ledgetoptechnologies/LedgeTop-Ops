import { describe, expect, it } from "vitest";
import relationFixture from "../../../packages/shared/fixtures/project-alpha-portal-relations-v3.json";
import { parsePortalProjectionDelivery } from "../src/worker/project-alpha-portal";

describe("Project Alpha shared relation/lifecycle projection corpus", () => {
  it("accepts every positive v3 specimen only when the independent relation contract is enabled", () => {
    expect(relationFixture.contract).toBe("ltds-project-alpha-portal-relations-v3");
    expect(relationFixture.endpoint).toBe("/api/internal/project-alpha/portal-v2");
    for (const delivery of Object.values(relationFixture.valid)) {
      expect(() => parsePortalProjectionDelivery(delivery, relationFixture.applicationKey))
        .toThrow("portal-envelope-invalid");
      expect(parsePortalProjectionDelivery(delivery, relationFixture.applicationKey, true).schemaVersion).toBe(3);
    }
  });

  it("rejects every shared strict negative specimen", () => {
    for (const specimen of relationFixture.invalid)
      expect(() => parsePortalProjectionDelivery(specimen.delivery, relationFixture.applicationKey, true), specimen.name)
        .toThrow(specimen.expectedError);
  });

  it("binds activation to the exact page hash and all five record arrays", () => {
    const page = relationFixture.valid.snapshotPage;
    const activation = relationFixture.valid.snapshotActivate;
    const recordCount = page.entities.length + page.principals.length + page.entitlements.length +
      page.relations.length + page.projectLifecycles.length;
    expect(recordCount).toBe(page.recordCount);
    expect(activation).toMatchObject({
      schemaVersion: page.schemaVersion,
      sourceGeneration: page.sourceGeneration,
      sourceSequence: page.sourceSequence,
      workspaceId: page.workspaceId,
      snapshotHash: page.snapshotHash,
      pageCount: page.pageCount,
      recordCount: page.recordCount,
    });
    expect(Object.keys(activation).sort()).toEqual([
      "applicationKey", "deliveryId", "kind", "occurredAt", "pageCount", "recordCount",
      "schemaVersion", "snapshotHash", "sourceGeneration", "sourceSequence", "workspaceId",
    ].sort());
  });
});
