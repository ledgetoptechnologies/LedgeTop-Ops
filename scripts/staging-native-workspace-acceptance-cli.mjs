import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildNativeWorkspaceAcceptanceConfigs,
  validateNativeWorkspaceAcceptanceConfigs,
} from "./staging-native-workspace-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const NATIVE_WORKSPACE_ACCEPTANCE_PROFILE_NAME = "native-workspace-acceptance";
export const NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS = Object.freeze({
  delivery: Object.freeze({ source: "apps/client/wrangler.staging.json", production: "apps/client/wrangler.jsonc",
    output: "apps/client/wrangler.staging.native-workspace-acceptance.json" }),
  operations: Object.freeze({ source: "apps/operations/wrangler.staging.json", production: "apps/operations/wrangler.jsonc",
    output: "apps/operations/wrangler.staging.native-workspace-acceptance.json" }),
});

function parse(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0]))
    throw new Error("usage: node scripts/staging-native-workspace-acceptance-cli.mjs --write|--check");
  return argv[0];
}

function regularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}

function readJson(file, label) {
  regularFile(file, label);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`${label} must contain strict JSON`); }
}

function ignored(base, relative) {
  const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", relative], {
    cwd: base, encoding: "utf8", windowsHide: true,
  });
  if (result.error) throw new Error(`cannot verify Git ignore status for ${relative}: ${result.error.message}`);
  if (![0, 1].includes(result.status)) throw new Error(`cannot verify Git ignore status for ${relative}: ${result.stderr.trim() || `git exited ${result.status}`}`);
  return result.status === 0;
}

function canonicalWithin(base, candidate, label) {
  const canonicalBase = fs.realpathSync(base);
  let canonical;
  try { canonical = fs.realpathSync(candidate); }
  catch { throw new Error(`${label} is missing`); }
  if (canonical !== canonicalBase && !canonical.startsWith(`${canonicalBase}${path.sep}`)) {
    throw new Error(`${label} must remain below the workspace root`);
  }
  return canonical;
}

function inputs(base) {
  const sources = {}, production = {};
  for (const [app, files] of Object.entries(NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS)) {
    const source = path.join(base, files.source), productionFile = path.join(base, files.production);
    regularFile(source, files.source); canonicalWithin(base, source, files.source);
    regularFile(productionFile, files.production); canonicalWithin(base, productionFile, files.production);
    sources[app] = readJson(source, files.source);
    production[app] = readJson(productionFile, files.production);
    if (!ignored(base, files.output)) throw new Error(`${files.output} must be ignored before candidate generation`);
  }
  return { sources, production };
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parse(argv), resolvedBase = path.resolve(base);
  canonicalWithin(resolvedBase, resolvedBase, "workspace root");
  const { sources, production } = inputs(resolvedBase);
  const expected = buildNativeWorkspaceAcceptanceConfigs(sources, production);
  const candidates = {};
  for (const [app, files] of Object.entries(NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS)) {
    const output = path.join(resolvedBase, files.output);
    canonicalWithin(resolvedBase, path.dirname(output), path.dirname(files.output));
    if (fs.existsSync(output)) canonicalWithin(resolvedBase, output, files.output);
    candidates[app] = fs.existsSync(output) ? readJson(output, files.output) : expected[app];
  }
  const errors = validateNativeWorkspaceAcceptanceConfigs(sources, candidates, production);
  if (errors.length) throw new Error(`${NATIVE_WORKSPACE_ACCEPTANCE_PROFILE_NAME} config is invalid or stale:\n${errors.map(error => `- ${error}`).join("\n")}`);
  if (mode === "--check") {
    const missing = Object.values(NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS).filter(files => !fs.existsSync(path.join(resolvedBase, files.output)));
    if (missing.length) throw new Error(`${missing.map(files => files.output).join(", ")} missing; generate with --write`);
    console.log(`Validated ignored ${NATIVE_WORKSPACE_ACCEPTANCE_PROFILE_NAME} configs. No remote action was performed.`);
    return Object.values(NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS).map(files => files.output);
  }
  const pending = [];
  try {
    for (const [app, files] of Object.entries(NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS)) {
      const output = path.join(resolvedBase, files.output);
      if (fs.existsSync(output)) continue;
      const parent = path.dirname(output);
      regularFile(path.join(resolvedBase, files.source), files.source);
      canonicalWithin(resolvedBase, parent, path.dirname(files.output));
      const temporary = `${output}.tmp-${process.pid}`;
      fs.writeFileSync(temporary, `${JSON.stringify(expected[app], null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      pending.push({ temporary, output });
    }
    for (const item of pending) fs.renameSync(item.temporary, item.output);
  } finally {
    for (const { temporary } of pending) if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  console.log(`Wrote ignored ${NATIVE_WORKSPACE_ACCEPTANCE_PROFILE_NAME} configs. No remote action was performed.`);
  return Object.values(NATIVE_WORKSPACE_ACCEPTANCE_CONFIGS).map(files => files.output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); } catch (error) { console.error(`Native workspace acceptance CLI failed: ${error.message}`); process.exitCode = 1; }
}
