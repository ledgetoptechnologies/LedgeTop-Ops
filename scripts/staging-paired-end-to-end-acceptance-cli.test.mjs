import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import { VIEWER_ACCEPTANCE_SECRET_NAMES } from "./staging-project-alpha-api-v2-viewer-acceptance-profile.mjs";
import {
  PAIRED_END_TO_END_ACCEPTANCE_CONFIGS as CONFIGS,
  PAIRED_END_TO_END_ACCEPTANCE_SECRET_NAMES as SECRET_NAMES,
  run,
} from "./staging-paired-end-to-end-acceptance-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const values = Object.freeze({
  DELIVERY_STAGING_ACCESS_AUD: "a".repeat(64), OPERATIONS_STAGING_ACCESS_AUD: "b".repeat(64),
  PROJECT_ALPHA_OPS_SYNC_STAGING_ACCESS_AUD: "c".repeat(64), DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD: "d".repeat(64),
  STAGING_PROJECT_ALPHA_SOURCE_ID: "project-alpha:staging", STAGING_PROJECT_ALPHA_HTTPS_ORIGIN: "https://pa-staging.ledgetoptechnologies.com",
  CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.client-staging", OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.operations-staging",
  MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false", STAGING_EMAIL_DOMAIN: "staging.example.test", STAGING_TRIAGE_EMAIL: "triage@staging.example.test",
  STAGING_ACCESS_GROUP_ID: "11111111-1111-4111-8111-111111111111", STAGING_ACCESS_GROUP_NAME: "LTDS staging operators",
});

function fixture({ ignored = true, secrets = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-paired-e2e-cli-"));
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: base, encoding: "utf8", windowsHide: true });
  if (initialized.status !== 0) throw initialized.error || new Error(initialized.stderr);
  fs.writeFileSync(path.join(base, ".gitignore"), ignored ? "apps/*/wrangler.staging.*.json\n.backups/\n" : ".backups/\n");
  const rendered = renderConfigs(root, values);
  for (const [app, files] of Object.entries(CONFIGS)) {
    fs.mkdirSync(path.dirname(path.join(base, files.source)), { recursive: true });
    fs.writeFileSync(path.join(base, files.source), `${JSON.stringify(rendered[app], null, 2)}\n`);
    fs.writeFileSync(path.join(base, files.production), fs.readFileSync(path.join(root, files.production)));
  }
  if (secrets) {
    const inventory = path.join(base, SECRET_NAMES); fs.mkdirSync(path.dirname(inventory), { recursive: true });
    fs.writeFileSync(inventory, `${JSON.stringify({ names: [...VIEWER_ACCEPTANCE_SECRET_NAMES] }, null, 2)}\n`);
  }
  return base;
}

function symlinkOrSkip(t, target, link, type = "file") {
  try { fs.symlinkSync(target, link, type); return true; }
  catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") {
      t.skip("Windows policy does not permit symbolic-link creation"); return false;
    }
    throw error;
  }
}

test("writes and checks the exact ignored pair without changing inputs", () => {
  const base = fixture();
  const inputs = Object.values(CONFIGS).flatMap(files => [files.source, files.production])
    .concat(SECRET_NAMES).map(relative => [relative, fs.readFileSync(path.join(base, relative), "utf8")]);
  assert.deepEqual(run(["--write"], base), Object.values(CONFIGS).map(files => files.output));
  run(["--check"], base);
  for (const [relative, bytes] of inputs) assert.equal(fs.readFileSync(path.join(base, relative), "utf8"), bytes);
  if (process.platform !== "win32") for (const files of Object.values(CONFIGS))
    assert.equal(fs.statSync(path.join(base, files.output)).mode & 0o777, 0o600);
});

test("requires an exact mode and both candidates on check", () => {
  const base = fixture();
  assert.throws(() => run(["--check"], base), /candidates are missing/);
  assert.throws(() => run(["--write", "extra"], base), /usage:/);
});

test("rejects a partial pair", () => {
  const base = fixture(); run(["--write"], base);
  fs.rmSync(path.join(base, CONFIGS.delivery.output));
  assert.throws(() => run(["--check"], base), /candidates are partial/);
  assert.throws(() => run(["--write"], base), /candidates are partial/);
});

test("rejects drift and never overwrites existing candidates", () => {
  const base = fixture(); run(["--write"], base);
  const output = path.join(base, CONFIGS.operations.output);
  const value = JSON.parse(fs.readFileSync(output, "utf8"));
  value.vars.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED = "false";
  value.vars.UNRELATED_ACCEPTANCE_FLAG = "true";
  fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
  const before = fs.readFileSync(output, "utf8");
  assert.throws(() => run(["--write"], base), /invalid or stale/);
  assert.equal(fs.readFileSync(output, "utf8"), before);
});

test("a valid existing pair is not overwritten", () => {
  const base = fixture(); run(["--write"], base);
  const before = Object.values(CONFIGS).map(files => fs.readFileSync(path.join(base, files.output), "utf8"));
  run(["--write"], base);
  assert.deepEqual(Object.values(CONFIGS).map(files => fs.readFileSync(path.join(base, files.output), "utf8")), before);
});

test("a second publish race cleans only invocation-created output and temporaries", () => {
  const base = fixture();
  const inputs = Object.values(CONFIGS).flatMap(files => [files.source, files.production])
    .concat(SECRET_NAMES).map(relative => [relative, fs.readFileSync(path.join(base, relative), "utf8")]);
  const firstOutput = path.join(base, CONFIGS.delivery.output);
  const secondOutput = path.join(base, CONFIGS.operations.output);
  const interloper = "racing output must survive\n";
  const originalLinkSync = fs.linkSync;
  let publishes = 0;
  fs.linkSync = (existingPath, newPath) => {
    publishes += 1;
    if (publishes === 2) fs.writeFileSync(secondOutput, interloper, { flag: "wx" });
    return originalLinkSync(existingPath, newPath);
  };
  try {
    assert.throws(() => run(["--write"], base), error => error?.code === "EEXIST");
  } finally {
    fs.linkSync = originalLinkSync;
  }

  assert.equal(publishes, 2);
  assert.equal(fs.existsSync(firstOutput), false);
  assert.equal(fs.readFileSync(secondOutput, "utf8"), interloper);
  for (const [relative, bytes] of inputs) assert.equal(fs.readFileSync(path.join(base, relative), "utf8"), bytes);
  for (const files of Object.values(CONFIGS)) {
    const directory = path.dirname(path.join(base, files.output));
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes(".tmp-")), []);
  }
});

test("requires the names-only secret inventory", () => {
  assert.throws(() => run(["--write"], fixture({ secrets: false })), /operations-staging-secret-names.json is missing/);
  const base = fixture(), inventory = path.join(base, SECRET_NAMES);
  fs.writeFileSync(inventory, `${JSON.stringify({ names: [], values: {} })}\n`);
  assert.throws(() => run(["--write"], base), /secret names|secret values/);
});

test("rejects nonignored outputs", () => {
  assert.throws(() => run(["--write"], fixture({ ignored: false })), /must be ignored/);
});

test("rejects symlinked baseline, production, inventory, and output files", t => {
  for (const relative of [CONFIGS.delivery.source, CONFIGS.operations.production, SECRET_NAMES]) {
    const base = fixture(), file = path.join(base, relative), target = `${file}.real`; fs.renameSync(file, target);
    if (!symlinkOrSkip(t, target, file)) return;
    assert.throws(() => run(["--write"], base), /regular non-symlink|remain below/);
  }
  const base = fixture(); run(["--write"], base);
  const output = path.join(base, CONFIGS.delivery.output), target = `${output}.real`; fs.renameSync(output, target);
  if (!symlinkOrSkip(t, target, output)) return;
  assert.throws(() => run(["--check"], base), /regular non-symlink|remain below/);
});

test("rejects parent directory escape", t => {
  const base = fixture(), client = path.join(base, "apps", "client");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-paired-e2e-outside-"));
  const moved = path.join(outside, "client"); fs.renameSync(client, moved);
  if (!symlinkOrSkip(t, moved, client, process.platform === "win32" ? "junction" : "dir")) return;
  assert.throws(() => run(["--write"], base), /remain below the workspace root/);
});

test("rejects an enabled production constituent gate", () => {
  const base = fixture(), file = path.join(base, CONFIGS.operations.production);
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.vars.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED = "true";
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  assert.throws(() => run(["--write"], base), /EXACT_ADOPTION_ENABLED=false/);
});
