import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { NATIVE_PORTAL_ACCEPTANCE_CONFIGS } from "./staging-native-portal-acceptance-profile.mjs";
import {
  buildPaNativePortalAcceptanceConfigs,
  PA_NATIVE_PORTAL_ACCEPTANCE_APPS,
  validatePaNativePortalAcceptanceConfigs,
} from "./staging-pa-native-portal-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS = Object.freeze({
  delivery: "apps/client/wrangler.staging.pa-native-portal-acceptance.json",
  operations: "apps/operations/wrangler.staging.pa-native-portal-acceptance.json",
});

function fail(message) {
  throw new Error(`pa-native-portal-acceptance-cli: ${message}`);
}

function parse(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0]))
    fail("usage: --write|--check; no secret, network, or remote-operation arguments are accepted");
  return argv[0];
}

function regularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { fail(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
}

function canonicalWithin(canonicalBase, candidate, label) {
  let canonical;
  try { canonical = fs.realpathSync(candidate); }
  catch { fail(`${label} is missing`); }
  const relative = path.relative(canonicalBase, canonical);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    fail(`${label} must remain below the workspace root`);
  return canonical;
}

function relativeWithin(canonicalBase, candidate, label) {
  const relative = path.relative(canonicalBase, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    fail(`${label} must remain below the workspace root`);
  return relative;
}

function ignored(canonicalBase, file, label) {
  const relative = relativeWithin(canonicalBase, file, label);
  const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", relative], {
    cwd: canonicalBase,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || ![0, 1].includes(result.status)) fail(`cannot verify ignore status for ${label}`);
  if (result.status !== 0) fail(`${label} must be ignored`);
}

function readJson(file, label) {
  regularFile(file, label);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { fail(`${label} must contain strict JSON`); }
}

function loadRepositoryJson(canonicalBase, relative, label) {
  const file = path.resolve(canonicalBase, relative);
  regularFile(file, label);
  const canonical = canonicalWithin(canonicalBase, file, label);
  return readJson(canonical, label);
}

function inspectOutput(canonicalBase, app, expected) {
  const label = `${app} acceptance output`;
  const file = path.resolve(canonicalBase, PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS[app]);
  relativeWithin(canonicalBase, file, label);
  canonicalWithin(canonicalBase, path.dirname(file), `${label} directory`);
  ignored(canonicalBase, file, label);
  if (!fs.existsSync(file)) return { app, file, missing: true };
  regularFile(file, label);
  const canonical = canonicalWithin(canonicalBase, file, label);
  const candidate = readJson(canonical, label);
  if (!isDeepStrictEqual(candidate, expected))
    fail(`${label} is stale or conflicting and was not overwritten`);
  return { app, file: canonical, missing: false };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function publishMissing(entries) {
  const prepared = [];
  const linked = [];
  try {
    for (const { app, file, expected } of entries) {
      const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
      fs.writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      prepared.push({ app, file, temporary, stat: fs.statSync(temporary, { bigint: true }) });
    }
    for (const item of prepared) {
      fs.linkSync(item.temporary, item.file);
      linked.push(item);
    }
  } catch (error) {
    for (const item of [...linked].reverse()) {
      try {
        const outputStat = fs.lstatSync(item.file, { bigint: true });
        if (outputStat.isFile() && !outputStat.isSymbolicLink() && sameFile(outputStat, item.stat))
          fs.unlinkSync(item.file);
      } catch { /* Preserve any path that is no longer the file created by this run. */ }
    }
    if (error?.code === "EEXIST") fail("an acceptance output appeared concurrently; no existing file was overwritten");
    throw error;
  } finally {
    for (const { temporary } of prepared) {
      try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      catch { /* The fixed outputs remain valid even if temporary cleanup needs operator attention. */ }
    }
  }
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parse(argv);
  let canonicalBase;
  try { canonicalBase = fs.realpathSync(path.resolve(base)); }
  catch { fail("workspace root is missing"); }

  const sources = {};
  const production = {};
  for (const app of PA_NATIVE_PORTAL_ACCEPTANCE_APPS) {
    const config = NATIVE_PORTAL_ACCEPTANCE_CONFIGS[app];
    sources[app] = loadRepositoryJson(canonicalBase, config.source, `${app} staging source`);
    production[app] = loadRepositoryJson(canonicalBase, config.production, `${app} production baseline`);
  }

  const expected = buildPaNativePortalAcceptanceConfigs(sources, production);
  const errors = validatePaNativePortalAcceptanceConfigs(sources, expected, production);
  if (errors.length) fail(`combined profile failed validation: ${errors.join("; ")}`);

  const inspected = PA_NATIVE_PORTAL_ACCEPTANCE_APPS.map(app =>
    inspectOutput(canonicalBase, app, expected[app]));
  const missing = inspected.filter(item => item.missing);
  if (mode === "--check" && missing.length)
    fail("one or more acceptance outputs are missing; generate the fixed pair with --write");
  if (mode === "--write" && missing.length) {
    publishMissing(missing.map(item => ({ ...item, expected: expected[item.app] })));
    console.log("Wrote the ignored PA plus native portal acceptance config pair. No remote action was performed.");
  } else {
    console.log("Validated the existing ignored PA plus native portal acceptance config pair. It was not overwritten.");
  }
  return PA_NATIVE_PORTAL_ACCEPTANCE_APPS.map(app => PA_NATIVE_PORTAL_ACCEPTANCE_OUTPUTS[app]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) {
    console.error(`pa-native-portal-acceptance-cli failed: ${error.message}`);
    process.exitCode = 1;
  }
}
