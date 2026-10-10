import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildPairedEndToEndAcceptanceConfigs,
  validatePairedEndToEndAcceptanceConfigs,
} from "./staging-paired-end-to-end-acceptance-profile.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PAIRED_END_TO_END_ACCEPTANCE_CONFIGS = Object.freeze({
  delivery: Object.freeze({
    source: "apps/client/wrangler.staging.json",
    production: "apps/client/wrangler.jsonc",
    output: "apps/client/wrangler.staging.paired-end-to-end-acceptance.json",
  }),
  operations: Object.freeze({
    source: "apps/operations/wrangler.staging.json",
    production: "apps/operations/wrangler.jsonc",
    output: "apps/operations/wrangler.staging.paired-end-to-end-acceptance.json",
  }),
});

export const PAIRED_END_TO_END_ACCEPTANCE_SECRET_NAMES =
  ".backups/operations-staging-secret-names.json";

function parse(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0]))
    throw new Error("usage: node scripts/staging-paired-end-to-end-acceptance-cli.mjs --write|--check");
  return argv[0];
}

function regularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(`${label} is missing`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return stat;
}

function readJson(file, label) {
  regularFile(file, label);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`${label} must contain strict JSON`); }
}

function canonicalWithin(base, candidate, label) {
  const canonicalBase = fs.realpathSync(base);
  let canonical;
  try { canonical = fs.realpathSync(candidate); }
  catch { throw new Error(`${label} is missing`); }
  if (canonical !== canonicalBase && !canonical.startsWith(`${canonicalBase}${path.sep}`))
    throw new Error(`${label} must remain below the workspace root`);
  return canonical;
}

function ignored(base, relative) {
  const result = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", relative], {
    cwd: base, encoding: "utf8", windowsHide: true,
  });
  if (result.error) throw new Error(`cannot verify Git ignore status for ${relative}: ${result.error.message}`);
  if (![0, 1].includes(result.status))
    throw new Error(`cannot verify Git ignore status for ${relative}: ${result.stderr.trim() || `git exited ${result.status}`}`);
  return result.status === 0;
}

function identity(file) {
  regularFile(file, file);
  const stat = fs.lstatSync(file, { bigint: true });
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mode: stat.mode,
    birthtimeNs: stat.birthtimeNs, mtimeNs: stat.mtimeNs };
}

function removeIfSame(file, expected) {
  let current;
  try { current = fs.lstatSync(file, { bigint: true }); } catch { return; }
  if (current.isFile() && !current.isSymbolicLink()
    && current.dev === expected.dev && current.ino === expected.ino && current.size === expected.size
    && current.mode === expected.mode && current.birthtimeNs === expected.birthtimeNs && current.mtimeNs === expected.mtimeNs)
    fs.rmSync(file);
}

function loadInputs(base) {
  const sources = {}, production = {};
  for (const [app, files] of Object.entries(PAIRED_END_TO_END_ACCEPTANCE_CONFIGS)) {
    const source = path.join(base, files.source), productionFile = path.join(base, files.production);
    canonicalWithin(base, source, files.source); canonicalWithin(base, productionFile, files.production);
    sources[app] = readJson(source, files.source);
    production[app] = readJson(productionFile, files.production);
    canonicalWithin(base, path.dirname(path.join(base, files.output)), path.dirname(files.output));
    if (!ignored(base, files.output)) throw new Error(`${files.output} must be ignored before candidate generation`);
  }
  const inventory = path.join(base, PAIRED_END_TO_END_ACCEPTANCE_SECRET_NAMES);
  canonicalWithin(base, inventory, PAIRED_END_TO_END_ACCEPTANCE_SECRET_NAMES);
  const secretNames = readJson(inventory, PAIRED_END_TO_END_ACCEPTANCE_SECRET_NAMES);
  return { sources, production, secretNames };
}

function existingCandidates(base) {
  const present = Object.entries(PAIRED_END_TO_END_ACCEPTANCE_CONFIGS)
    .filter(([, files]) => fs.existsSync(path.join(base, files.output)));
  if (present.length !== 0 && present.length !== Object.keys(PAIRED_END_TO_END_ACCEPTANCE_CONFIGS).length)
    throw new Error("paired end-to-end candidates are partial; remove neither file and recover the complete reviewed pair");
  if (!present.length) return null;
  return Object.fromEntries(present.map(([app, files]) => {
    const output = path.join(base, files.output);
    canonicalWithin(base, output, files.output);
    return [app, readJson(output, files.output)];
  }));
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parse(argv), resolvedBase = path.resolve(base);
  canonicalWithin(resolvedBase, resolvedBase, "workspace root");
  const { sources, production, secretNames } = loadInputs(resolvedBase);
  const expected = buildPairedEndToEndAcceptanceConfigs(sources, production, secretNames);
  const existing = existingCandidates(resolvedBase);
  const errors = validatePairedEndToEndAcceptanceConfigs(sources, existing ?? expected, production, secretNames);
  if (errors.length) throw new Error(`paired end-to-end acceptance config is invalid or stale:\n${errors.map(error => `- ${error}`).join("\n")}`);
  if (mode === "--check") {
    if (!existing) throw new Error("paired end-to-end candidates are missing; generate with --write");
    console.log("Validated ignored paired end-to-end acceptance configs. No remote action was performed.");
    return Object.values(PAIRED_END_TO_END_ACCEPTANCE_CONFIGS).map(files => files.output);
  }
  if (existing) {
    console.log("Ignored paired end-to-end acceptance configs are current. They were not overwritten.");
    return Object.values(PAIRED_END_TO_END_ACCEPTANCE_CONFIGS).map(files => files.output);
  }

  const created = [], temporaries = [];
  try {
    for (const [app, files] of Object.entries(PAIRED_END_TO_END_ACCEPTANCE_CONFIGS)) {
      const output = path.join(resolvedBase, files.output);
      const temporary = `${output}.tmp-${process.pid}-${app}`;
      fs.writeFileSync(temporary, `${JSON.stringify(expected[app], null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      temporaries.push(temporary);
      fs.linkSync(temporary, output);
      const ownIdentity = identity(output);
      fs.rmSync(temporary); temporaries.pop();
      created.push({ output, identity: ownIdentity });
    }
  } catch (error) {
    for (const item of created.reverse()) removeIfSame(item.output, item.identity);
    throw error;
  } finally {
    for (const temporary of temporaries) if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  console.log("Wrote ignored paired end-to-end acceptance configs. No remote action was performed.");
  return Object.values(PAIRED_END_TO_END_ACCEPTANCE_CONFIGS).map(files => files.output);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) { console.error(`Paired end-to-end acceptance CLI failed: ${error.message}`); process.exitCode = 1; }
}
