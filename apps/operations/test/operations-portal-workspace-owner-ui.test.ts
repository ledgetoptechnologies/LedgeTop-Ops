import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationsPortalWorkspaceOwner, prepareOperationsWorkspaceRefreshRequest }
  from "../src/client/OperationsPortalWorkspaceOwner";

const targetId = "11111111-1111-4111-8111-111111111111";

afterEach(() => vi.restoreAllMocks());

describe("operations portal workspace owner refresh control", () => {
  it("renders an explicit topology-only refresh control with a positive publication revision", () => {
    const html = renderToStaticMarkup(createElement(OperationsPortalWorkspaceOwner));
    expect(html).toContain("Refresh and publish current workspace topology");
    expect(html).toContain("does not grant or revoke a folder or recipient");
    expect(html).toContain('name="refreshPublicationRevision"');
    expect(html).toContain('min="1"');
  });

  it("retains every generated publication ID for an exact retry and rejects changed retry inputs", () => {
    const values = [
      "20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002",
      "20000000-0000-4000-8000-000000000003", "20000000-0000-4000-8000-000000000004",
      "20000000-0000-4000-8000-000000000005",
    ];
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockImplementation(() => values.shift() as `${string}-${string}-${string}-${string}-${string}`);
    const first = prepareOperationsWorkspaceRefreshRequest(null, targetId, 4, "Refresh current membership");
    const replay = prepareOperationsWorkspaceRefreshRequest(first, targetId, 4, "Refresh current membership");
    expect(replay).toBe(first); expect(randomUUID).toHaveBeenCalledTimes(5);
    expect(Object.values(first.publication).slice(0, 5)).toEqual([
      "20000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000002",
      "20000000-0000-4000-8000-000000000003", "20000000-0000-4000-8000-000000000004",
      "20000000-0000-4000-8000-000000000005",
    ]);
    expect(() => prepareOperationsWorkspaceRefreshRequest(first, targetId, 5, "Refresh current membership"))
      .toThrow("Discard the retained refresh request");
    expect(() => prepareOperationsWorkspaceRefreshRequest(first, targetId, 4, "Changed reason"))
      .toThrow("Discard the retained refresh request");
  });
});
