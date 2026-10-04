import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand as canonical,
  type OperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";
import { sha256OperationsPortalWorkspaceSnapshot, type OperationsPortalWorkspacePublication }
  from "@ltds/shared/operations-portal-workspace-publication";
import { appendOperationsNativeContentStart, OperationsNativeContentAuditUnavailableError }
  from "../src/worker/client-portal/operations-native-content-audit";
import { consumeOperationsPortalWorkspacePublication } from "../src/worker/operations-portal-workspace-publications";
import { applyOperationsPortalNativeRecipientAuthority } from "../src/worker/operations-portal-native-recipient-authority";
import { applyOperationsPortalNativeDeliveryAuthority } from "../src/worker/operations-portal-native-delivery-authority";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const issuer = "https://synthetic.cloudflareaccess.com", subject = "synthetic-recipient";
const principal = { issuer, subject };
const actor = { staffId: "synthetic-owner", verifiedAccessSubject: "synthetic-owner-subject", admissionVersion: "1",
  profileVersion: "1", grantGeneration: "1", verifiedUntil: new Date(Date.now() + 3_600_000).toISOString() };
const secret = "native-content-audit-secret-32-bytes-minimum";
const storageKey = "synthetic/photos/image.tif", contentVersion = "etag-sensitive-value";

function publication(): OperationsPortalWorkspacePublication {
  return { protocol: "operations-portal-workspace-publication", protocolVersion: 1, action: "publish",
    publicationId: id(1), operationId: id(2), expectedRevision: "0", resultingRevision: "1",
    target: { targetId: id(3), targetRevision: "1", clientAuthorityId: id(4), workspaceId: "synthetic-workspace",
      rootKind: "standalone_client", rootRecordId: "synthetic-client" },
    snapshot: { snapshotId: id(5), checkpointId: id(6), sourceSequence: "1", complete: true,
      counts: { directoryRecords: 1, projects: 1, folderReservations: 1, recipientAuthorityHeads: 0, deliveryAuthorityHeads: 0 },
      snapshotSha256: "0".repeat(64), directoryRecords: [{ recordId: "synthetic-client", kind: "client", version: "1",
        parentRecordId: null, relationshipVersion: "1", displayName: "Synthetic Client", externalFences: [] }],
      projects: [{ externalProjectId: "synthetic-project", version: "1", name: "Synthetic Project", lifecycle: "active",
        plannedStart: null, plannedEnd: null, completedAt: null, archived: false, archivedAt: null, overdueWarning: false,
        published: true, organizationRecordId: null, clientRecordId: "synthetic-client", externalFence: null }],
      folderReservations: [{ reservationId: id(7), externalProjectId: "synthetic-project",
        opsFolderProjectId: "synthetic-physical-project", divisionId: "synthetic-division",
        clientFolderBindingId: "synthetic-folder", bindingVersion: "1", r2Prefix: "synthetic/photos/", state: "active" }],
      recipientAuthorityHeads: [], deliveryAuthorityHeads: [] }, actorProof: actor, observedAt: new Date().toISOString() };
}

describe("Operations native content-start audit with real delivery authority", () => {
  let runtime: Miniflare, db: D1Database, empty: D1Database;
  let command: OperationsPortalNativeDeliveryAuthorityCommand, requestFingerprint: string;
  const env = () => ({ DELIVERY_DB: db, ENVIRONMENT: "staging", CLIENT_PORTAL_ORIGIN: "https://client-staging.ledgetopdroneservices.com",
    CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED: "true",
    CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET: secret });
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
      d1Databases: { DELIVERY_DB: crypto.randomUUID(), EMPTY_DB: crypto.randomUUID() } });
    db = await runtime.getD1Database("DELIVERY_DB") as unknown as D1Database;
    empty = await runtime.getD1Database("EMPTY_DB") as unknown as D1Database;
    await db.prepare("CREATE TABLE file_index(r2_key TEXT PRIMARY KEY,etag TEXT NOT NULL)").run();
    const tombstones = readFileSync(new URL("../migrations/0008_trash_tombstones.sql", import.meta.url), "utf8");
    await db.batch(splitD1MigrationStatements(tombstones).map(statement => db.prepare(statement)));
    for (const name of ["0223_operations_portal_workspace_publications.sql", "0224_operations_portal_native_recipient_authority.sql",
      "0225_operations_portal_workspace_publication_cancellations.sql", "0226_operations_portal_native_workspace_cleanup.sql",
      "0227_operations_portal_native_delivery_authority.sql", "0228_operations_portal_native_content_start_audit.sql"]) {
      const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
      await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
    }
    let published = publication();
    published = { ...published, snapshot: { ...published.snapshot,
      snapshotSha256: await sha256OperationsPortalWorkspaceSnapshot(published) } };
    const publicationReceipt = await consumeOperationsPortalWorkspacePublication(db, published);
    const home = { protocol: "operations-portal-native-authority", protocolVersion: 1, permissionSchemaVersion: 3,
      action: "recipient.grant", operationId: id(8), target: published.target,
      recipient: { recipientBindingId: id(9), enrollmentIntentId: id(10), targetClientRecordId: "synthetic-client", issuer, subject },
      expected: { ownershipEpoch: "0", grantRevision: "0" }, resulting: { ownershipEpoch: "1", grantRevision: "1" },
      permissions: ["operations.service_home.read"], expiresAt: null,
      publication: { operationId: published.operationId, publicationId: published.publicationId, revision: "1", sourceSequence: "1",
        snapshotId: published.snapshot.snapshotId, snapshotSha256: published.snapshot.snapshotSha256,
        requestFingerprint: publicationReceipt.requestFingerprint }, actorProof: actor, observedAt: new Date().toISOString() };
    const homeResult = JSON.parse(await applyOperationsPortalNativeRecipientAuthority({ DELIVERY_DB: db, ENVIRONMENT: "staging",
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED: "true" }, JSON.stringify(home)));
    expect(homeResult.ok).toBe(true);
    command = { protocol: "operations-portal-native-delivery-authority", protocolVersion: 1, permissionSchemaVersion: 3,
      action: "delivery.grant", operationId: id(11), authority: { authorityId: id(12), expectedRevision: "0", resultingRevision: "1" },
      target: published.target, recipient: { recipientBindingId: id(9), enrollmentIntentId: id(10),
        targetClientRecordId: "synthetic-client", issuer, subject, homeOwnershipEpoch: "1", homeGrantRevision: "1",
        homeGrantOperationId: id(8), homeRequestFingerprint: homeResult.requestFingerprint },
      publication: { operationId: published.operationId, publicationId: published.publicationId, revision: "1", sourceSequence: "1",
        snapshotId: published.snapshot.snapshotId, snapshotSha256: published.snapshot.snapshotSha256 },
      resource: { folderReservationId: id(7), folderReservationRevision: "1", clientFolderBindingId: "synthetic-folder",
        externalProjectId: "synthetic-project", projectVersion: "1", opsFolderProjectId: "synthetic-physical-project",
        opsDivisionId: "synthetic-division", selectedR2Prefix: "synthetic/photos/", baseR2Prefix: "synthetic/",
        baseMatchMethod: "manual", baseConfirmedBy: "synthetic-owner", baseConfirmedAt: new Date().toISOString() },
      features: ["folder.list", "file.metadata", "file.preview", "file.download"],
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), reasonCode: "synthetic-acceptance", observedAt: new Date().toISOString() };
    const delivery = JSON.parse(await applyOperationsPortalNativeDeliveryAuthority({ DELIVERY_DB: db, ENVIRONMENT: "staging",
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: "true" }, canonical(command)));
    expect(delivery.ok).toBe(true); requestFingerprint = delivery.receipt.requestFingerprint;
    await db.prepare("INSERT INTO file_index VALUES(?,?)").bind(storageKey, contentVersion).run();
  }, 120_000);
  afterAll(async () => runtime?.dispose());

  it("fails closed before database work when disabled or misconfigured and on missing schema", async () => {
    const dead = {} as D1Database;
    await expect(appendOperationsNativeContentStart({ DELIVERY_DB: dead, ENVIRONMENT: "production",
      CLIENT_PORTAL_ORIGIN: "https://client-staging.ledgetopdroneservices.com", CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED: "true",
      CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET: secret }, {} as never))
      .rejects.toMatchObject({ reason: "disabled" });
    for (const CLIENT_PORTAL_ORIGIN of [undefined, "https://portal-staging.ledgetoptechnologies.com"]) {
      await expect(appendOperationsNativeContentStart({ DELIVERY_DB: dead, ENVIRONMENT: "staging", CLIENT_PORTAL_ORIGIN,
        CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED: "true",
        CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET: secret }, {} as never))
        .rejects.toMatchObject({ reason: "disabled" });
    }
    await expect(appendOperationsNativeContentStart({ ...env(), CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET: "short" }, {} as never))
      .rejects.toMatchObject({ reason: "configuration_invalid" });
    await expect(appendOperationsNativeContentStart({ ...env(), DELIVERY_DB: empty }, {} as never))
      .rejects.toMatchObject({ reason: "schema_missing" });
  });

  it("records before handoff, dedupes exactly, stores no raw principal/key/version, and requires current index", async () => {
    const input = { principal, context: { command, requestFingerprint, selectedR2Prefix: command.resource.selectedR2Prefix },
      action: "file.download_requested" as const, feature: "file.download" as const, storageKey, contentVersion };
    const first = await appendOperationsNativeContentStart(env(), input);
    expect(first).toMatchObject({ replayed: false });
    await expect(appendOperationsNativeContentStart(env(), input)).resolves.toEqual({ ...first, replayed: true });
    const row = await db.prepare("SELECT * FROM operations_portal_native_content_start_events").first<Record<string, unknown>>();
    expect(row).not.toBeNull(); expect(row!.principal_fingerprint).toHaveLength(43);
    expect(row!.prefix_fingerprint).toHaveLength(43); expect(row!.resource_fingerprint).toHaveLength(43);
    expect(row!.content_version_fingerprint).toHaveLength(43);
    const retained = JSON.stringify(row);
    for (const raw of [issuer, subject, storageKey, contentVersion, command.resource.selectedR2Prefix]) expect(retained).not.toContain(raw);
    expect(await db.prepare("SELECT count(*) n FROM operations_portal_native_content_start_events").first("n")).toBe(1);
    await db.prepare(`INSERT INTO delivery_tombstones(id,physical_key,tombstone_kind,deleted_by,purge_after)
      VALUES('audit-tombstone',?,'exact','synthetic-owner',datetime('now','+30 days'))`).bind(storageKey).run();
    await expect(appendOperationsNativeContentStart(env(), input)).rejects.toMatchObject({ reason: "authority_stale" });
    await db.prepare("UPDATE delivery_tombstones SET restored_by='synthetic-owner',restored_at=datetime('now') WHERE id='audit-tombstone'").run();
    await db.prepare("UPDATE file_index SET etag='changed' WHERE r2_key=?").bind(storageKey).run();
    await expect(appendOperationsNativeContentStart(env(), input)).rejects.toMatchObject({ reason: "authority_stale" });
    await db.prepare("UPDATE file_index SET etag=? WHERE r2_key=?").bind(contentVersion, storageKey).run();
    await expect(db.prepare("UPDATE operations_portal_native_content_start_events SET action='file.preview_requested'").run())
      .rejects.toThrow("native content start audit is immutable");
    await expect(db.prepare("DELETE FROM operations_portal_native_content_start_events").run())
      .rejects.toThrow("native content start audit is durable");
  });

  it("denies replay after the exact current delivery head is revoked", async () => {
    const revoke = { ...command, action: "delivery.revoke" as const, operationId: id(13),
      authority: { ...command.authority, expectedRevision: "1", resultingRevision: "2" }, features: [], expiresAt: null };
    expect(JSON.parse(await applyOperationsPortalNativeDeliveryAuthority({ DELIVERY_DB: db, ENVIRONMENT: "staging",
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: "true" }, canonical(revoke))).ok).toBe(true);
    await expect(appendOperationsNativeContentStart(env(), { principal,
      context: { command, requestFingerprint, selectedR2Prefix: command.resource.selectedR2Prefix },
      action: "file.download_requested", feature: "file.download", storageKey, contentVersion }))
      .rejects.toBeInstanceOf(OperationsNativeContentAuditUnavailableError);
    expect(await db.prepare("SELECT count(*) n FROM operations_portal_native_content_start_events").first("n")).toBe(1);
  });
});
