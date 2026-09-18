import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { planProjectAlphaProjectV2Command, type ProjectAlphaProjectV2CommandProducerAction } from "../src/worker/project-alpha-project-v2-command-producer";
import { dispatchProjectAlphaProjectV2PendingCommand } from "../src/worker/project-alpha-project-v2-pending-dispatcher";
import { settleProjectAlphaProjectV2Read } from "../src/worker/project-alpha-project-read-settlement-adapter";
import { activateProjectAlphaProjectV2Canonical } from "../src/worker/project-alpha-project-canonical-activation-adapter";

let runtime: Miniflare, db: D1Database, sequence = 0;
const uuid = () => `10000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, "0")}`;
const sourceOne = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", appOne = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", epochOne = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const sourceTwo = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", appTwo = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", epochTwo = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const sha = "a".repeat(64), until = "2999-01-01T00:00:00.000Z";

async function migrate(name: string) {
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}
function env(enabled = false) {
  return { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
    "project-alpha:one": { sourceId: "project-alpha:one", enabled, baseUrl: "https://one.example.test", apiKey: "one", sourceInstanceId: sourceOne, applicationId: appOne, historyEpoch: epochOne },
    "project-alpha:two": { sourceId: "project-alpha:two", enabled, baseUrl: "https://two.example.test", apiKey: "two", sourceInstanceId: sourceTwo, applicationId: appTwo, historyEpoch: epochTwo },
  } }) };
}
async function actor() {
  const staffId = `staff-${++sequence}`, accessSubject = `subject-${sequence}`, email = `${staffId}@example.test`;
  await db.batch([
    db.prepare("INSERT INTO native_staff_admissions VALUES(?,1,?,1)").bind(staffId, accessSubject),
    db.prepare("INSERT INTO native_staff_profiles VALUES(?,?,1)").bind(staffId, email),
    db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,granted_by)
      VALUES(?,?,'project.shared.sync','allow','global',?)`).bind(`grant-${staffId}`, staffId, staffId),
  ]);
  return { staffId, accessSubject, email, admissionVersion: 1, profileVersion: 1 };
}
async function directory(sourceId: string, sourceInstanceId: string, applicationId: string, historyEpochId: string) {
  const organizationRecordId = uuid(), clientRecordId = uuid(), organizationPublicId = crypto.randomUUID().replaceAll("-", ""), clientPublicId = crypto.randomUUID().replaceAll("-", "");
  await db.batch([
    db.prepare("INSERT INTO operations_directory_records(record_id,record_kind) VALUES(?,'organization')").bind(organizationRecordId),
    db.prepare("INSERT INTO operations_directory_records(record_id,record_kind) VALUES(?,'client')").bind(clientRecordId),
    db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
      VALUES(?,?,?,?,?,?,?)`).bind(sourceId, sourceInstanceId, applicationId, historyEpochId, "organization", organizationRecordId, organizationPublicId),
    db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
      VALUES(?,?,?,?,?,?,?)`).bind(sourceId, sourceInstanceId, applicationId, historyEpochId, "client", clientRecordId, clientPublicId),
    db.prepare("INSERT INTO operations_directory_client_organizations(client_record_id,organization_record_id) VALUES(?,?)").bind(clientRecordId, organizationRecordId),
  ]);
  return { organizationRecordId, clientRecordId, organizationPublicId, clientPublicId };
}
async function createAction(sourceId = "project-alpha:one"): Promise<Extract<ProjectAlphaProjectV2CommandProducerAction, { operation: "create" }>> {
  const sourceInstanceId = sourceId === "project-alpha:one" ? sourceOne : sourceTwo;
  const applicationId = sourceId === "project-alpha:one" ? appOne : appTwo;
  const historyEpochId = sourceId === "project-alpha:one" ? epochOne : epochTwo;
  const [staff, records] = await Promise.all([actor(), directory(sourceId, sourceInstanceId, applicationId, historyEpochId)]);
  return { sourceId, actor: { ...staff, verifiedUntil: until, scopes: [] }, operation: "create", local: { expectedLocalVersion: 0, expectedLocalProjectionSha256: null },
    directory: { organizationRecordId: records.organizationRecordId, clientRecordId: records.clientRecordId },
    command: { commandId: uuid(), externalId: `ops/project-${sequence}`, expectedAuthorizationGeneration: "0",
      project: { name: "Survey", description: null, estimatedStart: null, estimatedEnd: null },
      organization: { externalId: records.organizationRecordId, expectedPublicId: records.organizationPublicId, expectedRevision: "1", expectedProjectionSha256: sha },
      client: { externalId: records.clientRecordId, expectedPublicId: records.clientPublicId, expectedRevision: "1", expectedProjectionSha256: sha } },
  };
}
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": "11111111-1111-4111-8111-111111111111" } }); }
function transport(action: Extract<ProjectAlphaProjectV2CommandProducerAction, { operation: "create" }>) {
  const sourceInstanceId = action.sourceId === "project-alpha:one" ? sourceOne : sourceTwo;
  const applicationId = action.sourceId === "project-alpha:one" ? appOne : appTwo;
  const historyEpoch = action.sourceId === "project-alpha:one" ? epochOne : epochTwo;
  return vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== "POST") return response({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch,
      requestId: "11111111-1111-4111-8111-111111111111", grantedCapabilities: [{ name: "api.capabilities.read" }, { name: "projects.create" }],
      implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, { method: "POST", path: "/api/v2/projects/commands", requiredCapability: "projects.create", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }] });
    return response({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId: "11111111-1111-4111-8111-111111111111", replayed: false,
      result: { resource: { type: "project", id: action.command.externalId, publicId: "d".repeat(32), revision: "1", projectionSha256: sha }, authorizationGeneration: "1", presentation: { portalPublished: false, publicLinkEnabled: false } } }, 201);
  });
}
function readTransport(action: Extract<ProjectAlphaProjectV2CommandProducerAction, { operation: "create" }>) {
  const sourceInstanceId = action.sourceId === "project-alpha:one" ? sourceOne : sourceTwo;
  const applicationId = action.sourceId === "project-alpha:one" ? appOne : appTwo;
  const historyEpoch = action.sourceId === "project-alpha:one" ? epochOne : epochTwo, publicId = "d".repeat(32);
  return vi.fn<typeof fetch>(async (url) => {
    if (String(url).endsWith("/api/v2/capabilities")) return response({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch,
      requestId: "11111111-1111-4111-8111-111111111111", grantedCapabilities: [{ name: "api.capabilities.read" }, { name: "projects.v2.read" }],
      implementedEndpoints: [{ method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" }, { method: "GET", path: "/api/v2/projects/{publicId}", requiredCapability: "projects.v2.read", requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true }] });
    return response({ apiVersion: "2", sourceInstanceId, applicationId, historyEpoch, requestId: "11111111-1111-4111-8111-111111111111", replayed: false, accepted: true,
      resource: { type: "project", id: publicId, revision: "1", projectionSha256: sha }, data: { name: action.command.project.name, description: action.command.project.description,
        status: "active", archived: false, overdueWarning: false, completedAt: null, archivedAt: null, estimatedStart: action.command.project.estimatedStart,
        estimatedEnd: action.command.project.estimatedEnd, clientPublicId: action.command.client!.expectedPublicId, organizationPublicId: action.command.organization.expectedPublicId } });
  });
}
function selectedConnection(sourceId: string) {
  return sourceId === "project-alpha:one"
    ? { baseUrl: "https://one.example.test", apiKey: "one", expectedSourceInstanceId: sourceOne, expectedApplicationId: appOne, expectedHistoryEpoch: epochOne }
    : { baseUrl: "https://two.example.test", apiKey: "two", expectedSourceInstanceId: sourceTwo, expectedApplicationId: appTwo, expectedHistoryEpoch: epochTwo };
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  await migrate("0062_project_alpha_project_outbox.sql"); await migrate("0063_project_alpha_project_adoption.sql"); await migrate("0064_project_alpha_project_history_epoch.sql");
  await db.exec("CREATE TABLE native_staff_admissions(staff_id TEXT PRIMARY KEY,active INTEGER,bound_access_subject TEXT,version INTEGER); CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,login_email TEXT,version INTEGER); CREATE TABLE native_business_areas(id TEXT PRIMARY KEY,active INTEGER); CREATE TABLE native_business_divisions(id TEXT PRIMARY KEY,business_area_id TEXT,active INTEGER,UNIQUE(business_area_id,id)); CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT); CREATE TABLE project_alpha_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT); CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,organization_record_id TEXT); CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT,payload BLOB); CREATE TABLE delivery_records(id TEXT PRIMARY KEY,payload BLOB); INSERT INTO delivery_public_shares VALUES('share','https://public.example.test/s/keep',x'00ff80'); INSERT INTO delivery_records VALUES('delivery',x'ff0001');");
  await migrate("0086_native_shared_projects.sql"); await migrate("0119_project_alpha_project_v2_persistence_ledger.sql"); await migrate("0120_project_alpha_project_v2_canonical_settlement.sql"); await migrate("0121_project_alpha_project_v2_settlement_proof_expiry.sql"); await migrate("0122_project_alpha_project_v2_canonical_activation.sql");
});
afterAll(async () => runtime.dispose());

describe("unmounted project-v2 command producer", () => {
  it("pins each deliberately selected source, canonicalizes once, and inserts only pending local evidence", async () => {
    const one = await createAction("project-alpha:one"), two = await createAction("project-alpha:two");
    const publicBefore = await db.prepare("SELECT id,url,hex(payload) payload FROM delivery_public_shares").all();
    const deliveryBefore = await db.prepare("SELECT id,hex(payload) payload FROM delivery_records").all();
    await expect(planProjectAlphaProjectV2Command(env(), one)).resolves.toMatchObject({ status: "queued", replayed: false });
    await expect(planProjectAlphaProjectV2Command(env(), two)).resolves.toMatchObject({ status: "queued", replayed: false });
    expect(await db.prepare("SELECT source_id,application_id,destination_base_url,state FROM project_alpha_project_outbox WHERE command_id=?").bind(one.command.commandId).first())
      .toEqual({ source_id: "project-alpha:one", application_id: appOne, destination_base_url: "https://one.example.test", state: "pending" });
    expect(await db.prepare("SELECT source_id,application_id,destination_base_url,state FROM project_alpha_project_outbox WHERE command_id=?").bind(two.command.commandId).first())
      .toEqual({ source_id: "project-alpha:two", application_id: appTwo, destination_base_url: "https://two.example.test", state: "pending" });
    expect(await db.prepare("SELECT count(*) n FROM native_project_command_reservations WHERE command_id IN (?,?)").bind(one.command.commandId, two.command.commandId).first("n")).toBe(2);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_request_fingerprints WHERE command_id IN (?,?)").bind(one.command.commandId, two.command.commandId).first("n")).toBe(2);
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_v2_canonical_intents WHERE command_id IN (?,?)").bind(one.command.commandId, two.command.commandId).first("n")).toBe(2);
    expect((await db.prepare("SELECT id,url,hex(payload) payload FROM delivery_public_shares").all()).results).toEqual(publicBefore.results);
    expect((await db.prepare("SELECT id,hex(payload) payload FROM delivery_records").all()).results).toEqual(deliveryBefore.results);
  });

  it("replays byte-identical command IDs and rejects a changed canonical body", async () => {
    const action = await createAction();
    const first = await planProjectAlphaProjectV2Command(env(), action);
    const replay = await planProjectAlphaProjectV2Command(env(), action);
    expect(first).toMatchObject({ status: "queued", replayed: false }); expect(replay).toEqual({ ...(first as object), replayed: true });
    const changed = { ...action, command: { ...action.command, project: { ...action.command.project, name: "Changed" } } } as ProjectAlphaProjectV2CommandProducerAction;
    await expect(planProjectAlphaProjectV2Command(env(), changed)).resolves.toEqual({ status: "conflict", reason: "command_id" });
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_outbox WHERE command_id=?").bind(action.command.commandId).first("n")).toBe(1);
  });

  it("does not turn a cross-source concurrent reservation into a fallback replay", async () => {
    const one = await createAction();
    await db.batch([
      db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
        VALUES('project-alpha:two',?,?,?,'organization',?,?)`).bind(sourceTwo, appTwo, epochTwo, one.directory.organizationRecordId, one.command.organization.expectedPublicId),
      db.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
        VALUES('project-alpha:two',?,?,?,'client',?,?)`).bind(sourceTwo, appTwo, epochTwo, one.directory.clientRecordId, one.command.client!.expectedPublicId),
    ]);
    const two = { ...one, sourceId: "project-alpha:two" };
    const outcomes = await Promise.all([planProjectAlphaProjectV2Command(env(), one), planProjectAlphaProjectV2Command(env(), two)]);
    expect(outcomes.filter(value => value.status === "queued")).toHaveLength(1);
    expect(outcomes.filter(value => value.status === "queued" && value.replayed)).toHaveLength(0);
    expect(outcomes.some(value => value.status === "conflict" || value.status === "uncertain")).toBe(true);
    const winningSource = await db.prepare("SELECT source_id FROM project_alpha_project_outbox WHERE command_id=?").bind(one.command.commandId).first("source_id");
    const loser = winningSource === "project-alpha:one" ? two : one;
    await expect(planProjectAlphaProjectV2Command(env(), loser)).resolves.toEqual({ status: "conflict", reason: "command_id" });
  });

  it("blocks a replay when the original staff proof is revoked", async () => {
    const action = await createAction();
    await expect(planProjectAlphaProjectV2Command(env(), action)).resolves.toMatchObject({ status: "queued", replayed: false });
    await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id=?").bind(action.actor.staffId).run();
    await expect(planProjectAlphaProjectV2Command(env(), action)).resolves.toEqual({ status: "blocked", reason: "authority" });
  });

  it("rejects an authenticated snapshot after admission or profile replacement", async () => {
    const admissionChanged = await createAction();
    await db.prepare("UPDATE native_staff_admissions SET version=version+1 WHERE staff_id=?")
      .bind(admissionChanged.actor.staffId).run();
    await expect(planProjectAlphaProjectV2Command(env(), admissionChanged))
      .resolves.toEqual({ status: "blocked", reason: "authority" });

    const profileChanged = await createAction();
    await db.prepare("UPDATE native_staff_profiles SET version=version+1 WHERE staff_id=?")
      .bind(profileChanged.actor.staffId).run();
    await expect(planProjectAlphaProjectV2Command(env(), profileChanged))
      .resolves.toEqual({ status: "blocked", reason: "authority" });
  });

  it("fails closed for a revoked staff member and missing or different directory mappings", async () => {
    const revoked = await createAction();
    await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id=?").bind(revoked.actor.staffId).run();
    await expect(planProjectAlphaProjectV2Command(env(), revoked)).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(await db.prepare("SELECT count(*) n FROM project_alpha_project_outbox WHERE command_id=?").bind(revoked.command.commandId).first("n")).toBe(0);

    const missing = await createAction();
    await db.prepare("DELETE FROM project_alpha_directory_mappings WHERE external_id=? AND resource_type='client'").bind(missing.directory.clientRecordId).run();
    await expect(planProjectAlphaProjectV2Command(env(), missing)).resolves.toEqual({ status: "blocked", reason: "directory" });
    const different = await createAction();
    const wrong = { ...different, command: { ...different.command, organization: { ...different.command.organization, expectedPublicId: "f".repeat(32) } } } as ProjectAlphaProjectV2CommandProducerAction;
    await expect(planProjectAlphaProjectV2Command(env(), wrong)).resolves.toEqual({ status: "blocked", reason: "directory" });
    const mismatchedId = { ...different, directory: { ...different.directory, organizationRecordId: uuid() } };
    await expect(planProjectAlphaProjectV2Command(env(), mismatchedId)).resolves.toEqual({ status: "blocked", reason: "invalid_action" });
    const mismatchedClient = { ...different, directory: { ...different.directory, clientRecordId: uuid() } };
    await expect(planProjectAlphaProjectV2Command(env(), mismatchedClient)).resolves.toEqual({ status: "blocked", reason: "invalid_action" });
    const mismatchedNullClient = { ...different, directory: { ...different.directory, clientRecordId: null } };
    await expect(planProjectAlphaProjectV2Command(env(), mismatchedNullClient)).resolves.toEqual({ status: "blocked", reason: "invalid_action" });
  });

  it("keeps a disabled/outage-selected connection pending and never sends", async () => {
    const action = await createAction(), sent = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", sent);
    try {
      await expect(planProjectAlphaProjectV2Command(env(), action)).resolves.toMatchObject({ status: "queued", replayed: false });
      expect(sent).not.toHaveBeenCalled();
      expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(action.command.commandId).first("state")).toBe("pending");
      expect(await db.prepare("SELECT state FROM project_alpha_project_v2_events WHERE command_id=? AND state_version=1").bind(action.command.commandId).first("state")).toBe("pending");
    } finally { vi.unstubAllGlobals(); }
  });

  it("leases exactly one producer reservation, records the validated receipt atomically, and replays it without another request", async () => {
    const action = await createAction(), send = transport(action);
    await expect(planProjectAlphaProjectV2Command(env(), action)).resolves.toMatchObject({ status: "queued", replayed: false });
    const [first, second] = await Promise.all([
      dispatchProjectAlphaProjectV2PendingCommand(env(true), action.sourceId, action.command.commandId, send),
      dispatchProjectAlphaProjectV2PendingCommand(env(true), action.sourceId, action.command.commandId, send),
    ]);
    expect([first, second]).toContainEqual(expect.objectContaining({ status: "acknowledged" }));
    expect(send.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    const receipt = await db.prepare("SELECT receipt_id FROM project_alpha_project_v2_success_receipts WHERE command_id=?").bind(action.command.commandId).first<string>("receipt_id");
    expect(receipt).toEqual(expect.any(String));
    const replayTransport = vi.fn<typeof fetch>();
    await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), action.sourceId, action.command.commandId, replayTransport))
      .resolves.toEqual({ status: "acknowledged", receiptId: receipt, replayed: true });
    expect(replayTransport).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT state,lease_token,lease_expires_at FROM project_alpha_project_outbox WHERE command_id=?").bind(action.command.commandId).first())
      .toEqual({ state: "pending", lease_token: null, lease_expires_at: null });
    expect(await db.prepare("SELECT state FROM project_alpha_project_v2_events WHERE command_id=? ORDER BY state_version").bind(action.command.commandId).all())
      .toEqual({ results: [{ state: "pending" }, { state: "acknowledged" }], success: true, meta: expect.any(Object) });
  });

  it("rechecks current proof and source identity before transport, and makes timeout evidence terminal without retry", async () => {
    const revoked = await createAction(), noSend = vi.fn<typeof fetch>();
    await planProjectAlphaProjectV2Command(env(), revoked);
    await db.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id=?").bind(revoked.actor.staffId).run();
    await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), revoked.sourceId, revoked.command.commandId, noSend)).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(noSend).not.toHaveBeenCalled();
    await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), "project-alpha:two", revoked.command.commandId, noSend)).resolves.toEqual({ status: "conflict", reason: "source" });

    const timeout = await createAction(), healthy = transport(timeout), timedOut = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") throw new Error("offline");
      return healthy(url, init);
    });
    await planProjectAlphaProjectV2Command(env(), timeout);
    await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), timeout.sourceId, timeout.command.commandId, timedOut)).resolves.toMatchObject({ status: "uncertain", reason: "transport" });
    expect(await db.prepare("SELECT state,outcome_json FROM project_alpha_project_outbox WHERE command_id=?").bind(timeout.command.commandId).first())
      .toMatchObject({ state: "terminal", outcome_json: expect.stringContaining("transport") });
    const retry = vi.fn<typeof fetch>();
    await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), timeout.sourceId, timeout.command.commandId, retry)).resolves.toEqual({ status: "uncertain", reason: "transport" });
    expect(retry).not.toHaveBeenCalled();
  });

  it("replays terminal uncertain, conflict, and rejected ledger evidence without transport", async () => {
    for (const [state, expected] of [["uncertain", { status: "uncertain", reason: "transport" }], ["conflict", { status: "conflict", reason: "http_status", httpStatus: 409 }], ["rejected", { status: "rejected", reason: "invalid_command" }]] as const) {
      const action = await createAction();
      await planProjectAlphaProjectV2Command(env(), action);
      await db.batch([
        db.prepare("INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state) SELECT ?,2,?,request_sha256,? FROM project_alpha_project_v2_request_fingerprints WHERE command_id=?")
          .bind(action.command.commandId, uuid(), state, action.command.commandId),
        db.prepare("UPDATE project_alpha_project_outbox SET state='terminal',outcome_json=? WHERE command_id=?")
          .bind(JSON.stringify({ projectV2Dispatcher: state, reason: expected.reason, ...(state === "conflict" ? { httpStatus: 409 } : {}) }), action.command.commandId),
      ]);
      const noSend = vi.fn<typeof fetch>();
      await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), action.sourceId, action.command.commandId, noSend)).resolves.toEqual(expected);
      expect(noSend).not.toHaveBeenCalled();
      if (state === "uncertain") {
        await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), "project-alpha:two", action.command.commandId, noSend)).resolves.toEqual({ status: "conflict", reason: "source" });
        const wrongIdentity = JSON.parse(env(true).PROJECT_ALPHA_API_V2_CONNECTIONS!);
        wrongIdentity.instances["project-alpha:one"].applicationId = "99999999-9999-4999-8999-999999999999";
        await expect(dispatchProjectAlphaProjectV2PendingCommand({ OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify(wrongIdentity) }, action.sourceId, action.command.commandId, noSend))
          .resolves.toEqual({ status: "blocked", reason: "destination" });
        expect(noSend).not.toHaveBeenCalled();
      }
    }
  });

  it("replays the persisted request identifier for an ambiguous non-success response", async () => {
    const action = await createAction(), healthy = transport(action), failure = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") return response({ error: "upstream" }, 500);
      return healthy(url, init);
    });
    await planProjectAlphaProjectV2Command(env(), action);
    const first = await dispatchProjectAlphaProjectV2PendingCommand(env(true), action.sourceId, action.command.commandId, failure);
    expect(first).toEqual({ status: "uncertain", reason: "http_status", httpStatus: 500, requestId: "11111111-1111-4111-8111-111111111111" });
    const replay = vi.fn<typeof fetch>();
    await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), action.sourceId, action.command.commandId, replay)).resolves.toEqual(first);
    expect(replay).not.toHaveBeenCalled();
  });

  it("releases a preflight-only lease back to pending without appending terminal evidence", async () => {
    const action = await createAction(), unavailable = vi.fn<typeof fetch>(async () => response({ malformed: true }));
    await planProjectAlphaProjectV2Command(env(), action);
    await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), action.sourceId, action.command.commandId, unavailable))
      .resolves.toMatchObject({ status: "blocked", reason: "preflight" });
    expect(unavailable.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(await db.prepare("SELECT state,lease_token,lease_expires_at,outcome_json FROM project_alpha_project_outbox WHERE command_id=?").bind(action.command.commandId).first())
      .toEqual({ state: "pending", lease_token: null, lease_expires_at: null, outcome_json: null });
    expect(await db.prepare("SELECT state FROM project_alpha_project_v2_events WHERE command_id=? ORDER BY state_version").bind(action.command.commandId).all())
      .toMatchObject({ results: [{ state: "pending" }] });
  });

  it("releases a post-lease authority drift without sending and permits a restored retry", async () => {
    const action = await createAction(), noSend = vi.fn<typeof fetch>();
    await planProjectAlphaProjectV2Command(env(), action);
    let drifted = false;
    const hookedDb = new Proxy(db, { get(target, property) {
      if (property !== "prepare") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (query: string) => {
        const statement = target.prepare(query);
        if (drifted || !query.includes("UPDATE project_alpha_project_outbox SET state='leased'")) return statement;
        const hook = (candidate: D1PreparedStatement): D1PreparedStatement => new Proxy(candidate, { get(statementTarget, statementProperty) {
          if (statementProperty === "run") return async () => {
            const result = await statementTarget.run();
            drifted = true;
            await target.prepare("UPDATE native_staff_admissions SET active=0 WHERE staff_id=?").bind(action.actor.staffId).run();
            return result;
          };
          if (statementProperty === "bind") return (...values: unknown[]) => hook(statementTarget.bind(...values));
          const value = Reflect.get(statementTarget, statementProperty, statementTarget);
          return typeof value === "function" ? value.bind(statementTarget) : value;
        } }) as D1PreparedStatement;
        return hook(statement);
      };
    } }) as D1Database;
    await expect(dispatchProjectAlphaProjectV2PendingCommand({ ...env(true), OPS_DB: hookedDb }, action.sourceId, action.command.commandId, noSend))
      .resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(drifted).toBe(true);
    expect(noSend).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT state,lease_token,lease_expires_at,outcome_json FROM project_alpha_project_outbox WHERE command_id=?").bind(action.command.commandId).first())
      .toEqual({ state: "pending", lease_token: null, lease_expires_at: null, outcome_json: null });
    expect(await db.prepare("SELECT state FROM project_alpha_project_v2_events WHERE command_id=? ORDER BY state_version").bind(action.command.commandId).all())
      .toMatchObject({ results: [{ state: "pending" }] });
    await db.prepare("UPDATE native_staff_admissions SET active=1 WHERE staff_id=?").bind(action.actor.staffId).run();
    const retry = transport(action);
    await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), action.sourceId, action.command.commandId, retry)).resolves.toMatchObject({ status: "acknowledged" });
    expect(retry.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true);
  });

  it("is default-off and records malformed successful-looking transport as uncertain without changing canonical state", async () => {
    const disabled = await createAction(), noSend = vi.fn<typeof fetch>();
    await planProjectAlphaProjectV2Command(env(), disabled);
    await expect(dispatchProjectAlphaProjectV2PendingCommand(env(), disabled.sourceId, disabled.command.commandId, noSend)).resolves.toEqual({ status: "blocked", reason: "configuration" });
    expect(noSend).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(disabled.command.commandId).first("state")).toBe("pending");

    const malformed = await createAction(), healthy = transport(malformed), broken = vi.fn<typeof fetch>(async (url, init) => {
      if (init?.method === "POST") return new Response("{", { status: 201, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Request-ID": "11111111-1111-4111-8111-111111111111" } });
      return healthy(url, init);
    });
    await planProjectAlphaProjectV2Command(env(), malformed);
    await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), malformed.sourceId, malformed.command.commandId, broken)).resolves.toMatchObject({ status: "uncertain", reason: "invalid_contract" });
    expect(await db.prepare("SELECT state FROM project_alpha_project_v2_events WHERE command_id=? ORDER BY state_version").bind(malformed.command.commandId).all())
      .toMatchObject({ results: [{ state: "pending" }, { state: "uncertain" }] });
    expect(await db.prepare("SELECT COUNT(*) n FROM project_alpha_project_v2_success_receipts WHERE command_id=?").bind(malformed.command.commandId).first("n")).toBe(0);
  });

  it("rejects an expired proof before transport even when its staff admission and grants still look live", async () => {
    const expiring = await createAction();
    const action = { ...expiring, actor: { ...expiring.actor, verifiedUntil: new Date(Date.now() + 1_500).toISOString() } };
    await expect(planProjectAlphaProjectV2Command(env(), action)).resolves.toMatchObject({ status: "queued" });
    await new Promise(resolve => setTimeout(resolve, 1_650));
    const noSend = vi.fn<typeof fetch>();
    await expect(dispatchProjectAlphaProjectV2PendingCommand(env(true), action.sourceId, action.command.commandId, noSend)).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(noSend).not.toHaveBeenCalled();
    expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(action.command.commandId).first("state")).toBe("pending");
  });

  it("keeps a dispatcher acknowledgement pending for the existing read/activation chain and changes no canonical or public state before activation", async () => {
    const action = await createAction(), post = transport(action);
    await planProjectAlphaProjectV2Command(env(), action);
    const dispatched = await dispatchProjectAlphaProjectV2PendingCommand(env(true), action.sourceId, action.command.commandId, post);
    expect(dispatched.status).toBe("acknowledged");
    if (dispatched.status !== "acknowledged") throw new Error("dispatcher setup failed");
    const before = (await Promise.all([
      db.prepare("SELECT * FROM project_alpha_project_mappings WHERE external_project_id=?").bind(action.command.externalId).all(),
      db.prepare("SELECT * FROM operations_shared_projects WHERE external_project_id=?").bind(action.command.externalId).all(),
      db.prepare("SELECT id,url,hex(payload) payload FROM delivery_public_shares ORDER BY id").all(),
    ])).map(result => result.results);
    expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(action.command.commandId).first("state")).toBe("pending");
    const settled = await settleProjectAlphaProjectV2Read({ OPS_DB: db }, dispatched.receiptId, selectedConnection(action.sourceId), readTransport(action));
    expect(settled).toMatchObject({ status: "settled", successReceiptId: dispatched.receiptId, commandId: action.command.commandId });
    expect((await Promise.all([
      db.prepare("SELECT * FROM project_alpha_project_mappings WHERE external_project_id=?").bind(action.command.externalId).all(),
      db.prepare("SELECT * FROM operations_shared_projects WHERE external_project_id=?").bind(action.command.externalId).all(),
      db.prepare("SELECT id,url,hex(payload) payload FROM delivery_public_shares ORDER BY id").all(),
    ])).map(result => result.results)).toEqual(before);
    if (settled.status !== "settled") throw new Error("read settlement setup failed");
    await expect(activateProjectAlphaProjectV2Canonical({ OPS_DB: db }, settled.settlementId)).resolves.toMatchObject({ status: "activated", commandId: action.command.commandId });
    expect(await db.prepare("SELECT state FROM project_alpha_project_outbox WHERE command_id=?").bind(action.command.commandId).first("state")).toBe("acknowledged");
    expect((await db.prepare("SELECT id,url,hex(payload) payload FROM delivery_public_shares ORDER BY id").all()).results).toEqual(before[2]);
  });

  it("allows bind only from a current unmapped native head and rejects unsupported operations", async () => {
    const staff = await actor(), records = await directory("project-alpha:one", sourceOne, appOne, epochOne), externalId = `ops/bind-${sequence}`;
    await db.prepare(`INSERT INTO operations_shared_projects(external_project_id,name,lifecycle,scopes_json,canonical_projection_sha256,organization_record_id,client_record_id)
      VALUES(?,'Native','active','[]',?,?,?)`).bind(externalId, sha, records.organizationRecordId, records.clientRecordId).run();
    const bind: ProjectAlphaProjectV2CommandProducerAction = { sourceId: "project-alpha:one", actor: { ...staff, verifiedUntil: until, scopes: [] }, operation: "bind",
      local: { expectedLocalVersion: 1, expectedLocalProjectionSha256: sha }, command: { commandId: uuid(), externalId, expectedPublicId: "1".repeat(32), expectedRevision: "1", expectedProjectionSha256: sha, expectedAuthorizationGeneration: "0" } };
    const badHash = { ...bind, command: { ...bind.command, commandId: uuid(), expectedProjectionSha256: "b".repeat(64) } } as ProjectAlphaProjectV2CommandProducerAction;
    await expect(planProjectAlphaProjectV2Command(env(), badHash)).resolves.toEqual({ status: "blocked", reason: "invalid_action" });
    await expect(planProjectAlphaProjectV2Command(env(), bind)).resolves.toMatchObject({ status: "queued", replayed: false });
    const unsupported = { ...bind, operation: "refresh" } as unknown as ProjectAlphaProjectV2CommandProducerAction;
    await expect(planProjectAlphaProjectV2Command(env(), unsupported)).resolves.toEqual({ status: "blocked", reason: "invalid_action" });
  });
});
