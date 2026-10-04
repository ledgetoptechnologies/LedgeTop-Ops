import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderConfigs } from "./staging-config-scaffold.mjs";
import {
  buildOpsProjectV2JoinedAcceptanceConfig,
  OPS_PROJECT_V2_JOINED_ACCEPTANCE_ACTIVATION_VALUES,
  OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG,
  OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG,
  OPS_PROJECT_V2_JOINED_ACCEPTANCE_PROFILE_NAME,
  run,
  validateOpsProjectV2JoinedAcceptanceConfig,
} from "./staging-ops-project-v2-joined-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const clone = value => structuredClone(value);
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
  const production = JSON.parse(fs.readFileSync(
    path.join(root, OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.production), "utf8",
  ));
  return { source, production };
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-ops-project-v2-joined-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const { source, production } = pair();
  const sourcePath = path.join(base, OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.source);
  const productionPath = path.join(base, OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.production);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  fs.writeFileSync(productionPath, `${JSON.stringify(production, null, 2)}\n`);
  return { base, source, production, sourcePath, productionPath };
}

test("builds only the isolated joined Project-v2 activation gate", () => {
  const { source, production } = pair();
  const before = clone({ source, production });
  const candidate = buildOpsProjectV2JoinedAcceptanceConfig(source, production);

  assert.equal(OPS_PROJECT_V2_JOINED_ACCEPTANCE_PROFILE_NAME,
    "ops-project-v2-joined-acceptance");
  assert.equal(OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG,
    "PROJECT_ALPHA_PROJECT_V2_ACTIVATION_ENABLED");
  assert.deepEqual(OPS_PROJECT_V2_JOINED_ACCEPTANCE_ACTIVATION_VALUES, {
    PROJECT_ALPHA_PROJECT_V2_ACTIVATION_ENABLED: "true",
  });
  assert.equal(source.vars[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG], "false");
  assert.equal(production.vars[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG], "false");
  assert.equal(candidate.vars[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG], "true");
  assert.deepEqual(validateOpsProjectV2JoinedAcceptanceConfig(
    source, candidate, production,
  ), []);
  assert.deepEqual({ source, production }, before);

  const restored = clone(candidate);
  restored.vars[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG] =
    source.vars[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG];
  assert.deepEqual(restored, source);
});

test("rejects a wrong environment and production identifiers, routes, resources, or bindings", () => {
  const mutations = [
    state => { state.source.vars.ENVIRONMENT = "production"; },
    state => { state.source.name = state.production.name; },
    state => { state.source.routes = clone(state.production.routes); },
    state => {
      state.source.d1_databases.find(row => row.binding === "OPS_DB").database_id =
        state.production.d1_databases.find(row => row.binding === "OPS_DB").database_id;
    },
    state => {
      state.source.r2_buckets.find(row => row.binding === "DATA_BUCKET").bucket_name =
        state.production.r2_buckets.find(row => row.binding === "DATA_BUCKET").bucket_name;
    },
    state => {
      state.source.services.find(row => row.binding === "CLIENT_AUTHORITY_WORKSPACE_BINDING").service =
        state.production.services.find(row => row.binding === "CLIENT_AUTHORITY_WORKSPACE_BINDING").service;
    },
  ];
  for (const mutate of mutations) {
    const state = pair();
    mutate(state);
    assert.throws(() => buildOpsProjectV2JoinedAcceptanceConfig(
      state.source, state.production,
    ), /staging|production|approved staging inventory|reuses/);
  }
});

test("rejects absent or default-on staging and production activation flags", () => {
  const mutations = [
    state => { delete state.source.vars[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG]; },
    state => { state.source.vars[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG] = "true"; },
    state => { delete state.production.vars[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG]; },
    state => { state.production.vars[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG] = "true"; },
  ];
  for (const mutate of mutations) {
    const state = pair();
    mutate(state);
    assert.throws(() => buildOpsProjectV2JoinedAcceptanceConfig(
      state.source, state.production,
    ), /PROJECT_ALPHA_PROJECT_V2_ACTIVATION_ENABLED=false/);
  }
});

test("rejects another gate, resource drift, or a disabled joined candidate", () => {
  const mutations = [
    candidate => { candidate.vars.PROJECT_ALPHA_API_V2_SYNC_ENABLED = "true"; },
    candidate => { candidate.vars.PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED = "true"; },
    candidate => { candidate.routes = []; },
    candidate => { candidate.d1_databases[0].database_id = "production-db"; },
    candidate => { candidate.vars[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG] = "false"; },
  ];
  for (const mutate of mutations) {
    const { source, production } = pair();
    const candidate = buildOpsProjectV2JoinedAcceptanceConfig(source, production);
    mutate(candidate);
    const errors = validateOpsProjectV2JoinedAcceptanceConfig(
      source, candidate, production,
    );
    assert(errors.some(error => error.includes("outside the isolated one-gate staging window")),
      errors.join(" | "));
  }
});

test("rejects non-object source, production, and candidate inputs", () => {
  const { source, production } = pair();
  assert.throws(() => buildOpsProjectV2JoinedAcceptanceConfig(null, production),
    /default staging source must be a JSON object/);
  assert.throws(() => buildOpsProjectV2JoinedAcceptanceConfig(source, []),
    /production baseline must be a JSON object/);
  for (const candidate of [null, [], "candidate"]) {
    const errors = validateOpsProjectV2JoinedAcceptanceConfig(source, candidate, production);
    assert(errors.some(error => error.includes("candidate must be a JSON object")));
  }
});

test("writes and checks the fixed ignored output without overwriting current content", t => {
  const { base, sourcePath, productionPath } = fixture(t);
  const sourceBytes = fs.readFileSync(sourcePath, "utf8");
  const productionBytes = fs.readFileSync(productionPath, "utf8");
  const output = path.join(base, OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.output);

  assert.throws(() => run(["--check"], base), /missing; generate with --write/);
  assert.equal(run(["--write"], base), OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.output);
  const candidateBytes = fs.readFileSync(output, "utf8");
  assert.equal(run(["--write"], base), OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.output);
  assert.equal(fs.readFileSync(output, "utf8"), candidateBytes);
  assert.equal(run(["--check"], base), OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.output);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceBytes);
  assert.equal(fs.readFileSync(productionPath, "utf8"), productionBytes);
});

test("refuses a stale output without overwriting it", t => {
  const { base } = fixture(t);
  run(["--write"], base);
  const output = path.join(base, OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.output);
  const stale = JSON.parse(fs.readFileSync(output, "utf8"));
  stale.vars.PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED = "true";
  fs.writeFileSync(output, `${JSON.stringify(stale, null, 2)}\n`);
  const before = fs.readFileSync(output, "utf8");

  assert.throws(() => run(["--write"], base), /invalid or stale/);
  assert.throws(() => run(["--check"], base), /invalid or stale/);
  assert.equal(fs.readFileSync(output, "utf8"), before);
});

test("CLI modes reject unsupported arguments and missing baseline inputs", t => {
  assert.throws(() => run([], root), /usage:/);
  assert.throws(() => run(["--deploy"], root), /usage:/);
  assert.throws(() => run(["--write", "--check"], root), /usage:/);

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ltds-ops-project-v2-joined-missing-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  assert.throws(() => run(["--write"], base), /wrangler\.staging\.json is missing/);

  const sourcePath = path.join(base, OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.source);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, `${JSON.stringify(pair().source, null, 2)}\n`);
  assert.throws(() => run(["--write"], base), /production default-off baseline is required/);
});
