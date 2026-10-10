import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderConfigs } from "./staging-config-scaffold.mjs";
import {
  buildDirectoryWritesAcceptanceConfig,
  buildDirectoryProfileWriteAcceptanceConfig,
  DIRECTORY_WRITES_ACCEPTANCE_CONFIG,
  DIRECTORY_WRITES_ACCEPTANCE_VALUES,
  run,
  validateDirectoryWritesAcceptanceConfig,
} from "./staging-directory-writes-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

function pair() {
  return {
    source: renderConfigs(root, values).operations,
    production: JSON.parse(fs.readFileSync(path.join(root, DIRECTORY_WRITES_ACCEPTANCE_CONFIG.production), "utf8")),
  };
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-directory-writes-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { source, production } = pair();
  const sourcePath = path.join(base, DIRECTORY_WRITES_ACCEPTANCE_CONFIG.source);
  const productionPath = path.join(base, DIRECTORY_WRITES_ACCEPTANCE_CONFIG.production);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  fs.writeFileSync(productionPath, `${JSON.stringify(production, null, 2)}\n`);
  return { base, source, production };
}

test("interactive profile writes leave the global drain off and preserve both baselines", () => {
  const { source, production } = pair();
  const before = structuredClone({ source, production });
  const candidate = buildDirectoryProfileWriteAcceptanceConfig(source, production);
  const expected = structuredClone(source);
  expected.vars.NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED = "true";
  assert.deepEqual(candidate, expected);
  assert.equal(candidate.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED, "false");
  assert.deepEqual({ source, production }, before);
  for (const owner of ["source", "production"]) {
    for (const flag of Object.keys(DIRECTORY_WRITES_ACCEPTANCE_VALUES)) {
      const unsafe = pair();
      unsafe[owner].vars[flag] = "true";
      assert.throws(() => buildDirectoryProfileWriteAcceptanceConfig(unsafe.source, unsafe.production), /false|omit/);
    }
  }
});

test("enables only the two exact native directory write/outbox gates on validated staging clone", () => {
  const { source, production } = pair();
  const before = structuredClone({ source, production });
  const candidate = buildDirectoryWritesAcceptanceConfig(source, production);
  assert.deepEqual(DIRECTORY_WRITES_ACCEPTANCE_VALUES, {
    NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED: "true",
    NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: "true",
  });
  assert.deepEqual(validateDirectoryWritesAcceptanceConfig(source, candidate, production), []);
  assert.deepEqual({ source, production }, before);
  const restored = structuredClone(candidate);
  for (const flag of Object.keys(DIRECTORY_WRITES_ACCEPTANCE_VALUES)) restored.vars[flag] = "false";
  assert.deepEqual(restored, source);
});

test("rejects unsafe base defaults, production enablement, and any unrelated candidate delta", () => {
  for (const mutate of [
    state => { delete state.source.vars.NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED; },
    state => { state.source.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED = "true"; },
    state => { state.production.vars.NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED = "true"; },
  ]) {
    const state = pair(); mutate(state);
    assert.throws(() => buildDirectoryWritesAcceptanceConfig(state.source, state.production), /false|omit/);
  }
  const { source, production } = pair();
  const candidate = buildDirectoryWritesAcceptanceConfig(source, production);
  candidate.vars.PROJECT_ALPHA_API_V2_SYNC_ENABLED = "true";
  assert(validateDirectoryWritesAcceptanceConfig(source, candidate, production)
    .some(error => error.includes("outside the exact two-gate staging window")));
});

test("writes and checks only the fixed ignored staging output without overwriting", t => {
  const { base } = fixture(t);
  const output = path.join(base, DIRECTORY_WRITES_ACCEPTANCE_CONFIG.output);
  assert.throws(() => run(["--check"], base), /missing; generate with --write/);
  run(["--write"], base);
  const bytes = fs.readFileSync(output, "utf8");
  run(["--write"], base);
  assert.equal(fs.readFileSync(output, "utf8"), bytes);
  run(["--check"], base);
});

test("rejects stale output and unsupported command modes", t => {
  const { base } = fixture(t);
  run(["--write"], base);
  const output = path.join(base, DIRECTORY_WRITES_ACCEPTANCE_CONFIG.output);
  const stale = JSON.parse(fs.readFileSync(output, "utf8"));
  stale.vars.PROJECT_ALPHA_API_V2_SYNC_ENABLED = "true";
  fs.writeFileSync(output, `${JSON.stringify(stale, null, 2)}\n`);
  assert.throws(() => run(["--check"], base), /outside the exact two-gate staging window/);
  assert.throws(() => run(["--deploy"], base), /usage:/);
});
