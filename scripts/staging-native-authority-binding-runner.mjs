import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { isDeepStrictEqual as same } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  STAGING_TARGET,
  applyNativeOnlyAuthorityPacket,
} from "./staging-onboarding-native-only-authority-packet.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_KEYS = Object.freeze(["name", "account_id", "compatibility_date", "d1_databases"]);
const DATABASE_KEYS = Object.freeze(["binding", "database_name", "database_id", "remote"]);
const COMPATIBILITY_DATE = "2026-10-02";
const STATUS_SQL = `SELECT count(*) AS migration_count, max(name) AS final_migration
  FROM d1_migrations`;

const fail = message => {
  throw new Error(`staging-native-authority-binding-runner: ${message}`);
};

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || !same(Object.keys(value).sort(), [...keys].sort())) fail(`${label} shape`);
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** Validate the complete, deliberately tiny Wrangler config and derive the
 * trusted packet target from its actual resource identity. */
export function validateStagingBindingConfig(value) {
  exact(value, CONFIG_KEYS, "config");
  if (value.name !== STAGING_TARGET.workerName
    || value.account_id !== STAGING_TARGET.accountId
    || value.compatibility_date !== COMPATIBILITY_DATE) fail("exact staging worker config required");
  if (!Array.isArray(value.d1_databases) || value.d1_databases.length !== 1) {
    fail("exactly one D1 binding required");
  }
  const database = value.d1_databases[0];
  exact(database, DATABASE_KEYS, "D1 binding");
  if (database.binding !== STAGING_TARGET.binding
    || database.database_name !== STAGING_TARGET.databaseName
    || database.database_id !== STAGING_TARGET.databaseId
    || database.remote !== true) fail("exact remote staging D1 binding required");
  return Object.freeze({
    accountId: value.account_id,
    workerName: value.name,
    hostname: STAGING_TARGET.hostname,
    databaseId: database.database_id,
    databaseName: database.database_name,
    binding: database.binding,
    environment: STAGING_TARGET.environment,
  });
}

export function readStagingBindingConfig(configPath, dependencies = {}) {
  if (typeof configPath !== "string" || !configPath.length || configPath !== configPath.trim()) {
    fail("config path required");
  }
  const resolved = path.resolve(configPath);
  const lstat = dependencies.lstat ?? fs.lstatSync;
  const readFile = dependencies.readFile ?? fs.readFileSync;
  let stat;
  try {
    stat = lstat(resolved);
  } catch {
    fail("config must be an existing regular file");
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("config must be a non-symlink regular file");
  let bytes;
  try {
    bytes = readFile(resolved, "utf8");
  } catch {
    fail("config could not be read");
  }
  let config;
  try {
    config = JSON.parse(bytes);
  } catch {
    fail("config must be valid JSON");
  }
  return Object.freeze({
    configPath: resolved,
    config,
    configSha256: hash(bytes),
    target: validateStagingBindingConfig(config),
  });
}

function loadGetPlatformProxy() {
  const requireOperations = createRequire(path.join(ROOT, "apps", "operations", "package.json"));
  return requireOperations("wrangler").getPlatformProxy;
}

function assertStableConfig(before, after) {
  if (before.configPath !== after.configPath
    || before.configSha256 !== after.configSha256
    || !same(before.config, after.config)
    || !same(before.target, after.target)) fail("config changed while opening binding");
}

/** Open only the reviewed remote staging D1 binding. The config is re-read
 * after Wrangler starts and before the callback can issue any database call. */
export async function withStagingAuthorityBinding(configPath, callback, dependencies = {}) {
  if (typeof callback !== "function") fail("binding callback required");
  const readConfig = dependencies.readConfig ?? readStagingBindingConfig;
  const before = readConfig(configPath, dependencies);
  const getPlatformProxy = dependencies.getPlatformProxy ?? loadGetPlatformProxy();
  const platform = await getPlatformProxy({
    configPath: before.configPath,
    envFiles: [],
    persist: false,
    remoteBindings: true,
  });
  if (!platform || typeof platform !== "object" || typeof platform.dispose !== "function") {
    fail("Wrangler returned an invalid platform proxy");
  }
  try {
    const after = readConfig(before.configPath, dependencies);
    assertStableConfig(before, after);
    if (!platform.env || typeof platform.env !== "object" || Array.isArray(platform.env)
      || !same(Object.keys(platform.env).sort(), [before.target.binding])) {
      fail("platform exposed an unexpected binding set");
    }
    const db = platform.env[before.target.binding];
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      fail("OPS_DB is not a D1 binding");
    }
    return await callback(Object.freeze({ db, target: before.target }));
  } finally {
    await platform.dispose();
  }
}

/** A non-mutating binding/migration snapshot suitable for CLI output. */
export async function readOnlyStagingAuthorityStatus(configPath, dependencies = {}) {
  return withStagingAuthorityBinding(configPath, async ({ db, target }) => {
    const row = await db.prepare(STATUS_SQL).first();
    if (!row || !Number.isSafeInteger(row.migration_count) || row.migration_count < 0
      || (row.final_migration !== null && typeof row.final_migration !== "string")) {
      fail("invalid migration status response");
    }
    return {
      mode: "read-only-status",
      environment: target.environment,
      workerName: target.workerName,
      binding: target.binding,
      databaseName: target.databaseName,
      migrations: { count: row.migration_count, final: row.final_migration },
      mutationsPerformed: false,
    };
  }, dependencies);
}

/** Module-only mutation entry point. The existing guarded helper recompiles the
 * reviewed packet and submits its complete write set in one D1.batch. */
export async function applyReviewedNativeOnlyAuthorityPacket(configPath, packet, dependencies = {}) {
  if (!packet || typeof packet !== "object" || Array.isArray(packet)
    || ![2, 3].includes(packet.schemaVersion) || !Array.isArray(packet.statements)) {
    fail("reviewed compiled packet required");
  }
  const applyPacket = dependencies.applyPacket ?? applyNativeOnlyAuthorityPacket;
  return withStagingAuthorityBinding(configPath, ({ db, target }) => applyPacket(db, packet, {
    target,
    ...(dependencies.root ? { root: dependencies.root } : {}),
  }), dependencies);
}

function parseArguments(argv) {
  const values = [...argv];
  if (values[0] === "status") values.shift();
  if (values.length !== 2 || values[0] !== "--config" || !values[1]) {
    fail("read-only usage: status --config <reviewed-minimal-wrangler.json>");
  }
  return { configPath: values[1] };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const { configPath } = parseArguments(argv);
  const status = await readOnlyStagingAuthorityStatus(configPath, dependencies);
  (dependencies.log ?? console.log)(JSON.stringify(status));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`staging native authority binding status failed: ${error.message}`);
    process.exitCode = 1;
  });
}
