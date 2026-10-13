import { afterEach, describe, expect, it, vi } from "vitest";
import { grantOperationsNativeDeliveryAuthority, listOperationsNativeDeliveryAuthorities,
  listOperationsNativeDeliveryCandidates,
  openOperationsNativeDeliveryOwnerSession, readOperationsNativeDeliveryAuthority,
  recoverOperationsNativeDeliveryAuthority, revokeOperationsNativeDeliveryAuthority,
  type OperationsNativeDeliveryAuthority, type OperationsNativeDeliveryCandidate }
  from "../src/client/operations-native-delivery-owner-api";

const id = (digit: number) => {
  const value = String(digit);
  return `${value.repeat(8)}-${value.repeat(4)}-4${value.repeat(3)}-8${value.repeat(3)}-${value.repeat(12)}`;
};
const targetId = id(1), recipientBindingId = id(2), folderReservationId = id(3), authorityId = id(4);
const operationId = id(5), invocationId = id(6), fingerprint = "a".repeat(64);
const csrfToken = `123.${"b".repeat(64)}`, expiry = "2099-01-01T00:00:00.000Z";
const grantExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const cursor = `v1.page_${"c".repeat(4)}.${"d".repeat(64)}`;
const candidate: OperationsNativeDeliveryCandidate = { candidateFingerprint: fingerprint, recipientBindingId,
  enrollmentIntentId: id(7), targetId, targetRevision: 9, targetClientRecordId: "client:one",
  clientLabel: "Client One", recipientLabel: "Recipient One", workspaceId: "workspace:one",
  homeOwnershipEpoch: 3, homeGrantRevision: 4, publicationRevision: 5, folderReservationId,
  folderReservationRevision: 6, clientFolderBindingId: "folder-binding:one", externalProjectId: "project:one",
  projectLabel: "Project One", projectVersion: 7, opsFolderProjectId: "ops-project:one",
  folderLabel: "Folder One", opsDivisionId: "division:one" };
const active = (overrides: Partial<OperationsNativeDeliveryAuthority> = {}): OperationsNativeDeliveryAuthority => ({
  authorityId, revision: 1, state: "active", recipientBindingId, folderReservationId, targetId,
  enrollmentIntentId: id(7), targetClientRecordId: "client:one", workspaceId: "workspace:one",
  clientFolderBindingId: "folder-binding:one", externalProjectId: "project:one",
  opsFolderProjectId: "ops-project:one", opsDivisionId: "division:one", clientLabel: "Client One",
  recipientLabel: "Recipient One", projectLabel: "Project One", folderLabel: "Folder One",
  features: ["folder.list", "file.metadata"], expiresAt: expiry, latestOperationId: operationId,
  latestAction: "delivery.grant", transportStatus: "acknowledged", recoveryOperationId: null, ...overrides });

function json(value: unknown, status = 200) {
  const mocked = vi.fn().mockResolvedValue(Response.json(value, { status }));
  vi.stubGlobal("fetch", mocked);
  return mocked;
}
afterEach(() => vi.unstubAllGlobals());

describe("operations-native delivery owner API", () => {
  it("parses the exact session and preserves access-denial status without requiring a JSON body", async () => {
    json({ csrfToken, verifiedUntil: expiry });
    await expect(openOperationsNativeDeliveryOwnerSession()).resolves.toEqual({ csrfToken, verifiedUntil: expiry });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Access denied", {
      status: 403, headers: { "Content-Type": "text/html" } })));
    await expect(openOperationsNativeDeliveryOwnerSession()).rejects.toMatchObject({ status: 403, uncertain: false });
  });

  it("accepts only exact requested-target candidate pages and signed bounded cursors", async () => {
    json({ items: [candidate], page: { nextCursor: cursor } });
    await expect(listOperationsNativeDeliveryCandidates(targetId)).resolves.toEqual({ items: [candidate],
      page: { nextCursor: cursor } });
    json({ items: [{ ...candidate, targetId: id(8) }], page: { nextCursor: null } });
    await expect(listOperationsNativeDeliveryCandidates(targetId)).rejects.toMatchObject({ uncertain: true });
    json({ items: [candidate, { ...candidate, candidateFingerprint: "e".repeat(64) }], page: { nextCursor: null } });
    await expect(listOperationsNativeDeliveryCandidates(targetId)).rejects.toMatchObject({ uncertain: true });
    await expect(listOperationsNativeDeliveryCandidates(targetId, "unsigned"))
      .rejects.toMatchObject({ status: 400, uncertain: false });
    json({ items: [], page: { nextCursor: cursor } });
    await expect(listOperationsNativeDeliveryCandidates(targetId, cursor)).rejects.toMatchObject({ uncertain: true });
  });

  it("rejects extra candidate secrets and malformed authority transport correlations", async () => {
    json({ items: [{ ...candidate, selectedR2Prefix: "private/prefix" }], page: { nextCursor: null } });
    await expect(listOperationsNativeDeliveryCandidates(targetId)).rejects.toMatchObject({ uncertain: true });
    json({ authority: active({ transportStatus: "pending", recoveryOperationId: null }) });
    await expect(readOperationsNativeDeliveryAuthority(authorityId)).rejects.toMatchObject({ uncertain: true });
    json({ authority: active({ targetClientRecordId: "client:other" }) });
    await expect(readOperationsNativeDeliveryAuthority(authorityId)).resolves.toMatchObject({
      targetClientRecordId: "client:other", latestAction: "delivery.grant" });
  });

  it("lists only current exact-target authorities with unique authority IDs", async () => {
    const fetch = json({ items: [active()], page: { nextCursor: cursor } });
    await expect(listOperationsNativeDeliveryAuthorities(targetId)).resolves.toMatchObject({
      items: [{ authorityId, targetId, clientLabel: "Client One", folderLabel: "Folder One" }],
      page: { nextCursor: cursor } });
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ headers: { "X-Native-Staff-Request": "1" } });
    json({ items: [active(), active()], page: { nextCursor: null } });
    await expect(listOperationsNativeDeliveryAuthorities(targetId)).rejects.toMatchObject({ uncertain: true });
    json({ items: [active({ targetId: id(8) })], page: { nextCursor: null } });
    await expect(listOperationsNativeDeliveryAuthorities(targetId)).rejects.toMatchObject({ uncertain: true });
    json({ items: [], page: { nextCursor: cursor } });
    await expect(listOperationsNativeDeliveryAuthorities(targetId, cursor))
      .rejects.toMatchObject({ uncertain: true });
    await expect(listOperationsNativeDeliveryAuthorities(targetId, "unsigned"))
      .rejects.toMatchObject({ status: 400, uncertain: false });
  });

  it("sends an exact grant body and correlates every returned operation and authority pin", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ operationId, status: "acknowledged",
      authority: active({ expiresAt: grantExpiry }), replayed: false, recoveryOperationId: null }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const input = { operationId, authorityId, recipientBindingId, folderReservationId, expectedRevision: 0 as const,
      expectedCandidateFingerprint: fingerprint, features: ["folder.list", "file.metadata"] as const,
      expiresAt: grantExpiry, reasonCode: "approved-staging-review", ignored: "never-sent" };
    await expect(grantOperationsNativeDeliveryAuthority(csrfToken, input)).resolves.toMatchObject({
      status: "acknowledged", authority: { authorityId, revision: 1 } });
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual({ operationId, authorityId,
      recipientBindingId, folderReservationId, expectedRevision: 0, expectedCandidateFingerprint: fingerprint,
      features: ["folder.list", "file.metadata"], expiresAt: grantExpiry, reasonCode: "approved-staging-review" });
    json({ operationId, status: "acknowledged", authority: active({ latestOperationId: invocationId }),
      replayed: false, recoveryOperationId: null }, 201);
    await expect(grantOperationsNativeDeliveryAuthority(csrfToken, input)).rejects.toMatchObject({ uncertain: true });
  });

  it("reports stale review as a known conflict and accepts only the exact rejected envelope", async () => {
    const input = { operationId, authorityId, recipientBindingId, folderReservationId, expectedRevision: 0 as const,
      expectedCandidateFingerprint: fingerprint, features: ["folder.list"] as const,
      expiresAt: grantExpiry, reasonCode: "approved-staging-review" };
    json({ error: "candidate_review_stale" }, 409);
    await expect(grantOperationsNativeDeliveryAuthority(csrfToken, input))
      .rejects.toMatchObject({ status: 409, uncertain: false });
    json({ operationId, status: "rejected" }, 409);
    await expect(grantOperationsNativeDeliveryAuthority(csrfToken, input)).resolves.toEqual({ operationId,
      status: "rejected" });
  });

  it("pins revoke and recovery to the next or unchanged revision and exact stored operation", async () => {
    const current = active();
    const revoked = active({ revision: 2, state: "revoked", features: [], expiresAt: null,
      latestOperationId: invocationId, latestAction: "delivery.revoke" });
    json({ operationId: invocationId, status: "acknowledged", authority: revoked,
      replayed: false, recoveryOperationId: null });
    await expect(revokeOperationsNativeDeliveryAuthority(csrfToken, current, { operationId: invocationId,
      expectedRevision: 1, reasonCode: "revoke-after-review" })).resolves.toMatchObject({ authority: { revision: 2,
      state: "revoked" } });
    const pending = active({ transportStatus: "pending", recoveryOperationId: operationId });
    json({ operationId, status: "acknowledged", authority: active(), replayed: true, recoveryOperationId: null });
    await expect(recoverOperationsNativeDeliveryAuthority(csrfToken, pending, { invocationId, operationId,
      expectedRevision: 1, reason: "retry-after-current-owner-review" })).resolves.toMatchObject({
      authority: { revision: 1, latestOperationId: operationId }, recoveryOperationId: null });
    json({ operationId, status: "acknowledged", authority: active({ revision: 2 }), replayed: true,
      recoveryOperationId: null });
    await expect(recoverOperationsNativeDeliveryAuthority(csrfToken, pending, { invocationId, operationId,
      expectedRevision: 1, reason: "retry-after-current-owner-review" })).rejects.toMatchObject({ uncertain: true });
  });

  it("classifies a network failure as uncertain", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    await expect(readOperationsNativeDeliveryAuthority(authorityId))
      .rejects.toMatchObject({ status: 503, uncertain: true });
  });
});
