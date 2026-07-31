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
  "GET /api/public/cloud-transfers/oauth/:provider/callback",
  "GET /api/public/shares/:publicId/bulk-download/:jobId",
  "GET /api/public/shares/:publicId/cloud-transfers/:jobId",
  "GET /api/public/shares/:publicId/items/:itemRef/download-ticket",
  "GET /api/public/shares/:publicId/items/:itemRef/thumbnail",
  "GET /api/public/shares/:publicId/manifest",
  "GET /health",
  "GET /s/:publicId",
  "GET|HEAD /api/public/cloud-transfers/source/:grant",
  "GET|HEAD /api/public/shares/:publicId/bulk-download/:jobId/file",
  "GET|HEAD /api/public/shares/:publicId/items/:itemRef/download",
  "GET|HEAD /api/public/shares/:publicId/items/:itemRef/pdf",
  "GET|HEAD /api/public/shares/:publicId/items/:itemRef/preview",
  "GET|HEAD /api/public/shares/:publicId/items/:itemRef/source",
  "POST /api/public/shares/:publicId/bulk-download",
  "POST /api/public/shares/:publicId/cloud-transfers",
  "POST /api/public/shares/:publicId/cloud-transfers/:jobId/cancel",
  "POST /api/public/shares/:publicId/cloud-transfers/:jobId/retry",
  "POST /api/public/shares/:publicId/cloud-transfers/google/authorizations/:authorizationId/token",
  "POST /api/public/shares/:publicId/cloud-transfers/oauth/:provider/start",
  "POST /api/public/shares/:publicId/items/:itemRef/stream-ticket",
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
  assert.equal(fs.existsSync(path.join(root, "apps", "delivery")), false);
  assert.equal(readJson("apps/client/package.json").name, "@ltds/client");
  assert.equal(readJson("apps/client/package-lock.json").name, "@ltds/client");
  assert(!read("package.json").includes("apps/delivery"));
});

test("the deployed Worker, resources, hosts, and asset routing remain unchanged", () => {
  assert.equal(normalizedSha256("apps/client/wrangler.jsonc"), "caf189f0ed59cb5d9bff1c5f16dba97b5b0a861230538de3f487d488f5bb0f95");
  const config = readJson("apps/client/wrangler.jsonc");
  assert.equal(config.name, "ltds-delivery");
  assert.equal(config.main, "src/worker/index.ts");
  assert.equal(Object.hasOwn(config, "routes"), false);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.triggers, { crons: ["15 * * * *"] });
  assert.deepEqual(config.assets, {
    binding: "ASSETS",
    directory: "./dist/client",
    not_found_handling: "single-page-application",
    run_worker_first: ["/api/*", "/s/*", "/health"],
  });
  assert.equal(config.vars.PUBLIC_BASE_URL, "https://delivery.ledgetopdroneservices.com");
  assert.equal(config.vars.EXPECTED_HOST, "delivery.ledgetopdroneservices.com");
  assert.equal(config.vars.R2_BUCKET_NAME, "client-data");
  assert.deepEqual(config.r2_buckets, [{ binding: "DATA_BUCKET", bucket_name: "client-data" }]);
  assert.deepEqual(config.d1_databases, [{
    binding: "DELIVERY_DB",
    database_name: "client-data",
    database_id: "7f40a7b7-c3ec-470e-a626-e798867f71f8",
    migrations_dir: "migrations",
  }]);
  assert.deepEqual(config.images, { binding: "IMAGES" });
  assert.deepEqual(config.stream, { binding: "STREAM" });
  assert.deepEqual(config.workflows, [
    { name: "ltds-bulk-download", binding: "BULK_DOWNLOAD_WORKFLOW", class_name: "BulkDownloadWorkflow" },
    { name: "ltds-cloud-transfer", binding: "CLOUD_TRANSFER_WORKFLOW", class_name: "CloudTransferWorkflow" },
  ]);
  assert.deepEqual(config.ratelimits.map((item) => [item.name, item.namespace_id, item.simple.limit]), expectedRateLimits);
});

test("public route, host-guard, health, and cookie contracts remain unchanged", () => {
  const worker = read("apps/client/src/worker/index.ts");
  const security = read("apps/client/src/worker/security.ts");
  assert.deepEqual(publicRoutes(worker), expectedPublicRoutes);
  assert(worker.includes('const COOKIE_NAME = "__Host-ltds_delivery";'));
  assert(worker.includes('service: "ltds-delivery"'));
  assert(worker.includes('new URL(c.req.url).host !== c.env.EXPECTED_HOST'));
  assert.equal(worker.match(/12 \* 60 \* 60 \* 1000/g)?.length, 2);
  assert(security.includes('`__Host-ltds_delivery=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`'));
  assert(!security.includes("Domain="));
});

test("Operations and staging find the canonical client migration history", () => {
  assert.equal(readJson("apps/operations/wrangler.jsonc").d1_databases.find((item) => item.binding === "DELIVERY_DB").migrations_dir, "../client/migrations");
  assert(read("scripts/staging-requirements.mjs").includes('migrations_dir: "../client/migrations"'));
  assert(read("docs/staging/operations.wrangler.json.example").includes('"migrations_dir": "../client/migrations"'));
});
