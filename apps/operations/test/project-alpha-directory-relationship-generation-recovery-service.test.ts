import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDirectoryRelationshipRecoveryReview, authorizeDirectoryRelationshipRecoveryReview,
  validateDirectoryRelationshipRecoveryReviewCurrent }
  from "../src/worker/project-alpha-directory-relationship-generation-recovery-service";

const mocks = vi.hoisted(() => ({ administrator: vi.fn(), grant: vi.fn(), collect: vi.fn(), persist: vi.fn() }));
vi.mock("../src/worker/project-alpha-directory-relationship-generation-recovery", () => ({
  currentDirectoryRelationshipRecoveryAdministrator: mocks.administrator,
}));
vi.mock("../src/worker/native-directory-profile-routes", () => ({ selectGrant: mocks.grant }));
vi.mock("../src/worker/project-alpha-directory-relationship-generation-recovery-evidence", () => ({
  collectDirectoryRelationshipGenerationRecoveryEvidence: mocks.collect,
}));
vi.mock("../src/worker/project-alpha-v2-sync", () => ({ persistProjectAlphaDirectoryInventoryPage: mocks.persist }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = "project-alpha:staging", client = "client-local", organization = "org-local";
const actor = { staffId: "staff", accessSubject: "subject", email: "admin@example.test", admissionVersion: 1, profileVersion: 2,
  verifiedUntil: "2999-01-01T00:00:00.000Z" };
const command = { commandId: id(1), expectedClientRevision: "2", expectedAuthorizationGeneration: "10",
  expectedCurrentOrganizationPublicId: null, organization: { externalId: "org-remote", publicId: "b".repeat(32), expectedRevision: "3" } };
const predecessor = { command_id: id(1), client_record_id: client, relationship_version: 2, organization_record_id: organization,
  client_record_version: 1, organization_record_version: 2, source_id: source, source_instance_id: id(2), application_id: id(3),
  history_epoch_id: id(4), destination_origin: "https://pa.example.test", client_external_id: "client-remote", client_public_id: "a".repeat(32),
  organization_external_id: "org-remote", organization_public_id: "b".repeat(32), expected_client_revision: "2",
  expected_organization_revision: "3", command_json: JSON.stringify(command), request_json: JSON.stringify({ frozen: "original request" }) };
const connections = JSON.stringify({ version: 1, instances: { [source]: { sourceId: source, enabled: true,
  baseUrl: "https://pa.example.test", apiKey: "synthetic-test-key", sourceInstanceId: id(2), applicationId: id(3), historyEpoch: id(4) } } });
type Stored = Record<string, string | number | null>;
type Statement = { sql: string; values: unknown[]; bind: (...values: unknown[]) => Statement;
  first: () => Promise<Stored | null>; all: () => Promise<{ results: typeof predecessor[] }>; run: () => Promise<object> };
function database() {
  const controls = { eligible: true, review: null as Stored | null, ledger: null as Stored | null,
    outbox: null as Stored | null, failBatch: false, newerInventory: false, sql: [] as string[] };
  function inserted(statement: Statement): Stored {
    const keys = statement.sql.match(/INSERT INTO \w+\(([^)]+)\)/)?.[1]?.split(",") ?? [];
    return Object.fromEntries(keys.map((key, index) => {
      const value = statement.values[index];
      if (value !== null && typeof value !== "string" && typeof value !== "number") throw new Error("Invalid fixture binding");
      return [key, value];
    }));
  }
  const db = { withSession: vi.fn(() => db), prepare: vi.fn((sql: string): Statement => {
    controls.sql.push(sql);
    const statement: Statement = { sql, values: [], bind(...values) { statement.values = values; return statement; },
      async first() { return sql.includes("FROM project_alpha_api_v2_inventory_receipts")
        ? controls.newerInventory ? { present: 1 } : null
        : sql.includes("FROM project_alpha_directory_relationship_generation_recoveries WHERE authorization_id")
        ? controls.ledger : controls.review; },
      async all() { return { results: controls.eligible ? [{ ...predecessor }] : [] }; },
      async run() { controls.review = inserted(statement); return { success: true }; } };
    return statement;
  }), batch: vi.fn(async (statements: Statement[]) => {
    if (controls.failBatch) throw new Error("synthetic transaction failure");
    controls.ledger = inserted(statements[0]!); controls.outbox = inserted(statements[1]!);
    if (controls.review) controls.review.state = "authorized";
    return [];
  }) };
  return { db, controls };
}
function setup() {
  const { db, controls } = database();
  const env = { OPS_DB: db as unknown as D1Database, PROJECT_ALPHA_API_V2_CONNECTIONS: connections,
    PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED: "true" };
  return { env, controls, db };
}
function observed() {
  return { status: "observed", inventoryPagesForRootPersistence: [{ nextCursor: null }], evidence: {
    clientRevision: "2", targetOrganizationRevision: "3", observedAuthorizationGeneration: "11",
    replayRequestPath: `/api/v2/directory/clients/${"a".repeat(32)}/organization/assign/commands`,
    replayConflictJson: JSON.stringify({ apiVersion: "2", sourceInstanceId: id(2), applicationId: id(3), historyEpoch: id(4),
      requestId: id(5), error: { code: "authorization_generation_conflict" } }),
    readRequestIds: { clientInventory: id(6), organizationInventory: id(7) },
  } };
}
beforeEach(() => {
  mocks.administrator.mockReset().mockResolvedValue(true);
  mocks.grant.mockReset().mockImplementation(async (_db, _staff, permission, record) => `${record}:${permission}`);
  mocks.collect.mockReset().mockResolvedValue(observed());
  mocks.persist.mockReset().mockResolvedValue({ status: "persisted" });
});
afterEach(() => vi.restoreAllMocks());

describe("relationship recovery review service (mocked I/O; SQL atomicity covered separately)", () => {
  it("does no database or network work when default-off", async () => {
    const { env, db } = setup(); env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED = "false";
    expect(await createDirectoryRelationshipRecoveryReview(env, { recordId: client, sourceId: source }, actor))
      .toEqual({ status: "blocked", reason: "disabled" });
    expect(db.prepare).not.toHaveBeenCalled(); expect(mocks.collect).not.toHaveBeenCalled();
  });
  it.each(["administrator", "grant", "enrollment"])("blocks before terminal replay on missing %s", async kind => {
    const { env, controls } = setup();
    if (kind === "administrator") mocks.administrator.mockResolvedValue(false);
    if (kind === "grant") mocks.grant.mockResolvedValue(null);
    if (kind === "enrollment") controls.eligible = false;
    expect((await createDirectoryRelationshipRecoveryReview(env, { recordId: client, sourceId: source }, actor)).status).toBe("blocked");
    expect(mocks.collect).not.toHaveBeenCalled();
  });
  it("requires exact enrollment for BOTH records in the pre-network discovery query", async () => {
    const { env, controls } = setup();
    await createDirectoryRelationshipRecoveryReview(env, { recordId: client, sourceId: source }, actor);
    const discovery = controls.sql.find(sql => sql.startsWith("SELECT predecessor.command_id"));
    expect(discovery?.match(/FROM native_directory_enrollments/g)).toHaveLength(2);
    expect(discovery).toContain("externalCanonicalId"); expect(discovery).toContain("predecessor.history_epoch_id");
  });
  it("requires the canonical persisted relationship-dispatcher conflict marker", async () => {
    const { env, controls } = setup();
    await createDirectoryRelationshipRecoveryReview(env, { recordId: client, sourceId: source }, actor);
    const discovery = controls.sql.find(sql => sql.startsWith("SELECT predecessor.command_id"));
    expect(discovery).toContain("json_extract(predecessor.outcome_json,'$.directoryRelationshipDispatcher')='conflict'");
    expect(discovery).toContain("json_extract(predecessor.outcome_json,'$.httpStatus')=409");
    expect(discovery).not.toContain("json_extract(predecessor.outcome_json,'$.status')='conflict'");
  });
  it("seals sanitized review, authorizes all three writes and replays exactly without sending", async () => {
    const { env, controls, db } = setup();
    const review = await createDirectoryRelationshipRecoveryReview(env, { recordId: client, sourceId: source }, actor);
    expect(review.status).toBe("review"); if (review.status !== "review") return;
    expect(JSON.stringify(review)).not.toContain("synthetic-test-key"); expect(JSON.stringify(review)).not.toContain("selected_grants");
    expect(review.review.evidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    const input = { recordId: client, reviewId: review.review.reviewId, evidenceSha256: review.review.evidenceSha256,
      authorizationId: id(8), successorCommandId: id(9), reason: "Reviewed exact pending assignment" };
    expect(await authorizeDirectoryRelationshipRecoveryReview(env, input, actor)).toEqual({ status: "prepared",
      successorCommandId: id(9), generation: "11", replayed: false });
    expect(db.batch).toHaveBeenCalledOnce();
    expect(controls.outbox?.request_json).toBe(predecessor.request_json);
    expect(JSON.parse(String(controls.outbox?.command_json))).toEqual({ ...command, commandId: id(9), expectedAuthorizationGeneration: "11" });
    expect(await authorizeDirectoryRelationshipRecoveryReview(env, input, actor)).toEqual({ status: "prepared",
      successorCommandId: id(9), generation: "11", replayed: true });
    expect(await authorizeDirectoryRelationshipRecoveryReview(env, { ...input, reason: "Changed body" }, actor))
      .toEqual({ status: "conflict", reason: "authorization_id" });
    expect(db.batch).toHaveBeenCalledOnce(); expect(mocks.collect).toHaveBeenCalledOnce();
  });
  it("rejects revoked authority after evidence collection", async () => {
    const { env, controls } = setup();
    mocks.collect.mockImplementation(async () => { mocks.grant.mockResolvedValue(null); return observed(); });
    expect((await createDirectoryRelationshipRecoveryReview(env, { recordId: client, sourceId: source }, actor)).status).toBe("blocked");
    expect(controls.review).toBeNull(); expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("validates open review re-entry without remote requests or writes", async () => {
    const { env, controls, db } = setup();
    const result = await createDirectoryRelationshipRecoveryReview(env, { recordId: client, sourceId: source }, actor);
    if (result.status !== "review") throw new Error("expected sealed review");
    const input = { recordId: client, sourceId: source, reviewId: result.review.reviewId,
      evidenceSha256: result.review.evidenceSha256 };
    expect(await validateDirectoryRelationshipRecoveryReviewCurrent(env, input, actor)).toBe("current");
    controls.newerInventory = true;
    expect(await validateDirectoryRelationshipRecoveryReviewCurrent(env, input, actor)).toBe("evidence_changed");
    controls.newerInventory = false;
    controls.eligible = false;
    expect(await validateDirectoryRelationshipRecoveryReviewCurrent(env, input, actor)).toBe("evidence_changed");
    controls.eligible = true;
    mocks.grant.mockResolvedValue(null);
    expect(await validateDirectoryRelationshipRecoveryReviewCurrent(env, input, actor)).toBe("authority_revoked");
    expect(mocks.collect).toHaveBeenCalledOnce(); expect(db.batch).not.toHaveBeenCalled();
  });
  it("rejects forged or expired re-entry and does no I/O while disabled", async () => {
    const { env, controls, db } = setup();
    const result = await createDirectoryRelationshipRecoveryReview(env, { recordId: client, sourceId: source }, actor);
    if (result.status !== "review") throw new Error("expected sealed review");
    const input = { recordId: client, sourceId: source, reviewId: result.review.reviewId,
      evidenceSha256: result.review.evidenceSha256 };
    expect(await validateDirectoryRelationshipRecoveryReviewCurrent(env, input, { ...actor, accessSubject: "forged" }))
      .toBe("authority_revoked");
    if (controls.review) controls.review.expires_at = "2000-01-01T00:00:00.000Z";
    expect(await validateDirectoryRelationshipRecoveryReviewCurrent(env, input, actor)).toBe("evidence_changed");
    env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED = "false";
    db.prepare.mockClear();
    expect(await validateDirectoryRelationshipRecoveryReviewCurrent(env, input, actor)).toBe("authority_revoked");
    expect(db.prepare).not.toHaveBeenCalled();
  });
  it("rejects a changed evidence seal, wrong reviewer, expiry and local drift without reserving", async () => {
    for (const kind of ["seal", "reviewer", "expiry", "local"] as const) {
      const { env, controls, db } = setup();
      const result = await createDirectoryRelationshipRecoveryReview(env, { recordId: client, sourceId: source }, actor);
      if (result.status !== "review") throw new Error("expected sealed review");
      if (kind === "expiry" && controls.review) controls.review.expires_at = "2000-01-01T00:00:00.000Z";
      if (kind === "local") controls.eligible = false;
      const input = { recordId: client, reviewId: result.review.reviewId, evidenceSha256: kind === "seal" ? "0".repeat(64) : result.review.evidenceSha256,
        authorizationId: id(8), successorCommandId: id(9), reason: "Reviewed" };
      expect((await authorizeDirectoryRelationshipRecoveryReview(env, input, kind === "reviewer" ? { ...actor, staffId: "other" } : actor)).status).toBe("blocked");
      expect(db.batch).not.toHaveBeenCalled();
    }
  });
});
