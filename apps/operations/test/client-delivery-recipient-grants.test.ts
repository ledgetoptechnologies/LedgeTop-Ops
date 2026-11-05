import { describe, expect, it, vi } from "vitest";
import { assertReviewedPreview, deterministicUuid, grantView, parseFolderRef, parseIdempotencyKey, parsePreviewBody, parseRevokeBody, previewVersionForContext, publicationContains } from "../src/worker/client-delivery-recipient-grants";
import type { Resolved } from "../src/worker/client-delivery-recipient-grants";

describe("client delivery recipient grants contract", () => {
  it("requires exact preview shape and canonical expiry", () => {
    const body = { folderRef: "Zm9sZGVy", recipientId: "ops-record-1", recipientVersion: "crv_" + "a".repeat(43),
      audience: "all_members", expiresAt: null };
    expect(parsePreviewBody(body)).toEqual(body);
    expect(() => parsePreviewBody({ ...body, email: "private@example.test" })).toThrow();
    expect(() => parsePreviewBody({ ...body, audience: "selected_member" })).toThrow();
    expect(() => parsePreviewBody({ ...body, expiresAt: "2020-01-01T00:00:00.000Z" })).toThrow();
    expect(() => parsePreviewBody({ ...body, previewVersion: "cpv_" + "a".repeat(43) })).toThrow();
  });

  it("accepts the preview pin only on create and validates the revoke CAS version", () => {
    const body = { folderRef: "Zm9sZGVy", recipientId: "ops-record-1", recipientVersion: "crv_" + "b".repeat(43),
      audience: "all_members", expiresAt: null, previewVersion: "cpv_" + "c".repeat(43) };
    expect(parsePreviewBody(body, true).previewVersion).toBe(body.previewVersion);
    expect(() => parsePreviewBody(body)).toThrow();
    expect(parseRevokeBody({ expectedVersion: 3 })).toEqual({ expectedVersion: 3 });
    expect(() => parseRevokeBody({ expectedVersion: 0 })).toThrow();
    expect(() => parseRevokeBody({ expectedVersion: 1, recipientId: "forbidden-extra" })).toThrow();
  });

  it("normalizes only encoded folder references and validates idempotency keys", () => {
    expect(parseFolderRef("Sm9icy9DbGllbnRzL0FjbWU").prefix).toBe("Jobs/Clients/Acme/");
    expect(() => parseFolderRef("")).toThrow();
    expect(parseIdempotencyKey("client-operation-1234")).toBe("client-operation-1234");
    expect(() => parseIdempotencyKey("short")).toThrow();
  });

  it("derives stable valid operation IDs from a staff-scoped idempotency key", async () => {
    const a = await deterministicUuid(["grant", "staff-1", "key-1", "create"]);
    const same = await deterministicUuid(["grant", "staff-1", "key-1", "create"]);
    const changed = await deterministicUuid(["grant", "staff-1", "key-2", "create"]);
    expect(a).toBe(same);
    expect(a).not.toBe(changed);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  });

  it("accepts only the selected root or its exact published child relationship", () => {
    const authority = { rootRecordId: "ops-org-1", rootKind: "organization" } as never;
    const snapshot = { directoryRecords: [
      { recordId: "ops-org-1", kind: "organization", version: "8", parentRecordId: null, relationshipVersion: null },
      { recordId: "ops-child-1", kind: "client", version: "5", parentRecordId: "ops-org-1", relationshipVersion: "4" },
    ] } as never;
    const child: { record_id: string; record_kind: "client"; current_version: number; display_name: string;
      organization_record_id: string; relationship_version: number; organization_version: number; organization_name: string } = {
      record_id: "ops-child-1", record_kind: "client", current_version: 5, display_name: "Child",
      organization_record_id: "ops-org-1", relationship_version: 4, organization_version: 8, organization_name: "Org" };
    expect(publicationContains(authority, snapshot, child)).toBe(true);
    expect(publicationContains(authority, snapshot, { ...child, relationship_version: 3 })).toBe(false);
    expect(publicationContains(authority, snapshot, { ...child, organization_record_id: "ops-other-org" })).toBe(false);
  });

  it("projects only the public grant contract and omits authority, path and identity internals", () => {
    const view = grantView({ grantId: "grant-uuid", version: 2, recipientRecordId: "ops-recipient-id", status: "active",
      expiresAt: null, createdAt: "2026-11-02T12:00:00.000Z", revokedAt: null } as never,
    { recipientId: "ops-recipient-id", type: "client", displayName: "Example Client", memberCount: 3 } as never, true);
    expect(view).toEqual({ grantId: "grant-uuid", version: 2, recipientId: "ops-recipient-id", recipientLabel: "Example Client",
      recipientType: "client", audienceLabel: "All current and future Client Workspace members", recipientCount: 3,
      status: "active", expiresAt: null, updatedAt: "2026-11-02T12:00:00.000Z", canRevoke: true });
    const serialized = JSON.stringify(view);
    for (const secret of ["workspaceId", "bindingId", "ownerRecordId", "r2Prefix", "sourceId", "email", "memberId", "pa_"])
      expect(serialized).not.toContain(secret);
  });

  it("keeps a naturally expired active grant explicitly revocable for cleanup", () => {
    const view = grantView({ grantId: "grant-expired", version: 1, recipientRecordId: "ops-recipient-id", status: "active",
      expiresAt: "2020-01-01T00:00:00.000Z", createdAt: "2019-01-01T00:00:00.000Z", revokedAt: null, canRevoke: true } as never,
    { recipientId: "ops-recipient-id", type: "client", displayName: "Example Client", memberCount: 1 } as never, true);
    expect(view).toMatchObject({ status: "expired", canRevoke: true });
  });

  it("rejects a stale review pin before the write adapter can be called", async () => {
    const input = { folderRef: "Zm9sZGVy", recipientId: "ops-recipient", recipientVersion: "crv_" + "d".repeat(43),
      audience: "all_members" as const, expiresAt: null };
    const context = { prefix: "Jobs/Clients/Example/", authority: { targetId: "target", targetRevision: 1,
      clientAuthorityId: "authority", workspaceId: "workspace", publicationRevision: 3, sourceSequence: 3,
      rootKind: "organization", rootRecordId: "ops-root", snapshotId: "snapshot", snapshotSha256: "a".repeat(64),
      operationId: "operation", ackToken: "ack", checkpointId: "checkpoint" },
      workspace: { workspaceVersion: "b".repeat(64), membershipVersion: "c".repeat(64), memberCount: 2 },
      folderRef: "Sm9icy9DbGllbnRzL0V4YW1wbGU", divisionIds: ["division"], recipientRecordId: "ops-recipient",
      record: { record_id: "ops-recipient", current_version: 1, organization_record_id: "ops-root",
        relationship_version: 2, organization_version: 5 } } as unknown as Resolved;
    const submitted = await previewVersionForContext(context, "staff-1", input);
    const changed = { ...context, workspace: { ...context.workspace, membershipVersion: "f".repeat(64) } } as Resolved;
    const write = vi.fn();
    const guardedMutation = async () => { await assertReviewedPreview(changed, "staff-1", input, submitted); return write(); };
    await expect(guardedMutation()).rejects.toMatchObject({ status: 409 });
    await expect(assertReviewedPreview({ ...context, divisionIds: ["other-division"] } as Resolved,
      "staff-1", input, submitted)).rejects.toMatchObject({ status: 409 });
    expect(write).not.toHaveBeenCalled();
  });
});
