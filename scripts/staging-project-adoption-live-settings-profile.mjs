import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG } from "./staging-project-alpha-project-adoption-finalization-acceptance-profile.mjs";
import { buildProjectAdoptionLiveSettingsPreservedConfig } from "./staging-project-adoption-live-settings-preservation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT =
  "apps/operations/wrangler.staging.project-alpha-project-adoption-finalization-live-preserved.json";
export const PROJECT_ADOPTION_LIVE_PREFLIGHT_MAX_AGE_MS = 5 * 60 * 1000;
export const PROJECT_ADOPTION_LIVE_PREFLIGHT_MAX_FUTURE_SKEW_MS = 30 * 1000;

const exactKeys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...expected].sort());

function fail(message) {
  throw new Error(`project-adoption-live-settings-profile: ${message}`);
}

function parse(argv) {
  let mode;
  let snapshot;
  let preflight;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--write" || argument === "--check") {
      if (mode) fail("exactly one of --write or --check is required");
      mode = argument;
      continue;
    }
    if (argument === "--snapshot" || argument === "--preflight") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`${argument} requires a file path`);
      if (argument === "--snapshot") {
        if (snapshot) fail("--snapshot may be supplied only once");
        snapshot = value;
      } else {
        if (preflight) fail("--preflight may be supplied only once");
        preflight = value;
      }
      index += 1;
      continue;
    }
    fail("unsupported argument; no secret or remote-operation arguments are accepted");
  }
  if (!mode || !snapshot || !preflight)
    fail("usage: --write|--check --snapshot <ignored-json> --preflight <ignored-json>");
  return { mode, snapshot, preflight };
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
  canonicalWithin(canonicalBase, file, label);
  return { file, value: readJson(file, label) };
}

function loadIgnoredInput(canonicalBase, supplied, label) {
  const file = path.resolve(canonicalBase, supplied);
  regularFile(file, label);
  const canonical = canonicalWithin(canonicalBase, file, label);
  ignored(canonicalBase, canonical, label);
  return readJson(canonical, label);
}

function parseObservedAt(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    fail("preflight observedAt must be a canonical UTC millisecond timestamp");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value)
    fail("preflight observedAt must be a canonical UTC millisecond timestamp");
  return timestamp;
}

function unwrapFreshPreflight(wrapper, nowMs) {
  if (!exactKeys(wrapper, ["schemaVersion", "environment", "observedAt", "activeVersionPreflight"])
    || wrapper.schemaVersion !== 1 || wrapper.environment !== "staging")
    fail("preflight wrapper must be the exact staging schema version 1");
  if (!Number.isFinite(nowMs)) fail("clock must return finite epoch milliseconds");
  const observedAt = parseObservedAt(wrapper.observedAt);
  if (observedAt > nowMs + PROJECT_ADOPTION_LIVE_PREFLIGHT_MAX_FUTURE_SKEW_MS)
    fail("preflight observation is too far in the future");
  if (nowMs - observedAt > PROJECT_ADOPTION_LIVE_PREFLIGHT_MAX_AGE_MS)
    fail("preflight observation is stale");
  return wrapper.activeVersionPreflight;
}

function verifyExistingOutput(file, expected, mode) {
  const existing = readJson(file, "live-preserved output");
  if (!isDeepStrictEqual(existing, expected))
    fail(`existing live-preserved output is stale or conflicting; ${mode} did not overwrite it`);
}

function writeExclusiveAtomic(file, expected) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try { fs.linkSync(temporary, file); }
    catch (error) {
      if (error?.code === "EEXIST") fail("live-preserved output appeared concurrently and was not overwritten");
      throw error;
    }
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
}

export function run(argv = process.argv.slice(2), base = root, clock = () => Date.now()) {
  const { mode, snapshot: snapshotArgument, preflight: preflightArgument } = parse(argv);
  let canonicalBase;
  try { canonicalBase = fs.realpathSync(path.resolve(base)); }
  catch { fail("workspace root is missing"); }

  const source = loadRepositoryJson(canonicalBase,
    PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.source, "base staging config").value;
  const production = loadRepositoryJson(canonicalBase,
    PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.production, "production config").value;
  const baseline = loadRepositoryJson(canonicalBase,
    PROJECT_ADOPTION_FINALIZATION_ACCEPTANCE_CONFIG.output, "generic finalization candidate");
  ignored(canonicalBase, baseline.file, "generic finalization candidate");

  const snapshot = loadIgnoredInput(canonicalBase, snapshotArgument, "live-settings snapshot");
  const preflightWrapper = loadIgnoredInput(canonicalBase, preflightArgument, "active-version preflight");
  const activeVersionPreflight = unwrapFreshPreflight(preflightWrapper, clock());
  const expected = buildProjectAdoptionLiveSettingsPreservedConfig(
    source,
    baseline.value,
    production,
    snapshot,
    activeVersionPreflight,
  );

  const output = path.resolve(canonicalBase, PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT);
  relativeWithin(canonicalBase, output, "live-preserved output");
  canonicalWithin(canonicalBase, path.dirname(output), "live-preserved output directory");
  ignored(canonicalBase, output, "live-preserved output");

  if (fs.existsSync(output)) {
    regularFile(output, "live-preserved output");
    canonicalWithin(canonicalBase, output, "live-preserved output");
    verifyExistingOutput(output, expected, mode);
    console.log(`Validated existing ignored ${PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT}. It was not overwritten.`);
    return PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT;
  }
  if (mode === "--check") fail(`live-preserved output is missing; generate it with --write`);
  writeExclusiveAtomic(output, expected);
  console.log(`Wrote ignored ${PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT}. No remote action was performed.`);
  return PROJECT_ADOPTION_LIVE_SETTINGS_OUTPUT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) {
    console.error(`project-adoption-live-settings-profile failed: ${error.message}`);
    process.exitCode = 1;
  }
}
