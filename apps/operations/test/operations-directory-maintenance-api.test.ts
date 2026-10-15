import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryMaintenanceApiError, executeDirectoryMaintenance, readDirectoryMaintenanceSession,
  reviewDirectoryMaintenance } from "../src/client/operations-directory-maintenance-api";

const csrfToken = `123.${"a".repeat(64)}`;
const planSha256 = "b".repeat(64);
const independentBindingVerificationSha256 = "c".repeat(64);
const commandId = "11111111-1111-4111-8111-111111111111", approvalId = "22222222-2222-4222-8222-222222222222";
const plan = {
  protocol: "native-directory-maintenance-authority", version: 1,
  target: { environment: "staging", accountLabel: "staging-account", workerLabel: "ledgetop-ops-staging",
    databaseLabel: "staging-database" },
  staffId: "staff-beau-koltz", grantId: "33333333-3333-4333-8333-333333333333", commandId,
  operator: { staffId: "staff-beau-koltz", accessSubject: "private-subject" },
  approvalIssuer: { staffId: "staff-beau-koltz", accessSubject: "private-subject" },
  identityEvidence: { staffId: "staff-beau-koltz", accessSubject: "private-subject", verificationId: "verification-1",
    verifiedAt: "2026-10-11T00:00:00.000Z", expiresAt: "2026-10-11T01:00:00.000Z", issuer: "private-issuer" },
  snapshot: { staff: [], admission: [], profile: [], roles: [], grants: [], history: [], generation: [] },
};

afterEach(() => vi.unstubAllGlobals());

describe("staging directory maintenance client API", () => {
  it("reads the scoped session and reviews only an empty request body", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => init.method === "POST"
      ? Response.json({ plan, planSha256, independentBindingVerificationSha256 })
      : Response.json({ csrfToken, staffId: "staff-beau-koltz", verifiedUntil: "2026-10-11T01:00:00.000Z" }));
    vi.stubGlobal("fetch", fetcher);
    expect((await readDirectoryMaintenanceSession()).staffId).toBe("staff-beau-koltz");
    const reviewed = await reviewDirectoryMaintenance(csrfToken);
    expect(reviewed.commandId).toBe(commandId);
    expect(reviewed.snapshotRows).toBe(0);
    expect(reviewed.plan).toEqual(plan);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/native-client-portal/directory-maintenance-authority/review");
    expect(fetcher.mock.calls[1]?.[1].body).toBe("{}");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ credentials: "same-origin", mode: "same-origin", redirect: "error" });
  });

  it("sends only the frozen approved command and rejects a mismatched result", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => Response.json({ status: "applied",
      commandId, approvalId, grantId: "33333333-3333-4333-8333-333333333333", resultingGeneration: 2 }));
    vi.stubGlobal("fetch", fetcher);
    const attempt = { approvalId, commandId, planSha256 };
    expect((await executeDirectoryMaintenance(csrfToken, attempt)).status).toBe("applied");
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1].body))).toEqual({ ...attempt, confirm: true });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status: "applied", commandId: "other-command",
      approvalId, grantId: "33333333-3333-4333-8333-333333333333", resultingGeneration: 2 })));
    await expect(executeDirectoryMaintenance(csrfToken, attempt)).rejects.toMatchObject({ uncertain: true });
  });

  it("fails closed on malformed private plans, unexpected session actors, and lost responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ plan: { ...plan, staffId: "other" },
      planSha256, independentBindingVerificationSha256 })));
    await expect(reviewDirectoryMaintenance(csrfToken)).rejects.toBeInstanceOf(DirectoryMaintenanceApiError);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ csrfToken, staffId: "other",
      verifiedUntil: "2026-10-11T01:00:00.000Z" })));
    await expect(readDirectoryMaintenanceSession()).rejects.toBeInstanceOf(DirectoryMaintenanceApiError);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("response lost"); }));
    await expect(executeDirectoryMaintenance(csrfToken, { approvalId, commandId, planSha256 }))
      .rejects.toMatchObject({ uncertain: true });
  });
});
