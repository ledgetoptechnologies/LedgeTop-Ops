import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const mocks = vi.hoisted(() => ({
  syncProjectAlpha: vi.fn(),
  reconcilePrimary: vi.fn(),
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
  reconcilePrimaryClientPortalWorkspaces: mocks.reconcilePrimary,
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
    mocks.reconcilePrimary.mockReset().mockResolvedValue({
      enabled: true, scanned: 2, eligible: 1, projected: 1, unchanged: 0,
      skippedUnlinked: 1, skippedAmbiguous: 0, skippedNoMember: 0,
      skippedInactive: 0, skippedManualReview: 0, skippedAlreadyProjected: 0,
      conflicts: 0, truncated: false,
    });
    mocks.rebuildAirspace.mockReset().mockResolvedValue(undefined);
    vi.restoreAllMocks();
  });

  it("runs aggregate-only reconciliation after a successful primary sync", async () => {
    mocks.syncProjectAlpha.mockResolvedValue({
      status: "success", records: 4, changedCollections: ["operations"],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(runScheduledPrimaryProjectAlphaSync(env)).resolves.toMatchObject({ status: "success" });
    expect(mocks.reconcilePrimary).toHaveBeenCalledExactlyOnceWith(env);
    expect(mocks.rebuildAirspace).toHaveBeenCalledExactlyOnceWith(env);
    expect(log).toHaveBeenCalledWith(JSON.stringify({
      event: "client_portal.primary_workspace_reconciliation",
      enabled: true, scanned: 2, eligible: 1, projected: 1, unchanged: 0,
      skippedUnlinked: 1, skippedAmbiguous: 0, skippedNoMember: 0,
      skippedInactive: 0, skippedManualReview: 0, skippedAlreadyProjected: 0,
      conflicts: 0, truncated: false,
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
    expect(mocks.reconcilePrimary).not.toHaveBeenCalled();
    expect(mocks.rebuildAirspace).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
