import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import {
  buildProjectAlphaApiV2AcceptanceConfig,
  PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG,
  PROJECT_ALPHA_API_V2_ACCEPTANCE_PROFILE,
  PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES,
  run,
  validateProjectAlphaApiV2AcceptanceConfig,
} from "./staging-project-alpha-api-v2-acceptance-profile.mjs";

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
  const source = renderConfigs(root, values).operations;
  const production = JSON.parse(fs.readFileSync(path.join(root, PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.production), "utf8"));
  return { source, production };
}

test("builds the separate five-gate staging profile without changing the base config", () => {
  const { source, production } = pair();
  const candidate = buildProjectAlphaApiV2AcceptanceConfig(source, production);
  assert.equal(PROJECT_ALPHA_API_V2_ACCEPTANCE_PROFILE, "project-alpha-api-v2-acceptance");
  assert.deepEqual(Object.keys(PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES).sort(), [
    "PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED",
    "PROJECT_ALPHA_API_V2_SYNC_ENABLED",
    "PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED",
    "PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED",
    "PROJECT_ALPHA_PROJECT_BINDING_REVISION_REFRESH_ENABLED",
  ].sort());
  for (const [flag, expected] of Object.entries(PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES)) {
    assert.equal(source.vars[flag], "false", `base ${flag}`);
    assert.equal(production.vars[flag], "false", `production ${flag}`);
    assert.equal(candidate.vars[flag], expected, `acceptance ${flag}`);
  }
  const reverted = structuredClone(candidate);
  for (const flag of Object.keys(PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES)) reverted.vars[flag] = source.vars[flag];
  assert.deepEqual(reverted, source);
  assert.deepEqual(validateProjectAlphaApiV2AcceptanceConfig(source, candidate, production), []);
});

test("rejects active source or production flags and unrelated candidate drift", () => {
  const { source, production } = pair();
  const candidate = buildProjectAlphaApiV2AcceptanceConfig(source, production);
  const activeSource = structuredClone(source);
  activeSource.vars.PROJECT_ALPHA_API_V2_SYNC_ENABLED = "true";
  assert.throws(() => buildProjectAlphaApiV2AcceptanceConfig(activeSource, production), /base staging config must set PROJECT_ALPHA_API_V2_SYNC_ENABLED=false/);
  const activeProduction = structuredClone(production);
  activeProduction.vars.PROJECT_ALPHA_PROJECT_BINDING_REVISION_REFRESH_ENABLED = "true";
  assert.throws(() => buildProjectAlphaApiV2AcceptanceConfig(source, activeProduction), /production config must keep PROJECT_ALPHA_PROJECT_BINDING_REVISION_REFRESH_ENABLED=false/);
  candidate.vars.PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED = "true";
  assert(validateProjectAlphaApiV2AcceptanceConfig(source, candidate, production)
    .some(error => error.includes("drifted outside the five-gate staging window")));
});

test("writes one ignored candidate and refuses to overwrite stale content", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-project-alpha-api-v2-window-"));
  try {
    const { source, production } = pair();
    const sourcePath = path.join(base, PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.source);
    const productionPath = path.join(base, PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.production);
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(productionPath), { recursive: true });
    fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
    fs.writeFileSync(productionPath, `${JSON.stringify(production, null, 2)}\n`);
    const output = path.join(base, PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.output);
    run(["--write"], base);
    run(["--check"], base);
    assert.equal(fs.existsSync(output), true);
    const stale = JSON.parse(fs.readFileSync(output, "utf8"));
    stale.vars.PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED = "false";
    fs.writeFileSync(output, `${JSON.stringify(stale, null, 2)}\n`);
    const before = fs.readFileSync(output, "utf8");
    assert.throws(() => run(["--write"], base), /invalid or stale/);
    assert.equal(fs.readFileSync(output, "utf8"), before);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
