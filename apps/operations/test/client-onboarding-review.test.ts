import { describe, expect, it, vi } from "vitest";
import { readClientOnboardingSubmissionForReview } from "../src/worker/client-onboarding-review";

const submissionId = "33333333-3333-4333-8333-333333333333";
const actor = { identity: { kind: "native" as const, staffId: "staff:reviewer",
  verifiedAccessSubject: "access|staff:reviewer", email: "reviewer@example.test",
  displayName: "Reviewer", profileVersion: 4 }, admissionVersion: 7,
verifiedUntil: "2099-01-01T00:00:00.000Z" };
const fields = { clientType: "consumer", name: "Client", email: "client@example.test", phone: "",
  organizationName: "", organizationEmail: "", organizationPhone: "", addressLine1: "1 Main",
  addressLine2: "", city: "Town", state: "TX", postalCode: "75001", country: "US" };

function database(row: unknown) {
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  const db = { withSession: vi.fn(() => ({ prepare })) } as unknown as D1Database;
  return { db, prepare, bind };
}

describe("client onboarding submission review authority", () => {
  it("pins current identity and requires allow-over-every-scope with deny precedence", async () => {
    const fake = database({ invitation_id: "11111111-1111-4111-8111-111111111111", submission_id: submissionId,
      fields_json: JSON.stringify(fields), fields_sha256: "e".repeat(64), submitted_at: "2098-01-01T00:00:00.000Z",
      target_client_record_id: null, scopes_json: JSON.stringify([{ businessAreaId: "area:onboarding", divisionId: null }]) });
    const result = await readClientOnboardingSubmissionForReview(fake.db, actor, submissionId);
    expect(result).toMatchObject({ submissionId, fields, scopes: [{ businessAreaId: "area:onboarding", divisionId: null }] });
    const sql = String((fake.prepare.mock.calls as unknown[][])[0]?.[0]);
    expect(sql).toContain("NOT EXISTS(SELECT 1 FROM review_scopes scope");
    expect(sql).toContain("NOT EXISTS(SELECT 1 FROM native_directory_grants deny_row");
    expect(sql).toContain("deny_row.effect='deny'");
    expect(sql).toContain("permission='directory.profile.edit'");
    expect(fake.bind).toHaveBeenCalledWith(actor.identity.staffId, actor.identity.verifiedAccessSubject,
      actor.admissionVersion, actor.identity.profileVersion, actor.identity.email, submissionId,
      actor.identity.staffId, actor.identity.staffId, actor.identity.staffId, actor.identity.staffId);
  });

  it("fails closed when the scoped query returns no authorized row", async () => {
    const fake = database(null);
    await expect(readClientOnboardingSubmissionForReview(fake.db, actor, submissionId))
      .rejects.toThrow("client_onboarding_review_denied");
  });
});
