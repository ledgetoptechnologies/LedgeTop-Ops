import { describe, expect, it } from "vitest";
import { chicagoEndOfDay, directShareBody, grantsForTarget, validViewerCatalogProjects, validViewerCatalogTasks,
  type DirectShareGrant, type ViewerShareTarget } from "../src/client/ViewerQuickShare";

const project = { viewerProjectId: "vp-1", name: "Seawall survey" };
const task = { taskId: "task-1", title: "Orthomosaic", publishedAt: "2026-10-20T12:00:00.000Z", modelId: "model-1" };
const client = { sourceId: "project-alpha:primary", workspaceId: "ws-1", displayName: "Harbor", businessName: "Ledge Top" };
const permissions = { measure: true, cameras: false, download: false };

describe("Viewer quick share", () => {
  it("accepts only well-formed catalog pages", () => {
    expect(validViewerCatalogProjects({ projects: [{ viewerProjectId: "vp-1", name: "A", publishedTaskCount: 0, updatedAt: "x" }], nextCursor: null })).toBe(true);
    expect(validViewerCatalogProjects({ projects: [{ viewerProjectId: "../vp", name: "A", publishedTaskCount: 0, updatedAt: "x" }], nextCursor: null })).toBe(false);
    expect(validViewerCatalogProjects({ projects: [{ viewerProjectId: "vp-1", name: "A", publishedTaskCount: -1, updatedAt: "x" }], nextCursor: null })).toBe(false);
    expect(validViewerCatalogProjects({ projects: [] })).toBe(false);
    // Count and update time may be absent until the source catalog provides them.
    expect(validViewerCatalogProjects({ projects: [{ viewerProjectId: "vp-1", name: "A" }, { viewerProjectId: "vp-2", name: "B", publishedTaskCount: null, updatedAt: null }], nextCursor: "c-2" })).toBe(true);
    expect(validViewerCatalogTasks({ project, tasks: [task], nextCursor: null }, "vp-1")).toBe(true);
    // A page for another project is never shown under this one.
    expect(validViewerCatalogTasks({ project, tasks: [task], nextCursor: null }, "vp-2")).toBe(false);
    expect(validViewerCatalogTasks({ project, tasks: [{ ...task, modelId: "" }], nextCursor: null }, "vp-1")).toBe(false);
  });

  it("builds a task share without future models, and a project share only with the explicit opt-in", () => {
    expect(directShareBody({ project, task }, client, permissions, null, true)).toEqual({ sourceId: "project-alpha:primary",
      workspaceId: "ws-1", viewerProjectId: "vp-1", taskId: "task-1", scopeType: "task", includeFuturePublished: false,
      confirmedScope: true, expiresAt: null, permissions });
    expect(() => directShareBody({ project, task: null }, client, permissions, null, false)).toThrow();
    expect(directShareBody({ project, task: null }, client, permissions, null, true))
      .toMatchObject({ taskId: null, scopeType: "project", includeFuturePublished: true });
  });

  it("lists only active grants that cover the chosen target", () => {
    const base = { sourceId: "s", workspaceId: "w", viewerProjectId: "vp-1", includeFuturePublished: false, permissions,
      expiresAt: null, revokedAt: null, createdAt: "x", clientDisplayName: null } as const;
    const grants: DirectShareGrant[] = [
      { ...base, grantId: "project", taskId: null, scopeType: "project", includeFuturePublished: true },
      { ...base, grantId: "same-task", taskId: "task-1", scopeType: "task" },
      { ...base, grantId: "other-task", taskId: "task-2", scopeType: "task" },
      { ...base, grantId: "revoked", taskId: "task-1", scopeType: "task", revokedAt: "x" },
      { ...base, grantId: "other-project", viewerProjectId: "vp-2", taskId: null, scopeType: "project" },
    ];
    const ids = (target: ViewerShareTarget) => grantsForTarget(grants, target).map(grant => grant.grantId);
    expect(ids({ project, task })).toEqual(["project", "same-task"]);
    expect(ids({ project, task: null })).toEqual(["project"]);
  });

  it("ends access at the close of the chosen Central-time day across daylight saving", () => {
    expect(chicagoEndOfDay("2026-12-31")).toBe("2027-01-01T05:59:59.000Z");
    expect(chicagoEndOfDay("2026-07-04")).toBe("2026-07-05T04:59:59.000Z");
    expect(chicagoEndOfDay("2026-03-08")).toBe("2026-03-09T04:59:59.000Z");
    expect(chicagoEndOfDay("2026-11-01")).toBe("2026-11-02T05:59:59.000Z");
    expect(chicagoEndOfDay("12/31/2026")).toBeNull();
  });
});
