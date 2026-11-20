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
      [{ id: "a", name: 7 }], [{ id: "a", name: "x".repeat(4097) }], [outer, outer],
      Array.from({ length: 17 }, (_, index) => ({ id: `f${index}`, name: `F${index}` }))])
      await expect(load([{ ...item(), folderPath }])).rejects.toThrow();
    for (const projectKey of ["short", "has space in it here", 7])
      await expect(load([{ ...item(), projectKey }])).rejects.toThrow();
    await expect(load([{ ...item(), folderPath: [outer, inner] }])).resolves.toMatchObject({ items: [{ folderPath: [outer, inner] }] });
  });
  it("neutralizes one legacy folder name (DEL, control characters) and still renders the rest of the page", async () => {
    const result = await load([{ ...item({ taskId: "legacy" }), folderPath: [outer, { id: "folder-del", name: "Old\u007fname\u0007\n" }, { id: "folder-blank", name: "\u007f" }] },
      item({ taskId: "other", folderPath: [inner] })]);
    expect(result.items.map(row => row.folderPath)).toEqual([
      [outer, { id: "folder-del", name: "Oldname" }, { id: "folder-blank", name: "Untitled folder" }], [inner]]);
    const html = render(sharedViewerRows(result.items));
    expect(html).toContain(">legacy<");
    expect(html).toContain(">other<");
    expect(html).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
  });
  it("keeps two different projects with the same names as two groups, keyed per account", () => {
    const rows = [item({ taskId: "a", projectKey: "k".repeat(43), folderPath: [] }), item({ taskId: "b", projectKey: "j".repeat(43), folderPath: [] })];
    const groups = sharedViewerGroups(rows);
    expect(groups).toHaveLength(2);
    expect(groups.map(group => group.projectName)).toEqual(["Synthetic project", "Synthetic project"]);
    expect(groups.map(group => group.tasks.map(row => row.taskId))).toEqual([["a"], ["b"]]);
    // The same key from another account is a different group: keys never join accounts.
    expect(sharedViewerGroups([rows[0]!, { ...rows[0]!, taskId: "c", workspaceId: "workspace-c" }])).toHaveLength(2);
    expect(render(rows)).not.toContain("k".repeat(43));
  });
});
