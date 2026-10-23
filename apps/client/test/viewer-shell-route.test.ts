import { afterEach, describe, expect, it, vi } from "vitest";
import { openViewerShell, validateViewerSessionModel } from "@ltds/ui";
import { clientViewerShellPath, nativeClientViewerShellPath, parseClientViewerShellRoute } from "../src/client/ClientViewerShell";

afterEach(() => vi.unstubAllGlobals());

describe("client Viewer shell", () => {
  it("round trips only opaque routing identifiers", () => {
    const route = { projectId: "project-one", associationId: "association_one", modelId: "model-1" };
    expect(parseClientViewerShellRoute(clientViewerShellPath(route))).toEqual({mode: "legacy", ...route});
    expect(parseClientViewerShellRoute("/portal/viewer/project/association/model%2Fescape")).toBeNull();
    expect(parseClientViewerShellRoute("/portal/viewer/project/association")).toBeNull();
  });

  it("round-trips an exact native workspace route without placing authority or secrets in the URL", () => {
    const route = {workspaceId: "workspace-one", projectId: "project one", associationId: "association-one", modelId: "model-one"};
    const path = nativeClientViewerShellPath(route);
    expect(path).toBe("/portal/viewer/native/workspace-one/project%20one/association-one/model-one");
    expect(parseClientViewerShellRoute(path)).toEqual({mode: "native", ...route});
    expect(path).not.toContain("context");
    expect(path).not.toContain("grant");
  });

  it("opens models in the current tab without creating a popup", () => {
    const assign = vi.fn(), open = vi.fn();
    vi.stubGlobal("window", { location: { origin: "https://portal.example.test", assign }, open });
    expect(openViewerShell("/portal/viewer/project/association/model")).toBe("same-tab");
    expect(assign).toHaveBeenCalledWith("https://portal.example.test/portal/viewer/project/association/model");
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin shell destination", () => {
    vi.stubGlobal("window", { location: { origin: "https://portal.example.test" }, open: vi.fn() });
    expect(() => openViewerShell("https://attacker.example/viewer")).toThrow("current application origin");
  });

  it("fails closed when a session carrying model identity disagrees with the route", () => {
    const session = {
      grant: "grant", grantExpiresAt: "2026-09-06T00:00:00.000Z", sessionTtlSeconds: 60,
      redeemUrl: "https://viewer.example.test/redeem", embedUrl: "https://viewer.example.test/session/grant",
      modelId: "model-two",
    };
    expect(() => validateViewerSessionModel(session, "model-one")).toThrow("does not match");
    expect(validateViewerSessionModel(session, "model-two")).toBe(session);
  });

  it("fails closed when a session omits model identity", () => {
    const session = {
      grant: "grant", grantExpiresAt: "2026-09-06T00:00:00.000Z", sessionTtlSeconds: 60,
      redeemUrl: "https://viewer.example.test/redeem", embedUrl: "https://viewer.example.test/session/grant",
    };
    expect(() => validateViewerSessionModel(session, "model-one")).toThrow("does not match");
  });
});
