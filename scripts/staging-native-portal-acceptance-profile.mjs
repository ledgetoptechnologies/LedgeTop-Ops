import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { validateApp } from "./staging-preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const NATIVE_PORTAL_ACCEPTANCE_PROFILE_NAME = "native-recipient-service-home-acceptance";

export const NATIVE_PORTAL_ACCEPTANCE_CONFIGS = Object.freeze({
  delivery: Object.freeze({
    source: "apps/client/wrangler.staging.json",
    production: "apps/client/wrangler.jsonc",
    output: "apps/client/wrangler.staging.native-portal-acceptance.json",
  }),
  operations: Object.freeze({
    source: "apps/operations/wrangler.staging.json",
    production: "apps/operations/wrangler.jsonc",
    output: "apps/operations/wrangler.staging.native-portal-acceptance.json",
  }),
});

// The selector is deliberately set on both sides of the private RPC. These are
// three unique gates and four exact config placements; none may be enabled on
// its own by this profile.
export const NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES = Object.freeze({
  delivery: Object.freeze({
    CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED: "true",
    CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true",
  }),
  operations: Object.freeze({
    CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED: "true",
    CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED: "true",
  }),
});

export const NATIVE_PORTAL_ACCEPTANCE_GATES = Object.freeze([
  "CLIENT_PORTAL_OPERATIONS_SERVICE_HOME_ENABLED",
  "CLIENT_PORTAL_SERVICE_METADATA_RPC_ENABLED",
  "CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED",
]);

const REQUIRED_NATIVE_BASE_FLAGS = Object.freeze({
  delivery: Object.freeze([
    "CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_WRITER_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_STATUS_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_WRITER_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_STATUS_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED",
    "CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED",
  ]),
  operations: Object.freeze([
    "CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED",
    "CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED",
    "OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED",
    "OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED",
    "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_DISPATCH_ENABLED",
    "OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED",
  ]),
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const clone = (value) => structuredClone(value);

function validateSourcePair(sources, productionConfigs) {
  const errors = [];
  for (const app of Object.keys(NATIVE_PORTAL_ACCEPTANCE_CONFIGS)) {
    errors.push(...validateApp(app, sources?.[app], productionConfigs?.[app]).map((error) => `${app}: ${error}`));
    for (const [flag] of Object.entries(NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES[app])) {
      if (sources?.[app]?.vars?.[flag] !== "false") {
        errors.push(`${app} default staging config must set ${flag}=false before the acceptance profile is generated`);
      }
      if (productionConfigs?.[app]?.vars?.[flag] !== "false") {
        errors.push(`${app} production config must keep ${flag}=false`);
      }
    }
    for (const flag of REQUIRED_NATIVE_BASE_FLAGS[app]) {
      if (sources?.[app]?.vars?.[flag] !== "true") {
        errors.push(`${app} native portal acceptance source must set ${flag}=true`);
      }
    }
  }
  const metadataReader = sources?.delivery?.services?.find(({ binding }) => binding === "CLIENT_PORTAL_SERVICE_METADATA_READER");
  if (metadataReader?.service !== sources?.operations?.name || metadataReader?.entrypoint !== "ClientPortalServiceMetadataReader") {
    errors.push("delivery metadata reader must target the exact Operations staging Worker and private named entrypoint");
  }
  return errors;
}

export function buildNativePortalAcceptanceConfigs(sources, productionConfigs) {
  const errors = validateSourcePair(sources, productionConfigs);
  if (errors.length) throw new Error(errors.join("\n"));
  return Object.fromEntries(Object.keys(NATIVE_PORTAL_ACCEPTANCE_CONFIGS).map((app) => {
    const candidate = clone(sources[app]);
    Object.assign(candidate.vars, NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES[app]);
    return [app, candidate];
  }));
}

export function validateNativePortalAcceptanceConfigs(sources, candidates, productionConfigs) {
  const errors = validateSourcePair(sources, productionConfigs);
  for (const app of Object.keys(NATIVE_PORTAL_ACCEPTANCE_CONFIGS)) {
    const candidate = candidates?.[app];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      errors.push(`${app} ${NATIVE_PORTAL_ACCEPTANCE_PROFILE_NAME} candidate must be a JSON object`);
      continue;
    }
    const expected = clone(sources[app]);
    Object.assign(expected.vars, NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES[app]);
    if (!isDeepStrictEqual(candidate, expected)) {
      errors.push(`${app} ${NATIVE_PORTAL_ACCEPTANCE_PROFILE_NAME} candidate drifted outside the three-gate activation window`);
    }
    for (const [flag, value] of Object.entries(NATIVE_PORTAL_ACCEPTANCE_ACTIVATION_VALUES[app])) {
      if (candidate.vars?.[flag] !== value) errors.push(`${app} acceptance candidate must set ${flag}=${value}`);
    }
  }
  const selectorPlacements = Object.keys(NATIVE_PORTAL_ACCEPTANCE_CONFIGS)
    .filter((app) => candidates?.[app]?.vars?.CLIENT_PORTAL_NATIVE_RECIPIENT_SERVICE_HOME_ENABLED === "true");
  if (selectorPlacements.length !== Object.keys(NATIVE_PORTAL_ACCEPTANCE_CONFIGS).length) {
    errors.push("native recipient service-home selection must be enabled on both Client and Operations; legacy PA fallback is forbidden");
  }
  return errors;
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("usage: node scripts/staging-native-portal-acceptance-profile.mjs --write|--check");
  }
  return argv[0];
}

function loadInputs(base) {
  const sources = {}, productionConfigs = {};
  for (const [app, files] of Object.entries(NATIVE_PORTAL_ACCEPTANCE_CONFIGS)) {
    const sourcePath = path.join(base, files.source);
    const productionPath = path.join(base, files.production);
    if (!fs.existsSync(sourcePath)) throw new Error(`${files.source} is missing; render and validate default-off staging configs first`);
    sources[app] = readJson(sourcePath);
    productionConfigs[app] = readJson(productionPath);
  }
  return { sources, productionConfigs };
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parseArguments(argv);
  const { sources, productionConfigs } = loadInputs(base);
  const expected = buildNativePortalAcceptanceConfigs(sources, productionConfigs);
  const existing = {};
  for (const [app, files] of Object.entries(NATIVE_PORTAL_ACCEPTANCE_CONFIGS)) {
    const outputPath = path.join(base, files.output);
    existing[app] = fs.existsSync(outputPath) ? readJson(outputPath) : expected[app];
  }
  const errors = validateNativePortalAcceptanceConfigs(sources, existing, productionConfigs);
  if (errors.length) throw new Error(`${NATIVE_PORTAL_ACCEPTANCE_PROFILE_NAME} config is invalid or stale:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  if (mode === "--check") {
    const missing = Object.entries(NATIVE_PORTAL_ACCEPTANCE_CONFIGS)
      .filter(([, files]) => !fs.existsSync(path.join(base, files.output)));
    if (missing.length) throw new Error(`${missing.map(([, files]) => files.output).join(", ")} missing; generate with --write`);
    console.log(`Validated ignored ${NATIVE_PORTAL_ACCEPTANCE_PROFILE_NAME} configs. No remote action was performed.`);
    return Object.values(NATIVE_PORTAL_ACCEPTANCE_CONFIGS).map(({ output }) => output);
  }

  const temporaries = [];
  try {
    for (const [app, files] of Object.entries(NATIVE_PORTAL_ACCEPTANCE_CONFIGS)) {
      const outputPath = path.join(base, files.output);
      if (fs.existsSync(outputPath)) continue;
      const temporary = `${outputPath}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(expected[app], null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      temporaries.push({ temporary, outputPath });
    }
    for (const { temporary, outputPath } of temporaries) fs.renameSync(temporary, outputPath);
  } finally {
    for (const { temporary } of temporaries) if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  console.log(`Wrote ignored ${NATIVE_PORTAL_ACCEPTANCE_PROFILE_NAME} configs from validated default-off staging configs. No remote action was performed.`);
  return Object.values(NATIVE_PORTAL_ACCEPTANCE_CONFIGS).map(({ output }) => output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) { console.error(`Native portal acceptance profile failed: ${error.message}`); process.exitCode = 1; }
}
