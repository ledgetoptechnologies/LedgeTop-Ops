import { isDeepStrictEqual } from "node:util";
import { validateApp } from "./staging-preflight.mjs";

// Pure configuration transformation: no remote calls, secret reads, file writes,
// recipient grants, or production rollout. Deploy the pair only after review.
export const WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES = Object.freeze({
  delivery: Object.freeze({ CLIENT_PORTAL_OPERATIONS_PUBLICATION_WRITER_ENABLED: "true" }),
  operations: Object.freeze({ OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED: "true",
    OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED: "true" }),
});

function sourceErrors(sources, production) {
  const errors = [];
  for (const app of ["delivery", "operations"]) {
    errors.push(...validateApp(app, sources?.[app], production?.[app]).map(error => `${app}: ${error}`));
    for (const flag of Object.keys(WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES[app])) {
      if (sources?.[app]?.vars?.[flag] !== "false") errors.push(`${app} source must keep ${flag}=false`);
      const productionValue = production?.[app]?.vars?.[flag];
      if (productionValue !== undefined && productionValue !== "false")
        errors.push(`${app} production must omit ${flag} or keep it false`);
    }
  }
  const bindings = sources?.operations?.services?.filter(binding => binding.binding === "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION") ?? [];
  if (bindings.length !== 1 || bindings[0].service !== "ledgetop-clients-staging"
    || bindings[0].entrypoint !== "OperationsPortalWorkspacePublicationIngress")
    errors.push("workspace publication requires the exact private Client staging binding");
  if (sources?.operations?.main !== "src/worker/staging-native-authority-entrypoint.ts")
    errors.push("workspace owner requires the isolated native staging entrypoint");
  return errors;
}

export function buildNativeWorkspaceAcceptanceConfigs(sources, production) {
  const errors = sourceErrors(sources, production);
  if (errors.length) throw new Error(errors.join("\n"));
  return Object.fromEntries(["delivery", "operations"].map(app => {
    const candidate = structuredClone(sources[app]);
    Object.assign(candidate.vars, WORKSPACE_ACCEPTANCE_ACTIVATION_VALUES[app]);
    return [app, candidate];
  }));
}

export function validateNativeWorkspaceAcceptanceConfigs(sources, candidates, production) {
  const errors = sourceErrors(sources, production);
  if (errors.length) return errors;
  const expected = buildNativeWorkspaceAcceptanceConfigs(sources, production);
  for (const app of ["delivery", "operations"]) {
    if (!isDeepStrictEqual(candidates?.[app], expected[app]))
      errors.push(`${app} workspace acceptance candidate drifted outside the paired three-gate window`);
  }
  return errors;
}
