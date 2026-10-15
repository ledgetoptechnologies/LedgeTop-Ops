import { describe, expect, it } from "vitest";
import { advanceImportRecord, loadImportCandidates, nativeImportRecordId, parseImportJob, reviewImportRecord, renewImportRecord,
  type ExistingImportRequest, type ImportCandidate, type ImportReference, type ImportReview } from "../src/client/native-directory-existing-import-client";

const batchId = "11111111-1111-4111-8111-111111111111", importId = "22222222-2222-4222-8222-222222222222";
const key = "33333333-3333-4333-8333-333333333333";
const org: ImportCandidate = { sourceId: "project-alpha:primary", kind: "organization", recordId: "same-classic-id",
  publicId: "a".repeat(32), name: "Existing organization", parentRecordId: null, parentPublicId: null, businessAreaId: "area-primary" };
const client: ImportCandidate = { ...org, kind: "client", publicId: "b".repeat(32), name: "Existing client",
  parentRecordId: org.recordId, parentPublicId: org.publicId };
const ref: ImportReference = { sourceId: org.sourceId, kind: org.kind, recordId: org.recordId,
  businessAreaId: org.businessAreaId, idempotencyKey: key, importId };
const reviewed: ImportReview = { ...org, importId, batchId, nativeRecordId: nativeImportRecordId(org),
  parentNativeRecordId: null, profile: { name: org.name }, expiresAt: "2099-01-01T00:00:00Z" };

describe("existing PA import operator recovery", () => {
  it("orders organizations before contacts across paginated sources and keeps overlapping legacy IDs distinct", async () => {
    let page = 0;
    const request = (async () => ++page === 1 ? { items: [client], nextCursor: "page-two" }
      : { items: [org], nextCursor: null }) as ExistingImportRequest;
    const result = await loadImportCandidates(request);
    expect(result.map(row => row.kind)).toEqual(["organization", "client"]);
    expect(new Set(result.map(nativeImportRecordId)).size).toBe(2);
  });
  it("rejects a review for another PA record before any execute request", async () => {
    const paths: string[] = [];
    const request = (async (path: string) => { paths.push(path); return { status: "reviewed", review: { ...reviewed, publicId: "c".repeat(32) } }; }) as ExistingImportRequest;
    await expect(reviewImportRecord(request, batchId, org, ref)).rejects.toThrow("PA record or its organization changed");
    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain("/review");
  });
  it("restores only opaque recovery references and discards profile data from local storage", () => {
    const parsed = parseImportJob(JSON.stringify({ version: 1, batchId, records: [{ ...ref, name: "Private name",
      profile: { email: "private@example.test" }, apiKey: "must-not-be-retained" }] }));
    expect(parsed).toEqual({ version: 1, batchId, records: [ref] });
    expect(JSON.stringify(parsed)).not.toContain("private");
    expect(JSON.stringify(parsed)).not.toContain("apiKey");
  });
  it("rejects a changed parent PA identity even when its classic ID matches", async () => {
    const clientRef = { ...ref, kind: client.kind };
    const clientReview = { ...reviewed, ...client, nativeRecordId: nativeImportRecordId(client),
      parentNativeRecordId: nativeImportRecordId(org), parentPublicId: "d".repeat(32) };
    const request = (async () => ({ status: "reviewed", review: clientReview })) as ExistingImportRequest;
    await expect(reviewImportRecord(request, batchId, client, clientRef)).rejects.toThrow("PA record or its organization changed");
  });
  it("reconciles a lost acknowledgement without sending a second binding request", async () => {
    let committed = false; const writes: RequestInit[] = [];
    const request = (async (path: string, init?: RequestInit) => {
      if (path.includes("/status?")) return { status: committed ? "activated" : "reviewed", review: reviewed };
      writes.push(init!); committed = true; throw new Error("Response lost after server commit");
    }) as ExistingImportRequest;
    await expect(advanceImportRecord(request, batchId, ref, () => true)).rejects.toThrow("Response lost");
    await expect(advanceImportRecord(request, batchId, ref, () => true)).resolves.toMatchObject({ status: "activated" });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body).toBe(JSON.stringify({ importId }));
    expect(new Headers(writes[0]!.headers).get("Idempotency-Key")).toBe(importId);
  });
  it("uses the saved import on pending resume and honors pause after the status read", async () => {
    const writes: RequestInit[] = [];
    const request = (async (path: string, init?: RequestInit) => {
      if (path.includes("/status?")) return { status: "pending", review: reviewed };
      writes.push(init!); return { status: "activated", importId, recordId: reviewed.nativeRecordId };
    }) as ExistingImportRequest;
    await expect(advanceImportRecord(request, batchId, ref, () => false)).resolves.toMatchObject({ status: "pending" });
    expect(writes).toHaveLength(0);
    await expect(advanceImportRecord(request, batchId, ref, () => true)).resolves.toMatchObject({ status: "activated" });
    expect(writes.map(write => write.body)).toEqual([JSON.stringify({ importId })]);
  });
  it("renews authorization for the same immutable import and rejects profile replacement", async () => {
    const writes: RequestInit[] = [];
    let changed = false;
    const request = (async (_path: string, init?: RequestInit) => {
      writes.push(init!);
      return { status: "reviewed", review: { ...reviewed, expiresAt: "2099-02-01T00:00:00Z",
        ...(changed ? { profile: { name: "Replacement profile" } } : {}) } };
    }) as ExistingImportRequest;
    await expect(renewImportRecord(request, reviewed, ref)).resolves.toMatchObject({ importId, expiresAt: "2099-02-01T00:00:00Z" });
    expect(writes[0]!.body).toBe(JSON.stringify({ importId }));
    changed = true;
    await expect(renewImportRecord(request, reviewed, ref)).rejects.toThrow("changed its reviewed identity or profile");
  });
  it("requires explicit renewal before executing an expired review", async () => {
    const paths: string[] = [];
    const request = (async (path: string) => { paths.push(path); return { status: "reviewed", review: reviewed, renewable: true }; }) as ExistingImportRequest;
    await expect(advanceImportRecord(request, batchId, ref, () => true)).resolves.toMatchObject({ status: "blocked", renewable: true });
    expect(paths).toHaveLength(1); expect(paths[0]).toContain("/status?");
  });
});
