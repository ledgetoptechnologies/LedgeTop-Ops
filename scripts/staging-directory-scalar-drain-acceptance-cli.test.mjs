import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildDirectoryScalarDrainAcceptanceConfig,
  DIRECTORY_SCALAR_DRAIN_ACCEPTANCE_OUTPUT,
  run,
  validateDirectoryScalarDrainAcceptanceConfig,
} from "./staging-directory-scalar-drain-acceptance-cli.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceName = "apps/operations/wrangler.staging.provider-preserved-scalar.json";

function providerSource() {
  const source = JSON.parse(fs.readFileSync(path.join(root, "apps/operations/wrangler.staging.json"), "utf8"));
  source.vars.NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED = "true";
  source.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED = "false";
  source.vars.PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED = "false";
  source.vars.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED = "false";
  source.vars.PROVIDER_PRESERVED_UNKNOWN_FLAG = "preserved-value";
  source.provider_preserved_resource = { nested: ["unchanged"] };
  return source;
}

function fixture(t, { ignored = true } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-scalar-drain-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: base, encoding: "utf8", windowsHide: true });
  if (initialized.status !== 0) throw initialized.error || new Error(initialized.stderr);
  fs.writeFileSync(path.join(base, ".gitignore"), ignored ? "apps/*/wrangler.staging.*.json\n" : "node_modules/\n");
  fs.mkdirSync(path.join(base, "apps/operations"), { recursive: true });
  fs.writeFileSync(path.join(base, sourceName), `${JSON.stringify(providerSource(), null, 2)}\n`);
  return base;
}

test("builds exactly one drain delta over the provider-preserved source", () => {
  const source = providerSource(), before = structuredClone(source);
  const candidate = buildDirectoryScalarDrainAcceptanceConfig(source);
  const expected = structuredClone(source);
  expected.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED = "true";
  assert.deepEqual(candidate, expected);
  assert.equal(validateDirectoryScalarDrainAcceptanceConfig(source, candidate), true);
  assert.deepEqual(source, before);
  assert.equal(Object.keys(candidate.vars).length, Object.keys(source.vars).length);
  assert.deepEqual(candidate.provider_preserved_resource, source.provider_preserved_resource);
});

test("writes once, checks exactly, and preserves an unrelated combined candidate", t => {
  const base = fixture(t);
  const combined = path.join(base, "apps/operations/wrangler.staging.pa-native-portal-acceptance.json");
  const combinedBytes = Buffer.from("synthetic combined candidate sentinel\n");
  fs.writeFileSync(combined, combinedBytes);
  assert.throws(() => run(["--check", "--operations-source-config", sourceName], base), /missing/);
  assert.equal(run(["--write", "--operations-source-config", sourceName], base), DIRECTORY_SCALAR_DRAIN_ACCEPTANCE_OUTPUT);
  const output = path.join(base, DIRECTORY_SCALAR_DRAIN_ACCEPTANCE_OUTPUT);
  const bytes = fs.readFileSync(output);
  run(["--write", "--operations-source-config", sourceName], base);
  run(["--check", "--operations-source-config", sourceName], base);
  assert.deepEqual(fs.readFileSync(output), bytes);
  assert.deepEqual(fs.readFileSync(combined), combinedBytes);
});

test("rejects unsafe gate state, target drift, and any second candidate delta", () => {
  for (const mutate of [
    value => { value.vars.NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED = "false"; },
    value => { value.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED = "true"; },
    value => { value.vars.PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED = "true"; },
    value => { value.vars.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED = "true"; },
    value => { value.name = "production"; },
    value => { value.d1_databases.find(row => row.binding === "OPS_DB").database_id = "wrong"; },
  ]) {
    const source = providerSource(); mutate(source);
    assert.throws(() => buildDirectoryScalarDrainAcceptanceConfig(source), /must|target/u);
  }
  const source = providerSource(), candidate = buildDirectoryScalarDrainAcceptanceConfig(source);
  candidate.vars.PROVIDER_PRESERVED_UNKNOWN_FLAG = "drifted";
  assert.throws(() => validateDirectoryScalarDrainAcceptanceConfig(source, candidate), /drifted outside/u);
});

test("requires an explicit ignored workspace-local source and accepts no extra arguments", t => {
  const base = fixture(t, { ignored: false });
  assert.throws(() => run(["--write", "--operations-source-config", sourceName], base), /must be ignored/u);
  assert.throws(() => run(["--write"], base), /usage/u);
  assert.throws(() => run(["--write", "--operations-source-config", sourceName, "--deploy"], base), /usage/u);
  assert.throws(() => run(["--write", "--operations-source-config", path.join(base, "..", "outside.json")], base), /remain below/u);
});

test("rejects stale and malformed local artifacts", t => {
  const base = fixture(t), output = path.join(base, DIRECTORY_SCALAR_DRAIN_ACCEPTANCE_OUTPUT);
  run(["--write", "--operations-source-config", sourceName], base);
  const stale = JSON.parse(fs.readFileSync(output, "utf8"));
  stale.vars.PROVIDER_PRESERVED_UNKNOWN_FLAG = "drifted";
  fs.writeFileSync(output, `${JSON.stringify(stale, null, 2)}\n`);
  assert.throws(() => run(["--check", "--operations-source-config", sourceName], base), /drifted outside/u);
  fs.writeFileSync(path.join(base, sourceName), "{not-json\n");
  assert.throws(() => run(["--check", "--operations-source-config", sourceName], base), /strict JSON/u);
});

test("rejects a symlinked provider-preserved source", t => {
  const base = fixture(t);
  const real = `${path.join(base, sourceName)}.real`;
  fs.writeFileSync(real, `${JSON.stringify(providerSource(), null, 2)}\n`);
  fs.unlinkSync(path.join(base, sourceName));
  try { fs.symlinkSync(real, path.join(base, sourceName)); }
  catch (error) {
    if (process.platform === "win32" && error?.code === "EPERM") return t.skip("Windows policy does not permit symbolic-link creation");
    throw error;
  }
  assert.throws(() => run(["--check", "--operations-source-config", sourceName], base), /regular non-symlink/u);
});
