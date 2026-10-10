import assert from "node:assert/strict";
import test from "node:test";
import { buildRelationshipRecoveryReleaseConfig, RELATIONSHIP_RECOVERY_RELEASE_TARGET as target } from "./staging-relationship-recovery-release-config.mjs";

const recovery = "PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED";
const fiveLiveDrifts = {
  PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED: "true",
  PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED: "true",
  NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED: "true",
  OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED: "true",
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED: "true",
};
const baseline = () => ({ account_id: target.accountId, name: target.workerName, compatibility_date: "2026-07-22",
  vars: { ENVIRONMENT: "staging", NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: "false",
    ...Object.fromEntries(Object.keys(fiveLiveDrifts).map(name => [name, "false"])) },
  assets: { binding: "ASSETS", run_worker_first: ["/api/*"] }, containers: [{ name: "thumbnail", max_instances: 1 }],
  d1_databases: [{ binding: "OPS_DB", database_id: "staging-db" }], services: [{ binding: "CLIENT", service: "clients-staging" }],
  observability: { enabled: true }, compatibility_flags: ["nodejs_compat"] });
const bindings = () => [
  { name: "ENVIRONMENT", type: "plain_text", text: "staging" },
  { name: "NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED", type: "plain_text", text: "false" },
  ...Object.entries(fiveLiveDrifts).map(([name, text]) => ({ name, type: "plain_text", text })),
  { name: "UNKNOWN_LIVE_STAGING_VAR", type: "plain_text", text: "preserve-me" },
  { name: "OPS_DB", type: "d1_namespace", id: "staging-db" },
  { name: "PRIVATE_KEY", type: "secret_text" },
];
const snapshot = () => ({ version: { id: "dbe5d1b6", resources: { bindings: bindings(),
  script_runtime: { compatibility_date: "2026-07-22", compatibility_flags: ["nodejs_compat"] },
  script: { etag: "reviewed-script" } } }, deployment: { deployments: [{ id: "deployment-1",
    versions: [{ version_id: "dbe5d1b6", percentage: 100 }] }] } });

test("preserves the complete live plain map, all five live drifts, unknown vars, and baseline non-vars", () => {
  const before = baseline(), nonVars = structuredClone({ ...before, vars: undefined });
  const result = buildRelationshipRecoveryReleaseConfig(before, snapshot(), target);
  assert.deepEqual({ ...result.config, vars: undefined }, nonVars);
  assert.deepEqual(Object.fromEntries(Object.keys(fiveLiveDrifts).map(name => [name, result.config.vars[name]])), fiveLiveDrifts);
  assert.equal(result.config.vars.UNKNOWN_LIVE_STAGING_VAR, "preserve-me");
  assert.equal(result.config.vars[recovery], "false");
  assert.equal(result.config.vars.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED, "false");
  assert.deepEqual(result.expectedScriptRuntime, snapshot().version.resources.script_runtime);
  assert.deepEqual(result.expectedScript, snapshot().version.resources.script);
  assert.deepEqual(result.summary.changedVariableNames, [...Object.keys(fiveLiveDrifts), "UNKNOWN_LIVE_STAGING_VAR", recovery].sort());
  assert(!JSON.stringify(result.summary).includes("preserve-me"));
  assert(!result.expectedProviderBindings.some(binding => binding.name === "PRIVATE_KEY" && ("text" in binding || "value" in binding)));
});

test("adds only the disabled recovery provider binding and otherwise preserves every binding", () => {
  const source = snapshot(), result = buildRelationshipRecoveryReleaseConfig(baseline(), source, target);
  assert.deepEqual(result.expectedProviderBindings.slice(0, -1), source.version.resources.bindings);
  assert.deepEqual(result.expectedProviderBindings.at(-1), { name: recovery, type: "plain_text", text: "false" });
});

test("selects the first current deployment while accepting older deployment history", () => {
  const source = snapshot();
  source.deployment.deployments.push(
    { id: "deployment-previous", versions: [{ version_id: "previous-version", percentage: 100 }] },
    { id: "deployment-older-split", versions: [
      { version_id: "older-a", percentage: 60 },
      { version_id: "older-b", percentage: 40 },
    ] },
  );
  const result = buildRelationshipRecoveryReleaseConfig(baseline(), source, target);
  assert.equal(result.sourceVersionId, "dbe5d1b6");
});

test("fails closed on targets, deployment drift, active gates, duplicates, secrets, and malformed types", () => {
  const cases = [
    ["account", baseline(), snapshot(), { ...target, accountId: "production" }],
    ["worker", { ...baseline(), name: "ledgetop-ops" }, snapshot(), target],
    ["environment", baseline(), (() => { const s=snapshot();s.version.resources.bindings[0].text="production";return s; })(), target],
    ["percentage", baseline(), (() => { const s=snapshot();s.deployment.deployments[0].versions[0].percentage=99;return s; })(), target],
    ["two versions", baseline(), (() => { const s=snapshot();s.deployment.deployments[0].versions.push({version_id:"other",percentage:0});return s; })(), target],
    ["no current deployment", baseline(), (() => { const s=snapshot();s.deployment.deployments=[];return s; })(), target],
    ["drain", baseline(), (() => { const s=snapshot();s.version.resources.bindings[1].text="true";return s; })(), target],
    ["recovery", baseline(), (() => { const s=snapshot();s.version.resources.bindings.push({name:recovery,type:"plain_text",text:"true"});return s; })(), target],
    ["duplicate", baseline(), (() => { const s=snapshot();s.version.resources.bindings.push({...s.version.resources.bindings[0]});return s; })(), target],
    ["secret value", baseline(), (() => { const s=snapshot();s.version.resources.bindings.at(-1).text="never";return s; })(), target],
    ["binding type", baseline(), (() => { const s=snapshot();s.version.resources.bindings[0].type=7;return s; })(), target],
  ];
  for (const [label, config, provider, selected] of cases) assert.throws(
    () => buildRelationshipRecoveryReleaseConfig(config, provider, selected), undefined, label);
});

test("never accepts a production baseline", () => {
  const production = baseline(); production.name = "ledgetop-ops"; production.vars.ENVIRONMENT = "production";
  assert.throws(() => buildRelationshipRecoveryReleaseConfig(production, snapshot(), target), /exact staging baseline/);
});
