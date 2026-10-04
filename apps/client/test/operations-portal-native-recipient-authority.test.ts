import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { applyOperationsPortalNativeRecipientAuthority } from
  "../src/worker/operations-portal-native-recipient-authority";
import { readNativeOperationsPortalHomes } from "../src/worker/client-portal/operations-native-recipient-read";

const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const targetId = id(1), authorityId = id(2), recipientId = id(3), intentId = id(4);
const publicationOperationId = id(5), publicationId = id(6), snapshotId = id(7);
const clientId = "client:exact", rootId = "organization:exact", workspaceId = "workspace-exact";
const issuer = "https://team.cloudflareaccess.com", subject = "access|exact-person";
const principal = { issuer, subject, email: "ignored@example.invalid" };
const sha = "a".repeat(64);
const publicationFingerprint = "b".repeat(64);
const actor = { staffId: "staff:manager", verifiedAccessSubject: "access|manager", admissionVersion: "2",
  profileVersion: "3", grantGeneration: "4", verifiedUntil: "2099-01-01T00:00:00.000Z" };
function command(operationId: string, action: "recipient.grant" | "recipient.revoke", expectedGrantRevision: number) {
  return JSON.stringify({ protocol: "operations-portal-native-authority", protocolVersion: 1, permissionSchemaVersion: 3,
    action, operationId, target: { targetId, targetRevision: "1", clientAuthorityId: authorityId,
      workspaceId, rootKind: "organization", rootRecordId: rootId },
    recipient: { recipientBindingId: recipientId, enrollmentIntentId: intentId,
      targetClientRecordId: clientId, issuer, subject },
    expected: { ownershipEpoch: action === "recipient.grant" ? "0" : "1", grantRevision: String(expectedGrantRevision) },
    resulting: { ownershipEpoch: "1", grantRevision: String(expectedGrantRevision + 1) },
    permissions: action === "recipient.grant" ? ["operations.service_home.read"] : [], expiresAt: null,
    publication: action === "recipient.grant" ? { operationId: publicationOperationId, publicationId, revision: "1",
      sourceSequence: "1", snapshotId, snapshotSha256: sha, requestFingerprint: publicationFingerprint } : null,
    actorProof: actor, observedAt: "2026-09-30T12:00:00.000Z" });
}
const env = (db: D1Database) => ({ DELIVERY_DB: db,
  ENVIRONMENT: "staging",
  CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true" });

describe("Operations-native recipient authority consumer", () => {
  let runtime: Miniflare, db: D1Database;
  beforeEach(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { DELIVERY_DB: crypto.randomUUID() } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    await db.batch([
      db.prepare("CREATE TABLE operations_portal_workspace_publication_commands(operation_id TEXT PRIMARY KEY,target_id TEXT)"),
      db.prepare(`CREATE TABLE operations_portal_workspace_publication_receipts(operation_id TEXT PRIMARY KEY,
        publication_id TEXT,request_fingerprint TEXT,target_id TEXT,resulting_revision INTEGER,source_sequence INTEGER,
        snapshot_id TEXT,snapshot_sha256 TEXT)`),
      db.prepare(`CREATE TABLE operations_portal_workspace_publication_heads(target_id TEXT PRIMARY KEY,revision INTEGER,
        target_revision INTEGER,client_authority_id TEXT,workspace_id TEXT,root_kind TEXT,root_record_id TEXT,
        source_sequence INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT,latest_operation_id TEXT)`),
      db.prepare(`CREATE TABLE operations_portal_workspace_publication_snapshots(snapshot_id TEXT PRIMARY KEY,
        operation_id TEXT,target_id TEXT,revision INTEGER,source_sequence INTEGER,snapshot_sha256 TEXT,snapshot_json TEXT)`),
      db.prepare(`CREATE TABLE operations_portal_workspace_publication_history(operation_id TEXT PRIMARY KEY,
        target_id TEXT,revision INTEGER,source_sequence INTEGER,snapshot_id TEXT,snapshot_sha256 TEXT)`),
    ]);
    const migration = readFileSync(new URL("../migrations/0224_operations_portal_native_recipient_authority.sql", import.meta.url), "utf8");
    await db.batch(splitD1MigrationStatements(migration).map(statement => db.prepare(statement)));
    const snapshot = JSON.stringify({ directoryRecords: [
      { recordId: rootId, kind: "organization", parentRecordId: null },
      { recordId: clientId, kind: "client", parentRecordId: rootId },
    ] });
    await db.batch([
      db.prepare("INSERT INTO operations_portal_workspace_publication_commands VALUES(?,?)").bind(publicationOperationId, targetId),
      db.prepare("INSERT INTO operations_portal_workspace_publication_receipts VALUES(?,?,?,?,?,?,?,?)")
        .bind(publicationOperationId, publicationId, publicationFingerprint, targetId, 1, 1, snapshotId, sha),
      db.prepare("INSERT INTO operations_portal_workspace_publication_heads VALUES(?,1,1,?,?,'organization',?,1,?,?,?)")
        .bind(targetId, authorityId, workspaceId, rootId, snapshotId, sha, publicationOperationId),
      db.prepare("INSERT INTO operations_portal_workspace_publication_snapshots VALUES(?,?,?,1,1,?,?)")
        .bind(snapshotId, publicationOperationId, targetId, sha, snapshot),
      db.prepare("INSERT INTO operations_portal_workspace_publication_history VALUES(?,?,1,1,?,?)")
        .bind(publicationOperationId, targetId, snapshotId, sha),
    ]);
  });
  afterEach(async () => runtime.dispose());

  it("atomically grants, discovers, replays, revokes and immediately disappears", async () => {
    const grant = id(8), revoke = id(9), grantWire = command(grant, "recipient.grant", 0);
    const first = JSON.parse(await applyOperationsPortalNativeRecipientAuthority(env(db), grantWire));
    expect(first).toMatchObject({ ok: true, status: "recorded", action: "recipient.grant",
      ownershipEpoch: 1, grantRevision: 1, state: "active", replayed: false });
    expect(JSON.parse(await applyOperationsPortalNativeRecipientAuthority(env(db), grantWire)))
      .toMatchObject({ ok: true, status: "duplicate", replayed: true });
    expect(await readNativeOperationsPortalHomes(db, principal, true))
      .toEqual([{ authorityId, workspaceId, targetId, recipientBindingId: recipientId, ownershipEpoch: 1, grantRevision: 1 }]);
    const revoked = JSON.parse(await applyOperationsPortalNativeRecipientAuthority(env(db), command(revoke, "recipient.revoke", 1)));
    expect(revoked).toMatchObject({ ok: true, action: "recipient.revoke", grantRevision: 2, state: "revoked" });
    expect(await readNativeOperationsPortalHomes(db, principal, true)).toEqual([]);
    expect(await db.prepare("SELECT count(*) count FROM operations_portal_native_authority_receipts").first<number>("count")).toBe(2);
  });

  it("fails closed for stale topology, same operation drift and stale CAS", async () => {
    const operation = id(10), wire = command(operation, "recipient.grant", 0);
    await db.prepare("UPDATE operations_portal_workspace_publication_heads SET target_revision=2 WHERE target_id=?").bind(targetId).run();
    expect(JSON.parse(await applyOperationsPortalNativeRecipientAuthority(env(db), wire))).toMatchObject({ ok: false, code: "conflict" });
    await db.prepare("UPDATE operations_portal_workspace_publication_heads SET target_revision=1 WHERE target_id=?").bind(targetId).run();
    expect(JSON.parse(await applyOperationsPortalNativeRecipientAuthority(env(db), wire))).toMatchObject({ ok: true });
    const drift = JSON.parse(wire) as Record<string, unknown>;
    drift.observedAt = "2026-09-30T12:00:01.000Z";
    expect(JSON.parse(await applyOperationsPortalNativeRecipientAuthority(env(db), JSON.stringify(drift))))
      .toMatchObject({ ok: false, code: "conflict" });
    expect(JSON.parse(await applyOperationsPortalNativeRecipientAuthority(env(db), command(id(11), "recipient.revoke", 2))))
      .toMatchObject({ ok: false, code: "conflict" });
  });
});
