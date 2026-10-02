import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { validateApp } from "./staging-preflight.mjs";
import { STAGING_HOSTS } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const applications = Object.freeze(["delivery", "operations"]);

export const NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_PROFILE_NAME =
  "native-client-onboarding-acceptance";
export const NATIVE_CLIENT_ONBOARDING_ADMIN_ORIGIN =
  `https://${STAGING_HOSTS.operations}`;

export const NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS = Object.freeze({
  delivery: Object.freeze({
    source: "apps/client/wrangler.staging.json",
    production: "apps/client/wrangler.jsonc",
    output: "apps/client/wrangler.staging.native-client-onboarding-acceptance.json",
  }),
  operations: Object.freeze({
    source: "apps/operations/wrangler.staging.json",
    production: "apps/operations/wrangler.jsonc",
    output: "apps/operations/wrangler.staging.native-client-onboarding-acceptance.json",
  }),
});

// Two unique gates have three placements. The staff origin is configuration,
// not another gate, but it must move atomically with the Operations admin gate.
export const NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_ACTIVATION_VALUES = Object.freeze({
  delivery: Object.freeze({
    CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "true",
  }),
  operations: Object.freeze({
    CLIENT_ONBOARDING_ADMIN_ENABLED: "true",
    CLIENT_ONBOARDING_ADMIN_ORIGIN: NATIVE_CLIENT_ONBOARDING_ADMIN_ORIGIN,
    CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: "true",
  }),
});

export const NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_GATES = Object.freeze([
  "CLIENT_ONBOARDING_ADMIN_ENABLED",
  "CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED",
]);

const expectedBridge = Object.freeze({
  binding: "CLIENT_ONBOARDING_RECIPIENT_BRIDGE",
  service: "ledgetop-ops-staging",
  entrypoint: "ClientOnboardingRecipientBridge",
});
const expectedLimiter = Object.freeze({
  name: "PUBLIC_SESSION_RATE_LIMITER",
  namespace_id: "730202602",
  simple: Object.freeze({ limit: 20, period: 60 }),
});

const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const clone = value => structuredClone(value);

function exactNamedRows(rows, key, name) {
  return Array.isArray(rows) ? rows.filter(row => row?.[key] === name) : [];
}

function sourceErrors(sources, productionConfigs) {
  const errors = [];
  for (const app of applications) {
    errors.push(...validateApp(app, sources?.[app], productionConfigs?.[app])
      .map(error => `${app}: ${error}`));
  }

  for (const app of applications) {
    const source = sources?.[app];
    const production = productionConfigs?.[app];
    for (const flag of Object.keys(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_ACTIVATION_VALUES[app])) {
      if (flag === "CLIENT_ONBOARDING_ADMIN_ORIGIN") continue;
      if (source?.vars?.[flag] !== "false") {
        errors.push(`${app} default staging config must set ${flag}=false before onboarding activation`);
      }
      if (production?.vars?.[flag] !== "false") {
        errors.push(`${app} production config must keep ${flag}=false`);
      }
    }
  }
  if (sources?.operations?.vars?.CLIENT_ONBOARDING_ADMIN_ORIGIN !== "") {
    errors.push("operations default staging config must keep CLIENT_ONBOARDING_ADMIN_ORIGIN blank while disabled");
  }
  if (productionConfigs?.operations?.vars?.CLIENT_ONBOARDING_ADMIN_ORIGIN !== "") {
    errors.push("operations production config must keep CLIENT_ONBOARDING_ADMIN_ORIGIN blank while disabled");
  }

  if (sources?.delivery?.name !== "ledgetop-clients-staging"
    || sources?.delivery?.main !== "src/worker/index.ts") {
    errors.push("onboarding recipient acceptance requires the exact Client staging Worker");
  }
  if (sources?.operations?.name !== expectedBridge.service
    || sources?.operations?.main !== "src/worker/staging-native-authority-entrypoint.ts") {
    errors.push("onboarding staff acceptance requires the isolated Operations staging Worker");
  }

  const bridges = exactNamedRows(sources?.delivery?.services, "binding", expectedBridge.binding);
  if (bridges.length !== 1 || !isDeepStrictEqual(bridges[0], expectedBridge)) {
    errors.push("onboarding recipient acceptance requires the exact private Operations staging bridge");
  }

  const limiters = exactNamedRows(sources?.delivery?.ratelimits, "name", expectedLimiter.name);
  if (limiters.length !== 1 || !isDeepStrictEqual(limiters[0], expectedLimiter)) {
    errors.push("onboarding recipient acceptance requires the exact Client public-session rate limiter");
  }

  const assets = sources?.delivery?.assets;
  const workerFirst = assets?.run_worker_first;
  if (assets?.binding !== "ASSETS" || !Array.isArray(workerFirst)
    || workerFirst.filter(route => route === "/api/*").length !== 1
    || workerFirst.filter(route => route === "/onboarding/*").length !== 1) {
    errors.push("onboarding recipient acceptance requires Worker-first Client API and onboarding routes");
  }

  const opsDatabases = exactNamedRows(sources?.operations?.d1_databases, "binding", "OPS_DB");
  if (opsDatabases.length !== 1 || opsDatabases[0]?.database_name !== "ltds-ops-staging"
    || opsDatabases[0]?.migrations_dir !== "migrations") {
    errors.push("onboarding acceptance requires the exact Operations staging database binding");
  }
  return errors;
}

export function buildNativeClientOnboardingAcceptanceConfigs(sources, productionConfigs) {
  const errors = sourceErrors(sources, productionConfigs);
  if (errors.length) throw new Error(errors.join("\n"));
  return Object.fromEntries(applications.map(app => {
    const candidate = clone(sources[app]);
    Object.assign(candidate.vars,
      NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_ACTIVATION_VALUES[app]);
    return [app, candidate];
  }));
}

export function validateNativeClientOnboardingAcceptanceConfigs(
  sources, candidates, productionConfigs,
) {
  const errors = sourceErrors(sources, productionConfigs);
  if (errors.length) return errors;
  const expected = buildNativeClientOnboardingAcceptanceConfigs(sources, productionConfigs);
  for (const app of applications) {
    const candidate = candidates?.[app];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      errors.push(`${app} ${NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_PROFILE_NAME} candidate must be a JSON object`);
      continue;
    }
    if (!isDeepStrictEqual(candidate, expected[app])) {
      errors.push(`${app} ${NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_PROFILE_NAME} candidate drifted outside the bounded onboarding activation window`);
    }
    for (const [name, value] of Object.entries(
      NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_ACTIVATION_VALUES[app],
    )) {
      if (candidate.vars?.[name] !== value) {
        errors.push(`${app} onboarding acceptance candidate must set ${name}=${value}`);
      }
    }
  }
  const candidateNames = candidates && typeof candidates === "object" && !Array.isArray(candidates)
    ? Object.keys(candidates).sort() : [];
  if (!isDeepStrictEqual(candidateNames, [...applications].sort())) {
    errors.push("onboarding acceptance candidates must contain exactly Client and Operations");
  }
  return errors;
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("usage: node scripts/staging-native-client-onboarding-acceptance-profile.mjs --write|--check");
  }
  return argv[0];
}

function loadInputs(base) {
  const sources = {}, productionConfigs = {};
  for (const [app, files] of Object.entries(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS)) {
    const sourcePath = path.join(base, files.source);
    const productionPath = path.join(base, files.production);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`${files.source} is missing; render and validate default-off staging configs first`);
    }
    sources[app] = readJson(sourcePath);
    productionConfigs[app] = readJson(productionPath);
  }
  return { sources, productionConfigs };
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parseArguments(argv);
  const { sources, productionConfigs } = loadInputs(base);
  const expected = buildNativeClientOnboardingAcceptanceConfigs(sources, productionConfigs);
  const existing = {};
  for (const [app, files] of Object.entries(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS)) {
    const outputPath = path.join(base, files.output);
    existing[app] = fs.existsSync(outputPath) ? readJson(outputPath) : expected[app];
  }
  const errors = validateNativeClientOnboardingAcceptanceConfigs(
    sources, existing, productionConfigs,
  );
  if (errors.length) {
    throw new Error(`${NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_PROFILE_NAME} config is invalid or stale:\n${errors.map(error => `- ${error}`).join("\n")}`);
  }
  if (mode === "--check") {
    const missing = Object.entries(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS)
      .filter(([, files]) => !fs.existsSync(path.join(base, files.output)));
    if (missing.length) {
      throw new Error(`${missing.map(([, files]) => files.output).join(", ")} missing; generate with --write`);
    }
    console.log(`Validated ignored ${NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_PROFILE_NAME} configs. No remote action was performed.`);
    return Object.values(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS).map(({ output }) => output);
  }

  const temporaries = [];
  try {
    for (const [app, files] of Object.entries(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS)) {
      const outputPath = path.join(base, files.output);
      if (fs.existsSync(outputPath)) continue;
      const temporary = `${outputPath}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(expected[app], null, 2)}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 });
      temporaries.push({ temporary, outputPath });
    }
    for (const { temporary, outputPath } of temporaries) fs.renameSync(temporary, outputPath);
  } finally {
    for (const { temporary } of temporaries) {
      if (fs.existsSync(temporary)) fs.rmSync(temporary);
    }
  }
  console.log(`Wrote ignored ${NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_PROFILE_NAME} configs from validated default-off staging configs. No remote action was performed.`);
  return Object.values(NATIVE_CLIENT_ONBOARDING_ACCEPTANCE_CONFIGS).map(({ output }) => output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) {
    console.error(`Native client onboarding acceptance profile failed: ${error.message}`);
    process.exitCode = 1;
  }
}
