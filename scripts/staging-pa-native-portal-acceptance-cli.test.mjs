import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import { NATIVE_PORTAL_ACCEPTANCE_CONFIGS } from "./staging-native-portal-acceptance-profile.mjs";
import { buildPaNativePortalAcceptanceConfigs } from "./staging-pa-native-portal-acceptance-profile.mjs";
import {
  PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS,
  run,
} from "./staging-pa-native-portal-acceptance-cli.mjs";

const root = path.resolve(import.meta.dirname, "..");
const apps = ["delivery", "operations"];
const outputPatterns = Object.values(PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS);
const values = Object.freeze({
  DELIVERY_STAGING_ACCESS_AUD: "a".repeat(64),
  OPERATIONS_STAGING_ACCESS_AUD: "b".repeat(64),
  PROJECT_ALPHA_OPS_SYNC_STAGING_ACCESS_AUD: "c".repeat(64),
  DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD: "d".repeat(64),
  STAGING_PROJECT_ALPHA_SOURCE_ID: "project-alpha:staging",
  STAGING_PROJECT_ALPHA_HTTPS_ORIGIN: "https://pa-staging.ledgetoptechnologies.com",
  CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.client-staging",
  OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.operations-staging",
  MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false",
  STAGING_EMAIL_DOMAIN: "staging.example.test",
  STAGING_TRIAGE_EMAIL: "triage@staging.example.test",
  STAGING_ACCESS_GROUP_ID: "11111111-1111-4111-8111-111111111111",
  STAGING_ACCESS_GROUP_NAME: "LTDS staging operators",
});

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function fixture(ignore = outputPatterns) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-pa-native-portal-cli-"));
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: base, windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr?.toString());
  fs.writeFileSync(path.join(base, ".gitignore"), `${ignore.join("\n")}\n`);
  const sources = {};
  const production = {};
  const rendered = renderConfigs(root, values);
  for (const app of apps) {
    const config = NATIVE_PORTAL_ACCEPTANCE_CONFIGS[app];
    sources[app] = rendered[app];
    production[app] = JSON.parse(fs.readFileSync(path.join(root, config.production), "utf8"));
    write(path.join(base, config.source), sources[app]);
    write(path.join(base, config.production), production[app]);
  }
  return { base, sources, production, expected: buildPaNativePortalAcceptanceConfigs(sources, production) };
}

function bytes(current) {
  return Object.fromEntries(apps.flatMap(app => {
    const config = NATIVE_PORTAL_ACCEPTANCE_CONFIGS[app];
    return [
      [`${app}.source`, fs.readFileSync(path.join(current.base, config.source), "utf8")],
      [`${app}.production`, fs.readFileSync(path.join(current.base, config.production), "utf8")],
    ];
  }));
}

test("writes the fixed ignored pair, checks exactly, and never rewrites current outputs or baselines", () => {
  const current = fixture();
  try {
    const baselineBytes = bytes(current);
    assert.deepEqual(run(["--write"], current.base), outputPatterns);
    const outputBytes = {};
    for (const app of apps) {
      const file = path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS[app]);
      assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), current.expected[app]);
      outputBytes[app] = fs.readFileSync(file, "utf8");
    }
    assert.deepEqual(run(["--check"], current.base), outputPatterns);
    assert.deepEqual(run(["--write"], current.base), outputPatterns);
    assert.deepEqual(bytes(current), baselineBytes);
    for (const app of apps)
      assert.equal(fs.readFileSync(path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS[app]), "utf8"), outputBytes[app]);
  } finally { fs.rmSync(current.base, { recursive: true, force: true }); }
});

test("rejects stale or conflicting existing output before creating or changing its pair", () => {
  for (const staleApp of apps) {
    const current = fixture();
    try {
      const staleFile = path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS[staleApp]);
      write(staleFile, { stale: true });
      const before = fs.readFileSync(staleFile, "utf8");
      assert.throws(() => run(["--write"], current.base), /stale or conflicting.*not overwritten/);
      assert.equal(fs.readFileSync(staleFile, "utf8"), before);
      const other = apps.find(app => app !== staleApp);
      assert.equal(fs.existsSync(path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS[other])), false);
    } finally { fs.rmSync(current.base, { recursive: true, force: true }); }
  }
});

test("a second-link EEXIST rolls back only the first new output and preserves the concurrent file", { concurrency: false }, () => {
  const current = fixture();
  const originalLinkSync = fs.linkSync;
  try {
    let calls = 0;
    fs.linkSync = (source, destination) => {
      calls += 1;
      if (calls === 1) return originalLinkSync(source, destination);
      write(destination, { concurrent: true });
      const error = new Error("synthetic concurrent output");
      error.code = "EEXIST";
      throw error;
    };
    assert.throws(() => run(["--write"], current.base), /appeared concurrently.*no existing file was overwritten/);
    assert.equal(calls, 2);
    assert.equal(fs.existsSync(path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS.delivery)), false);
    const concurrent = path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS.operations);
    assert.deepEqual(JSON.parse(fs.readFileSync(concurrent, "utf8")), { concurrent: true });
    for (const app of apps) {
      const directory = path.dirname(path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS[app]));
      assert.equal(fs.readdirSync(directory).some(name => name.includes(".tmp-")), false);
    }
  } finally {
    fs.linkSync = originalLinkSync;
    fs.rmSync(current.base, { recursive: true, force: true });
  }
});

test("a missing-pair write failure preserves an already valid output and removes its temp", { concurrency: false }, () => {
  const current = fixture();
  const originalLinkSync = fs.linkSync;
  try {
    const existing = path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS.delivery);
    write(existing, current.expected.delivery);
    const existingBytes = fs.readFileSync(existing, "utf8");
    let calls = 0;
    fs.linkSync = () => {
      calls += 1;
      const error = new Error("synthetic link failure");
      error.code = "EIO";
      throw error;
    };
    assert.throws(() => run(["--write"], current.base), /synthetic link failure/);
    assert.equal(calls, 1);
    assert.equal(fs.readFileSync(existing, "utf8"), existingBytes);
    assert.equal(fs.existsSync(path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS.operations)), false);
    const directory = path.dirname(path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS.operations));
    assert.equal(fs.readdirSync(directory).some(name => name.includes(".tmp-")), false);
  } finally {
    fs.linkSync = originalLinkSync;
    fs.rmSync(current.base, { recursive: true, force: true });
  }
});

test("check fails closed when either fixed output is missing", () => {
  const current = fixture();
  try {
    assert.throws(() => run(["--check"], current.base), /outputs are missing/);
    write(path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS.delivery), current.expected.delivery);
    assert.throws(() => run(["--check"], current.base), /outputs are missing/);
    assert.equal(fs.existsSync(path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS.operations)), false);
  } finally { fs.rmSync(current.base, { recursive: true, force: true }); }
});

test("requires both fixed outputs to be ignored before writing either", () => {
  for (const ignoredOutput of outputPatterns) {
    const current = fixture([ignoredOutput]);
    try {
      assert.throws(() => run(["--write"], current.base), /acceptance output must be ignored/);
      for (const app of apps)
        assert.equal(fs.existsSync(path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS[app])), false);
    } finally { fs.rmSync(current.base, { recursive: true, force: true }); }
  }
});

test("rejects missing, malformed, or invalid source and production baselines without output", () => {
  const mutations = [
    current => fs.rmSync(path.join(current.base, NATIVE_PORTAL_ACCEPTANCE_CONFIGS.delivery.source)),
    current => write(path.join(current.base, NATIVE_PORTAL_ACCEPTANCE_CONFIGS.operations.production), "{not-json\n"),
    current => {
      const file = path.join(current.base, NATIVE_PORTAL_ACCEPTANCE_CONFIGS.operations.source);
      const source = JSON.parse(fs.readFileSync(file, "utf8"));
      source.vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED = "true";
      write(file, source);
    },
  ];
  for (const mutate of mutations) {
    const current = fixture();
    try {
      mutate(current);
      assert.throws(() => run(["--write"], current.base));
      for (const app of apps)
        assert.equal(fs.existsSync(path.join(current.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS[app])), false);
    } finally { fs.rmSync(current.base, { recursive: true, force: true }); }
  }
});

test("rejects symlinked input and output artifacts", () => {
  const inputFixture = fixture();
  try {
    const source = path.join(inputFixture.base, NATIVE_PORTAL_ACCEPTANCE_CONFIGS.delivery.source);
    const target = path.join(inputFixture.base, ".source-junction-target");
    fs.rmSync(source);
    fs.mkdirSync(target);
    fs.symlinkSync(target, source, "junction");
    assert.throws(() => run(["--write"], inputFixture.base), /regular non-symlink file/);
  } finally { fs.rmSync(inputFixture.base, { recursive: true, force: true }); }

  const outputFixture = fixture();
  try {
    const output = path.join(outputFixture.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS.delivery);
    const target = path.join(outputFixture.base, ".output-junction-target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, output, "junction");
    assert.throws(() => run(["--write"], outputFixture.base), /regular non-symlink file/);
    assert.equal(fs.existsSync(path.join(outputFixture.base, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS.operations)), false);
  } finally { fs.rmSync(outputFixture.base, { recursive: true, force: true }); }
});

test("accepts no secret, network, output-path, or other unsupported arguments", () => {
  const current = fixture();
  try {
    for (const argv of [[], ["--write", "--secret", "sensitive-value"], ["--output", "elsewhere"], ["--deploy"]]) {
      let thrown;
      try { run(argv, current.base); } catch (error) { thrown = error; }
      assert(thrown);
      assert.match(thrown.message, /no secret, network, or remote-operation arguments are accepted/);
      assert.doesNotMatch(thrown.message, /sensitive-value/);
    }
  } finally { fs.rmSync(current.base, { recursive: true, force: true }); }
});
