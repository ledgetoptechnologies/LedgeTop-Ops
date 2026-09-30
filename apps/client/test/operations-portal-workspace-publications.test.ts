import { Miniflare } from "miniflare";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalOperationsPortalWorkspacePublication, sha256OperationsPortalWorkspacePublication,
  sha256OperationsPortalWorkspaceSnapshot } from "@ltds/shared/operations-portal-workspace-publication";
import { consumeOperationsPortalWorkspacePublication, getOperationsPortalWorkspacePublicationStatus }
  from "../src/worker/operations-portal-workspace-publications";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { getOperationsPortalWorkspacePublicationStatusRpc, publishOperationsPortalWorkspaceRpc }
  from "../src/worker/operations-portal-workspace-publication-entrypoint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

async function applyCanonicalChain(database: D1Database): Promise<void> {
  const directory = path.join(root, "apps", "client", "migrations");
  const names = fs.readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  await database.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
  for (const name of names) {
    const statements = splitD1MigrationStatements(fs.readFileSync(path.join(directory, name), "utf8"))
      .map(sql => database.prepare(sql));
    statements.push(database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name));
    await database.batch(statements);
  }
}

function draft(overrides: { operation?: string; publication?: string; snapshot?: string; checkpoint?: string;
  expected?: string; resulting?: string; sequence?: string } = {}) {
  const expected = overrides.expected ?? "0", resulting = overrides.resulting ?? "1";
  return {
    protocol: "operations-portal-workspace-publication", protocolVersion: 1, action: "publish",
    publicationId: overrides.publication ?? id("1"), operationId: overrides.operation ?? id("2"),
    expectedRevision: expected, resultingRevision: resulting,
    target: { targetId: id("3"), targetRevision: "4", clientAuthorityId: id("4"),
      workspaceId: "workspace-native-one", rootKind: "organization", rootRecordId: "ops/org/root" },
    snapshot: { snapshotId: overrides.snapshot ?? id("5"), checkpointId: overrides.checkpoint ?? id("6"),
      sourceSequence: overrides.sequence ?? "1", complete: true,
      counts: { directoryRecords: 1, projects: 0, folderReservations: 0, recipientAuthorityHeads: 0, deliveryAuthorityHeads: 0 },
      snapshotSha256: "0".repeat(64),
      directoryRecords: [{ recordId: "ops/org/root", kind: "organization", version: "1", parentRecordId: null,
        relationshipVersion: null, displayName: "Native Operations Customer", externalFences: [] }],
      projects: [], folderReservations: [], recipientAuthorityHeads: [], deliveryAuthorityHeads: [] },
    actorProof: { staffId: "staging-native-owner", verifiedAccessSubject: "access-subject",
      admissionVersion: "1", profileVersion: "1", grantGeneration: "1", verifiedUntil: "2026-10-01T00:00:00.000Z" },
    observedAt: "2026-09-30T00:00:00.000Z",
  };
}

async function publication(overrides: Parameters<typeof draft>[0] = {}) {
  const value = draft(overrides);
  value.snapshot.snapshotSha256 = await sha256OperationsPortalWorkspaceSnapshot(value);
  return value;
}

async function count(database: D1Database, table: string): Promise<number> {
  return (await database.prepare(`SELECT count(*) count FROM ${table}`).first<number>("count"))!;
}

async function rawCommand(database: D1Database, input: Awaited<ReturnType<typeof publication>>, canonical: string) {
  return database.prepare(`INSERT INTO operations_portal_workspace_publication_commands
    (operation_id,publication_id,request_fingerprint,target_id,target_revision,client_authority_id,workspace_id,root_kind,
      root_record_id,expected_revision,resulting_revision,snapshot_id,checkpoint_id,source_sequence,snapshot_sha256,
      canonical_publication_json,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(input.operationId, input.publicationId, await sha256OperationsPortalWorkspacePublication(input),
      input.target.targetId, Number(input.target.targetRevision), input.target.clientAuthorityId, input.target.workspaceId,
      input.target.rootKind, input.target.rootRecordId, Number(input.expectedRevision), Number(input.resultingRevision),
      input.snapshot.snapshotId, input.snapshot.checkpointId, Number(input.snapshot.sourceSequence),
      input.snapshot.snapshotSha256, canonical, input.observedAt);
}

describe("Operations-native portal workspace publication consumer", () => {
  let runtime: Miniflare, database: D1Database;
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('private')}}", d1Databases: ["DELIVERY_DB"] });
    database = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await applyCanonicalChain(database);
  }, 120_000);
  afterAll(async () => { await runtime?.dispose(); });

  it("commits one complete closed snapshot atomically and replays the exact receipt", async () => {
    const input = await publication();
    const ingress = { DELIVERY_DB: database, ENVIRONMENT: "staging", EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com",
      CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true" };
    const published = await publishOperationsPortalWorkspaceRpc(ingress, input);
    expect(published.ok).toBe(true);
    if (!published.ok || !("receipt" in published)) throw new Error("joined publication failed");
    const first = published.receipt;
    expect(first).toMatchObject({ operationId: input.operationId, targetId: input.target.targetId,
      resultingRevision: "1", sourceSequence: "1", replayed: false });
    await expect(publishOperationsPortalWorkspaceRpc(ingress, structuredClone(input)))
      .resolves.toEqual({ ok: true, receipt: { ...first, replayed: true } });
    await expect(getOperationsPortalWorkspacePublicationStatusRpc(ingress, structuredClone(input)))
      .resolves.toEqual({ ok: true, receipt: { ...first, replayed: true } });
    const unseen = await publication({ operation: id("7"), publication: id("8"), snapshot: id("9"), checkpoint: id("a") });
    await expect(getOperationsPortalWorkspacePublicationStatusRpc(ingress, unseen))
      .resolves.toMatchObject({ ok: false, code: "not-found", retryable: false });
    const mismatched = structuredClone(input);
    mismatched.observedAt = "2026-09-30T00:00:01.000Z";
    mismatched.snapshot.snapshotSha256 = await sha256OperationsPortalWorkspaceSnapshot(mismatched);
    await expect(getOperationsPortalWorkspacePublicationStatus(database, mismatched)).rejects.toThrow("replay_mismatch");
    expect(await count(database, "operations_portal_workspace_publication_commands")).toBe(1);
    expect(await count(database, "operations_portal_workspace_publication_heads")).toBe(1);
    expect(await count(database, "operations_portal_workspace_publication_snapshots")).toBe(1);
    expect(await count(database, "operations_portal_workspace_publication_history")).toBe(1);
    expect(await count(database, "operations_portal_workspace_publication_receipts")).toBe(1);
    expect(await count(database, "portal_operations_principal_grant_heads")).toBe(0);
    expect(await count(database, "portal_operations_workspace_authority_heads")).toBe(0);
    expect(await count(database, "portal_v2_workspace_memberships")).toBe(0);
    expect(await count(database, "portal_v2_entitlements")).toBe(0);
    expect(await count(database, "portal_v2_folder_bindings")).toBe(0);
  });

  it("rejects same-operation mismatch, duplicate initial publication, stale CAS, and non-monotonic sequence without partial rows", async () => {
    const mismatch = await publication({ operation: id("2"), publication: id("7"), snapshot: id("8"), checkpoint: id("9") });
    await expect(consumeOperationsPortalWorkspacePublication(database, mismatch)).rejects.toThrow("replay_mismatch");
    const duplicate = await publication({ operation: id("7"), publication: id("8"), snapshot: id("9"), checkpoint: id("a") });
    await expect(consumeOperationsPortalWorkspacePublication(database, duplicate)).rejects.toThrow("conflict");
    expect(await count(database, "operations_portal_workspace_publication_commands")).toBe(1);
    const stale = await publication({ operation: id("a"), publication: id("b"), snapshot: id("c"), checkpoint: id("d"),
      expected: "1", resulting: "2", sequence: "1" });
    await expect(consumeOperationsPortalWorkspacePublication(database, stale)).rejects.toThrow("conflict");
    expect(await count(database, "operations_portal_workspace_publication_commands")).toBe(1);
  });

  it("rejects mismatched, missing, null, or extra canonical command JSON atomically", async () => {
    const input = await publication({ operation: id("e"), publication: id("f"), snapshot: id("7"), checkpoint: id("8"),
      expected: "1", resulting: "2", sequence: "2" });
    const original = JSON.parse(canonicalOperationsPortalWorkspacePublication(input));
    const variants = [
      { ...original, target: { ...original.target, targetId: id("9") } },
      (() => { const value = structuredClone(original); delete value.actorProof.verifiedUntil; return value; })(),
      { ...original, actorProof: null },
      { ...original, unexpected: true },
    ];
    for (const value of variants) {
      const statement = await rawCommand(database, input, JSON.stringify(value));
      await expect(database.batch([statement])).rejects.toThrow("publication command canonical JSON does not match its exact row");
      expect(await count(database, "operations_portal_workspace_publication_commands")).toBe(1);
    }
  });

  it("accepts an exact monotonic CAS while retaining immutable history and rejects update/delete/rebind", async () => {
    const next = await publication({ operation: id("a"), publication: id("b"), snapshot: id("c"), checkpoint: id("d"),
      expected: "1", resulting: "2", sequence: "2" });
    await expect(consumeOperationsPortalWorkspacePublication(database, next)).resolves.toMatchObject({ replayed: false,
      resultingRevision: "2", sourceSequence: "2" });
    expect(await count(database, "operations_portal_workspace_publication_history")).toBe(2);
    await expect(database.prepare("DELETE FROM operations_portal_workspace_publication_history").run()).rejects.toThrow();
    await expect(database.prepare("UPDATE operations_portal_workspace_publication_heads SET workspace_id='rebound' WHERE target_id=?")
      .bind(next.target.targetId).run()).rejects.toThrow();
    const historical = await publication();
    await expect(database.prepare(`UPDATE operations_portal_workspace_publication_heads
      SET revision=3,target_revision=4,source_sequence=3,snapshot_id=?,checkpoint_id=?,snapshot_sha256=?,latest_operation_id=?
      WHERE target_id=?`).bind(historical.snapshot.snapshotId, historical.snapshot.checkpointId,
        historical.snapshot.snapshotSha256, historical.operationId, historical.target.targetId).run())
      .rejects.toThrow("publication head transition must match its exact command");
    await expect(database.prepare(`INSERT INTO operations_portal_workspace_publication_heads
      (target_id,revision,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,source_sequence,
        snapshot_id,checkpoint_id,snapshot_sha256,latest_operation_id) VALUES(?,1,1,?,?, 'standalone_client',?,1,?,?,?,?)`)
      .bind(id("7"), id("8"), "workspace-unreceipted", "ops/client/unreceipted", id("9"), id("e"),
        "a".repeat(64), id("f")).run()).rejects.toThrow();
    await expect(database.prepare(`INSERT INTO operations_portal_workspace_publication_heads
      (target_id,revision,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,source_sequence,
        snapshot_id,checkpoint_id,snapshot_sha256,latest_operation_id) VALUES(?,2,2,?,?, 'standalone_client',?,1,?,?,?,?)`)
      .bind(id("7"), id("8"), "workspace-invalid-initial-revision", "ops/client/invalid", id("9"), id("e"),
        "a".repeat(64), id("f")).run()).rejects.toThrow("initial publication head");
    await expect(database.prepare(`INSERT INTO operations_portal_workspace_publication_snapshots
      (snapshot_id,target_id,revision,checkpoint_id,source_sequence,snapshot_sha256,snapshot_json,
        directory_record_count,project_count,folder_reservation_count,recipient_authority_head_count,
        delivery_authority_head_count,operation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(id("7"), "different-target", 2, id("8"), 2, "b".repeat(64),
        JSON.stringify({ snapshotId: id("7"), checkpointId: id("8"), sourceSequence: "2", snapshotSha256: "b".repeat(64),
          complete: true, directoryRecords: [{}], projects: [], folderReservations: [], recipientAuthorityHeads: [], deliveryAuthorityHeads: [] }),
        1, 0, 0, 0, 0, next.operationId).run()).rejects.toThrow("publication snapshot does not match its canonical command");
    const altered = await publication({ operation: id("e"), publication: id("f"), snapshot: id("7"), checkpoint: id("8"),
      expected: "2", resulting: "3", sequence: "3" });
    const alteredFingerprint = await sha256OperationsPortalWorkspacePublication(altered);
    const alteredCommand = database.prepare(`INSERT INTO operations_portal_workspace_publication_commands
      (operation_id,publication_id,request_fingerprint,target_id,target_revision,client_authority_id,workspace_id,root_kind,
        root_record_id,expected_revision,resulting_revision,snapshot_id,checkpoint_id,source_sequence,snapshot_sha256,
        canonical_publication_json,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(altered.operationId, altered.publicationId, alteredFingerprint, altered.target.targetId,
        Number(altered.target.targetRevision), altered.target.clientAuthorityId, altered.target.workspaceId,
        altered.target.rootKind, altered.target.rootRecordId, 2, 3, altered.snapshot.snapshotId,
        altered.snapshot.checkpointId, 3, altered.snapshot.snapshotSha256,
        canonicalOperationsPortalWorkspacePublication(altered), altered.observedAt);
    const alteredSnapshot = structuredClone(altered.snapshot);
    alteredSnapshot.directoryRecords[0]!.displayName = "Body changed after hashing";
    const alteredSnapshotInsert = database.prepare(`INSERT INTO operations_portal_workspace_publication_snapshots
      (snapshot_id,target_id,revision,checkpoint_id,source_sequence,snapshot_sha256,snapshot_json,
        directory_record_count,project_count,folder_reservation_count,recipient_authority_head_count,
        delivery_authority_head_count,operation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(altered.snapshot.snapshotId, altered.target.targetId, 3, altered.snapshot.checkpointId, 3,
        altered.snapshot.snapshotSha256, JSON.stringify(alteredSnapshot), 1, 0, 0, 0, 0, altered.operationId);
    await expect(database.batch([alteredCommand, alteredSnapshotInsert]))
      .rejects.toThrow("publication snapshot does not match its canonical command");
    const guards = await database.prepare(`SELECT name,sql FROM sqlite_schema WHERE type='trigger'
      AND name IN ('operations_portal_workspace_publication_snapshot_command_guard',
        'operations_portal_workspace_publication_receipt_chain_guard') ORDER BY name`).all<{ name: string; sql: string }>();
    expect(guards.results).toHaveLength(2);
    const guard = Object.fromEntries(guards.results.map(row => [row.name, row.sql]));
    expect(guard.operations_portal_workspace_publication_snapshot_command_guard).toContain("snapshot_sha256=NEW.snapshot_sha256");
    expect(guard.operations_portal_workspace_publication_receipt_chain_guard).toContain("command.request_fingerprint=NEW.request_fingerprint");
    expect(guard.operations_portal_workspace_publication_receipt_chain_guard).toContain("head.client_authority_id=command.client_authority_id");
    const head = await database.prepare("SELECT revision,source_sequence,workspace_id FROM operations_portal_workspace_publication_heads WHERE target_id=?")
      .bind(next.target.targetId).first<{ revision: number; source_sequence: number; workspace_id: string }>();
    expect(head).toEqual({ revision: 2, source_sequence: 2, workspace_id: next.target.workspaceId });
  });

  it("reconciles an exact concurrent retry from the durable receipt", async () => {
    const concurrent = await publication({ operation: id("e"), publication: id("f"), snapshot: id("7"), checkpoint: id("8"),
      expected: "2", resulting: "3", sequence: "3" });
    const results = await Promise.all([
      consumeOperationsPortalWorkspacePublication(database, structuredClone(concurrent)),
      consumeOperationsPortalWorkspacePublication(database, structuredClone(concurrent)),
    ]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(await count(database, "operations_portal_workspace_publication_commands")).toBe(3);
    expect(await count(database, "operations_portal_workspace_publication_receipts")).toBe(3);
  });

  it("fails closed on malformed hashes, incomplete topology, and reservation-pin drift", async () => {
    const badHash = await publication({ operation: id("0"), publication: id("9"), snapshot: id("3"), checkpoint: id("4"),
      expected: "3", resulting: "4", sequence: "4" });
    badHash.snapshot.snapshotSha256 = "f".repeat(64);
    await expect(consumeOperationsPortalWorkspacePublication(database, badHash)).rejects.toThrow("invalid");
    const incomplete = await publication({ operation: id("0"), publication: id("9"), snapshot: id("3"), checkpoint: id("4"),
      expected: "3", resulting: "4", sequence: "4" });
    incomplete.snapshot.counts.directoryRecords = 0;
    await expect(consumeOperationsPortalWorkspacePublication(database, incomplete)).rejects.toThrow("invalid");
    const mismatch = await publication({ operation: id("0"), publication: id("9"), snapshot: id("3"), checkpoint: id("4"),
      expected: "3", resulting: "4", sequence: "4" });
    mismatch.target.targetRevision = "5";
    mismatch.snapshot.snapshotSha256 = await sha256OperationsPortalWorkspaceSnapshot(mismatch);
    await expect(consumeOperationsPortalWorkspacePublication(database, mismatch)).rejects.toThrow("conflict");
    expect(await count(database, "operations_portal_workspace_publication_commands")).toBe(3);
  });
});
