import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { inviteTargetProofStatement, verifyInviteTargetChoice } from "../src/worker/client-onboarding-target-choices";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../src/worker/types";

const calls = vi.hoisted(() => ({ legacy: vi.fn(), native: vi.fn(), issue: vi.fn(), reveal: vi.fn(),
  review: vi.fn(), inbox: vi.fn(), approve: vi.fn(), sharedApprove:vi.fn(), existingCompanies: vi.fn(), sharedPlan:vi.fn(), sharedChoices:vi.fn(), enrollmentChoices: vi.fn(), scopeChoices: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: calls.legacy }));
vi.mock("../src/worker/native-staff-auth", () => ({
  authenticateNativeStaffWithAdmissionVersion: calls.native,
}));
vi.mock("../src/worker/client-onboarding-handoff", () => ({
  snapshotClientOnboardingKeyring: (value: unknown) => value,
  issueClientOnboardingWithHandoff: calls.issue,
  revealClientOnboardingSecret: calls.reveal,
}));
vi.mock("../src/worker/client-onboarding-review", async original => ({
  ...await original<typeof import("../src/worker/client-onboarding-review")>(),
  readClientOnboardingSubmissionForReview: calls.review,
  listClientOnboardingSubmissionsForReview: calls.inbox,
}));
vi.mock("../src/worker/client-onboarding-approval", () => ({
  approveNewNativeOnlyClientOnboarding: calls.approve,
}));
vi.mock("../src/worker/client-onboarding-shared-company-approval",()=>({approveClientOnboardingSharedCompany:calls.sharedApprove}));
vi.mock("../src/worker/client-onboarding-enrollment-discovery", () => ({
  readClientOnboardingEnrollmentChoices: calls.enrollmentChoices,
}));
vi.mock("../src/worker/client-onboarding-scope-choices", () => ({
  readClientOnboardingScopeChoices: calls.scopeChoices,
}));
vi.mock("../src/worker/client-onboarding-existing-company",async original=>({
  ...await original<typeof import("../src/worker/client-onboarding-existing-company")>(),
  readClientOnboardingExistingCompanies:calls.existingCompanies,
}));
vi.mock("../src/worker/client-onboarding-shared-company-plan",async original=>({
  ...await original<typeof import("../src/worker/client-onboarding-shared-company-plan")>(),
  prepareClientOnboardingSharedCompanyPlan:calls.sharedPlan,readClientOnboardingSharedCompanyChoices:calls.sharedChoices,
}));
const { targetSchema, destinationSchema } = vi.hoisted(() => ({ targetSchema: vi.fn(), destinationSchema: vi.fn() }));
vi.mock("../src/worker/client-onboarding-target-schema", async original => ({
  ...await original<typeof import("../src/worker/client-onboarding-target-schema")>(),
  targetIssuanceSchemaFence: targetSchema,
  destinationIssuanceSchemaFence: destinationSchema,
}));
import worker from "../src/worker/index";
import { clientOnboardingStaffHttpRequest } from "../src/worker/client-onboarding-staff-http";

const origin = "https://ops.ledgetopdroneservices.com";
const canonicalOrigin = "https://ops.ledgetop.app";
const keyring = { activeKeyId: "current", keys: { current: "ab".repeat(32) } };
const actor = { identity: { kind: "native" as const, staffId: "staff:onboarding",
  verifiedAccessSubject: "access|staff:onboarding", email: "staff@example.test",
  displayName: "Onboarding Staff", profileVersion: 1 }, admissionVersion: 2,
verifiedUntil: "2099-01-01T00:00:00.000Z" };
const unavailable = (): never => { throw Error("unexpected database use"); };
const database: D1Database = { prepare: unavailable, batch: unavailable, exec: unavailable,
  withSession: unavailable, dump: unavailable };
function env(enabled = "true"): Env {
  return { ENVIRONMENT: "production", EXPECTED_HOST: "ops.ledgetopdroneservices.com", OPERATIONS_ORIGINS: `${canonicalOrigin},${origin}`,
    PUBLIC_BASE_URL: origin, DELIVERY_BASE_URL: "https://portal.example.test",
    PUBLIC_SHARE_ORIGIN: "https://delivery.example.test", INCOMING_EXPECTED_HOST: "incoming.example.test",
    INCOMING_BASE_URL: "https://incoming.example.test", OPS_DB: database,
    TEAM_DOMAIN: "https://synthetic-team.cloudflareaccess.com",
    OPERATIONS_AUD: "synthetic-staff-audience", CLIENT_ONBOARDING_ADMIN_ENABLED: enabled,
    CLIENT_ONBOARDING_ADMIN_ORIGIN: origin, CLIENT_ONBOARDING_HANDOFF_KEYRING: JSON.stringify(keyring),
    OPERATIONS_SESSION_SECRET: "synthetic-client-onboarding-csrf-secret-at-least-thirty-two-bytes" } as Env;
}
const context: ExecutionContext = { waitUntil() {}, passThroughOnException() {}, props: {},
  get exports(): Cloudflare.Exports { return unavailable(); }, get tracing(): Tracing { return unavailable(); } };
function send(path: string, method = "GET", body?: unknown, csrf?: string,
  environment = env(), requestOrigin = origin, urlOrigin = origin) {
  return worker.fetch(new Request(`${urlOrigin}${path}`, { method,
    headers: { "X-Native-Staff-Request": "1", "Sec-Fetch-Site": "same-origin",
      Origin: requestOrigin, "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), environment, context);
}
async function session(environment = env(), requestOrigin = origin, urlOrigin = origin): Promise<string> {
  const reply = await send("/api/client-onboarding/staff/session", "GET", undefined, undefined, environment, requestOrigin, urlOrigin);
  expect(reply.status).toBe(200);
  return (await reply.json() as { csrfToken: string }).csrfToken;
}

it("reports only configured destination bindings that survive the native authority query", async () => {
  const environment = env();
  environment.CLIENT_ONBOARDING_INVITE_DESTINATION_BINDINGS = JSON.stringify([
    { sourceId: "project-alpha:primary", businessAreaId: "area:d", divisionId: "division:d" },
    { sourceId: "project-alpha:secondary", businessAreaId: "area:t", divisionId: "division:t" },
  ]);
  const scopes = [{ businessAreaId: "area:t", name: "Technologies", allowAreaWide: true,
    divisions: [{ divisionId: "division:t", name: "Allowed exact division" }] },
  { businessAreaId: "area:d", name: "Drone", allowAreaWide: true, divisions: [] }];
  calls.scopeChoices.mockResolvedValue({ scopes });
  const path = "/api/client-onboarding/staff/scope-choices";
  const csrf = await session(environment);
  const withSession = vi.fn((_mode: string) => ({}));
  environment.OPS_DB = { ...database, withSession } as unknown as D1Database;
  destinationSchema.mockRejectedValueOnce(new Error("fixture_schema_missing"));
  expect(await (await send(path, "POST", {}, csrf, environment)).json()).toEqual({ scopes, destinationSourceIds: [] });
  expect(await (await send(path, "POST", {}, csrf, environment)).json()).toEqual({ scopes, destinationSourceIds: ["project-alpha:secondary"] });
  expect(withSession.mock.calls.every(call => call[0] === "first-primary")).toBe(true);
  environment.CLIENT_ONBOARDING_INVITE_DESTINATION_BINDINGS = "[]";
  expect(await (await send(path, "POST", {}, csrf, environment)).json()).toEqual({ scopes, destinationSourceIds: [] });
  delete environment.CLIENT_ONBOARDING_INVITE_DESTINATION_BINDINGS;
  expect(await (await send(path, "POST", {}, csrf, environment)).json()).toEqual({ scopes });
  expect(calls.issue).not.toHaveBeenCalled();
});

it("reports target-capable destinations only with both flags, a full connection identity, exact division access, and a reviewed schema", async () => {
  const primary = "project-alpha:primary", secondary = "project-alpha:secondary";
  const bindings = [
    { sourceId: primary, businessAreaId: "area:d", divisionId: "division:d" },
    { sourceId: secondary, businessAreaId: "area:t", divisionId: "division:t" },
  ];
  const scopes = [
    { businessAreaId: "area:d", name: "Drone", allowAreaWide: true, divisions: [] },
    { businessAreaId: "area:t", name: "Technologies", allowAreaWide: false,
      divisions: [{ divisionId: "division:t", name: "Allowed exact division" }] },
  ];
  calls.scopeChoices.mockResolvedValue({ scopes });
  const connection = (sourceId: string, suffix: number, enabled = true) => ({
    sourceId, enabled, baseUrl: "https://source.example.test", apiKey: "synthetic-test-key",
    sourceInstanceId: `a0000000-0000-4000-8000-00000000000${suffix}`,
    applicationId: `b0000000-0000-4000-8000-00000000000${suffix}`,
    historyEpoch: `c0000000-0000-4000-8000-00000000000${suffix}`,
  });
  const config = (instances: Record<string, unknown>) => JSON.stringify({ version: 1, instances });
  const primaryConnection = connection(primary, 1), secondaryConnection = connection(secondary, 2);
  const environment: Env = {
    ...env(),
    CLIENT_ONBOARDING_INVITE_DESTINATION_BINDINGS: JSON.stringify(bindings),
    CLIENT_ONBOARDING_INVITE_TARGET_CHOICES_ENABLED: "true",
    CLIENT_ONBOARDING_INVITE_TARGET_ISSUANCE_ENABLED: "true",
    PROJECT_ALPHA_API_V2_CONNECTIONS: config({ [primary]: primaryConnection, [secondary]: secondaryConnection }),
  };
  const csrf = await session(environment);
  const read = async (overrides: Partial<Env> = {}) => {
    const response = await send("/api/client-onboarding/staff/scope-choices", "POST", {}, csrf, { ...environment, ...overrides });
    expect(response.status).toBe(200);
    return response.json();
  };
  const ordinary = { scopes, destinationSourceIds: [secondary] };
  environment.OPS_DB = { ...database, withSession: vi.fn(() => ({})) } as unknown as D1Database;
  const primarySession = {};
  const withSession = vi.fn((_mode: string) => primarySession);
  const opsDb = { ...database, withSession } as unknown as D1Database;
  targetSchema.mockRejectedValueOnce(new Error("client_onboarding_target_schema_unavailable"));
  expect(await read({ OPS_DB: opsDb })).toEqual(ordinary);
  targetSchema.mockResolvedValueOnce(undefined);
  expect(await read({ OPS_DB: opsDb })).toEqual({ ...ordinary, targetDestinationSourceIds: [secondary] });
  expect(withSession.mock.calls.every(call => call[0] === "first-primary")).toBe(true);
  expect(targetSchema.mock.calls).toEqual([[primarySession], [primarySession]]);
  expect(withSession).toHaveBeenCalledTimes(4);
  targetSchema.mockClear();
  expect(await read({ CLIENT_ONBOARDING_INVITE_TARGET_CHOICES_ENABLED: undefined })).toEqual(ordinary);
  expect(await read({ CLIENT_ONBOARDING_INVITE_TARGET_ISSUANCE_ENABLED: "TRUE" })).toEqual(ordinary);
  expect(await read({ PROJECT_ALPHA_API_V2_CONNECTIONS: undefined })).toEqual(ordinary);
  expect(await read({ PROJECT_ALPHA_API_V2_CONNECTIONS: config({ [primary]: primaryConnection,
    [secondary]: { ...secondaryConnection, enabled: false } }) })).toEqual(ordinary);
  expect(await read({ PROJECT_ALPHA_API_V2_CONNECTIONS: config({ [primary]: primaryConnection,
    [secondary]: { ...secondaryConnection, historyEpoch: undefined } }) })).toEqual(ordinary);
  expect(targetSchema).not.toHaveBeenCalled();
  expect(calls.issue).not.toHaveBeenCalled();
});

it("derives scopes and immutable intent for destination create before entering the one-time handoff", async () => {
  const environment = env();
  const binding = { sourceId: "project-alpha:secondary", businessAreaId: "area:t", divisionId: "division:t" };
  environment.CLIENT_ONBOARDING_INVITE_DESTINATION_BINDINGS = JSON.stringify([binding]);
  const scopes = [{ businessAreaId: binding.businessAreaId, name: "Technologies", allowAreaWide: true,
    divisions: [{ divisionId: binding.divisionId, name: "Allowed exact division" }] }];
  calls.scopeChoices.mockResolvedValue({ scopes });
  const path = "/api/client-onboarding/staff/create";
  const csrf = await session(environment);
  const command = { commandId: "22222222-2222-4222-8222-222222222222", expiresAt: "2099-01-01T00:00:00.000Z" };
  expect((await send(path, "POST", { ...command, destinationSourceIds: [binding.sourceId, "project-alpha:primary"] }, csrf, environment)).status).toBe(403);
  expect(calls.issue).not.toHaveBeenCalled();
  expect((await send(path, "POST", { ...command, destinationSourceIds: [binding.sourceId] }, csrf, environment)).status).toBe(200);
  expect(calls.issue.mock.calls[0]?.[1].request).toEqual({ ...command, targetClientRecordId: null,
    scopes: [{ businessAreaId: binding.businessAreaId, divisionId: binding.divisionId }], destinationIntent: [binding] });
});

it("looks up an exact staff-authorized directory target without returning profile fields", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const publicId = "2".repeat(32);
  const sourceId = "project-alpha:secondary";
  const sourceInstanceId = "a0000000-0000-4000-8000-000000000001";
  const applicationId = "b0000000-0000-4000-8000-000000000002";
  const historyEpoch = "c0000000-0000-4000-8000-000000000003";
  const binding = { sourceId, businessAreaId: "area:t", divisionId: "division:t" };
  try {
    sqlite.exec(`CREATE TABLE native_staff_admissions(staff_id,active,bound_access_subject,version);
      CREATE TABLE native_staff_onboarding_rate_limits(rate_key TEXT PRIMARY KEY,window_bucket,request_count,request_limit);
      CREATE TABLE native_staff_profiles(staff_id,version,login_email);
      CREATE TABLE staff_users(id,status,access_subject);
      CREATE TABLE native_business_areas(id,active);
      CREATE TABLE native_business_divisions(id,business_area_id,active);
      CREATE TABLE project_alpha_active_directory_mappings(source_id,source_instance_id,application_id,history_epoch_id,record_id,external_id,resource_type,project_alpha_public_id,provenance_id);
      CREATE TABLE effective_native_directory_enrollments(record_id,destinations_json,provenance_id);
      CREATE TABLE operations_directory_records(record_id,current_version,record_kind);
      CREATE TABLE operations_directory_lifecycle_state(record_id,status);
      CREATE TABLE operations_directory_revisions(record_id,version,profile_json);
      CREATE TABLE native_directory_resource_scopes(record_id,active,business_area_id,division_id);
      CREATE TABLE native_directory_grants(staff_id,permission,active,effect,scope_kind,resource_id,business_area_id,division_id);
      CREATE TABLE native_directory_assignments(staff_id,record_id,active);
      CREATE TABLE operations_directory_client_organizations(client_record_id,organization_record_id,relationship_version);
      INSERT INTO native_staff_admissions VALUES ('staff:onboarding',1,'access|staff:onboarding',2);
      INSERT INTO native_staff_profiles VALUES ('staff:onboarding',1,'staff@example.test');
      INSERT INTO staff_users VALUES ('staff:onboarding','active','access|staff:onboarding');
      INSERT INTO native_business_areas VALUES ('area:t',1);
      INSERT INTO native_business_divisions VALUES ('division:t','area:t',1);
      INSERT INTO native_directory_grants VALUES ('staff:onboarding','directory.profile.view',1,'allow','global',NULL,NULL,NULL),
        ('staff:onboarding','directory.profile.edit',1,'allow','global',NULL,NULL,NULL);
      INSERT INTO operations_directory_client_organizations VALUES ('local:client','local:org',2);`);
    for (const [kind, recordId, id] of [["client", "local:client", publicId], ["organization", "local:org", "3".repeat(32)]]) {
      sqlite.prepare("INSERT INTO operations_directory_records VALUES (?,1,?)").run(recordId, kind);
      sqlite.prepare("INSERT INTO operations_directory_lifecycle_state VALUES (?,'active')").run(recordId);
      sqlite.prepare("INSERT INTO operations_directory_revisions VALUES (?,1,'{\"name\":\"Sensitive fixture\"}')").run(recordId);
      sqlite.prepare("INSERT INTO native_directory_resource_scopes VALUES (?,1,'area:t','division:t')").run(recordId);
      sqlite.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES (?,?,?,?,?,?,?,?,?)")
        .run(sourceId, sourceInstanceId, applicationId, historyEpoch, recordId, recordId, kind, id, `mapping:${kind}`);
      sqlite.prepare("INSERT INTO effective_native_directory_enrollments VALUES (?,?,?)").run(recordId,
        JSON.stringify([{ sourceId, sourceInstanceUUID: sourceInstanceId, applicationUUID: applicationId, historyEpoch, externalCanonicalId: recordId }]), `enrollment:${kind}`);
    }
    const fixtureDatabase = { withSession(mode: string) {
      expect(mode).toBe("first-primary");
      return { prepare(sql: string) { return { bind(...args: Array<string | number>) {
        return {
          async all() { return { results: sqlite.prepare(sql).all(...args) }; },
          async run() { return { success: true, meta: { changes: sqlite.prepare(sql).run(...args).changes } }; },
        };
      } }; } };
    } } as unknown as D1Database;
    const configuration = { sourceId, sourceInstanceId, applicationId, historyEpoch, enabled: true,
      baseUrl: "https://technology.example.test", apiKey: "synthetic-test-key" };
    const environment = { ...env(), OPS_DB: fixtureDatabase, CLIENT_ONBOARDING_INVITE_DESTINATION_BINDINGS: JSON.stringify([binding]),
      PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { [sourceId]: configuration } }) };
    calls.scopeChoices.mockResolvedValue({ scopes: [{ businessAreaId: binding.businessAreaId, name: "Technology", allowAreaWide: false,
      divisions: [{ divisionId: binding.divisionId, name: "Division" }] }] });
    const csrf = await session(environment);
    const path = "/api/client-onboarding/staff/target-choices";
    const request = { kind: "client", sourceId, publicId };
    const lookup = (patch = {}, payload = request) => send(path, "POST", payload, csrf,
      { ...environment, CLIENT_ONBOARDING_INVITE_TARGET_CHOICES_ENABLED: "true", ...patch });
    expect((await lookup({ CLIENT_ONBOARDING_INVITE_TARGET_CHOICES_ENABLED: undefined })).status).toBe(404);
    expect((await send(path, "POST", request, undefined, { ...environment, CLIENT_ONBOARDING_INVITE_TARGET_CHOICES_ENABLED: "true" })).status).toBe(403);
    expect((await lookup()).status).toBe(403); // Directory viewing and editing do not grant identity linking.
    sqlite.exec("INSERT INTO native_directory_grants VALUES ('staff:onboarding','directory.identity.link',1,'allow','global',NULL,NULL,NULL)");
    const success = await lookup();
    expect(success.status).toBe(200);
    const original = await success.json();
    expect(original).toEqual({ choice: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const context = { origin, auth: actor, binding: { ...binding, sourceId: "project-alpha:secondary" as const },
      source: { instance: sourceInstanceId, application: applicationId, epoch: historyEpoch }, lookup: { kind: "client" as const, publicId } };
    const verify = (candidate = context) => verifyInviteTargetChoice(fixtureDatabase, candidate, original.choice,
      async message => createHmac("sha256", environment.OPERATIONS_SESSION_SECRET!).update(message).digest("hex"));
    expect(await verify()).toMatchObject([{ recordId: "local:client", recordVersion: 1 }, { recordId: "local:org" }]);
    expect(await verify({ ...context, origin: canonicalOrigin })).toBeNull();
    expect(await verify({ ...context, auth: { ...actor, admissionVersion: 1 } })).toBeNull();
    expect(await verify({ ...context, source: { ...context.source, instance: applicationId } })).toBeNull();
    expect(await verify({ ...context, lookup: { ...context.lookup, publicId: "3".repeat(32) } })).toBeNull();
    sqlite.exec("DELETE FROM native_directory_grants WHERE permission='directory.identity.link'");
    expect(await verify()).toBeNull();
    sqlite.exec("INSERT INTO native_directory_grants VALUES ('staff:onboarding','directory.identity.link',1,'allow','global',NULL,NULL,NULL)");
    const pin = await verify();
    if (!pin) throw Error("synthetic target pin unavailable");
    const command = { commandId: "22222222-2222-4222-8222-222222222222", expiresAt: "2099-01-01T00:00:00.000Z",
      destinationSourceIds: [sourceId], targetChoices: [{ ...request, choice: original.choice }] };
    const enabledIssue = { ...environment, CLIENT_ONBOARDING_INVITE_TARGET_CHOICES_ENABLED: "true",
      CLIENT_ONBOARDING_INVITE_TARGET_ISSUANCE_ENABLED: "true" };
    expect((await send("/api/client-onboarding/staff/create", "POST", command, csrf, enabledIssue)).status).toBe(200);
    expect(calls.issue.mock.calls.at(-1)?.[3]).toEqual([{ context, pin }]);
    calls.issue.mockClear();
    sqlite.exec("DELETE FROM native_directory_grants WHERE permission='directory.identity.link'");
    expect((await send("/api/client-onboarding/staff/create", "POST", command, csrf, enabledIssue)).status).toBe(403);
    expect(calls.issue).not.toHaveBeenCalled();
    expect(calls.reveal).not.toHaveBeenCalled();
    sqlite.exec("INSERT INTO native_directory_grants VALUES ('staff:onboarding','directory.identity.link',1,'allow','global',NULL,NULL,NULL)");
    sqlite.exec(`CREATE TABLE client_onboarding_invitations(invitation_id TEXT PRIMARY KEY,issued_by,bound_access_subject);
      CREATE TABLE client_onboarding_issuance_commands(invitation_id TEXT PRIMARY KEY,request_sha256,destination_intent_json,
        issuer_admission_version,issuer_profile_version);
      CREATE TABLE client_onboarding_handoffs(invitation_id TEXT PRIMARY KEY,request_sha256);
      CREATE TABLE client_onboarding_decisions(invitation_id TEXT PRIMARY KEY,outcome);`);
    sqlite.exec(readFileSync(new URL("./fixtures/client-onboarding-target-proofs.provisional.sql", import.meta.url), "utf8"));
    const pinHash = "a".repeat(64);
    const secondTarget = { ...request, sourceId: "project-alpha:primary" };
    const bothDestinations = [binding, { ...binding, sourceId: secondTarget.sourceId, divisionId: "division:d" }];
    const persist = async (invitationId: string, selected: unknown = [request], candidate = context, writeProof = true,
      destinations = bothDestinations) => {
      sqlite.exec("BEGIN");
      try {
        sqlite.prepare("INSERT INTO client_onboarding_invitations VALUES (?,?,?)").run(invitationId, actor.identity.staffId, actor.identity.verifiedAccessSubject);
        sqlite.prepare("INSERT INTO client_onboarding_issuance_commands VALUES (?,?,?,?,?,?)")
          .run(invitationId, pinHash, JSON.stringify(destinations), actor.admissionVersion, actor.identity.profileVersion, JSON.stringify(selected));
        if (writeProof) await inviteTargetProofStatement(fixtureDatabase.withSession("first-primary"), candidate, pin, invitationId, pinHash).run();
        sqlite.prepare("INSERT INTO client_onboarding_handoffs VALUES (?,?)").run(invitationId, pinHash);
        sqlite.exec("COMMIT");
      } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    };
    sqlite.exec("DELETE FROM native_directory_grants WHERE permission='directory.identity.link'");
    await expect(persist("no-identity-link")).rejects.toThrow();
    sqlite.exec("INSERT INTO native_directory_grants VALUES ('staff:onboarding','directory.identity.link',1,'allow','global',NULL,NULL,NULL)");
    await expect(persist("zero-intent", [])).rejects.toThrow("invalid target intent");
    await expect(persist("duplicate-intent", [request, request])).rejects.toThrow("invalid target intent");
    await expect(persist("not-invited", [secondTarget], context, false, [binding])).rejects.toThrow("invalid target intent");
    await expect(persist("missing-set", [request, secondTarget], context, false)).rejects.toThrow("incomplete target proof set");
    await expect(persist("partial-set", [request, secondTarget])).rejects.toThrow("incomplete target proof set");
    await expect(persist("wrong-proof-source", [secondTarget])).rejects.toThrow("invalid target proof set");
    await expect(persist("wrong-target", [{ ...request, publicId: "4".repeat(32) }])).rejects.toThrow("invalid target proof set");
    await expect(persist("wrong-instance", [request], { ...context, source: { ...context.source, instance: applicationId } })).rejects.toThrow();
    sqlite.exec("UPDATE operations_directory_records SET current_version=2 WHERE record_id='local:client'; INSERT INTO operations_directory_revisions VALUES ('local:client',2,'{}')");
    await expect(persist("stale-record")).rejects.toThrow();
    sqlite.exec("UPDATE operations_directory_records SET current_version=1 WHERE record_id='local:client'");
    sqlite.exec("UPDATE native_staff_admissions SET version=3");
    await expect(persist("stale-actor")).rejects.toThrow();
    sqlite.exec("UPDATE native_staff_admissions SET version=2; UPDATE operations_directory_client_organizations SET relationship_version=3");
    await expect(persist("stale-relation")).rejects.toThrow();
    sqlite.exec("UPDATE operations_directory_client_organizations SET relationship_version=2");
    for (const table of ["client_onboarding_invitations", "client_onboarding_issuance_commands", "client_onboarding_target_proofs", "client_onboarding_handoffs"])
      expect(sqlite.prepare(`SELECT count(*) total FROM ${table}`).get()?.total).toBe(0);
    await persist("exact-target");
    const replay = await inviteTargetProofStatement(fixtureDatabase.withSession("first-primary"), context, pin, "exact-target", pinHash).run();
    expect(replay.meta.changes).toBe(0);
    expect(() => sqlite.exec("INSERT INTO client_onboarding_decisions VALUES ('exact-target','approved')")).toThrow("target-aware approval unavailable");
    sqlite.exec(`INSERT INTO client_onboarding_issuance_commands
      (invitation_id,request_sha256,destination_intent_json,issuer_admission_version,issuer_profile_version)
      VALUES ('legacy','${pinHash}',NULL,2,1);
      INSERT INTO client_onboarding_handoffs VALUES ('legacy','${pinHash}');
      INSERT INTO client_onboarding_decisions VALUES ('legacy','approved');`);
    expect(await (await lookup({}, { ...request, kind: "organization", publicId: "3".repeat(32) })).json())
      .toEqual({ choice: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect((await lookup({}, { ...request, sourceId: "project-alpha:primary" })).status).toBe(403);
    expect((await lookup({ PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { [sourceId]:
      { ...configuration, historyEpoch: "d0000000-0000-4000-8000-000000000004" } } }) })).status).toBe(403);
    sqlite.exec("UPDATE operations_directory_client_organizations SET relationship_version=3");
    expect(await verify()).toBeNull();
    expect(await (await lookup()).json()).not.toEqual(original);
    sqlite.exec("UPDATE native_directory_grants SET scope_kind='resource',resource_id='local:client' WHERE permission='directory.profile.edit'");
    expect((await lookup()).status).toBe(403);
    sqlite.exec("UPDATE native_directory_grants SET scope_kind='global',resource_id=NULL WHERE permission='directory.profile.edit'");
    sqlite.exec("INSERT INTO native_directory_grants VALUES ('staff:onboarding','directory.profile.view',1,'deny','resource','local:org',NULL,NULL)");
    expect((await lookup()).status).toBe(403);
    sqlite.exec("DELETE FROM native_directory_grants WHERE effect='deny'; INSERT INTO project_alpha_active_directory_mappings SELECT * FROM project_alpha_active_directory_mappings WHERE resource_type='client'");
    expect((await lookup()).status).toBe(403);
    const quota = sqlite.prepare("SELECT rate_key,request_count,request_limit FROM native_staff_onboarding_rate_limits").all();
    expect(quota).toEqual([{ rate_key: expect.stringMatching(/^subject:[A-Za-z0-9_-]{43}$/), request_count: 11, request_limit: 20 }]);
    sqlite.exec("UPDATE native_staff_onboarding_rate_limits SET request_count=20,window_bucket=CAST(unixepoch('now') / 60 AS INTEGER)");
    expect((await lookup()).status).toBe(429);
    const searchPath = "/api/client-onboarding/staff/target-search";
    const searchBody = { sourceId, kind: "client", query: "Fixture", cursor: null as string | null };
    const search = (overrides: Partial<typeof searchBody> = {}) => send(searchPath, "POST", { ...searchBody, ...overrides }, csrf, enabledIssue);
    expect((await search()).status).toBe(429);
    sqlite.exec("UPDATE native_staff_onboarding_rate_limits SET request_count=0");
    expect((await send(searchPath, "POST", searchBody, csrf, environment)).status).toBe(404);
    expect((await send(searchPath, "POST", searchBody, undefined, enabledIssue)).status).toBe(403);
    expect((await search({ query: "x" })).status).toBe(400);
    expect((await search({ sourceId: "project-alpha:primary" })).status).toBe(403);
    expect(await (await search()).json()).toEqual({ targets: [], nextCursor: null }); // Duplicate exact mapping.
    sqlite.exec("DELETE FROM project_alpha_active_directory_mappings WHERE rowid=(SELECT max(rowid) FROM project_alpha_active_directory_mappings)");
    const addMapping = sqlite.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES (?,?,?,?,?,?,?,?,'mapping:test-extra')");
    for (const [recordId, externalId, candidateId] of [
      ["local:other", "external:other", publicId],
      ["local:client", "external:other", "5".repeat(32)],
      ["local:other", "local:client", "5".repeat(32)],
    ] as const) {
      addMapping.run(sourceId, sourceInstanceId, applicationId, historyEpoch, recordId, externalId, "client", candidateId);
      expect(await (await search()).json()).toEqual({ targets: [], nextCursor: null });
      sqlite.exec("DELETE FROM project_alpha_active_directory_mappings WHERE provenance_id='mapping:test-extra'");
    }
    addMapping.run(sourceId, sourceInstanceId, applicationId, historyEpoch, "local:other", "local:org", "organization", "5".repeat(32));
    expect(await (await search()).json()).toEqual({ targets: [], nextCursor: null }); // The linked parent has an ambiguous mapping.
    sqlite.exec("DELETE FROM project_alpha_active_directory_mappings WHERE provenance_id='mapping:test-extra'");
    addMapping.run(sourceId, sourceInstanceId, applicationId, historyEpoch, "local:other", null, "client", "5".repeat(32));
    addMapping.run(sourceId, sourceInstanceId, applicationId, historyEpoch, "local:other", "local:client", "organization", publicId);
    addMapping.run(sourceId, sourceInstanceId, applicationId, "d0000000-0000-4000-8000-000000000004", "local:client", "local:client", "client", publicId);
    sqlite.exec("INSERT INTO native_directory_grants VALUES ('staff:onboarding','directory.profile.view',1,'deny','resource','local:org',NULL,NULL)");
    expect(await (await search()).json()).toEqual({ targets: [], nextCursor: null });
    sqlite.exec("DELETE FROM native_directory_grants WHERE effect='deny'");
    sqlite.exec("DELETE FROM native_directory_grants WHERE permission='directory.identity.link'");
    expect(await (await search()).json()).toEqual({ targets: [], nextCursor: null });
    sqlite.exec("INSERT INTO native_directory_grants VALUES ('staff:onboarding','directory.identity.link',1,'allow','global',NULL,NULL,NULL)");
    sqlite.exec("INSERT INTO native_directory_grants VALUES ('staff:onboarding','directory.identity.link',1,'deny','resource','local:org',NULL,NULL)");
    expect(await (await search()).json()).toEqual({ targets: [], nextCursor: null });
    sqlite.exec("DELETE FROM native_directory_grants WHERE effect='deny'");
    const first = await search({ query: "  fixture  " });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({
      targets: [{ sourceId, kind: "client", publicId, displayName: "Sensitive fixture" }], nextCursor: null,
    });
    sqlite.exec("DELETE FROM project_alpha_active_directory_mappings WHERE provenance_id='mapping:test-extra'");
    const seed = (ordinal: number, relationship: boolean, mappingEpoch = historyEpoch) => {
      const recordId = `local:search:${ordinal}`, candidateId = (ordinal + 100).toString(16).padStart(32, "a");
      sqlite.prepare("INSERT INTO operations_directory_records VALUES (?,1,'client')").run(recordId);
      sqlite.prepare("INSERT INTO operations_directory_lifecycle_state VALUES (?,'active')").run(recordId);
      sqlite.prepare("INSERT INTO operations_directory_revisions VALUES (?,1,?)").run(recordId, JSON.stringify({ name: "Fixture client", email: "private@example.test" }));
      sqlite.prepare("INSERT INTO native_directory_resource_scopes VALUES (?,1,'area:t','division:t')").run(recordId);
      sqlite.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES (?,?,?,?,?,?,'client',?,?)")
        .run(sourceId, sourceInstanceId, applicationId, mappingEpoch, recordId, recordId, candidateId, `mapping:${recordId}`);
      sqlite.prepare("INSERT INTO effective_native_directory_enrollments VALUES (?,?,?)").run(recordId,
        JSON.stringify([{ sourceId, sourceInstanceUUID: sourceInstanceId, applicationUUID: applicationId, historyEpoch: mappingEpoch,
          externalCanonicalId: recordId }]), `enrollment:${recordId}`);
      if (relationship) sqlite.prepare("INSERT INTO operations_directory_client_organizations VALUES (?,NULL,1)").run(recordId);
      return candidateId;
    };
    const candidates = Array.from({ length: 13 }, (_, i) => seed(i, true));
    seed(13, false);
    seed(14, true, "d0000000-0000-4000-8000-000000000004");
    const found = await search();
    expect(found.status).toBe(200);
    const { targets, nextCursor } = await found.json() as { targets: unknown[]; nextCursor: string };
    const row = (id: string, displayName = "Fixture client") => ({ sourceId, kind: "client", publicId: id, displayName });
    expect(targets).toEqual([row(publicId, "Sensitive fixture"), ...candidates.slice(0, 11).map(id => row(id))]);
    expect(nextCursor).toMatch(/^[a-f0-9]{32}\.[a-f0-9]{64}$/);
    expect((await search({ cursor: nextCursor, query: "client" })).status).toBe(403);
    expect((await search({ cursor: nextCursor, kind: "organization" })).status).toBe(403);
    expect(await (await search({ kind: "organization" })).json()).toEqual({
      targets: [{ sourceId, kind: "organization", publicId: "3".repeat(32), displayName: "Sensitive fixture" }], nextCursor: null,
    });
    expect(await (await search({ cursor: nextCursor })).json()).toEqual({ targets: candidates.slice(11).map(id => row(id)), nextCursor: null });
    sqlite.prepare("INSERT INTO native_directory_grants VALUES ('staff:onboarding','directory.profile.view',1,'deny','resource',?,NULL,NULL)")
      .run("local:search:11");
    expect(await (await search({ cursor: nextCursor })).json()).toEqual({ targets: [row(candidates[12]!)], nextCursor: null });
    sqlite.exec("DROP TABLE native_staff_onboarding_rate_limits");
    expect((await lookup()).status).toBe(503);
    expect((await send("/api/client-onboarding/staff/create", "POST", {
      commandId: "22222222-2222-4222-8222-222222222222", expiresAt: "2099-01-01T00:00:00.000Z",
      destinationSourceIds: [sourceId], targetChoices: [{ ...request, choice: original.choice }],
    }, csrf, environment)).status).toBe(404);
    expect(calls.issue).not.toHaveBeenCalled();
  } finally { sqlite.close(); }
});

beforeEach(() => {
  calls.legacy.mockReset().mockRejectedValue(new HTTPException(401, { message: "legacy denied" }));
  calls.native.mockReset().mockResolvedValue(actor);
  calls.issue.mockReset().mockResolvedValue({ invitationId: "11111111-1111-4111-8111-111111111111",
    expiresAt: "2099-01-01T00:00:00.000Z", requestSha256: "c".repeat(64), state: "pending" });
  calls.reveal.mockReset().mockResolvedValue({ commandId: "22222222-2222-4222-8222-222222222222",
    invitationId: "11111111-1111-4111-8111-111111111111", expiresAt: "2099-01-01T00:00:00.000Z",
    invitationSecret: "d".repeat(64) });
  calls.inbox.mockReset().mockResolvedValue({ submissions: [], nextCursor: null });
  calls.review.mockReset().mockResolvedValue({
    invitationId: "11111111-1111-4111-8111-111111111111",
    submissionId: "33333333-3333-4333-8333-333333333333", fieldsSha256: "e".repeat(64),
    submittedAt: "2098-01-01T00:00:00.000Z", targetClientRecordId: null,
    scopes: [{ businessAreaId: "area:onboarding", divisionId: null }],
    fields: { clientType: "consumer", name: "Client", email: "client@example.test", phone: "",
      organizationName: "", organizationEmail: "", organizationPhone: "", addressLine1: "1 Main",
      addressLine2: "", city: "Town", state: "TX", postalCode: "75001", country: "US" },
  });
  calls.approve.mockReset().mockResolvedValue({ status: "written", replayed: false,
    decisionId: "44444444-4444-4444-8444-444444444444",
    invitationId: "11111111-1111-4111-8111-111111111111",
    submissionId: "33333333-3333-4333-8333-333333333333",
    clientRecordId: "55555555-5555-4555-8555-555555555555",
    clientRecordVersion: 1, relationshipVersion: 1 });
  calls.sharedPlan.mockReset().mockResolvedValue({planId:"55555555-5555-4555-8555-555555555555",state:"reviewed",approvalAvailable:false});
  calls.sharedApprove.mockReset();
  calls.sharedChoices.mockReset().mockResolvedValue({companies:[],nextAfterGroupId:null,approvalAvailable:false});
  calls.existingCompanies.mockReset().mockResolvedValue({companies:[],nextAfterRecordId:null,existingContactReuse:"unsupported"});
  calls.enrollmentChoices.mockReset().mockResolvedValue({ sourceIds: ["project-alpha:primary"] });
  calls.scopeChoices.mockReset().mockResolvedValue({ scopes: [{ businessAreaId: "area:onboarding", name: "Drone Services",
    allowAreaWide: false, divisions: [{ divisionId: "division:onboarding", name: "Greenleaf" }] }] });
});

describe("native client onboarding staff route", () => {
  it("finishes an old-origin onboarding intent after canonical Ops config changes without rebinding its origin signature", async () => {
    const before = env();
    const oldCsrf = await session(before);
    const command = { commandId: "22222222-2222-4222-8222-222222222222",
      expiresAt: "2099-01-01T00:00:00.000Z", targetClientRecordId: null,
      scopes: [{ businessAreaId: "area:onboarding", divisionId: null }] };
    const created = await send("/api/client-onboarding/staff/create", "POST", command, oldCsrf, before);
    expect(created.status).toBe(200);
    expect(calls.issue).toHaveBeenCalledOnce();

    const after = { ...before, PUBLIC_BASE_URL: canonicalOrigin, EXPECTED_HOST: "ops.ledgetop.app",
      CLIENT_ONBOARDING_ADMIN_ORIGIN: canonicalOrigin,
      OPERATIONS_ORIGINS: `${canonicalOrigin},${origin}` } as Env;
    const revealPath = "/api/client-onboarding/staff/reveal";
    const revealed = await send(revealPath, "POST", { commandId: command.commandId }, oldCsrf, after);
    expect(revealed.status).toBe(200);
    expect(calls.reveal).toHaveBeenCalledWith(database, { authenticatedNativeStaff: {
      identity: actor.identity, verifiedUntil: actor.verifiedUntil,
    }, commandId: command.commandId }, keyring);
    expect(calls.issue).toHaveBeenCalledOnce();

    const movedCsrf = await session(after, canonicalOrigin, canonicalOrigin);
    const movedReveal = await send(revealPath, "POST", { commandId: command.commandId }, movedCsrf,
      after, canonicalOrigin, canonicalOrigin);
    expect(movedReveal.status).toBe(200);
    expect(calls.issue).toHaveBeenCalledOnce();

    const oldTokenOnNewOrigin = await send(revealPath, "POST", { commandId: command.commandId }, oldCsrf,
      after, canonicalOrigin, canonicalOrigin);
    expect(oldTokenOnNewOrigin.status).toBe(403);
    expect(calls.reveal).toHaveBeenCalledTimes(2);

    const refresh = await worker.fetch(new Request(`${origin}/clients?view=list`, { headers: {
      Accept: "text/html", "Sec-Fetch-Dest": "document", "Sec-Fetch-Mode": "navigate",
      Cookie: "CF_Authorization=old-host-session",
    } }), after, context);
    expect(refresh.status).toBe(302);
    expect(refresh.headers.get("Location")).toBe(`${canonicalOrigin}/clients?view=list`);
    expect(refresh.headers.get("Set-Cookie")).toBeNull();
  });
  it("matches scope choices only at the exact POST route", () => {
    const path = "/api/client-onboarding/staff/scope-choices";
    expect(clientOnboardingStaffHttpRequest("POST", path)).toBe("scope-choices");
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE"])
      expect(clientOnboardingStaffHttpRequest(method, path)).toBeNull();
    expect(clientOnboardingStaffHttpRequest("POST", `${path}/`)).toBeNull();
  });
  it("reads named scope choices only through strict native-staff Origin and CSRF checks", async () => {
    const path = "/api/client-onboarding/staff/scope-choices";
    expect((await send(path, "POST", {}, undefined, env("false"))).status).toBe(404);
    expect(calls.native).not.toHaveBeenCalled();
    expect((await send(path, "POST", {}, "bad")).status).toBe(403);
    expect(calls.scopeChoices).not.toHaveBeenCalled();
    const csrf = await session();
    expect((await send(path, "POST", {}, csrf, env(), "https://other.example.test")).status).toBe(403);
    expect((await send(path, "POST", { staffId: "another-staff" }, csrf)).status).toBe(400);
    expect(calls.scopeChoices).not.toHaveBeenCalled();
    const reply = await send(path, "POST", {}, csrf);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual(await calls.scopeChoices.mock.results[0]?.value);
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
    expect(calls.scopeChoices).toHaveBeenCalledWith(database, actor);
    expect(calls.legacy).not.toHaveBeenCalled();
    expect(calls.issue).not.toHaveBeenCalled();
    expect(calls.reveal).not.toHaveBeenCalled();
  });

  it("collapses revoked scope authority to denial and refuses incomplete scope inventories", async () => {
    const csrf = await session(), path = "/api/client-onboarding/staff/scope-choices";
    calls.scopeChoices.mockRejectedValueOnce(Error("client_onboarding_scope_choices_denied"));
    const denied = await send(path, "POST", {}, csrf);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "client_onboarding_denied" });
    calls.scopeChoices.mockRejectedValueOnce(Error("client_onboarding_scope_choices_unavailable"));
    const unavailable = await send(path, "POST", {}, csrf);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "client_onboarding_unavailable" });
    calls.native.mockRejectedValueOnce(Error("revoked"));
    expect((await send(path, "POST", {}, csrf)).status).toBe(403);
    expect(calls.scopeChoices).toHaveBeenCalledTimes(2);
  });

  it("is absent by default before either authentication stack", async () => {
    expect((await send("/api/client-onboarding/staff/session", "GET", undefined, undefined, env("false"))).status).toBe(404);
    expect(calls.native).not.toHaveBeenCalled();
    expect(calls.legacy).not.toHaveBeenCalled();
  });

  it("rejects wrong origin and invalid CSRF before issuing", async () => {
    expect((await send("/api/client-onboarding/staff/session", "GET", undefined, undefined, env(),
      "https://evil.example.test")).status).toBe(403);
    const command = { commandId: "22222222-2222-4222-8222-222222222222",
      expiresAt: "2099-01-01T00:00:00.000Z", targetClientRecordId: null,
      scopes: [{ businessAreaId: "area:onboarding", divisionId: null }] };
    expect((await send("/api/client-onboarding/staff/create", "POST", command, "bad")).status).toBe(403);
    expect(calls.issue).not.toHaveBeenCalled();
    expect(calls.legacy).not.toHaveBeenCalled();
  });

  it("creates metadata only and reveals separately through audited service", async () => {
    const csrf = await session();
    const command = { commandId: "22222222-2222-4222-8222-222222222222",
      expiresAt: "2099-01-01T00:00:00.000Z", targetClientRecordId: null,
      scopes: [{ businessAreaId: "area:onboarding", divisionId: null }] };
    const created = await send("/api/client-onboarding/staff/create", "POST", command, csrf);
    expect(created.status).toBe(200);
    const createText = await created.text();
    expect(createText).not.toContain("invitationSecret");
    expect(createText).not.toContain("d".repeat(64));
    expect(created.headers.get("Cache-Control")).toBe("no-store");
    const handoffActor = { identity: actor.identity, verifiedUntil: actor.verifiedUntil };
    expect(calls.issue).toHaveBeenCalledWith(database, { authenticatedNativeStaff: handoffActor,
      request: command }, keyring);
    const revealed = await send("/api/client-onboarding/staff/reveal", "POST",
      { commandId: command.commandId }, csrf);
    expect(revealed.status).toBe(200);
    expect(await revealed.json()).toMatchObject({ invitationSecret: "d".repeat(64),
      recipientUrl: `https://portal.example.test/onboarding/11111111-1111-4111-8111-111111111111#${"d".repeat(64)}` });
    expect(revealed.headers.get("Cache-Control")).toBe("no-store");
    expect(revealed.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(calls.reveal).toHaveBeenCalledWith(database, { authenticatedNativeStaff: handoffActor,
      commandId: command.commandId }, keyring);
    expect(calls.issue.mock.calls[0]?.[1].authenticatedNativeStaff).not.toHaveProperty("admissionVersion");
    expect(calls.reveal.mock.calls[0]?.[1].authenticatedNativeStaff).not.toHaveProperty("admissionVersion");
    expect(calls.legacy).not.toHaveBeenCalled();
  });

  it("fails closed when current grant authority is revoked", async () => {
    const csrf = await session();
    calls.issue.mockRejectedValueOnce(Error("client_onboarding_handoff_issue_denied"));
    const reply = await send("/api/client-onboarding/staff/create", "POST", {
      commandId: "22222222-2222-4222-8222-222222222222", expiresAt: "2099-01-01T00:00:00.000Z",
      targetClientRecordId: null, scopes: [{ businessAreaId: "area:onboarding", divisionId: null }],
    }, csrf);
    expect(reply.status).toBe(403);
    expect(await reply.json()).toEqual({ error: "client_onboarding_denied" });
    expect(calls.reveal).not.toHaveBeenCalled();
  });

  it("returns committed create and reveal results when authentication expires during the service call", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date("2098-01-01T00:00:00.000Z");
      vi.setSystemTime(startedAt);
      calls.native.mockResolvedValue({ ...actor,
        verifiedUntil: new Date(startedAt.getTime() + 500).toISOString() });
      const csrf = await session();
      const command = { commandId: "22222222-2222-4222-8222-222222222222",
        expiresAt: "2099-01-01T00:00:00.000Z", targetClientRecordId: null,
        scopes: [{ businessAreaId: "area:onboarding", divisionId: null }] };
      calls.issue.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(startedAt.getTime() + 1_000));
        return { invitationId: "11111111-1111-4111-8111-111111111111",
          expiresAt: command.expiresAt, requestSha256: "c".repeat(64), state: "pending" };
      });
      expect((await send("/api/client-onboarding/staff/create", "POST", command, csrf)).status).toBe(200);

      vi.setSystemTime(startedAt);
      calls.reveal.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(startedAt.getTime() + 1_000));
        return { commandId: command.commandId, invitationId: "11111111-1111-4111-8111-111111111111",
          expiresAt: command.expiresAt, invitationSecret: "d".repeat(64) };
      });
      expect((await send("/api/client-onboarding/staff/reveal", "POST",
        { commandId: command.commandId }, csrf)).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });

  it("returns only authorized immutable submission details with no-store", async () => {
    const csrf = await session();
    const submissionId = "33333333-3333-4333-8333-333333333333";
    const reply = await send("/api/client-onboarding/staff/review", "POST", { submissionId }, csrf);
    expect(reply.status).toBe(200);
    const text = await reply.text();
    expect(text).toContain(submissionId);
    expect(text).not.toContain("invitationSecret");
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
    expect(reply.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(calls.review).toHaveBeenCalledWith(database, actor, submissionId);
    expect(calls.issue).not.toHaveBeenCalled();
    expect(calls.reveal).not.toHaveBeenCalled();
  });

  it("requires CSRF and collapses out-of-scope review to denial", async () => {
    const submissionId = "33333333-3333-4333-8333-333333333333";
    expect((await send("/api/client-onboarding/staff/review", "POST", { submissionId }, "bad")).status).toBe(403);
    expect(calls.review).not.toHaveBeenCalled();
    const csrf = await session();
    calls.review.mockRejectedValueOnce(Error("client_onboarding_review_denied"));
    const denied = await send("/api/client-onboarding/staff/review", "POST", { submissionId }, csrf);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "client_onboarding_denied" });
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
  });

  it("approves through the server-owned native-only command and returns no authority material", async () => {
    const csrf = await session(), submissionId = "33333333-3333-4333-8333-333333333333";
    const reply = await send("/api/client-onboarding/staff/approve", "POST",
      { submissionId, fieldsSha256: "e".repeat(64) }, csrf);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ decisionId: "44444444-4444-4444-8444-444444444444",
      submissionId, clientRecordId: "55555555-5555-4555-8555-555555555555",
      clientRecordVersion: 1, relationshipVersion: 1, replayed: false });
    expect(calls.approve).toHaveBeenCalledWith(database, actor, submissionId, "e".repeat(64), [], undefined, undefined, undefined);
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
  });

  it("refuses crafted ordinary decision requests for a recorded target before a decision writer runs", async () => {
    const ordinary = await vi.importActual<typeof import("../src/worker/client-onboarding-approval")>("../src/worker/client-onboarding-approval");
    const plan = await vi.importActual<typeof import("../src/worker/client-onboarding-shared-company-plan")>("../src/worker/client-onboarding-shared-company-plan");
    const shared = await vi.importActual<typeof import("../src/worker/client-onboarding-shared-company-approval")>("../src/worker/client-onboarding-shared-company-approval");
    const withSession = vi.fn(unavailable);
    const environment = { ...env(), OPS_DB: { ...database, withSession } };
    const csrf = await session(environment), submissionId = "33333333-3333-4333-8333-333333333333";
    const decision = { submissionId, fieldsSha256: "e".repeat(64) };
    calls.review.mockResolvedValue({ ...decision, targetClientRecordId: null, targetApprovalPending: true, fields: { clientType: "business" } });
    calls.approve.mockImplementationOnce(ordinary.approveNewNativeOnlyClientOnboarding);
    calls.sharedPlan.mockImplementationOnce(plan.prepareClientOnboardingSharedCompanyPlan);
    calls.sharedApprove.mockImplementationOnce(shared.approveClientOnboardingSharedCompany);
    const commandId = "55555555-5555-4555-8555-555555555555";
    const organizationSelection = { kind: "shared_existing", groupId: "11111111-1111-4111-8111-111111111111", expectedVersion: 1,
      members: [{ recordId: "company:a", expectedVersion: 1 }, { recordId: "company:b", expectedVersion: 1 }] };
    for (const [route, payload] of [
      ["approve", { ...decision, sourceIds: [], organizationSelection: { kind: "new" } }],
      ["shared-company-plan", { ...decision, commandId, organizationSelection, sourceIds: ["project-alpha:primary"] }],
      ["approve-shared-company", { ...decision, planId: commandId }],
    ] as const) {
      const response = await send(`/api/client-onboarding/staff/${route}`, "POST", payload, csrf, environment);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "client_onboarding_denied" });
    }
    expect(calls.review).toHaveBeenCalledTimes(3);
    expect(withSession).not.toHaveBeenCalled();
  });

  it("returns the committed approval receipt when access expires after the atomic write", async () => {
    const now = Date.now(), boundaryActor = { ...actor,
      verifiedUntil: new Date(now + 60_000).toISOString() };
    calls.native.mockResolvedValue(boundaryActor);
    const csrf = await session(), submissionId = "33333333-3333-4333-8333-333333333333";
    const clock = vi.spyOn(Date, "now");
    calls.approve.mockImplementationOnce(async () => {
      clock.mockReturnValue(now + 60_001);
      return { status: "written", replayed: false,
        decisionId: "44444444-4444-4444-8444-444444444444",
        invitationId: "11111111-1111-4111-8111-111111111111", submissionId,
        clientRecordId: "55555555-5555-4555-8555-555555555555",
        clientRecordVersion: 1, relationshipVersion: 1 };
    });
    try {
      const reply = await send("/api/client-onboarding/staff/approve", "POST",
        { submissionId, fieldsSha256: "e".repeat(64) }, csrf);
      expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({ submissionId,
        clientRecordId: "55555555-5555-4555-8555-555555555555" });
    } finally { clock.mockRestore(); }
  });

  it("requires exact approval input, CSRF, and current server authority", async () => {
    const csrf = await session(), submissionId = "33333333-3333-4333-8333-333333333333";
    expect((await send("/api/client-onboarding/staff/approve", "POST",
      { submissionId, fieldsSha256: "e".repeat(64) }, "bad")).status).toBe(403);
    expect(calls.approve).not.toHaveBeenCalled();
    expect((await send("/api/client-onboarding/staff/approve", "POST",
      { submissionId, fieldsSha256: "e".repeat(64), recordId: "caller-owned" }, csrf)).status).toBe(400);
    expect((await send("/api/client-onboarding/staff/approve", "POST",
      { submissionId, fieldsSha256: "e".repeat(64), sourceIds: ["project-alpha:primary", "project-alpha:primary"] }, csrf)).status).toBe(400);
    expect(calls.approve).not.toHaveBeenCalled();
    calls.approve.mockRejectedValueOnce(Error("client_onboarding_approval_denied"));
    const denied = await send("/api/client-onboarding/staff/approve", "POST",
      { submissionId, fieldsSha256: "e".repeat(64) }, csrf);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "client_onboarding_denied" });
  });

  it("accepts an explicit empty or canonical enrollment selection and passes server config to approval", async () => {
    const csrf = await session();
    const submissionId = "33333333-3333-4333-8333-333333333333";
    const fieldsSha256 = "e".repeat(64);
    const empty = await send("/api/client-onboarding/staff/approve", "POST",
      { submissionId, fieldsSha256, sourceIds: [] }, csrf);
    expect(empty.status).toBe(200);
    expect(calls.approve).toHaveBeenCalledWith(database, actor, submissionId, fieldsSha256, [], undefined, undefined, undefined);

    calls.approve.mockClear();
    const configured = { ...env(), PROJECT_ALPHA_API_V2_CONNECTIONS: "server-owned-config" } as Env;
    const selectedSourceIds = ["project-alpha:primary", "project-alpha:secondary"];
    const selected = await send("/api/client-onboarding/staff/approve", "POST",
      { submissionId, fieldsSha256, sourceIds: selectedSourceIds }, csrf, configured);
    expect(selected.status).toBe(200);
    expect(calls.approve).toHaveBeenCalledWith(database, actor, submissionId, fieldsSha256,
      selectedSourceIds, "server-owned-config", undefined, undefined);
  });

  it("discovers only server-configured enrollment choices through the native CSRF boundary", async () => {
    const csrf = await session();
    const request = { submissionId: "11111111-1111-4111-8111-111111111111" };
    const reply = await send("/api/client-onboarding/staff/enrollment-choices", "POST", request, csrf);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ sourceIds: ["project-alpha:primary"] });
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
    expect(calls.enrollmentChoices).toHaveBeenCalledWith(database,
      { PROJECT_ALPHA_API_V2_CONNECTIONS: undefined }, actor, request);
    expect(calls.legacy).not.toHaveBeenCalled();
    expect(calls.issue).not.toHaveBeenCalled();
    expect(calls.reveal).not.toHaveBeenCalled();
  });

  it("rejects malformed or CSRF-invalid enrollment discovery before the read service", async () => {
    const csrf = await session();
    const request = { submissionId: "11111111-1111-4111-8111-111111111111" };
    expect((await send("/api/client-onboarding/staff/enrollment-choices", "POST", request, "bad")).status).toBe(403);
    expect((await send("/api/client-onboarding/staff/enrollment-choices", "POST", { ...request, scopes: [] }, csrf)).status).toBe(400);
    expect(calls.enrollmentChoices).not.toHaveBeenCalled();
  });

  it("does not expose deployment configuration failures from enrollment discovery", async () => {
    const csrf = await session();
    calls.enrollmentChoices.mockRejectedValueOnce(Error("client_onboarding_enrollment_discovery_unavailable"));
    const reply = await send("/api/client-onboarding/staff/enrollment-choices", "POST", {
      submissionId: "11111111-1111-4111-8111-111111111111",
    }, csrf);
    expect(reply.status).toBe(503);
    expect(await reply.json()).toEqual({ error: "client_onboarding_unavailable" });
  });

  it("lists authorized submissions through the native CSRF boundary", async () => {
    const csrf = await session();
    const reply = await send("/api/client-onboarding/staff/inbox", "POST", { cursor: null }, csrf);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ submissions: [], nextCursor: null });
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
    expect(calls.inbox).toHaveBeenCalledWith(database, actor, null);
    expect(calls.legacy).not.toHaveBeenCalled();
    calls.inbox.mockClear();
    expect((await send("/api/client-onboarding/staff/inbox", "POST", { cursor: null }, "bad")).status).toBe(403);
    expect((await send("/api/client-onboarding/staff/inbox", "POST", { cursor: null, staffId: "other" }, csrf)).status).toBe(400);
    expect(calls.inbox).not.toHaveBeenCalled();
  });

  it("reserves the exact namespace and leaves unrelated API paths to legacy auth", async () => {
    expect((await send("/api/client-onboarding/staff/create/extra", "POST", {}, "bad")).status).toBe(404);
    expect(calls.native).not.toHaveBeenCalled();
    expect(calls.legacy).not.toHaveBeenCalled();
    expect((await send("/api/session")).status).toBe(401);
    expect(calls.legacy).toHaveBeenCalledOnce();
  });
  it("requires native CSRF for existing-company review and carries only an exact explicit selection into approval",async()=>{
    const csrf=await session(),submissionId="33333333-3333-4333-8333-333333333333";
    const input={submissionId,sourceIds:["project-alpha:primary"],query:"Example",afterRecordId:null};
    expect((await send("/api/client-onboarding/staff/existing-companies","POST",input,"bad")).status).toBe(403);
    expect(calls.existingCompanies).not.toHaveBeenCalled();
    expect((await send("/api/client-onboarding/staff/existing-companies","POST",input,csrf)).status).toBe(200);
    expect(calls.existingCompanies).toHaveBeenCalledWith(database,actor,input);
    const organizationSelection={kind:"existing",recordId:"company:exact",expectedVersion:4};
    expect((await send("/api/client-onboarding/staff/approve","POST",{submissionId,fieldsSha256:"e".repeat(64),sourceIds:[],organizationSelection},csrf)).status).toBe(200);
    expect(calls.approve).toHaveBeenCalledWith(database,actor,submissionId,"e".repeat(64),[],undefined,organizationSelection,undefined);
    expect((await send("/api/client-onboarding/staff/approve","POST",{submissionId,fieldsSha256:"e".repeat(64),sourceIds:[],organizationSelection:{...organizationSelection,email:"inferred@example.test"}},csrf)).status).toBe(400);
  });

  it("prepares native CSRF-protected grouped review evidence without exposing an approval or bearer capability",async()=>{
    const csrf=await session(),submissionId="33333333-3333-4333-8333-333333333333";
    const organizationSelection={kind:"shared_existing",groupId:"11111111-1111-4111-8111-111111111111",expectedVersion:1,
      members:[{recordId:"company:a",expectedVersion:1},{recordId:"company:b",expectedVersion:1}]};
    const input={commandId:"55555555-5555-4555-8555-555555555555",submissionId,fieldsSha256:"e".repeat(64),sourceIds:["project-alpha:primary","project-alpha:secondary"],organizationSelection};
    expect((await send("/api/client-onboarding/staff/shared-company-plan","POST",input,"bad")).status).toBe(403);
    expect(calls.sharedPlan).not.toHaveBeenCalled();
    const reply=await send("/api/client-onboarding/staff/shared-company-plan","POST",input,csrf);
    expect(reply.status).toBe(200);expect(await reply.json()).toMatchObject({state:"reviewed",approvalAvailable:false});
    expect(calls.sharedPlan).toHaveBeenCalledWith(database,actor,input,undefined,undefined);
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
    expect((await send("/api/client-onboarding/staff/approve","POST",{submissionId,fieldsSha256:input.fieldsSha256,sourceIds:input.sourceIds,organizationSelection},csrf)).status).toBe(400);
    expect(calls.approve).not.toHaveBeenCalled();
    const choices={submissionId,sourceIds:input.sourceIds,query:"Example",afterGroupId:null};
    expect((await send("/api/client-onboarding/staff/shared-company-choices","POST",choices,csrf)).status).toBe(200);
    expect(calls.sharedChoices).toHaveBeenCalledWith(database,actor,choices);
  });

  it("approves a sealed shared-company review only through the native CSRF-protected exact plan endpoint",async()=>{
    const csrf=await session(),input={planId:"55555555-5555-4555-8555-555555555555",submissionId:"33333333-3333-4333-8333-333333333333",fieldsSha256:"e".repeat(64)};
    calls.sharedApprove.mockResolvedValue({decisionId:input.planId,members:[],portalActivation:"pending",replayed:false});
    expect((await send("/api/client-onboarding/staff/approve-shared-company","POST",input,"bad")).status).toBe(403);
    expect(calls.sharedApprove).not.toHaveBeenCalled();
    expect((await send("/api/client-onboarding/staff/approve-shared-company","POST",{...input,sourceIds:["project-alpha:primary"]},csrf)).status).toBe(400);
    expect(calls.sharedApprove).not.toHaveBeenCalled();
    const reply=await send("/api/client-onboarding/staff/approve-shared-company","POST",input,csrf);
    expect(reply.status).toBe(200);expect(await reply.json()).toMatchObject({decisionId:input.planId,portalActivation:"pending"});
    expect(calls.sharedApprove).toHaveBeenCalledWith(database,actor,input,undefined,undefined);
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
  });

});
