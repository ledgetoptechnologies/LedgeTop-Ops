import { describe, expect, it } from "vitest";
import { loadUnifiedAccount, showsClientName, unifiedAccount, unifiedAccountSupported } from "../src/client/unified-portal";
import type { PortalWorkspace } from "../src/client/portal-api";

const legacy: PortalWorkspace = { id: "workspace-a", rootType: "organization", rootPublicId: "org-a", displayName: "Acme" };
const secondary: PortalWorkspace = { id: "workspace-b", rootType: "organization", rootPublicId: "org-b", displayName: "Acme", resourceMode: "native", sourceId: "project-alpha:secondary" };

describe("unified client portal", () => {
  it("labels accounts with business names only, never raw or unknown sources", () => {
    expect(unifiedAccount(legacy).business).toBe("Ledge Top Drone Services");
    expect(unifiedAccount(secondary).business).toBe("Ledge Top Technologies");
    expect(unifiedAccount({ ...secondary, sourceId: "project-alpha:staging" }).business).toBe("Ledge Top");
  });
  it("keeps the rule that a non-primary source must be native", () => {
    expect(unifiedAccountSupported(legacy)).toBe(true);
    expect(unifiedAccountSupported(secondary)).toBe(true);
    expect(unifiedAccountSupported({ ...legacy, sourceId: "project-alpha:secondary" })).toBe(false);
  });
  it("shows client names only when a person spans several clients of a business", () => {
    expect(showsClientName([unifiedAccount(legacy), unifiedAccount(secondary)])).toBe(false);
    expect(showsClientName([unifiedAccount(legacy), unifiedAccount({ ...legacy, id: "workspace-c", displayName: "Beta" })])).toBe(true);
  });
  it("reads a legacy account with that account's explicit scope and tags every item with it", async () => {
    const seen: Array<{ url: string; workspaceId?: string }> = [];
    const request = (async (url: string, init?: { workspaceId?: string }) => {
      seen.push({ url, workspaceId: init?.workspaceId });
      if (url === "/api/client/session") return { capabilities: { requestV2: true } };
      if (url === "/api/client/projects") return { projects: [{ id: "p1", projectName: "North Site", status: "active", lastUpdateAt: null, canRequestService: true }] };
      return { requests: [{ id: "r1", projectId: "p1", title: "Survey", status: "submitted", updatedAt: "2026-10-18T00:00:00Z" }] };
    }) as never;
    const result = await loadUnifiedAccount(unifiedAccount(legacy), new AbortController().signal, request);
    expect(seen.every(call => call.workspaceId === "workspace-a")).toBe(true);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.projects.map(item => [item.key, item.account.workspace.id])).toEqual([["workspace-a\u0000p1", "workspace-a"]]);
    expect(result.requests[0]?.projectName).toBe("North Site");
    expect(result.canRequest).toBe(true);
  });
  it("reports one failed account without throwing so the others still render", async () => {
    const request = (async () => { throw Object.assign(new Error("Unavailable"), { status: 503 }); }) as never;
    const result = await loadUnifiedAccount(unifiedAccount(legacy), new AbortController().signal, request);
    expect(result).toMatchObject({ status: "error", message: "Unavailable" });
  });
});
