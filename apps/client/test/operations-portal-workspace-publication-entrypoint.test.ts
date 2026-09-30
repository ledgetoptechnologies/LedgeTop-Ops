import { beforeEach, describe, expect, it, vi } from "vitest";
import { sha256OperationsPortalWorkspacePublication, sha256OperationsPortalWorkspaceSnapshot }
  from "@ltds/shared/operations-portal-workspace-publication";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
vi.mock("../src/worker/operations-portal-workspace-publications", () => ({
  consumeOperationsPortalWorkspacePublication: vi.fn(),
  getOperationsPortalWorkspacePublicationStatus: vi.fn(),
}));
import { consumeOperationsPortalWorkspacePublication, getOperationsPortalWorkspacePublicationStatus }
  from "../src/worker/operations-portal-workspace-publications";
import { getOperationsPortalWorkspacePublicationStatusRpc, publishOperationsPortalWorkspaceRpc,
  OperationsPortalWorkspacePublicationIngress }
  from "../src/worker/operations-portal-workspace-publication-entrypoint";

const writer = vi.mocked(consumeOperationsPortalWorkspacePublication);
const statusReader = vi.mocked(getOperationsPortalWorkspacePublicationStatus);
const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const env = { DELIVERY_DB: {} as D1Database, ENVIRONMENT: "staging",
  EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com", CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true" };
async function fixture() {
  const input = { protocol: "operations-portal-workspace-publication", protocolVersion: 1, action: "publish",
    publicationId: id("1"), operationId: id("2"), expectedRevision: "0", resultingRevision: "1",
    target: { targetId: id("3"), targetRevision: "4", clientAuthorityId: id("4"), workspaceId: "workspace-test",
      rootKind: "organization", rootRecordId: "ops/org/test" },
    snapshot: { snapshotId: id("5"), checkpointId: id("6"), sourceSequence: "1", complete: true,
      counts: { directoryRecords: 1, projects: 0, folderReservations: 0, recipientAuthorityHeads: 0, deliveryAuthorityHeads: 0 },
      snapshotSha256: "0".repeat(64), directoryRecords: [{ recordId: "ops/org/test", kind: "organization",
        version: "1", parentRecordId: null, relationshipVersion: null, displayName: "Synthetic customer", externalFences: [] }],
      projects: [], folderReservations: [], recipientAuthorityHeads: [], deliveryAuthorityHeads: [] },
    actorProof: { staffId: "test-owner", verifiedAccessSubject: "test-subject", admissionVersion: "1",
      profileVersion: "1", grantGeneration: "1", verifiedUntil: "2030-01-01T00:00:00.000Z" },
    observedAt: "2026-09-30T00:00:00.000Z" };
  input.snapshot.snapshotSha256 = await sha256OperationsPortalWorkspaceSnapshot(input);
  const receipt = { operationId: input.operationId, publicationId: input.publicationId,
    requestFingerprint: await sha256OperationsPortalWorkspacePublication(input), targetId: input.target.targetId,
    resultingRevision: "1", sourceSequence: "1", snapshotId: input.snapshot.snapshotId,
    snapshotSha256: input.snapshot.snapshotSha256, replayed: false };
  return { input, receipt };
}

describe("private Ops-native publication ingress", () => {
  beforeEach(() => { writer.mockReset(); statusReader.mockReset(); });
  it("is default-off and staging/exact-host fenced before inspecting input or storage", async () => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("must not inspect"); } });
    for (const candidate of [
      ...[undefined, "false", "TRUE", "1"].map(flag => ({ ...env, CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: flag })),
      { ...env, ENVIRONMENT: "production" }, { ...env, ENVIRONMENT: undefined },
      { ...env, EXPECTED_HOST: undefined }, { ...env, EXPECTED_HOST: "delivery.ledgetopdroneservices.com" },
    ]) await expect(publishOperationsPortalWorkspaceRpc(candidate, hostile))
      .resolves.toMatchObject({ ok: false, code: "disabled", retryable: true });
    expect(writer).not.toHaveBeenCalled();
  });
  it("rejects malformed/hostile payloads and changed snapshot hashes without storage", async () => {
    const { input } = await fixture();
    for (const value of [null, { operationId: id("2") }, { ...input, owner: true },
      { ...input, snapshot: { ...input.snapshot, snapshotSha256: "f".repeat(64) } },
      new Proxy({}, { getPrototypeOf() { throw new Error("private details"); } })])
      await expect(publishOperationsPortalWorkspaceRpc(env, value)).resolves.toMatchObject({ ok: false, code: "invalid" });
    expect(writer).not.toHaveBeenCalled();
  });
  it("returns only an exact durable closed receipt for initial publication and replay", async () => {
    const { input, receipt } = await fixture();
    writer.mockResolvedValueOnce(receipt);
    await expect(publishOperationsPortalWorkspaceRpc(env, input)).resolves.toEqual({ ok: true, receipt });
    writer.mockResolvedValueOnce({ ...receipt, replayed: true });
    await expect(publishOperationsPortalWorkspaceRpc(env, input))
      .resolves.toEqual({ ok: true, receipt: { ...receipt, replayed: true } });
    expect(writer).toHaveBeenCalledWith(env.DELIVERY_DB, input);
  });
  it("refuses mismatched durable receipt evidence", async () => {
    const { input, receipt } = await fixture();
    for (const mismatch of [{ ...receipt, requestFingerprint: "0".repeat(64) }, { ...receipt, targetId: id("7") },
      { ...receipt, snapshotSha256: "f".repeat(64) }, { ...receipt, resultingRevision: "2" }]) {
      writer.mockResolvedValueOnce(mismatch);
      await expect(publishOperationsPortalWorkspaceRpc(env, input)).resolves.toMatchObject({ ok: false, code: "conflict" });
    }
  });
  it("sanitizes conflicts and storage failures without leaking errors", async () => {
    const { input } = await fixture();
    writer.mockRejectedValueOnce(new Error("operations_portal_workspace_publication_conflict"));
    await expect(publishOperationsPortalWorkspaceRpc(env, input)).resolves.toMatchObject({ ok: false, code: "conflict", retryable: false });
    writer.mockRejectedValueOnce(new Error("private SQL, subject or snapshot bytes"));
    const result = await publishOperationsPortalWorkspaceRpc(env, input);
    expect(result).toMatchObject({ ok: false, code: "temporarily-unavailable", retryable: true });
    expect(JSON.stringify(result)).not.toContain("private SQL");
  });
  it("returns exact read-only status, explicit not-found, and conflict for a mismatched existing operation", async () => {
    const { input, receipt } = await fixture();
    statusReader.mockResolvedValueOnce(null);
    await expect(getOperationsPortalWorkspacePublicationStatusRpc(env, input))
      .resolves.toEqual({ ok: false, protocol: "operations-portal-workspace-publication", protocolVersion: 1,
        code: "not-found", retryable: false });
    statusReader.mockResolvedValueOnce({ ...receipt, replayed: true });
    await expect(getOperationsPortalWorkspacePublicationStatusRpc(env, input))
      .resolves.toEqual({ ok: true, receipt: { ...receipt, replayed: true } });
    statusReader.mockRejectedValueOnce(new Error("operations_portal_workspace_publication_replay_mismatch"));
    await expect(getOperationsPortalWorkspacePublicationStatusRpc(env, input))
      .resolves.toMatchObject({ ok: false, code: "conflict", retryable: false });
    expect(statusReader).toHaveBeenCalledTimes(3);
    expect(writer).not.toHaveBeenCalled();
  });
  it("fences status before input inspection and sanitizes read failures", async () => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("must not inspect"); } });
    await expect(getOperationsPortalWorkspacePublicationStatusRpc({ ...env,
      CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "false" }, hostile))
      .resolves.toMatchObject({ ok: false, code: "disabled" });
    const { input } = await fixture();
    statusReader.mockRejectedValueOnce(new Error("private SQL and identity details"));
    const result = await getOperationsPortalWorkspacePublicationStatusRpc(env, input);
    expect(result).toMatchObject({ ok: false, code: "temporarily-unavailable", retryable: true });
    expect(JSON.stringify(result)).not.toContain("private SQL");
  });
  it("does not expose publication through HTTP", async () => {
    const response = await OperationsPortalWorkspacePublicationIngress.prototype.fetch();
    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(writer).not.toHaveBeenCalled();
  });
});
