import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildExpandConfig,
  MIGRATION_FILE,
  MIGRATION_PATTERN,
  OUTPUT_CONFIG,
  run,
  SOURCE_CONFIG,
  validateExpandConfig,
} from "./staging-client-expand-0179-config.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

const sourceConfig = () => ({
  $schema: "node_modules/wrangler/config-schema.json",
  name: "ltds-delivery-staging",
  main: "src/worker/index.ts",
  vars: { ENVIRONMENT: "staging", FEATURE_FLAG: "false" },
  r2_buckets: [{ binding: "DATA_BUCKET", bucket_name: "client-data-staging" }],
  d1_databases: [{
    binding: "DELIVERY_DB",
    database_name: "client-data-staging",
    database_id: "b6f653ab-9acd-4421-9ad0-207754b59aeb",
    migrations_dir: "migrations",
  }],
  services: [{ binding: "VIEWER_SESSION_ISSUER", service: "ltds-ops-staging" }],
});

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-expand-0179-"));
  fs.mkdirSync(path.join(base, "apps", "client", "migrations"), { recursive: true });
  fs.mkdirSync(path.join(base, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(base, SOURCE_CONFIG), `${JSON.stringify(sourceConfig(), null, 2)}\n`);
  fs.writeFileSync(path.join(base, "apps", "client", MIGRATION_PATTERN), "-- canonical migration\n");
  return base;
}

test("derives an exact 0179 config while preserving every staging field and binding", () => {
  const base = fixture();
  const source = sourceConfig();
  const candidate = buildExpandConfig(source, base);
  assert.equal(candidate.d1_databases[0].migrations_pattern, MIGRATION_PATTERN);
  const comparable = structuredClone(candidate);
  delete comparable.d1_databases[0].migrations_pattern;
  assert.deepEqual(comparable, source);
  assert.deepEqual(validateExpandConfig(source, candidate, base), []);
});

test("the checked-in Client staging template remains compatible with the derived config", () => {
  const template = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "docs", "staging", "delivery.wrangler.json.example"), "utf8"));
  const candidate = buildExpandConfig(template, repositoryRoot);
  assert.deepEqual(validateExpandConfig(template, candidate, repositoryRoot), []);
  assert.equal(candidate.d1_databases[0].database_id, template.d1_databases[0].database_id);
  assert.equal(candidate.d1_databases[0].migrations_pattern, MIGRATION_PATTERN);
});

test("writes only the derived config, remains idempotent, and validates it", () => {
  const base = fixture();
  run(["--write"], base);
  assert.equal(fs.existsSync(path.join(base, OUTPUT_CONFIG)), true);
  assert.equal(fs.readdirSync(path.join(base, "apps", "client", "migrations")).join(), MIGRATION_FILE);
  run(["--write"], base);
  assert.equal(run(["--check"], base), OUTPUT_CONFIG);
});

test("fails closed when the output broadens the pattern or changes a staging binding", () => {
  const base = fixture();
  const source = sourceConfig();
  const candidate = buildExpandConfig(source, base);
  candidate.d1_databases[0].migrations_pattern = "migrations/*.sql";
  candidate.r2_buckets[0].bucket_name = "client-data-production";
  const errors = validateExpandConfig(source, candidate, base);
  assert(errors.some((error) => error.includes("select exactly")), errors.join(" | "));
  assert(errors.some((error) => error.includes("drifted")), errors.join(" | "));
});

test("fails closed on a missing canonical migration, ambiguous D1 binding, or stale generated config", () => {
  const base = fixture();
  fs.rmSync(path.join(base, "apps", "client", MIGRATION_PATTERN));
  assert.throws(() => buildExpandConfig(sourceConfig(), base), /canonical migration is missing/);

  fs.writeFileSync(path.join(base, "apps", "client", MIGRATION_PATTERN), "-- canonical migration\n");
  const ambiguous = sourceConfig();
  ambiguous.d1_databases.push({ ...ambiguous.d1_databases[0], binding: "OTHER_DB" });
  assert.throws(() => buildExpandConfig(ambiguous, base), /exactly one DELIVERY_DB/);

  run(["--write"], base);
  const changedSource = sourceConfig();
  changedSource.d1_databases[0].database_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  fs.writeFileSync(path.join(base, SOURCE_CONFIG), `${JSON.stringify(changedSource, null, 2)}\n`);
  assert.throws(() => run(["--check"], base), /drifted/);
  assert.throws(() => run(["--write"], base), /invalid or stale/);
});

test("rejects an already-filtered base staging config", () => {
  const base = fixture();
  const source = sourceConfig();
  source.d1_databases[0].migrations_pattern = MIGRATION_PATTERN;
  assert.throws(() => buildExpandConfig(source, base), /must not contain migrations_pattern/);
});
