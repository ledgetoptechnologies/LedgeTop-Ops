import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildProjectAlphaApiV2ViewerAcceptanceConfig,
  PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG,
  validateProjectAlphaApiV2ViewerAcceptanceConfig,
} from "./staging-project-alpha-api-v2-viewer-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DIRECTORY_ADOPTION_ACCEPTANCE_PROFILE = "project-alpha-directory-adoption-acceptance";
export const DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG = Object.freeze({
  source: PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.source,
  production: PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.production,
  secretNames: PROJECT_ALPHA_API_V2_VIEWER_ACCEPTANCE_CONFIG.secretNames,
  output: "apps/operations/wrangler.staging.project-alpha-directory-adoption-acceptance.json",
});
export const DIRECTORY_ADOPTION_ACCEPTANCE_VALUES = Object.freeze({
  PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED: "true",
  PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED: "true",
});

function regularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}
function canonicalWithin(base, candidate, label) {
  const canonicalBase = fs.realpathSync(base);
  let canonical;
  try { canonical = fs.realpathSync(candidate); } catch { throw new Error(`${label} is missing`); }
  if (canonical !== canonicalBase && !canonical.startsWith(`${canonicalBase}${path.sep}`))
    throw new Error(`${label} must remain below the workspace root`);
  return canonical;
}
function readJson(file, label) {
  regularFile(file, label);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`${label} must contain strict JSON`); }
}
function ignored(base, relative) {
  const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", relative],
    { cwd: base, encoding: "utf8", windowsHide: true });
  if (result.error) throw new Error(`cannot verify Git ignore status for ${relative}: ${result.error.message}`);
  if (![0, 1].includes(result.status)) throw new Error(`cannot verify Git ignore status for ${relative}`);
  return result.status === 0;
}
function validateDefaultOff(source, production) {
  const errors = [];
  for (const flag of Object.keys(DIRECTORY_ADOPTION_ACCEPTANCE_VALUES)) {
    if (source?.vars?.[flag] !== "false") errors.push(`Operations base staging config must set ${flag}=false`);
    if (flag === "PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED") {
      const value = production?.vars?.[flag];
      if (value !== undefined && value !== "false")
        errors.push(`Operations production config must omit ${flag} or set it to the string false`);
    } else if (production?.vars?.[flag] !== "false") {
      errors.push(`Operations production config must set ${flag}=false`);
    }
  }
  return errors;
}

export function buildDirectoryAdoptionAcceptanceConfig(source, production, secretNames) {
  const composed = buildProjectAlphaApiV2ViewerAcceptanceConfig(source, production, secretNames);
  const errors = validateDefaultOff(source, production);
  if (errors.length) throw new Error(errors.join("\n"));
  const candidate = structuredClone(composed);
  Object.assign(candidate.vars, DIRECTORY_ADOPTION_ACCEPTANCE_VALUES);
  return candidate;
}

export function validateDirectoryAdoptionAcceptanceConfig(source, candidate, production, secretNames) {
  const errors = validateDefaultOff(source, production);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    errors.push(`Operations ${DIRECTORY_ADOPTION_ACCEPTANCE_PROFILE} candidate must be a JSON object`);
    return errors;
  }
  let composed;
  try { composed = buildProjectAlphaApiV2ViewerAcceptanceConfig(source, production, secretNames); }
  catch (error) { errors.push(error.message); return errors; }
  errors.push(...validateProjectAlphaApiV2ViewerAcceptanceConfig(source, composed, production, secretNames));
  const expected = structuredClone(composed);
  Object.assign(expected.vars, DIRECTORY_ADOPTION_ACCEPTANCE_VALUES);
  if (!isDeepStrictEqual(candidate, expected))
    errors.push(`Operations ${DIRECTORY_ADOPTION_ACCEPTANCE_PROFILE} candidate drifted outside the exact two-gate Directory adoption window`);
  for (const [flag, value] of Object.entries(DIRECTORY_ADOPTION_ACCEPTANCE_VALUES))
    if (candidate.vars?.[flag] !== value) errors.push(`Operations Directory adoption candidate must set ${flag}=${value}`);
  return errors;
}

function parse(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0]))
    throw new Error("usage: node scripts/staging-project-alpha-directory-adoption-acceptance-profile.mjs --write|--check");
  return argv[0];
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parse(argv), resolvedBase = path.resolve(base);
  canonicalWithin(resolvedBase, resolvedBase, "workspace root");
  const load = (relative) => {
    const file = path.join(resolvedBase, relative); regularFile(file, relative); canonicalWithin(resolvedBase, file, relative);
    return readJson(file, relative);
  };
  const source = load(DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.source);
  const production = load(DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.production);
  const secretNames = load(DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.secretNames);
  if (!ignored(resolvedBase, DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.output))
    throw new Error(`${DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.output} must be ignored before candidate generation`);
  const expected = buildDirectoryAdoptionAcceptanceConfig(source, production, secretNames);
  const outputPath = path.join(resolvedBase, DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.output);
  canonicalWithin(resolvedBase, path.dirname(outputPath), path.dirname(DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.output));
  if (fs.existsSync(outputPath)) canonicalWithin(resolvedBase, outputPath, DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.output);
  const candidate = fs.existsSync(outputPath) ? readJson(outputPath, DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.output) : expected;
  const errors = validateDirectoryAdoptionAcceptanceConfig(source, candidate, production, secretNames);
  if (errors.length) throw new Error(`${DIRECTORY_ADOPTION_ACCEPTANCE_PROFILE} config is invalid or stale:\n${errors.map(error => `- ${error}`).join("\n")}`);
  if (mode === "--check") {
    if (!fs.existsSync(outputPath)) throw new Error(`${DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.output} missing; generate with --write`);
    console.log(`Validated ignored ${DIRECTORY_ADOPTION_ACCEPTANCE_PROFILE} config. No remote action was performed.`);
    return DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.output;
  }
  if (fs.existsSync(outputPath)) {
    console.log(`Ignored ${DIRECTORY_ADOPTION_ACCEPTANCE_PROFILE} config is current. It was not overwritten.`);
    return DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.output;
  }
  const temporary = `${outputPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, outputPath);
  } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
  console.log(`Wrote ignored ${DIRECTORY_ADOPTION_ACCEPTANCE_PROFILE} config. No remote action was performed.`);
  return DIRECTORY_ADOPTION_ACCEPTANCE_CONFIG.output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); } catch (error) { console.error(`${DIRECTORY_ADOPTION_ACCEPTANCE_PROFILE} profile failed: ${error.message}`); process.exitCode = 1; }
}
