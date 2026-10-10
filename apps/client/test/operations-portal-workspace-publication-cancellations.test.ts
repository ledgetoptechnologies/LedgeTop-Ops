import { Miniflare } from "miniflare";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { canonicalOperationsPortalWorkspacePublication, sha256OperationsPortalWorkspacePublication,
  sha256OperationsPortalWorkspaceSnapshot } from "@ltds/shared/operations-portal-workspace-publication";
import { cancelOperationsPortalWorkspacePublication,
  getOperationsPortalWorkspacePublicationDisposition } from "../src/worker/operations-portal-workspace-publication-cancellations";
import { consumeOperationsPortalWorkspacePublication } from "../src/worker/operations-portal-workspace-publications";
import { cancelOperationsPortalWorkspacePublicationRpc, getOperationsPortalWorkspacePublicationDispositionRpc,
  publishOperationsPortalWorkspaceRpc } from "../src/worker/operations-portal-workspace-publication-entrypoint";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const migrations = path.join(root, "apps", "client", "migrations");
const ingress = (database: D1Database) => ({ DELIVERY_DB: database, ENVIRONMENT: "staging",
  EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com",
  CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true" });

async function applyReviewedChain(database: D1Database) {
  const names = fs.readdirSync(migrations).filter(name => /^\d{4}_.+\.sql$/.test(name)
    && name <= "0223_operations_portal_workspace_publications.sql").sort();
  expect(names).toHaveLength(142);
  await database.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
  for (const name of [...names, "0225_operations_portal_workspace_publication_cancellations.sql"]) {
    const statements = splitD1MigrationStatements(fs.readFileSync(path.join(migrations, name), "utf8"))
      .map(sql => database.prepare(sql));
    statements.push(database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name));
    await database.batch(statements);
  }
}

async function publication(overrides: { targetId?: string; targetRevision?: string; clientAuthorityId?: string;
  workspaceId?: string; rootRecordId?: string; expected?: string; resulting?: string; sequence?: string } = {}) {
  const expected = overrides.expected ?? "0", resulting = overrides.resulting ?? "1";
  const value = {
    protocol: "operations-portal-workspace-publication", protocolVersion: 1, action: "publish",
    publicationId: crypto.randomUUID(), operationId: crypto.randomUUID(), expectedRevision: expected,
    resultingRevision: resulting, target: { targetId: overrides.targetId ?? crypto.randomUUID(),
      targetRevision: overrides.targetRevision ?? "1", clientAuthorityId: overrides.clientAuthorityId ?? crypto.randomUUID(),
      workspaceId: overrides.workspaceId ?? `workspace-${crypto.randomUUID()}`, rootKind: "organization",
      rootRecordId: overrides.rootRecordId ?? `ops/org/${crypto.randomUUID()}` },
    snapshot: { snapshotId: crypto.randomUUID(), checkpointId: crypto.randomUUID(), sourceSequence: overrides.sequence ?? "1",
      complete: true, counts: { directoryRecords: 1, projects: 0, folderReservations: 0,
        recipientAuthorityHeads: 0, deliveryAuthorityHeads: 0 }, snapshotSha256: "0".repeat(64),
      directoryRecords: [{ recordId: overrides.rootRecordId ?? "ops/org/cancellation", kind: "organization", version: "1",
        parentRecordId: null, relationshipVersion: null, displayName: "Cancellation test", externalFences: [] }],
      projects: [], folderReservations: [], recipientAuthorityHeads: [], deliveryAuthorityHeads: [] },
    actorProof: { staffId: "staging-owner", verifiedAccessSubject: "access-subject", admissionVersion: "1",
      profileVersion: "1", grantGeneration: "1", verifiedUntil: "2030-01-01T00:00:00.000Z" },
    observedAt: "2026-09-30T00:00:00.000Z",
  };
  value.snapshot.directoryRecords[0]!.recordId = value.target.rootRecordId;
  value.snapshot.snapshotSha256 = await sha256OperationsPortalWorkspaceSnapshot(value);
  return value;
}
async function rawCancellation(database: D1Database, input: Awaited<ReturnType<typeof publication>>,
  canonical = canonicalOperationsPortalWorkspacePublication(input), targetId = input.target.targetId) {
  return database.prepare(`INSERT INTO operations_portal_workspace_publication_cancellations
    (operation_id,publication_id,request_fingerprint,target_id,target_revision,client_authority_id,workspace_id,
      root_kind,root_record_id,expected_revision,resulting_revision,source_sequence,snapshot_id,checkpoint_id,
      snapshot_sha256,canonical_publication_json,observed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(input.operationId, input.publicationId, await sha256OperationsPortalWorkspacePublication(input), targetId,
      1, input.target.clientAuthorityId, input.target.workspaceId, input.target.rootKind, input.target.rootRecordId, 0, 1, 1,
      input.snapshot.snapshotId, input.snapshot.checkpointId, input.snapshot.snapshotSha256, canonical, input.observedAt);
}

describe("0225 exact publication cancellation tombstones", () => {
  let runtime: Miniflare, database: D1Database;
  beforeAll(async () => {
    runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('private')}}", d1Databases: ["DELIVERY_DB"] });
    database = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await applyReviewedChain(database);
    expect(await database.prepare("SELECT count(*) count FROM d1_migrations").first("count")).toBe(143);
    expect(await database.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first("name"))
      .toBe("0225_operations_portal_workspace_publication_cancellations.sql");
  }, 180_000);
  afterAll(async () => runtime.dispose());

  it("terminates unseen operations exactly and makes late publication return durable cancellation evidence", async () => {
    const input = await publication(), config = ingress(database);
    const first = await cancelOperationsPortalWorkspacePublicationRpc(config, input);
    expect(first).toMatchObject({ ok: true, disposition: "cancelled",
      cancellation: { operationId: input.operationId, requestFingerprint: await sha256OperationsPortalWorkspacePublication(input),
        targetId: input.target.targetId, targetRevision: "1", expectedRevision: "0", resultingRevision: "1",
        sourceSequence: "1", snapshotId: input.snapshot.snapshotId, checkpointId: input.snapshot.checkpointId,
        replayed: false } });
    await expect(getOperationsPortalWorkspacePublicationDispositionRpc(config, structuredClone(input)))
      .resolves.toMatchObject({ ok: true, disposition: "cancelled", cancellation: { replayed: true } });
    await expect(publishOperationsPortalWorkspaceRpc(config, structuredClone(input)))
      .resolves.toMatchObject({ ok: true, disposition: "cancelled",
        cancellation: { operationId: input.operationId, replayed: true } });
    expect(await database.prepare("SELECT count(*) count FROM operations_portal_workspace_publication_commands")
      .first("count")).toBe(0);
    expect(await database.prepare("SELECT count(*) count FROM operations_portal_workspace_publication_heads")
      .first("count")).toBe(0);
    await expect(cancelOperationsPortalWorkspacePublication(database, structuredClone(input)))
      .resolves.toMatchObject({ disposition: "cancelled", cancellation: { replayed: true } });
  });

  it("returns committed evidence when publication wins and serializes the publish/cancel race", async () => {
    const committed = await publication(), config = ingress(database);
    await expect(publishOperationsPortalWorkspaceRpc(config, committed)).resolves.toMatchObject({ ok: true,
      receipt: { operationId: committed.operationId, replayed: false } });
    await expect(cancelOperationsPortalWorkspacePublicationRpc(config, structuredClone(committed)))
      .resolves.toMatchObject({ ok: true, disposition: "committed",
        receipt: { operationId: committed.operationId, replayed: true } });

    const raced = await publication(), racedConfig = ingress(database);
    const outcomes = await Promise.all([
      publishOperationsPortalWorkspaceRpc(racedConfig, structuredClone(raced)),
      cancelOperationsPortalWorkspacePublicationRpc(racedConfig, structuredClone(raced)),
    ]);
    const disposition = await getOperationsPortalWorkspacePublicationDisposition(database, raced);
    expect(disposition?.disposition === "committed" || disposition?.disposition === "cancelled").toBe(true);
    if (disposition?.disposition === "committed") {
      expect(outcomes.some(value => value.ok && "receipt" in value)).toBe(true);
      expect(await database.prepare(`SELECT count(*) count FROM operations_portal_workspace_publication_receipts
        WHERE operation_id=?`).bind(raced.operationId).first("count")).toBe(1);
    } else {
      expect(outcomes.every(value => value.ok && "disposition" in value && value.disposition === "cancelled")).toBe(true);
      expect(await database.prepare(`SELECT count(*) count FROM operations_portal_workspace_publication_commands
        WHERE operation_id=?`).bind(raced.operationId).first("count")).toBe(0);
    }
  });

  it("recovers a lost cancellation response and rejects mismatch, stale CAS, raw contradiction and mutation", async () => {
    const input = await publication(), config = ingress(database);
    await cancelOperationsPortalWorkspacePublication(database, input); // response deliberately discarded
    await expect(getOperationsPortalWorkspacePublicationDispositionRpc(config, input))
      .resolves.toMatchObject({ ok: true, disposition: "cancelled",
        cancellation: { operationId: input.operationId, replayed: true } });
    const mismatch = structuredClone(input);
    mismatch.observedAt = "2026-09-30T00:00:01.000Z";
    mismatch.snapshot.snapshotSha256 = await sha256OperationsPortalWorkspaceSnapshot(mismatch);
    await expect(cancelOperationsPortalWorkspacePublication(database, mismatch)).rejects.toThrow("replay_mismatch");

    const baseline = await publication();
    await consumeOperationsPortalWorkspacePublication(database, baseline);
    const stale = await publication({ targetId: baseline.target.targetId,
      targetRevision: baseline.target.targetRevision, clientAuthorityId: baseline.target.clientAuthorityId,
      workspaceId: baseline.target.workspaceId, rootRecordId: baseline.target.rootRecordId });
    await expect(cancelOperationsPortalWorkspacePublicationRpc(config, stale))
      .resolves.toMatchObject({ ok: false, code: "conflict", retryable: false });

    const raw = await publication();
    await expect((await rawCancellation(database, raw, undefined, crypto.randomUUID())).run())
      .rejects.toThrow("publication cancellation canonical JSON does not match its exact row");
    const malformed = await publication(), malformedBody = JSON.parse(canonicalOperationsPortalWorkspacePublication(malformed));
    delete malformedBody.snapshot.directoryRecords[0].displayName;
    malformedBody.snapshot.directoryRecords[0].unknownDisplayName = "Malformed";
    await expect((await rawCancellation(database, malformed, JSON.stringify(malformedBody))).run())
      .rejects.toThrow("publication cancellation canonical JSON does not match its exact row");
    const duplicate = await publication();
    const duplicateBody = canonicalOperationsPortalWorkspacePublication(duplicate)
      .replace('"displayName":"Cancellation test"', `"recordId":"${duplicate.target.rootRecordId}"`);
    await expect((await rawCancellation(database, duplicate, duplicateBody)).run())
      .rejects.toThrow("publication cancellation canonical JSON does not match its exact row");

    // SQLite cannot recompute the shared SHA-256. A trusted raw writer can
    // persist a semantically valid changed body beside a genuine fingerprint,
    // but exact readback compares the full canonical bytes and never turns
    // that corrupt row into false cancellation evidence.
    const tampered = await publication();
    const tamperedBody = canonicalOperationsPortalWorkspacePublication(tampered)
      .replace("Cancellation test", "Tampered cancellation test");
    await expect((await rawCancellation(database, tampered, tamperedBody)).run()).resolves.toBeDefined();
    await expect(getOperationsPortalWorkspacePublicationDisposition(database, tampered)).rejects.toThrow("replay_mismatch");
    await expect(publishOperationsPortalWorkspaceRpc(config, tampered))
      .resolves.toMatchObject({ ok: false, code: "conflict", retryable: false });
    await expect(database.prepare(`UPDATE operations_portal_workspace_publication_cancellations
      SET root_record_id='changed' WHERE operation_id=?`).bind(input.operationId).run()).rejects.toThrow("immutable");
    await expect(database.prepare(`DELETE FROM operations_portal_workspace_publication_cancellations
      WHERE operation_id=?`).bind(input.operationId).run()).rejects.toThrow("cannot be deleted");
    expect(await database.prepare(`SELECT name FROM sqlite_schema WHERE type='table'
      AND name='operations_portal_native_authority_commands'`).first()).toBeNull();
    expect(await database.prepare("SELECT count(*) count FROM portal_v2_entitlements").first("count")).toBe(0);
    expect(await database.prepare("SELECT count(*) count FROM portal_v2_folder_bindings").first("count")).toBe(0);
  });

  it("is default-off before inspecting hostile input or touching storage", async () => {
    const hostile = new Proxy({}, { getPrototypeOf() { throw new Error("must not inspect"); } });
    for (const method of [cancelOperationsPortalWorkspacePublicationRpc,
      getOperationsPortalWorkspacePublicationDispositionRpc]) {
      await expect(method({ ...ingress(database), CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "false" }, hostile))
        .resolves.toMatchObject({ ok: false, code: "disabled", retryable: true });
    }
  });
});
