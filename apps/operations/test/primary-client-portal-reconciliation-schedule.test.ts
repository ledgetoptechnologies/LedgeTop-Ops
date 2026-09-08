import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const mocks = vi.hoisted(() => ({
  syncProjectAlpha: vi.fn(),
  reconcileWorkspaces: vi.fn(),
  rebuildAirspace: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/project-alpha", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/project-alpha")>(),
  syncProjectAlpha: mocks.syncProjectAlpha,
}));
vi.mock("../src/worker/client-account-root-activation", () => ({
  activateClientAccountRoot: vi.fn(),
  listClientAccountRootActivation: vi.fn(),
}));
vi.mock("../src/worker/client-portal-workspace-reconciliation", () => ({
  reconcileClientPortalWorkspaces: mocks.reconcileWorkspaces,
}));
vi.mock("../src/worker/airspace", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/airspace")>(),
  rebuildOperationAirspaceMatches: mocks.rebuildAirspace,
}));

import { runScheduledPrimaryProjectAlphaSync } from "../src/worker/index";

describe("scheduled primary Project Alpha workspace reconciliation", () => {
  const env = {} as Env;

  beforeEach(() => {
    mocks.syncProjectAlpha.mockReset();
    mocks.reconcileWorkspaces.mockReset().mockResolvedValue({ enabled: true, sources: [] });
    mocks.rebuildAirspace.mockReset().mockResolvedValue(undefined);
    vi.restoreAllMocks();
  });

  it("runs aggregate-only reconciliation after a successful primary sync", async () => {
    mocks.syncProjectAlpha.mockResolvedValue({
      status: "success", records: 4, changedCollections: ["operations"],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(runScheduledPrimaryProjectAlphaSync(env)).resolves.toMatchObject({ status: "success" });
    expect(mocks.reconcileWorkspaces).toHaveBeenCalledExactlyOnceWith(env, "project-alpha:primary");
    expect(mocks.rebuildAirspace).toHaveBeenCalledExactlyOnceWith(env);
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      event: "client_portal.workspace_reconciliation",
      enabled: true, sources: [],
    }));
  });

  it("does no Delivery reconciliation when the scheduled primary sync is disabled", async () => {
    mocks.syncProjectAlpha.mockResolvedValue({
      status: "disabled", records: 0, changedCollections: [],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(runScheduledPrimaryProjectAlphaSync(env)).resolves.toEqual({
      status: "disabled", records: 0, changedCollections: [],
    });
    expect(mocks.reconcileWorkspaces).not.toHaveBeenCalled();
    expect(mocks.rebuildAirspace).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
