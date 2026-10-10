import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderConfigs } from "./staging-config-scaffold.mjs";
import {
  buildProjectAlphaApiV2AcceptanceConfig,
  PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES,
} from "./staging-project-alpha-api-v2-acceptance-profile.mjs";
import {
  buildProjectAlphaApiV2ViewerAcceptanceConfig,
  VIEWER_ACCEPTANCE_IDENTITY,
  VIEWER_ACCEPTANCE_SECRET_NAMES,
  VIEWER_ACCEPTANCE_VALUES,
} from "./staging-project-alpha-api-v2-viewer-acceptance-profile.mjs";
import {
  buildProjectAdoptionFinalizationAcceptanceConfig,
  PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG,
  PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_VALUES,
  run,
  validateProjectAdoptionFinalizationAcceptanceConfig,
} from "./staging-project-alpha-project-adoption-finalization-acceptance-profile.mjs";

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

function state() {
  return {
    source: renderConfigs(root, values).operations,
    production: JSON.parse(fs.readFileSync(path.join(root, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.production), "utf8")),
  };
}

test("layers only Project adoption finalization on the exact five-gate API-v2 profile", () => {
  const { source, production } = state();
  const composed = buildProjectAlphaApiV2AcceptanceConfig(source, production);
  const candidate = buildProjectAdoptionFinalizationAcceptanceConfig(source, production);
  assert.equal(candidate.vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED, "true");
  const reverted = structuredClone(candidate);
  reverted.vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED = "false";
  assert.deepEqual(reverted, composed);
  assert.deepEqual(validateProjectAdoptionFinalizationAcceptanceConfig(source, candidate, production), []);
});

test("preserves baseline Viewer identity, gates, resources, and routes without a secret-inventory dependency", () => {
  const { source, production } = state();
  const candidate = buildProjectAdoptionFinalizationAcceptanceConfig(source, production);
  for (const name of Object.keys({ ...VIEWER_ACCEPTANCE_VALUES, ...VIEWER_ACCEPTANCE_IDENTITY }))
    assert.equal(candidate.vars[name], source.vars[name], name);
  assert.deepEqual(candidate.routes, source.routes);
  assert.deepEqual(candidate.assets, source.assets);
  assert.deepEqual(candidate.d1_databases, source.d1_databases);
  assert.equal(Object.hasOwn(PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG, "secretNames"), false);
  assert.equal(JSON.stringify(candidate).includes("VIEWER_SERVICE_HMAC_SECRET"), false);
});

test("does not change the existing API-v2 or Viewer profile contracts", () => {
  const { source, production } = state();
  const sourceBefore = structuredClone(source), productionBefore = structuredClone(production);
  const api = buildProjectAlphaApiV2AcceptanceConfig(source, production);
  const viewer = buildProjectAlphaApiV2ViewerAcceptanceConfig(source, production,
    { names: [...VIEWER_ACCEPTANCE_SECRET_NAMES] });
  assert.deepEqual(source, sourceBefore);
  assert.deepEqual(production, productionBefore);
  for (const [flag, value] of Object.entries(PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES)) {
    assert.equal(api.vars[flag], value);
    assert.equal(viewer.vars[flag], value);
  }
  assert.equal(api.vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED, "false");
  assert.equal(viewer.vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED, "false");
  for (const [name, value] of Object.entries({ ...VIEWER_ACCEPTANCE_VALUES, ...VIEWER_ACCEPTANCE_IDENTITY }))
    assert.equal(viewer.vars[name], value);
});

test("requires explicit string-false staging and production baselines", () => {
  for (const side of ["source", "production"]) for (const value of [undefined, "true", true, false, null, ""]) {
    const current = state();
    if (value === undefined) delete current[side].vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED;
    else current[side].vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED = value;
    assert.throws(() => buildProjectAdoptionFinalizationAcceptanceConfig(current.source, current.production),
    new RegExp(`${side === "source" ? "base staging" : "production"} config must set PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED=false`));
  }
});

test("rejects a missing finalization gate and every unrelated candidate drift", () => {
  for (const mutate of [
    candidate => { candidate.vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED = "false"; },
    candidate => { candidate.vars.PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED = "true"; },
    candidate => { candidate.vars.VIEWER_BASE_URL = "https://wrong.example.test"; },
    candidate => { candidate.routes[0].pattern = "wrong.example.test"; },
    candidate => { candidate.d1_databases[0].database_id = "production-db"; },
  ]) {
    const { source, production } = state();
    const candidate = buildProjectAdoptionFinalizationAcceptanceConfig(source, production);
    mutate(candidate);
    const errors = validateProjectAdoptionFinalizationAcceptanceConfig(source, candidate, production);
    assert(errors.some(error => error.includes("drifted outside") || error.includes("FINALIZATION_ENABLED=true")), errors.join(" | "));
  }
});

test("requires all five API-v2 gates to remain exact string-false in both baselines", () => {
  for (const flag of Object.keys(PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES)) for (const side of ["source", "production"]) {
    const current = state();
    current[side].vars[flag] = "true";
    assert.throws(() => buildProjectAdoptionFinalizationAcceptanceConfig(current.source, current.production),
      new RegExp(flag));
  }
});

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-project-adoption-finalization-"));
  spawnSync("git", ["init", "--quiet"], { cwd: base, windowsHide: true });
  fs.writeFileSync(path.join(base, ".gitignore"), "apps/*/wrangler.staging.*.json\n.backups/\n");
  const current = state();
  for (const [relative, value] of [
    [PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.source, current.source],
    [PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.production, current.production],
  ]) {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  }
  return base;
}

test("writes and checks one ignored candidate without overwriting stale content", () => {
  const base = fixture();
  try {
    run(["--write"], base);
    run(["--check"], base);
    const output = path.join(base, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output);
    const stale = JSON.parse(fs.readFileSync(output, "utf8"));
    stale.vars.PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED = "false";
    fs.writeFileSync(output, `${JSON.stringify(stale, null, 2)}\n`);
    const before = fs.readFileSync(output, "utf8");
    assert.throws(() => run(["--write"], base), /invalid or stale/);
    assert.equal(fs.readFileSync(output, "utf8"), before);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("refuses a nonignored output", () => {
  const base = fixture();
  try {
    fs.writeFileSync(path.join(base, ".gitignore"), ".backups/\n");
    assert.throws(() => run(["--write"], base), /must be ignored/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("exports exactly the one finalization activation delta", () => {
  assert.deepEqual(PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_VALUES, {
    PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED: "true",
  });
});
