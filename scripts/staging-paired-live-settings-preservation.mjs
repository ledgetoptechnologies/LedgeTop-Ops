import { isDeepStrictEqual } from "node:util";
import { validatePairedEndToEndAcceptanceConfigs } from "./staging-paired-end-to-end-acceptance-profile.mjs";

export const STAGING_OPERATIONS_WORKER = "ledgetop-ops-staging";
export const EXPECTED_STAGING_OPERATIONS_VERSION_ID = "5f0ad270-0092-4f51-9534-34efc6ee2957";
export const STAGING_CLIENT_WORKER = "ledgetop-clients-staging";
export const EXPECTED_STAGING_CLIENT_VERSION_ID = "8bf70f8c-c3c5-494d-8c4b-474427f86350";

export const PAIRED_LIVE_BOOLEAN_NAMES = Object.freeze({
  operations: Object.freeze([
    "VIEWER_PUBLIC_SHARES_ENABLED",
    "CLIENT_VIEWER_SESSION_ISSUER_ENABLED",
    "CLIENT_VIEWER_SHARES_ENABLED",
  ]),
  delivery: Object.freeze([
    "CLIENT_VIEWER_ENABLED",
    "CLIENT_VIEWER_SHARES_ENABLED",
  ]),
});
export const REVIEWED_PAIRED_LIVE_BOOLEAN_VALUES = Object.freeze({
  operations: Object.freeze({
    VIEWER_PUBLIC_SHARES_ENABLED: "true",
    CLIENT_VIEWER_SESSION_ISSUER_ENABLED: "true",
    CLIENT_VIEWER_SHARES_ENABLED: "true",
  }),
  delivery: Object.freeze({
    CLIENT_VIEWER_ENABLED: "false",
    CLIENT_VIEWER_SHARES_ENABLED: "false",
  }),
});

const exactKeys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());

function fail(message) {
  throw new Error(`paired-live-settings-preservation: ${message}`);
}

function validateBooleanSettings(value, names, reviewed, label) {
  if (!exactKeys(value, names)) fail(`${label} must contain exactly the selected live boolean names`);
  for (const name of names) {
    if (value[name] !== "true" && value[name] !== "false")
      fail(`${label}.${name} must be the explicit string true or false`);
    if (value[name] !== reviewed[name])
      fail(`${label}.${name} differs from the exact reviewed active-version value`);
  }
}

function validateSnapshot(snapshot) {
  if (!exactKeys(snapshot, ["schemaVersion", "environment", "worker", "settings"]))
    fail("snapshot must contain only schemaVersion, environment, worker, and settings");
  if (snapshot.schemaVersion !== 1 || snapshot.environment !== "staging") fail("staging snapshot schema required");
  if (!exactKeys(snapshot.worker, ["operations", "delivery"])) fail("snapshot worker identity is invalid");
  for (const [app, name, versionId] of [
    ["operations", STAGING_OPERATIONS_WORKER, EXPECTED_STAGING_OPERATIONS_VERSION_ID],
    ["delivery", STAGING_CLIENT_WORKER, EXPECTED_STAGING_CLIENT_VERSION_ID],
  ]) {
    if (!exactKeys(snapshot.worker[app], ["name", "versionId"]) || snapshot.worker[app].name !== name
      || snapshot.worker[app].versionId !== versionId) fail(`snapshot must target the exact reviewed staging ${app} version`);
  }
  if (!exactKeys(snapshot.settings, ["operations", "delivery"])) fail("snapshot settings must contain exactly operations and delivery");
  validateBooleanSettings(snapshot.settings.operations, PAIRED_LIVE_BOOLEAN_NAMES.operations,
    REVIEWED_PAIRED_LIVE_BOOLEAN_VALUES.operations, "operations settings");
  validateBooleanSettings(snapshot.settings.delivery, PAIRED_LIVE_BOOLEAN_NAMES.delivery,
    REVIEWED_PAIRED_LIVE_BOOLEAN_VALUES.delivery, "delivery settings");
}

function validatePreflight(preflight, snapshot) {
  if (!exactKeys(preflight, ["operations", "delivery"])) fail("active-version preflight is invalid");
  for (const app of ["operations", "delivery"]) {
    if (!exactKeys(preflight[app], ["workerName", "activeVersionId"])) fail("active-version preflight is invalid");
    if (preflight[app].workerName !== snapshot.worker[app].name
      || preflight[app].activeVersionId !== snapshot.worker[app].versionId)
      fail(`selected live settings snapshot is stale for the active staging ${app} version`);
  }
}

function requireValidatedPair(pair) {
  if (!exactKeys(pair, ["delivery", "operations"])) {
    fail("an already validated paired Client and Operations candidate is required");
  }
}

/**
 * Preserves the exact five booleans reviewed at the two pinned active versions.
 * A future version or setting change requires fresh inspection and review; it
 * is never interpreted as authorization to enable anything automatically.
 * This pure function performs no reads, writes, or deploys.
 */
export function buildPairedLiveSettingsPreservedConfig(sources, validatedPair, production, secretNames, snapshot, activeVersionPreflight) {
  requireValidatedPair(validatedPair);
  const baselineErrors = validatePairedEndToEndAcceptanceConfigs(sources, validatedPair, production, secretNames);
  if (baselineErrors.length) fail(`paired baseline is not validated: ${baselineErrors.join("; ")}`);
  validateSnapshot(snapshot);
  validatePreflight(activeVersionPreflight, snapshot);
  const result = structuredClone(validatedPair);
  for (const name of PAIRED_LIVE_BOOLEAN_NAMES.operations)
    result.operations.vars[name] = snapshot.settings.operations[name];
  for (const name of PAIRED_LIVE_BOOLEAN_NAMES.delivery)
    result.delivery.vars[name] = snapshot.settings.delivery[name];
  return result;
}

export function validatePairedLiveSettingsPreservedConfig(sources, validatedPair, candidate, production, secretNames, snapshot, activeVersionPreflight) {
  try {
    const expected = buildPairedLiveSettingsPreservedConfig(sources, validatedPair, production, secretNames, snapshot, activeVersionPreflight);
    return isDeepStrictEqual(candidate, expected)
      ? []
      : ["paired live-settings candidate drifted outside the exact five-boolean preservation overlay"];
  } catch (error) {
    return [error.message];
  }
}
