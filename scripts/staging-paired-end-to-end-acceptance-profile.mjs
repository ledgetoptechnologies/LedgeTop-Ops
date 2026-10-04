import { isDeepStrictEqual } from "node:util";
import {
  buildDirectoryAdoptionAcceptanceConfig,
  DIRECTORY_ADOPTION_ACCEPTANCE_VALUES,
} from "./staging-project-alpha-directory-adoption-acceptance-profile.mjs";
import { PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES } from "./staging-project-alpha-api-v2-acceptance-profile.mjs";
import { VIEWER_ACCEPTANCE_IDENTITY, VIEWER_ACCEPTANCE_VALUES } from "./staging-project-alpha-api-v2-viewer-acceptance-profile.mjs";
import {
  buildNativeWorkspaceAcceptanceConfigs,
  WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES,
} from "./staging-native-workspace-acceptance-profile.mjs";
import {
  buildNativePortalAcceptanceConfigs,
  NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES,
} from "./staging-native-portal-acceptance-profile.mjs";

export const PAIRED_END_TO_END_ACCEPTANCE_PROFILE = "paired-end-to-end-staging-acceptance";
export const PAIRED_END_TO_END_ACCEPTANCE_APPS = Object.freeze(["delivery", "operations"]);

export function mergeAcceptanceDeltas(...deltas) {
  const merged = {};
  for (const delta of deltas) for (const [flag, value] of Object.entries(delta)) {
    if (Object.hasOwn(merged, flag) && merged[flag] !== value)
      throw new Error(`acceptance profiles conflict on ${flag}`);
    merged[flag] = value;
  }
  return merged;
}

function expectedFromSource(source, delta) {
  const expected = structuredClone(source);
  Object.assign(expected.vars, delta);
  return expected;
}

// Every constituent builder validates the same untouched default-off sources.
// Only their exported deltas are merged; no already-activated candidate is fed
// back through validateApp or another constituent builder.
export function buildPairedEndToEndAcceptanceConfigs(sources, production, secretNames) {
  const directoryOperations = buildDirectoryAdoptionAcceptanceConfig(
    sources?.operations, production?.operations, secretNames,
  );
  const workspace = buildNativeWorkspaceAcceptanceConfigs(sources, production);
  const portal = buildNativePortalAcceptanceConfigs(sources, production);

  const directoryDelta = mergeAcceptanceDeltas(
    PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES,
    VIEWER_ACCEPTANCE_VALUES,
    VIEWER_ACCEPTANCE_IDENTITY,
    DIRECTORY_ADOPTION_ACCEPTANCE_VALUES);
  if (!isDeepStrictEqual(directoryOperations, expectedFromSource(sources.operations, directoryDelta)))
    throw new Error("Directory constituent drifted outside its exported API, Viewer, and adoption deltas");
  for (const app of PAIRED_END_TO_END_ACCEPTANCE_APPS) {
    if (!isDeepStrictEqual(workspace[app], expectedFromSource(sources[app], WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES[app])))
      throw new Error(`workspace ${app} constituent drifted outside its exported delta`);
    if (!isDeepStrictEqual(portal[app], expectedFromSource(sources[app], NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES[app])))
      throw new Error(`native portal ${app} constituent drifted outside its exported delta`);
  }

  const deliveryDelta = mergeAcceptanceDeltas(
    WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES.delivery,
    NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES.delivery);
  const operationsDelta = mergeAcceptanceDeltas(
    PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES,
    VIEWER_ACCEPTANCE_VALUES,
    VIEWER_ACCEPTANCE_IDENTITY,
    DIRECTORY_ADOPTION_ACCEPTANCE_VALUES,
    WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES.operations,
    NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES.operations);

  return {
    delivery: expectedFromSource(sources.delivery, deliveryDelta),
    operations: expectedFromSource(sources.operations, operationsDelta),
  };
}

export function validatePairedEndToEndAcceptanceConfigs(sources, candidates, production, secretNames) {
  const errors = [];
  const names = candidates && typeof candidates === "object" && !Array.isArray(candidates)
    ? Object.keys(candidates).sort() : [];
  if (!isDeepStrictEqual(names, [...PAIRED_END_TO_END_ACCEPTANCE_APPS].sort()))
    errors.push("paired end-to-end candidates must contain exactly Client and Operations");
  let expected;
  try { expected = buildPairedEndToEndAcceptanceConfigs(sources, production, secretNames); }
  catch (error) { errors.push(error.message); return errors; }
  for (const app of PAIRED_END_TO_END_ACCEPTANCE_APPS) {
    if (!isDeepStrictEqual(candidates?.[app], expected[app]))
      errors.push(`${app} ${PAIRED_END_TO_END_ACCEPTANCE_PROFILE} candidate drifted outside the exact composed window`);
  }
  return errors;
}
