import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { lstat, readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { canonical, hash } from "./production-deploy.mjs";
import { RETAINED_EXPORTS, RETAINED_RUNTIME_PINS, RETAINED_RUNTIME_SIZES } from "./native-staff-cohort-review-bridge-build.mjs";

const EXPECTED_BASELINE_VERSION = "0b1ab5a8-9db0-42ab-b718-8569fae2382e";
const INSTALLED_PROFILE_SHA256 = "8aabbb21105428aa7fc28df433779770bcc479bdbe7d522129503d4cb5c3b39b";
const INSTALLED_PROFILE_BYTES = readFileSync(new URL("./native-staff-cohort-review-bridge-installed-profile.json", import.meta.url));
if (hash(INSTALLED_PROFILE_BYTES) !== INSTALLED_PROFILE_SHA256) {
  throw new Error("The reviewed installed Operations profile file differs from its independent hash pin");
}
const INSTALLED_PROFILE = JSON.parse(INSTALLED_PROFILE_BYTES.toString("utf8"));
if (INSTALLED_PROFILE.schemaVersion !== 1 || INSTALLED_PROFILE.versionId !== EXPECTED_BASELINE_VERSION
  || INSTALLED_PROFILE.provenance?.acceptedProfileModuleSha256 !== "d549052f06fada267f51eaafb51843a8693bb7b6b4aff9ebebf2bf038e1ff457"
  || INSTALLED_PROFILE.purpose !== "Finite recognition of the already installed Operations baseline; no settings writer") {
  throw new Error("The reviewed installed Operations profile identity is invalid");
}
const OPS = INSTALLED_PROFILE.operations;
const EXPECTED_WRAPPER = Object.freeze({ bytes: 687566, sha256: "0b747e80c503eb0600df5fa37d8f1d31a9d6f2f6c96c869768dd741e49fc2daa" });
const EXPECTED_RECEIPT_SHA256 = "e9965611d915be2b994f64387c09d2b3d2e1b5a92ff8680378df88bcd85c538a";
const EXPECTED_MODULE_CONTENT_TYPES = Object.freeze({
  "index.js": "application/javascript+module",
  "__ops_c880_retention_ledger.json": "text/plain",
  "__ops_release_ledger.json": "text/plain",
});
const MAX_RECEIPT_BYTES = 1_000_000;
const MODULE_NAMES = Object.freeze(["wrapper.js", ...Object.keys(RETAINED_RUNTIME_PINS)]);
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const equal = (left, right) => canonical(left) === canonical(right);
const need = (ok, message) => { if (!ok) throw new Error(message); };

function exactRows(value, label) {
  need(Array.isArray(value) && value.every(row => isObject(row) && typeof row.name === "string" && typeof row.type === "string"), `${label} metadata is invalid`);
  need(new Set(value.map(row => row.name)).size === value.length, `${label} names are duplicated`);
  return value;
}

function scriptShape(script) {
  need(isObject(script) && Array.isArray(script.handlers) && Array.isArray(script.named_handlers), "Baseline script metadata is missing");
  return {
    handlers: [...script.handlers].sort(),
    named_handlers: [...script.named_handlers].map(row => ({ name: row.name, handlers: [...row.handlers].sort() }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

function validateBaseline(snapshot) {
  need(isObject(snapshot) && isObject(snapshot.operations), "Complete captured Worker snapshot is required");
  const baseline = snapshot.operations;
  const id = EXPECTED_BASELINE_VERSION;
  need(baseline.latest === id && baseline.version?.id === id && baseline.modern?.id === id,
    "Operations active, latest, and modern version must all match the pinned baseline");
  need(!baseline.latestVersion && !baseline.latestModern, "Operations snapshot contains a distinct inactive latest version");
  need(Array.isArray(baseline.deployment?.versions) && baseline.deployment.versions.length === 1
    && baseline.deployment.versions[0].version_id === id && baseline.deployment.versions[0].percentage === 100,
  "Operations must have exactly one active version at 100 percent");

  const resources = baseline.version.resources;
  need(isObject(resources) && equal(scriptShape(resources.script), scriptShape(OPS.script)), "Baseline script handlers differ from the pinned production profile");
  need(equal(resources.script_runtime, OPS.runtime), "Baseline Worker runtime metadata differs from the pinned production profile");
  need(baseline.settings?.compatibility_date === OPS.settings.compatibility_date
    && equal(baseline.settings?.compatibility_flags, OPS.settings.compatibility_flags),
  "Baseline compatibility settings differ from the pinned production profile");
  const annotations = baseline.settings.annotations ?? {};
  for (const [name, value] of Object.entries(annotations)) {
    need(["workers/message", "workers/triggered_by"].includes(name) && typeof value === "string",
      "Baseline contains an unreviewed Worker annotation");
  }
  const settingsShape = structuredClone(baseline.settings);
  delete settingsShape.annotations;
  delete settingsShape.bindings;
  need(equal(settingsShape, OPS.settings), "Baseline Worker settings differ from the pinned production profile");
  need(equal(baseline.schedules?.schedules?.map(row => row.cron).sort(), [...OPS.crons].sort()),
    "Baseline cron schedule inventory differs from the pinned production profile");
  need(baseline.modern.main_module === "index.js"
    && baseline.modern.compatibility_date === OPS.runtime.compatibility_date
    && equal(baseline.modern.compatibility_flags, OPS.runtime.compatibility_flags)
    && equal(baseline.modern.exports, OPS.runtime.exports)
    && baseline.modern.usage_model === OPS.runtime.usage_model
    && equal(baseline.modern.containers, OPS.runtime.containers)
    && baseline.modern.migration_tag === OPS.runtime.migration_tag,
  "Modern version metadata differs from the pinned production profile");
  need(isObject(baseline.modern.assets) && isObject(baseline.modern.assets.config)
    && equal(baseline.modern.assets.config, OPS.metadata.assets.config),
  "Baseline asset configuration differs from the pinned production profile");

  const bindings = exactRows(resources.bindings, "Baseline binding");
  const nonPlain = bindings.filter(row => row.type !== "plain_text");
  const expectedNonPlain = OPS.bindings;
  need(equal([...nonPlain].sort((a, b) => a.name.localeCompare(b.name)), [...expectedNonPlain].sort((a, b) => a.name.localeCompare(b.name))),
    "Baseline resource and secret binding metadata differs from the pinned production profile");
  const plain = bindings.filter(row => row.type === "plain_text");
  need(equal(plain.map(row => row.name).sort(), [...OPS.plainNames].sort()), "Baseline plain binding names differ from the pinned production profile");
  const bindingNamesAndTypes = bindings.map(({ name, type }) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name));
  const modernBindings = exactRows(baseline.modern.bindings, "Modern version binding");
  const modernBindingProjection = modernBindings.map(({ name, type }) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name));
  need(equal(modernBindingProjection, bindingNamesAndTypes), "Modern version and active-version binding names/types differ");
  if (baseline.settings.bindings !== undefined) {
    const settingBindings = exactRows(baseline.settings.bindings, "Settings binding");
    const settingsProjection = settingBindings.map(({ name, type }) => ({ name, type })).sort((a, b) => a.name.localeCompare(b.name));
    need(equal(settingsProjection, bindingNamesAndTypes), "Settings and active-version binding names/types differ");
  }
  for (const row of plain) {
    need(typeof row.text === "string" && Object.hasOwn(OPS.plainValueSHA256, row.name)
      && hash(row.text) === OPS.plainValueSHA256[row.name], `Baseline plain binding value hash differs from the installed profile: ${row.name}`);
  }

  const modules = baseline.modern.modules;
  need(Array.isArray(modules) && modules.length === Object.keys(RETAINED_RUNTIME_PINS).length,
    "Baseline module inventory must contain exactly the three retained modules");
  need(modules.every(module => isObject(module) && typeof module.name === "string")
    && new Set(modules.map(module => module.name)).size === modules.length
    && equal(modules.map(module => module.name).sort(), Object.keys(RETAINED_RUNTIME_PINS).sort()),
  "Baseline module names differ from the exact retained module inventory");
  const moduleContentTypes = {};
  for (const name of Object.keys(RETAINED_RUNTIME_PINS)) {
    const row = modules.find(module => module.name === name);
    need(row && row.content_type === EXPECTED_MODULE_CONTENT_TYPES[name], `Baseline module content type differs for ${name}`);
    need(typeof row.content_base64 === "string", `Baseline module bytes are missing for ${name}`);
    const bytes = Buffer.from(row.content_base64, "base64");
    need(bytes.toString("base64") === row.content_base64 && bytes.byteLength === RETAINED_RUNTIME_SIZES[name]
      && sha256(bytes) === RETAINED_RUNTIME_PINS[name], `Baseline module bytes differ from the retained pin: ${name}`);
    moduleContentTypes[name] = row.content_type;
  }
  return {
    versionId: id,
    compatibilityDate: baseline.settings.compatibility_date,
    compatibilityFlags: [...baseline.settings.compatibility_flags],
    bindings,
    bindingNamesAndTypesSha256: sha256(canonical(bindingNamesAndTypes)),
    runtimeSha256: sha256(canonical(resources.script_runtime)),
    scriptHandlersSha256: sha256(canonical(scriptShape(resources.script))),
    assetsSha256: hash(canonical(baseline.modern.assets)),
    assetConfigSha256: sha256(canonical(baseline.modern.assets.config)),
    moduleContentTypes,
  };
}

async function readRegularFile(directory, name) {
  const file = path.join(directory, name);
  const before = await lstat(file);
  need(before.isFile() && !before.isSymbolicLink() && before.nlink === 1, `Candidate file is not a regular single-link file: ${name}`);
  const exactSize = name === "bridge-build-receipt.json" ? null
    : name === "wrapper.js" ? EXPECTED_WRAPPER.bytes : RETAINED_RUNTIME_SIZES[name];
  need(name !== "bridge-build-receipt.json" || before.size <= MAX_RECEIPT_BYTES, "Candidate receipt exceeds its read bound");
  need(exactSize === null || before.size === exactSize, `Candidate file size differs from its pin: ${name}`);
  need(await realpath(file) === file, `Candidate file path resolves through a link: ${name}`);
  const bytes = await readFile(file);
  const after = await lstat(file);
  need(after.isFile() && !after.isSymbolicLink() && after.nlink === before.nlink && after.size === before.size
    && after.dev === before.dev && after.ino === before.ino && bytes.byteLength === before.size,
  `Candidate file changed while reading: ${name}`);
  return bytes;
}

async function validateCandidateDirectory(candidateDir) {
  need(typeof candidateDir === "string" && path.isAbsolute(candidateDir), "Candidate directory must be an absolute path");
  const directory = path.resolve(candidateDir);
  const stat = await lstat(directory);
  need(stat.isDirectory() && !stat.isSymbolicLink() && await realpath(directory) === directory,
    "Candidate directory must be a regular directory without links");
  const receiptBytes = await readRegularFile(directory, "bridge-build-receipt.json");
  need(sha256(receiptBytes) === EXPECTED_RECEIPT_SHA256, "Candidate receipt differs from the independently reviewed receipt pin");
  let receipt;
  try { receipt = JSON.parse(receiptBytes.toString("utf8")); } catch { throw new Error("Candidate receipt is invalid JSON"); }
  need(isObject(receipt) && receipt.kind === "offline-review-package-not-deployable"
    && receipt.candidateMainModule === "wrapper.js" && receipt.receiptIsNotModule === true,
  "Candidate receipt is not the pinned offline bridge package format");
  need(Array.isArray(receipt.candidateModuleFiles) && equal([...receipt.candidateModuleFiles].sort(), [...MODULE_NAMES].sort()),
    "Candidate module inventory differs from the reviewed four-module package");
  need(isObject(receipt.checks) && receipt.checks.retainedEntryExternalAndSingle === true
    && receipt.checks.retainedRuntimeNotBundled === true && receipt.checks.retainedExportSurfaceExact === true,
  "Candidate receipt is missing retained-module closure checks");
  need(Array.isArray(receipt.retainedExports) && equal([...receipt.retainedExports].sort(), [...RETAINED_EXPORTS].sort()),
    "Candidate receipt retained JavaScript export inventory differs from the pinned inventory");
  need(Array.isArray(receipt.externalImports) && receipt.externalImports.every(value => value === "./index.js" || value === "node:crypto")
    && equal([...new Set(receipt.externalImports)].sort(), ["./index.js", "node:crypto"].sort()),
    "Candidate receipt external module closure differs from the reviewed bridge package");
  need(isObject(receipt.wrapper) && receipt.wrapper.name === "wrapper.js"
    && receipt.wrapper.bytes === EXPECTED_WRAPPER.bytes && receipt.wrapper.sha256 === EXPECTED_WRAPPER.sha256,
  "Candidate wrapper receipt is malformed");
  const retained = new Map();
  need(Array.isArray(receipt.retainedModules) && receipt.retainedModules.length === Object.keys(RETAINED_RUNTIME_PINS).length,
    "Candidate retained module receipt inventory is malformed");
  for (const row of receipt.retainedModules) {
    need(isObject(row) && Object.hasOwn(RETAINED_RUNTIME_PINS, row.name) && !retained.has(row.name)
      && row.bytes === RETAINED_RUNTIME_SIZES[row.name] && row.sha256 === RETAINED_RUNTIME_PINS[row.name]
      && row.copiedSha256 === RETAINED_RUNTIME_PINS[row.name], "Candidate retained module receipt differs from the retained byte pins");
    retained.set(row.name, row);
  }
  need([...retained.keys()].length === Object.keys(RETAINED_RUNTIME_PINS).length, "Candidate retained module receipt is incomplete");

  const modules = [];
  for (const name of MODULE_NAMES) {
    const bytes = await readRegularFile(directory, name);
    const digest = sha256(bytes);
    if (name === "wrapper.js") {
      need(bytes.byteLength === receipt.wrapper.bytes && digest === receipt.wrapper.sha256, "Candidate wrapper bytes differ from the receipt");
    } else {
      need(bytes.byteLength === RETAINED_RUNTIME_SIZES[name] && digest === RETAINED_RUNTIME_PINS[name], `Candidate retained module bytes differ from pin: ${name}`);
    }
    const contentType = name === "wrapper.js" ? EXPECTED_MODULE_CONTENT_TYPES["index.js"] : EXPECTED_MODULE_CONTENT_TYPES[name];
    modules.push({ name, contentType, bytes: bytes.byteLength, sha256: digest, path: path.join(directory, name) });
  }
  return { directory, receipt, modules };
}

/** Read-only inspection of the independently pinned offline candidate package. */
export async function inspectNativeStaffCohortReviewBridgeCandidatePackage(candidateDir) {
  const candidate = await validateCandidateDirectory(candidateDir);
  return { modules: candidate.modules, receipt: candidate.receipt };
}

/**
 * Create an offline-only inactive-version upload draft. This reads only the
 * supplied in-memory capture and candidate package; it does not read credentials,
 * contact Cloudflare, upload, or deploy. Persist only `safeSummary`.
 */
export async function createNativeStaffCohortReviewBridgeUploadPlan({ baselineSnapshot, candidateDir }) {
  const baseline = validateBaseline(baselineSnapshot);
  const candidate = await validateCandidateDirectory(candidateDir);
  const annotations = structuredClone(baselineSnapshot.operations.settings.annotations ?? {});
  delete annotations["workers/triggered_by"];
  const metadata = {
    ...structuredClone(OPS.metadata),
    main_module: "wrapper.js",
    compatibility_date: baseline.compatibilityDate,
    compatibility_flags: baseline.compatibilityFlags,
    bindings: baseline.bindings.map(({ name }) => ({ name, type: "inherit" })).sort((a, b) => a.name.localeCompare(b.name)),
    keep_assets: true,
    annotations,
  };
  const moduleSummary = candidate.modules.map(({ name, contentType, bytes, sha256: digest }) => ({ name, contentType, bytes, sha256: digest }));
  const safeSummary = {
    schemaVersion: 1,
    kind: "offline-inactive-upload-plan-not-executable",
    workerName: OPS.name,
    providerAcceptancePending: true,
    previewUnavailableDo: true,
    baseline: {
      versionId: baseline.versionId,
      mainModule: "index.js",
      activePercent: 100,
      singleActiveVersion: true,
      bindingCount: baseline.bindings.length,
      bindingNamesAndTypesSha256: baseline.bindingNamesAndTypesSha256,
      scriptHandlersSha256: baseline.scriptHandlersSha256,
      runtimeSha256: baseline.runtimeSha256,
      assetsSha256: baseline.assetsSha256,
      assetConfigSha256: baseline.assetConfigSha256,
      compatibilityDate: baseline.compatibilityDate,
      compatibilityFlags: baseline.compatibilityFlags,
      moduleContentTypes: baseline.moduleContentTypes,
    },
    candidate: {
      mainModule: "wrapper.js",
      modules: moduleSummary,
      retainedExportSurfaceSha256: sha256(canonical([...candidate.receipt.retainedExports].sort())),
    },
    changes: {
      mainModuleSelected: true,
      wrapperModuleAdded: true,
      cohortReviewRouteAdded: true,
      retainedModulesByteIdentical: true,
      inheritedBindings: true,
      bindingsAddedOrChanged: false,
      runtimeExportsPreserved: true,
      compatibilityPreserved: true,
      schedulesPreserved: true,
      migrationTagPreserved: true,
      migrationsAdded: false,
      activation: false,
      fullMainDeployment: false,
      existingAssetsKept: true,
    },
    limits: [
      "No provider acceptance or runtime result is asserted until a separate inactive upload is authorized and verified.",
      "This plan does not execute or persist plaintext settings, secret values, or credentials.",
      "metadataDraft and module descriptors are offline planning data, not an executable Wrangler config or multipart request.",
      "The Operations Worker implements a Durable Object, so Cloudflare Version URL preview routing is unavailable for this candidate.",
    ],
  };
  return { safeSummary, metadataDraft: metadata, modules: candidate.modules, receipt: candidate.receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  throw new Error("This planner is an in-memory library only; use a reviewed caller with an already captured snapshot");
}
