import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import { NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS, run } from "./staging-native-workspace-acceptance-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const values = Object.freeze({
  DELIVERY_STAGING_ACCESS_AUD: "a".repeat(64), OPERATIONS_STAGING_ACCESS_AUD: "b".repeat(64),
  PROJECT_ALPHA_OPS_SYNC_STAGING_ACCESS_AUD: "c".repeat(64), DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD: "d".repeat(64),
  STAGING_PROJECT_ALPHA_SOURCE_ID: "project-alpha:staging", STAGING_PROJECT_ALPHA_HTTPS_ORIGIN: "https://pa-staging.ledgetoptechnologies.com",
  CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.client-staging", OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.operations-staging",
  MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false", STAGING_EMAIL_DOMAIN: "staging.example.test", STAGING_TRIAGE_EMAIL: "triage@staging.example.test",
  STAGING_ACCESS_GROUP_ID: "11111111-1111-4111-8111-111111111111", STAGING_ACCESS_GROUP_NAME: "LTDS staging operators",
});

function fixture({ ignored = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-workspace-acceptance-cli-"));
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: base, encoding: "utf8", windowsHide: true });
  if (initialized.status !== 0) throw initialized.error || new Error(initialized.stderr);
  const rendered = renderConfigs(root, values);
  if (ignored) fs.writeFileSync(path.join(base, ".gitignore"), "apps/*/wrangler.staging.*.json\n");
  else fs.writeFileSync(path.join(base, ".gitignore"), "node_modules/\n");
  for (const [app, files] of Object.entries(NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS)) {
    fs.mkdirSync(path.dirname(path.join(base, files.source)), { recursive: true });
    fs.writeFileSync(path.join(base, files.source), `${JSON.stringify(rendered[app], null, 2)}\n`);
    fs.writeFileSync(path.join(base, files.production), fs.readFileSync(path.join(root, files.production)));
  }
  return base;
}

function symlinkOrSkip(t, target, link, type = "file") {
  try { fs.symlinkSync(target, link, type); return true; }
  catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") {
      t.skip("Windows policy does not permit symbolic-link creation");
      return false;
    }
    throw error;
  }
}

test("writes and idempotently checks only ignored workspace candidates", () => {
  const base = fixture(), sources = Object.values(NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS)
    .map(files => [files.source, fs.readFileSync(path.join(base, files.source), "utf8")]);
  assert.deepEqual(run(["--write"], base), Object.values(NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS).map(files => files.output));
  run(["--write"], base); run(["--check"], base);
  for (const [source, bytes] of sources) assert.equal(fs.readFileSync(path.join(base, source), "utf8"), bytes);
});

test("check requires candidates and argument mode is exact", () => {
  const base = fixture();
  assert.throws(() => run(["--check"], base), /missing; generate with --write/);
  assert.throws(() => run(["--write", "--check"], base), /usage:/);
});

test("refuses stale or unrelated candidate drift without overwrite", () => {
  const base = fixture(); run(["--write"], base);
  const output = path.join(base, NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS.operations.output);
  const candidate = JSON.parse(fs.readFileSync(output, "utf8"));
  candidate.vars.OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED = "false";
  candidate.vars.CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED = "true";
  fs.writeFileSync(output, `${JSON.stringify(candidate, null, 2)}\n`);
  const before = fs.readFileSync(output, "utf8");
  assert.throws(() => run(["--write"], base), /invalid or stale/);
  assert.equal(fs.readFileSync(output, "utf8"), before);
});

test("refuses nonignored outputs", () => {
  assert.throws(() => run(["--write"], fixture({ ignored: false })), /must be ignored/);
});

test("refuses symlinked inputs", t => {
  const base = fixture(), source = path.join(base, NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS.delivery.source);
  const target = `${source}.real`; fs.renameSync(source, target);
  if (!symlinkOrSkip(t, target, source)) return;
  assert.throws(() => run(["--write"], base), /regular non-symlink/);
});

test("refuses symlinked outputs", t => {
  const base = fixture(); run(["--write"], base);
  const output = path.join(base, NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS.delivery.output);
  const target = `${output}.real`; fs.renameSync(output, target);
  if (!symlinkOrSkip(t, target, output)) return;
  assert.throws(() => run(["--check"], base), /regular non-symlink/);
});

test("refuses parent directory chains that escape the workspace", t => {
  const base = fixture(), client = path.join(base, "apps", "client");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-workspace-acceptance-outside-"));
  const moved = path.join(outside, "client"); fs.renameSync(client, moved);
  if (!symlinkOrSkip(t, moved, client, process.platform === "win32" ? "junction" : "dir")) return;
  assert.throws(() => run(["--write"], base), /remain below the workspace root/);
});

test("refuses malformed source input", () => {
  const base = fixture(), source = path.join(base, NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS.delivery.source);
  fs.writeFileSync(source, "{not-json\n");
  assert.throws(() => run(["--write"], base), /must contain strict JSON/);
});

test("refuses resource and URL drift in existing candidates", () => {
  const base = fixture(); run(["--write"], base);
  const delivery = path.join(base, NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS.delivery.output);
  const deliveryCandidate = JSON.parse(fs.readFileSync(delivery, "utf8"));
  assert.ok(deliveryCandidate.services?.length); assert.ok(deliveryCandidate.routes?.length);
  deliveryCandidate.services[0].service = "wrong-staging-service";
  deliveryCandidate.routes[0].pattern = "wrong-staging.example.test/*";
  fs.writeFileSync(delivery, `${JSON.stringify(deliveryCandidate, null, 2)}\n`);
  assert.throws(() => run(["--check"], base), /invalid or stale/);
});

test("refuses active default staging or production workspace gates", () => {
  for (const selected of ["source", "production"]) {
    const base = fixture(), files = NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS.operations;
    const file = path.join(base, selected === "source" ? files.source : files.production);
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    value.vars.OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED = "true";
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    assert.throws(() => run(["--write"], base), /must keep|production must omit/);
  }
});
