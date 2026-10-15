import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runCanonicalPortalResourceAcceptance, existingOrganizationRemote } from "./helpers/operations-native-portal-resource-acceptance-fixture";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { manageOperationsPortalNativeBillingPermission } from "../src/worker/operations-portal-native-billing-permission-issuer";
import { reviewOperationsPortalNativeBillingCandidate, grantOperationsPortalNativeBillingAuthority, revokeOperationsPortalNativeBillingAuthority } from "../src/worker/operations-portal-native-billing-authority-issuer";
import { reviewNativeBillingSourceAuthority, grantNativeBillingSourceAuthority, revokeNativeBillingSourceAuthority, readNativeBillingSourceAuthorityStatus } from "../src/worker/operations-portal-native-billing-source-authority-issuer";
import { acquireProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-acquisition-coordinator";
import { activateProjectAlphaExistingDirectoryBinding } from "../src/worker/project-alpha-existing-directory-binding-review-consumer";
import { persistProjectAlphaDirectoryInventoryPage } from "../src/worker/project-alpha-v2-sync";
import { resolveTrustedNativeFinancialMapping } from "../src/worker/project-alpha-financial-mapping";
import { readClientPortalNativeFinancialCollections } from "../src/worker/client-portal-native-financial-entrypoint";
import { readClientPortalNativeFinancialDocuments } from "../src/worker/client-portal-native-financial-reader";
import { createOperationsHomeRouter } from "../../client/src/worker/client-portal/operations-home-routes";
import type { Env as ClientEnv } from "../../client/src/worker/types";
// Interleave real writes at a selected read boundary without adapting the trusted resolver.
function interleaveSelect(database: D1Database, needle: string, method: "first" | "all", at: number, before: boolean, action: () => Promise<void>, bindingSource?: string) {
    let count = 0;
    const statement = (value: D1PreparedStatement, sql: string, bindings: unknown[] = []): D1PreparedStatement => new Proxy(value, { get(target, key) {
            if (key === "bind")
                return (...args: unknown[]) => statement(target.bind(...args), sql, args);
            if (key === method && sql.includes(needle) && (bindingSource === undefined || bindings[0] === bindingSource))
                return async () => {
                    count++;
                    const selected = count === at;
                    if (selected && before)
                        await action();
                    const result = method === "first" ? await target.first() : await target.all();
                    if (selected && !before)
                        await action();
                    return result;
                };
            const result = Reflect.get(target, key);
            return typeof result === "function" ? result.bind(target) : result;
        } });
    const wrapped = new Proxy(database, { get(target, key) {
            if (key === "withSession")
                return () => {
                    const session = target.withSession("first-primary");
                    return new Proxy(session, { get(current, member) {
                            if (member === "prepare")
                                return (sql: string) => statement(current.prepare(sql), sql);
                            const result = Reflect.get(current, member);
                            return typeof result === "function" ? result.bind(current) : result;
                        } });
                };
            const result = Reflect.get(target, key);
            return typeof result === "function" ? result.bind(target) : result;
        } });
    return { database: wrapped, count: () => count };
}
function interleaveFinalReadBatch(database: D1Database, action: () => Promise<void>) {
    let count = 0;
    const wrapped = new Proxy(database, { get(target, key) {
            if (key === "withSession")
                return () => {
                    const session = target.withSession("first-primary");
                    return new Proxy(session, { get(current, member) {
                            if (member === "batch")
                                return async (statements: D1PreparedStatement[]) => {
                                    count++;
                                    if (count === 1)
                                        await action();
                                    return current.batch(statements);
                                };
                            const value = Reflect.get(current, member);
                            return typeof value === "function" ? value.bind(current) : value;
                        } });
                };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
        } });
    return { database: wrapped, count: () => count };
}
describe("source-scoped billing with joined real Workers D1", () => {
    it("isolates colliding documents for one recipient, current binding, revoke races and parent ABA without legacy fallback", async () => {
        await runCanonicalPortalResourceAcceptance(async (c) => {
            const { operations: db, owner, id, organization, workspace, recipient } = c;
            for (const name of ["0204_native_project_archive_restore.sql", "0205_native_billing_source_authority.sql"]) {
                const sql = readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");
                await db.batch([...splitD1MigrationStatements(sql).map(s => db.prepare(s)), db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
            }
            expect(await db.prepare("SELECT count(*) count FROM d1_migrations").first("count")).toBe(205);
            if (!recipient.recipientBindingId)
                throw Error("recipient absent");
            const twoSource = "project-alpha:secondary", external = "pa/organization/existing-one", publicId = "90000000000000000000000000000001";
            const two = { sourceId: twoSource, sourceInstanceId: "41111111-1111-4111-8111-111111111111", applicationId: "42222222-2222-4222-8222-222222222222",
                historyEpoch: "43333333-3333-4333-8333-333333333333", baseUrl: "https://pa-two.example.test", apiKey: "secondary-private-test-key", enabled: true };
            const config = JSON.parse(c.projectAlphaConnections);
            config.instances[twoSource] = two;
            const env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify(config), CLIENT_PORTAL_NATIVE_FINANCIAL_RPC_ENABLED: "true" };
            const grantGeneration = await db.prepare("SELECT generation FROM native_directory_grant_generations WHERE staff_id=?").bind(owner.identity.staffId).first<number>("generation");
            if (grantGeneration === null)
                throw Error("directory grant absent");
            const remote = existingOrganizationRemote({ ...two, historyEpochId: two.historyEpoch });
            const acquired = await acquireProjectAlphaExistingDirectoryBinding(env, { reviewId: id(), commandId: id(), sourceId: twoSource, recordId: organization,
                externalId: external, resourceType: "organization", projectAlphaPublicId: publicId, expectedProjectAlphaRevision: "7", expectedAuthorizationGeneration: "8",
                localRecordVersion: 1, reviewer: { staffId: owner.identity.staffId, accessSubject: owner.identity.verifiedAccessSubject,
                    admissionVersion: owner.admissionVersion, profileVersion: owner.identity.profileVersion, grantGeneration } }, remote);
            expect(acquired.status).toBe("acquired");
            if (acquired.status !== "acquired")
                throw Error(JSON.stringify(acquired));
            expect(await activateProjectAlphaExistingDirectoryBinding(env, { reviewItemId: acquired.reviewReceiptId, idempotencyKey: id() }, { staffId: owner.identity.staffId, accessSubject: owner.identity.verifiedAccessSubject }, remote)).toMatchObject({ status: "activated", recordId: organization });
            const sources = [{ sourceId: c.sourceId, sourceInstanceId: c.sourceInstanceId, applicationId: c.applicationId, historyEpoch: c.historyEpochId }, two];
            const inventory = async (index: number, generation: string, bound = true, expected = "persisted") => {
                const source = sources[index]!;
                expect(await persistProjectAlphaDirectoryInventoryPage(db, { authoritative: false, sourceId: source.sourceId, sourceInstanceId: source.sourceInstanceId, applicationId: source.applicationId, historyEpoch: source.historyEpoch, requestId: id(), authorizationGeneration: generation,
                    resources: [{ type: "organization", publicId, revision: "7", present: true, lastAction: "upsert", projectionSha256: (index ? "b" : "a").repeat(64),
                            binding: bound ? { externalId: external, status: "active", resourceRevision: "7" } : null }], nextCursor: null }, null)).toMatchObject({ status: expected });
            };
            await inventory(0, "11");
            await inventory(1, "11");
            expect(await resolveTrustedNativeFinancialMapping(env, { kind: "organization", recordId: organization })).toBeNull();
            for (const source of sources)
                expect(await resolveTrustedNativeFinancialMapping(env, { kind: "organization", recordId: organization, sourceId: source.sourceId })).not.toBeNull();
            expect(await manageOperationsPortalNativeBillingPermission(db, owner, { operationId: id(), expectedGeneration: 0, action: "issue", grantId: id(),
                staffId: owner.identity.staffId, effect: "allow", scope: { kind: "resource", resourceId: organization } })).toMatchObject({ status: "applied" });
            const selection = { targetId: workspace.targetId, recipientBindingId: recipient.recipientBindingId, entity: { kind: "organization" as const, nativeId: organization }, expiresAt: null };
            const reviewed = await reviewOperationsPortalNativeBillingCandidate(db, owner, selection), parentId = id();
            expect(await grantOperationsPortalNativeBillingAuthority(db, owner, { ...selection, operationId: id(), grantId: parentId,
                expectedRevision: reviewed.expectedRevision, reviewFingerprint: reviewed.reviewFingerprint })).toMatchObject({ status: "applied", authority: { live: true, revision: 1 } });
            const wh = await db.prepare("SELECT ownership_epoch FROM operations_portal_native_workspace_authority_heads WHERE target_id=?").bind(workspace.targetId).first<{
                ownership_epoch: number;
            }>();
            const rh = await db.prepare("SELECT grant_revision FROM operations_portal_native_recipient_authority_heads WHERE recipient_binding_id=?").bind(recipient.recipientBindingId).first<{
                grant_revision: number;
            }>();
            if (!wh || !rh)
                throw Error("authority absent");
            const request = { protocolVersion: 1 as const, authorityId: workspace.clientAuthorityId, workspaceId: workspace.workspaceId, ownershipEpoch: wh.ownership_epoch,
                grantRevision: rh.grant_revision, issuer: c.issuer, subject: c.subject };
            let calls: string[] = [];
            let heldSecond: Promise<void> | null = null;
            let secondEntered: () => void = () => { };
            let hook: (sourceId: string) => Promise<void> = async () => { };
            const financial = async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = new URL(String(input)), index = url.origin === two.baseUrl ? 1 : 0, source = sources[index]!;
                expect(url.pathname).toBe("/api/v2/financial-documents");
                const headers = new Headers(init?.headers);
                expect(headers.get("Authorization")).toBe("Bearer " + (index ? two.apiKey : "acceptance-private-key"));
                expect(headers.get("X-PA-Source-Instance-ID")).toBe(source.sourceInstanceId);
                expect(headers.get("X-PA-Application-ID")).toBe(source.applicationId);
                expect(headers.get("X-PA-History-Epoch")).toBe(source.historyEpoch);
                const mapping = await resolveTrustedNativeFinancialMapping(env, { kind: "organization", recordId: organization, sourceId: source.sourceId });
                if (!mapping)
                    throw Error("mapping not current before fetch");
                const requestId = id();
                calls.push(source.sourceId);
                if (index === 1 && heldSecond) {
                    secondEntered();
                    await heldSecond;
                }
                await hook(source.sourceId);
                return new Response(JSON.stringify({ apiVersion: "2", sourceInstanceId: source.sourceInstanceId, applicationId: source.applicationId, historyEpoch: source.historyEpoch, requestId,
                    selector: { kind: mapping.kind, externalId: mapping.externalId, publicId: mapping.publicId, revision: mapping.revision, projectionSha256: mapping.projectionSha256, authorizationGeneration: mapping.authorizationGeneration },
                    snapshot: { sha256: "c".repeat(64), documentCount: 1 }, documents: [{ publicId: "80000000000000000000000000000001", kind: "contract", status: "pending", currency: "USD", total: "0.00", amountPaid: null, balanceDue: null,
                            documentUrl: url.origin + "/?page=public-doc&token=abcdefghijklmnop", actionUrl: url.origin + "/?page=public-doc&token=abcdefghijklmnop" }], nextCursor: null }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Request-ID": requestId } });
            };
            expect(await readClientPortalNativeFinancialCollections(env, request, financial)).toEqual({ ok: false, protocolVersion: 1, code: "denied" });
            expect(calls).toEqual([]);
            // Interleave an authentic inventory advance after review but immediately before the real SQL batch.
            const racedReview = await reviewNativeBillingSourceAuthority(env, owner, { parentGrantId: parentId, sourceId: c.sourceId });
            const racedOperation = id(), racedGrant = id();
            let interleaved = false;
            const racedDb = new Proxy(db, { get(target, key) {
                    if (key === "withSession")
                        return () => {
                            const session = target.withSession("first-primary");
                            return new Proxy(session, { get(current, member) {
                                    if (member === "batch")
                                        return async (statements: D1PreparedStatement[]) => {
                                            if (!interleaved) {
                                                interleaved = true;
                                                await inventory(0, "12");
                                            }
                                            return current.batch(statements);
                                        };
                                    const value = Reflect.get(current, member);
                                    return typeof value === "function" ? value.bind(current) : value;
                                } });
                        };
                    const value = Reflect.get(target, key);
                    return typeof value === "function" ? value.bind(target) : value;
                } });
            expect(await grantNativeBillingSourceAuthority({ ...env, OPS_DB: racedDb }, owner, { parentGrantId: parentId, sourceId: c.sourceId,
                operationId: racedOperation, grantId: racedGrant, expectedRevision: racedReview.expectedRevision,
                reviewFingerprint: racedReview.reviewFingerprint })).toEqual({ status: "conflict" });
            expect(interleaved).toBe(true);
            expect(await db.prepare("SELECT operation_id FROM operations_portal_native_billing_source_commands WHERE operation_id=?").bind(racedOperation).first()).toBeNull();
            expect(await db.prepare("SELECT grant_id FROM operations_portal_native_billing_source_heads WHERE grant_id=?").bind(racedGrant).first()).toBeNull();
            const child = async (sourceId: string, grantId = id()) => {
                const r = await reviewNativeBillingSourceAuthority(env, owner, { parentGrantId: parentId, sourceId });
                const body = { parentGrantId: parentId, sourceId, grantId, expectedRevision: r.expectedRevision, reviewFingerprint: r.reviewFingerprint, operationId: id() };
                expect(await grantNativeBillingSourceAuthority(env, owner, body)).toMatchObject({ status: "applied", authority: { live: true } });
                expect(await grantNativeBillingSourceAuthority(env, owner, body)).toMatchObject({ status: "replayed" });
                expect(await grantNativeBillingSourceAuthority(env, owner, { ...body, reviewFingerprint: "f".repeat(64) })).toEqual({ status: "conflict" });
                expect(await grantNativeBillingSourceAuthority(env, owner, { ...body, sourceId: sourceId === twoSource ? c.sourceId : twoSource })).toEqual({ status: "conflict" });
                return grantId;
            };
            const one = await child(c.sourceId), second = await child(twoSource);
            const both = await readClientPortalNativeFinancialCollections(env, request, financial);
            expect(both.ok).toBe(true);
            if (!both.ok)
                throw Error("joined financial denied");
            expect(both.collections.map(x => x.grantId)).toEqual([one, second]);
            expect(both.collections.map(x => x.value.documents[0]?.publicId)).toEqual(["80000000000000000000000000000001", "80000000000000000000000000000001"]);
            expect(new Set(both.collections.map(x => x.value.documents[0]?.documentUrl)).size).toBe(2);
            const router = createOperationsHomeRouter({ resolvePrincipal: async () => ({ issuer: c.issuer, subject: c.subject, email: "recipient@example.test" }) });
            const clientEnv = { DELIVERY_DB: c.client, CLIENT_PORTAL_ENABLED: "true", CLIENT_PORTAL_ORIGIN: "https://client.example.test", CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true",
                CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true", CLIENT_PORTAL_NATIVE_FINANCIAL_ENABLED: "true",
                CLIENT_PORTAL_NATIVE_FINANCIAL_READER: { readFinancialDocuments: async (value: typeof request) => JSON.stringify(await readClientPortalNativeFinancialCollections(env, value, financial)) } } as unknown as ClientEnv;
            const route = () => router.fetch(new Request("https://client.example.test/home/" + workspace.clientAuthorityId + "/financial"), clientEnv);
            const response = await route();
            expect(response.status).toBe(200);
            expect(response.headers.get("Cache-Control")).toBe("no-store");
            expect(await response.json()).toMatchObject({ collections: [{ grantId: one, documents: [{ publicId: "80000000000000000000000000000001" }] }, { grantId: second, documents: [{ publicId: "80000000000000000000000000000001" }] }] });
            // Both individual readers completed before the aggregate's final read. Same UUID is not same authority.
            const aggregateRace = interleaveFinalReadBatch(db, async () => {
                expect(await revokeNativeBillingSourceAuthority(env, owner, { operationId: id(), grantId: one, expectedRevision: 1 })).toMatchObject({ status: "applied" });
                await child(c.sourceId, one);
            });
            expect(await readClientPortalNativeFinancialCollections({ ...env, OPS_DB: aggregateRace.database }, request, financial))
                .toEqual({ ok: false, protocolVersion: 1, code: "denied" });
            expect(aggregateRace.count()).toBe(1);
            const oneRevision = (await readNativeBillingSourceAuthorityStatus(env, owner, one)).revision;
            let once = false;
            hook = async (source) => {
                if (source === c.sourceId && !once) {
                    once = true;
                    expect(await revokeNativeBillingSourceAuthority(env, owner, { operationId: id(), grantId: one, expectedRevision: oneRevision })).toMatchObject({ status: "applied" });
                }
            };
            expect(await readClientPortalNativeFinancialCollections(env, request, financial)).toEqual({ ok: false, protocolVersion: 1, code: "denied" });
            hook = async () => { };
            calls = [];
            expect(await readClientPortalNativeFinancialCollections(env, request, financial)).toMatchObject({ ok: true, collections: [{ grantId: second }] });
            expect(calls).toEqual([twoSource]);
            expect(await readClientPortalNativeFinancialDocuments(env, { ...request, grantId: parentId }, financial)).toEqual({ status: "denied" });
            expect(await revokeOperationsPortalNativeBillingAuthority(db, owner, { operationId: id(), grantId: parentId, expectedRevision: 1 })).toMatchObject({ status: "applied" });
            expect(await readClientPortalNativeFinancialCollections(env, request, financial)).toEqual({ ok: false, protocolVersion: 1, code: "denied" });
            const current = await reviewOperationsPortalNativeBillingCandidate(db, owner, selection);
            expect(await grantOperationsPortalNativeBillingAuthority(db, owner, { ...selection, operationId: id(), grantId: parentId, expectedRevision: 2, reviewFingerprint: current.reviewFingerprint })).toMatchObject({ status: "applied", authority: { revision: 3 } });
            expect((await readNativeBillingSourceAuthorityStatus(env, owner, second)).live).toBe(false);
            calls = [];
            expect(await readClientPortalNativeFinancialCollections(env, request, financial)).toEqual({ ok: false, protocolVersion: 1, code: "denied" });
            expect(calls).toEqual([]);
            await child(twoSource, second);
            expect(await readClientPortalNativeFinancialCollections(env, request, financial)).toMatchObject({ ok: true, collections: [{ grantId: second, revision: 2 }] });
            await child(c.sourceId, one);
            // Source one fully completes its own read while source two is still waiting for PA.
            // Retire the first mapping only after that completion, before aggregate serialization.
            const deferred = () => {
                let resolve!: () => void;
                const promise = new Promise<void>(done => { resolve = done; });
                return { promise, resolve };
            };
            const held = deferred(), entered = deferred(), completedOne = deferred();
            heldSecond = held.promise;
            secondEntered = entered.resolve;
            const completedReader = interleaveSelect(db, "FROM operations_portal_native_billing_source_live_authority child", "all", 3, false, async () => {
                // The authentic final authority query returns, then its reader's microtasks drain.
                setTimeout(completedOne.resolve, 0);
            }, one);
            calls = [];
            const fanIn = readClientPortalNativeFinancialCollections({ ...env, OPS_DB: completedReader.database }, request, financial);
            await entered.promise;
            await completedOne.promise;
            expect(completedReader.count()).toBe(3);
            // Existing durable conflict semantics are retained, not cleared or treated as clean.
            await inventory(0, "14", false, "conflicted");
            held.resolve();
            heldSecond = null;
            secondEntered = () => { };
            expect(await fanIn).toMatchObject({ ok: true, collections: [{ grantId: second }] });
            expect([...calls].sort()).toEqual([c.sourceId, twoSource].sort());
            hook = async () => { };
            calls = [];
            expect(await readClientPortalNativeFinancialCollections(env, request, financial)).toMatchObject({ ok: true, collections: [{ grantId: second }] });
            expect(calls).toEqual([twoSource]);
            expect((await readNativeBillingSourceAuthorityStatus(env, owner, one)).live).toBe(false);
            // The actual mapping row resolves first; revoke immediately afterward must close an admin status read.
            const statusRace = interleaveSelect(db, "SELECT mapping_kind,provenance_id FROM project_alpha_active_directory_mappings", "first", 1, false, async () => {
                expect(await revokeNativeBillingSourceAuthority(env, owner, { operationId: id(), grantId: second, expectedRevision: 2 })).toMatchObject({ status: "applied" });
            });
            expect((await readNativeBillingSourceAuthorityStatus({ ...env, OPS_DB: statusRace.database }, owner, second)).live).toBe(false);
            expect(statusRace.count()).toBe(1);
            // Explicitly regrant the same child, then retire its mapping after provenance resolves.
            await child(twoSource, second);
            expect(await readNativeBillingSourceAuthorityStatus(env, owner, second)).toMatchObject({ live: true, revision: 4 });
            const statusMappingRace = interleaveSelect(db, "SELECT mapping_kind,provenance_id FROM project_alpha_active_directory_mappings", "first", 1, false, async () => {
                await inventory(1, "12", false, "conflicted");
            });
            expect((await readNativeBillingSourceAuthorityStatus({ ...env, OPS_DB: statusMappingRace.database }, owner, second)).live).toBe(false);
            expect(statusMappingRace.count()).toBe(1);
            expect(await revokeNativeBillingSourceAuthority(env, owner, { operationId: id(), grantId: second, expectedRevision: 4 })).toMatchObject({ status: "applied" });
            calls = [];
            expect(await readClientPortalNativeFinancialCollections(env, request, financial)).toEqual({ ok: false, protocolVersion: 1, code: "denied" });
            expect(calls).toEqual([]);
            expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
        }, { stopAfterReady: true, operationsThroughMigration: "0203_effective_native_directory_enrollment_consumers.sql",
            nativeRecordIds: { organization: "acceptance-org-source-billing", client: "acceptance-client-source-billing" } });
    }, 240000);
});
