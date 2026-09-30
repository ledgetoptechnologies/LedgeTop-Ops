import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { sha256OperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublication } from "@ltds/shared/operations-portal-workspace-publication";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { applyCanonicalChain } from "./helpers/verified-recipient-canonical-lineage";
import { writeNativeDirectoryProfile, type NativeDirectoryCreateWrite }
  from "../src/worker/native-directory-profile-writer";
import { reserveOperationsPortalWorkspace } from "../src/worker/operations-portal-workspace-reservations";
import { dispatchOperationsPortalWorkspacePublication, reserveOperationsPortalWorkspacePublication }
  from "../src/worker/operations-portal-workspace-publication-outbox";
import { cancelOperationsPortalWorkspacePublication,
  type OperationsPortalWorkspacePublicationCancellation,
  type OperationsPortalWorkspacePublicationCancellationBinding }
  from "../src/worker/operations-portal-workspace-publication-cancellations";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "../src/worker/native-staff-auth";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { cancelOperationsPortalWorkspacePublicationRpc, getOperationsPortalWorkspacePublicationDispositionRpc,
  publishOperationsPortalWorkspaceRpc } from "../../client/src/worker/operations-portal-workspace-publication-entrypoint";

let runtime: Miniflare, db: D1Database, client: D1Database, sequence = 1;
const id = () => `d0000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
const rpcResponse = (value: unknown) => JSON.stringify(value);
const rootRecordId = "ops/organization/publication-cancellation";
const sourceInstance = "11111111-1111-4111-8111-111111111111";
const application = "22222222-2222-4222-8222-222222222222";
const epoch = "33333333-3333-4333-8333-333333333333";

function actor(): AuthenticatedNativeStaffWithAdmissionVersion {
  return { identity: { kind: "native", staffId: "cancellation-owner",
    verifiedAccessSubject: "access|cancellation-owner", email: "cancellation-owner@example.test",
    displayName: "Cancellation Owner", profileVersion: 1 }, admissionVersion: 1,
    verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() };
}
async function seedAuthority() {
  await db.batch([
    db.prepare(`INSERT INTO staff_users(id,email,display_name,access_subject,status)
      VALUES('cancellation-owner','cancellation-owner@example.test','Cancellation Owner',
        'access|cancellation-owner','active')`),
    db.prepare(`INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by)
      VALUES('cancellation-owner','access|cancellation-owner',1,'cancellation-owner')`),
    db.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name)
      VALUES('cancellation-owner','cancellation-owner@example.test','Cancellation Owner')`),
    db.prepare(`INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,division_id,scope_key,created_by)
      VALUES('cancellation-owner-role','cancellation-owner','role-owner','global',NULL,'global','cancellation-owner')`),
    ...["directory.portal_access.manage", "directory.profile.edit", "directory.identity.link"].map((permission, index) =>
      db.prepare(`INSERT INTO native_directory_grants
        (id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES(?, 'cancellation-owner',?,'allow','global',1,'cancellation-owner')`)
        .bind(`cancellation-owner-grant-${index}`, permission)),
    db.prepare(`INSERT INTO native_business_areas(id,name,active)
      VALUES('cancellation-area','Cancellation Area',1)`),
    db.prepare(`INSERT INTO native_business_divisions(id,business_area_id,name,active)
      VALUES('cancellation-division','cancellation-area','Cancellation Division',1)`),
  ]);
}
async function seedRoot(recordId = rootRecordId) {
  const admissionId = `admission-${id()}`, mutationId = id();
  const profile = { name: "Publication Cancellation Organization", generalEmail: "cancellation@example.test",
    generalPhone: "", addressLine1: "1 Main", addressLine2: "", city: "Austin", state: "TX",
    postalCode: "78701", country: "US" };
  const destination = { sourceId: "project-alpha:primary", sourceInstanceUUID: sourceInstance,
    applicationUUID: application, historyEpoch: epoch, origin: "https://pa.example.test",
    externalCanonicalId: recordId, expectedAuthorizationGeneration: "0" };
  await db.prepare(`INSERT INTO native_directory_create_admissions
    (id,staff_id,bound_access_subject,record_id,record_kind,scopes_json,profile_json,destinations_json,issued_by)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(admissionId, "cancellation-owner", "access|cancellation-owner", recordId,
      "organization", JSON.stringify([{ businessAreaId: "cancellation-area", divisionId: "cancellation-division" }]),
      JSON.stringify(profile), JSON.stringify([{ sourceId: destination.sourceId,
        sourceInstanceUUID: destination.sourceInstanceUUID, applicationUUID: destination.applicationUUID,
        historyEpoch: destination.historyEpoch, origin: destination.origin, externalCanonicalId: recordId }]),
      "cancellation-owner").run();
  const write: NativeDirectoryCreateWrite = { operation: "create", mutationId, createAdmissionId: admissionId,
    recordId, expectedLocalVersion: 0, kind: "organization", profile,
    scopes: [{ businessAreaId: "cancellation-area", divisionId: "cancellation-division" }],
    destinations: [destination], actor: { staffId: "cancellation-owner", accessSubject: "access|cancellation-owner",
      loginEmail: "cancellation-owner@example.test", admissionVersion: 1, profileVersion: 1,
      selectedGrantId: "cancellation-owner-grant-1", selectedIdentityGrantId: "cancellation-owner-grant-2" } };
  expect(await writeNativeDirectoryProfile(db, write)).toMatchObject({ status: "written", version: 1 });
}
async function applyExact(database: D1Database, application: "operations" | "client", name: string) {
  const sql = readFileSync(new URL(`../../${application}/migrations/${name}`, import.meta.url), "utf8");
  const statements = splitD1MigrationStatements(sql);
  await database.batch([...statements.map(statement => database.prepare(statement)),
    database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
}
function workspaceInput(recordId = rootRecordId) {
  return { operationId: id(), targetId: id(), clientAuthorityId: id(), workspaceId: `workspace:${id()}`,
    rootKind: "organization" as const, rootRecordId: recordId, rootRecordVersion: 1, relationshipVersion: null,
    expectedRevision: 0 as const, reason: "Reserve publication cancellation workspace" };
}
function publicationInput(targetId: string, expectedRevision: number) {
  return { operationId: id(), publicationId: id(), targetId, snapshotId: id(), checkpointId: id(), expectedRevision,
    reason: "Publish complete topology before cancellation" };
}
async function attemptedPublication(targetId: string, expectedRevision: number) {
  const input = publicationInput(targetId, expectedRevision);
  await reserveOperationsPortalWorkspacePublication(db, actor(), input);
  let publication: OperationsPortalWorkspacePublication | undefined;
  const result = await dispatchOperationsPortalWorkspacePublication({ db, operationId: input.operationId, binding: {
    async publishWorkspace(value) { publication = value; throw new Error("response-lost-after-invocation"); },
    async getPublicationStatus() { throw new Error("unexpected-status-before-first-attempt"); },
  } });
  expect(result).toEqual({ operationId: input.operationId, status: "retry" });
  expect(publication).toBeDefined();
  expect(await db.prepare(`SELECT remote_attempted FROM operations_portal_workspace_publication_outbox
    WHERE operation_id=?`).bind(input.operationId).first("remote_attempted")).toBe(1);
  return { input, publication: publication! };
}
async function cancellation(publication: OperationsPortalWorkspacePublication, replayed: boolean) {
  const requestFingerprint = await sha256OperationsPortalWorkspacePublication(publication);
  return { operationId: publication.operationId, publicationId: publication.publicationId, requestFingerprint,
    targetId: publication.target.targetId, targetRevision: publication.target.targetRevision,
    clientAuthorityId: publication.target.clientAuthorityId, workspaceId: publication.target.workspaceId,
    rootKind: publication.target.rootKind, rootRecordId: publication.target.rootRecordId,
    expectedRevision: publication.expectedRevision, resultingRevision: publication.resultingRevision,
    sourceSequence: publication.snapshot.sourceSequence, snapshotId: publication.snapshot.snapshotId,
    checkpointId: publication.snapshot.checkpointId, snapshotSha256: publication.snapshot.snapshotSha256,
    cancelledAt: "2026-09-30T12:00:00.000Z", replayed } satisfies OperationsPortalWorkspacePublicationCancellation;
}
async function receipt(publication: OperationsPortalWorkspacePublication, replayed: boolean) {
  return { operationId: publication.operationId, publicationId: publication.publicationId,
    requestFingerprint: await sha256OperationsPortalWorkspacePublication(publication),
    targetId: publication.target.targetId, resultingRevision: publication.resultingRevision,
    sourceSequence: publication.snapshot.sourceSequence, snapshotId: publication.snapshot.snapshotId,
    snapshotSha256: publication.snapshot.snapshotSha256, replayed };
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: crypto.randomUUID(), CLIENT_DB: crypto.randomUUID() } });
  db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
  client = await runtime.getD1Database("CLIENT_DB") as unknown as D1Database;
  expect(await applyCanonicalChain(db, "operations",
    "0153_operations_portal_workspace_publication_outbox.sql", true)).toHaveLength(153);
  await applyExact(db, "operations", "0155_operations_portal_workspace_publication_cancellations.sql");
  expect(await db.prepare("SELECT count(*) count FROM d1_migrations").first("count")).toBe(154);
  expect(await db.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first("name"))
    .toBe("0155_operations_portal_workspace_publication_cancellations.sql");
  await seedAuthority();
  await seedRoot();
  expect(await applyCanonicalChain(client, "client", "0223_operations_portal_workspace_publications.sql"))
    .toHaveLength(142);
  await applyExact(client, "client", "0225_operations_portal_workspace_publication_cancellations.sql");
  expect(await client.prepare("SELECT count(*) count FROM d1_migrations").first("count")).toBe(143);
  expect(await client.prepare("SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1").first("name"))
    .toBe("0225_operations_portal_workspace_publication_cancellations.sql");
}, 240_000);
afterAll(async () => runtime.dispose());

describe("0155 Operations publication cancellation receipt ledger", () => {
  it("keeps attempted work fenced until an exact durable cancellation and rejects hostile dispositions", async () => {
    const workspace = workspaceInput();
    await reserveOperationsPortalWorkspace(db, actor(), workspace);
    const first = await attemptedPublication(workspace.targetId, 0);
    const exactCancellation = await cancellation(first.publication, true);
    const exactCommittedReceipt = await receipt(first.publication, true);
    let getterCalled = false, cancelCalls = 0;
    const getter = { ok: true, cancellation: exactCancellation } as Record<string, unknown>;
    Object.defineProperty(getter, "disposition", { enumerable: true, get() {
      getterCalled = true; return "cancelled";
    } });
    const nestedGetter = { ...exactCancellation } as Record<string, unknown>;
    Object.defineProperty(nestedGetter, "operationId", { enumerable: true, get() {
      getterCalled = true; return first.publication.operationId;
    } });
    const hidden = { ...exactCancellation } as Record<string, unknown>;
    Object.defineProperty(hidden, "cancelledAt", { enumerable: false, value: exactCancellation.cancelledAt });
    const symbol = { ok: true, disposition: "cancelled", cancellation: exactCancellation,
      [Symbol("hostile")]: true };
    const inherited = Object.assign(Object.create({ inherited: true }),
      { ok: true, disposition: "cancelled", cancellation: exactCancellation });
    const malformed: unknown[] = [
      getter,
      { ok: true, disposition: "cancelled", cancellation: nestedGetter },
      { ok: true, disposition: "cancelled", cancellation: hidden },
      symbol,
      inherited,
      { ok: true, disposition: "cancelled", cancellation: { ...exactCancellation, extra: true } },
      { ok: true, disposition: "cancelled", cancellation: { ...exactCancellation, requestFingerprint: "f".repeat(64) } },
      { ok: true, disposition: "cancelled", cancellation: { ...exactCancellation, targetRevision: 1 } },
      { ok: true, disposition: "cancelled", cancellation: { ...exactCancellation,
        cancelledAt: "2026-09-30T12:00:00Z" } },
      { ok: true, disposition: "not-found", extra: true },
      "{",
      `"${"x".repeat(16_385)}"`,
      '{"ok":true,"ok":true,"disposition":"not-found"}',
      ` ${rpcResponse({ ok: true, disposition: "not-found" })}`,
      rpcResponse({ ok: true, disposition: "cancelled", cancellation: exactCancellation, extra: true }),
      rpcResponse({ ok: true, disposition: "cancelled",
        cancellation: { ...exactCancellation, extra: true } }),
      rpcResponse({ ok: true, disposition: "cancelled",
        cancellation: { ...exactCancellation, requestFingerprint: "f".repeat(64) } }),
      rpcResponse({ ok: true, disposition: "cancelled",
        cancellation: { ...exactCancellation, targetId: id() } }),
      rpcResponse({ ok: true, disposition: "cancelled",
        cancellation: { ...exactCancellation, targetRevision: 1 } }),
      rpcResponse({ ok: true, disposition: "cancelled",
        cancellation: { ...exactCancellation, cancelledAt: "2026-09-30T12:00:00Z" } }),
      rpcResponse({ ok: true, disposition: "committed",
        receipt: { ...exactCommittedReceipt, extra: true } }),
      rpcResponse({ ok: true, disposition: "committed",
        receipt: { ...exactCommittedReceipt, requestFingerprint: "f".repeat(64) } }),
      rpcResponse({ ok: true, disposition: "not-found", extra: true }),
    ];
    for (const response of malformed) {
      const result = await cancelOperationsPortalWorkspacePublication({ db, operationId: first.input.operationId,
        binding: { async getPublicationDisposition() { return response; }, async cancelWorkspacePublication() {
          cancelCalls += 1; throw new Error("must-not-cancel-after-invalid-status");
        } } });
      expect(result).toEqual({ operationId: first.input.operationId, status: "retry" });
    }
    expect(getterCalled).toBe(false);
    expect(cancelCalls).toBe(0);
    expect(await db.prepare(`SELECT state||':'||remote_attempted value
      FROM operations_portal_workspace_publication_outbox WHERE operation_id=?`).bind(first.input.operationId)
      .first("value")).toBe("retry:1");
    expect(await db.prepare(`SELECT count(*) count
      FROM operations_portal_workspace_publication_cancellation_receipts`).first("count")).toBe(0);

    let remoteCancellation: OperationsPortalWorkspacePublicationCancellation | null = null;
    const lostBinding: OperationsPortalWorkspacePublicationCancellationBinding = {
      async getPublicationDisposition() {
        return rpcResponse(remoteCancellation
          ? { ok: true, disposition: "cancelled", cancellation: { ...remoteCancellation, replayed: true } }
          : { ok: true, disposition: "not-found" });
      },
      async cancelWorkspacePublication(publication) {
        cancelCalls += 1;
        remoteCancellation = await cancellation(publication, false);
        throw new Error("client-committed-cancellation-before-response-loss");
      },
    };
    expect(await cancelOperationsPortalWorkspacePublication({ db, binding: lostBinding,
      operationId: first.input.operationId })).toEqual({ operationId: first.input.operationId, status: "retry" });
    expect(await db.prepare(`SELECT state||':'||remote_attempted value
      FROM operations_portal_workspace_publication_outbox WHERE operation_id=?`).bind(first.input.operationId)
      .first("value")).toBe("retry:1");
    expect(await db.prepare(`SELECT count(*) count
      FROM operations_portal_workspace_publication_cancellation_receipts`).first("count")).toBe(0);

    const reconciled = await cancelOperationsPortalWorkspacePublication({ db, binding: lostBinding,
      operationId: first.input.operationId });
    expect(reconciled).toMatchObject({ operationId: first.input.operationId, status: "cancelled", replayed: true,
      cancellation: { operationId: first.input.operationId, requestFingerprint: exactCancellation.requestFingerprint,
        cancelledAt: exactCancellation.cancelledAt, replayed: true } });
    expect(cancelCalls).toBe(1);
    expect(await db.prepare(`SELECT state||':'||remote_attempted||':'||last_error_code value
      FROM operations_portal_workspace_publication_outbox WHERE operation_id=?`).bind(first.input.operationId)
      .first("value")).toBe("dead:1:client-cancelled");
    expect(await db.prepare(`SELECT action FROM operations_portal_workspace_publication_cancellation_audit
      WHERE operation_id=?`).bind(first.input.operationId).first("action")).toBe("workspace.snapshot.cancelled");
    expect(await db.prepare(`SELECT count(*) count FROM operations_portal_workspace_publication_cancellation_receipts
      WHERE operation_id=? AND target_revision=? AND checkpoint_id=?`).bind(first.input.operationId,
        Number(first.publication.target.targetRevision), first.publication.snapshot.checkpointId).first("count")).toBe(1);
    const replay = await cancelOperationsPortalWorkspacePublication({ db, operationId: first.input.operationId,
      binding: { async getPublicationDisposition() { throw new Error("replay-must-not-call-client"); },
        async cancelWorkspacePublication() { throw new Error("replay-must-not-call-client"); } } });
    expect(replay).toMatchObject({ status: "cancelled", replayed: true });
    await expect(db.prepare(`UPDATE operations_portal_workspace_publication_cancellation_receipts
      SET client_replayed=0 WHERE operation_id=?`).bind(first.input.operationId).run()).rejects.toThrow();
    await expect(db.prepare(`DELETE FROM operations_portal_workspace_publication_cancellation_audit
      WHERE operation_id=?`).bind(first.input.operationId).run()).rejects.toThrow();
  }, 180_000);

  it("requires exact current-claim evidence, rejects raw release, and lets an exact commit win", async () => {
    const targetId = String(await db.prepare(`SELECT target_id FROM operations_portal_workspace_reservation_heads
      WHERE state='active'`).first("target_id"));
    const second = await attemptedPublication(targetId, 0);
    const row = await db.prepare(`SELECT command.*,outbox.state,outbox.remote_attempted FROM
      operations_portal_workspace_publication_commands command JOIN operations_portal_workspace_publication_outbox outbox
      ON outbox.operation_id=command.operation_id WHERE command.operation_id=?`).bind(second.input.operationId)
      .first<Record<string, string | number>>();
    expect(row).not.toBeNull();
    const rawClaim = id(), until = new Date(Date.now() + 60_000).toISOString();
    expect((await db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='dispatching',
      attempt_count=attempt_count+1,claim_token=?,claim_until=? WHERE operation_id=? AND state='retry' AND remote_attempted=1`)
      .bind(rawClaim, until, second.input.operationId).run()).meta.changes).toBe(1);
    await expect(db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='dead',
      last_error_code='client-cancelled',claim_token=NULL,claim_until=NULL
      WHERE operation_id=? AND state='dispatching' AND claim_token=?`).bind(second.input.operationId, rawClaim).run())
      .rejects.toThrow("publication outbox transition denied");
    const cancellationSql = `INSERT INTO operations_portal_workspace_publication_cancellation_receipts
      (operation_id,publication_id,operation_fingerprint,target_id,target_revision,client_authority_id,workspace_id,
        root_kind,root_record_id,expected_revision,resulting_revision,source_sequence,snapshot_id,checkpoint_id,
        snapshot_sha256,client_cancelled_at,client_replayed,cancelled_claim_token)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
    const binds = [row!.operation_id, row!.publication_id, row!.operation_fingerprint, row!.target_id,
      row!.target_revision, row!.client_authority_id, row!.workspace_id, row!.root_kind, row!.root_record_id,
      row!.expected_revision, row!.resulting_revision, row!.source_sequence, row!.snapshot_id, row!.checkpoint_id,
      row!.snapshot_sha256, "2026-09-30T12:00:00.000Z", 0, rawClaim];
    await expect(db.prepare(cancellationSql).bind(...binds.map((value, index) => index === 4
      ? Number(value) + 1 : value)).run()).rejects.toThrow("publication cancellation receipt is not exact");
    await expect(db.prepare(cancellationSql).bind(...binds.map((value, index) => index === 15
      ? "2026-09-30T12:00:00Z" : value)).run()).rejects.toThrow();
    await expect(db.prepare(cancellationSql).bind(...binds.map((value, index) => index === 17
      ? id() : value)).run()).rejects.toThrow("publication cancellation receipt is not exact");
    expect((await db.prepare(`UPDATE operations_portal_workspace_publication_outbox SET state='retry',
      last_error_code='raw-guard-tested',claim_token=NULL,claim_until=NULL WHERE operation_id=? AND state='dispatching'
      AND claim_token=?`).bind(second.input.operationId, rawClaim).run()).meta.changes).toBe(1);

    const exactReceipt = await receipt(second.publication, false);
    let cancelCalled = false;
    const committed = await cancelOperationsPortalWorkspacePublication({ db, operationId: second.input.operationId,
      binding: { async getPublicationDisposition() {
        return rpcResponse({ ok: true, disposition: "committed", receipt: exactReceipt });
      }, async cancelWorkspacePublication() { cancelCalled = true;
        return rpcResponse({ ok: true, disposition: "not-found" }); } } });
    expect(committed).toEqual({ operationId: second.input.operationId, status: "acknowledged", replayed: false });
    expect(cancelCalled).toBe(false);
    expect(await db.prepare(`SELECT state||':'||remote_attempted value
      FROM operations_portal_workspace_publication_outbox WHERE operation_id=?`).bind(second.input.operationId)
      .first("value")).toBe("acknowledged:1");
    expect(await db.prepare(`SELECT count(*) count FROM operations_portal_workspace_publication_heads
      WHERE target_id=? AND publication_revision=1 AND latest_operation_id=?`).bind(targetId, second.input.operationId)
      .first("count")).toBe(1);
    expect(await db.prepare(`SELECT count(*) count FROM operations_portal_workspace_publication_cancellation_receipts
      WHERE operation_id=?`).bind(second.input.operationId).first("count")).toBe(0);

    const third = await attemptedPublication(targetId, 1);
    const thirdReceipt = await receipt(third.publication, false);
    expect(await cancelOperationsPortalWorkspacePublication({ db, operationId: third.input.operationId,
      binding: { async getPublicationDisposition() {
        return rpcResponse({ ok: true, disposition: "committed", receipt: thirdReceipt });
      }, async cancelWorkspacePublication() { throw new Error("committed-status-must-win"); } } }))
      .toEqual({ operationId: third.input.operationId, status: "acknowledged", replayed: false });
    let historicalRpc = false;
    expect(await cancelOperationsPortalWorkspacePublication({ db, operationId: second.input.operationId,
      binding: { async getPublicationDisposition() { historicalRpc = true; throw new Error("historical-no-rpc"); },
        async cancelWorkspacePublication() { historicalRpc = true; throw new Error("historical-no-rpc"); } } }))
      .toEqual({ operationId: second.input.operationId, status: "acknowledged", replayed: true });
    expect(historicalRpc).toBe(false);
    expect(await db.prepare(`SELECT publication_revision FROM operations_portal_workspace_publication_heads
      WHERE target_id=?`).bind(targetId).first("publication_revision")).toBe(2);
  }, 180_000);

  it("reconciles cancel-first, publish-first, and concurrent outcomes against a real 0225 Client database", async () => {
    const clientEnv = { DELIVERY_DB: client, ENVIRONMENT: "staging",
      EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com",
      CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true" };
    const binding: OperationsPortalWorkspacePublicationCancellationBinding = {
      cancelWorkspacePublication: async publication => rpcResponse(
        await cancelOperationsPortalWorkspacePublicationRpc(clientEnv, publication)),
      getPublicationDisposition: async publication => rpcResponse(
        await getOperationsPortalWorkspacePublicationDispositionRpc(clientEnv, publication)),
    };
    const authorityCount = async () => Number(await client.prepare(`SELECT
      (SELECT count(*) FROM portal_operations_workspace_authority_heads)
      +(SELECT count(*) FROM portal_operations_principal_grant_heads)
      +(SELECT count(*) FROM portal_verified_recipient_delivery_authority_heads) count`).first("count"));
    const grantsBefore = await authorityCount();

    const cancelRoot = "ops/organization/publication-cancel-first";
    await seedRoot(cancelRoot);
    const cancelWorkspace = workspaceInput(cancelRoot);
    await reserveOperationsPortalWorkspace(db, actor(), cancelWorkspace);
    const cancelFirst = await attemptedPublication(cancelWorkspace.targetId, 0);
    let cancelledResponse: unknown;
    const lostCancellationBinding: OperationsPortalWorkspacePublicationCancellationBinding = {
      getPublicationDisposition: binding.getPublicationDisposition.bind(binding),
      async cancelWorkspacePublication(publication) {
        const response = await binding.cancelWorkspacePublication(publication);
        cancelledResponse = typeof response === "string" ? JSON.parse(response) : response;
        throw new Error("lost-client-cancel-response");
      },
    };
    expect(await cancelOperationsPortalWorkspacePublication({ db, operationId: cancelFirst.input.operationId,
      binding: lostCancellationBinding })).toEqual({ operationId: cancelFirst.input.operationId, status: "retry" });
    expect(cancelledResponse).toMatchObject({ ok: true, disposition: "cancelled",
      cancellation: { operationId: cancelFirst.input.operationId, replayed: false } });
    expect(await db.prepare(`SELECT state||':'||remote_attempted value
      FROM operations_portal_workspace_publication_outbox WHERE operation_id=?`).bind(cancelFirst.input.operationId)
      .first("value")).toBe("retry:1");
    expect(await cancelOperationsPortalWorkspacePublication({ db, operationId: cancelFirst.input.operationId,
      binding })).toMatchObject({ status: "cancelled", replayed: true,
        cancellation: { operationId: cancelFirst.input.operationId } });
    expect(await publishOperationsPortalWorkspaceRpc(clientEnv, cancelFirst.publication))
      .toMatchObject({ ok: true, disposition: "cancelled",
        cancellation: { operationId: cancelFirst.input.operationId, replayed: true } });
    expect(await client.prepare(`SELECT
      (SELECT count(*) FROM operations_portal_workspace_publication_commands WHERE operation_id=?) commands,
      (SELECT count(*) FROM operations_portal_workspace_publication_cancellations WHERE operation_id=?) cancellations`)
      .bind(cancelFirst.input.operationId, cancelFirst.input.operationId)
      .first()).toEqual({ commands: 0, cancellations: 1 });
    const replacement = await reserveOperationsPortalWorkspacePublication(db, actor(),
      publicationInput(cancelWorkspace.targetId, 0));
    expect(replacement).toMatchObject({ state: "pending", publicationRevision: 1, replayed: false });

    const publishRoot = "ops/organization/publication-publish-first";
    await seedRoot(publishRoot);
    const publishWorkspace = workspaceInput(publishRoot);
    await reserveOperationsPortalWorkspace(db, actor(), publishWorkspace);
    const publishFirst = await attemptedPublication(publishWorkspace.targetId, 0);
    expect(await publishOperationsPortalWorkspaceRpc(clientEnv, publishFirst.publication))
      .toMatchObject({ ok: true, receipt: { operationId: publishFirst.input.operationId, replayed: false } });
    expect(await cancelOperationsPortalWorkspacePublication({ db, operationId: publishFirst.input.operationId,
      binding })).toEqual({ operationId: publishFirst.input.operationId, status: "acknowledged", replayed: true });
    expect(await client.prepare(`SELECT
      (SELECT count(*) FROM operations_portal_workspace_publication_commands WHERE operation_id=?) commands,
      (SELECT count(*) FROM operations_portal_workspace_publication_cancellations WHERE operation_id=?) cancellations`)
      .bind(publishFirst.input.operationId, publishFirst.input.operationId)
      .first()).toEqual({ commands: 1, cancellations: 0 });

    const raceRoot = "ops/organization/publication-concurrent-terminal";
    await seedRoot(raceRoot);
    const raceWorkspace = workspaceInput(raceRoot);
    await reserveOperationsPortalWorkspace(db, actor(), raceWorkspace);
    const raced = await attemptedPublication(raceWorkspace.targetId, 0);
    const [publishRace, cancelRace] = await Promise.all([
      publishOperationsPortalWorkspaceRpc(clientEnv, raced.publication),
      cancelOperationsPortalWorkspacePublicationRpc(clientEnv, raced.publication),
    ]);
    const clientTerminal = await getOperationsPortalWorkspacePublicationDispositionRpc(clientEnv, raced.publication);
    expect(clientTerminal).toMatchObject({ ok: true });
    expect(clientTerminal.ok && clientTerminal.disposition).toMatch(/^(committed|cancelled)$/);
    expect(publishRace).toMatchObject({ ok: true });
    expect(cancelRace).toMatchObject({ ok: true });
    const clientRows = await client.prepare(`SELECT
      (SELECT count(*) FROM operations_portal_workspace_publication_commands WHERE operation_id=?) commands,
      (SELECT count(*) FROM operations_portal_workspace_publication_cancellations WHERE operation_id=?) cancellations`)
      .bind(raced.input.operationId, raced.input.operationId).first<{ commands: number; cancellations: number }>();
    expect(clientRows).not.toBeNull();
    expect(clientRows!.commands + clientRows!.cancellations).toBe(1);
    expect(await cancelOperationsPortalWorkspacePublication({ db, operationId: raced.input.operationId, binding }))
      .toMatchObject({ operationId: raced.input.operationId,
        status: clientTerminal.ok && clientTerminal.disposition === "committed" ? "acknowledged" : "cancelled" });
    expect(await authorityCount()).toBe(grantsBefore);
  }, 240_000);
});
