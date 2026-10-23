import { WINDOWS_STAGING_EXPORT_POLICY, assertWindowsStagingRuntimeExports } from "../../../scripts/windows-files-staging-exports.mjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { build } from "esbuild";
import { Miniflare, Response as MfResponse } from "miniflare";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { splitD1MigrationStatements } from "../test/helpers/d1-migrations";
import { realOpsTransportAuthority } from "../../operations/test/windows-real-ops-transport.fixture";
import { canonicalOperationsPortalNativeDeliveryAuthorityCommand } from "@ltds/shared/operations-portal-native-delivery-authority";

const issuer = "https://ledgetoptechnologies.cloudflareaccess.com";
const workerOrigin = "https://portal-staging.ledgetopdroneservices.com";
const audience = "8eed2de9972afe7d653de2adb68c1b0ef7c6462a9a694203b31d9a32f4248bbc";
const root = resolve("../..");
async function bundle(app: "operations" | "client", contents?: string) {
  const base = resolve(root, "apps", app);
  const result = await build({ bundle: true, format: "esm", platform: "browser", conditions: ["workerd", "worker", "browser"],
    external: ["cloudflare:*", "node:*"], write: false, metafile: true, logLevel: "silent", outfile: "index.js",
    ...(contents ? { stdin: { contents, resolveDir: resolve(base, app === "operations" ? "test" : "integration"), sourcefile: "local-workerd-entry.ts", loader: "ts" as const } }
      : { entryPoints: [resolve(base, app === "operations" ? "src/worker/staging-native-authority-entrypoint.ts" : "src/worker/index.ts")] }) });
  const script = result.outputFiles[0]!.text;
  return { script, sha256: createHash("sha256").update(script).digest("hex"), exports: Object.values(result.metafile!.outputs).flatMap(o => o.exports).sort() };
}

/** Opt-in local Workerd only. No production credentials, remote resources or human identity. */
export async function workerdRpcTransportFixture() {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const publicKey = await exportJWK(pair.publicKey); publicKey.kid = "paired-workerd-synthetic";
  const token = await new SignJWT({ type: "app", email: "synthetic@example.invalid" }).setProtectedHeader({ alg: "RS256", kid: publicKey.kid })
    .setIssuer(issuer).setSubject("synthetic-recipient").setAudience(audience).setExpirationTime("10m").sign(pair.privateKey);
  const opsBundle = await bundle("operations", `
    import standard from "../src/worker/staging-native-authority-entrypoint";
    import {createWindowsEmployeeStagingWorker} from "../src/worker/windows-files-staging-worker";
    export {${WINDOWS_STAGING_EXPORT_POLICY.operations.runtime.join(",")}} from "../src/worker/staging-native-authority-entrypoint";
    export default createWindowsEmployeeStagingWorker({enabled:true,gateway:{origin:"https://synthetic-files-staging.ledgetopdroneservices.com",gatewayId:"00000000-0000-4000-8000-000000000001",keyId:"synthetic"}},standard);
  `);
  const clientBundle = await bundle("client", `
    import standard from "../src/worker/index";
    import {createWindowsPortalStagingWorker} from "../src/worker/client-portal/windows-files-staging-worker";
    export {${WINDOWS_STAGING_EXPORT_POLICY.delivery.runtime.join(",")}} from "../src/worker/index";
    export default createWindowsPortalStagingWorker({enabled:true,deployment:{accountId:"00000000000000000000000000000000",workerName:"local-client-staging",databaseId:"11111111-1111-4111-8111-111111111111",bucketName:"local-data-staging",opsReaderWorkerName:"local-ops-staging"}},standard);
  `);
  const baselineOps = await bundle("operations"), baselineClient = await bundle("client");
  const exportAudits = { ops: assertWindowsStagingRuntimeExports("operations", baselineOps.exports, opsBundle.exports),
    client: assertWindowsStagingRuntimeExports("delivery", baselineClient.exports, clientBundle.exports) };
  const observations = { jwksRequests: 0, forbiddenNetwork: [] as string[], directRpcCalls: 0, directRpcDenied: 0 };
  const outboundService = async (request: Request) => {
    if (request.method !== "GET" || request.url !== issuer + "/cdn-cgi/access/certs") {
      observations.forbiddenNetwork.push(new URL(request.url).origin); return new MfResponse("Local fixture outbound denied", { status: 503 });
    }
    observations.jwksRequests++; return MfResponse.json({ keys: [publicKey] });
  };
  const shared = { modules: true, compatibilityDate: "2026-08-06", compatibilityFlags: ["nodejs_compat"], outboundService };
  const opsId = crypto.randomUUID(), clientId = crypto.randomUUID(), bucketId = crypto.randomUUID();
  const opsBindings = { ENVIRONMENT: "staging", EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com", PUBLIC_BASE_URL: "https://ops-staging.ledgetopdroneservices.com", OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "true" };
  const runtime = new Miniflare({ workers: [
    { ...shared, name: "local-client", script: clientBundle.script, d1Databases: { DELIVERY_DB: clientId }, r2Buckets: { DATA_BUCKET: bucketId },
      bindings: { ENVIRONMENT: "staging", CLIENT_PORTAL_ORIGIN: workerOrigin, CLIENT_PORTAL_ENABLED: "true", CLIENT_ACCESS_TEAM_DOMAIN: issuer, CLIENT_ACCESS_AUD: audience,
        CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED: "true", CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED: "true",
        DELIVERY_SESSION_SECRET: randomBytes(48).toString("hex"), CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET: randomBytes(48).toString("hex"), WINDOWS_PORTAL_QUEUE_KEY: randomBytes(32).toString("base64url") },
      serviceBindings: { OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER: { name: "local-ops", entrypoint: "OperationsPortalNativeDeliveryAuthorizationReader" } } },
    { ...shared, name: "local-ops", script: opsBundle.script, bindings: opsBindings, d1Databases: { OPS_DB: opsId } },
    { ...shared, name: "local-ops-disabled", script: opsBundle.script, bindings: { ...opsBindings, OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED: "false" }, d1Databases: { OPS_DB: opsId } },
    { ...shared, name: "local-probe", serviceBindings: { READER: { name: "local-ops", entrypoint: "OperationsPortalNativeDeliveryAuthorizationReader" }, DISABLED: { name: "local-ops-disabled", entrypoint: "OperationsPortalNativeDeliveryAuthorizationReader" } },
      script: `export default {async fetch(request,env){const input=await request.json();const reader=input.disabled?env.DISABLED:env.READER;const result=input.feature===undefined?await reader.readWindowsDeliverySuccessorAuthorization(input.wire):await reader.readWindowsCatalogSuccessorAuthorization(input.wire,input.feature);return new Response(result,{headers:{"content-type":"application/json"}});}};` }
  ] });
  try {
    const db = await runtime.getD1Database("DELIVERY_DB", "local-client") as unknown as D1Database;
    const ops = await runtime.getD1Database("OPS_DB", "local-ops") as unknown as D1Database;
    const bucket = await runtime.getR2Bucket("DATA_BUCKET", "local-client") as unknown as R2Bucket;
    for (const file of ["0001_initial.sql", "0003_delivery_platform.sql", "0008_trash_tombstones.sql", "0223_operations_portal_workspace_publications.sql", "0224_operations_portal_native_recipient_authority.sql", "0225_operations_portal_workspace_publication_cancellations.sql", "0226_operations_portal_native_workspace_cleanup.sql", "0227_operations_portal_native_delivery_authority.sql", "0228_operations_portal_native_content_start_audit.sql", "0229_operations_portal_native_delivery_regrant.sql", "0230_operations_portal_native_delivery_terminal_cancellations.sql", "0235_windows_portal_successor_candidates.sql", "0236_windows_portal_successor_content_start_audit.sql"])
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8")).map(q => db.prepare(q)));
    const authority = await realOpsTransportAuthority(ops, db, { issuer });
    const bytes = Uint8Array.from({ length: 2 * 1024 * 1024 }, (_, i) => (i * 31 + 17) % 251);
    const sha = await crypto.subtle.digest("SHA-256", bytes);
    const object = await bucket.put(authority.objectKey, bytes, { sha256: sha });
    await db.prepare("INSERT INTO file_index(r2_key,etag,size,uploaded_at,content_type,media_kind) VALUES(?,?,?,?,?,?)").bind(authority.objectKey, object!.etag, bytes.length, new Date().toISOString(), "application/octet-stream", "other").run();
    const clientWorker = await runtime.getWorker("local-client"), probe = await runtime.getWorker("local-probe");
    const commandWire = canonicalOperationsPortalNativeDeliveryAuthorityCommand(authority.command);
    return { runtime, db, ops, bucket, bytes, sha, token, workerOrigin, observations,
      fullOpsComposition: true, exportAudits, localCompatibilityDate: "2026-08-06",
      bundles: { ops: { sha256: opsBundle.sha256, exports: opsBundle.exports }, client: { sha256: clientBundle.sha256, exports: clientBundle.exports } },
      fetch: (request: Request) => clientWorker.fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body }) }),
      revoke: authority.revoke,
      async rpc({ wire = commandWire, feature, disabled = false }: { wire?: string; feature?: string; disabled?: boolean } = {}) {
        const reply = await probe.fetch("https://local-probe.invalid/", { method: "POST", body: JSON.stringify({ wire, feature, disabled }) });
        const result = await reply.json() as { ok: boolean; code?: string }; observations.directRpcCalls++; if (result.code === "denied") observations.directRpcDenied++; return result;
      }
    };
  } catch (error) { await runtime.dispose(); throw error; }
}
