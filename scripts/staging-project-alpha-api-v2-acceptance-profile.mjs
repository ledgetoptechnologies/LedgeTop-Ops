import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { validateApp } from "./staging-preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PROJECT_ALPHA_API_V2_ACCEPTANCE_PROFILE = "project-alpha-api-v2-acceptance";
export const PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG = Object.freeze({
  source: "apps/operations/wrangler.staging.json",
  production: "apps/operations/wrangler.jsonc",
  output: "apps/operations/wrangler.staging.project-alpha-api-v2-acceptance.json",
});

// Keep the baseline release config default-off. This separately named profile
// is the only candidate that enables the bounded staging API-v2 test window.
export const PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES = Object.freeze({
  PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED: "true",
  PROJECT_ALPHA_API_V2_SYNC_ENABLED: "true",
  PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED: "true",
  PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED: "true",
  PROJECT_ALPHA_PROJECT_BINDING_REVISION_REFRESH_ENABLED: "true",
});

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const clone = (value) => structuredClone(value);

function validateSource(source, production) {
  const errors = validateApp("operations", source, production);
  for (const flag of Object.keys(PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES)) {
    if (source?.vars?.[flag] !== "false") errors.push(`Operations base staging config must set ${flag}=false`);
    if (production?.vars?.[flag] !== "false") errors.push(`Operations production config must keep ${flag}=false`);
  }
  return errors;
}

export function buildProjectAlphaApiV2AcceptanceConfig(source, production) {
  const errors = validateSource(source, production);
  if (errors.length) throw new Error(errors.join("\n"));
  const candidate = clone(source);
  Object.assign(candidate.vars, PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES);
  return candidate;
}

export function validateProjectAlphaApiV2AcceptanceConfig(source, candidate, production) {
  const errors = validateSource(source, production);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    errors.push(`Operations ${PROJECT_ALPHA_API_V2_ACCEPTANCE_PROFILE} candidate must be a JSON object`);
    return errors;
  }
  const expected = clone(source);
  Object.assign(expected.vars, PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES);
  if (!isDeepStrictEqual(candidate, expected)) {
    errors.push(`Operations ${PROJECT_ALPHA_API_V2_ACCEPTANCE_PROFILE} candidate drifted outside the five-gate staging window`);
  }
  for (const [flag, value] of Object.entries(PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES)) {
    if (candidate.vars?.[flag] !== value) errors.push(`Operations acceptance candidate must set ${flag}=${value}`);
  }
  return errors;
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("usage: node scripts/staging-project-alpha-api-v2-acceptance-profile.mjs --write|--check");
  }
  return argv[0];
}

function loadInputs(base) {
  const sourcePath = path.join(base, PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.source);
  const productionPath = path.join(base, PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.production);
  if (!fs.existsSync(sourcePath)) throw new Error(`${PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.source} is missing; render default-off staging config first`);
  return { source: readJson(sourcePath), production: readJson(productionPath) };
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parseArguments(argv);
  const { source, production } = loadInputs(base);
  const expected = buildProjectAlphaApiV2AcceptanceConfig(source, production);
  const outputPath = path.join(base, PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.output);
  const candidate = fs.existsSync(outputPath) ? readJson(outputPath) : expected;
  const errors = validateProjectAlphaApiV2AcceptanceConfig(source, candidate, production);
  if (errors.length) throw new Error(`${PROJECT_ALPHA_API_V2_ACCEPTANCE_PROFILE} config is invalid or stale:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  if (mode === "--check") {
    if (!fs.existsSync(outputPath)) throw new Error(`${PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.output} missing; generate with --write`);
    console.log(`Validated ignored ${PROJECT_ALPHA_API_V2_ACCEPTANCE_PROFILE} config. No remote action was performed.`);
    return PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.output;
  }
  if (fs.existsSync(outputPath)) {
    console.log(`Ignored ${PROJECT_ALPHA_API_V2_ACCEPTANCE_PROFILE} config is current. It was not overwritten.`);
    return PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.output;
  }
  const temporary = `${outputPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, outputPath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  console.log(`Wrote ignored ${PROJECT_ALPHA_API_V2_ACCEPTANCE_PROFILE} config from the validated default-off staging config. No remote action was performed.`);
  return PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) { console.error(`${PROJECT_ALPHA_API_V2_ACCEPTANCE_PROFILE} profile failed: ${error.message}`); process.exitCode = 1; }
}
