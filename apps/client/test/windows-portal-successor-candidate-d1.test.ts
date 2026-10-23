import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL } from "../src/worker/client-portal/windows-portal-successor-candidate";
import { grant, id, principal } from "./helpers/windows-portal-successor-fixture";
import { consumeOperationsPortalWorkspacePublication } from "../src/worker/operations-portal-workspace-publications";
import { applyOperationsPortalNativeRecipientAuthority } from "../src/worker/operations-portal-native-recipient-authority";
import { applyOperationsPortalNativeDeliveryAuthority } from "../src/worker/operations-portal-native-delivery-authority";
import { sha256OperationsPortalWorkspaceSnapshot, type OperationsPortalWorkspacePublication }
  from "@ltds/shared/operations-portal-workspace-publication";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand, type OperationsPortalNativeDeliveryAuthorityCommand }
  from "@ltds/shared/operations-portal-native-delivery-authority";

const migration = "0235_windows_portal_successor_candidates.sql";
async function apply(db: D1Database, file: string) {
  const sql = readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}
async function schema(db: D1Database) {
  for (const file of ["0223_operations_portal_workspace_publications.sql", "0224_operations_portal_native_recipient_authority.sql",
    "0227_operations_portal_native_delivery_authority.sql", "0228_operations_portal_native_content_start_audit.sql",
    "0229_operations_portal_native_delivery_regrant.sql", "0230_operations_portal_native_delivery_terminal_cancellations.sql"])
    await apply(db, file);
}
function publication(command: OperationsPortalNativeDeliveryAuthorityCommand): OperationsPortalWorkspacePublication {
  const f = command.resource;
  return { protocol: "operations-portal-workspace-publication", protocolVersion: 1, action: "publish",
    publicationId: command.publication.publicationId, operationId: command.publication.operationId,
    expectedRevision: "0", resultingRevision: "1", target: command.target,
    snapshot: { snapshotId: command.publication.snapshotId, checkpointId: id(401), sourceSequence: "1", complete: true,
      counts: { directoryRecords: 1, projects: 1, folderReservations: 1, recipientAuthorityHeads: 0, deliveryAuthorityHeads: 0 },
      snapshotSha256: "0".repeat(64), directoryRecords: [{ recordId: command.target.rootRecordId, kind: "client", version: "1",
        parentRecordId: null, relationshipVersion: "1", displayName: "Synthetic Client", externalFences: [] }],
      projects: [{ externalProjectId: f.externalProjectId, version: f.projectVersion, name: "Synthetic Project", lifecycle: "active",
        plannedStart: null, plannedEnd: null, completedAt: null, archived: false, archivedAt: null, overdueWarning: false,
        published: true, organizationRecordId: null, clientRecordId: command.recipient.targetClientRecordId, externalFence: null }],
      folderReservations: [{ reservationId: f.folderReservationId, externalProjectId: f.externalProjectId,
        opsFolderProjectId: f.opsFolderProjectId, divisionId: f.opsDivisionId, clientFolderBindingId: f.clientFolderBindingId,
        bindingVersion: f.folderReservationRevision, r2Prefix: f.selectedR2Prefix, state: "active" }],
      recipientAuthorityHeads: [], deliveryAuthorityHeads: [] },
    actorProof: { staffId: "synthetic-owner", verifiedAccessSubject: "synthetic-owner-subject", admissionVersion: "1", profileVersion: "1",
      grantGeneration: "1", verifiedUntil: new Date(Date.now() + 3600_000).toISOString() }, observedAt: new Date().toISOString() };
}

describe("successor candidate query against real Client schema", () => {
  it("stays within D1 expression depth and cannot infer authority from an empty schema", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { DB: crypto.randomUUID() } });
    try {
      const db = await runtime.getD1Database("DB") as unknown as D1Database;
      await schema(db);
      const before = (await db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).results;
      // The migration is one read-only view; prior views, tables and audit
      // guards remain byte-for-byte unchanged in sqlite_master.
      const sql = readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8");
      expect(splitD1MigrationStatements(sql)).toHaveLength(1);
      await db.prepare(sql).run();
      const after = (await db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all()).results;
      expect(after.filter(row => row.name !== "operations_portal_native_delivery_successor_candidates")).toEqual(before);
      const query = db.prepare(WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL).bind(id(2), principal.issuer, principal.subject);
      expect(await query.first()).toBeNull();
      const plan = await db.prepare("EXPLAIN QUERY PLAN " + WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL)
        .bind(id(2), principal.issuer, principal.subject).all();
      expect(plan.success).toBe(true);
      expect(plan.results.length).toBeGreaterThan(0);
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await runtime.dispose(); }
  });

  it.each(["file.download", "folder.list", "file.metadata"] as const)("tracks %s current applied publication while preserving original grant and terminal revoke fences", async feature => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { DB: crypto.randomUUID() } });
    try {
      const db = await runtime.getD1Database("DB") as unknown as D1Database;
      await schema(db); await apply(db, migration);
      let command: OperationsPortalNativeDeliveryAuthorityCommand = { ...grant(), features: [feature] }, published = publication(command);
      published = { ...published, snapshot: { ...published.snapshot, snapshotSha256: await sha256OperationsPortalWorkspaceSnapshot(published) } };
      const receipt = await consumeOperationsPortalWorkspacePublication(db, published);
      command = { ...command, publication: { ...command.publication, snapshotSha256: published.snapshot.snapshotSha256 } };
      const home = { protocol: "operations-portal-native-authority", protocolVersion: 1, permissionSchemaVersion: 3,
        action: "recipient.grant", operationId: command.recipient.homeGrantOperationId, target: command.target,
        recipient: { recipientBindingId: command.recipient.recipientBindingId, enrollmentIntentId: command.recipient.enrollmentIntentId,
          targetClientRecordId: command.recipient.targetClientRecordId, ...principal },
        expected: { ownershipEpoch: "0", grantRevision: "0" }, resulting: { ownershipEpoch: "1", grantRevision: "1" },
        permissions: ["operations.service_home.read"], expiresAt: null,
        publication: { ...command.publication, requestFingerprint: receipt.requestFingerprint },
        actorProof: published.actorProof, observedAt: new Date().toISOString() };
      const homeResult = JSON.parse(await applyOperationsPortalNativeRecipientAuthority({ DELIVERY_DB: db, ENVIRONMENT: "staging",
        EXPECTED_HOST: "client-staging.example.test", CLIENT_PORTAL_ORIGIN: "https://client-staging.example.test",
        CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true" }, JSON.stringify(home)));
      expect(homeResult).toMatchObject({ ok: true });
      command = { ...command, recipient: { ...command.recipient, homeRequestFingerprint: homeResult.requestFingerprint } };
      const env = { DELIVERY_DB: db, ENVIRONMENT: "staging", CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: "true" };
      const wire = canonicalOperationsPortalNativeDeliveryAuthorityCommand(command);
      expect(JSON.parse(await applyOperationsPortalNativeDeliveryAuthority(env, wire))).toMatchObject({ ok: true });
      const read = (subject = principal.subject) => db.prepare(WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL)
        .bind(command.authority.authorityId, principal.issuer, subject).first();
      const initial = await read();
      expect(initial).toMatchObject({ canonical_command_json: wire, publication_operation_id: published.operationId, publication_revision: 1 });
      expect(await read("another-person")).toBeNull();
      expect(await db.prepare("SELECT count(*) n FROM operations_portal_native_delivery_live_heads").first("n")).toBe(1);
      let next: OperationsPortalWorkspacePublication = { ...published, operationId: id(102), publicationId: id(202),
        expectedRevision: "1", resultingRevision: "2", snapshot: { ...published.snapshot, snapshotId: id(302), checkpointId: id(402), sourceSequence: "2" } };
      next = { ...next, snapshot: { ...next.snapshot, snapshotSha256: await sha256OperationsPortalWorkspaceSnapshot(next) } };
      await consumeOperationsPortalWorkspacePublication(db, next);
      expect(await read()).toMatchObject({ canonical_command_json: wire, request_fingerprint: initial!.request_fingerprint,
        publication_operation_id: next.operationId, publication_revision: 2, publication_source_sequence: 2 });
      // Candidate existence does not resurrect ordinary original-publication authority.
      expect(await db.prepare("SELECT count(*) n FROM operations_portal_native_delivery_live_heads").first("n")).toBe(0);
      const revoke: OperationsPortalNativeDeliveryAuthorityCommand = { ...command, operationId: id(501), action: "delivery.revoke",
        authority: { ...command.authority, expectedRevision: "1", resultingRevision: "2" }, features: [], expiresAt: null };
      expect(JSON.parse(await applyOperationsPortalNativeDeliveryAuthority(env, canonicalOperationsPortalNativeDeliveryAuthorityCommand(revoke))))
        .toMatchObject({ ok: true });
      expect(await read()).toBeNull();
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await runtime.dispose(); }
  }, 120_000);
});
