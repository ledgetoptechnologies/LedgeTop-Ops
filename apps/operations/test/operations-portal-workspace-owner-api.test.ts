import { afterEach, describe, expect, it, vi } from "vitest";
import {
  confirmOperationsProjectFolder,
  lookupOperationsProjectFolder,
  operationsWorkspaceCsrf,
  refreshAndPublishOperationsWorkspace,
} from "../src/client/operations-portal-workspace-owner-api";
import type {
  ConfirmOperationsPortalSharedProjectFolder,
  OperationsPortalSharedProjectFolder,
} from "../src/worker/operations-portal-shared-project-folders";

const targetId = "11111111-1111-4111-8111-111111111111";
const externalProjectId = "project:alpha/flight 42";
const csrfToken = "csrf-token-from-authorized-session";
const association = {
  opsFolderProjectId: externalProjectId,
  opsDivisionId: "division:operations",
  baseR2Prefix: "operations/projects/alpha/",
  baseMatchMethod: "manual" as const,
  baseConfirmedBy: "staff:owner",
  baseConfirmedAt: "2026-10-02T18:00:00.000Z",
};
const proof: OperationsPortalSharedProjectFolder = {
  targetId,
  externalProjectId,
  projectName: "Flight 42",
  projectVersion: 7,
  association,
};
const confirmation: ConfirmOperationsPortalSharedProjectFolder = {
  targetId,
  externalProjectId,
  expectedProjectVersion: 7,
  expectedAssociation: null,
  opsDivisionId: association.opsDivisionId,
  baseR2Prefix: association.baseR2Prefix,
};

function json(value: unknown, status = 200) {
  const mocked = vi.fn().mockResolvedValue(Response.json(value, { status }));
  vi.stubGlobal("fetch", mocked);
  return mocked;
}

afterEach(() => vi.unstubAllGlobals());

describe("operations portal workspace owner project-folder API", () => {
  it("performs an authorized no-store lookup and returns only the exactly correlated folder proof", async () => {
    const fetch = json({ ...proof, ignoredServerField: "not part of the proof",
      association: { ...association, ignoredAssociationField: "not part of the proof" } });

    await expect(lookupOperationsProjectFolder(targetId, externalProjectId)).resolves.toEqual(proof);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(`/api/native-client-portal/operations-workspaces/project-folder?${new URLSearchParams({
      targetId, externalProjectId,
    })}`);
    expect(init).toEqual({ credentials: "same-origin", cache: "no-store" });
  });

  it("accepts an authorized lookup with no existing association", async () => {
    json({ ...proof, association: null });
    await expect(lookupOperationsProjectFolder(targetId, externalProjectId)).resolves.toEqual({
      ...proof,
      association: null,
    });
  });

  it("denies malformed associations, invalid versions, and mismatched response targets", async () => {
    const invalid = [
      { ...proof, projectVersion: 0 },
      { ...proof, projectVersion: 1.5 },
      { ...proof, projectVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...proof, targetId: "22222222-2222-4222-8222-222222222222" },
      { ...proof, externalProjectId: "project:other" },
      { ...proof, association: { ...association, opsFolderProjectId: 3 } },
      { ...proof, association: { ...association, opsDivisionId: null } },
      { ...proof, association: { ...association, baseR2Prefix: false } },
      { ...proof, association: { ...association, baseMatchMethod: "guessed" } },
      { ...proof, association: { ...association, baseConfirmedBy: undefined } },
      { ...proof, association: { ...association, baseConfirmedAt: 123 } },
    ];
    for (const body of invalid) {
      json(body);
      await expect(lookupOperationsProjectFolder(targetId, externalProjectId)).rejects.toThrow("invalid_response");
    }
  });

  it("sends confirmation over the exact same-origin CSRF transport and correlates its response", async () => {
    const fetch = json(proof);
    await expect(confirmOperationsProjectFolder(csrfToken, confirmation)).resolves.toEqual(proof);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/api/native-client-portal/operations-workspaces/confirm-project-folder");
    expect(fetch.mock.calls[0]?.[1]).toEqual({
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify(confirmation),
    });

    json({ ...proof, targetId: "22222222-2222-4222-8222-222222222222" });
    await expect(confirmOperationsProjectFolder(csrfToken, confirmation)).rejects.toThrow("invalid_response");
  });

  it("uses the no-store session transport and rejects malformed CSRF or server denial responses", async () => {
    const fetch = json({ csrfToken });
    await expect(operationsWorkspaceCsrf()).resolves.toBe(csrfToken);
    expect(fetch).toHaveBeenCalledWith(
      "/api/native-client-portal/operations-workspaces/csrf",
      { credentials: "same-origin", cache: "no-store" },
    );

    json({ csrfToken: 123 });
    await expect(operationsWorkspaceCsrf()).rejects.toThrow("invalid_response");

    json({ error: "csrf_denied" }, 403);
    await expect(confirmOperationsProjectFolder(csrfToken, confirmation)).rejects.toThrow("csrf_denied");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network unavailable")));
    await expect(confirmOperationsProjectFolder(csrfToken, confirmation)).rejects.toThrow("network unavailable");
  });

  it("sends an exact refresh request with the publication operation as its idempotency key", async () => {
    const body = { targetId, publication: { operationId: "22222222-2222-4222-8222-222222222222",
      publicationId: "33333333-3333-4333-8333-333333333333", snapshotId: "44444444-4444-4444-8444-444444444444",
      checkpointId: "55555555-5555-4555-8555-555555555555", invocationId: "66666666-6666-4666-8666-666666666666",
      expectedRevision: 4, reason: "Refresh current workspace membership" } };
    const fetch = json({ publicationOperationId: body.publication.operationId, publicationRevision: 5,
      publicationState: "acknowledged", publicationReplayed: false });
    await refreshAndPublishOperationsWorkspace(csrfToken, body);
    expect(fetch).toHaveBeenCalledWith("/api/native-client-portal/operations-workspaces/refresh-and-publish", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken, "Idempotency-Key": body.publication.operationId }, body: JSON.stringify(body),
    });
    await expect(refreshAndPublishOperationsWorkspace(csrfToken, { targetId })).rejects.toThrow("invalid_request");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
