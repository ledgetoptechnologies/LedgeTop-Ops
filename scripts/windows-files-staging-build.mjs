import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertWindowsStagingRuntimeExports } from "./windows-files-staging-exports.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

/** Offline esbuild qualification only. It does not deploy or upload assets. */
export async function buildWindowsStagingModules(root) {
  root = path.resolve(root);
  if (root.startsWith("\\\\") || fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root).toLowerCase() !== root.toLowerCase()) throw Error("windows_staging_build_root_alias");
  const observations = [];
  for (const [app, directory, originalMain] of [["operations", "operations", "src/worker/staging-native-authority-entrypoint.ts"], ["delivery", "client", "src/worker/index.ts"]]) {
    const base = path.join(root, "apps", directory), generated = path.join(base, ".windows-files-staging");
    if (fs.realpathSync(generated).toLowerCase() !== generated.toLowerCase() || fs.lstatSync(generated).isSymbolicLink()) throw Error("windows_staging_build_root_alias");
    const output = path.join(generated, "module-build");
    if (fs.existsSync(output)) throw Error("windows_staging_build_output_exists");
    const config = JSON.parse(fs.readFileSync(path.join(base, "wrangler.staging.windows-files.json"), "utf8"));
    const receipt = JSON.parse(fs.readFileSync(path.join(generated, "receipt.json"), "utf8"));
    if (config.main !== ".windows-files-staging/entrypoint.ts" || receipt.status !== "source_composition_only"
      || receipt.configSha256?.[app] !== sha(JSON.stringify(config))
      || receipt.entrySha256?.[app] !== sha(fs.readFileSync(path.join(generated, "entrypoint.ts")))) throw Error("windows_staging_build_inputs_drifted");
    const require = createRequire(path.join(base, "package.json")), { build } = require("esbuild");
    const options = { bundle: true, format: "esm", platform: "browser", conditions: ["workerd", "worker", "browser"],
      external: ["cloudflare:*", "node:*"], write: false, metafile: true, logLevel: "silent" };
    const baseline = await build({ ...options, entryPoints: [path.join(base, originalMain)], outfile: path.join(output, "baseline.js") });
    const candidate = await build({ ...options, entryPoints: [path.join(generated, "entrypoint.ts")], outfile: path.join(output, "entrypoint.js") });
    const exportsOf = result => Object.values(result.metafile.outputs).flatMap(o => o.exports).sort();
    const before = exportsOf(baseline), after = exportsOf(candidate);
    const exportObservation = assertWindowsStagingRuntimeExports(app, before, after);
    fs.mkdirSync(output);
    for (const file of candidate.outputFiles) fs.writeFileSync(file.path, file.contents, { flag: "wx" });
    observations.push({ app, exports: after, ...exportObservation, moduleSha256: sha(candidate.outputFiles[0].contents), moduleBytes: candidate.outputFiles[0].contents.length });
    fs.writeFileSync(path.join(output, "build-receipt.json"), JSON.stringify({ schemaVersion: 1, status: "offline_module_build_only", observations: observations.filter(o => o.app === app), uploaded: false, activated: false, workerdRpcTested: false }, null, 2) + "\n", { flag: "wx" });
  }
  return { schemaVersion: 1, status: "offline_module_build_only", observations, uploaded: false, activated: false, workerdRpcTested: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--build") throw Error("usage: node scripts/windows-files-staging-build.mjs --build WORKSPACE_ROOT");
  process.stdout.write(JSON.stringify(await buildWindowsStagingModules(path.resolve(process.argv[3])), null, 2) + "\n");
}
