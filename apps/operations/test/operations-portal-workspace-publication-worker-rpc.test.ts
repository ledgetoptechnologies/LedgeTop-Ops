import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256OperationsPortalWorkspaceSnapshot } from "@ltds/shared/operations-portal-workspace-publication";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { writeNativeDirectoryProfile } from "../src/worker/native-directory-profile-writer";
import { reserveOperationsPortalWorkspace } from "../src/worker/operations-portal-workspace-reservations";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const opsMigrations = path.join(root, "apps", "operations", "migrations");
const clientMigrations = path.join(root, "apps", "client", "migrations");
let sequence = 1;
let rootSequence = 1;
const id = () => `e0000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const actor = () => ({ identity: { kind: "native" as const, staffId: "rpc-publication-owner",
  verifiedAccessSubject: "access|rpc-publication-owner", email: "rpc-publication-owner@example.test",
  displayName: "RPC Publication Owner", profileVersion: 1 }, admissionVersion: 1,
  verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() });

async function bundle(url: URL) {
  const result = await build({ configFile: false, logLevel: "silent", ssr: { noExternal: true },
    build: { ssr: fileURLToPath(url), target: "esnext", write: false, minify: false,
      rollupOptions: { external: value => value.startsWith("cloudflare:") } } });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !("output" in output)) throw new Error("RPC bundle missing");
  const chunk = output.output.find(item => item.type === "chunk" && item.isEntry);
  if (!chunk || chunk.type !== "chunk") throw new Error("RPC bundle entry missing");
  return chunk.code;
}
async function apply(database: Awaited<ReturnType<Miniflare["getD1Database"]>>, directory: string,
  through: string, exactAfter: string | readonly string[]) {
  const names = fs.readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name) && name <= through).sort();
  await database.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
  for (const name of [...names, ...(typeof exactAfter === "string" ? [exactAfter] : exactAfter)]) {
    const statements = splitD1MigrationStatements(fs.readFileSync(path.join(directory, name), "utf8"));
    await database.batch([...statements.map(sql => database.prepare(sql)),
      database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
  }
  return names;
}
async function request(runtime: Miniflare, action: string, body: unknown) {
  return runtime.dispatchFetch(`https://ops-rpc.example.test/${action}`, { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
async function sha256Json(value: unknown) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("actual Ops publication helpers over a named Client Worker binding", () => {
  let runtime: Miniflare;
  beforeAll(async () => {
    const [driver, client] = await Promise.all([
      bundle(new URL("./fixtures/operations-portal-workspace-publication-rpc-driver.ts", import.meta.url)),
      bundle(new URL("../../client/src/worker/operations-portal-workspace-publication-entrypoint.ts", import.meta.url)),
    ]);
    runtime = new Miniflare({ workers: [
      { name: "ops-driver", modules: true, compatibilityDate: "2026-07-22", compatibilityFlags: ["nodejs_compat"], script: driver,
        d1Databases: { OPS_DB: crypto.randomUUID() }, serviceBindings: { CLIENT_PUBLICATION:
          { name: "client-publication", entrypoint: "OperationsPortalWorkspacePublicationIngress" } } },
      { name: "client-publication", modules: true, compatibilityDate: "2026-07-16",
        compatibilityFlags: ["nodejs_compat"], script: client, d1Databases: { DELIVERY_DB: crypto.randomUUID() },
        bindings: { ENVIRONMENT: "staging", EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com",
          CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true" } },
    ] });
    const ops = await runtime.getD1Database("OPS_DB", "ops-driver");
    const clientDb = await runtime.getD1Database("DELIVERY_DB", "client-publication");
    expect(await apply(ops, opsMigrations, "0153_operations_portal_workspace_publication_outbox.sql",
      ["0155_operations_portal_workspace_publication_cancellations.sql",
        "0156_operations_portal_workspace_publication_invocations.sql"])).toHaveLength(153);
    expect(await apply(clientDb, clientMigrations, "0223_operations_portal_workspace_publications.sql",
      "0225_operations_portal_workspace_publication_cancellations.sql")).toHaveLength(142);
    await ops.batch([
      ops.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status) VALUES(?,?,?,?, 'active')`)
        .bind("rpc-publication-owner", "rpc-publication-owner@example.test", "RPC Publication Owner",
          "access|rpc-publication-owner"),
      ops.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
        VALUES('rpc-publication-owner','access|rpc-publication-owner',1,'rpc-publication-owner')`),
      ops.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
        VALUES('rpc-publication-owner','rpc-publication-owner@example.test','RPC Publication Owner')`),
      ops.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
        VALUES('rpc-publication-role','rpc-publication-owner','role-owner','global',NULL,'global','rpc-publication-owner')`),
      ...["directory.portal_access.manage", "directory.profile.edit", "directory.identity.link"].map((permission, index) =>
        ops.prepare(`INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by)
          VALUES(?,'rpc-publication-owner',?,'allow','global',1,'rpc-publication-owner')`)
          .bind(`rpc-publication-grant-${index}`, permission)),
      ops.prepare("INSERT INTO native_business_areas(id,name,active) VALUES('rpc-area','RPC Area',1)"),
      ops.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active)
        VALUES('rpc-division','rpc-area','RPC Division',1)`),
    ]);
    const profile = { name: "RPC Publication Organization", generalEmail: "rpc@example.test", generalPhone: "",
      addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX", postalCode: "78701", country: "US" };
    const destination = { sourceId: "project-alpha:primary", sourceInstanceUUID: "11111111-1111-4111-8111-111111111111",
      applicationUUID: "22222222-2222-4222-8222-222222222222", historyEpoch: "33333333-3333-4333-8333-333333333333",
      origin: "https://pa.example.test", externalCanonicalId: "", expectedAuthorizationGeneration: "0" };
    for (let index = 1; index <= 4; index += 1) {
      const recordId = `ops/organization/rpc-publication-${index}`, admissionId = `admission-${id()}`;
      const recordDestination = { ...destination, externalCanonicalId: recordId };
      await ops.prepare(`INSERT INTO native_directory_create_admissions
        (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
        VALUES(?,?,?,?,?,?,?,?,?)`).bind(admissionId, "rpc-publication-owner", "access|rpc-publication-owner", recordId,
          "organization", JSON.stringify([{ businessAreaId: "rpc-area", divisionId: "rpc-division" }]),
          JSON.stringify(profile), JSON.stringify([{ ...recordDestination, expectedAuthorizationGeneration: undefined }]),
          "rpc-publication-owner").run();
      await writeNativeDirectoryProfile(ops, { operation: "create", mutationId: id(), createAdmissionId: admissionId,
        recordId, expectedLocalVersion: 0, kind: "organization", profile,
        scopes: [{ businessAreaId: "rpc-area", divisionId: "rpc-division" }], destinations: [recordDestination],
        actor: { staffId: "rpc-publication-owner", accessSubject: "access|rpc-publication-owner",
          loginEmail: "rpc-publication-owner@example.test", admissionVersion: 1, profileVersion: 1,
          selectedGrantId: "rpc-publication-grant-1", selectedIdentityGrantId: "rpc-publication-grant-2" } });
    }
    await ops.prepare(`CREATE TABLE rpc_publication_test_calls(kind TEXT PRIMARY KEY,count INTEGER NOT NULL)`).run();
  }, 300_000);
  afterAll(async () => { if (runtime) await runtime.dispose(); });

  async function reserveWorkspace() {
    const ops = await runtime.getD1Database("OPS_DB", "ops-driver");
    const rootRecordId = `ops/organization/rpc-publication-${rootSequence++}`;
    const input = { operationId: id(), targetId: id(), clientAuthorityId: id(), workspaceId: `workspace:${id()}`,
      rootKind: "organization" as const, rootRecordId, rootRecordVersion: 1,
      relationshipVersion: null, expectedRevision: 0 as const, reason: "RPC publication workspace" };
    await reserveOperationsPortalWorkspace(ops, actor(), input);
    return input.targetId;
  }
  const reservation = (targetId: string) => ({ operationId: id(), publicationId: id(), targetId,
    snapshotId: id(), checkpointId: id(), expectedRevision: 0, reason: "RPC publication acceptance" });

  it("correlates an exact normal receipt and recovers a caller-discarded committed response", async () => {
    for (const mode of ["reserve-dispatch", "reserve-discard-publish"]) {
      const targetId = await reserveWorkspace(), command = reservation(targetId);
      const first = await request(runtime, mode, { actor: actor(), reservation: command });
      expect(await first.json()).toMatchObject({ dispatched: {
        status: mode === "reserve-dispatch" ? "acknowledged" : "retry" },
        outbox: { state: mode === "reserve-dispatch" ? "acknowledged" : "retry" } });
      if (mode === "reserve-discard-publish") {
        expect(await (await request(runtime, "dispatch", { operationId: command.operationId })).json())
          .toEqual({ operationId: command.operationId, status: "acknowledged", replayed: true });
      }
      const ops = await runtime.getD1Database("OPS_DB", "ops-driver");
      const client = await runtime.getD1Database("DELIVERY_DB", "client-publication");
      const opsRow = await ops.prepare(`SELECT command.operation_id operationId,command.publication_id publicationId,
        command.operation_fingerprint fingerprint,command.target_id targetId,command.target_revision targetRevision,
        command.client_authority_id clientAuthorityId,command.workspace_id workspaceId,command.root_kind rootKind,
        command.root_record_id rootRecordId,command.expected_revision expectedRevision,
        command.resulting_revision resultingRevision,command.source_sequence sourceSequence,
        command.snapshot_id snapshotId,command.checkpoint_id checkpointId,command.snapshot_sha256 snapshotSha256,
        outbox.state,receipt.operation_id receipt FROM operations_portal_workspace_publication_commands command
        JOIN operations_portal_workspace_publication_outbox outbox ON outbox.operation_id=command.operation_id
        JOIN operations_portal_workspace_publication_receipts receipt ON receipt.operation_id=command.operation_id
        WHERE command.operation_id=?`).bind(command.operationId).first();
      const clientRow = await client.prepare(`SELECT command.operation_id operationId,command.publication_id publicationId,
        command.request_fingerprint fingerprint,command.target_id targetId,command.target_revision targetRevision,
        command.client_authority_id clientAuthorityId,command.workspace_id workspaceId,command.root_kind rootKind,
        command.root_record_id rootRecordId,command.expected_revision expectedRevision,
        command.resulting_revision resultingRevision,command.source_sequence sourceSequence,
        command.snapshot_id snapshotId,command.checkpoint_id checkpointId,command.snapshot_sha256 snapshotSha256,
        receipt.operation_id receipt FROM operations_portal_workspace_publication_commands command
        JOIN operations_portal_workspace_publication_receipts receipt ON receipt.operation_id=command.operation_id
        WHERE command.operation_id=?`).bind(command.operationId).first();
      expect(opsRow).not.toBeNull();
      expect(clientRow).not.toBeNull();
      expect(opsRow).toEqual({ ...clientRow, state: "acknowledged" });
      const opsHeadSnapshot = await ops.prepare(`SELECT head.target_id targetId,
        head.publication_revision revision,head.target_revision targetRevision,
        head.client_authority_id clientAuthorityId,head.workspace_id workspaceId,head.root_kind rootKind,
        head.root_record_id rootRecordId,head.source_sequence sourceSequence,head.snapshot_id snapshotId,
        head.checkpoint_id checkpointId,head.snapshot_sha256 snapshotSha256,
        head.latest_operation_id latestOperationId,snapshot.snapshot_json snapshotJson
        FROM operations_portal_workspace_publication_heads head
        JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=head.snapshot_id
          AND snapshot.target_id=head.target_id AND snapshot.source_sequence=head.source_sequence
          AND snapshot.checkpoint_id=head.checkpoint_id AND snapshot.snapshot_sha256=head.snapshot_sha256
        WHERE head.latest_operation_id=?`).bind(command.operationId).first();
      const clientHeadSnapshot = await client.prepare(`SELECT head.target_id targetId,head.revision revision,
        head.target_revision targetRevision,head.client_authority_id clientAuthorityId,head.workspace_id workspaceId,
        head.root_kind rootKind,head.root_record_id rootRecordId,head.source_sequence sourceSequence,
        head.snapshot_id snapshotId,head.checkpoint_id checkpointId,head.snapshot_sha256 snapshotSha256,
        head.latest_operation_id latestOperationId,snapshot.snapshot_json snapshotJson
        FROM operations_portal_workspace_publication_heads head
        JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=head.snapshot_id
          AND snapshot.target_id=head.target_id AND snapshot.source_sequence=head.source_sequence
          AND snapshot.checkpoint_id=head.checkpoint_id AND snapshot.snapshot_sha256=head.snapshot_sha256
          AND snapshot.operation_id=head.latest_operation_id
        WHERE head.latest_operation_id=?`).bind(command.operationId).first();
      expect(opsHeadSnapshot).not.toBeNull();
      expect(clientHeadSnapshot).not.toBeNull();
      expect(opsHeadSnapshot).toEqual(clientHeadSnapshot);
      expect(await client.prepare(`SELECT directory_record_count||':'||project_count||':'||folder_reservation_count||':'||
        recipient_authority_head_count||':'||delivery_authority_head_count counts
        FROM operations_portal_workspace_publication_snapshots WHERE operation_id=?`)
        .bind(command.operationId).first("counts")).toBe("1:0:0:0:0");
      const durable = await ops.prepare(`SELECT command.canonical_publication_json publicationJson,
        snapshot.snapshot_json snapshotJson,checkpoint.directory_record_count directoryCount,
        checkpoint.project_count projectCount,checkpoint.folder_reservation_count folderCount,
        checkpoint.directory_sha256 directorySha256,checkpoint.project_sha256 projectSha256,
        checkpoint.folder_sha256 folderSha256 FROM operations_portal_workspace_publication_commands command
        JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=command.snapshot_id
          AND snapshot.checkpoint_id=command.checkpoint_id AND snapshot.snapshot_sha256=command.snapshot_sha256
        JOIN operations_portal_workspace_publication_checkpoints checkpoint ON checkpoint.checkpoint_id=command.checkpoint_id
          AND checkpoint.target_id=command.target_id AND checkpoint.target_revision=command.target_revision
        WHERE command.operation_id=?`).bind(command.operationId).first<{
          publicationJson: string; snapshotJson: string; directoryCount: number; projectCount: number; folderCount: number;
          directorySha256: string; projectSha256: string; folderSha256: string }>();
      expect(durable).not.toBeNull();
      if (!durable) throw new Error("missing durable publication checkpoint");
      const storedPublication = JSON.parse(durable.publicationJson);
      expect(durable.snapshotJson).toBe(JSON.stringify(storedPublication.snapshot));
      expect(await sha256OperationsPortalWorkspaceSnapshot(storedPublication)).toBe(storedPublication.snapshot.snapshotSha256);
      expect({ directoryCount: durable.directoryCount, projectCount: durable.projectCount, folderCount: durable.folderCount,
        directorySha256: durable.directorySha256, projectSha256: durable.projectSha256,
        folderSha256: durable.folderSha256 }).toEqual({ directoryCount: storedPublication.snapshot.directoryRecords.length,
        projectCount: storedPublication.snapshot.projects.length,
        folderCount: storedPublication.snapshot.folderReservations.length,
        directorySha256: await sha256Json(storedPublication.snapshot.directoryRecords),
        projectSha256: await sha256Json(storedPublication.snapshot.projects),
        folderSha256: await sha256Json(storedPublication.snapshot.folderReservations) });
      if (mode === "reserve-discard-publish") {
        expect(await ops.prepare("SELECT count FROM rpc_publication_test_calls WHERE kind='discard-publish:publish'")
          .first("count")).toBe(1);
        expect(await ops.prepare("SELECT count FROM rpc_publication_test_calls WHERE kind='recovery:status'")
          .first("count")).toBe(1);
        expect(await ops.prepare("SELECT count FROM rpc_publication_test_calls WHERE kind='recovery:publish'")
          .first("count")).toBeNull();
      }
    }
  }, 180_000);

  it("recovers a caller-discarded cancellation and serializes a dispatch/cancel race", async () => {
    const targetId = await reserveWorkspace(), command = reservation(targetId);
    expect(await (await request(runtime, "reserve-fail-before-publish", { actor: actor(), reservation: command })).json())
      .toMatchObject({ dispatched: { status: "retry" } });
    expect(await (await request(runtime, "cancel-discard", { operationId: command.operationId })).json())
      .toEqual({ operationId: command.operationId, status: "retry" });
    const cancelled = await (await request(runtime, "cancel", { operationId: command.operationId })).json();
    expect(cancelled).toMatchObject({ result: { operationId: command.operationId, status: "cancelled", replayed: true,
      cancellation: { operationId: command.operationId, replayed: true } }, outbox: { state: "dead", remote_attempted: 1 } });
    const ops = await runtime.getD1Database("OPS_DB", "ops-driver");
    const client = await runtime.getD1Database("DELIVERY_DB", "client-publication");
    expect(await ops.prepare(`SELECT state||':'||remote_attempted value FROM operations_portal_workspace_publication_outbox
      WHERE operation_id=?`).bind(command.operationId).first("value")).toBe("dead:1");
    expect(await ops.prepare(`SELECT count(*) FROM operations_portal_workspace_publication_cancellation_receipts
      WHERE operation_id=?`).bind(command.operationId).first("count(*)")).toBe(1);
    expect(await client.prepare(`SELECT count(*) FROM operations_portal_workspace_publication_cancellations
      WHERE operation_id=?`).bind(command.operationId).first("count(*)")).toBe(1);
    expect(await client.prepare(`SELECT count(*) FROM operations_portal_workspace_publication_commands
      WHERE operation_id=?`).bind(command.operationId).first("count(*)")).toBe(0);
    expect(await ops.prepare("SELECT count FROM rpc_publication_test_calls WHERE kind='cancel:cancel'")
      .first("count")).toBe(1);
    expect(await ops.prepare("SELECT count FROM rpc_publication_test_calls WHERE kind='cancel-recovery:disposition'")
      .first("count")).toBe(1);
    expect(await ops.prepare("SELECT count FROM rpc_publication_test_calls WHERE kind='cancel-recovery:cancel'")
      .first("count")).toBeNull();
    const opsCancellation = await ops.prepare(`SELECT operation_id operationId,publication_id publicationId,
      operation_fingerprint fingerprint,target_id targetId,target_revision targetRevision,
      client_authority_id clientAuthorityId,workspace_id workspaceId,root_kind rootKind,root_record_id rootRecordId,
      expected_revision expectedRevision,resulting_revision resultingRevision,source_sequence sourceSequence,
      snapshot_id snapshotId,checkpoint_id checkpointId,snapshot_sha256 snapshotSha256,client_cancelled_at cancelledAt
      FROM operations_portal_workspace_publication_cancellation_receipts WHERE operation_id=?`)
      .bind(command.operationId).first();
    const clientCancellation = await client.prepare(`SELECT operation_id operationId,publication_id publicationId,
      request_fingerprint fingerprint,target_id targetId,target_revision targetRevision,
      client_authority_id clientAuthorityId,workspace_id workspaceId,root_kind rootKind,root_record_id rootRecordId,
      expected_revision expectedRevision,resulting_revision resultingRevision,source_sequence sourceSequence,
      snapshot_id snapshotId,checkpoint_id checkpointId,snapshot_sha256 snapshotSha256,cancelled_at cancelledAt
      FROM operations_portal_workspace_publication_cancellations WHERE operation_id=?`)
      .bind(command.operationId).first();
    expect(opsCancellation).not.toBeNull();
    expect(clientCancellation).not.toBeNull();
    expect(opsCancellation).toEqual(clientCancellation);
    expect(await ops.prepare(`SELECT action FROM operations_portal_workspace_publication_cancellation_audit
      WHERE operation_id=?`).bind(command.operationId).first("action")).toBe("workspace.snapshot.cancelled");

    const raceTarget = await reserveWorkspace(), raced = reservation(raceTarget);
    await request(runtime, "reserve-fail-before-publish", { actor: actor(), reservation: raced });
    const race = await (await request(runtime, "race", { operationId: raced.operationId })).json();
    expect(race).toMatchObject({ dispatch: expect.any(Object), cancellation: expect.any(Object) });
    const raceWire = JSON.stringify(race);
    expect(raceWire.includes("claim_conflict") || raceWire.includes("invocation_denied")
      || raceWire.includes('"replayed":true')).toBe(true);
    const clientKinds = Number(await client.prepare(`SELECT count(*) FROM operations_portal_workspace_publication_receipts
      WHERE operation_id=?`).bind(raced.operationId).first("count(*)"))
      + Number(await client.prepare(`SELECT count(*) FROM operations_portal_workspace_publication_cancellations
        WHERE operation_id=?`).bind(raced.operationId).first("count(*)"));
    expect(clientKinds).toBe(1);
    const state = await ops.prepare(`SELECT state FROM operations_portal_workspace_publication_outbox
      WHERE operation_id=? AND state IN ('acknowledged','dead')`).bind(raced.operationId).first("state");
    expect(state).toMatch(/^(acknowledged|dead)$/);
    const opsReceipts = Number(await ops.prepare(`SELECT count(*) FROM operations_portal_workspace_publication_receipts
      WHERE operation_id=?`).bind(raced.operationId).first("count(*)"));
    const opsCancellations = Number(await ops.prepare(`SELECT count(*) FROM operations_portal_workspace_publication_cancellation_receipts
      WHERE operation_id=?`).bind(raced.operationId).first("count(*)"));
    const clientReceipts = Number(await client.prepare(`SELECT count(*) FROM operations_portal_workspace_publication_receipts
      WHERE operation_id=?`).bind(raced.operationId).first("count(*)"));
    const clientCancellations = Number(await client.prepare(`SELECT count(*) FROM operations_portal_workspace_publication_cancellations
      WHERE operation_id=?`).bind(raced.operationId).first("count(*)"));
    expect({ state, opsReceipts, opsCancellations, clientReceipts, clientCancellations }).toEqual(state === "acknowledged"
      ? { state: "acknowledged", opsReceipts: 1, opsCancellations: 0, clientReceipts: 1, clientCancellations: 0 }
      : { state: "dead", opsReceipts: 0, opsCancellations: 1, clientReceipts: 0, clientCancellations: 1 });
    if (state === "acknowledged") {
      const opsWinner = await ops.prepare(`SELECT receipt.operation_id operationId,receipt.publication_id publicationId,
        receipt.operation_fingerprint fingerprint,receipt.target_id targetId,
        receipt.resulting_revision resultingRevision,receipt.source_sequence sourceSequence,
        receipt.snapshot_id snapshotId,receipt.snapshot_sha256 snapshotSha256,
        head.publication_revision revision,head.target_revision targetRevision,
        head.client_authority_id clientAuthorityId,head.workspace_id workspaceId,head.root_kind rootKind,
        head.root_record_id rootRecordId,head.checkpoint_id checkpointId,
        head.latest_operation_id latestOperationId,snapshot.snapshot_json snapshotJson
        FROM operations_portal_workspace_publication_receipts receipt
        JOIN operations_portal_workspace_publication_heads head ON head.latest_operation_id=receipt.operation_id
        JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=receipt.snapshot_id
          AND snapshot.checkpoint_id=head.checkpoint_id AND snapshot.source_sequence=receipt.source_sequence
        WHERE receipt.operation_id=?`).bind(raced.operationId).first();
      const clientWinner = await client.prepare(`SELECT receipt.operation_id operationId,
        receipt.publication_id publicationId,receipt.request_fingerprint fingerprint,receipt.target_id targetId,
        receipt.resulting_revision resultingRevision,receipt.source_sequence sourceSequence,
        receipt.snapshot_id snapshotId,receipt.snapshot_sha256 snapshotSha256,
        head.revision revision,head.target_revision targetRevision,head.client_authority_id clientAuthorityId,
        head.workspace_id workspaceId,head.root_kind rootKind,head.root_record_id rootRecordId,
        head.checkpoint_id checkpointId,head.latest_operation_id latestOperationId,snapshot.snapshot_json snapshotJson
        FROM operations_portal_workspace_publication_receipts receipt
        JOIN operations_portal_workspace_publication_heads head ON head.latest_operation_id=receipt.operation_id
        JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=receipt.snapshot_id
          AND snapshot.operation_id=receipt.operation_id AND snapshot.checkpoint_id=head.checkpoint_id
          AND snapshot.source_sequence=receipt.source_sequence
        WHERE receipt.operation_id=?`).bind(raced.operationId).first();
      expect(opsWinner).not.toBeNull();
      expect(clientWinner).not.toBeNull();
      expect(opsWinner).toEqual(clientWinner);
    } else {
      const opsWinner = await ops.prepare(`SELECT operation_id operationId,publication_id publicationId,
        operation_fingerprint fingerprint,target_id targetId,target_revision targetRevision,
        client_authority_id clientAuthorityId,workspace_id workspaceId,root_kind rootKind,root_record_id rootRecordId,
        expected_revision expectedRevision,resulting_revision resultingRevision,source_sequence sourceSequence,
        snapshot_id snapshotId,checkpoint_id checkpointId,snapshot_sha256 snapshotSha256,
        client_cancelled_at cancelledAt FROM operations_portal_workspace_publication_cancellation_receipts
        WHERE operation_id=?`).bind(raced.operationId).first();
      const clientWinner = await client.prepare(`SELECT operation_id operationId,publication_id publicationId,
        request_fingerprint fingerprint,target_id targetId,target_revision targetRevision,
        client_authority_id clientAuthorityId,workspace_id workspaceId,root_kind rootKind,root_record_id rootRecordId,
        expected_revision expectedRevision,resulting_revision resultingRevision,source_sequence sourceSequence,
        snapshot_id snapshotId,checkpoint_id checkpointId,snapshot_sha256 snapshotSha256,cancelled_at cancelledAt
        FROM operations_portal_workspace_publication_cancellations WHERE operation_id=?`)
        .bind(raced.operationId).first();
      expect(opsWinner).not.toBeNull();
      expect(clientWinner).not.toBeNull();
      expect(opsWinner).toEqual(clientWinner);
      expect(await ops.prepare(`SELECT action FROM operations_portal_workspace_publication_cancellation_audit
        WHERE operation_id=?`).bind(raced.operationId).first("action")).toBe("workspace.snapshot.cancelled");
    }
    expect(await client.prepare("SELECT count(*) FROM portal_operations_principal_grant_heads").first("count(*)")).toBe(0);
    expect(await client.prepare("SELECT count(*) FROM portal_operations_workspace_authority_heads").first("count(*)")).toBe(0);
    expect(await client.prepare("SELECT count(*) FROM portal_v2_entitlements").first("count(*)")).toBe(0);
    expect(await client.prepare("SELECT count(*) FROM portal_v2_folder_bindings").first("count(*)")).toBe(0);
    expect(await client.prepare("SELECT count(*) FROM portal_verified_recipient_delivery_authority_heads").first("count(*)")).toBe(0);
    expect(await client.prepare("SELECT count(*) FROM shares").first("count(*)")).toBe(0);
    expect(await client.prepare("SELECT count(*) FROM client_delegated_shares").first("count(*)")).toBe(0);
    expect(await client.prepare("SELECT count(*) FROM viewer_client_grants").first("count(*)")).toBe(0);
    expect(await client.prepare("SELECT count(*) FROM viewer_native_client_grants").first("count(*)")).toBe(0);
    expect(await client.prepare("SELECT name FROM sqlite_schema WHERE name='operations_portal_native_authority_commands'")
      .first()).toBeNull();
    const privateResponse = await request(runtime, "client-http", { ignored: true });
    expect(privateResponse.status).toBe(404);
    expect(privateResponse.headers.get("cache-control")).toBe("no-store");
  }, 180_000);
});
