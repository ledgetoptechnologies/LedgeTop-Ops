import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import {
  buildProjectAdoptionFinalizationAcceptanceConfig,
  PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG,
} from "./staging-project-alpha-project-adoption-finalization-acceptance-profile.mjs";
import {
  EXPECTED_STAGING_PROJECT_ADOPTION_OPERATIONS_VERSION_ID,
  REVIEWED_PROJECT_ADOPTION_LIVE_BOOLEAN_VALUES,
  STAGING_PROJECT_ADOPTION_OPERATIONS_WORKER,
} from "./staging-project-adoption-live-settings-preservation.mjs";
import {
  PROJECT_ADOPTION_LIVE_PREFLIGHT_MAX_AGE_MS,
  PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT,
  run,
} from "./staging-project-adoption-live-settings-profile.mjs";

const root = path.resolve(import.meta.dirname, "..");
const now = Date.parse("2026-10-09T18:00:00.000Z");
const snapshotPath = ".live-settings/project-adoption-snapshot.json";
const preflightPath = ".live-settings/project-adoption-preflight.json";
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

const json = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

const snapshot = () => ({
  schemaVersion: 1,
  environment: "staging",
  worker: {
    name: STAGING_PROJECT_ADOPTION_OPERATIONS_WORKER,
    versionId: EXPECTED_STAGING_PROJECT_ADOPTION_OPERATIONS_VERSION_ID,
  },
  settings: { ...REVIEWED_PROJECT_ADOPTION_LIVE_BOOLEAN_VALUES },
});

const preflight = (observedAt = new Date(now - 60_000).toISOString()) => ({
  schemaVersion: 1,
  environment: "staging",
  observedAt,
  activeVersionPreflight: {
    workerName: STAGING_PROJECT_ADOPTION_OPERATIONS_WORKER,
    versions: [{ versionId: EXPECTED_STAGING_PROJECT_ADOPTION_OPERATIONS_VERSION_ID, percentage: 100 }],
  },
});

function fixture(ignore = ["apps/operations/wrangler.staging.*.json", ".live-settings/"]) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-project-adoption-live-settings-"));
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: base, windowsHide: true });
  assert.equal(initialized.status, 0, initialized.stderr?.toString());
  fs.writeFileSync(path.join(base, ".gitignore"), `${ignore.join("\n")}\n`);

  const rendered = renderConfigs(root, values).operations;
  const production = JSON.parse(fs.readFileSync(path.join(root, "apps/operations/wrangler.jsonc"), "utf8"));
  const baseline = buildProjectAdoptionFinalizationAcceptanceConfig(rendered, production);
  json(path.join(base, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.source), rendered);
  json(path.join(base, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.production), production);
  json(path.join(base, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output), baseline);
  json(path.join(base, snapshotPath), snapshot());
  json(path.join(base, preflightPath), preflight());
  return { base, baseline };
}

const args = mode => [mode, "--snapshot", snapshotPath, "--preflight", preflightPath];
const execute = (base, mode = "--write") => run(args(mode), base, () => now);

test("writes once atomically, checks exactly, and never overwrites the current artifact", () => {
  const current = fixture();
  try {
    assert.equal(execute(current.base), PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT);
    const output = path.join(current.base, PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT);
    const bytes = fs.readFileSync(output, "utf8");
    const candidate = JSON.parse(bytes);
    for (const [name, value] of Object.entries(REVIEWED_PROJECT_ADOPTION_LIVE_BOOLEAN_VALUES))
      assert.equal(candidate.vars[name], value);
    const reverted = structuredClone(candidate);
    for (const name of Object.keys(REVIEWED_PROJECT_ADOPTION_LIVE_BOOLEAN_VALUES)) reverted.vars[name] = "false";
    assert.deepEqual(reverted, current.baseline);
    assert.equal(execute(current.base, "--check"), PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT);
    assert.equal(execute(current.base), PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT);
    assert.equal(fs.readFileSync(output, "utf8"), bytes);
  } finally { fs.rmSync(current.base, { recursive: true, force: true }); }
});

test("refuses stale or conflicting existing output without changing its bytes", () => {
  const current = fixture();
  try {
    const output = path.join(current.base, PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT);
    json(output, { stale: true });
    const before = fs.readFileSync(output, "utf8");
    assert.throws(() => execute(current.base), /stale or conflicting.*did not overwrite/);
    assert.throws(() => execute(current.base, "--check"), /stale or conflicting.*did not overwrite/);
    assert.equal(fs.readFileSync(output, "utf8"), before);
  } finally { fs.rmSync(current.base, { recursive: true, force: true }); }
});

test("requires fresh timestamped preflight evidence with an injected clock", () => {
  for (const [observedAt, expected] of [
    [new Date(now - PROJECT_ADOPTION_LIVE_PREFLIGHT_MAX_AGE_MS - 1).toISOString(), /stale/],
    [new Date(now + 30_001).toISOString(), /too far in the future/],
    ["2026-10-09T18:00:00Z", /canonical UTC millisecond/],
    [true, /canonical UTC millisecond/],
  ]) {
    const current = fixture();
    try {
      json(path.join(current.base, preflightPath), preflight(observedAt));
      assert.throws(() => execute(current.base), expected);
      assert.equal(fs.existsSync(path.join(current.base, PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT)), false);
    } finally { fs.rmSync(current.base, { recursive: true, force: true }); }
  }
});

test("rejects wrapper drift and delegates exact worker traffic checks to the pure helper", () => {
  for (const mutate of [
    value => { value.extra = true; },
    value => { value.schemaVersion = "1"; },
    value => { value.environment = "production"; },
    value => { value.activeVersionPreflight.workerName = "ledgetop-ops"; },
    value => { value.activeVersionPreflight.versions[0].percentage = "100"; },
    value => { value.activeVersionPreflight.versions.push({ versionId: "other", percentage: 0 }); },
  ]) {
    const current = fixture();
    try {
      const value = preflight();
      mutate(value);
      json(path.join(current.base, preflightPath), value);
      assert.throws(() => execute(current.base), /project-adoption-live-settings/);
    } finally { fs.rmSync(current.base, { recursive: true, force: true }); }
  }
});

test("requires ignored inputs, baseline, and fixed output beneath the repository", () => {
  const cases = [
    {
      ignore: ["apps/operations/wrangler.staging.*.json"],
      invoke: current => execute(current.base),
      expected: /live-settings snapshot must be ignored/,
    },
    {
      ignore: ["apps/operations/wrangler.staging.*.json", snapshotPath],
      invoke: current => execute(current.base),
      expected: /active-version preflight must be ignored/,
    },
    {
      ignore: [PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output, ".live-settings/"],
      invoke: current => execute(current.base),
      expected: /live-preserved output must be ignored/,
    },
    {
      ignore: [PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT, ".live-settings/"],
      invoke: current => execute(current.base),
      expected: /generic finalization candidate must be ignored/,
    },
  ];
  for (const currentCase of cases) {
    const current = fixture(currentCase.ignore);
    try { assert.throws(() => currentCase.invoke(current), currentCase.expected); }
    finally { fs.rmSync(current.base, { recursive: true, force: true }); }
  }

  const current = fixture();
  const outside = `${current.base}-outside.json`;
  try {
    json(outside, snapshot());
    assert.throws(() => run(["--write", "--snapshot", outside, "--preflight", preflightPath],
      current.base, () => now), /must remain below the workspace root/);
    assert.throws(() => run(["--write", "--snapshot", ".live-settings", "--preflight", preflightPath],
      current.base, () => now), /regular non-symlink file/);
  } finally {
    if (fs.existsSync(outside)) fs.rmSync(outside);
    fs.rmSync(current.base, { recursive: true, force: true });
  }
});

test("rejects stale generic candidates, malformed JSON, missing output checks, and unsupported arguments", () => {
  const current = fixture();
  try {
    assert.throws(() => execute(current.base, "--check"), /output is missing/);
    assert.throws(() => run(["--write", "--secret", "forbidden", "--snapshot", snapshotPath,
      "--preflight", preflightPath], current.base, () => now), /no secret or remote-operation arguments are accepted/);

    const baselineFile = path.join(current.base, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output);
    const baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
    baseline.vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED = "false";
    json(baselineFile, baseline);
    assert.throws(() => execute(current.base), /finalization baseline is not validated/);

    fs.writeFileSync(path.join(current.base, snapshotPath), "{not-json\n");
    assert.throws(() => execute(current.base), /must contain strict JSON/);
  } finally { fs.rmSync(current.base, { recursive: true, force: true }); }
});
