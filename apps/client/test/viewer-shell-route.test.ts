import { afterEach, describe, expect, it, vi } from "vitest";
import { openViewerShell } from "@ltds/ui";
import { clientViewerShellPath, parseClientViewerShellRoute } from "../src/client/ClientViewerShell";

afterEach(() => vi.unstubAllGlobals());

describe("client Viewer shell", () => {
  it("round trips only opaque routing identifiers", () => {
    const route = { projectId: "project-one", associationId: "association_one", modelId: "model-1" };
    expect(parseClientViewerShellRoute(clientViewerShellPath(route))).toEqual(route);
    expect(parseClientViewerShellRoute("/portal/viewer/project/association/model%2Fescape")).toBeNull();
    expect(parseClientViewerShellRoute("/portal/viewer/project/association")).toBeNull();
  });

  it("detaches the blank window before same-origin navigation", () => {
    const replace = vi.fn();
    const popup = { opener: {} as unknown, location: { replace }, close: vi.fn() };
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { origin: "https://portal.example.test", assign }, open: vi.fn(() => popup) });
    expect(openViewerShell("/portal/viewer/project/association/model")).toBe("new-tab");
    expect(popup.opener).toBeNull();
    expect(replace).toHaveBeenCalledWith("https://portal.example.test/portal/viewer/project/association/model");
    expect(assign).not.toHaveBeenCalled();
  });

  it("falls back to the current tab when the popup is blocked", () => {
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { origin: "https://portal.example.test", assign }, open: vi.fn(() => null) });
    expect(openViewerShell("/portal/viewer/project/association/model")).toBe("same-tab");
    expect(assign).toHaveBeenCalledWith("https://portal.example.test/portal/viewer/project/association/model");
  });

  it("rejects a cross-origin shell destination", () => {
    vi.stubGlobal("window", { location: { origin: "https://portal.example.test" }, open: vi.fn() });
    expect(() => openViewerShell("https://attacker.example/viewer")).toThrow("current application origin");
  });
});
