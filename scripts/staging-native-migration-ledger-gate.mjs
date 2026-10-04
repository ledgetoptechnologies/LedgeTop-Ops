import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildProfiles, validateGenerated } from "./staging-native-migration-profile.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_QUERY = 'SELECT name FROM "d1_migrations" ORDER BY id';

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function regularFile(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing`);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}

export function parseRemoteLedgerJson(stdout) {
  let payload;
  try { payload = JSON.parse(stdout); }
  catch { throw new Error("Wrangler remote ledger response was not strict JSON"); }
  if (!Array.isArray(payload) || payload.length === 0) {
    throw new Error("Wrangler remote ledger response must be a non-empty result array");
  }
  const names = [];
  for (const result of payload) {
    if (!result || result.success === false || !Array.isArray(result.results)) {
      throw new Error("Wrangler remote ledger response contained an unsuccessful or malformed result");
    }
    for (const row of result.results) {
      if (!row || typeof row.name !== "string" || row.name.length === 0) {
        throw new Error("Wrangler remote ledger response contained a row without a migration name");
      }
      names.push(row.name);
    }
  }
  return names;
}

export function validateExactRemoteLedger(profile, actualNames) {
  const expected = profile.expectedRemoteAppliedMigrations;
  if (JSON.stringify(actualNames) !== JSON.stringify(expected)) {
    throw new Error(`${profile.application} remote migration ledger is not the exact pinned pre-suffix history `
      + `(expected count ${expected.length}, names SHA-256 ${sha256(expected.join("\n"))}; `
      + `received count ${actualNames.length}, names SHA-256 ${sha256(actualNames.join("\n"))})`);
  }
  return {
    application: profile.application,
    count: expected.length,
    namesSha256: sha256(expected.join("\n")),
    baseline: profile.contract.remoteBaseline,
  };
}

export function verifyLiveRemoteLedger(base, application, runner = spawnSync, options = {}) {
  if (!['client', 'operations'].includes(application)) {
    throw new Error("application must be client or operations");
  }
  const profiles = buildProfiles(base);
  validateGenerated(base, profiles);
  const profile = profiles[application];
  const executable = options.executable ?? process.execPath;
  const wranglerCli = options.cliPath ?? path.join(base, "apps", "client", "node_modules", "wrangler", "bin", "wrangler.js");
  regularFile(wranglerCli, "pinned Wrangler CLI entrypoint");
  const args = [
    wranglerCli,
    "d1", "execute", profile.contract.binding,
    "--remote",
    "--config", profile.configPath,
    "--command", LEDGER_QUERY,
    "--json",
  ];
  const result = runner(executable, args, { cwd: base, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || String(result.stderr || "Wrangler exited unsuccessfully").trim();
    throw new Error(`${application} read-only remote ledger query failed: ${detail}`);
  }
  return validateExactRemoteLedger(profile, parseRemoteLedgerJson(result.stdout));
}

export function run(argv = process.argv.slice(2), base = repositoryRoot) {
  if (argv.length !== 2 || argv[0] !== "--application") {
    throw new Error("usage: node scripts/staging-native-migration-ledger-gate.mjs --application client|operations");
  }
  const result = verifyLiveRemoteLedger(base, argv[1]);
  console.log(`PASS: live read-only ${result.application} ledger exactly matches the pinned ${result.count}-migration `
    + `pre-suffix history ending at ${result.baseline} (names SHA-256 ${result.namesSha256}). `
    + "No migration was applied; this result describes only the remote read completed by this invocation.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) {
    console.error(`staging native migration ledger gate failed: ${error.message}`);
    process.exitCode = 1;
  }
}
