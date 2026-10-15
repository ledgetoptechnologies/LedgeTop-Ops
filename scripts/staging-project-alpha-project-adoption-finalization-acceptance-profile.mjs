import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import {
  buildProjectAlphaApiV2AcceptanceConfig,
  PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG,
  validateProjectAlphaApiV2AcceptanceConfig,
} from "./staging-project-alpha-api-v2-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_PROFILE = "project-alpha-project-adoption-finalization-acceptance";
export const PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG = Object.freeze({
  source: PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.source,
  production: PROJECT_ALPHA_API_V2_ACCEPTANCE_CONFIG.production,
  output: "apps/operations/wrangler.staging.project-alpha-project-adoption-finalization-acceptance.json",
});
export const PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_VALUES = Object.freeze({
  PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED: "true",
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
  const flag = "PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED";
  const errors = [];
  if (source?.vars?.[flag] !== "false") errors.push(`Operations base staging config must set ${flag}=false`);
  if (production?.vars?.[flag] !== "false") errors.push(`Operations production config must set ${flag}=false`);
  return errors;
}

export function buildProjectAdoptionFinalizationAcceptanceConfig(source, production) {
  const errors = validateDefaultOff(source, production);
  if (errors.length) throw new Error(errors.join("\n"));
  const composed = buildProjectAlphaApiV2AcceptanceConfig(source, production);
  const candidate = structuredClone(composed);
  Object.assign(candidate.vars, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_VALUES);
  return candidate;
}

export function validateProjectAdoptionFinalizationAcceptanceConfig(source, candidate, production) {
  const errors = validateDefaultOff(source, production);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    errors.push(`Operations ${PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_PROFILE} candidate must be a JSON object`);
    return errors;
  }
  let composed;
  try { composed = buildProjectAlphaApiV2AcceptanceConfig(source, production); }
  catch (error) { errors.push(error.message); return errors; }
  errors.push(...validateProjectAlphaApiV2AcceptanceConfig(source, composed, production));
  const expected = structuredClone(composed);
  Object.assign(expected.vars, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_VALUES);
  if (!isDeepStrictEqual(candidate, expected))
    errors.push(`Operations ${PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_PROFILE} candidate drifted outside the exact six-gate API-v2 plus finalization window`);
  for (const [flag, value] of Object.entries(PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_VALUES))
    if (candidate.vars?.[flag] !== value)
      errors.push(`Operations Project adoption finalization candidate must set ${flag}=${value}`);
  return errors;
}

function parse(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0]))
    throw new Error("usage: node scripts/staging-project-alpha-project-adoption-finalization-acceptance-profile.mjs --write|--check");
  return argv[0];
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parse(argv), resolvedBase = path.resolve(base);
  canonicalWithin(resolvedBase, resolvedBase, "workspace root");
  const load = (relative) => {
    const file = path.join(resolvedBase, relative);
    regularFile(file, relative);
    canonicalWithin(resolvedBase, file, relative);
    return readJson(file, relative);
  };
  const source = load(PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.source);
  const production = load(PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.production);
  if (!ignored(resolvedBase, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output))
    throw new Error(`${PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output} must be ignored before candidate generation`);
  const expected = buildProjectAdoptionFinalizationAcceptanceConfig(source, production);
  const outputPath = path.join(resolvedBase, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output);
  canonicalWithin(resolvedBase, path.dirname(outputPath), path.dirname(PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output));
  if (fs.existsSync(outputPath)) canonicalWithin(resolvedBase, outputPath, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output);
  const candidate = fs.existsSync(outputPath)
    ? readJson(outputPath, PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output) : expected;
  const errors = validateProjectAdoptionFinalizationAcceptanceConfig(source, candidate, production);
  if (errors.length) throw new Error(`${PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_PROFILE} config is invalid or stale:\n${errors.map(error => `- ${error}`).join("\n")}`);
  if (mode === "--check") {
    if (!fs.existsSync(outputPath))
      throw new Error(`${PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output} missing; generate with --write`);
    console.log(`Validated ignored ${PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_PROFILE} config. No remote action was performed.`);
    return PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output;
  }
  if (fs.existsSync(outputPath)) {
    console.log(`Ignored ${PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_PROFILE} config is current. It was not overwritten.`);
    return PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output;
  }
  const temporary = `${outputPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, outputPath);
  } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); }
  console.log(`Wrote ignored ${PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_PROFILE} config. No remote action was performed.`);
  return PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) {
    console.error(`${PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_PROFILE} profile failed: ${error.message}`);
    process.exitCode = 1;
  }
}
