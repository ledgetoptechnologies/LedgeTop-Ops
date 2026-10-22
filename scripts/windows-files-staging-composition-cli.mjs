import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWindowsStagingComposition } from "./windows-files-staging-composition.mjs";

/** Prepare ignored public build inputs only. No Wrangler/deployment invocation. */
export function writeWindowsStagingComposition(root, inputs) {
  const result = buildWindowsStagingComposition(inputs);
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot.startsWith("\\\\") || fs.lstatSync(resolvedRoot).isSymbolicLink()
    || fs.realpathSync(resolvedRoot).toLowerCase() !== resolvedRoot.toLowerCase()) throw Error("windows_staging_composition_root_alias");
  const outputs = [];
  for (const [app, directory] of [["operations", "operations"], ["delivery", "client"]]) {
    const expected = path.join(resolvedRoot, "apps", directory), base = fs.realpathSync(expected);
    if (base.toLowerCase() !== expected.toLowerCase() || fs.lstatSync(expected).isSymbolicLink()) throw Error("windows_staging_composition_root_alias");
    const generated = path.join(base, ".windows-files-staging");
    const config = path.join(base, "wrangler.staging.windows-files.json");
    if (fs.existsSync(generated) || fs.existsSync(config)) throw Error("windows_staging_composition_output_exists");
    outputs.push({ app, generated, config });
  }
  // Check every target before the first write. A partial filesystem failure is
  // retained for inspection; no automatic overwrite, cleanup or cloud retry.
  for (const output of outputs) {
    fs.mkdirSync(output.generated);
    fs.writeFileSync(path.join(output.generated, "entrypoint.ts"), result.entries[output.app], { flag: "wx" });
    fs.writeFileSync(path.join(output.generated, "receipt.json"), JSON.stringify(result.receipt, null, 2) + "\n", { flag: "wx" });
    fs.writeFileSync(output.config, JSON.stringify(result.configs[output.app], null, 2) + "\n", { flag: "wx" });
  }
  return result.receipt;
}
const ownPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === ownPath) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[0] !== "--write") throw Error("usage: node scripts/windows-files-staging-composition-cli.mjs --write PUBLIC_INPUTS_JSON WORKSPACE_ROOT");
  // The explicitly named JSON contains only a reviewed nonsecret profile,
  // read-only observation and nonsecret staging configs. Never pass a secret file.
  const input = fs.readFileSync(args[1], "utf8");
  if (Buffer.byteLength(input) > 2 * 1024 * 1024) throw Error("windows_staging_composition_inputs_too_large");
  process.stdout.write(JSON.stringify(writeWindowsStagingComposition(path.resolve(args[2]), JSON.parse(input)), null, 2) + "\n");
}
