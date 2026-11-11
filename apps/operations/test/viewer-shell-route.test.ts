import { describe, expect, it } from "vitest";
import { operationsViewerShellPath, operationsViewerShellRouteKey, parseOperationsViewerShellRoute } from "../src/client/OperationsViewerShell";

describe("Operations Viewer shell route", () => {
  it("round trips exact opaque association and model identifiers", () => {
    const route = { associationId: "association-one", modelId: "model_one" };
    expect(parseOperationsViewerShellRoute(operationsViewerShellPath(route))).toEqual(route);
  });

  it("round trips the exact native target in the query", () => {
    const native = { sourceId: "project-alpha:secondary", workspaceId: "workspace-1", projectPublicId: "PA 7/2026", projectId: "project-7",
      generationId: "generation-3", sourceVersion: "2026-10-19T00:00:00.000Z" };
    const route = { associationId: "association-7", modelId: "model-7", native };
    const path = operationsViewerShellPath(route), [pathname, search] = path.split("?");
    expect(pathname).toBe("/viewer/session/native/association-7/model-7");
    expect(parseOperationsViewerShellRoute(pathname!, `?${search}`)).toEqual(route);
  });

  it("keeps native target field boundaries in the shell identity", () => {
    const shared = { sourceId: "project-alpha:primary", workspaceId: "workspace-1", projectId: "project-1", generationId: "generation-1" };
    const first = { ...shared, projectPublicId: "public:a", sourceVersion: "b" };
    const second = { ...shared, projectPublicId: "public", sourceVersion: "a:b" };
    const route = (native: typeof first) => ({ associationId: "association-1", modelId: "model-1", native });

    expect(operationsViewerShellRouteKey(route(first))).not.toBe(operationsViewerShellRouteKey(route(second)));
    expect(operationsViewerShellRouteKey({ associationId: "association-1", modelId: "model-1" }))
      .not.toBe(operationsViewerShellRouteKey(route(first)));
  });

  it("refuses a native route with a missing, repeated, extra or invalid target field", () => {
    const query = new URLSearchParams({ sourceId: "project-alpha:primary", workspaceId: "w", projectPublicId: "p", projectId: "p1", generationId: "g", sourceVersion: "v" });
    const path = "/viewer/session/native/association-7/model-7";
    expect(parseOperationsViewerShellRoute(path, `?${query}`)).not.toBeNull();
    for (const mutate of [(q: URLSearchParams) => q.delete("generationId"), (q: URLSearchParams) => q.append("workspaceId", "other"),
      (q: URLSearchParams) => q.set("extra", "1"), (q: URLSearchParams) => q.set("sourceId", "legacy:primary"), (q: URLSearchParams) => q.set("projectId", "../x")]) {
      const changed = new URLSearchParams(query); mutate(changed);
      expect(parseOperationsViewerShellRoute(path, `?${changed}`)).toBeNull();
    }
    expect(parseOperationsViewerShellRoute(path)).toBeNull();
    // The legacy two-segment form is unchanged and never picks up a native target.
    expect(parseOperationsViewerShellRoute("/viewer/session/association-7/model-7", `?${query}`)).toEqual({ associationId: "association-7", modelId: "model-7" });
  });

  it("fails closed for malformed or extra route segments", () => {
    expect(parseOperationsViewerShellRoute("/viewer/session/association/model/extra")).toBeNull();
    expect(parseOperationsViewerShellRoute("/viewer/session/association/model%2Fescape")).toBeNull();
    expect(parseOperationsViewerShellRoute("/viewer/session//model")).toBeNull();
  });
});
