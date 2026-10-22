import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
const jwks = vi.hoisted(() => vi.fn());
vi.mock("../../client/src/worker/client-portal/access-identity", async () => {
  const actual = await vi.importActual<typeof import("../../client/src/worker/client-portal/access-identity")>("../../client/src/worker/client-portal/access-identity");
  // Ops and Client install separate jose copies. Inject only the supported
  // key-resolver argument, preserving the actual Client JWT verifier/mapping.
  return { ...actual, resolveCloudflareRecipientEnrollmentProof: (request: Request,
    env: Parameters<typeof actual.resolveCloudflareRecipientEnrollmentProof>[1]) =>
    actual.resolveCloudflareRecipientEnrollmentProof(request, env, jwks()) };
});
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
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
import { authorizeWindowsPortalSuccessor } from "../../client/src/worker/client-portal/windows-portal-successor-authorization";
import { WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL } from "../../client/src/worker/client-portal/windows-portal-successor-candidate";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { createWindowsPortalSuccessorRouter, type WindowsPortalSuccessorRouteEnv } from "../../client/src/worker/client-portal/windows-portal-successor-routes";
import { createOperationsNativeQueueRouter } from "../../client/src/worker/client-portal/operations-native-queue-routes";
import { encodeOperationsNativeDeliveryHandle } from "../../client/src/worker/client-portal/operations-native-delivery-handles";
import { readOperationsPortalNativeDeliveryAuthorizationEntrypoint } from "../src/worker/operations-portal-native-delivery-authority-reader";
import { readWindowsPortalCatalogSuccessorAuthorizationEntrypoint } from "../src/worker/operations-portal-native-delivery-authority-reader";
import { createWindowsPortalCatalogRouter, type WindowsPortalCatalogRouteEnv } from "../../client/src/worker/client-portal/windows-portal-catalog-routes";

describe("Windows publication history evidence with real canonical Ops/Client producers", () => {
  it("retains an unchanged grant across applied refreshes, excludes pending commands, and rejects revocation", async () => {
    await runCanonicalPortalResourceAcceptance(async ctx => {
      const { operations: db, client, id, owner } = ctx;
      await db.prepare(readFileSync(new URL("../migrations/0224_windows_portal_publication_chain_index.sql", import.meta.url), "utf8")).run();
      await client.prepare(readFileSync(new URL("../../client/migrations/0235_windows_portal_successor_candidates.sql", import.meta.url), "utf8")).run();
      await client.batch(splitD1MigrationStatements(readFileSync(new URL("../../client/migrations/0236_windows_portal_successor_content_start_audit.sql", import.meta.url), "utf8"))
        .map(sql => client.prepare(sql)));
      const candidate = (await listOperationsPortalNativeDeliveryCandidates(db, { targetId: ctx.workspace.targetId, owner })).items
        .find(item => item.recipientBindingId === ctx.recipient.recipientBindingId);
      if (!candidate || !ctx.recipient.recipientBindingId) throw new Error("missing synthetic candidate");
      const operationId = id(), authorityId = id();
      await issueOperationsPortalNativeDeliveryAuthority(db, { operationId, authorityId, owner,
        recipientBindingId: ctx.recipient.recipientBindingId, folderReservationId: candidate.folderReservationId,
        expectedRevision: 0, expectedCandidateFingerprint: candidate.candidateFingerprint, features: ["folder.list", "file.metadata", "file.download"],
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
      const opsEnv = { OPS_DB: db, ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com",
        PUBLIC_BASE_URL: "https://ops-staging.ledgetopdroneservices.com", OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "true" };
      const consumerEnv = { DELIVERY_DB: client, ENVIRONMENT: "staging", CLIENT_PORTAL_ORIGIN: "https://client-staging.ledgetopdroneservices.com",
        CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true", OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: {
          readNativeDeliveryAuthorization: async () => { throw new Error("ordinary RPC must not be used as fallback"); },
          readWindowsDeliverySuccessorAuthorization: (wire: string) => readWindowsPortalSuccessorAuthorizationEntrypoint(opsEnv, wire),
        } };
      const initialCandidate = await client.prepare(WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL).bind(authorityId, ctx.issuer, ctx.subject).first();
      expect(initialCandidate).not.toBeNull();
      await expect(authorizeWindowsPortalSuccessor(consumerEnv, { issuer: ctx.issuer, subject: ctx.subject }, authorityId))
        .resolves.toMatchObject({ ok: true, successorContext: { kind: "windows-portal-successor-v1", continuity: { publicationCount: 1 } } });
      // Real signed human -> durable reference -> manifest -> R2 range bytes,
      // retaining the original grant across an acknowledged publication refresh.
      // Only JWK discovery is substituted; JWT signature/issuer/audience checks run.
      const pair = await generateKeyPair("RS256", { extractable: true }), key = await exportJWK(pair.publicKey);
      key.kid = "synthetic-successor"; jwks.mockReturnValue(createLocalJWKSet({ keys: [key] }));
      const audience = "synthetic-successor-queue", origin = consumerEnv.CLIENT_PORTAL_ORIGIN;
      const jwt = await new SignJWT({ type: "app", email: "synthetic@example.invalid" }).setProtectedHeader({ alg: "RS256", kid: key.kid })
        .setIssuer(ctx.issuer).setSubject(ctx.subject).setAudience(audience).setExpirationTime("1h").sign(pair.privateKey);
      const bytes = new TextEncoder().encode("synthetic publication-continuous exact range bytes");
      const checksum = await crypto.subtle.digest("SHA-256", bytes);
      const storageKey = grant.resource.selectedR2Prefix + "successor-map.bin";
      const object = await ctx.bucket.put(storageKey, bytes, { sha256: checksum });
      if (!object) throw new Error("missing synthetic object");
      await client.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,datetime('now'),'application/octet-stream','other')")
        .bind(storageKey, object.etag, bytes.length).run();
      const unicodeKey = grant.resource.selectedR2Prefix + "Unicode🚁/ 彩色🚁 map.bin";
      const unicodeObject = await ctx.bucket.put(unicodeKey, bytes, { sha256: checksum });
      await client.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,datetime('now'),'application/octet-stream','other')")
        .bind(unicodeKey, unicodeObject!.etag, bytes.length).run();
      const queueEnv = { ...consumerEnv, CLIENT_PORTAL_ENABLED: "true", DATA_BUCKET: ctx.bucket,
        DELIVERY_SESSION_SECRET: "synthetic-successor-desktop-secret-".repeat(3), CLIENT_ACCESS_TEAM_DOMAIN: ctx.issuer, CLIENT_ACCESS_AUD: audience,
        CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET: "synthetic-successor-audit-secret-".repeat(3),
        OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: { ...consumerEnv.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER,
          readWindowsCatalogSuccessorAuthorization: (wire: string, feature: "folder.list" | "file.metadata") =>
            readWindowsPortalCatalogSuccessorAuthorizationEntrypoint(opsEnv, wire, feature),
          readNativeDeliveryAuthorization: (input: Parameters<typeof readOperationsPortalNativeDeliveryAuthorizationEntrypoint>[1]) =>
            readOperationsPortalNativeDeliveryAuthorizationEntrypoint(opsEnv, input) } } as unknown as WindowsPortalCatalogRouteEnv;
      const config = { enabled: true, portalOrigin: origin, issuer: ctx.issuer, audience, queueKey: new Uint8Array(32).fill(17) };
      const queue = createOperationsNativeQueueRouter(config), downloads = createWindowsPortalSuccessorRouter(config);
      const catalog = createWindowsPortalCatalogRouter(config), catalogBase = "/api/client/operations/data/windows-catalog";
      const selectedPrefix = grant.resource.selectedR2Prefix;
      const request = (path: string, extra: HeadersInit = {}) => new Request(origin + path, { headers: { "Cf-Access-Jwt-Assertion": jwt, ...extra } });
      async function browse() {
        const listed = await catalog.fetch(request(catalogBase + "/deliveries"), queueEnv); expect(listed.status).toBe(200);
        const root = (await listed.json() as { items: { id: string }[] }).items[0]!.id;
        const opened = await catalog.fetch(request(catalogBase + "/folders/" + root), queueEnv); expect(opened.status).toBe(200);
        const folder = await opened.json() as { files: { id: string; name: string; downloadAvailable: boolean }[]; folders: { id: string; name: string }[] };
        expect(folder.files).toHaveLength(1); expect(folder.files[0]).toMatchObject({ name: "successor-map.bin", downloadAvailable: true });
        expect(JSON.stringify(folder)).not.toContain(selectedPrefix);
        const unicodeFolder = folder.folders.find(item => item.name === "Unicode🚁"); expect(unicodeFolder).toBeDefined();
        const nestedResponse = await catalog.fetch(request(catalogBase + "/folders/" + unicodeFolder!.id), queueEnv); expect(nestedResponse.status).toBe(200);
        const nested = await nestedResponse.json() as typeof folder;
        expect(nested.files).toEqual([{ id: expect.stringMatching(/^wpc1_/u), name: " 彩色🚁 map.bin", size: bytes.length, downloadAvailable: true }]);
        return { root, file: folder.files[0]!.id };
      }
      const initialCatalog = await browse();
      expect((await catalog.fetch(request(catalogBase + "/files/" + initialCatalog.file), queueEnv)).status).toBe(200);
      const g = grant;
      const selector = await encodeOperationsNativeDeliveryHandle(queueEnv, { v: 1, kind: "file", authorityId, authorityRevision: g.authority.resultingRevision,
        ...g.recipient, targetId: g.target.targetId, targetRevision: g.target.targetRevision, clientAuthorityId: g.target.clientAuthorityId, workspaceId: g.target.workspaceId,
        publicationId: g.publication.publicationId, publicationOperationId: g.publication.operationId, publicationRevision: g.publication.revision,
        publicationSourceSequence: g.publication.sourceSequence, snapshotId: g.publication.snapshotId, snapshotSha256: g.publication.snapshotSha256,
        folderReservationId: g.resource.folderReservationId, folderReservationRevision: g.resource.folderReservationRevision,
        clientFolderBindingId: g.resource.clientFolderBindingId, externalProjectId: g.resource.externalProjectId, projectVersion: g.resource.projectVersion,
        path: "successor-map.bin", etag: object.etag, expires: Date.now() + 600_000 });
      const selectedResponse = await queue.fetch(request("/api/client/operations/data/queue/reference?fileHandle=" + selector), queueEnv);
      expect(selectedResponse.status).toBe(200);
      const selected = await selectedResponse.json() as { resourceRef: string };
      const resolve = () => queue.fetch(request("/api/client/operations/data/queue/resolve?resourceRef=" + selected.resourceRef), queueEnv);
      const beforeResponse = await resolve(); expect(beforeResponse.status).toBe(200);
      type Resolved = { manifest: { logicalFileId: string; remoteVersion: string; sha256: string; strongETag: string; downloadPath: string } };
      const beforeManifest = (await beforeResponse.json() as Resolved).manifest;
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
      // Consumer original live_heads intentionally disappears; the separate
      // candidate query and strict successor proof now agree on publication 2.
      expect(await client.prepare("SELECT authority_id FROM operations_portal_native_delivery_live_heads WHERE authority_id=?")
        .bind(authorityId).first()).toBeNull();
      const consumer = await authorizeWindowsPortalSuccessor(consumerEnv, { issuer: ctx.issuer, subject: ctx.subject }, authorityId);
      expect(consumer).toMatchObject({ ok: true, successorContext: { originalRequestFingerprint: refreshed.grantFingerprint,
        continuity: refreshed, originalGrant: grant } });
      // Browsing has its own explicit feature proof. Old page selectors fail;
      // discovery at publication2 returns fresh metadata without forging a grant.
      expect((await catalog.fetch(request(catalogBase + "/folders/" + initialCatalog.root), queueEnv)).status).toBe(404);
      expect((await catalog.fetch(request(catalogBase + "/files/" + initialCatalog.file), queueEnv)).status).toBe(404);
      const refreshedCatalog = await browse();
      const catalogSelection = await queue.fetch(request("/api/client/operations/data/queue/reference?fileHandle=" + refreshedCatalog.file), queueEnv);
      expect(catalogSelection.status).toBe(200);
      const catalogReference = await catalogSelection.json() as { resourceRef: string };
      const catalogResolvedResponse = await queue.fetch(request("/api/client/operations/data/queue/resolve?resourceRef=" + catalogReference.resourceRef), queueEnv);
      expect(catalogResolvedResponse.status).toBe(200);
      expect((await catalogResolvedResponse.json() as Resolved).manifest.logicalFileId).toBe(beforeManifest.logicalFileId);
      const catalogManifestResponse = await catalog.fetch(request(catalogBase + "/files/" + refreshedCatalog.file + "/download-manifest"), queueEnv);
      expect(catalogManifestResponse.status).toBe(200);
      expect((await catalogManifestResponse.json() as Resolved["manifest"]).logicalFileId).toBe(beforeManifest.logicalFileId);
      const renewedResponse = await resolve(); expect(renewedResponse.status).toBe(200);
      const renewed = (await renewedResponse.json() as Resolved).manifest;
      expect(renewed.logicalFileId).toBe(beforeManifest.logicalFileId);
      expect(renewed.remoteVersion).toBe(beforeManifest.remoteVersion); expect(renewed.sha256).toBe(beforeManifest.sha256);
      expect((await downloads.fetch(request(beforeManifest.downloadPath), queueEnv)).status).toBe(404);
      const ranged = await downloads.fetch(request(renewed.downloadPath, { Range: "bytes=8-", "If-Match": renewed.strongETag }), queueEnv);
      expect(ranged.status).toBe(206); expect(ranged.headers.get("Content-Range")).toBe(`bytes 8-${bytes.length - 1}/${bytes.length}`);
      expect(new Uint8Array(await ranged.arrayBuffer())).toEqual(bytes.slice(8));
      const event = await client.prepare("SELECT original_publication_revision,effective_publication_revision,publication_count FROM windows_portal_successor_content_start_events").all();
      expect(event.results).toEqual([{ original_publication_revision: 1, effective_publication_revision: 2, publication_count: 2 }]);
      await expect(authorizeWindowsPortalSuccessor(consumerEnv, { issuer: ctx.issuer, subject: "another-person" }, authorityId))
        .resolves.toEqual({ ok: false, code: "denied" });
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
      // Local Client still has the old active grant. Remote revoke must stop it
      // even before the revoke is delivered to Client.
      await expect(authorizeWindowsPortalSuccessor(consumerEnv, { issuer: ctx.issuer, subject: ctx.subject }, authorityId))
        .resolves.toEqual({ ok: false, code: "denied" });
      expect((await resolve()).status).toBe(409);
      expect((await downloads.fetch(request(renewed.downloadPath), queueEnv)).status).toBe(404);
      expect((await catalog.fetch(request(catalogBase + "/deliveries"), queueEnv)).status).toBe(404);
      expect((await catalog.fetch(request(catalogBase + "/files/" + refreshedCatalog.file + "/download-manifest"), queueEnv)).status).toBe(404);
      expect(await client.prepare("SELECT count(*) n FROM windows_portal_successor_content_start_events").first("n")).toBe(1);
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    }, { stopAfterReady: true, operationsThroughMigration: "0203_effective_native_directory_enrollment_consumers.sql" });
  }, 240_000);
});
