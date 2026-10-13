import { describe, expect, it } from "vitest";
import { assertSameFolderRetry, assertSameWorkspaceRetry } from "../src/client/operations-folder-retry";

const folder = { operationId: "original", targetId: "workspace-a", externalProjectId: "project-a",
  projectVersion: 2, baseR2Prefix: "data/a/", baseConfirmedAt: "confirmation-1", reason: "test" };
const pending = { folder, publication: { operationId: "publish-a", expectedRevision: 3, reason: "test" } };
describe("folder retry selection fence", () => {
  it("permits first requests and exact retries without replacing retained IDs", () => {
    expect(() => assertSameFolderRetry(null, folder, 3, "test")).not.toThrow();
    expect(() => assertSameFolderRetry(pending, { ...folder, operationId: "new-unused" }, 3, "test")).not.toThrow();
    expect(pending.folder.operationId).toBe("original");
  });
  it("rejects another project, workspace, prefix, version or confirmation before transport", () => {
    for (const [key, value] of Object.entries({ targetId: "workspace-b", externalProjectId: "project-b",
      projectVersion: 3, baseR2Prefix: "data/b/", baseConfirmedAt: "confirmation-2", reason: "changed" })) {
      expect(() => assertSameFolderRetry(pending, { ...folder, [key]: value }, 3, "test")).toThrow("selection changed");
    }
  });
  it("rejects changed publication expectations and malformed retained requests", () => {
    expect(() => assertSameFolderRetry(pending, folder, 4, "test")).toThrow("selection changed");
    expect(() => assertSameFolderRetry(pending, folder, 3, "changed")).toThrow("selection changed");
    expect(() => assertSameFolderRetry({ folder: null }, folder, 3, "test")).toThrow("invalid");
    expect(() => assertSameFolderRetry({ ...pending, folder: { ...folder, unexpected: true } }, folder, 3, "test")).toThrow("selection changed");
  });
});

describe("workspace retry selection fence", () => {
  const workspace = { operationId: "original", targetId: "target-a", clientAuthorityId: "authority-a",
    workspaceId: "workspace-a", rootKind: "organization", rootRecordId: "organization-a",
    rootRecordVersion: 1, relationshipVersion: null, expectedRevision: 0, reason: "test" };
  it("permits only exact workspace retries and preserves retained IDs", () => {
    expect(() => assertSameWorkspaceRetry(null, workspace)).not.toThrow();
    expect(() => assertSameWorkspaceRetry({ workspace }, { ...workspace, operationId: "unused" })).not.toThrow();
    for (const [key, value] of Object.entries(workspace).filter(([key]) => key !== "operationId")) {
      expect(() => assertSameWorkspaceRetry({ workspace }, { ...workspace, [key]: `${value}-changed` }))
        .toThrow("workspace selection changed");
    }
  });
  it("rejects malformed or unexpected retained workspace state", () => {
    expect(() => assertSameWorkspaceRetry({ workspace: null }, workspace)).toThrow("invalid");
    expect(() => assertSameWorkspaceRetry({ workspace: { ...workspace, extra: true } }, workspace)).toThrow("selection changed");
  });
});
