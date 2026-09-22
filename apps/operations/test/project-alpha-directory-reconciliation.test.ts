import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import {
  reconcileProjectAlphaDirectorySource,
  reconcileProjectAlphaDirectorySources,
  type ProjectAlphaDirectoryReconciliationOptions,
} from "../src/worker/project-alpha-directory-reconciliation";
import type { ProjectAlphaDirectoryInventoryResource } from "../src/worker/project-alpha-directory-inventory-api-v2";

const sourceA = "project-alpha:reconcile-a", sourceB = "project-alpha:reconcile-b";
const identity = {
  sourceInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  applicationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  historyEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  authorizationGeneration: "7",
};
const sourceBIdentity = { ...identity, sourceInstanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  applicationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", historyEpoch: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
const hashA = "a".repeat(64), hashB = "b".repeat(64);
let runtime: Miniflare, db: D1Database, sequence = 0;

function splitSql(sql: string): string[] {
  const statements: string[] = []; let current = "", trigger = false;
  for (const line of sql.split(/\r?\n/u)) {
    if (!current && /^\s*--/u.test(line)) continue;
    if (/^\s*CREATE\s+TRIGGER\b/iu.test(line)) trigger = true;
    current += `${line}\n`;
    if ((!trigger && /;\s*$/u.test(line)) || (trigger && /^\s*END;\s*$/iu.test(line))) {
      statements.push(current.trim()); current = ""; trigger = false;
    }
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}
async function applySql(sql: string): Promise<void> {
  for (const statement of splitSql(sql)) await db.prepare(statement).run();
}
function uuid(): string { return `10000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`; }
function publicId(character: string): string { return character.repeat(32); }
function resource(type: "client" | "organization", id: string, externalId: string,
  overrides: Partial<ProjectAlphaDirectoryInventoryResource> = {}): ProjectAlphaDirectoryInventoryResource {
  return { type, publicId: id, revision: "1", present: true, lastAction: "upsert", projectionSha256: hashA,
    binding: { externalId, status: "active", resourceRevision: "1" }, ...overrides };
}
function inventory(sourceId: string, resources: readonly ProjectAlphaDirectoryInventoryResource[], nextCursor: string | null,
  overrides: Partial<typeof identity> = {}) {
  const fence = sourceId === sourceB ? sourceBIdentity : identity;
  return { status: "observed" as const, inventory: { authoritative: false as const, sourceId, ...fence, ...overrides,
    requestId: uuid(), resources, nextCursor } };
}
function readers(pages: (sourceId: string, cursor: string | null) => ReturnType<typeof inventory> | Promise<ReturnType<typeof inventory>> | { status: "uncertain"; reason: "transport" | "timeout" | "response_limit" | "invalid_contract" | "http_status"; httpStatus?: number }) {
  return {
    inventory: async (_env: unknown, sourceId: string, query: { cursor: string | null }) => pages(sourceId, query.cursor),
    profile: async (_env: unknown, sourceId: string, kind: "client" | "organization", id: string) => {
      const fence = sourceId === sourceB ? sourceBIdentity : identity;
      return { status: "observed" as const, observation: { authoritative: false as const, sourceId, ...fence,
        requestId: uuid(), resource: { type: kind, id, revision: "1" }, profile: { publicId: id, name: "redacted",
          email: null, phone: null, address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null },
          ...(kind === "client" ? { clientType: "business" as const, organizationPublicId: null } : {}) } } };
    },
    binding: async (_env: unknown, sourceId: string, kind: "client" | "organization", externalId: string, id: string) => {
      const fence = sourceId === sourceB ? sourceBIdentity : identity;
      return { status: "observed" as const, observation: { authoritative: false as const, sourceId, ...fence,
        requestId: uuid(), binding: { type: kind, externalId, publicId: id, createdAt: "2026-09-22T12:00:00.000Z" },
        resource: { revision: "1", present: true as const } } };
    },
  } as NonNullable<ProjectAlphaDirectoryReconciliationOptions["readers"]>;
}
function options(customReaders: NonNullable<ProjectAlphaDirectoryReconciliationOptions["readers"]>,
  extra: Partial<ProjectAlphaDirectoryReconciliationOptions> = {}): ProjectAlphaDirectoryReconciliationOptions {
  return { readers: customReaders, runId: uuid, maxPages: 4, maxItems: 20, pageSize: 2, ...extra };
}
async function seedMapping(sourceId: string, type: "client" | "organization", externalId: string, id: string,
  expectedRevision = "1", relationshipOrganization: string | null = null): Promise<void> {
  const fence = sourceId === sourceB ? sourceBIdentity : identity, commandId = uuid();
  await db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,expected_source_instance_id,
    application_id,expected_history_epoch_id,resource_type,external_id,state,outcome_json)
    VALUES(?,?,?,?,?,?,?,'acknowledged',?)`).bind(commandId, sourceId, fence.sourceInstanceId, fence.applicationId,
      fence.historyEpoch, type, externalId,
      JSON.stringify({ response: { result: { resource: { revision: expectedRevision } } } })).run();
  await db.prepare(`INSERT INTO project_alpha_active_directory_mappings(source_id,resource_type,external_id,
    project_alpha_public_id,source_instance_id,application_id,history_epoch_id,provenance_id,mapping_kind)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(sourceId, type, externalId, id, fence.sourceInstanceId, fence.applicationId,
      fence.historyEpoch, commandId, "legacy").run();
  if (type === "client") await db.prepare(`INSERT INTO operations_directory_client_organizations(client_record_id,
    organization_record_id) VALUES(?,?)`).bind(externalId, relationshipOrganization).run();
}
async function takeOwnership(sourceId: string): Promise<{ previous: string; takeover: string }> {
  const checkpoint = await db.prepare(`SELECT active_run_id activeRunId FROM
    project_alpha_directory_reconciliation_checkpoints WHERE source_id=?`).bind(sourceId)
    .first<{ activeRunId: string }>();
  if (!checkpoint?.activeRunId) throw new Error("missing active reconciliation run");
  const takeover = uuid(), at = "2026-09-22T12:30:00.000Z";
  await db.batch([
    db.prepare(`UPDATE project_alpha_directory_reconciliation_runs SET status='uncertain',
      failure_reason='stale_run',completed_at=? WHERE run_id=? AND status='running'`).bind(at, checkpoint.activeRunId),
    db.prepare(`UPDATE project_alpha_directory_reconciliation_checkpoints SET active_run_id=NULL,cursor=NULL,
      updated_at=? WHERE source_id=? AND active_run_id=?`).bind(at, sourceId, checkpoint.activeRunId),
    db.prepare(`INSERT INTO project_alpha_directory_reconciliation_runs(run_id,source_id,status,started_at)
      VALUES(?,?,'running',?)`).bind(takeover, sourceId, at),
    db.prepare(`UPDATE project_alpha_directory_reconciliation_checkpoints SET active_run_id=?,updated_at=?
      WHERE source_id=? AND active_run_id IS NULL`).bind(takeover, at, sourceId),
  ]);
  return { previous: checkpoint.activeRunId, takeover };
}

beforeEach(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  db = await runtime.getD1Database("OPS_DB"); sequence = 0;
  await applySql(`
    CREATE TABLE project_alpha_directory_outbox(command_id TEXT PRIMARY KEY,source_id TEXT,
      expected_source_instance_id TEXT,application_id TEXT,expected_history_epoch_id TEXT,resource_type TEXT,
      external_id TEXT,state TEXT,outcome_json TEXT);
    CREATE TABLE project_alpha_existing_directory_binding_activation_receipts(activation_id TEXT PRIMARY KEY,project_alpha_revision TEXT);
    CREATE TABLE project_alpha_active_directory_mappings(source_id TEXT,resource_type TEXT,external_id TEXT,
      project_alpha_public_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      provenance_id TEXT,mapping_kind TEXT,PRIMARY KEY(source_id,resource_type,external_id));
    CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT);
    CREATE TABLE public_delivery_links(link_id TEXT PRIMARY KEY,payload TEXT);
  `);
  await applySql(readFileSync(new URL("../migrations/0136_project_alpha_directory_reconciliation.sql", import.meta.url), "utf8"));
  await db.prepare("INSERT INTO public_delivery_links(link_id,payload) VALUES('keep','unchanged')").run();
});
afterEach(async () => runtime.dispose());

describe("bounded read-only Project Alpha directory reconciliation", () => {
  it("keeps two source checkpoints isolated and completes ordered pagination", async () => {
    await seedMapping(sourceA, "client", "client-a", publicId("1"));
    await seedMapping(sourceB, "organization", "organization-b", publicId("2"));
    const perSource = readers((sourceId, cursor) => {
      if (sourceId === sourceA) return cursor === null
        ? inventory(sourceId, [resource("client", publicId("1"), "client-a")], `client:${publicId("1")}`)
        : inventory(sourceId, [], null);
      return inventory(sourceId, [resource("organization", publicId("2"), "organization-b")], null);
    });
    const result = await reconcileProjectAlphaDirectorySources({ OPS_DB: db }, [sourceA, sourceB], options(perSource));
    expect(result.map(value => [value.sourceId, value.status, value.pages])).toEqual([
      [sourceA, "complete", 2], [sourceB, "complete", 1],
    ]);
    const checkpoints = await db.prepare(`SELECT source_id,complete_run_id,items_observed FROM
      project_alpha_directory_reconciliation_checkpoints ORDER BY source_id`).all();
    expect(checkpoints.results).toHaveLength(2);
    expect(checkpoints.results.map(row => row.items_observed)).toEqual([1, 1]);
  });

  it.each(["duplicate", "out_of_order"])("fails closed on %s resources without advancing a complete snapshot", async mode => {
    const high = resource("client", publicId("f"), "high"), low = resource("client", publicId("1"), "low");
    const result = await reconcileProjectAlphaDirectorySource({ OPS_DB: db }, sourceA, options(readers((_source, cursor) =>
      cursor === null ? inventory(sourceA, [high], `client:${high.publicId}`)
        : inventory(sourceA, [mode === "duplicate" ? high : low], null))));
    expect(result).toMatchObject({ status: "uncertain", reason: "duplicate_or_order" });
    expect(await db.prepare(`SELECT complete_run_id FROM project_alpha_directory_reconciliation_checkpoints
      WHERE source_id=?`).bind(sourceA).first()).toEqual({ complete_run_id: null });
  });

  it.each([
    ["sourceInstanceId", "99999999-9999-4999-8999-999999999999"],
    ["applicationId", "99999999-9999-4999-8999-999999999999"],
    ["historyEpoch", "99999999-9999-4999-8999-999999999999"],
    ["authorizationGeneration", "8"],
  ] as const)("marks the run uncertain when %s changes between pages", async (field, changed) => {
    const first = resource("client", publicId("1"), "one"), second = resource("client", publicId("2"), "two");
    const result = await reconcileProjectAlphaDirectorySource({ OPS_DB: db }, sourceA, options(readers((_source, cursor) =>
      cursor === null ? inventory(sourceA, [first], `client:${first.publicId}`)
        : inventory(sourceA, [second], null, { [field]: changed }))));
    expect(result).toMatchObject({ status: "uncertain", reason: "fence_changed" });
  });

  it.each([
    ["timeout", { status: "uncertain" as const, reason: "timeout" as const }],
    ["429", { status: "uncertain" as const, reason: "http_status" as const, httpStatus: 429 }],
    ["malformed", { status: "uncertain" as const, reason: "invalid_contract" as const }],
    ["transport", { status: "uncertain" as const, reason: "transport" as const }],
  ])("retains the previous complete snapshot after %s", async (_name, failed) => {
    const item = resource("organization", publicId("3"), "org");
    const complete = await reconcileProjectAlphaDirectorySource({ OPS_DB: db }, sourceA,
      options(readers(() => inventory(sourceA, [item], null))));
    const uncertain = await reconcileProjectAlphaDirectorySource({ OPS_DB: db }, sourceA,
      options(readers(() => failed)));
    expect(complete.status).toBe("complete");
    expect(uncertain.status).toBe("uncertain");
    const checkpoint = await db.prepare(`SELECT complete_run_id,active_run_id FROM
      project_alpha_directory_reconciliation_checkpoints WHERE source_id=?`).bind(sourceA).first();
    expect(checkpoint).toEqual({ complete_run_id: complete.runId, active_run_id: null });
  });

  it("enforces the wall-clock budget before issuing another remote read", async () => {
    const times = [0, 10]; let index = 0, calls = 0;
    const custom = readers(() => { calls += 1; return inventory(sourceA, [], null); });
    const result = await reconcileProjectAlphaDirectorySource({ OPS_DB: db }, sourceA,
      options(custom, { timeBudgetMs: 5, now: () => times[Math.min(index++, times.length - 1)]! }));
    expect(result).toMatchObject({ status: "uncertain", reason: "time_limit" });
    expect(calls).toBe(0);
  });

  it("takes over a stale durable run but does not steal a live source lease", async () => {
    const stale = uuid();
    await db.batch([
      db.prepare(`INSERT INTO project_alpha_directory_reconciliation_runs(run_id,source_id,status,started_at)
        VALUES(?,?,'running','2020-01-01T00:00:00.000Z')`).bind(stale, sourceA),
      db.prepare(`INSERT INTO project_alpha_directory_reconciliation_checkpoints(source_id,active_run_id,
        cursor,pages_observed,items_observed,updated_at) VALUES(?,?,NULL,0,0,'2020-01-01T00:00:00.000Z')`)
        .bind(sourceA, stale),
    ]);
    const current = Date.parse("2026-09-22T12:00:00.000Z");
    const result = await reconcileProjectAlphaDirectorySource({ OPS_DB: db }, sourceA,
      options(readers(() => inventory(sourceA, [], null)), { now: () => current }));
    expect(result.status).toBe("complete");
    expect(await db.prepare(`SELECT status,failure_reason FROM project_alpha_directory_reconciliation_runs
      WHERE run_id=?`).bind(stale).first()).toEqual({ status: "uncertain", failure_reason: "stale_run" });
    const live = uuid();
    await db.batch([
      db.prepare(`INSERT INTO project_alpha_directory_reconciliation_runs(run_id,source_id,status,started_at)
        VALUES(?,?,'running',?)`).bind(live, sourceB, new Date(current).toISOString()),
      db.prepare(`INSERT INTO project_alpha_directory_reconciliation_checkpoints(source_id,active_run_id,
        cursor,pages_observed,items_observed,updated_at) VALUES(?,?,NULL,0,0,?)`)
        .bind(sourceB, live, new Date(current).toISOString()),
    ]);
    const contended = await reconcileProjectAlphaDirectorySource({ OPS_DB: db }, sourceB,
      options(readers(() => inventory(sourceB, [], null)), { now: () => current }));
    expect(contended).toMatchObject({ status: "uncertain", reason: "run_in_progress", runId: live });
  });

  it("ignores historical mappings outside the exact observed instance/application/epoch fence", async () => {
    const oldCommand = uuid(), old = "99999999-9999-4999-8999-999999999999";
    await db.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,expected_source_instance_id,
      application_id,expected_history_epoch_id,resource_type,external_id,state,outcome_json)
      VALUES(?,?,?,?,?,'organization','historical','acknowledged',?)`).bind(oldCommand, sourceA, old, old, old,
        JSON.stringify({ response: { result: { resource: { revision: "1" } } } })).run();
    await db.prepare(`INSERT INTO project_alpha_active_directory_mappings(source_id,resource_type,external_id,
      project_alpha_public_id,source_instance_id,application_id,history_epoch_id,provenance_id,mapping_kind)
      VALUES(?,'organization','historical',?,?,?,?,?,'legacy')`).bind(sourceA, publicId("6"), old, old, old, oldCommand).run();
    const result = await reconcileProjectAlphaDirectorySource({ OPS_DB: db }, sourceA,
      options(readers(() => inventory(sourceA, [], null))));
    expect(result).toMatchObject({ status: "complete", findings: 0 });
  });

  it.each(["insert", "update"] as const)("rejects stale observation %s after checkpoint ownership changes", async phase => {
    const id = publicId("7"), item = resource("client", id, "ownership-client");
    if (phase === "update") await seedMapping(sourceA, "client", "ownership-client", id);
    let stolen: { previous: string; takeover: string } | null = null;
    const base = readers(async () => {
      if (phase === "insert") stolen = await takeOwnership(sourceA);
      return inventory(sourceA, [item], null);
    });
    const originalProfile = base.profile;
    const guardedReaders: NonNullable<ProjectAlphaDirectoryReconciliationOptions["readers"]> = phase === "update"
      ? { ...base, profile: async (...args) => { stolen = await takeOwnership(sourceA); return originalProfile(...args); } }
      : base;
    const result = await reconcileProjectAlphaDirectorySource({ OPS_DB: db }, sourceA, options(guardedReaders));
    expect(result).toMatchObject({ status: "uncertain", reason: "ownership_lost", runId: stolen!.previous });
    expect(await db.prepare(`SELECT active_run_id FROM project_alpha_directory_reconciliation_checkpoints
      WHERE source_id=?`).bind(sourceA).first()).toEqual({ active_run_id: stolen!.takeover });
    const observations = await db.prepare(`SELECT profile_json FROM project_alpha_directory_reconciliation_observations
      WHERE run_id=?`).bind(stolen!.previous).all<{ profile_json: string | null }>();
    if (phase === "insert") expect(observations.results).toEqual([]);
    else expect(observations.results).toEqual([{ profile_json: null }]);
  });

  it("persists every drift class, uses the prior complete snapshot for immutable projection drift, and preserves public links", async () => {
    const organizationRecord = "organization-parent";
    await seedMapping(sourceA, "organization", organizationRecord, publicId("8"));
    await seedMapping(sourceA, "client", "client-a", publicId("1"), "1", organizationRecord);
    await seedMapping(sourceA, "client", "client-b", publicId("2"));
    await seedMapping(sourceA, "client", "client-c", publicId("3"));
    await seedMapping(sourceA, "organization", "organization-e", publicId("5"));
    const baselineItems = [
      resource("client", publicId("1"), "client-a"),
      resource("client", publicId("2"), "client-b"),
      resource("client", publicId("3"), "client-c"),
      resource("organization", publicId("5"), "organization-e"),
      resource("organization", publicId("8"), organizationRecord),
    ];
    const baseline = await reconcileProjectAlphaDirectorySource({ OPS_DB: db }, sourceA,
      options(readers(() => inventory(sourceA, baselineItems, null)), { pageSize: 10 }));
    expect(baseline.status).toBe("complete");

    const mismatchedBase = readers(() => inventory(sourceA, [
      resource("client", publicId("1"), "wrong-external", { revision: "2", projectionSha256: hashB,
        binding: { externalId: "wrong-external", status: "active", resourceRevision: "9" } }),
      resource("client", publicId("4"), "client-c"),
      resource("organization", publicId("5"), "organization-e", { present: false, lastAction: "delete",
        binding: { externalId: "organization-e", status: "tombstoned", resourceRevision: "1" } }),
      resource("organization", publicId("8"), organizationRecord, { projectionSha256: hashB }),
      resource("organization", publicId("9"), "remote-only"),
    ], null));
    const mismatchedProfile: NonNullable<ProjectAlphaDirectoryReconciliationOptions["readers"]>["profile"] = async (_env, sourceId, kind, id) => ({ status: "observed", observation: {
      authoritative: false, sourceId, ...identity, requestId: uuid(), resource: { type: kind, id, revision: id === publicId("1") ? "2" : "1" },
      profile: { publicId: id, name: "redacted", email: null, phone: null,
        address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null },
        ...(kind === "client" ? { clientType: "business" as const, organizationPublicId: publicId("7") } : {}) } } });
    const mismatchedBinding: NonNullable<ProjectAlphaDirectoryReconciliationOptions["readers"]>["binding"] = async (_env, sourceId, kind, externalId, id) => ({ status: "observed", observation: {
      authoritative: false, sourceId, ...identity, requestId: uuid(), binding: { type: kind, externalId, publicId: id,
        createdAt: "2026-09-22T12:00:00.000Z" }, resource: { revision: id === publicId("1") ? "2" : "1", present: true } } });
    const mismatched: NonNullable<ProjectAlphaDirectoryReconciliationOptions["readers"]> = {
      ...mismatchedBase, profile: mismatchedProfile, binding: mismatchedBinding,
    };
    const result = await reconcileProjectAlphaDirectorySource({ OPS_DB: db }, sourceA,
      options(mismatched, { pageSize: 10 }));
    expect(result.status).toBe("complete");
    const rows = await db.prepare(`SELECT DISTINCT classification FROM project_alpha_directory_reconciliation_findings
      WHERE run_id=? ORDER BY classification`).bind(result.runId).all<{ classification: string }>();
    expect(rows.results.map(row => row.classification)).toEqual([
      "binding_mismatch", "external_id_mismatch", "extra_remote", "missing_remote", "presence_mismatch",
      "projection_mismatch", "public_id_mismatch", "relationship_mismatch", "revision_mismatch",
    ]);
    expect(await db.prepare("SELECT * FROM public_delivery_links").all()).toMatchObject({
      results: [{ link_id: "keep", payload: "unchanged" }],
    });
  });
});
