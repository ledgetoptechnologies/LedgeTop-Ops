import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../test/helpers/d1-migrations";
import { realOpsTransportAuthority } from "../../operations/test/windows-real-ops-transport.fixture";
import { readWindowsPortalSuccessorAuthorizationEntrypoint, readWindowsPortalCatalogSuccessorAuthorizationEntrypoint } from "../../operations/src/worker/operations-portal-native-delivery-authority-reader";
export async function transportFixture() {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}", d1Databases: { DB: crypto.randomUUID(), OPS: crypto.randomUUID() }, r2Buckets: { DATA: crypto.randomUUID() } });
    const db = await runtime.getD1Database("DB") as unknown as D1Database;
    const ops = await runtime.getD1Database("OPS") as unknown as D1Database;
    const bucket = await runtime.getR2Bucket("DATA") as unknown as R2Bucket;
    try {
        for (const file of ["0001_initial.sql", "0003_delivery_platform.sql", "0008_trash_tombstones.sql", "0223_operations_portal_workspace_publications.sql", "0224_operations_portal_native_recipient_authority.sql", "0225_operations_portal_workspace_publication_cancellations.sql", "0226_operations_portal_native_workspace_cleanup.sql", "0227_operations_portal_native_delivery_authority.sql", "0228_operations_portal_native_content_start_audit.sql", "0229_operations_portal_native_delivery_regrant.sql", "0230_operations_portal_native_delivery_terminal_cancellations.sql", "0235_windows_portal_successor_candidates.sql", "0236_windows_portal_successor_content_start_audit.sql"]) {
            await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")).map(q => db.prepare(q)));
        }
        const authority = await realOpsTransportAuthority(ops, db);
        const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => (i * 31 + 17) % 251);
        const sha = await crypto.subtle.digest("SHA-256", bytes);
        const object = await bucket.put(authority.objectKey, bytes, { sha256: sha });
        await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,?)").bind(authority.objectKey, object!.etag, bytes.length, new Date().toISOString(), "application/octet-stream", "other").run();
        const env = { OPS_DB: ops, ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com", PUBLIC_BASE_URL: "https://ops-staging.ledgetopdroneservices.com", OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "true" };
        const readerObservations = { calls: 0, denied: 0 };
        const observe = async (reply: Promise<string>) => { const wire = await reply; readerObservations.calls++; if (JSON.parse(wire).code === "denied")
            readerObservations.denied++; return wire; };
        return { runtime, db, ops, bucket, bytes, sha, readerObservations, revoke: authority.revoke, reader: {
                readNativeDeliveryAuthorization: async () => { throw Error("Ordinary authorization must not rescue denial"); },
                readWindowsDeliverySuccessorAuthorization: (wire: string) => observe(readWindowsPortalSuccessorAuthorizationEntrypoint(env, wire)),
                readWindowsCatalogSuccessorAuthorization: (wire: string, feature: string) => observe(readWindowsPortalCatalogSuccessorAuthorizationEntrypoint(env, wire, feature))
            } };
    }
    catch (error) {
        await runtime.dispose();
        throw error;
    }
}
