import { describe, expect, it } from "vitest";
import { workspaceSwitcherLabels } from "../src/client/workspace-labels";

const labels = (workspaces: Array<{ id: string; displayName: string; sourceId?: string }>) => [...workspaceSwitcherLabels(workspaces).entries()];

describe("workspace switcher labels", () => {
  it("shows unique names alone and never exposes a source ID", () => {
    expect(labels([{ id: "a", displayName: "Acme", sourceId: "project-alpha:primary" }, { id: "b", displayName: "Coastal", sourceId: "project-alpha:coastal" }]))
      .toEqual([["a", "Acme"], ["b", "Coastal"]]);
  });
  it("adds the known business name to duplicate names", () => {
    expect(labels([{ id: "a", displayName: "Acme", sourceId: "project-alpha:primary" }, { id: "b", displayName: "Acme", sourceId: "project-alpha:secondary" }]))
      .toEqual([["a", "Acme — Ledge Top Drone Services"], ["b", "Acme — Ledge Top Technologies"]]);
  });
  it("uses neutral ordinals for unknown sources and repeated business names", () => {
    const result = labels([
      { id: "a", displayName: "Acme", sourceId: "project-alpha:staging" }, { id: "b", displayName: "Acme" },
      { id: "c", displayName: "Acme", sourceId: "project-alpha:primary" }, { id: "d", displayName: "Acme", sourceId: "project-alpha:primary" },
      { id: "e", displayName: "Acme", sourceId: "project-alpha:secondary" },
    ]);
    expect(result).toEqual([["a", "Acme (1)"], ["b", "Acme (2)"], ["c", "Acme — Ledge Top Drone Services (1)"],
      ["d", "Acme — Ledge Top Drone Services (2)"], ["e", "Acme — Ledge Top Technologies"]]);
    expect(result.map(([, label]) => label).join(" ")).not.toMatch(/project-alpha|staging/);
  });
});
