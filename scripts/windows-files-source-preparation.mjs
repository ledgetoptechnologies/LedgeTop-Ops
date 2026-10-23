import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";
import { validateWindowsStagingProfile, renderWindowsStagingEntries } from "./windows-files-staging-entry-renderer.mjs";
import { assertWindowsStagingRuntimeExports } from "./windows-files-staging-exports.mjs";

export const WINDOWS_SOURCE_DIRECTORY = ".windows-files-source-preparation";
const APPS = [["operations", "operations", "src/worker/staging-native-authority-entrypoint.ts"], ["delivery", "client", "src/worker/index.ts"]];
const ORIGINS = { operations: "https://ops-staging.ledgetopdroneservices.com", delivery: "https://portal-staging.ledgetopdroneservices.com" };
const AUDIENCES = { operations: "559cd7c0d2cc47f271aac422412fce677a51443ec365d9f2c585d9c0e377cc0b", delivery: "8eed2de9972afe7d653de2adb68c1b0ef7c6462a9a694203b31d9a32f4248bbc" };
const ISSUER = "https://ledgetoptechnologies.cloudflareaccess.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REQUIRED_SERVICES = { operations: ["OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY", "OPERATIONS_PORTAL_WORKSPACE_PUBLICATION", "OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY"], delivery: ["OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER"] };
const SOURCE_PINS = ["scripts/windows-files-staging-entry-renderer.mjs", "scripts/windows-files-staging-exports.mjs", "scripts/windows-files-source-preparation.mjs", "scripts/staging-requirements.mjs",
  "apps/operations/src/worker/staging-native-authority-entrypoint.ts", "apps/operations/src/worker/windows-files-staging-worker.ts", "apps/client/src/worker/index.ts", "apps/client/src/worker/client-portal/windows-files-staging-worker.ts"];
const sha = value => createHash("sha256").update(value).digest("hex");
const jsonHash = value => sha(JSON.stringify(value));
const fail = suffix => { throw Error(`windows_source_preparation_${suffix}`); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

/** Source-only admission deliberately cannot produce an enabled entry or a config.
 * A real metadata observation and a synthetic compile gateway remain separate. */
export function prepareWindowsStagingSources(inputs) {
  if (!exact(inputs, ["profile", "preflight"])) fail("inputs_invalid");
  const { profile, preflight } = inputs;
  validateWindowsStagingProfile(profile);
  if (profile.enabled !== false) fail("must_be_disabled");
  if (preflight?.status !== "read_only_observed" || preflight.accountId !== STAGING_ACCOUNT_ID || preflight.versionBindingsMatchedInventory !== true
    || !Array.isArray(preflight.workers) || preflight.workers.length !== 2 || new Set(preflight.workers.map(w => w.app)).size !== 2) fail("preflight_invalid");
  for (const [app] of APPS) {
    const inventory = STAGING_INVENTORY[app], worker = preflight.workers.find(w => w.app === app);
    if (!worker || worker.workerName !== inventory.name || !UUID.test(worker.versionId) || worker.origin !== ORIGINS[app]
      || worker.audience !== AUDIENCES[app] || worker.issuer !== ISSUER || worker.foreignKeyViolationCount !== 0
      || !isDeepStrictEqual(worker.databases, inventory.d1_databases.map(b => ({ binding: b.binding, name: b.database_name, id: b.database_id })))
      || !isDeepStrictEqual(worker.buckets, inventory.r2_buckets.map(b => ({ binding: b.binding, name: b.bucket_name })))) fail("preflight_invalid");
    if (!Array.isArray(worker.services) || new Set(worker.services.map(s => s?.binding)).size !== worker.services.length
      || worker.services.some(s => !inventory.services.some(i => isDeepStrictEqual(s, { binding: i.binding, workerName: i.service, entrypoint: i.entrypoint })))
      || REQUIRED_SERVICES[app].some(binding => !worker.services.some(s => s.binding === binding))) fail("preflight_invalid");
  }
  const entries = renderWindowsStagingEntries(profile);
  return { entries, receipt: { schemaVersion: 1, status: "disabled_source_entries_only_not_configuration", enabled: false,
    profileSha256: jsonHash(profile), preflightSha256: jsonHash(preflight), entrySha256: Object.fromEntries(Object.entries(entries).map(([app, text]) => [app, sha(text)])),
    observedWorkers: preflight.workers.map(w => ({ app: w.app, workerName: w.workerName, versionId: w.versionId })),
    gatewayMetadata: { ...profile.gateway, purpose: "compile_input_only_not_runtime_ownership", provisioned: false },
    configWritten: false, secretsRead: false, physicallyVerified: false, canonicalBaselineVerified: false, uploaded: false, activated: false, deployReady: false,
    note: "Disabled source compilation only. Identity consistency is not observation freshness, gateway ownership, complete configuration preservation, runtime acceptance or deployment authorization." } };
}

function canonical(target, kind) {
  const resolved = path.resolve(target);
  if (resolved.startsWith("\\\\") || fs.lstatSync(resolved).isSymbolicLink() || fs.realpathSync(resolved).toLowerCase() !== resolved.toLowerCase()
    || (kind === "directory" ? !fs.statSync(resolved).isDirectory() : !fs.statSync(resolved).isFile())) fail("path_alias");
  return resolved;
}
function within(root, file) {
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail("path_alias");
  return relative;
}
function read(root, relative) {
  const file = canonical(path.join(root, relative), "file"); within(root, file);
  return fs.readFileSync(file);
}
function pins(root) { return Object.fromEntries(SOURCE_PINS.map(file => [file, sha(read(root, file))])); }
function targets(root) {
  root = canonical(root, "directory");
  return APPS.map(([app, directory, main]) => {
    const base = canonical(path.join(root, "apps", directory), "directory"); within(root, base);
    return { app, base, main, generated: path.join(base, WINDOWS_SOURCE_DIRECTORY) };
  });
}
/** New ignored source artifacts only. No Wrangler config is generated or read. */
export function writeWindowsStagingSources(root, inputs) {
  root = canonical(root, "directory");
  const result = prepareWindowsStagingSources(inputs), outputs = targets(root), sourceSha256 = pins(root);
  for (const output of outputs) if (fs.existsSync(output.generated)) fail("output_exists");
  const receipt = { ...result.receipt, sourceSha256 };
  // Check all destinations before writing either app. A partial failure is retained.
  for (const output of outputs) {
    fs.mkdirSync(output.generated);
    fs.writeFileSync(path.join(output.generated, "entrypoint.ts"), result.entries[output.app], { flag: "wx" });
    fs.writeFileSync(path.join(output.generated, "public-inputs.json"), JSON.stringify(inputs, null, 2) + "\n", { flag: "wx" });
    fs.writeFileSync(path.join(output.generated, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  }
  return receipt;
}
function load(root, target) {
  canonical(target.generated, "directory");
  const relative = file => path.relative(root, path.join(target.generated, file));
  const inputBytes = read(root, relative("public-inputs.json")), receiptBytes = read(root, relative("receipt.json"));
  if (inputBytes.length > 2 * 1024 * 1024 || receiptBytes.length > 2 * 1024 * 1024) fail("artifact_limit");
  const inputs = JSON.parse(inputBytes), receipt = JSON.parse(receiptBytes), expected = prepareWindowsStagingSources(inputs);
  if (!isDeepStrictEqual(receipt, { ...expected.receipt, sourceSha256: pins(root) })
    || !read(root, relative("entrypoint.ts")).equals(Buffer.from(expected.entries[target.app]))) fail("inputs_drifted");
  return { inputs, receipt };
}
/** esbuild represents browser:false replacements as a zero-byte virtual input.
 * Retain that explicit namespace; never invent a physical source hash for it. */
export function observeWindowsBundleInputs(root, inputs) {
  root = canonical(root, "directory");
  return Object.keys(inputs).sort().map(file => {
    if (file.startsWith("(disabled):")) {
      if (inputs[file].bytes !== 0) fail("bundle_input_invalid");
      within(root, path.resolve(root, file.slice("(disabled):".length)));
      return { inputName: file.split(path.sep).join("/"), kind: "esbuild_browser_disabled_virtual", sourceBytes: 0, physicalSourceSha256: null };
    }
    if (file.startsWith("(")) fail("bundle_input_invalid");
    const absolute = canonical(path.resolve(root, file), "file"), relative = within(root, absolute).split(path.sep).join("/");
    return { file: relative, kind: "physical_source", sha256: sha(fs.readFileSync(absolute)) };
  });
}
/** Real complete module graphs, with exact named export inventories. This is
 * neither Workerd startup nor a config/upload artifact. No deployment command. */
export async function buildWindowsStagingSourceModules(root) {
  root = canonical(root, "directory");
  const outputs = targets(root), initial = outputs.map(output => load(root, output));
  if (!isDeepStrictEqual(initial[0], initial[1])) fail("paired_inputs_drifted");
  for (const output of outputs) if (fs.existsSync(path.join(output.generated, "module-build"))) fail("output_exists");
  const observations = [];
  for (const [index, output] of outputs.entries()) {
    const require = createRequire(path.join(output.base, "package.json")), { build, version: esbuildVersion } = require("esbuild");
    const dest = path.join(output.generated, "module-build");
    const options = { bundle: true, format: "esm", platform: "browser", conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"], write: false, metafile: true, logLevel: "silent", absWorkingDir: root };
    const baseline = await build({ ...options, entryPoints: [path.join(output.base, output.main)], outfile: path.join(dest, "baseline.js") });
    const candidate = await build({ ...options, entryPoints: [path.join(output.generated, "entrypoint.ts")], outfile: path.join(dest, "entrypoint.js") });
    const exportsOf = result => Object.values(result.metafile.outputs).flatMap(o => o.exports).sort();
    const exports = exportsOf(candidate), policy = assertWindowsStagingRuntimeExports(output.app, exportsOf(baseline), exports);
    if (!isDeepStrictEqual(load(root, output), initial[index])) fail("inputs_drifted");
    const bundleInputs = observeWindowsBundleInputs(root, candidate.metafile.inputs);
    const observation = { app: output.app, exports, ...policy, esbuildVersion, moduleSha256: sha(candidate.outputFiles[0].contents), moduleBytes: candidate.outputFiles[0].contents.length,
      bundleInputCount: bundleInputs.length, bundleInputsSha256: jsonHash(bundleInputs), bundleInputs,
      bundleInputFilesObservedAfterBuild: true, compilerInputBytesAttested: false, atomicSourceSnapshot: false,
      inputEvidenceNote: "Physical input hashes are post-build filesystem observations, not exact esbuild loader-byte attestation or an atomic source snapshot. Virtual disabled inputs have no physical source hash." };
    fs.mkdirSync(dest);
    for (const file of candidate.outputFiles) fs.writeFileSync(file.path, file.contents, { flag: "wx" });
    observations.push(observation);
    fs.writeFileSync(path.join(dest, "build-receipt.json"), JSON.stringify({ schemaVersion: 1, status: "disabled_offline_modules_only_not_configuration", enabled: false,
      preparationReceiptSha256: jsonHash(initial[index].receipt), observation, configWritten: false, secretsRead: false, uploaded: false, activated: false, deployReady: false,
      workerdStartupTested: false, runtimeAcceptanceVerified: false }, null, 2) + "\n", { flag: "wx" });
  }
  return { schemaVersion: 1, status: "disabled_offline_modules_only_not_configuration", observations, configWritten: false, secretsRead: false, uploaded: false, activated: false, deployReady: false,
    workerdStartupTested: false, runtimeAcceptanceVerified: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 3 && args[0] === "--write-sources") {
    const file = canonical(args[1], "file"), bytes = fs.readFileSync(file);
    if (bytes.length > 2 * 1024 * 1024) fail("artifact_limit");
    process.stdout.write(JSON.stringify(writeWindowsStagingSources(args[2], JSON.parse(bytes)), null, 2) + "\n");
  } else if (args.length === 2 && args[0] === "--build-sources") {
    const result = await buildWindowsStagingSourceModules(args[1]);
    process.stdout.write(JSON.stringify({ ...result, observations: result.observations.map(({ bundleInputs, ...summary }) => summary) }, null, 2) + "\n");
  } else fail("usage_write-sources_PUBLIC_INPUTS_ROOT_or_build-sources_ROOT");
}
