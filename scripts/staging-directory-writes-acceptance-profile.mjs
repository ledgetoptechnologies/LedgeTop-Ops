import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

import { validateApp } from "./staging-preflight.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isObject = value => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const DIRECTORY_WRITES_ACCEPTANCE_PROFILE = "directory-writes-acceptance";
export const DIRECTORY_WRITES_ACCEPTANCE_CONFIG = Object.freeze({
  source: "apps/operations/wrangler.staging.json",
  production: "apps/operations/wrangler.jsonc",
  output: "apps/operations/wrangler.staging.directory-writes-acceptance.json",
});
export const DIRECTORY_WRITES_ACCEPTANCE_VALUES = Object.freeze({
  NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED: "true",
  NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: "true",
});

const readJson = file => JSON.parse(fs.readFileSync(file, "utf8"));

function sourceErrors(source, production) {
  const errors = [];
  if (!isObject(source)) errors.push("Operations default staging source must be a JSON object");
  if (!isObject(production)) errors.push("Operations production baseline must be a JSON object");
  if (isObject(source) && isObject(production)) errors.push(...validateApp("operations", source, production));
  for (const flag of Object.keys(DIRECTORY_WRITES_ACCEPTANCE_VALUES)) {
    if (source?.vars?.[flag] !== "false") errors.push(`Operations default staging config must set ${flag}=false`);
    if (production?.vars?.[flag] !== undefined && production.vars[flag] !== "false")
      errors.push(`Operations production config must omit ${flag} or set it to the string false`);
  }
  return errors;
}

export function buildDirectoryWritesAcceptanceConfig(source, production) {
  const errors = sourceErrors(source, production);
  if (errors.length) throw new Error(errors.join("\n"));
  const candidate = structuredClone(source);
  Object.assign(candidate.vars, DIRECTORY_WRITES_ACCEPTANCE_VALUES);
  return candidate;
}

export function validateDirectoryWritesAcceptanceConfig(source, candidate, production) {
  const errors = sourceErrors(source, production);
  if (!isObject(candidate)) {
    errors.push(`Operations ${DIRECTORY_WRITES_ACCEPTANCE_PROFILE} candidate must be a JSON object`);
    return errors;
  }
  if (!errors.length) {
    const expected = structuredClone(source);
    Object.assign(expected.vars, DIRECTORY_WRITES_ACCEPTANCE_VALUES);
    if (!isDeepStrictEqual(candidate, expected))
      errors.push(`Operations ${DIRECTORY_WRITES_ACCEPTANCE_PROFILE} candidate drifted outside the exact two-gate staging window`);
  }
  for (const [flag, value] of Object.entries(DIRECTORY_WRITES_ACCEPTANCE_VALUES))
    if (candidate.vars?.[flag] !== value) errors.push(`Operations directory-write acceptance candidate must set ${flag}=${value}`);
  return errors;
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0]))
    throw new Error("usage: node scripts/staging-directory-writes-acceptance-profile.mjs --write|--check");
  return argv[0];
}

function loadInputs(base) {
  const sourcePath = path.join(base, DIRECTORY_WRITES_ACCEPTANCE_CONFIG.source);
  const productionPath = path.join(base, DIRECTORY_WRITES_ACCEPTANCE_CONFIG.production);
  if (!fs.existsSync(sourcePath)) throw new Error(`${DIRECTORY_WRITES_ACCEPTANCE_CONFIG.source} is missing`);
  if (!fs.existsSync(productionPath)) throw new Error(`${DIRECTORY_WRITES_ACCEPTANCE_CONFIG.production} is missing`);
  return { source: readJson(sourcePath), production: readJson(productionPath) };
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parseArguments(argv);
  const { source, production } = loadInputs(base);
  const expected = buildDirectoryWritesAcceptanceConfig(source, production);
  const outputPath = path.join(base, DIRECTORY_WRITES_ACCEPTANCE_CONFIG.output);
  const candidate = fs.existsSync(outputPath) ? readJson(outputPath) : expected;
  const errors = validateDirectoryWritesAcceptanceConfig(source, candidate, production);
  if (errors.length) throw new Error(`${DIRECTORY_WRITES_ACCEPTANCE_PROFILE} config is invalid or stale:\n${errors.map(error => `- ${error}`).join("\n")}`);
  if (mode === "--check") {
    if (!fs.existsSync(outputPath)) throw new Error(`${DIRECTORY_WRITES_ACCEPTANCE_CONFIG.output} missing; generate with --write`);
    console.log(`Validated ignored ${DIRECTORY_WRITES_ACCEPTANCE_PROFILE} config. No remote action was performed.`);
    return DIRECTORY_WRITES_ACCEPTANCE_CONFIG.output;
  }
  if (fs.existsSync(outputPath)) {
    console.log(`Ignored ${DIRECTORY_WRITES_ACCEPTANCE_PROFILE} config is current. It was not overwritten.`);
    return DIRECTORY_WRITES_ACCEPTANCE_CONFIG.output;
  }
  const temporary = `${outputPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, outputPath);
  } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
  console.log(`Wrote ignored ${DIRECTORY_WRITES_ACCEPTANCE_PROFILE} config. No remote action was performed.`);
  return DIRECTORY_WRITES_ACCEPTANCE_CONFIG.output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); } catch (error) { console.error(`${DIRECTORY_WRITES_ACCEPTANCE_PROFILE} profile failed: ${error.message}`); process.exitCode = 1; }
}
