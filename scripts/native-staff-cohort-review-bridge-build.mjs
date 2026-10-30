import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..");
const OPS_ROOT = path.join(ROOT, "apps", "operations");
const requireOps = createRequire(path.join(OPS_ROOT, "package.json"));
const { build } = requireOps("esbuild");

export const RETAINED_RUNTIME_PINS = Object.freeze({
  "index.js": "7973278da1b6c3958a3071bf639f61f4dfbe8a224099a62881e9704fd2fa8760",
  "__ops_c880_retention_ledger.json": "ccee26957c3c99ff28a1f4c4d6c5a29c6ce97033fd5978f00d1a5b3422c155aa",
  "__ops_release_ledger.json": "29c66e83afb37a9a2952c8606318949a5ee9ee05a62b3e8c8bb0e29c14080b1d",
});
export const RETAINED_RUNTIME_SIZES = Object.freeze({
  "index.js": 6_884_992,
  "__ops_c880_retention_ledger.json": 66_973,
  "__ops_release_ledger.json": 60_961,
});

// This list is pinned from the byte-matched 797 runtime export audit, not the
// current-main source tree. Updating it requires a new retained-runtime review.
export const RETAINED_EXPORTS = Object.freeze([
  "ClientDelegatedShareSigner",
  "ClientOnboardingRecipientBridge",
  "ClientPortalNativeFinancialReader",
  "ClientPortalRecipientEnrollmentBridge",
  "ClientPortalServiceMetadataReader",
  "DropboxImportWorkflow",
  "IncomingRclonePromotionWorkflow",
  "IncomingUploadLifecycleWorkflow",
  "NATIVE_DIRECTORY_OUTBOX_CRON",
  "NATIVE_DIRECTORY_RECONCILIATION_CRON",
  "OperationsPortalNativeDeliveryAuthorizationReader",
  "OperationsPortalNativeRecipientEnrollmentIngress",
  "PROJECT_ALPHA_API_V2_MONITOR_CRON",
  "ProjectAlphaCatalogPromotionWorkflow",
  "ProjectAlphaDeliveryIntentIngress",
  "R2CrudWorkflow",
  "SharedProfilePortalIngress",
  "ThumbnailRendererContainer",
  "ViewerSessionIssuer",
  "default",
  "dispatchThumbnailRendererApi",
  "projectAlphaProjectionApiRequest",
  "runScheduledPrimaryProjectAlphaSync",
]);

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** Parse the module's ESM export surface with esbuild, without importing or executing it. */
export async function deriveRetainedRuntimeExports(sourceBytes, sourcefile = "pinned-retained-index.js") {
  const contents = Buffer.isBuffer(sourceBytes) ? sourceBytes : Buffer.from(sourceBytes);
  const result = await build({
    stdin: { contents, sourcefile, loader: "js" },
    bundle: false,
    platform: "neutral",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const outputs = Object.values(result.metafile.outputs).filter(output => output.entryPoint === sourcefile);
  if (outputs.length !== 1 || !Array.isArray(outputs[0].exports)) {
    throw new Error("Unable to derive one ESM export inventory from pinned retained module bytes");
  }
  return [...outputs[0].exports].sort();
}

export function assertExactEsmExports(actualExports, expectedExports) {
  const actual = Array.isArray(actualExports) && actualExports.every(value => typeof value === "string")
    ? [...actualExports].sort()
    : null;
  const expected = Array.isArray(expectedExports) && expectedExports.every(value => typeof value === "string")
    ? [...expectedExports].sort()
    : null;
  if (!expected || new Set(expected).size !== expected.length) {
    throw new TypeError("Expected ESM export inventory must be a unique string list");
  }
  if (!actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
    const actualSet = new Set(actual ?? []);
    const expectedSet = new Set(expected);
    const missing = expected.filter(name => !actualSet.has(name));
    const extra = [...actualSet].filter(name => !expectedSet.has(name)).sort();
    throw new Error(`ESM export surface mismatch: missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
  }
  return actual;
}

export function assertRetainedRuntimeExports(actualExports) {
  return assertExactEsmExports(actualExports, RETAINED_EXPORTS);
}

function pathContains(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameResolvedPath(left, right) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

async function validateRetainedDirectory(input) {
  const directoryStat = await lstat(input);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Retained input path must be a regular directory, not a symlink or junction");
  }
  const resolvedInput = await realpath(input);
  if (!sameResolvedPath(resolvedInput, input)) {
    throw new Error("Retained input path resolves through a symlink or junction");
  }
  return resolvedInput;
}

async function readPinnedModule(input, name) {
  const modulePath = path.join(input, name);
  const before = await lstat(modulePath);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Retained module must be a regular non-symlink file: ${name}`);
  }
  if (before.nlink !== 1) throw new Error(`Retained module must have exactly one hard link: ${name}`);
  if (before.size !== RETAINED_RUNTIME_SIZES[name]) {
    throw new Error(`Retained module size mismatch for ${name}: expected ${RETAINED_RUNTIME_SIZES[name]}, got ${before.size}`);
  }
  const resolvedPath = await realpath(modulePath);
  if (!sameResolvedPath(resolvedPath, modulePath)) {
    throw new Error(`Retained module resolves through a symlink or junction: ${name}`);
  }
  const bytes = await readFile(modulePath);
  const after = await lstat(modulePath);
  if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.size !== before.size ||
      after.dev !== before.dev || after.ino !== before.ino || bytes.byteLength !== before.size) {
    throw new Error(`Retained module changed during read: ${name}`);
  }
  return bytes;
}

/** Build only the new wrapper closure; the retained index.js remains external. */
export async function buildNativeStaffCohortReviewBridgeBundle({ sourceRoot = ROOT, outfile }) {
  if (!outfile) throw new TypeError("outfile is required");
  const source = path.resolve(sourceRoot);
  const result = await build({
    absWorkingDir: source,
    entryPoints: [path.join(source, "scripts", "native-staff-cohort-review-bridge-entry.mjs")],
    outfile: path.resolve(outfile),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    // The existing Worker compatibility configuration supplies nodejs_compat;
    // keep its built-in modules as runtime imports rather than bundling Node shims.
    external: ["./index.js", "node:*"],
    nodePaths: [path.join(source, "apps", "operations", "node_modules")],
    metafile: true,
    write: true,
    legalComments: "none",
  });
  const normalizedOutfile = path.resolve(outfile).replaceAll("\\", "/");
  const outputMeta = result.metafile.outputs[normalizedOutfile] ??
    result.metafile.outputs[path.relative(source, path.resolve(outfile)).replaceAll("\\", "/")];
  if (!outputMeta) throw new Error("esbuild did not report wrapper output");
  const retainedImports = outputMeta.imports.filter(item => item.path === "./index.js" && item.external);
  if (retainedImports.length === 0 || new Set(retainedImports.map(item => item.path)).size !== 1) {
    throw new Error(`wrapper must retain only the external ./index.js module; found ${JSON.stringify(outputMeta.imports)}`);
  }
  if (outputMeta.imports.some(item => item.path.includes("index.js") && !item.external)) {
    throw new Error("retained index.js was bundled into the wrapper");
  }
  const wrapperBytes = await readFile(path.resolve(outfile));
  const bundledInputs = [];
  for (const [name, inputMeta] of Object.entries(result.metafile.inputs)) {
    const absoluteInput = path.resolve(source, name);
    if (absoluteInput !== source && !absoluteInput.startsWith(`${source}${path.sep}`)) {
      throw new Error(`Bundled source escaped source root: ${name}`);
    }
    const bytes = await readFile(absoluteInput);
    if (bytes.byteLength !== inputMeta.bytes) throw new Error(`Bundled source changed while building: ${name}`);
    bundledInputs.push({ name: path.relative(source, absoluteInput).replaceAll("\\", "/"), bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  bundledInputs.sort((left, right) => left.name.localeCompare(right.name));
  return {
    wrapper: { name: path.basename(outfile), bytes: wrapperBytes.byteLength, sha256: sha256(wrapperBytes) },
    externalImports: outputMeta.imports.filter(item => item.external).map(item => item.path).sort(),
    bundledInputs,
    checks: { retainedEntryExternalAndSingle: true, retainedRuntimeNotBundled: true },
    metafile: result.metafile,
  };
}

/**
 * Build a candidate package from an independently exported retained runtime.
 * Output directory must be new. This does no provider interaction and emits
 * only a local review package; it is not a deployment command.
 *
 * @param {{retainedDir: string, outputDir: string, sourceRoot?: string}} options
 */
export async function buildNativeStaffCohortReviewBridge({ retainedDir, outputDir, sourceRoot = ROOT }) {
  if (!retainedDir || !outputDir) throw new TypeError("retainedDir and outputDir are required");
  const target = path.resolve(outputDir);
  const input = path.resolve(retainedDir);
  const source = path.resolve(sourceRoot);
  const resolvedSource = await realpath(source);
  if (!sameResolvedPath(resolvedSource, source)) throw new Error("Source root resolves through a symlink or junction");
  const outputParent = path.dirname(target);
  const resolvedOutputParent = await realpath(outputParent);
  if (!sameResolvedPath(resolvedOutputParent, outputParent)) {
    throw new Error("Output parent path must not resolve through a symlink or junction");
  }
  const effectiveTarget = path.join(resolvedOutputParent, path.basename(target));
  if (pathContains(resolvedSource, effectiveTarget) || pathContains(effectiveTarget, resolvedSource)) {
    throw new Error("Output must be outside the source tree and must not contain the source tree");
  }
  const resolvedInput = await validateRetainedDirectory(input);
  if (pathContains(resolvedInput, effectiveTarget) || pathContains(effectiveTarget, resolvedInput)) {
    throw new Error("Output must be a distinct directory outside and separate from retained input");
  }
  try {
    await lstat(target);
    throw new Error("Output directory already exists; use a new owned review directory");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const validatedModules = [];
  for (const [name, expectedHash] of Object.entries(RETAINED_RUNTIME_PINS)) {
    const bytes = await readPinnedModule(input, name);
    const actualHash = sha256(bytes);
    if (bytes.byteLength !== RETAINED_RUNTIME_SIZES[name] || actualHash !== expectedHash) {
      throw new Error(`Retained module pin mismatch for ${name}: ${bytes.byteLength} bytes / ${actualHash}`);
    }
    validatedModules.push({ name, bytes, sha256: actualHash });
  }
  const derivedExports = await deriveRetainedRuntimeExports(
    validatedModules.find(module => module.name === "index.js").bytes,
  );
  assertRetainedRuntimeExports(derivedExports);
  try {
    await lstat(target);
    throw new Error("Output directory already exists; use a new owned review directory");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(target, { recursive: false });
  const moduleReceipts = [];
  for (const { name, bytes, sha256: actualHash } of validatedModules) {
    const outputPath = path.join(target, name);
    await writeFile(outputPath, bytes, { flag: "wx" });
    const copiedHash = sha256(await readFile(outputPath));
    if (copiedHash !== actualHash) throw new Error(`Copied module hash mismatch for ${name}`);
    moduleReceipts.push({ name, bytes: bytes.byteLength, sha256: actualHash, copiedSha256: copiedHash });
  }

  const bundle = await buildNativeStaffCohortReviewBridgeBundle({ sourceRoot: source, outfile: path.join(target, "wrapper.js") });
  const wrapperBytes = await readFile(path.join(target, "wrapper.js"));
  const receipt = {
    kind: "offline-review-package-not-deployable",
    candidateMainModule: "wrapper.js",
    candidateModuleFiles: ["wrapper.js", ...Object.keys(RETAINED_RUNTIME_PINS)],
    receiptIsNotModule: true,
    referenceSourceCommit: "c2bba3d589ad0ea4718e94dc72f742b7c0d0e5ff",
    wrapper: bundle.wrapper,
    retainedModules: moduleReceipts,
    retainedExports: derivedExports,
    retainedNamedExports: derivedExports.filter(name => name !== "default"),
    externalImports: bundle.externalImports,
    bundledInputs: bundle.bundledInputs,
    checks: { ...bundle.checks, retainedExportSurfaceExact: true },
    runtimeAssumptions: ["The exact production runtime already has nodejs_compat enabled for the route's node:crypto dependency; the builder does not read or change Worker settings."],
    limits: [
      "referenceSourceCommit names the reviewed source base only; this builder does not assert that sourceRoot is at that Git commit. The bundledInputs path/size/SHA-256 list is the actual closure identity until a separately approved commit/build is recorded.",
      "No Worker runtime was executed by the builder.",
      "This package does not contain or modify provider metadata, bindings, secrets, compatibility settings, schedules, routes, or assets.",
      "A separate reviewed release process must re-verify all retained module hashes and active metadata before any upload or activation.",
    ],
  };
  await writeFile(path.join(target, "bridge-build-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const parsed = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!["--retained-dir", "--output-dir"].includes(name) || !value || parsed.has(name)) {
      throw new Error("Usage: node scripts/native-staff-cohort-review-bridge-build.mjs --retained-dir <existing-dir> --output-dir <new-dir>");
    }
    parsed.set(name, value);
  }
  const retainedDir = parsed.get("--retained-dir");
  const outputDir = parsed.get("--output-dir");
  if (!retainedDir || !outputDir || parsed.size !== 2) {
    throw new Error("Usage: node scripts/native-staff-cohort-review-bridge-build.mjs --retained-dir <existing-dir> --output-dir <new-dir>");
  }
  const receipt = await buildNativeStaffCohortReviewBridge({ retainedDir, outputDir });
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}
