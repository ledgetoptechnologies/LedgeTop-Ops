import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import { PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES } from "./staging-project-alpha-api-v2-acceptance-profile.mjs";
import {
  buildProjectAlphaApiV2ViewerAcceptanceConfig,
  PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG,
  run,
  validateOperationsSecretNameInventory,
  validateProjectAlphaApiV2ViewerAcceptanceConfig,
  VIEWER_ACCEPTANCE_IDENTITY,
  VIEWER_ACCEPTANCE_SECRET_NAMES,
  VIEWER_ACCEPTANCE_VALUES,
} from "./staging-project-alpha-api-v2-viewer-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const values = Object.freeze({
  DELIVERY_STAGING_ACCESS_AUD: "a".repeat(64), OPERATIONS_STAGING_ACCESS_AUD: "b".repeat(64),
  PROJECT_ALPHA_OPS_SYNC_STAGING_ACCESS_AUD: "c".repeat(64), DEDICATED_CLIENT_PORTAL_STAGING_ACCESS_AUD: "d".repeat(64),
  STAGING_PROJECT_ALPHA_SOURCE_ID: "project-alpha:staging", STAGING_PROJECT_ALPHA_HTTPS_ORIGIN: "https://pa-staging.ledgetoptechnologies.com",
  CLIENT_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.client-staging", OPERATIONS_STAGING_RESTRICTED_MAPBOX_PUBLIC_TOKEN: "pk.operations-staging",
  MAPBOX_STAGING_ACCEPTANCE_DEFERRED: "false", STAGING_EMAIL_DOMAIN: "staging.example.test", STAGING_TRIAGE_EMAIL: "triage@staging.example.test",
  STAGING_ACCESS_GROUP_ID: "11111111-1111-4111-8111-111111111111", STAGING_ACCESS_GROUP_NAME: "LTDS staging operators",
});
const inventory = () => ({ names: [...VIEWER_ACCEPTANCE_SECRET_NAMES] });
function state() {
  return {
    source: renderConfigs(root, values).operations,
    production: JSON.parse(fs.readFileSync(path.join(root, PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.production), "utf8")),
    secretNames: inventory(),
  };
}

test("builds exactly the five API gates plus two Viewer gates and preserves the Viewer identity", () => {
  const { source, production, secretNames } = state();
  const candidate = buildProjectAlphaApiV2ViewerAcceptanceConfig(source, production, secretNames);
  for (const [name, expected] of Object.entries(VIEWER_ACCEPTANCE_VALUES)) assert.equal(candidate.vars[name], expected);
  for (const [name, expected] of Object.entries(VIEWER_ACCEPTANCE_IDENTITY)) assert.equal(candidate.vars[name], expected);
  assert.equal(candidate.vars.VIEWER_PUBLIC_SHARES_ENABLED, "false");
  assert.equal(candidate.vars.VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED, "false");
  assert.deepEqual(validateProjectAlphaApiV2ViewerAcceptanceConfig(source, candidate, production, secretNames), []);
});

test("rejects resource, extra flag, Viewer URL, and Viewer key-ID drift", () => {
  for (const mutate of [
    (candidate) => { candidate.d1_databases[0].database_id = "production-db"; },
    (candidate) => { candidate.vars.UNRELATED_FLAG = "true"; },
    (candidate) => { candidate.vars.VIEWER_BASE_URL = "https://viewer.example.test"; },
    (candidate) => { candidate.vars.VIEWER_SERVICE_KEY_ID = "unreviewed-key"; },
    (candidate) => { candidate.vars.VIEWER_EVENT_KEY_ID = "unreviewed-key"; },
    (candidate) => { candidate.vars.VIEWER_PUBLIC_SHARES_ENABLED = "true"; },
    (candidate) => { candidate.vars.VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED = "true"; },
  ]) {
    const { source, production, secretNames } = state();
    const candidate = buildProjectAlphaApiV2ViewerAcceptanceConfig(source, production, secretNames);
    mutate(candidate);
    assert(validateProjectAlphaApiV2ViewerAcceptanceConfig(source, candidate, production, secretNames)
      .some((error) => error.includes("drifted outside the composed seven-gate staging window")));
  }
});

test("rejects every missing member of the exact five-gate API window", () => {
  for (const flag of Object.keys(PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES)) {
    const { source, production, secretNames } = state();
    const candidate = buildProjectAlphaApiV2ViewerAcceptanceConfig(source, production, secretNames);
    candidate.vars[flag] = "false";
    const errors = validateProjectAlphaApiV2ViewerAcceptanceConfig(source, candidate, production, secretNames);
    assert(errors.some((error) => error.includes(`${flag}=true`)), flag);
  }
});

test("rejects activation in the default-off staging source without changing production", () => {
  const { source, production, secretNames } = state();
  const before = structuredClone(production);
  source.vars.VIEWER_INTEGRATION_ENABLED = "true";
  assert.throws(() => buildProjectAlphaApiV2ViewerAcceptanceConfig(source, production, secretNames), /VIEWER_INTEGRATION_ENABLED=false/);
  assert.deepEqual(production, before);
});

test("requires the exact names-only Operations secret inventory", () => {
  assert.deepEqual(validateOperationsSecretNameInventory(inventory()), []);
  assert.match(validateOperationsSecretNameInventory({ names: null })[0], /exactly match/);
  assert.match(validateOperationsSecretNameInventory({ names: [] })[0], /exactly match/);
  assert.match(validateOperationsSecretNameInventory({ names: ["VIEWER_SERVICE_HMAC_SECRET", "VIEWER_SERVICE_HMAC_SECRET"] })[0], /exactly match/);
  assert.match(validateOperationsSecretNameInventory({ names: [42] })[0], /exactly match/);
  assert.match(validateOperationsSecretNameInventory({ names: [...VIEWER_ACCEPTANCE_SECRET_NAMES, "VIEWER_EVENT_HMAC_SECRET"] })[0], /exactly match/);
  assert.match(validateOperationsSecretNameInventory({ names: [...VIEWER_ACCEPTANCE_SECRET_NAMES], values: {} })[0], /secret values are prohibited/);
});

test("CLI fails closed with bounded errors when either config input is missing", () => {
  for (const missing of [PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.source, PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.production]) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-api-v2-viewer-missing-"));
    try {
      const { source, production, secretNames } = state();
      for (const [relative, value] of [
        [PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.source, source],
        [PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.production, production],
        [PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.secretNames, secretNames],
      ]) {
        if (relative === missing) continue;
        const file = path.join(base, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
      }
      assert.throws(() => run(["--check"], base), (error) => error.message === `${missing} is missing; no candidate was generated`);
    } finally { fs.rmSync(base, { recursive: true, force: true }); }
  }
});

test("CLI malformed JSON errors contain only the expected relative path", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-api-v2-viewer-malformed-"));
  try {
    const { source, production } = state();
    for (const [relative, value] of [
      [PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.source, source],
      [PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.production, production],
    ]) {
      const file = path.join(base, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    }
    const secretFile = path.join(base, PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.secretNames);
    fs.mkdirSync(path.dirname(secretFile), { recursive: true });
    fs.writeFileSync(secretFile, '{"names":["DO_NOT_LEAK_SENTINEL"],');
    assert.throws(() => run(["--check"], base), (error) =>
      error.message === `${PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.secretNames} must contain strict JSON` &&
      !error.message.includes("DO_NOT_LEAK_SENTINEL"));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("writes and checks one ignored candidate, then refuses stale content", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-api-v2-viewer-window-"));
  try {
    const { source, production, secretNames } = state();
    for (const [relative, value] of [
      [PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.source, source],
      [PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.production, production],
      [PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.secretNames, secretNames],
    ]) {
      const file = path.join(base, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    }
    run(["--write"], base); run(["--check"], base);
    const output = path.join(base, PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.output);
    const stale = JSON.parse(fs.readFileSync(output, "utf8")); stale.vars.VIEWER_PROCESSING_ENABLED = "false";
    fs.writeFileSync(output, `${JSON.stringify(stale, null, 2)}\n`);
    assert.throws(() => run(["--write"], base), /invalid or stale/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
