import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { APP_SOURCE_DIRS } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const readJson = (relative) => JSON.parse(read(relative));
const normalizedSha256 = (relative) => crypto.createHash("sha256").update(read(relative).replace(/\r\n/g, "\n")).digest("hex");

const projectAlphaCompatibilityFixtures = [
  "packages/shared/fixtures/project-alpha-portal-v2.json",
  "packages/shared/fixtures/project-alpha-portal-relations-v3.json",
  "packages/shared/fixtures/project-alpha-catalog-v2.json",
  "packages/shared/fixtures/project-alpha-pricing-hint-v1.json",
  "packages/shared/fixtures/project-alpha-draft-quote-v1.json",
];
const portalWireFixture = "packages/shared/fixtures/portal-integration-wire-v1.json";
const serviceAssignmentFixture = "packages/shared/fixtures/project-alpha-service-assignments-v1.json";

const expectedRateLimits = [
  ["ACCESS_CODE_RATE_LIMITER", "19462026", 10],
  ["PUBLIC_SESSION_RATE_LIMITER", "19462027", 20],
  ["PUBLIC_MANIFEST_RATE_LIMITER", "19462028", 120],
  ["PUBLIC_MEDIA_RATE_LIMITER", "19462029", 180],
  ["PUBLIC_BULK_RATE_LIMITER", "19462030", 3],
  ["PUBLIC_THUMBNAIL_RATE_LIMITER", "19462031", 300],
  ["PUBLIC_DOWNLOAD_RATE_LIMITER", "19462032", 30],
  ["PUBLIC_STREAM_RATE_LIMITER", "19462033", 10],
];

const expectedPublicRoutes = [
  "GET /",
  "GET /api/public/cloud-transfers/oauth/:provider/callback",
  "GET /api/public/shares/:publicId/bulk-download/:jobId",
  "GET /api/public/shares/:publicId/cloud-transfers/:jobId",
  "GET /api/public/shares/:publicId/download-summary",
  "GET /api/public/shares/:publicId/items/:itemRef/download-ticket",
  "GET /api/public/shares/:publicId/locations",
  "GET /api/public/shares/:publicId/locations/:assetRef",
  "GET /api/public/shares/:publicId/manifest",
  "GET /client-share/:publicId",
  "GET /health",
  "GET /s/:publicId",
  "GET|HEAD /api/public/cloud-transfers/source/:grant",
  "GET|HEAD /api/public/shares/:publicId/bulk-download/:jobId/file",
  "GET|HEAD /api/public/shares/:publicId/items/:itemRef/download",
  "GET|HEAD /api/public/shares/:publicId/items/:itemRef/pdf",
  "GET|HEAD /api/public/shares/:publicId/items/:itemRef/preview",
  "GET|HEAD /api/public/shares/:publicId/items/:itemRef/source",
  "GET|HEAD /api/public/shares/:publicId/items/:itemRef/thumbnail",
  "GET|HEAD /portal",
  "GET|HEAD /portal/*",
  "GET|HEAD /assets/*",
  "POST /api/internal/client-request-attachments/:attachmentId/scanned",
  "POST /api/internal/project-alpha/catalog-v2",
  "POST /api/internal/project-alpha/portal-v2",
  "POST /api/internal/project-alpha/service-assignments-v1",
  "POST /api/internal/project-alpha/sources/:sourceId/portal-v2",
  "POST /api/internal/project-alpha/sources/:sourceId/service-assignments-v1",
  "POST /api/public/shares/:publicId/bulk-download",
  "POST /api/public/shares/:publicId/cloud-transfers",
  "POST /api/public/shares/:publicId/cloud-transfers/:jobId/cancel",
  "POST /api/public/shares/:publicId/cloud-transfers/:jobId/retry",
  "POST /api/public/shares/:publicId/cloud-transfers/google/authorizations/:authorizationId/token",
  "POST /api/public/shares/:publicId/cloud-transfers/oauth/:provider/start",
  "POST /api/public/shares/:publicId/items/:itemRef/stream-ticket",
  "POST /api/public/shares/:publicId/manifest/media",
  "POST /api/public/shares/:routeId/session",
  "USE /api/public/shares/:publicId/*",
].sort();

function publicRoutes(source) {
  const routes = [];
  for (const match of source.matchAll(/app\.(get|post|use)\(\s*"([^"]+)"/g)) {
    const route = match[2];
    if (route !== "*") routes.push(`${match[1].toUpperCase()} ${route}`);
  }
  for (const match of source.matchAll(/app\.on\(\s*(\[[^\]]+\])\s*,\s*"([^"]+)"/g)) {
    routes.push(`${JSON.parse(match[1]).join("|")} ${match[2]}`);
  }
  return routes.sort();
}

test("the client source directory retains the deployed delivery service identity", () => {
  assert.deepEqual(APP_SOURCE_DIRS, { delivery: "client", operations: "operations", "ops-sync": "ops-sync" });
  assert.equal(fs.existsSync(path.join(root, "apps", "client")), true);
  // Local build caches from the former source path may exist, but no deployable
  // package may reappear there.
  assert.equal(fs.existsSync(path.join(root, "apps", "delivery", "package.json")), false);
  assert.equal(readJson("apps/client/package.json").name, "@ltds/client");
  assert.equal(readJson("apps/client/package-lock.json").name, "@ltds/client");
  assert(!read("package.json").includes("apps/delivery"));
});

test("the deployed Client Worker keeps reviewed resources, hosts, and portal asset routing", () => {
  // The digest intentionally moved with the reviewed exact two-host portal
  // allowlist. Keep the field assertions below so a future config change
  // cannot hide behind a digest refresh.
  assert.equal(normalizedSha256("apps/client/wrangler.jsonc"), "5997e8fa2f6ec1e5d03498921e0c550dbcdc7e0b0bab5605011df2c5e4af6032");
  const config = readJson("apps/client/wrangler.jsonc");
  assert.equal(config.name, "ltds-clients");
  assert.equal(config.main, "src/worker/index.ts");
  assert.deepEqual(config.routes, [
    { pattern: "client.ledgetopdroneservices.com", custom_domain: true },
    { pattern: "portal.ledgetoptechnologies.com", custom_domain: true },
  ]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.triggers, { crons: ["*/5 * * * *", "15 * * * *"] });
  assert.deepEqual(config.assets, {
    binding: "ASSETS",
    directory: "./dist/client",
    not_found_handling: "single-page-application",
    run_worker_first: ["/", "/api/*", "/s/*", "/client-share/*", "/portal", "/portal/*", "/assets/*", "/health"],
  });
  assert.equal(config.vars.PUBLIC_BASE_URL, "https://client.ledgetopdroneservices.com");
  assert.equal(config.vars.PUBLIC_SHARE_ORIGIN, "https://client.ledgetopdroneservices.com");
  assert.equal(config.vars.EXPECTED_HOST, "client.ledgetopdroneservices.com");
  assert.equal(config.vars.CLIENT_PORTAL_ORIGIN, "https://client.ledgetopdroneservices.com");
  assert.equal(config.vars.CLIENT_PORTAL_ORIGINS, "https://client.ledgetopdroneservices.com,https://portal.ledgetoptechnologies.com");
  assert.equal(config.vars.CLIENT_PORTAL_ENABLED, "true");
  assert.equal(config.vars.CLIENT_PORTAL_CONTENT_AUDIT_ENABLED, "false");
  assert.equal(config.vars.PROJECT_ALPHA_CATALOG_HMAC_KEY_ID, "");
  assert.equal(config.vars.PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_KEY_ID, "");
  assert.equal(config.vars.PROJECT_ALPHA_PORTAL_HMAC_KEY_ID, "");
  assert.equal(config.vars.PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID, "");
  assert.equal(config.vars.CLIENT_PORTAL_TEAM_ENABLED, "false");
  assert.equal(config.vars.CLIENT_PORTAL_REQUEST_V2_ENABLED, "false");
  assert.equal(config.vars.CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED, "false");
  assert.equal(config.vars.CLIENT_REQUEST_ATTACHMENTS_ENABLED, "false");
  assert.equal(config.vars.CLIENT_PORTAL_HIERARCHY_V2_ENABLED, "false");
  assert.equal(config.vars.CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED, "false");
  assert.equal(config.vars.AUTHENTICATED_DELIVERY_GRANTS_ENABLED, "false");
  assert.equal(config.vars.CLIENT_VIEWER_ENABLED, "false");
  assert.equal(config.vars.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED, "false");
  assert.equal(config.vars.CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED, "false");
  assert.equal(config.vars.CLIENT_PORTAL_INVITATION_EMAIL_ENABLED, "false");
  assert.equal(config.vars.CLIENT_PORTAL_ACCESS_ENROLLMENT_READY, "false");
  assert.equal(config.vars.CLIENT_DELEGATED_SHARES_ENABLED, "false");
  assert.equal(config.vars.PROJECT_ALPHA_CATALOG_SYNC_ENABLED, "false");
  assert.equal(config.vars.PROJECT_ALPHA_PORTAL_SYNC_ENABLED, "false");
  assert.equal(config.vars.PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED, "false");
  assert.equal(config.vars.CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED, "false");
  assert.equal(config.vars.PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED, "false");
  assert.equal(config.vars.PROJECT_ALPHA_PRICING_HINTS_ENABLED, "false");
  assert.equal(config.vars.R2_BUCKET_NAME, "client-data");
  assert.deepEqual(config.r2_buckets, [{ binding: "DATA_BUCKET", bucket_name: "client-data" }]);
  assert.deepEqual(config.d1_databases, [{
    binding: "DELIVERY_DB",
    database_name: "client-data",
    database_id: "7f40a7b7-c3ec-470e-a626-e798867f71f8",
    migrations_dir: "migrations",
  }]);
  assert.deepEqual(config.services, [
    {
      binding: "CLIENT_DELEGATED_SHARE_SIGNER",
      service: "ltds-ops",
      entrypoint: "ClientDelegatedShareSigner",
    },
    {
      binding: "VIEWER_SESSION_ISSUER",
      service: "ltds-ops",
      entrypoint: "ViewerSessionIssuer",
    },
  ]);
  assert.equal(config.images, undefined);
  assert.deepEqual(config.stream, { binding: "STREAM" });
  assert.deepEqual(config.workflows, [
    { name: "ltds-bulk-download", binding: "BULK_DOWNLOAD_WORKFLOW", class_name: "BulkDownloadWorkflow" },
    { name: "ltds-cloud-transfer", binding: "CLOUD_TRANSFER_WORKFLOW", class_name: "CloudTransferWorkflow" },
  ]);
  assert.deepEqual(config.ratelimits.map((item) => [item.name, item.namespace_id, item.simple.limit]), expectedRateLimits);
});

test("public route, host-namespace guard, health, and isolated cookie contracts remain reviewed", () => {
  const worker = read("apps/client/src/worker/index.ts");
  const originPolicy = read("apps/client/src/worker/origin-policy.ts");
  const security = read("apps/client/src/worker/security.ts");
  const delegated = read("apps/client/src/worker/client-portal/delegated-shares.ts");
  const lifecycle = read("apps/client/src/worker/public-share-lifecycle.ts");
  assert.deepEqual(publicRoutes(worker), expectedPublicRoutes);
  assert(worker.includes('app.route("/client-share/api", createClientDelegatedPublicRouter())'));
  assert(worker.includes('const COOKIE_NAME = "__Host-ltds_delivery";'));
  assert(worker.includes('service: "ltds-delivery"'));
  assert(worker.includes("requestHostAllowed(c.req.url,c.env)"));
  assert(originPolicy.includes('if (namespace === "public") return publicOrigin !== null && request.origin === publicOrigin;'));
  assert(originPolicy.includes('if (namespace === "internal") return primaryPortalOrigin !== null && request.origin === primaryPortalOrigin;'));
  assert(originPolicy.includes('if (namespace === "portal") return portalOrigins.includes(request.origin);'));
  assert(originPolicy.includes('if (namespace === "shared" || namespace === "assets")'));
  assert(originPolicy.includes('return (publicOrigin !== null && request.origin === publicOrigin) || portalOrigins.includes(request.origin);'));
  assert.equal(worker.match(/12 \* 60 \* 60 \* 1000/g)?.length, 1);
  assert.equal(lifecycle.match(/12 \* 60 \* 60 \* 1000/g)?.length, 1);
  assert(security.includes('`__Host-ltds_delivery=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`'));
  assert(!security.includes("Domain="));
  assert(delegated.includes('CLIENT_DELEGATED_SHARE_COOKIE = "__Secure-ltds_client_share"'));
  assert(delegated.includes("Path=/client-share/;"));
  assert(!delegated.includes("Domain="));
});

test("Operations and staging find the canonical client migration history", () => {
  assert.equal(readJson("apps/operations/wrangler.jsonc").d1_databases.find((item) => item.binding === "DELIVERY_DB").migrations_dir, "../client/migrations");
  assert(read("scripts/staging-requirements.mjs").includes('migrations_dir: "../client/migrations"'));
  assert(read("docs/staging/operations.wrangler.json.example").includes('"migrations_dir": "../client/migrations"'));
});

test("the Operations business-party lifecycle migration stays LF-only for D1 trigger parsing", () => {
  assert.match(read(".gitattributes"), /^apps\/operations\/migrations\/\*\.sql text eol=lf$/m);
  const bytes = fs.readFileSync(path.join(root, "apps/operations/migrations/0048_business_party_lifecycle.sql"));
  assert.equal(bytes.includes(13), false);
});

test("the Project Alpha handoff stays pinned to the reviewed compatibility corpus", () => {
  const prompt = read("docs/project-alpha-client-portal-agent-prompt.md").replaceAll("\r\n", "\n");
  assert(prompt.includes("Project Alpha commit `60e735265e0d50ef880fde33e058d213a8b70c4b`"));
  assert(prompt.includes("LTDS-Ops.git` commit\n`b1ee064d8e9a78ff1fbc43c671bff4c2c58d4c38`"));

  for (const fixture of projectAlphaCompatibilityFixtures) {
    const fixtureName = path.basename(fixture);
    const digest = normalizedSha256(fixture);
    assert(
      prompt.includes(`\`${fixture}\`:\n  \`${digest}\``),
      `${fixtureName} digest in the Project Alpha handoff is stale`,
    );
  }
});

test("the neutral Project Alpha wire contract stays byte-pinned across every route", () => {
  assert.equal(normalizedSha256(portalWireFixture), "063c993d8d1a20d7860517342e132efcf65a00b98b251b89ebf979333979d88a");
  const fixture = readJson(portalWireFixture);
  for (const name of ["portalProjection", "catalogProjection"]) {
    const value = fixture.cases[name];
    assert.equal(crypto.createHash("sha256").update(value.body).digest("hex"), value.bodySha256);
    const canonical = [value.timestamp, value.method, value.path, value.keyId, value.deliveryId, value.body].join("\n");
    assert.equal(canonical, value.canonical.replaceAll("\\n", "\n"));
    assert.equal(`sha256=${crypto.createHmac("sha256", fixture.testSecret).update(canonical).digest("hex")}`, value.signature);
  }
  for (const name of ["pricing", "draft"]) {
    const value = fixture.cases[name];
    assert.equal(crypto.createHash("sha256").update(value.body).digest("hex"), value.bodySha256);
    const canonical = [value.timestamp, value.method, value.path, value.scopeOrIdempotencyKey, value.bodySha256].join("\n");
    assert.equal(canonical, value.canonical.replaceAll("\\n", "\n"));
    assert.equal(`sha256=${crypto.createHmac("sha256", fixture.testSecret).update(canonical).digest("hex")}`, value.signature);
  }
  const rotation = fixture.rotationOverlap;
  const portal = fixture.cases.portalProjection;
  const previousCanonical = [portal.timestamp, portal.method, portal.path, rotation.previousKeyId, portal.deliveryId, portal.body].join("\n");
  assert.equal(previousCanonical, rotation.previousCanonical.replaceAll("\\n", "\n"));
  assert.equal(`sha256=${crypto.createHmac("sha256", rotation.previousTestSecret).update(previousCanonical).digest("hex")}`, rotation.previousSignature);
  assert.notEqual(rotation.currentKeyId, rotation.previousKeyId);
  assert.notEqual(rotation.unknownKeyId, rotation.currentKeyId);
  assert.notEqual(rotation.unknownKeyId, rotation.previousKeyId);
  const runtime = [
    "apps/client/src/worker/project-alpha-portal.ts",
    "apps/client/src/worker/project-alpha-catalog.ts",
    "apps/client/src/worker/client-portal/project-alpha-pricing-hint.ts",
    "apps/operations/src/worker/project-alpha-draft-quote.ts",
  ].map(read).join("\n");
  for (const header of fixture.commandHeaders) assert(runtime.includes(header), `${header} is missing from runtime`);
  for (const name of [
    "PROJECT_ALPHA_PORTAL_HMAC_KEY_ID", "PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID", "PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET",
    "PROJECT_ALPHA_CATALOG_HMAC_KEY_ID", "PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_KEY_ID", "PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_SECRET",
  ]) assert(runtime.includes(name), `${name} is missing from receiver rotation handling`);
  assert(!runtime.includes("X-PA-Timestamp"));
  assert(!runtime.includes("X-LTDS-Scope"));
});

test("the PA service-assignment producer fixture stays contract-pinned", () => {
  assert.equal(normalizedSha256(serviceAssignmentFixture), "6a85706e5ac2cc82a48ed58a993e3dd7f3308704bf0b897cd475106330f59fd9");
  const fixture = readJson(serviceAssignmentFixture);
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.requiredCapability, "portal.service-assignments.publish");
  assert.equal(fixture.snapshotPage.schemaVersion, 1);
  assert.equal(fixture.snapshotActivate.schemaVersion, 1);
  assert.equal(fixture.tombstoneEvent.schemaVersion, 1);
  assert.equal("workspacePublicId" in fixture.snapshotPage.items[0], false);
});

test("the TrueNAS thumbnail runbooks retain the production edge and lease contract", () => {
  const config = readJson("apps/operations/wrangler.jsonc");
  const renderer = read("apps/operations/src/worker/thumbnail-renderer-api.ts");
  const runbook = read("docs/media-thumbnail-pipeline.md");
  const setup = read("docs/cloudflare-setup.md");
  const flatRunbook = runbook.replace(/\s+/g, " ");
  const flatSetup = setup.replace(/\s+/g, " ");

  assert.equal(config.vars.THUMBNAIL_INGEST_EXPECTED_HOST, "ops.ledgetopdroneservices.com");
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "deploy-workers.yml")), false);
  assert.equal(fs.existsSync(path.join(root, ".github", "workflows", "publish-thumbnail-renderer.yml")), true);

  assert(renderer.includes('const RENDERER_API_PREFIX = "/api/internal/thumbnail-renderer/v1"'));
  assert(renderer.includes('env.THUMBNAIL_INGEST_EXPECTED_HOST || ""'));
  assert(!renderer.includes("env.INCOMING_EXPECTED_HOST"));
  assert(renderer.includes("const RENDERER_LEASE_TOKEN_MAX_MS = 24 * 60 * 60 * 1000"));
  assert(renderer.includes("const RENDERER_DEFAULT_LEASE_MS = 5 * 60 * 1000"));
  assert(renderer.includes("const RENDERER_VIDEO_INITIAL_LEASE_MS = 15 * 60 * 1000"));
  assert(renderer.includes('const initialLeaseMs = kind === "video" ? RENDERER_VIDEO_INITIAL_LEASE_MS : RENDERER_DEFAULT_LEASE_MS'));
  assert(renderer.includes("const renewedLeaseMs = Date.now() + RENDERER_DEFAULT_LEASE_MS"));
  assert(renderer.includes("expiresSeconds: 900"));
  assert(renderer.includes("typeof body.leaseId === \"string\""));

  for (const document of [runbook, setup]) {
    assert(document.includes("ops.ledgetopdroneservices.com"));
    assert(document.includes("/api/internal/thumbnail-ingest/v1"));
    assert(document.includes("/api/internal/thumbnail-renderer/v1"));
    assert(document.includes("CF-Access-Client-Id"));
    assert(document.includes("CF-Access-Client-Secret"));
    assert(document.includes("THUMBNAIL_INGEST_SECRET"));
    assert(/every\s+\*\*?60 seconds\*\*?|every\s+60 seconds/.test(document));
    assert(document.includes("15-minute D1") || document.includes("15-minute initial lease"));
    assert(document.includes("five minutes") || document.includes("five-minute"));
  }

  assert(flatRunbook.includes("must answer directly, without an Access login redirect"));
  assert(flatRunbook.includes("independent, at least 32-character Worker bearer"));
  assert(flatRunbook.includes("A stale or reclaimed attempt receives `404`"));
  assert(flatRunbook.includes("Video eligibility is at most `10 * 1024 * 1024 * 1024` bytes"));
  assert(flatRunbook.includes("`r2PresignedUrl` valid for 900 seconds"));
  assert(flatRunbook.includes("Do not pass either remote URL or any authentication header directly to FFmpeg"));
  assert(flatRunbook.includes("loopback-only range proxy; FFprobe and FFmpeg see only that loopback endpoint"));
  assert(flatRunbook.includes("This repository has no `.github/workflows/deploy-workers.yml`"));
  assert(!runbook.includes("`.github/workflows/deploy-workers.yml` auto-deploys"));
  assert(flatSetup.includes("Explicitly block or Access-protect the ingest prefix there, but allow the exact renderer prefix"));
});
