import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { loadNativeViewerWork, type NativeViewerWorkItem } from "../src/client/native-portal-api";
import { sharedViewerGroups, sharedViewerHasFolders, sharedViewerRows } from "../src/client/shared-viewer-work";
import { SharedViewerGroupedList } from "../src/client/SharedViewerWork";

function item(overrides: Partial<NativeViewerWorkItem> = {}): NativeViewerWorkItem {
  return { grantId: "grant-project", workspaceId: "workspace-b", taskId: "task-1", scopeType: "project", title: "Synthetic task",
    projectName: "Synthetic project", businessName: "Synthetic business", sharedAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-02T00:00:00Z",
    expiresAt: null, permissions: { measure: true, cameras: false, download: false }, ...overrides };
}
const page = (items: unknown[]) => ({ workspaceId: "workspace-b", contextVersion: "context-1", items, nextCursor: null });
const load = (items: unknown[]) => loadNativeViewerWork("workspace-b", null, undefined, (async () => page(items)) as never);
const outer = { id: "folder-outer", name: "Synthetic outer" }, inner = { id: "folder-inner", name: "Synthetic inner" };
const render = (rows: NativeViewerWorkItem[]) => renderToStaticMarkup(createElement(SharedViewerGroupedList,
  { groups: sharedViewerGroups(rows), idPrefix: "t", renderTask: row => createElement("li", { key: row.taskId }, row.taskId) }));

describe("shared 3D work folder grouping", () => {
  it("keeps the flat list for older responses without folder paths", async () => {
    const rows = sharedViewerRows((await load([item(), item({ taskId: "task-2" })])).items);
    expect(sharedViewerHasFolders(rows)).toBe(false);
    expect(sharedViewerHasFolders([...rows, item({ taskId: "task-3", folderPath: [] })])).toBe(true);
  });
  it("shows a nested task under its full path, folders before tasks, siblings ordered like staff", () => {
    const rows = [item({ taskId: "root", folderPath: [] }), item({ taskId: "deep", folderPath: [outer, inner] }),
      item({ taskId: "zeta", folderPath: [{ id: "folder-z", name: "zeta" }] }), item({ taskId: "alpha", folderPath: [{ id: "folder-a", name: "Alpha" }] }),
      item({ taskId: "beta", folderPath: [{ id: "folder-b", name: "beta" }] })];
    const [project] = sharedViewerGroups(rows);
    expect(project!.tasks.map(row => row.taskId)).toEqual(["root"]);
    expect(project!.folders.map(folder => folder.name)).toEqual(["Alpha", "beta", "Synthetic outer", "zeta"]);
    const outerGroup = project!.folders.find(folder => folder.id === outer.id)!;
    expect(outerGroup.tasks).toEqual([]);
    expect(outerGroup.folders[0]!.name).toBe("Synthetic inner");
    expect(outerGroup.folders[0]!.tasks.map(row => row.taskId)).toEqual(["deep"]);
    const html = render(rows);
    expect(html.indexOf("Synthetic outer")).toBeLessThan(html.indexOf("Synthetic inner"));
    expect(html.indexOf("Synthetic inner")).toBeLessThan(html.indexOf(">root<"));
    expect(html).toContain('role="heading" aria-level="5"');
  });
  it("moving a task changes only its heading, not the row", () => {
    const before = item({ folderPath: [outer] }), after = item({ folderPath: [{ id: "folder-other", name: "Synthetic other" }] });
    const { folderPath: _a, ...left } = before, { folderPath: _b, ...right } = after;
    expect(left).toEqual(right);
    expect(render([before])).toContain("Synthetic outer");
    expect(render([after])).not.toContain("Synthetic outer");
    expect(render([after])).toContain("Synthetic other");
  });
  it("keeps projects apart: one project's folders never appear under another", () => {
    const groups = sharedViewerGroups([item({ taskId: "a", projectName: "Synthetic A", folderPath: [outer] }),
      item({ taskId: "b", projectName: "Synthetic B", workspaceId: "workspace-c", businessName: "Other business", folderPath: [] })]);
    expect(groups.map(group => [group.projectName, group.folders.map(folder => folder.name)])).toEqual([["Synthetic A", ["Synthetic outer"]], ["Synthetic B", []]]);
  });
  it("regroups after each page: later pages join existing folders", () => {
    const first = [item({ taskId: "one", folderPath: [outer] })], second = [item({ taskId: "two", folderPath: [outer, inner] })];
    expect(sharedViewerGroups(first)[0]!.folders[0]!.folders).toEqual([]);
    const both = sharedViewerGroups(sharedViewerRows([...first, ...second]))[0]!.folders;
    expect(both).toHaveLength(1);
    expect(both[0]!.tasks.map(row => row.taskId)).toEqual(["one"]);
    expect(both[0]!.folders[0]!.tasks.map(row => row.taskId)).toEqual(["two"]);
  });
  it("renders folder and project names as text, never HTML", () => {
    const html = render([item({ projectName: "<img src=x onerror=alert(1)>", folderPath: [{ id: "folder-x", name: "<script>alert(1)</script>" }] })]);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
  it("rejects a malformed folder path instead of rendering it", async () => {
    for (const folderPath of [null, "folder", [{ id: "a" }], [{ id: "a", name: "b", extra: 1 }], [{ id: "../a", name: "b" }],
      [{ id: "a", name: "" }], [{ id: "a", name: "x".repeat(161) }], [{ id: "a", name: "b\u0007" }], [outer, outer],
      Array.from({ length: 17 }, (_, index) => ({ id: `f${index}`, name: `F${index}` }))])
      await expect(load([{ ...item(), folderPath }])).rejects.toThrow();
    await expect(load([{ ...item(), folderPath: [outer, inner] }])).resolves.toMatchObject({ items: [{ folderPath: [outer, inner] }] });
  });
});
