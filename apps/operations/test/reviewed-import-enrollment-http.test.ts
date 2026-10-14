import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleReviewedImportEnrollmentHttp, REVIEWED_IMPORT_ENROLLMENT_BASE,
  type ReviewedImportEnrollmentHttpDependencies } from "../src/worker/reviewed-import-enrollment-http";

const origin = "https://ops-staging.example.test";
const mutationId = "11111111-1111-4111-8111-111111111111";
const actor = { identity: { kind: "native" as const, staffId: "owner", verifiedAccessSubject: "access|owner",
  email: "owner@example.test", displayName: "Owner", profileVersion: 3 }, admissionVersion: 2,
  verifiedUntil: "2099-01-01T00:00:00.000Z" };
const destination = { sourceId: "project-alpha:primary", sourceInstanceUUID: "22222222-2222-4222-8222-222222222222",
  applicationUUID: "33333333-3333-4333-8333-333333333333", historyEpoch: "44444444-4444-4444-8444-444444444444",
  origin: "https://pa.example.test", externalCanonicalId: "pa-client" };
const authenticate = vi.fn(), selectAuthority = vi.fn(), readCommittedReplay = vi.fn(), resolveDestinations = vi.fn(), write = vi.fn(), readReview = vi.fn();

function deps(overrides: Partial<ReviewedImportEnrollmentHttpDependencies> = {}): ReviewedImportEnrollmentHttpDependencies {
  return { environment: "staging", enabledFlag: "true", expectedHost: "ops-staging.example.test",
    configuration: { enabled: true, origin, issuer: "https://team.cloudflareaccess.com",
      staffAudience: "a".repeat(16), csrfSecret: "synthetic-test-secret-at-least-thirty-two-bytes" },
    database: {} as D1Database, authenticate, selectAuthority, readCommittedReplay, resolveDestinations, write, readReview, ...overrides };
}
function request(path: string, body?: unknown, headers: Record<string,string> = {}): Request {
  const method = body === undefined ? "GET" : "POST";
  return new Request(`${origin}${REVIEWED_IMPORT_ENROLLMENT_BASE}/${path}`, { method,
    headers: { "Sec-Fetch-Site": "same-origin", ...(method === "GET" ? { "X-Native-Staff-Request": "1" }
      : { Origin: origin, "Content-Type": "application/json", "Idempotency-Key": mutationId }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function token(d = deps()): Promise<string> {
  const result = await handleReviewedImportEnrollmentHttp(request("session"), d);
  expect(result.status).toBe(200); return (await result.json() as {csrfToken:string}).csrfToken;
}
const input = { mutationId, expectedRecordVersion: 4, expectedEnrollmentVersion: 0,
  sourceIds: ["project-alpha:primary"] };

describe("reviewed import enrollment HTTP adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks(); authenticate.mockResolvedValue(actor);
    selectAuthority.mockResolvedValue({ selectedProfileGrantId: "profile-grant", selectedEnrollmentGrantId: "enrollment-grant" });
    readCommittedReplay.mockResolvedValue({ status: "absent" });
    readReview.mockResolvedValue({status:"reviewed",review:{recordId:"client-one",kind:"client",recordVersion:4,
      enrollmentVersion:0,sources:[{sourceId:"project-alpha:primary",enrolled:false}]}});
    resolveDestinations.mockResolvedValue({ status: "resolved", destinations: [destination] });
    write.mockResolvedValue({ status: "written", replayed: false, recordId: "client-one", enrollmentVersion: 1,
      destinations: [destination] });
  });

  it("is staging-only and default-off before authentication", async () => {
    expect((await handleReviewedImportEnrollmentHttp(request("session"), deps({ enabledFlag: "false" }))).status).toBe(404);
    expect((await handleReviewedImportEnrollmentHttp(request("session"), deps({ environment: "production" }))).status).toBe(404);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("reviews explicit source choices without a mutation or provenance response", async () => {
    const result=await handleReviewedImportEnrollmentHttp(request("clients/client-one/review"),deps());
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({review:{recordId:"client-one",kind:"client",recordVersion:4,
      enrollmentVersion:0,sources:[{sourceId:"project-alpha:primary",enrolled:false}]}});
    expect(readReview).toHaveBeenCalledWith(expect.anything(),actor,{recordId:"client-one",kind:"client"});
    expect(write).not.toHaveBeenCalled();expect(readCommittedReplay).not.toHaveBeenCalled();
    expect(resolveDestinations).not.toHaveBeenCalled();
  });

  it("rejects review without current grants, same-origin headers or exact redacted choices", async () => {
    selectAuthority.mockResolvedValueOnce(null);
    expect((await handleReviewedImportEnrollmentHttp(request("clients/client-one/review"),deps())).status).toBe(403);
    expect(readReview).not.toHaveBeenCalled();
    expect((await handleReviewedImportEnrollmentHttp(request("clients/client-one/review",undefined,
      {"Sec-Fetch-Site":"cross-site"}),deps())).status).toBe(403);
    readReview.mockResolvedValueOnce({status:"reviewed",review:{recordId:"client-one",kind:"client",recordVersion:4,
      enrollmentVersion:0,sources:[{sourceId:"project-alpha:primary",enrolled:false,externalCanonicalId:"hidden"}]}});
    expect((await handleReviewedImportEnrollmentHttp(request("clients/client-one/review"),deps())).status).toBe(503);
    expect(write).not.toHaveBeenCalled();
  });

  it("does not return choices when authority is revoked while the read is awaited", async () => {
    readReview.mockImplementationOnce(async()=>{
      selectAuthority.mockResolvedValueOnce(null);
      return {status:"reviewed",review:{recordId:"client-one",kind:"client",recordVersion:4,
        enrollmentVersion:0,sources:[{sourceId:"project-alpha:primary",enrolled:false}]}};
    });
    const result=await handleReviewedImportEnrollmentHttp(request("clients/client-one/review"),deps());
    expect(result.status).toBe(403);expect(await result.json()).toEqual({error:"denied"});
    expect(write).not.toHaveBeenCalled();
  });

  it("requires same-origin native authentication and actor-bound CSRF", async () => {
    authenticate.mockRejectedValueOnce(Error("denied"));
    expect((await handleReviewedImportEnrollmentHttp(request("session"), deps())).status).toBe(403);
    authenticate.mockResolvedValue(actor);
    const csrf = await token();
    expect((await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": `${csrf}bad` }), deps())).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });

  it("accepts only selected source IDs and derives all actor, grant, route, and destination evidence", async () => {
    const csrf = await token(), result = await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": csrf }), deps());
    expect(result.status).toBe(201);
    expect(await result.json()).toEqual({ outcome: { status: "written", replayed: false, recordId: "client-one",
      enrollmentVersion: 1, sourceIds: ["project-alpha:primary"] } });
    expect(resolveDestinations).toHaveBeenCalledWith(expect.anything(), actor, {
      recordId: "client-one", kind: "client", expectedRecordVersion: 4, expectedEnrollmentVersion: 0,
      sourceIds: ["project-alpha:primary"],
    });
    expect(write.mock.calls[0]?.[1]).toEqual({ mutationId, recordId: "client-one", kind: "client",
      expectedRecordVersion: 4, expectedEnrollmentVersion: 0, destinations: [destination], actor: {
        staffId: "owner", accessSubject: "access|owner", admissionVersion: 2, loginEmail: "owner@example.test",
        profileVersion: 3, verifiedUntil: actor.verifiedUntil, selectedProfileGrantId: "profile-grant",
        selectedEnrollmentGrantId: "enrollment-grant",
      } });
  });

  it("rejects provenance, grant, actor, owner, and destination injection before resolution", async () => {
    const csrf = await token();
    for (const extra of [{ destinations: [destination] }, { externalCanonicalId: "attacker" },
      { selectedProfileGrantId: "attacker" }, { actor: {} }, { owner: true }]) {
      expect((await handleReviewedImportEnrollmentHttp(request("organizations/org-one", { ...input, ...extra },
        { "X-CSRF-Token": csrf }), deps())).status).toBe(400);
    }
    expect(resolveDestinations).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });

  it("requires matching idempotency, strict sources, and a current deny-wins authority selection", async () => {
    const csrf = await token();
    expect((await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": csrf, "Idempotency-Key": "55555555-5555-4555-8555-555555555555" }), deps())).status).toBe(400);
    expect((await handleReviewedImportEnrollmentHttp(request("clients/client-one", { ...input,
      sourceIds: ["project-alpha:primary", "project-alpha:primary"] }, { "X-CSRF-Token": csrf }), deps())).status).toBe(400);
    selectAuthority.mockResolvedValueOnce(null);
    expect((await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": csrf }), deps())).status).toBe(403);
    expect(write).not.toHaveBeenCalled();
  });

  it("fails closed when the resolver returns provenance for a different selected source", async () => {
    const csrf = await token();
    resolveDestinations.mockResolvedValueOnce({ status: "resolved", destinations: [{ ...destination,
      sourceId: "project-alpha:other" }] });
    expect((await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": csrf }), deps())).status).toBe(503);
    expect(write).not.toHaveBeenCalled();
  });

  it("maps resolver and writer outcomes without exposing internal errors", async () => {
    const csrf = await token();
    resolveDestinations.mockResolvedValueOnce({ status: "conflict", reason: "stale_record" });
    expect((await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": csrf }), deps())).status).toBe(409);
    resolveDestinations.mockResolvedValue({ status: "resolved", destinations: [destination] });
    write.mockResolvedValueOnce({ status: "conflict", reason: "stale_enrollment" });
    expect((await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": csrf }), deps())).status).toBe(409);
    write.mockRejectedValueOnce(Error("sql details"));
    const unavailable = await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": csrf }), deps());
    expect(unavailable.status).toBe(503); expect(await unavailable.json()).toEqual({ error: "unavailable" });
  });

  it("replays an exact committed mutation before current enrollment resolution and keeps tuples private", async () => {
    const csrf = await token();
    readCommittedReplay.mockResolvedValueOnce({ status: "exact", destinations: [destination], authority: {
      selectedProfileGrantId: "frozen-profile-grant", selectedEnrollmentGrantId: "frozen-enrollment-grant" } });
    write.mockResolvedValueOnce({ status: "written", replayed: true, recordId: "client-one", enrollmentVersion: 1,
      destinations: [destination] });
    const result = await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": csrf }), deps());
    expect(result.status).toBe(200); expect(resolveDestinations).not.toHaveBeenCalled();
    const json = await result.json();
    expect(json).toEqual({ outcome: { status: "written", replayed: true, recordId: "client-one",
      enrollmentVersion: 1, sourceIds: ["project-alpha:primary"] } });
    expect(JSON.stringify(json)).not.toContain(destination.externalCanonicalId);
    expect(JSON.stringify(json)).not.toContain(destination.origin);
    expect(write.mock.calls[0]?.[1]).toMatchObject({ actor: { selectedProfileGrantId: "frozen-profile-grant",
      selectedEnrollmentGrantId: "frozen-enrollment-grant" } });
  });

  it("rejects changed-body replay and current grant denial without resolving or writing", async () => {
    const csrf = await token();
    readCommittedReplay.mockResolvedValueOnce({ status: "conflict" });
    let result = await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": csrf }), deps());
    expect(result.status).toBe(409); expect(await result.json()).toEqual({ error: "idempotency_body_conflict" });
    selectAuthority.mockResolvedValueOnce(null);
    readCommittedReplay.mockResolvedValueOnce({ status: "exact", destinations: [destination], authority: {
      selectedProfileGrantId: "profile-grant", selectedEnrollmentGrantId: "enrollment-grant" } });
    result = await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": csrf }), deps());
    expect(result.status).toBe(403);
    expect(resolveDestinations).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });

  it("rejects replay when the frozen original grants are no longer current", async () => {
    const csrf = await token();
    readCommittedReplay.mockReset().mockResolvedValueOnce({ status: "denied" });
    const result = await handleReviewedImportEnrollmentHttp(request("clients/client-one", input,
      { "X-CSRF-Token": csrf }), deps());
    expect(result.status).toBe(403); expect(resolveDestinations).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
});
