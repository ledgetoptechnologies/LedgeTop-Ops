import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import {
  proposeProjectAlphaInboundProjectEdit,
  readProjectAlphaInboundProjectProposal,
  resolveProjectAlphaInboundProjectEdit,
  type InboundProjectEnvironment,
} from "../src/worker/project-alpha-project-inbound-reconciliation";

const sourceId = "project-alpha:primary";
const sourceInstanceId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const applicationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const historyEpochId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const actor = { staffId: "staff-inbound-reviewer", accessSubject: "access|inbound-reviewer" } as const;
const oldProjection = "a".repeat(64);
const currentProjection = "b".repeat(64);
const staleProjection = "c".repeat(64);

type ProjectFixture = Readonly<{
  externalProjectId: string;
  projectAlphaPublicId: string;
  commandId: string;
  observationRequestId: string;
  remoteRequestId: string;
  proposalKey: string;
  resolutionKey: string;
  label: string;
}>;

const happy: ProjectFixture = {
  externalProjectId: "ops-project-inbound-happy",
  projectAlphaPublicId: "d".repeat(32),
  commandId: "10000000-0000-4000-8000-000000000011",
  observationRequestId: "20000000-0000-4000-8000-000000000011",
  remoteRequestId: "30000000-0000-4000-8000-000000000011",
  proposalKey: "40000000-0000-4000-8000-000000000011",
  resolutionKey: "50000000-0000-4000-8000-000000000011",
  label: "happy",
};
const stale: ProjectFixture = {
  externalProjectId: "ops-project-inbound-stale",
  projectAlphaPublicId: "e".repeat(32),
  commandId: "10000000-0000-4000-8000-000000000012",
  observationRequestId: "20000000-0000-4000-8000-000000000012",
  remoteRequestId: "30000000-0000-4000-8000-000000000012",
  proposalKey: "40000000-0000-4000-8000-000000000012",
  resolutionKey: "50000000-0000-4000-8000-000000000012",
  label: "stale",
};
const authority: ProjectFixture = {
  externalProjectId: "ops-project-inbound-authority",
  projectAlphaPublicId: "f".repeat(32),
  commandId: "10000000-0000-4000-8000-000000000013",
  observationRequestId: "20000000-0000-4000-8000-000000000013",
  remoteRequestId: "30000000-0000-4000-8000-000000000013",
  proposalKey: "40000000-0000-4000-8000-000000000013",
  resolutionKey: "50000000-0000-4000-8000-000000000013",
  label: "authority",
};
const keepOperations: ProjectFixture = {
  externalProjectId: "ops-project-inbound-keep-ops",
  projectAlphaPublicId: "1".repeat(32),
  commandId: "10000000-0000-4000-8000-000000000014",
  observationRequestId: "20000000-0000-4000-8000-000000000014",
  remoteRequestId: "30000000-0000-4000-8000-000000000014",
  proposalKey: "40000000-0000-4000-8000-000000000014",
  resolutionKey: "50000000-0000-4000-8000-000000000014",
  label: "keep-ops",
};
const fixtures = [happy, stale, authority, keepOperations] as const;

let runtime: Miniflare;
let db: D1Database;
let env: InboundProjectEnvironment;

function connectionConfiguration() {
  return JSON.stringify({ version: 1, instances: { [sourceId]: {
    sourceId,
    enabled: true,
    baseUrl: "https://alpha.example.test",
    apiKey: "synthetic-test-secret",
    sourceInstanceId,
    applicationId,
    historyEpoch: historyEpochId,
  } } });
}

function trustedJson(value: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Request-ID": requestId,
  } });
}

function capabilities(requestId: string) {
  return {
    apiVersion: "2",
    sourceInstanceId,
    applicationId,
    historyEpoch: historyEpochId,
    requestId,
    grantedCapabilities: ["api.capabilities.read", "projects.v2.read", "projects.binding_status.read"]
      .map(name => ({ name })),
    implementedEndpoints: [
      { method: "GET", path: "/api/v2/capabilities", requiredCapability: "api.capabilities.read" },
      { method: "GET", path: "/api/v2/projects/{publicId}", requiredCapability: "projects.v2.read",
        requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
      { method: "GET", path: "/api/v2/projects/bindings/status/{base64urlExternalId}",
        requiredCapability: "projects.binding_status.read",
        requiresSourceInstanceId: true, requiresApplicationId: true, requiresHistoryEpoch: true },
    ],
  };
}

function projectRead(fixture: ProjectFixture, revision = "2", projectionSha256 = currentProjection) {
  return {
    apiVersion: "2",
    sourceInstanceId,
    applicationId,
    historyEpoch: historyEpochId,
    requestId: fixture.remoteRequestId,
    replayed: false,
    accepted: true,
    resource: { type: "project", id: fixture.projectAlphaPublicId, revision, projectionSha256 },
    data: {
      name: `Project Alpha ${fixture.label}`,
      description: "Accepted from Project Alpha",
      status: "active",
      archived: false,
      overdueWarning: true,
      completedAt: null,
      archivedAt: null,
      estimatedStart: "2026-10-01",
      estimatedEnd: "2026-10-31",
      clientPublicId: null,
      organizationPublicId: null,
    },
  };
}

function bindingStatus(fixture: ProjectFixture, revision = "2", projectionSha256 = currentProjection,
  authorizationGeneration = "7") {
  return {
    apiVersion: "2",
    sourceInstanceId,
    applicationId,
    historyEpoch: historyEpochId,
    requestId: fixture.remoteRequestId,
    authorizationGeneration,
    binding: {
      externalId: fixture.externalProjectId,
      publicId: fixture.projectAlphaPublicId,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    },
    resource: { revision, projectionSha256, status: "active", archived: false },
  };
}

function projectAlpha(fixture: ProjectFixture, options: {
  revision?: string;
  projectionSha256?: string;
  authorizationGeneration?: string;
} = {}) {
  const revision = options.revision ?? "2";
  const projectionSha256 = options.projectionSha256 ?? currentProjection;
  const authorizationGeneration = options.authorizationGeneration ?? "7";
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const method = request?.method ?? init?.method ?? "GET";
    const url = new URL(request?.url ?? String(input));
    const expectedBindingStatus = `/api/v2/projects/bindings/status/${Buffer.from(fixture.externalProjectId, "utf8").toString("base64url")}`;
    const allowedPaths = new Set([
      "/api/v2/capabilities",
      `/api/v2/projects/${fixture.projectAlphaPublicId}`,
      expectedBindingStatus,
    ]);
    if (method !== "GET" || url.origin !== "https://alpha.example.test" || !allowedPaths.has(url.pathname))
      throw new Error(`unexpected Project Alpha request: ${method} ${url.pathname}`);
    if (url.pathname === "/api/v2/capabilities")
      return trustedJson(capabilities(fixture.remoteRequestId), fixture.remoteRequestId);
    if (url.pathname === expectedBindingStatus)
      return trustedJson(bindingStatus(fixture, revision, projectionSha256, authorizationGeneration), fixture.remoteRequestId);
    if (url.pathname === `/api/v2/projects/${fixture.projectAlphaPublicId}`)
      return trustedJson(projectRead(fixture, revision, projectionSha256), fixture.remoteRequestId);
    throw new Error(`unexpected Project Alpha request: ${method} ${url.pathname}`);
  });
}

async function migrate(name: string): Promise<void> {
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}

async function seedMappings(): Promise<void> {
  for (const fixture of fixtures) {
    await db.batch([
      db.prepare(`INSERT INTO project_alpha_project_destinations(external_project_id,source_id,application_id,
        destination_base_url,expected_source_instance_id,expected_history_epoch_id) VALUES(?,?,?,?,?,?)`)
        .bind(fixture.externalProjectId, sourceId, applicationId, "https://alpha.example.test", sourceInstanceId,
          historyEpochId),
      db.prepare(`INSERT INTO project_alpha_project_outbox(command_id,external_project_id,operation,command_json,
        source_id,application_id,destination_base_url,expected_source_instance_id,origin_snapshot_json,state,
        attempts,next_attempt_at,lease_token,lease_expires_at,expected_history_epoch_id)
        VALUES(?,?,'bind','{}',?,?, 'https://alpha.example.test',?,'{}','leased',0,0,?,4102444800,?)`)
        .bind(fixture.commandId, fixture.externalProjectId, sourceId, applicationId, sourceInstanceId,
          `fixture-${fixture.label}`, historyEpochId),
      db.prepare(`INSERT INTO project_alpha_project_mappings(external_project_id,source_id,source_instance_id,
        application_id,project_alpha_public_id,establishment_kind,establishment_command_id,create_command_id,
        history_epoch_id) VALUES(?,?,?,?,?,'bind',?,NULL,?)`)
        .bind(fixture.externalProjectId, sourceId, sourceInstanceId, applicationId,
          fixture.projectAlphaPublicId, fixture.commandId, historyEpochId),
    ]);
  }
}

async function seedCanonicalHeads(): Promise<void> {
  await db.exec("DROP TRIGGER operations_shared_projects_bound_refresh_guard");
  for (const fixture of fixtures) {
    await db.prepare(`INSERT INTO operations_shared_projects(external_project_id,source_id,source_instance_id,
      application_id,history_epoch_id,project_alpha_public_id,pa_revision,current_version,name,lifecycle,
      scopes_json,canonical_projection_sha256) VALUES(?,?,?,?,?,?, '1',1,?,'active','[]',?)`)
      .bind(fixture.externalProjectId, sourceId, sourceInstanceId, applicationId, historyEpochId,
        fixture.projectAlphaPublicId, `Operations ${fixture.label}`, oldProjection).run();
  }
  await db.prepare(`CREATE TRIGGER operations_shared_projects_bound_refresh_guard
    BEFORE INSERT ON operations_shared_projects BEGIN SELECT 1; END`).run();
}

async function seedCurrentAuthorityAndObservations(): Promise<void> {
  await db.batch([
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject)
      VALUES(?,'inbound-reviewer@example.test','Inbound Reviewer',?)`).bind(actor.staffId, actor.accessSubject),
    db.prepare(`INSERT INTO native_staff_admissions(staff_id,active,bound_access_subject,admitted_by,version)
      VALUES(?,1,?,?,1)`).bind(actor.staffId, actor.accessSubject, actor.staffId),
    db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version)
      VALUES(?,'inbound-reviewer@example.test','Inbound Reviewer',1)`).bind(actor.staffId),
    db.prepare(`INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,version,granted_by)
      VALUES('grant-inbound-reviewer',?,'project.shared.sync','allow','global',1,1,?)`)
      .bind(actor.staffId, actor.staffId),
  ]);
  for (const fixture of fixtures) {
    await db.batch([
      db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,
        history_epoch_id,inventory_kind,request_id,authorization_generation,page_sha256,item_count)
        VALUES(?,?,?,?,'project',?,'7',?,1)`)
        .bind(sourceId, sourceInstanceId, applicationId, historyEpochId, fixture.observationRequestId, "9".repeat(64)),
      db.prepare(`INSERT INTO project_alpha_api_v2_project_observations(source_id,source_instance_id,application_id,
        history_epoch_id,request_id,external_project_id,project_alpha_public_id,resource_revision,
        projection_sha256,lifecycle_status,archived) VALUES(?,?,?,?,?,?,?,'2',?,'active',0)`)
        .bind(sourceId, sourceInstanceId, applicationId, historyEpochId, fixture.observationRequestId,
          fixture.externalProjectId, fixture.projectAlphaPublicId, currentProjection),
    ]);
  }
  await db.exec(`
    CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT NOT NULL);
    INSERT INTO delivery_public_shares VALUES('public-link-sentinel','https://public.example.test/unchanged');
    CREATE TABLE financial_sentinel(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    INSERT INTO financial_sentinel VALUES('financial-row','unchanged');
  `);
}

async function protectedState() {
  const queries = {
    mappings: "SELECT * FROM project_alpha_project_mappings ORDER BY external_project_id",
    outbox: "SELECT * FROM project_alpha_project_outbox ORDER BY command_id",
    publicLinks: "SELECT * FROM delivery_public_shares ORDER BY id",
    financial: "SELECT * FROM financial_sentinel ORDER BY id",
  } as const;
  return Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([key, sql]) => {
    const result = await db.prepare(sql).all();
    return [key, JSON.stringify(result.results)];
  })));
}

function selection(fixture: ProjectFixture, idempotencyKey = fixture.proposalKey) {
  return { idempotencyKey, sourceId, externalProjectId: fixture.externalProjectId } as const;
}

beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    compatibilityDate: "2026-08-06",
    script: "export default { fetch() { return new Response('local test'); } }",
    d1Databases: { OPS_DB: `inbound-reconciliation-${randomUUID()}` },
    d1Persist: "./.tmp-checks/inbound-reconciliation-e2e",
  });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const directory = new URL("../migrations/", import.meta.url);
  const files = readdirSync(directory).filter(file => /^\d{4}_.*\.sql$/.test(file)).sort();
  expect(files.at(-1)).toBe("0181_project_alpha_directory_create_generation_recovery.sql");
  for (const file of files) {
    try {
      await migrate(file);
    } catch (error) {
      throw new Error(`failed applying migration ${file}`, { cause: error });
    }
    if (file === "0064_project_alpha_project_history_epoch.sql") await seedMappings();
    if (file === "0169_project_alpha_existing_directory_binding_generation_evidence.sql")
      await seedCanonicalHeads();
  }
  await seedCurrentAuthorityAndObservations();
  env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: connectionConfiguration() };
}, 180_000);

afterAll(async () => { await runtime?.dispose(); });

describe("PA-origin inbound project edit end-to-end on migrated Miniflare D1", () => {
  it("proposes, reviews, accepts, and replays without changing mapping, outbox, public-link, or financial state",
    async () => {
      const before = await protectedState();
      const send = projectAlpha(happy);
      const proposed = await proposeProjectAlphaInboundProjectEdit(env, actor, selection(happy), send);
      expect(proposed).toMatchObject({ status: "proposed", replayed: false });
      if (proposed.status !== "proposed") throw new Error(`proposal setup failed: ${JSON.stringify(proposed)}`);

      const noNetwork = vi.fn<typeof fetch>();
      await expect(proposeProjectAlphaInboundProjectEdit(env, actor, selection(happy), noNetwork))
        .resolves.toEqual({ status: "proposed", proposalId: proposed.proposalId, replayed: true });
      expect(noNetwork).not.toHaveBeenCalled();

      await expect(readProjectAlphaInboundProjectProposal(env, actor, proposed.proposalId)).resolves.toEqual({
        status: "available",
        proposal: expect.objectContaining({
          proposalId: proposed.proposalId,
          externalProjectId: happy.externalProjectId,
          expectedLocalVersion: 1,
          operations: expect.objectContaining({ revision: "1", name: "Operations happy" }),
          projectAlpha: expect.objectContaining({ revision: "2", name: "Project Alpha happy" }),
          changedFields: ["name", "description", "overdueWarning", "estimatedStart", "estimatedEnd"],
        }),
      });

      const resolution = { idempotencyKey: happy.resolutionKey, proposalId: proposed.proposalId,
        decision: "accept_project_alpha" as const };
      let batchFailure: unknown;
      const diagnosticDb = new Proxy(db, { get(target, property) {
        if (property === "batch") return async (statements: D1PreparedStatement[]) => {
          try { return await target.batch(statements); }
          catch (error) { batchFailure = error; throw error; }
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      } });
      const resolutionTransport = projectAlpha(happy);
      const resolved = await resolveProjectAlphaInboundProjectEdit({ ...env, OPS_DB: diagnosticDb }, actor,
        resolution, resolutionTransport);
      if (resolved.status === "uncertain" && batchFailure) throw batchFailure;
      expect(resolved).toMatchObject({ status: "resolved", decision: "accept_project_alpha",
        syncStatus: "synchronized", resultingVersion: 2, replayed: false });
      if (resolved.status !== "resolved") throw new Error(`resolution failed: ${JSON.stringify(resolved)}`);

      for (const [input, init] of [...send.mock.calls, ...resolutionTransport.mock.calls]) {
        const request = input instanceof Request ? input : undefined;
        const method = request?.method ?? init?.method ?? "GET";
        const url = new URL(request?.url ?? String(input));
        expect(method).toBe("GET");
        expect(url.pathname).not.toMatch(/quote|contract|invoice|payment|document|public|link/i);
      }

      const noReplayNetwork = vi.fn<typeof fetch>();
      await expect(resolveProjectAlphaInboundProjectEdit(env, actor, resolution, noReplayNetwork)).resolves.toEqual({
        ...resolved,
        replayed: true,
      });
      expect(noReplayNetwork).not.toHaveBeenCalled();
      const changedBodyNetwork = vi.fn<typeof fetch>();
      await expect(resolveProjectAlphaInboundProjectEdit(env, actor, { ...resolution,
        decision: "keep_operations" }, changedBodyNetwork)).resolves.toEqual({
        status: "conflict", reason: "idempotency_key",
      });
      expect(changedBodyNetwork).not.toHaveBeenCalled();
      await expect(resolveProjectAlphaInboundProjectEdit(env, actor, { ...resolution,
        idempotencyKey: "60000000-0000-4000-8000-000000000013" }, changedBodyNetwork)).resolves.toEqual({
        status: "conflict", reason: "already_resolved",
      });
      expect(changedBodyNetwork).not.toHaveBeenCalled();

      const second = await proposeProjectAlphaInboundProjectEdit(env, actor, selection(stale), projectAlpha(stale));
      if (second.status !== "proposed") throw new Error(`second proposal setup failed: ${JSON.stringify(second)}`);
      await expect(resolveProjectAlphaInboundProjectEdit(env, actor, {
        idempotencyKey: happy.resolutionKey,
        proposalId: second.proposalId,
        decision: "accept_project_alpha",
      }, changedBodyNetwork)).resolves.toEqual({ status: "conflict", reason: "idempotency_key" });
      expect(changedBodyNetwork).not.toHaveBeenCalled();
      expect(await db.prepare(`SELECT current_version,pa_revision,canonical_projection_sha256,name,description,
        overdue_warning,planned_start,planned_end FROM operations_shared_projects WHERE external_project_id=?`)
        .bind(happy.externalProjectId).first()).toEqual({
        current_version: 2,
        pa_revision: "2",
        canonical_projection_sha256: currentProjection,
        name: "Project Alpha happy",
        description: "Accepted from Project Alpha",
        overdue_warning: 1,
        planned_start: "2026-10-01",
        planned_end: "2026-10-31",
      });
      expect(await db.prepare(`SELECT inbound_resolution_id FROM operations_shared_project_revisions
        WHERE external_project_id=? AND version=2`).bind(happy.externalProjectId).first())
        .toEqual({ inbound_resolution_id: resolved.resolutionId });
      expect(await db.prepare(`SELECT count(*) count FROM project_alpha_project_inbound_proposals
        WHERE external_project_id=?`).bind(happy.externalProjectId).first<number>("count")).toBe(1);
      expect(await db.prepare(`SELECT count(*) count FROM project_alpha_project_inbound_resolution_receipts
        WHERE proposal_id=?`).bind(proposed.proposalId).first<number>("count")).toBe(1);
      expect(await protectedState()).toEqual(before);
    });

  it("records keep-Operations as divergent follow-up and never implies cross-system convergence", async () => {
    const fixture = keepOperations;
    const beforeProtected = await protectedState();
    const beforeLocal = await db.prepare(`SELECT current_version,pa_revision,canonical_projection_sha256,name
      FROM operations_shared_projects WHERE external_project_id=?`).bind(fixture.externalProjectId).first();
    const beforeOutbox = await db.prepare(`SELECT command_id,operation,state,command_json FROM project_alpha_project_outbox
      WHERE external_project_id=? ORDER BY command_id`).bind(fixture.externalProjectId).all();
    const transport = projectAlpha(fixture);
    const proposed = await proposeProjectAlphaInboundProjectEdit(env, actor, selection(fixture), transport);
    expect(proposed).toMatchObject({ status: "proposed", replayed: false });
    if (proposed.status !== "proposed") throw new Error(`proposal setup failed: ${JSON.stringify(proposed)}`);

    const resolution = { idempotencyKey: fixture.resolutionKey, proposalId: proposed.proposalId,
      decision: "keep_operations" as const };
    const resolved = await resolveProjectAlphaInboundProjectEdit(env, actor, resolution, transport);
    expect(resolved).toMatchObject({ status: "resolved", decision: "requires_follow_up",
      syncStatus: "divergent", resultingVersion: 1, replayed: false });
    expect(await db.prepare(`SELECT current_version,pa_revision,canonical_projection_sha256,name
      FROM operations_shared_projects WHERE external_project_id=?`).bind(fixture.externalProjectId).first())
      .toEqual(beforeLocal);
    expect((await db.prepare(`SELECT command_id,operation,state,command_json FROM project_alpha_project_outbox
      WHERE external_project_id=? ORDER BY command_id`).bind(fixture.externalProjectId).all()).results)
      .toEqual(beforeOutbox.results);
    expect(await db.prepare(`SELECT decision,prior_local_version,resulting_local_version
      FROM project_alpha_project_inbound_resolution_receipts WHERE proposal_id=?`).bind(proposed.proposalId).first())
      .toEqual({ decision: "requires_follow_up", prior_local_version: 1, resulting_local_version: 1 });
    expect(await protectedState()).toEqual(beforeProtected);

    const laterProposal = await proposeProjectAlphaInboundProjectEdit(env, actor,
      selection(fixture, "40000000-0000-4000-8000-000000000015"), projectAlpha(fixture));
    expect(laterProposal).toMatchObject({ status: "proposed", replayed: false });
    expect(transport.mock.calls.every(([input, init]) => {
      const request = input instanceof Request ? input : undefined;
      return (request?.method ?? init?.method ?? "GET") === "GET";
    })).toBe(true);
  });

  it("blocks stale remote evidence at proposal and resolution without mutating protected state", async () => {
    const before = await protectedState();
    const staleProposalKey = "60000000-0000-4000-8000-000000000012";
    await expect(proposeProjectAlphaInboundProjectEdit(env, actor, selection(stale, staleProposalKey),
      projectAlpha(stale, { revision: "3", projectionSha256: staleProjection })))
      .resolves.toEqual({ status: "blocked", reason: "stale_evidence" });
    expect(await db.prepare(`SELECT count(*) count FROM project_alpha_project_inbound_proposals
      WHERE idempotency_key=?`).bind(staleProposalKey).first<number>("count")).toBe(0);

    const proposed = await proposeProjectAlphaInboundProjectEdit(env, actor, selection(stale), projectAlpha(stale));
    if (proposed.status !== "proposed") throw new Error(`proposal setup failed: ${JSON.stringify(proposed)}`);
    await expect(resolveProjectAlphaInboundProjectEdit(env, actor, {
      idempotencyKey: stale.resolutionKey,
      proposalId: proposed.proposalId,
      decision: "accept_project_alpha",
    }, projectAlpha(stale, { revision: "3", projectionSha256: staleProjection })))
      .resolves.toEqual({ status: "blocked", reason: "stale_evidence" });
    expect(await db.prepare(`SELECT current_version,name FROM operations_shared_projects
      WHERE external_project_id=?`).bind(stale.externalProjectId).first())
      .toEqual({ current_version: 1, name: "Operations stale" });
    expect(await db.prepare(`SELECT count(*) count FROM project_alpha_project_inbound_resolution_receipts
      WHERE proposal_id=?`).bind(proposed.proposalId).first<number>("count")).toBe(0);
    expect(await protectedState()).toEqual(before);
  });

  it("blocks reviewer authority drift after proposal and review without touching protected or canonical state", async () => {
    const before = await protectedState();
    const proposed = await proposeProjectAlphaInboundProjectEdit(env, actor, selection(authority), projectAlpha(authority));
    if (proposed.status !== "proposed") throw new Error(`proposal setup failed: ${JSON.stringify(proposed)}`);
    await expect(readProjectAlphaInboundProjectProposal(env, actor, proposed.proposalId))
      .resolves.toMatchObject({ status: "available" });

    await db.prepare(`UPDATE native_project_grants SET active=0,version=version+1
      WHERE id='grant-inbound-reviewer'`).run();
    await expect(readProjectAlphaInboundProjectProposal(env, actor, proposed.proposalId))
      .resolves.toEqual({ status: "unavailable", reason: "authority" });
    const noNetwork = vi.fn<typeof fetch>();
    await expect(resolveProjectAlphaInboundProjectEdit(env, actor, {
      idempotencyKey: authority.resolutionKey,
      proposalId: proposed.proposalId,
      decision: "accept_project_alpha",
    }, noNetwork)).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(noNetwork).not.toHaveBeenCalled();
    expect(await db.prepare(`SELECT current_version,name FROM operations_shared_projects
      WHERE external_project_id=?`).bind(authority.externalProjectId).first())
      .toEqual({ current_version: 1, name: "Operations authority" });
    expect(await db.prepare(`SELECT count(*) count FROM project_alpha_project_inbound_resolution_receipts
      WHERE proposal_id=?`).bind(proposed.proposalId).first<number>("count")).toBe(0);
    expect(await protectedState()).toEqual(before);
  });
});
