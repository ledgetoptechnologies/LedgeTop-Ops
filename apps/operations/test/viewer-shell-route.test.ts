import { describe, expect, it } from "vitest";
import { operationsViewerShellPath, parseOperationsViewerShellRoute } from "../src/client/OperationsViewerShell";

describe("Operations Viewer shell route", () => {
  it("round trips exact opaque association and model identifiers", () => {
    const route = { associationId: "association-one", modelId: "model_one" };
    expect(parseOperationsViewerShellRoute(operationsViewerShellPath(route))).toEqual(route);
  });

  it("fails closed for malformed or extra route segments", () => {
    expect(parseOperationsViewerShellRoute("/viewer/session/association/model/extra")).toBeNull();
    expect(parseOperationsViewerShellRoute("/viewer/session/association/model%2Fescape")).toBeNull();
    expect(parseOperationsViewerShellRoute("/viewer/session//model")).toBeNull();
  });
});
