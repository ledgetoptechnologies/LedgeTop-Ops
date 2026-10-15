import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleOperationsNativeDirectoryMaintenanceOwnerHttp as handle,
  OPERATIONS_NATIVE_DIRECTORY_MAINTENANCE_OWNER_BASE as base,
  type OperationsNativeDirectoryMaintenanceOwnerHttpDependencies as Dependencies }
  from "../src/worker/operations-native-directory-maintenance-owner-http";
import { NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET,
  compileNativeDirectoryMaintenanceAuthorityPlan,
  executeNativeDirectoryMaintenanceAuthority,
  readFrozenNativeDirectoryMaintenanceApproval,
  type CompiledNativeDirectoryMaintenanceAuthorityPlan,
  type NativeDirectoryMaintenanceAuthorityPlan,
  type NativeDirectoryMaintenancePlanInput } from "../src/worker/native-directory-maintenance-authority";
import { authenticateNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";

const origin = "https://ops-staging.ledgetopdroneservices.com";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
const actor = { identity: { kind: "native" as const, staffId: "staff-beau-koltz",
  verifiedAccessSubject: "access|beau", email: "owner@example.test", displayName: "Owner", profileVersion: 4 },
  admissionVersion: 7, verifiedUntil: "2099-01-01T00:00:00.000Z" };
const authenticate = vi.fn<typeof authenticateNativeStaffWithAdmissionVersion>();
const compile = vi.fn<typeof compileNativeDirectoryMaintenanceAuthorityPlan>(async (_db, input) => compiled(input));
const readApproval = vi.fn<typeof readFrozenNativeDirectoryMaintenanceApproval>();
const execute = vi.fn<typeof executeNativeDirectoryMaintenanceAuthority>();
// All DB-using methods are injected by these boundary tests; access to the
// opaque database sentinel would fail instead of silently reaching real D1.
const database = Object.create(null) as D1Database;
const config = { enabled: true, issuer: "https://team.cloudflareaccess.com", staffAudience: "a".repeat(16),
  origin, csrfSecret: "test-secret-with-at-least-thirty-two-characters-long" };

function compiled(input: NativeDirectoryMaintenancePlanInput): CompiledNativeDirectoryMaintenanceAuthorityPlan {
  const plan: NativeDirectoryMaintenanceAuthorityPlan = { ...input, protocol: "native-directory-maintenance-authority", version: 1,
    snapshot: {
      staff: [{ id: input.staffId, email: "owner@example.test", display_name: "Owner", access_subject: input.operator.accessSubject,
        project_alpha_user_id: null, status: "active", created_at: "2026-01-01", updated_at: "2026-01-01", last_seen_at: null,
        provisioning_source: "native", sync_protected: 1 }],
      admission: [{ staff_id: input.staffId, bound_access_subject: input.operator.accessSubject, active: 1,
        admitted_by: input.staffId, created_at: "2026-01-01", updated_at: "2026-01-01", version: 1 }],
      profile: [{ staff_id: input.staffId, login_email: "owner@example.test", display_name: "Owner", version: 1,
        created_at: "2026-01-01", updated_at: "2026-01-01" }],
      roles: [{ id: "owner-role", staff_id: input.staffId, role_id: "role-owner", scope: "global", division_id: null,
        scope_key: "global", created_by: input.staffId, created_at: "2026-01-01" }],
      grants: [], history: [], generation: [],
    } };
  return { plan, canonicalPlanJson: "{}", canonicalPlanSha256: "a".repeat(64),
    independentBindingVerificationJson: "{}", independentBindingVerificationSha256: "b".repeat(64) };
}
function deps(): Dependencies {
  return { environment: "staging", expectedHost: "ops-staging.ledgetopdroneservices.com", enabledFlag: "true",
    configuration: config, database, authenticate, compile, readApproval, execute };
}
function request(route: string, value?: unknown, headers: Record<string, string> = {}): Request {
  const session = route === "session";
  return new Request(`${origin}${base}/${route}`, { method: session ? "GET" : "POST",
    headers: { "Sec-Fetch-Site": "same-origin", ...(session ? { "X-Native-Staff-Request": "1" }
      : { Origin: origin, "Content-Type": "application/json" }), ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
}
async function csrf(d: Dependencies): Promise<string> {
  const response = await handle(request("session"), d);
  expect(response.status).toBe(200);
  return (await response.json() as { csrfToken: string }).csrfToken;
}

describe("staging native directory maintenance HTTP boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actor.verifiedUntil = "2099-01-01T00:00:00.000Z";
    authenticate.mockResolvedValue(actor);
    compile.mockImplementation(async (_db, input) => compiled(input));
    readApproval.mockResolvedValue({ approvalId: uuid(3), plan: compiled({
      target: NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET, staffId: actor.identity.staffId,
      grantId: uuid(4), commandId: uuid(5), operator: { staffId: actor.identity.staffId,
        accessSubject: actor.identity.verifiedAccessSubject }, approvalIssuer: { staffId: actor.identity.staffId,
        accessSubject: actor.identity.verifiedAccessSubject }, identityEvidence: { staffId: actor.identity.staffId,
        accessSubject: actor.identity.verifiedAccessSubject, verificationId: uuid(6), verifiedAt: "2026-10-11T12:00:00.000Z",
        expiresAt: "2026-10-11T12:15:00.000Z", issuer: config.issuer } }).plan,
      canonicalPlanSha256: "a".repeat(64) });
    execute.mockResolvedValue({ status: "applied", commandId: uuid(5), approvalId: uuid(3), grantId: uuid(4), resultingGeneration: 1 });
  });

  it("is exact staging and default-off before authentication", async () => {
    for (const d of [{ ...deps(), environment: "production" }, { ...deps(), enabledFlag: "false" },
      { ...deps(), expectedHost: "ops-staging.example.test" },
      { ...deps(), configuration: { ...config, origin: "https://ops-staging.example.test" } }]) {
      expect((await handle(request("session"), d)).status).toBeGreaterThanOrEqual(400);
    }
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("requires exact native owner identity, fetch metadata, and actor-bound CSRF", async () => {
    const d = deps();
    authenticate.mockRejectedValueOnce(Error("private assertion"));
    expect((await handle(request("session"), d)).status).toBe(403);
    authenticate.mockResolvedValueOnce({ ...actor, identity: { ...actor.identity, staffId: "staff-other" } });
    expect((await handle(request("session"), d)).status).toBe(403);
    expect((await handle(request("session", undefined, { "Sec-Fetch-Site": "cross-site" }), d)).status).toBe(403);
    const token = await csrf(d);
    expect((await handle(request("review", {}, { "X-CSRF-Token": token, Origin: "https://elsewhere.test" }), d)).status).toBe(403);
    expect((await handle(request("review", {}, { "X-CSRF-Token": "0." + "0".repeat(64) }), d)).status).toBe(403);
    expect(compile).not.toHaveBeenCalled();
  });

  it("reviews only an empty body and derives all evidence/IDs from current auth", async () => {
    const d = deps(), token = await csrf(d);
    for (const value of [{ staffId: actor.identity.staffId }, { target: NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET },
      { identityEvidence: {} }, [], null]) {
      expect((await handle(request("review", value, { "X-CSRF-Token": token }), d)).status).toBe(400);
    }
    const response = await handle(request("review", {}, { "X-CSRF-Token": token }), d);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as { plan: NativeDirectoryMaintenanceAuthorityPlan; planSha256: string };
    expect(body.plan.staffId).toBe(actor.identity.staffId);
    expect(body.plan.target).toEqual(NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET);
    expect(body.plan.operator).toEqual({ staffId: actor.identity.staffId, accessSubject: actor.identity.verifiedAccessSubject });
    expect(body.plan.approvalIssuer).toEqual(body.plan.operator);
    expect(body.plan.identityEvidence).toMatchObject({ staffId: actor.identity.staffId,
      accessSubject: actor.identity.verifiedAccessSubject, issuer: config.issuer });
    expect(isUuid(body.plan.identityEvidence.verificationId)).toBe(true);
    expect(Date.parse(body.plan.identityEvidence.verifiedAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(body.plan.identityEvidence.expiresAt) - Date.parse(body.plan.identityEvidence.verifiedAt)).toBeLessThanOrEqual(15 * 60_000);
    expect(isUuid(body.plan.grantId)).toBe(true);
    expect(isUuid(body.plan.commandId)).toBe(true);
    expect(body.planSha256).toBe("a".repeat(64));
    expect(compile).toHaveBeenCalledTimes(1);
  });

  it("requires a preinstalled exact approval and matches its frozen actor/hash/command before execution", async () => {
    const d = deps(), token = await csrf(d);
    const action = { approvalId: uuid(3), commandId: uuid(5), planSha256: "a".repeat(64), confirm: true };
    for (const value of [{ ...action, plan: {} }, { ...action, confirm: false }, { ...action, commandId: "bad" }]) {
      expect((await handle(request("execute", value, { "X-CSRF-Token": token }), d)).status).toBe(400);
    }
    readApproval.mockRejectedValueOnce(Error("native_directory_maintenance_authority_denied"));
    expect((await handle(request("execute", action, { "X-CSRF-Token": token }), d)).status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
    const response = await handle(request("execute", action, { "X-CSRF-Token": token }), d);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "applied", commandId: uuid(5), approvalId: uuid(3), grantId: uuid(4), resultingGeneration: 1 });
    expect(readApproval).toHaveBeenCalledWith(database, uuid(3), uuid(5), "a".repeat(64));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("keeps session from granting authority and never calls executor for actor mismatch", async () => {
    const d = deps(), token = await csrf(d);
    const action = { approvalId: uuid(3), commandId: uuid(5), planSha256: "a".repeat(64), confirm: true };
    const changedSubjectPlan = compiled({ target: NATIVE_DIRECTORY_MAINTENANCE_STAGING_TARGET, staffId: actor.identity.staffId,
        grantId: uuid(4), commandId: uuid(5), operator: { staffId: actor.identity.staffId, accessSubject: "access|different" },
        approvalIssuer: { staffId: actor.identity.staffId, accessSubject: "access|different" },
        identityEvidence: { staffId: actor.identity.staffId, accessSubject: "access|different", verificationId: uuid(6),
          verifiedAt: "2026-10-11T12:00:00.000Z", expiresAt: "2026-10-11T12:15:00.000Z", issuer: config.issuer } }).plan;
    readApproval.mockResolvedValueOnce({ approvalId: uuid(3), canonicalPlanSha256: "a".repeat(64), plan: changedSubjectPlan });
    const response = await handle(request("execute", action, { "X-CSRF-Token": token }), d);
    expect(response.status).toBe(409);
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports post-commit session expiry as uncertain so the same frozen command can reconcile by replay", async () => {
    const d = deps(), token = await csrf(d);
    const action = { approvalId: uuid(3), commandId: uuid(5), planSha256: "a".repeat(64), confirm: true };
    execute.mockImplementationOnce(async (_db, input) => {
      actor.verifiedUntil = "2000-01-01T00:00:00.000Z";
      return { status: "applied", commandId: input.commandId, approvalId: input.approvalId,
        grantId: uuid(4), resultingGeneration: 1 };
    });
    const uncertain = await handle(request("execute", action, { "X-CSRF-Token": token }), d);
    expect(uncertain.status).toBe(503);
    expect(await uncertain.json()).toEqual({ error: "unavailable" });
    expect(execute).toHaveBeenCalledTimes(1);

    actor.verifiedUntil = "2099-01-01T00:00:00.000Z";
    execute.mockResolvedValueOnce({ status: "replayed", commandId: uuid(5), approvalId: uuid(3),
      grantId: uuid(4), resultingGeneration: 1 });
    const reconciled = await handle(request("execute", action, { "X-CSRF-Token": token }), d);
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ status: "replayed", commandId: uuid(5), grantId: uuid(4) });
    expect(readApproval).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
