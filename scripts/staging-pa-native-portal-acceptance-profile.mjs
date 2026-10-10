import { isDeepStrictEqual } from "node:util";
import {
  buildDirectoryProfileWriteAcceptanceConfig,
  DIRECTORY_PROFILE_WRITE_ACCEPTANCE_VALUES,
} from "./staging-directory-writes-acceptance-profile.mjs";
import {
  buildNativePortalAcceptanceConfigs,
  NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES,
} from "./staging-native-portal-acceptance-profile.mjs";
import {
  buildNativeWorkspaceAcceptanceConfigs,
  WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES,
} from "./staging-native-workspace-acceptance-profile.mjs";
import { PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES } from "./staging-project-alpha-api-v2-acceptance-profile.mjs";
import { DIRECTORY_ADOPTION_ACCEPTANCE_VALUES } from "./staging-project-alpha-directory-adoption-acceptance-profile.mjs";
import {
  buildProjectAdoptionFinalizationAcceptanceConfig,
  PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_VALUES,
} from "./staging-project-alpha-project-adoption-finalization-acceptance-profile.mjs";

export const PA_NATIVE_PORTAL_ACCEPTANCE_PROFILE = "pa-native-portal-staging-acceptance";
export const PA_NATIVE_PORTAL_ACCEPTANCE_APPS = Object.freeze(["delivery", "operations"]);

function mergeDeltas(...deltas) {
  const merged = {};
  for (const delta of deltas) for (const [flag, value] of Object.entries(delta)) {
    if (Object.hasOwn(merged, flag) && merged[flag] !== value)
      throw new Error(`PA plus native portal acceptance profiles conflict on ${flag}`);
    merged[flag] = value;
  }
  return merged;
}

export const PA_NATIVE_PORTAL_ACCEPTANCE_VALUES = Object.freeze({
  delivery: Object.freeze(mergeDeltas(
    WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES.delivery,
    NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES.delivery,
  )),
  operations: Object.freeze(mergeDeltas(
    PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES,
    DIRECTORY_ADOPTION_ACCEPTANCE_VALUES,
    DIRECTORY_PROFILE_WRITE_ACCEPTANCE_VALUES,
    PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_VALUES,
    WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES.operations,
    NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES.operations,
  )),
});

function expectedFromSource(source, delta) {
  const expected = structuredClone(source);
  Object.assign(expected.vars, delta);
  return expected;
}

function validateDirectoryAdoptionDefaultOff(source, production) {
  const errors = [];
  for (const flag of Object.keys(DIRECTORY_ADOPTION_ACCEPTANCE_VALUES)) {
    if (source?.vars?.[flag] !== "false")
      errors.push(`Operations base staging config must set ${flag}=false`);
    const productionValue = production?.vars?.[flag];
    if (flag === "PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED") {
      if (productionValue !== undefined && productionValue !== "false")
        errors.push(`Operations production config must omit ${flag} or set it to the string false`);
    } else if (productionValue !== "false") {
      errors.push(`Operations production config must set ${flag}=false`);
    }
  }
  return errors;
}

function assertConstituent(candidate, source, delta, label) {
  if (!isDeepStrictEqual(candidate, expectedFromSource(source, delta)))
    throw new Error(`${label} constituent drifted outside its exported delta`);
}

/**
 * Builds the post-adoption PA plus native portal window used to exercise normal
 * relationship creation and recipient-folder behavior. All constituents see
 * the untouched default-off sources and production baselines. This pure
 * function does not generate files, preserve live settings, or deploy.
 */
export function buildPaNativePortalAcceptanceConfigs(sources, production) {
  const finalization = buildProjectAdoptionFinalizationAcceptanceConfig(
    sources?.operations,
    production?.operations,
  );
  const directoryErrors = validateDirectoryAdoptionDefaultOff(
    sources?.operations,
    production?.operations,
  );
  if (directoryErrors.length) throw new Error(directoryErrors.join("\n"));
  const directoryProfileWrite = buildDirectoryProfileWriteAcceptanceConfig(
    sources?.operations,
    production?.operations,
  );
  const workspace = buildNativeWorkspaceAcceptanceConfigs(sources, production);
  const portal = buildNativePortalAcceptanceConfigs(sources, production);

  assertConstituent(finalization, sources.operations, mergeDeltas(
    PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES,
    PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_VALUES,
  ), "Project adoption finalization");
  assertConstituent(directoryProfileWrite, sources.operations,
    DIRECTORY_PROFILE_WRITE_ACCEPTANCE_VALUES, "Directory profile-write");
  for (const app of PA_NATIVE_PORTAL_ACCEPTANCE_APPS) {
    assertConstituent(workspace[app], sources[app],
      WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES[app], `native workspace ${app}`);
    assertConstituent(portal[app], sources[app],
      NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES[app], `native portal ${app}`);
  }

  return {
    delivery: expectedFromSource(sources.delivery, PA_NATIVE_PORTAL_ACCEPTANCE_VALUES.delivery),
    operations: expectedFromSource(sources.operations, PA_NATIVE_PORTAL_ACCEPTANCE_VALUES.operations),
  };
}

export function validatePaNativePortalAcceptanceConfigs(sources, candidates, production) {
  const errors = [];
  const names = candidates && typeof candidates === "object" && !Array.isArray(candidates)
    ? Object.keys(candidates).sort() : [];
  if (!isDeepStrictEqual(names, [...PA_NATIVE_PORTAL_ACCEPTANCE_APPS].sort()))
    errors.push("PA plus native portal candidates must contain exactly Client and Operations");
  let expected;
  try { expected = buildPaNativePortalAcceptanceConfigs(sources, production); }
  catch (error) { errors.push(error.message); return errors; }
  for (const app of PA_NATIVE_PORTAL_ACCEPTANCE_APPS) {
    if (!isDeepStrictEqual(candidates?.[app], expected[app]))
      errors.push(`${app} ${PA_NATIVE_PORTAL_ACCEPTANCE_PROFILE} candidate drifted outside the exact composed window`);
  }
  return errors;
}
