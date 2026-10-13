import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { validateApp } from "./staging-preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const OPS_PROJECT_V2_JOINED_ACCEPTANCE_PROFILE_NAME =
  "ops-project-v2-joined-acceptance";
export const OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG =
  "PROJECT_ALPHA_PROJECT_V2_ACTIVATION_ENABLED";
export const OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG = Object.freeze({
  source: "apps/operations/wrangler.staging.json",
  production: "apps/operations/wrangler.jsonc",
  output: "apps/operations/wrangler.staging.ops-project-v2-joined-acceptance.json",
});
export const OPS_PROJECT_V2_JOINED_ACCEPTANCE_ACTIVATION_VALUES = Object.freeze({
  [OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG]: "true",
});

const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));
const clone = value => structuredClone(value);

function sourceErrors(source, production) {
  const errors = [];
  if (!isObject(source)) {
    errors.push("Operations default staging source must be a JSON object");
  }
  if (!isObject(production)) {
    errors.push("Operations production baseline must be a JSON object");
  }
  if (isObject(source) && isObject(production)) {
    errors.push(...validateApp("operations", source, production));
  }
  if (isObject(source)
    && source.vars?.[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG] !== "false") {
    errors.push(`Operations default staging config must set ${OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG}=false`);
  }
  if (isObject(production)
    && production.vars?.[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG] !== "false") {
    errors.push(`Operations production config must keep ${OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG}=false`);
  }
  return errors;
}

export function buildOpsProjectV2JoinedAcceptanceConfig(source, production) {
  const errors = sourceErrors(source, production);
  if (errors.length) throw new Error(errors.join("\n"));
  const candidate = clone(source);
  Object.assign(candidate.vars, OPS_PROJECT_V2_JOINED_ACCEPTANCE_ACTIVATION_VALUES);
  return candidate;
}

export function validateOpsProjectV2JoinedAcceptanceConfig(
  source, candidate, production,
) {
  const errors = sourceErrors(source, production);
  if (!isObject(candidate)) {
    errors.push(`Operations ${OPS_PROJECT_V2_JOINED_ACCEPTANCE_PROFILE_NAME} candidate must be a JSON object`);
    return errors;
  }
  if (!errors.length) {
    const expected = clone(source);
    Object.assign(expected.vars, OPS_PROJECT_V2_JOINED_ACCEPTANCE_ACTIVATION_VALUES);
    if (!isDeepStrictEqual(candidate, expected)) {
      errors.push(`Operations ${OPS_PROJECT_V2_JOINED_ACCEPTANCE_PROFILE_NAME} candidate drifted outside the isolated one-gate staging window`);
    }
  }
  if (candidate.vars?.[OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG] !== "true") {
    errors.push(`Operations joined acceptance candidate must set ${OPS_PROJECT_V2_JOINED_ACCEPTANCE_FLAG}=true`);
  }
  return errors;
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("usage: node scripts/staging-ops-project-v2-joined-acceptance-profile.mjs --write|--check");
  }
  return argv[0];
}

function loadInputs(base) {
  const sourcePath = path.join(base, OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.source);
  const productionPath = path.join(base, OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.production);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`${OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.source} is missing; render and validate the default-off staging config first`);
  }
  if (!fs.existsSync(productionPath)) {
    throw new Error(`${OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.production} is missing; the production default-off baseline is required`);
  }
  return { source: readJson(sourcePath), production: readJson(productionPath) };
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parseArguments(argv);
  const { source, production } = loadInputs(base);
  const expected = buildOpsProjectV2JoinedAcceptanceConfig(source, production);
  const outputPath = path.join(base, OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.output);
  const candidate = fs.existsSync(outputPath) ? readJson(outputPath) : expected;
  const errors = validateOpsProjectV2JoinedAcceptanceConfig(source, candidate, production);
  if (errors.length) {
    throw new Error(`${OPS_PROJECT_V2_JOINED_ACCEPTANCE_PROFILE_NAME} config is invalid or stale:\n${errors.map(error => `- ${error}`).join("\n")}`);
  }

  if (mode === "--check") {
    if (!fs.existsSync(outputPath)) {
      throw new Error(`${OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.output} missing; generate with --write`);
    }
    console.log(`Validated ignored ${OPS_PROJECT_V2_JOINED_ACCEPTANCE_PROFILE_NAME} config. No remote action was performed.`);
    return OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.output;
  }

  if (fs.existsSync(outputPath)) {
    console.log(`Ignored ${OPS_PROJECT_V2_JOINED_ACCEPTANCE_PROFILE_NAME} config is current. It was not overwritten.`);
    return OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.output;
  }

  const temporary = `${outputPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(temporary, outputPath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  console.log(`Wrote ignored ${OPS_PROJECT_V2_JOINED_ACCEPTANCE_PROFILE_NAME} config from the validated default-off staging config. No remote action was performed.`);
  return OPS_PROJECT_V2_JOINED_ACCEPTANCE_CONFIG.output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    console.error(`Operations joined Project-v2 acceptance profile failed: ${error.message}`);
    process.exitCode = 1;
  }
}
