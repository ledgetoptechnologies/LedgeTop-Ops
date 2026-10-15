import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import { PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES } from "./staging-project-alpha-api-v2-acceptance-profile.mjs";
import { VIEWER_ACCEPTANCE_SECRET_NAMES, buildProjectAlphaApiV2ViewerAcceptanceConfig } from "./staging-project-alpha-api-v2-viewer-acceptance-profile.mjs";
import {
  buildDirectoryAdoptionAcceptanceConfig, DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG,
  DIRECTORY_ADOPTION_ACCEPTANCE_VALUES, run, validateDirectoryAdoptionAcceptanceConfig,
} from "./staging-project-alpha-directory-adoption-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const values = Object.freeze({ DELIVERY_STAGING_ACCESS_AUD: "a".repeat(64), OPERATIONS_STAGING_ACCESS_AUD: "b".repeat(64),
  PROJECT_ALPHA_OPS_SYNC_STAGING_ACCESS_AUD: "c".repeat(64), DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD: "d".repeat(64),
  STAGING_PROJECT_ALPHA_SOURCE_ID: "project-alpha:staging", STAGING_PROJECT_ALPHA_HTTPS_ORIGIN: "https://pa-staging.ledgetoptechnologies.com",
  CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.client-staging", OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.operations-staging",
  MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false", STAGING_EMAIL_DOMAIN: "staging.example.test", STAGING_TRIAGE_EMAIL: "triage@staging.example.test",
  STAGING_ACCESS_GROUP_ID: "11111111-1111-4111-8111-111111111111", STAGING_ACCESS_GROUP_NAME: "LTDS staging operators" });
function state() {
  const source = renderConfigs(root, values).operations;
  const production = JSON.parse(fs.readFileSync(path.join(root, DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.production), "utf8"));
  return { source, production, secretNames: { names: [...VIEWER_ACCEPTANCE_SECRET_NAMES] } };
}

test("layers exactly two Directory gates on the composed API plus Viewer profile", () => {
  const { source, production, secretNames } = state();
  const composed = buildProjectAlphaApiV2ViewerAcceptanceConfig(source, production, secretNames);
  const candidate = buildDirectoryAdoptionAcceptanceConfig(source, production, secretNames);
  for (const [flag, value] of Object.entries(DIRECTORY_ADOPTION_ACCEPTANCE_VALUES)) assert.equal(candidate.vars[flag], value);
  const reverted = structuredClone(candidate);
  for (const flag of Object.keys(DIRECTORY_ADOPTION_ACCEPTANCE_VALUES)) reverted.vars[flag] = "false";
  assert.deepEqual(reverted, composed);
  assert.deepEqual(validateDirectoryAdoptionAcceptanceConfig(source, candidate, production, secretNames), []);
});

test("rejects either missing Directory gate", () => {
  for (const flag of Object.keys(DIRECTORY_ADOPTION_ACCEPTANCE_VALUES)) {
    const { source, production, secretNames } = state();
    const candidate = buildDirectoryAdoptionAcceptanceConfig(source, production, secretNames); candidate.vars[flag] = "false";
    assert(validateDirectoryAdoptionAcceptanceConfig(source, candidate, production, secretNames).some(error => error.includes(`${flag}=true`)));
  }
});

test("rejects extra authority or portal gates and source identity or resource drift", () => {
  for (const mutate of [
    candidate => { candidate.vars.PROJECT_ALPHA_PROJECT_V2_ACTIVATION_ENABLED = "true"; },
    candidate => { candidate.vars.CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED = "true"; },
    candidate => { candidate.vars.STAGING_PROJECT_ALPHA_SOURCE_ID = "unreviewed:source"; },
    candidate => { candidate.d1_databases[0].database_id = "production-db"; },
  ]) {
    const { source, production, secretNames } = state(); const candidate = buildDirectoryAdoptionAcceptanceConfig(source, production, secretNames);
    mutate(candidate);
    assert(validateDirectoryAdoptionAcceptanceConfig(source, candidate, production, secretNames).some(error => error.includes("drifted outside")));
  }
});

test("requires explicit source false, explicit production exact false, and omitted-or-string-false production local profile", () => {
  for (const flag of Object.keys(DIRECTORY_ADOPTION_ACCEPTANCE_VALUES)) {
    let current = state(); current.source.vars[flag] = "true";
    assert.throws(() => buildDirectoryAdoptionAcceptanceConfig(current.source, current.production, current.secretNames), new RegExp(`${flag}=false`));
  }
  let current = state(); current.production.vars.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED = "true";
  assert.throws(() => buildDirectoryAdoptionAcceptanceConfig(current.source, current.production, current.secretNames), /EXACT_ADOPTION_ENABLED=false/);
  current = state();
  assert.doesNotThrow(() => buildDirectoryAdoptionAcceptanceConfig(current.source, current.production, current.secretNames));
  current.production.vars.PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED = "false";
  assert.doesNotThrow(() => buildDirectoryAdoptionAcceptanceConfig(current.source, current.production, current.secretNames));
  for (const value of ["true", null, "", false]) {
    current = state(); current.production.vars.PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED = value;
    assert.throws(() => buildDirectoryAdoptionAcceptanceConfig(current.source, current.production, current.secretNames), /omit PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED or set it to the string false/);
  }
});

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-directory-adoption-"));
  spawnSync("git", ["init", "--quiet"], { cwd: base, windowsHide: true });
  fs.writeFileSync(path.join(base, ".gitignore"), "apps/*/wrangler.staging.*.json\n.backups/\n");
  const current = state();
  for (const [relative, value] of [[DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.source, current.source],
    [DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.production, current.production], [DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.secretNames, current.secretNames]]) {
    const file = path.join(base, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }
  return base;
}

test("writes, checks, and refuses stale existing candidates without overwrite", () => {
  const base = fixture();
  try {
    run(["--write"], base); run(["--check"], base);
    const output = path.join(base, DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.output);
    const stale = JSON.parse(fs.readFileSync(output, "utf8")); stale.vars.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED = "false";
    fs.writeFileSync(output, `${JSON.stringify(stale, null, 2)}\n`); const before = fs.readFileSync(output, "utf8");
    assert.throws(() => run(["--write"], base), /invalid or stale/); assert.equal(fs.readFileSync(output, "utf8"), before);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("refuses a nonignored output and preserves all composed API gates", () => {
  const base = fixture();
  try {
    fs.writeFileSync(path.join(base, ".gitignore"), ".backups/\n");
    assert.throws(() => run(["--write"], base), /must be ignored/);
    const { source, production, secretNames } = state(); const candidate = buildDirectoryAdoptionAcceptanceConfig(source, production, secretNames);
    for (const flag of Object.keys(PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES)) assert.equal(candidate.vars[flag], "true");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
