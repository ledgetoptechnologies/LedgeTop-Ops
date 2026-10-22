import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
import { runCanonicalPortalResourceAcceptance } from "./helpers/operations-native-portal-resource-acceptance-fixture";
import { listOperationsPortalNativeDeliveryCandidates, issueOperationsPortalNativeDeliveryAuthority,
  revokeOperationsPortalNativeDeliveryAuthority } from "../src/worker/operations-portal-native-delivery-authority-issuer";
import { dispatchNextOperationsPortalNativeDeliveryAuthority } from "../src/worker/operations-portal-native-delivery-authority-dispatch";
import { applyOperationsPortalNativeDeliveryAuthority, readOperationsPortalNativeDeliveryAuthorityStatus }
  from "../../client/src/worker/operations-portal-native-delivery-authority";
import { reserveOperationsPortalWorkspacePublication, dispatchOperationsPortalWorkspacePublication }
  from "../src/worker/operations-portal-workspace-publication-outbox";
import { reserveOperationsPortalWorkspacePublicationInvocation } from "../src/worker/operations-portal-workspace-publication-invocations";
import { publishOperationsPortalWorkspaceRpc, getOperationsPortalWorkspacePublicationStatusRpc }
  from "../../client/src/worker/operations-portal-workspace-publication-entrypoint";
import { readWindowsPortalPublicationChainEvidence } from "../src/worker/windows-portal-publication-chain";
import { readWindowsPortalSuccessorAuthorization, readWindowsPortalSuccessorAuthorizationEntrypoint,
  readOperationsPortalNativeDeliveryAuthorization }
  from "../src/worker/operations-portal-native-delivery-authority-reader";
import { parseOperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";

describe("Windows publication history evidence with real canonical Ops/Client producers", () => {
  it("retains an unchanged grant across applied refreshes, excludes pending commands, and rejects revocation", async () => {
    await runCanonicalPortalResourceAcceptance(async ctx => {
      const { operations: db, client, id, owner } = ctx;
      await db.prepare(readFileSync(new URL("../migrations/0224_windows_portal_publication_chain_index.sql", import.meta.url), "utf8")).run();
      const candidate = (await listOperationsPortalNativeDeliveryCandidates(db, { targetId: ctx.workspace.targetId, owner })).items
        .find(item => item.recipientBindingId === ctx.recipient.recipientBindingId);
      if (!candidate || !ctx.recipient.recipientBindingId) throw new Error("missing synthetic candidate");
      const operationId = id(), authorityId = id();
      await issueOperationsPortalNativeDeliveryAuthority(db, { operationId, authorityId, owner,
        recipientBindingId: ctx.recipient.recipientBindingId, folderReservationId: candidate.folderReservationId,
        expectedRevision: 0, expectedCandidateFingerprint: candidate.candidateFingerprint, features: ["file.download"],
        expiresAt: new Date(Date.now() + 3600_000).toISOString(), reasonCode: "Synthetic Windows publication chain" });
      const wire = await db.prepare("SELECT canonical_wire_json wire FROM operations_portal_native_delivery_authority_outbox WHERE operation_id=?")
        .bind(operationId).first<string>("wire");
      const grant = parseOperationsPortalNativeDeliveryAuthorityCommand(JSON.parse(wire!));
      if (!grant) throw new Error("missing synthetic grant wire");
      // Producer acceptance is not enough: Client must acknowledge this grant.
      await expect(readWindowsPortalSuccessorAuthorization(db, grant)).rejects.toThrow();
      const env = { DELIVERY_DB: client, ENVIRONMENT: "staging", CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED: "true",
        CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED: "true" };
      await expect(dispatchNextOperationsPortalNativeDeliveryAuthority({ database: db, operationId, binding: {
        applyNativeDeliveryAuthority: wire => applyOperationsPortalNativeDeliveryAuthority(env, wire),
        getNativeDeliveryAuthorityStatus: wire => readOperationsPortalNativeDeliveryAuthorityStatus(env, wire),
      } })).resolves.toMatchObject({ state: "acknowledged" });
      const initial = await readWindowsPortalPublicationChainEvidence(db, grant);
      expect(initial.publicationCount).toBe(1);
      expect(initial.current).toEqual(initial.first);
      const original = await readWindowsPortalSuccessorAuthorization(db, grant);
      const oldRequest = { ...original.authorization, feature: "file.download" as const };
      await expect(readOperationsPortalNativeDeliveryAuthorization(db, oldRequest)).resolves.toEqual(original.authorization);
      for (const forged of [
        { ...grant, recipient: { ...grant.recipient, subject: "another-person" } },
        { ...grant, resource: { ...grant.resource, selectedR2Prefix: grant.resource.baseR2Prefix + "other/" } },
        { ...grant, features: ["file.metadata", "file.download"] },
        { ...grant, expiresAt: new Date(Date.parse(grant.expiresAt!) + 60_000).toISOString() },
      ]) await expect(readWindowsPortalSuccessorAuthorization(db, forged)).rejects.toThrow();
      const next = await reserveOperationsPortalWorkspacePublication(db, owner, { operationId: id(), publicationId: id(),
        targetId: ctx.workspace.targetId, snapshotId: id(), checkpointId: id(), expectedRevision: 1,
        reason: "Synthetic unrelated publication refresh" });
      // Enqueuing is not publication acceptance: the old current proof remains.
      expect((await readWindowsPortalPublicationChainEvidence(db, grant)).current).toEqual(initial.current);
      const invocationId = id();
      await reserveOperationsPortalWorkspacePublicationInvocation(db, owner, { invocationId, operationId: next.operationId,
        action: "publish", reason: "Synthetic publication dispatch" });
      const publicationEnv = { DELIVERY_DB: client, ENVIRONMENT: "staging", EXPECTED_HOST: "delivery-staging.ledgetopdroneservices.com",
        CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true" } as const;
      await expect(dispatchOperationsPortalWorkspacePublication({ db, operationId: next.operationId, invocationId, action: "publish", binding: {
        publishWorkspace: async value => JSON.stringify(await publishOperationsPortalWorkspaceRpc(publicationEnv, value)),
        getPublicationStatus: async value => JSON.stringify(await getOperationsPortalWorkspacePublicationStatusRpc(publicationEnv, value)),
      } })).resolves.toMatchObject({ status: "acknowledged" });
      const refreshed = await readWindowsPortalPublicationChainEvidence(db, grant);
      expect(refreshed).toMatchObject({ publicationCount: 2, first: initial.first,
        current: { operationId: next.operationId, revision: 2 }, grantOperationId: operationId });
      expect(refreshed.chainSha256).not.toBe(initial.chainSha256);
      const successor = await readWindowsPortalSuccessorAuthorization(db, grant);
      expect(successor.authorization).toEqual(original.authorization);
      expect(successor.continuity).toEqual(refreshed);
      const rpc = await readWindowsPortalSuccessorAuthorizationEntrypoint({ OPS_DB: db, ENVIRONMENT: "staging",
        EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com", PUBLIC_BASE_URL: "https://ops-staging.ledgetopdroneservices.com",
        OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "true" }, wire!);
      expect(JSON.parse(rpc)).toEqual({ ok: true, protocolVersion: 1, successor });
      // Old callers still require their exact original publication.
      await expect(readOperationsPortalNativeDeliveryAuthorization(db, oldRequest)).rejects.toThrow("authorization_denied");
      expect(JSON.stringify(refreshed)).not.toContain("r2Prefix");
      expect((await db.prepare(`EXPLAIN QUERY PLAN SELECT operation_id FROM operations_portal_workspace_publication_commands
        WHERE target_id=? AND source_sequence BETWEEN ? AND ? ORDER BY source_sequence,operation_id`)
        .bind(ctx.workspace.targetId, 1, 2).all()).results.some(row => String(row.detail).includes("operations_portal_publication_target_sequence"))).toBe(true);
      // Inject a real local revoke after both history reads and just before the
      // final current-authority SQL. No schema guard is disabled or bypassed.
      let authorizations = 0;
      const raced = { withSession: () => {
        const session = db.withSession("first-primary");
        return { prepare: (sql: string) => ({ bind: (...values: (string | number | null)[]) => {
          const statement = session.prepare(sql).bind(...values);
          return {
            all: () => statement.all(),
            first: async () => {
              if (sql.includes("FROM operations_portal_native_delivery_authority_heads head") && ++authorizations === 2)
                await revokeOperationsPortalNativeDeliveryAuthority(db, { operationId: id(), authorityId, expectedRevision: 1,
                  owner, reasonCode: "Synthetic revoke before final successor proof" });
              return statement.first();
            },
          };
        } }) };
      } } as unknown as D1Database;
      await expect(readWindowsPortalSuccessorAuthorization(raced, grant)).rejects.toThrow("authorization_denied");
      expect(authorizations).toBe(2);
      await expect(readWindowsPortalPublicationChainEvidence(db, grant)).rejects.toThrow("chain_unproven");
      await expect(readWindowsPortalSuccessorAuthorization(db, grant)).rejects.toThrow();
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    }, { stopAfterReady: true, operationsThroughMigration: "0203_effective_native_directory_enrollment_consumers.sql" });
  }, 240_000);
});
