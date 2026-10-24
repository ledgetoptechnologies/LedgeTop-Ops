import { describe, expect, it } from "vitest";
import { loadNativeViewerWork, openNativeViewerTaskSession, type NativeViewerWorkItem } from "../src/client/native-portal-api";
import { directViewerTaskPath, sharedViewerRows, showsBusinessName, viewerWorkAccounts } from "../src/client/shared-viewer-work";
import { parseClientViewerShellRoute, directClientViewerShellPath, clientViewerShellPath } from "../src/client/ClientViewerShell";
import type { PortalWorkspace } from "../src/client/portal-api";

function item(overrides: Partial<NativeViewerWorkItem> = {}): NativeViewerWorkItem {
  return { grantId: "grant-project", workspaceId: "workspace-b", taskId: "task-1", scopeType: "project", title: "North elevation scan",
    projectName: "Harbor bridge", businessName: "Coastal Surveying", sharedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
    expiresAt: null, permissions: { measure: true, cameras: false, download: false }, ...overrides };
}
const page = (items: unknown[], nextCursor: string | null = null, workspaceId = "workspace-b") => ({ workspaceId, contextVersion: "context-1", items, nextCursor });
const session = { grant: "g", grantExpiresAt: "2026-10-23T01:00:00Z", sessionTtlSeconds: 600, redeemUrl: "https://viewer.example.test/redeem", embedUrl: "https://viewer.example.test/s/g", modelId: "model-1" };

describe("shared 3D work rows", () => {
  it("shows one row per account and task, opening with the exact task grant and its own permissions", () => {
    const project = item(), task = item({ grantId: "grant-task", scopeType: "task", updatedAt: "2026-09-01T00:00:00Z", permissions: { measure: false, cameras: true, download: true } });
    const rows = sharedViewerRows([project, task, item({ taskId: "task-2", updatedAt: "2026-10-05T00:00:00Z" })]);
    expect(rows.map(row => [row.taskId, row.grantId])).toEqual([["task-2", "grant-project"], ["task-1", "grant-task"]]);
    expect(rows[1]!.permissions).toEqual(task.permissions);
    expect(sharedViewerRows([task, project])[0]!.grantId).toBe("grant-task");
  });
  it("never merges the same task across different client accounts", () => {
    const rows = sharedViewerRows([item(), item({ workspaceId: "workspace-c", grantId: "grant-c", businessName: "Mountain Engineering" })]);
    expect(rows).toHaveLength(2);
    expect(showsBusinessName(rows)).toBe(true);
    expect(showsBusinessName([item(), item({ taskId: "task-2" }), item({ taskId: "task-3", businessName: null })])).toBe(false);
  });
  it("only uses native accounts, once each", () => {
    const native: PortalWorkspace = { id: "workspace-b", rootType: "organization", rootPublicId: "org", displayName: "Internal test label", resourceMode: "native", sourceId: "project-alpha:secondary" };
    const legacy: PortalWorkspace = { id: "workspace-a", rootType: "organization", rootPublicId: "org", displayName: "Legacy" };
    expect(viewerWorkAccounts([legacy, native, native]).map(workspace => workspace.id)).toEqual(["workspace-b"]);
  });
  it("routes a direct task with its account pinned in the query, distinct from legacy model routes", () => {
    const path = directViewerTaskPath(item({ grantId: "grant-task", taskId: "task-1" }));
    expect(path).toBe("/portal/viewer/grant-task/tasks/task-1?workspace=workspace-b");
    expect(directClientViewerShellPath({ workspaceId: "workspace-b", grantId: "grant-task", taskId: "task-1" })).toBe(path);
    const url = new URL(path, "https://portal.example.test");
    expect(parseClientViewerShellRoute(url.pathname, url.search)).toEqual({ mode: "direct", workspaceId: "workspace-b", grantId: "grant-task", taskId: "task-1" });
    expect(parseClientViewerShellRoute(url.pathname, "")).toBeNull();
    expect(parseClientViewerShellRoute(url.pathname, "?workspace=bad%2Fid")).toBeNull();
    expect(parseClientViewerShellRoute("/portal/viewer/grant/tasks/task%2Fescape", "?workspace=workspace-b")).toBeNull();
    const legacy = clientViewerShellPath({ projectId: "project-one", associationId: "association-one", modelId: "model-one" });
    expect(parseClientViewerShellRoute(legacy, "?workspace=workspace-b")?.mode).toBe("legacy");
  });
});

describe("shared 3D work API", () => {
  it("sends the cursor back only to the account that issued it and validates every item", async () => {
    const seen: string[] = [];
    const request = (async (url: string) => { seen.push(url); return page([item()], "next"); }) as never;
    await expect(loadNativeViewerWork("workspace-b", null, undefined, request)).resolves.toMatchObject({ nextCursor: "next" });
    await loadNativeViewerWork("workspace-b", "opaque/cursor", undefined, (async (url: string) => { seen.push(url); return page([], "after"); }) as never);
    expect(seen).toEqual(["/api/client/v2/workspaces/workspace-b/viewer", "/api/client/v2/workspaces/workspace-b/viewer?cursor=opaque%2Fcursor"]);
  });
  it("accepts an empty page that still has more to load", async () => {
    await expect(loadNativeViewerWork("workspace-b", null, undefined, (async () => page([], "more")) as never)).resolves.toMatchObject({ items: [], nextCursor: "more" });
  });
  it.each([
    ["a different account", page([item()], null, "workspace-c")],
    ["an item from another account", page([item({ workspaceId: "workspace-c" })])],
    ["a non-array item list", { ...page([]), items: {} }],
    ["an unknown scope", page([{ ...item(), scopeType: "folder" }])],
    ["a missing title", page([{ ...item(), title: "" }])],
    ["a non-string project name", page([{ ...item(), projectName: 4 }])],
    ["an invalid date", page([{ ...item(), updatedAt: "soon" }])],
    ["unsafe grant id", page([{ ...item(), grantId: "../x" }])],
    ["missing permissions", page([{ ...item(), permissions: undefined }])],
    ["a non-string cursor", { ...page([]), nextCursor: 5 }],
  ])("rejects %s", async (_label, value) => {
    await expect(loadNativeViewerWork("workspace-b", null, undefined, (async () => value) as never)).rejects.toMatchObject({ status: 409 });
  });
  it("rejects a cursor that does not advance", async () => {
    await expect(loadNativeViewerWork("workspace-b", "same", undefined, (async () => page([], "same")) as never)).rejects.toMatchObject({ status: 409 });
  });
  it("posts the exact task session with its idempotency key and units", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const request = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return session; }) as never;
    await expect(openNativeViewerTaskSession("workspace-b", "grant-task", "task-1", "metric", "key-1", undefined, request)).resolves.toEqual(session);
    expect(seen[0]!.url).toBe("/api/client/v2/workspaces/workspace-b/viewer/grant-task/tasks/task-1/session");
    expect(seen[0]!.init.method).toBe("POST");
    expect(new Headers(seen[0]!.init.headers).get("Idempotency-Key")).toBe("key-1");
    expect(JSON.parse(String(seen[0]!.init.body))).toEqual({ displayUnits: "metric" });
  });
  it("rejects a session without a model identity", async () => {
    await expect(openNativeViewerTaskSession("workspace-b", "grant-task", "task-1", "imperial", "key-1", undefined,
      (async () => ({ ...session, modelId: undefined })) as never)).rejects.toMatchObject({ status: 409 });
  });
});
