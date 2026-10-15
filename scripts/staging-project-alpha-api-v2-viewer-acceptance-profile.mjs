import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildProjectAlphaApiV2AcceptanceConfig,
  PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES,
  validateProjectAlphaApiV2AcceptanceConfig,
} from "./staging-project-alpha-api-v2-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_PROFILE = "project-alpha-api-v2-viewer-acceptance";
export const PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG = Object.freeze({
  source: "apps/operations/wrangler.staging.json",
  production: "apps/operations/wrangler.jsonc",
  output: "apps/operations/wrangler.staging.project-alpha-api-v2-viewer-acceptance.json",
  secretNames: ".backups/operations-staging-secret-names.json",
});

export const VIEWER_ACCEPTANCE_VALUES = Object.freeze({
  VIEWER_INTEGRATION_ENABLED: "true",
  VIEWER_PROCESSING_ENABLED: "true",
});

export const VIEWER_ACCEPTANCE_IDENTITY = Object.freeze({
  VIEWER_BASE_URL: "https://viewer-staging.ledgetopdroneservices.com",
  VIEWER_SERVICE_KEY_ID: "staging-v1",
  VIEWER_EVENT_KEY_ID: "viewer-staging-v1",
});

const VIEWER_BASELINE_IDENTITY = Object.freeze({
  ...VIEWER_ACCEPTANCE_IDENTITY,
  VIEWER_SERVICE_KEY_ID: "ops-staging-v1",
});

export const VIEWER_ACCEPTANCE_SECRET_NAMES = Object.freeze(["VIEWER_SERVICE_HMAC_SECRET"]);

const VIEWER_REMAINING_DEFAULT_OFF = Object.freeze([
  "VIEWER_PUBLIC_SHARES_ENABLED",
  "VIEWER_WORKSPACE_RENEWAL_CORS_ENABLED",
]);

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`${label} must contain strict JSON`); }
}
const sameSet = (left, right) => Array.isArray(left) && left.length === new Set(left).size &&
  left.length === right.length && left.every((name) => right.includes(name));

export function validateOperationsSecretNameInventory(inventory) {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory) ||
      !isDeepStrictEqual(Object.keys(inventory).sort(), ["names"])) {
    return ["Operations secret-name inventory must contain only a names array; secret values are prohibited"];
  }
  if (!Array.isArray(inventory.names) || !inventory.names.every((name) => typeof name === "string") ||
      !sameSet(inventory.names, VIEWER_ACCEPTANCE_SECRET_NAMES)) {
    return ["Viewer secret names must exactly match the approved live binding inventory"];
  }
  return [];
}

function validateViewerSource(source, production) {
  const errors = [];
  for (const flag of [...Object.keys(VIEWER_ACCEPTANCE_VALUES), ...VIEWER_REMAINING_DEFAULT_OFF]) {
    if (source?.vars?.[flag] !== "false") errors.push(`Operations base staging config must set ${flag}=false`);
  }
  for (const [name, expected] of Object.entries(VIEWER_BASELINE_IDENTITY)) {
    if (source?.vars?.[name] !== expected) errors.push(`Operations base staging config must set ${name}=${expected}`);
  }
  return errors;
}

export function buildProjectAlphaApiV2ViewerAcceptanceConfig(source, production, secretNames) {
  const fiveGate = buildProjectAlphaApiV2AcceptanceConfig(source, production);
  const errors = [...validateViewerSource(source, production), ...validateOperationsSecretNameInventory(secretNames)];
  if (errors.length) throw new Error(errors.join("\n"));
  const candidate = structuredClone(fiveGate);
  Object.assign(candidate.vars, VIEWER_ACCEPTANCE_VALUES, VIEWER_ACCEPTANCE_IDENTITY);
  return candidate;
}

export function validateProjectAlphaApiV2ViewerAcceptanceConfig(source, candidate, production, secretNames) {
  const errors = [
    ...validateViewerSource(source, production),
    ...validateOperationsSecretNameInventory(secretNames),
  ];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    errors.push(`Operations ${PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_PROFILE} candidate must be a JSON object`);
    return errors;
  }
  let fiveGate;
  try { fiveGate = buildProjectAlphaApiV2AcceptanceConfig(source, production); }
  catch (error) { errors.push(error.message); return errors; }
  const fiveGateErrors = validateProjectAlphaApiV2AcceptanceConfig(source, fiveGate, production);
  if (fiveGateErrors.length) errors.push(...fiveGateErrors);
  const expected = structuredClone(fiveGate);
  Object.assign(expected.vars, VIEWER_ACCEPTANCE_VALUES, VIEWER_ACCEPTANCE_IDENTITY);
  if (!isDeepStrictEqual(candidate, expected)) {
    errors.push(`Operations ${PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_PROFILE} candidate drifted outside the composed seven-gate staging window`);
  }
  for (const [flag, value] of Object.entries({ ...PROJECT_ALPHA_API_V2_ACCEPTANCE_VALUES, ...VIEWER_ACCEPTANCE_VALUES })) {
    if (candidate.vars?.[flag] !== value) errors.push(`Operations composed acceptance candidate must set ${flag}=${value}`);
  }
  for (const flag of VIEWER_REMAINING_DEFAULT_OFF) {
    if (candidate.vars?.[flag] !== "false") errors.push(`Operations composed acceptance candidate must keep ${flag}=false`);
  }
  for (const [name, expectedValue] of Object.entries(VIEWER_ACCEPTANCE_IDENTITY)) {
    if (candidate.vars?.[name] !== expectedValue) errors.push(`Operations composed acceptance candidate must set ${name}=${expectedValue}`);
  }
  return errors;
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("usage: node scripts/staging-project-alpha-api-v2-viewer-acceptance-profile.mjs --write|--check");
  }
  return argv[0];
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parseArguments(argv);
  const resolve = (relative) => path.join(base, relative);
  for (const input of [PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.source, PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.production]) {
    if (!fs.existsSync(resolve(input))) throw new Error(`${input} is missing; no candidate was generated`);
  }
  const source = readJson(resolve(PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.source), PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.source);
  const production = readJson(resolve(PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.production), PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.production);
  const secretPath = resolve(PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.secretNames);
  if (!fs.existsSync(secretPath)) throw new Error(`${PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.secretNames} is missing; provide names only, never secret values`);
  const secretNames = readJson(secretPath, PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.secretNames);
  const expected = buildProjectAlphaApiV2ViewerAcceptanceConfig(source, production, secretNames);
  const outputPath = resolve(PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.output);
  const candidate = fs.existsSync(outputPath)
    ? readJson(outputPath, PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.output) : expected;
  const errors = validateProjectAlphaApiV2ViewerAcceptanceConfig(source, candidate, production, secretNames);
  if (errors.length) throw new Error(`${PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_PROFILE} config is invalid or stale:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  if (mode === "--check") {
    if (!fs.existsSync(outputPath)) throw new Error(`${PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.output} missing; generate with --write`);
    console.log(`Validated ignored ${PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_PROFILE} config and names-only secret inventory. No remote action was performed.`);
    return PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.output;
  }
  if (fs.existsSync(outputPath)) {
    console.log(`Ignored ${PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_PROFILE} config is current. It was not overwritten.`);
    return PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.output;
  }
  const temporary = `${outputPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, outputPath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  console.log(`Wrote ignored ${PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_PROFILE} config. No remote action was performed.`);
  return PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) { console.error(`${PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_PROFILE} profile failed: ${error.message}`); process.exitCode = 1; }
}
