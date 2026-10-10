import { isDeepStrictEqual as same } from "node:util";

const ACCOUNT_ID = "846c924bf17bf4f3dd15c97a4c5d1d51";
const WORKER_NAME = "ledgetop-ops-staging";
const RECOVERY_FLAG = "PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED";
const DRAIN_FLAG = "NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED";

const fail = message => { throw new Error(`staging-relationship-recovery-release-config: ${message}`); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const clone = value => structuredClone(value);

export const RELATIONSHIP_RECOVERY_RELEASE_TARGET = Object.freeze({
  accountId: ACCOUNT_ID, workerName: WORKER_NAME, environment: "staging",
});

export function buildRelationshipRecoveryReleaseConfig(baseline, snapshot, target) {
  if (!plain(baseline) || !plain(snapshot) || !plain(target)
    || !same(target, RELATIONSHIP_RECOVERY_RELEASE_TARGET)) fail("exact staging target required");
  if (baseline.account_id !== ACCOUNT_ID || baseline.name !== WORKER_NAME || !plain(baseline.vars)
    || baseline.vars.ENVIRONMENT !== "staging") fail("exact staging baseline required");
  if (!plain(snapshot.version) || typeof snapshot.version.id !== "string" || !snapshot.version.id
    || !plain(snapshot.version.resources) || !Array.isArray(snapshot.version.resources.bindings)
    || !plain(snapshot.version.resources.script_runtime) || !plain(snapshot.version.resources.script)) {
    fail("complete provider version snapshot required");
  }
  if (!plain(snapshot.deployment) || !Array.isArray(snapshot.deployment.deployments)
    || snapshot.deployment.deployments.length < 1) fail("exact provider deployment snapshot required");
  const runtime = snapshot.version.resources.script_runtime;
  if (baseline.compatibility_date !== runtime.compatibility_date
    || !same(baseline.compatibility_flags ?? [], runtime.compatibility_flags ?? [])) {
    fail("baseline runtime differs from live runtime; explicit review required");
  }
  const deployment = snapshot.deployment.deployments[0];
  if (!plain(deployment) || !Array.isArray(deployment.versions) || deployment.versions.length !== 1
    || !plain(deployment.versions[0]) || deployment.versions[0].version_id !== snapshot.version.id
    || deployment.versions[0].percentage !== 100) fail("deployment must be exactly the reviewed version at 100 percent");

  const bindings = snapshot.version.resources.bindings;
  const names = new Set();
  const liveVars = {};
  for (const binding of bindings) {
    if (!plain(binding) || typeof binding.name !== "string" || !binding.name
      || typeof binding.type !== "string" || !binding.type) fail("binding shape required");
    if (names.has(binding.name)) fail(`duplicate binding ${binding.name}`);
    names.add(binding.name);
    if (binding.type === "plain_text") {
      if (typeof binding.text !== "string") fail(`plain_text binding ${binding.name} requires text`);
      liveVars[binding.name] = binding.text;
    } else if (binding.type === "secret_text") {
      if (Object.hasOwn(binding, "text") || Object.hasOwn(binding, "value")) fail(`secret_text binding ${binding.name} exposed a value`);
    } else if (Object.hasOwn(binding, "text")) fail(`non-plain binding ${binding.name} contains text`);
  }
  if (liveVars.ENVIRONMENT !== "staging") fail("live environment must remain staging");
  if (liveVars[DRAIN_FLAG] !== "false") fail("Directory outbox drain must remain false");
  if (Object.hasOwn(liveVars, RECOVERY_FLAG) && liveVars[RECOVERY_FLAG] !== "false") fail("relationship recovery must remain false");

  const config = clone(baseline);
  config.vars = { ...liveVars, [RECOVERY_FLAG]: "false" };
  const expectedProviderBindings = bindings.map(binding => clone(binding));
  if (!Object.hasOwn(liveVars, RECOVERY_FLAG)) expectedProviderBindings.push({ name: RECOVERY_FLAG, type: "plain_text", text: "false" });
  const changedVariableNames = Object.keys(config.vars).filter(name => baseline.vars[name] !== config.vars[name]).sort();
  return Object.freeze({
    config,
    expectedProviderBindings,
    expectedScriptRuntime: clone(snapshot.version.resources.script_runtime),
    expectedScript: clone(snapshot.version.resources.script),
    sourceVersionId: snapshot.version.id,
    summary: Object.freeze({ changedVariableNames }),
  });
}
