import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT_ID = "846c924bf17bf4f3dd15c97a4c5d1d51";
const DATABASE_ID = "78b34173-b168-4e3d-9832-bb9d245cc6b8";
const PROFILE_WRITES = "NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED";
const DRAIN = "NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED";
const RECOVERY_FLAGS = Object.freeze([
  "PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED",
  "PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED",
]);

export const DIRECTORY_SCALAR_DRAIN_ACCEPTANCE_OUTPUT =
  "apps/operations/wrangler.staging.directory-scalar-drain-acceptance.json";

const fail = message => { throw new Error(`directory-scalar-drain-acceptance-cli: ${message}`); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

function parse(argv) {
  if (argv.length !== 3 || !["--write", "--check"].includes(argv[0])
    || argv[1] !== "--operations-source-config" || !argv[2])
    fail("usage: --write|--check --operations-source-config <workspace-local-ignored-json>; no secret, network, or remote-operation arguments are accepted");
  return { mode: argv[0], source: argv[2] };
}

function regularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { fail(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular non-symlink file`);
}

function relativeWithin(base, candidate, label) {
  const relative = path.relative(base, candidate);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    fail(`${label} must remain below the workspace root`);
  return relative;
}

function canonicalWithin(base, candidate, label) {
  let canonical;
  try { canonical = fs.realpathSync(candidate); } catch { fail(`${label} is missing`); }
  relativeWithin(base, canonical, label);
  return canonical;
}

function ignored(base, candidate, label) {
  const relative = relativeWithin(base, candidate, label);
  const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", relative], {
    cwd: base, encoding: "utf8", windowsHide: true,
  });
  if (result.error || ![0, 1].includes(result.status)) fail(`cannot verify ignore status for ${label}`);
  if (result.status !== 0) fail(`${label} must be ignored`);
}

function readJson(file, label) {
  regularFile(file, label);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { fail(`${label} must contain strict JSON`); }
}

function exactTarget(source) {
  if (!plain(source) || source.name !== "ledgetop-ops-staging" || source.account_id !== ACCOUNT_ID
    || !plain(source.vars) || source.vars.ENVIRONMENT !== "staging"
    || !Array.isArray(source.d1_databases)) fail("exact Operations staging target required");
  const databases = source.d1_databases.filter(row => plain(row) && row.binding === "OPS_DB");
  if (databases.length !== 1 || databases[0].database_name !== "ltds-ops-staging"
    || databases[0].database_id !== DATABASE_ID) fail("exact Operations staging target required");
}

export function buildDirectoryScalarDrainAcceptanceConfig(source) {
  exactTarget(source);
  if (source.vars[PROFILE_WRITES] !== "true") fail(`${PROFILE_WRITES} must already be true`);
  if (source.vars[DRAIN] !== "false") fail(`${DRAIN} must be false in the provider-preserved source`);
  for (const flag of RECOVERY_FLAGS)
    if (source.vars[flag] !== "false") fail(`${flag} must be false in the provider-preserved source`);
  const candidate = structuredClone(source);
  candidate.vars[DRAIN] = "true";
  return candidate;
}

export function validateDirectoryScalarDrainAcceptanceConfig(source, candidate) {
  const expected = buildDirectoryScalarDrainAcceptanceConfig(source);
  if (!isDeepStrictEqual(candidate, expected)) fail("candidate drifted outside the exact drain-only delta");
  return true;
}

export function run(argv = process.argv.slice(2), base = root) {
  const { mode, source } = parse(argv);
  let canonicalBase;
  try { canonicalBase = fs.realpathSync(path.resolve(base)); } catch { fail("workspace root is missing"); }
  const sourceFile = path.resolve(canonicalBase, source);
  relativeWithin(canonicalBase, sourceFile, "operations source");
  regularFile(sourceFile, "operations source");
  const canonicalSource = canonicalWithin(canonicalBase, sourceFile, "operations source");
  ignored(canonicalBase, sourceFile, "operations source");
  const sourceConfig = readJson(canonicalSource, "operations source");
  const expected = buildDirectoryScalarDrainAcceptanceConfig(sourceConfig);

  const output = path.resolve(canonicalBase, DIRECTORY_SCALAR_DRAIN_ACCEPTANCE_OUTPUT);
  relativeWithin(canonicalBase, output, "acceptance output");
  canonicalWithin(canonicalBase, path.dirname(output), "acceptance output directory");
  ignored(canonicalBase, output, "acceptance output");
  if (fs.existsSync(output)) {
    regularFile(output, "acceptance output");
    const canonicalOutput = canonicalWithin(canonicalBase, output, "acceptance output");
    validateDirectoryScalarDrainAcceptanceConfig(sourceConfig, readJson(canonicalOutput, "acceptance output"));
    console.log(`Validated existing ignored ${DIRECTORY_SCALAR_DRAIN_ACCEPTANCE_OUTPUT}. It was not overwritten.`);
    return DIRECTORY_SCALAR_DRAIN_ACCEPTANCE_OUTPUT;
  }
  if (mode === "--check") fail(`acceptance output is missing; generate with --write`);

  const temporary = `${output}.tmp-${process.pid}-${randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`, {
      encoding: "utf8", flag: "wx", mode: 0o600,
    });
    try { fs.linkSync(temporary, output); }
    catch (error) {
      if (error?.code === "EEXIST") fail("acceptance output appeared concurrently; no existing file was overwritten");
      throw error;
    }
  } finally {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch { /* output remains valid */ }
  }
  console.log(`Wrote ignored ${DIRECTORY_SCALAR_DRAIN_ACCEPTANCE_OUTPUT}. No remote action was performed.`);
  return DIRECTORY_SCALAR_DRAIN_ACCEPTANCE_OUTPUT;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
