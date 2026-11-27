import { describe, expect, it } from "vitest";
import { businessLabel, clientSearchPath, loadDirectShareWorkspace, nextActiveOption, projectSearchPath, QUICK_SHARE_RESULT_LIMIT, searchDirectShareClients, searchReady, chicagoEndOfDay, chicagoToday, directShareBody, futureChicagoEndOfDay, grantsForTarget, permissionSentence,
  defaultPublicLinkDay, publicLinkDayRange, publicLinkExpiry, validViewerCatalogProjects, validViewerCatalogTasks,
  type DirectShareGrant, type ViewerShareTarget } from "../src/client/ViewerQuickShare";

const project = { viewerProjectId: "vp-1", name: "Seawall survey" };
const task = { taskId: "task-1", title: "Orthomosaic", publishedAt: "2026-10-20T12:00:00.000Z", modelId: "model-1" };
const client = { sourceId: "project-alpha:primary", workspaceId: "ws-1", displayName: "Harbor", businessName: "Ledge Top" };
const permissions = { measure: true, cameras: false, download: false };

describe("Viewer quick share", () => {
  it("loads every page of existing shares without listing any clients, and flags a list it could not finish", async () => {
    const grant = (id: string) => ({ grantId: id, sourceId: client.sourceId, workspaceId: "ws-1", viewerProjectId: "vp-1", taskId: null,
      scopeType: "project", includeFuturePublished: true, permissions, expiresAt: null, revokedAt: null, createdAt: "x", clientDisplayName: null });
    const pages = [{ clients: [client], clientsNextCursor: null, grants: [grant("g-1")], grantsNextCursor: "g-1" },
      { clients: [], clientsNextCursor: null, grants: [grant("g-2")], grantsNextCursor: null }];
    const paths: string[] = [];
    const loaded = await loadDirectShareWorkspace(async path => { paths.push(path); return pages[paths.length - 1]; }, "vp-1");
    expect(loaded.grants.map(item => item.grantId)).toEqual(["g-1", "g-2"]);
    expect(loaded.grantsIncomplete).toBe(false);
    expect(Object.fromEntries(new URL(paths[0]!, "https://ops.test").searchParams)).toEqual({ viewerProjectId: "vp-1", include: "grants" });
    expect(Object.fromEntries(new URL(paths[1]!, "https://ops.test").searchParams)).toEqual({ viewerProjectId: "vp-1", include: "grants", grantsCursor: "g-1" });
    const endless = await loadDirectShareWorkspace(async () => ({ clients: [], clientsNextCursor: null, grants: [grant("g")], grantsNextCursor: "again" }), "vp-1");
    expect(endless.grantsIncomplete).toBe(true);
    await expect(loadDirectShareWorkspace(async () => ({ clients: [] }), "vp-1")).rejects.toThrow("invalid_response");
  });

  it("is search-first: nothing is requested for projects or clients below two characters", async () => {
    for (const text of ["", " ", "a", " a "]) {
      expect(searchReady(text)).toBe(false);
      expect(projectSearchPath(text)).toBeNull();
      expect(clientSearchPath("vp-1", text)).toBeNull();
    }
    const calls: string[] = [];
    expect(await searchDirectShareClients(async path => { calls.push(path); return {}; }, "vp-1", "a")).toBeNull();
    expect(calls).toEqual([]);
    expect(Object.fromEntries(new URL(projectSearchPath(" se ")!, "https://ops.test").searchParams)).toEqual({ limit: "10", q: "se" });
    expect(Object.fromEntries(new URL(clientSearchPath("vp-1", " Ha ")!, "https://ops.test").searchParams))
      .toEqual({ viewerProjectId: "vp-1", limit: "10", include: "clients", q: "Ha" });
  });

  it("bounds client results and says when more exist; never trusts a malformed page", async () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ ...client, workspaceId: `ws-${index}` }));
    const page = await searchDirectShareClients(async () => ({ clients: many, clientsNextCursor: null, grants: [] }), "vp-1", "Ha");
    expect(page!.clients).toHaveLength(QUICK_SHARE_RESULT_LIMIT);
    expect(page!.more).toBe(true);
    const few = await searchDirectShareClients(async () => ({ clients: [client], clientsNextCursor: null, grants: [] }), "vp-1", "Ha");
    expect(few).toEqual({ clients: [client], more: false });
    expect((await searchDirectShareClients(async () => ({ clients: [client], clientsNextCursor: "v1.x", grants: [] }), "vp-1", "Ha"))!.more).toBe(true);
    await expect(searchDirectShareClients(async () => ({ clients: [{ displayName: 1 }], grants: [] }), "vp-1", "Ha")).rejects.toThrow("invalid_response");
  });

  it("moves through results with the arrow, Home and End keys", () => {
    expect(nextActiveOption(-1, "ArrowDown", 3)).toBe(0);
    expect(nextActiveOption(0, "ArrowDown", 3)).toBe(1);
    expect(nextActiveOption(2, "ArrowDown", 3)).toBe(2);
    expect(nextActiveOption(-1, "ArrowUp", 3)).toBe(2);
    expect(nextActiveOption(1, "ArrowUp", 3)).toBe(0);
    expect(nextActiveOption(0, "ArrowUp", 3)).toBe(0);
    expect(nextActiveOption(1, "Home", 3)).toBe(0);
    expect(nextActiveOption(0, "End", 3)).toBe(2);
    expect(nextActiveOption(0, "ArrowDown", 0)).toBeNull();
    expect(nextActiveOption(0, "Enter", 3)).toBeNull();
  });

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

  it("builds only task shares and refuses whole projects", () => {
    expect(directShareBody({ project, task }, client, permissions, null)).toEqual({ sourceId: "project-alpha:primary",
      workspaceId: "ws-1", viewerProjectId: "vp-1", taskId: "task-1", scopeType: "task", includeFuturePublished: false,
      confirmedScope: true, expiresAt: null, permissions });
    expect(() => directShareBody({ project, task: null }, client, permissions, null)).toThrow("Share whole projects from the Viewer");
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

  it("does not infer model coverage from saved restricted project selections", () => {
    const base: DirectShareGrant = { ...client, grantId: "whole", viewerProjectId: project.viewerProjectId, taskId: null,
      scopeType: "project", includeFuturePublished: true, permissions, expiresAt: null, revokedAt: null,
      createdAt: "2026-10-20T12:00:00Z", clientDisplayName: client.displayName };
    const grants = [base, ...(["only", "except"] as const).map<DirectShareGrant>(mode => ({ ...base, grantId: mode,
      selection: { version: 1, mode, folderIds: ["00000000-0000-4000-8000-000000000001"], taskIds: [] } }))];
    expect(grantsForTarget(grants, { project, task }).map(grant => grant.grantId)).toEqual(["whole"]);
  });

  it("ends access at the close of the chosen Central-time day across daylight saving", () => {
    expect(chicagoEndOfDay("2026-12-31")).toBe("2027-01-01T05:59:59.000Z");
    expect(chicagoEndOfDay("2026-07-04")).toBe("2026-07-05T04:59:59.000Z");
    expect(chicagoEndOfDay("2026-03-08")).toBe("2026-03-09T04:59:59.000Z");
    expect(chicagoEndOfDay("2026-11-01")).toBe("2026-11-02T05:59:59.000Z");
    expect(chicagoEndOfDay("12/31/2026")).toBeNull();
  });
  it("allows today's Chicago date while its end of day is still ahead, never a day that has ended", () => {
    // 2026-10-27 22:00 in Chicago (CDT) is 2026-10-28 03:00Z: still Oct 27 there, though already Oct 28 in UTC.
    const lateEvening = Date.parse("2026-10-28T03:00:00Z");
    expect(chicagoToday(lateEvening)).toBe("2026-10-27");
    expect(futureChicagoEndOfDay("2026-10-27", lateEvening)).toBe("2026-10-28T04:59:59.000Z");
    expect(futureChicagoEndOfDay("2026-10-26", lateEvening)).toBeNull();
    expect(futureChicagoEndOfDay("2026-10-27", Date.parse("2026-10-28T04:59:59.000Z"))).toBeNull();
    expect(futureChicagoEndOfDay("not a day", lateEvening)).toBeNull();
  });

  it("offers public-link last days only between five minutes and 30 days ahead, in Central time", () => {
    const lateEvening = Date.parse("2026-10-28T03:00:00Z");
    expect(publicLinkDayRange(lateEvening)).toEqual({ min: "2026-10-27", max: "2026-11-25" });
    expect(publicLinkExpiry("2026-10-27", lateEvening)).toBe("2026-10-28T04:59:59.000Z");
    expect(publicLinkExpiry("2026-11-25", lateEvening)).toBe("2026-11-26T05:59:59.000Z");
    expect(publicLinkExpiry("2026-11-26", lateEvening)).toBeNull();
    expect(publicLinkExpiry("2026-10-26", lateEvening)).toBeNull();
    // Three minutes before Chicago midnight, today's end is too close; the first day offered is tomorrow.
    expect(publicLinkDayRange(Date.parse("2026-10-28T04:57:00Z")).min).toBe("2026-10-28");
  });

  it("starts a new public link on the latest allowed last day, 30 days out, on either side of a daylight-saving change", () => {
    for (const at of ["2026-10-28T03:00:00Z", "2026-11-01T05:30:00Z", "2026-02-20T18:00:00Z", "2026-03-08T07:59:00Z"]) {
      const now = Date.parse(at), end = Date.parse(publicLinkExpiry(defaultPublicLinkDay(now), now)!);
      expect(end).toBeLessThanOrEqual(now + 30 * 24 * 60 * 60 * 1000);
      expect(end).toBeGreaterThan(now + 28.9 * 24 * 60 * 60 * 1000);
    }
  });

  it("describes permissions and the business line in plain words", () => {
    expect(permissionSentence({ measure: false, cameras: false, download: false })).toBe("They can view the model.");
    expect(permissionSentence({ measure: true, cameras: false, download: false })).toBe("They can view the model and take measurements.");
    expect(permissionSentence({ measure: true, cameras: true, download: true }))
      .toBe("They can view the model, take measurements, see camera photos, and download files.");
    expect(businessLabel("Ledge Top", 1)).toBeNull();
    expect(businessLabel("LTDS", 2)).toBe("via Ledge Top LTDS");
    expect(businessLabel("Ledge Top Technologies", 2)).toBe("via Ledge Top Technologies");
  });
});
