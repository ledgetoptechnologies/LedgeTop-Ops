import { isDeepStrictEqual } from "node:util";
import { validateProjectAdoptionFinalizationAcceptanceConfig } from "./staging-project-alpha-project-adoption-finalization-acceptance-profile.mjs";

export const STAGING_PROJECT_ADOPTION_OPERATIONS_WORKER = "ledgetop-ops-staging";
export const EXPECTED_STAGING_PROJECT_ADOPTION_OPERATIONS_VERSION_ID = "712b6d8c-1b14-4a98-a6d6-d5bdb6555779";
export const PROJECT_ADOPTION_LIVE_BOOLEAN_NAMES = Object.freeze([
  "CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED",
  "CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED",
]);
export const REVIEWED_PROJECT_ADOPTION_LIVE_BOOLEAN_VALUES = Object.freeze({
  CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED: "true",
  CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true",
});

const exactKeys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());

function fail(message) {
  throw new Error(`project-adoption-live-settings-preservation: ${message}`);
}

function validateFinalizationBaseline(source, baseline, production) {
  const errors = validateProjectAdoptionFinalizationAcceptanceConfig(source, baseline, production);
  if (errors.length) fail(`finalization baseline is not validated: ${errors.join("; ")}`);
  for (const name of PROJECT_ADOPTION_LIVE_BOOLEAN_NAMES) {
    if (baseline.vars?.[name] !== "false")
      fail(`finalization baseline must keep ${name}=false before live-settings preservation`);
  }
}

function validateSnapshot(snapshot) {
  if (!exactKeys(snapshot, ["schemaVersion", "environment", "worker", "settings"]))
    fail("snapshot must contain only schemaVersion, environment, worker, and settings");
  if (snapshot.schemaVersion !== 1 || snapshot.environment !== "staging")
    fail("staging snapshot schema required");
  if (!exactKeys(snapshot.worker, ["name", "versionId"])
    || snapshot.worker.name !== STAGING_PROJECT_ADOPTION_OPERATIONS_WORKER
    || snapshot.worker.versionId !== EXPECTED_STAGING_PROJECT_ADOPTION_OPERATIONS_VERSION_ID)
    fail("snapshot must target the exact reviewed active staging Operations version");
  if (!exactKeys(snapshot.settings, PROJECT_ADOPTION_LIVE_BOOLEAN_NAMES))
    fail("snapshot settings must contain exactly the selected live boolean names");
  for (const name of PROJECT_ADOPTION_LIVE_BOOLEAN_NAMES) {
    if (typeof snapshot.settings[name] !== "string"
      || snapshot.settings[name] !== REVIEWED_PROJECT_ADOPTION_LIVE_BOOLEAN_VALUES[name])
      fail(`snapshot settings.${name} must equal the exact reviewed string true value`);
  }
}

function validateActiveVersionPreflight(preflight, snapshot) {
  if (!exactKeys(preflight, ["workerName", "versions"]) || !Array.isArray(preflight.versions))
    fail("active-version preflight is invalid");
  if (preflight.workerName !== snapshot.worker.name)
    fail("active-version preflight must target the exact staging Operations worker");
  if (preflight.versions.length !== 1)
    fail("active-version preflight must contain exactly one 100% active version");
  const [active] = preflight.versions;
  if (!exactKeys(active, ["versionId", "percentage"])
    || active.versionId !== snapshot.worker.versionId
    || active.percentage !== 100)
    fail("active-version preflight must pin the reviewed Operations version at numeric 100 percent");
}

/**
 * Preserves two explicitly reviewed live booleans on one pinned, 100%-active
 * staging Operations version. A new version or any other candidate change
 * requires fresh review. This pure helper performs no reads, writes, or deploys.
 */
export function buildProjectAdoptionLiveSettingsPreservedConfig(
  source,
  validatedFinalizationCandidate,
  production,
  snapshot,
  activeVersionPreflight,
) {
  validateFinalizationBaseline(source, validatedFinalizationCandidate, production);
  validateSnapshot(snapshot);
  validateActiveVersionPreflight(activeVersionPreflight, snapshot);
  const result = structuredClone(validatedFinalizationCandidate);
  for (const name of PROJECT_ADOPTION_LIVE_BOOLEAN_NAMES)
    result.vars[name] = snapshot.settings[name];
  return result;
}

export function validateProjectAdoptionLiveSettingsPreservedConfig(
  source,
  validatedFinalizationCandidate,
  candidate,
  production,
  snapshot,
  activeVersionPreflight,
) {
  try {
    const expected = buildProjectAdoptionLiveSettingsPreservedConfig(
      source,
      validatedFinalizationCandidate,
      production,
      snapshot,
      activeVersionPreflight,
    );
    return isDeepStrictEqual(candidate, expected)
      ? []
      : ["project-adoption live-settings candidate drifted outside the exact two-boolean preservation overlay"];
  } catch (error) {
    return [error.message];
  }
}
