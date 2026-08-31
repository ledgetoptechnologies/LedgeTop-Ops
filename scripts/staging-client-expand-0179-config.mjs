import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SOURCE_CONFIG = "apps/client/wrangler.staging.json";
export const OUTPUT_CONFIG = "apps/client/wrangler.staging.expand-0179.json";
export const MIGRATION_DIRECTORY = "migrations";
export const MIGRATION_FILE = "0179_service_assignment_policy_proof_v2.sql";
export const MIGRATION_PATTERN = `${MIGRATION_DIRECTORY}/${MIGRATION_FILE}`;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const populated = (value) => typeof value === "string" && value.trim().length > 0;

function deliveryDatabase(config) {
  return Array.isArray(config?.d1_databases)
    ? config.d1_databases.find((database) => database?.binding === "DELIVERY_DB")
    : undefined;
}

export function validateSourceConfig(config, base = root) {
  const errors = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) return ["Client staging config must be a JSON object"];
  if (config.name !== "ltds-delivery-staging") errors.push("Client staging config must target ltds-delivery-staging");
  if (config.vars?.ENVIRONMENT !== "staging") errors.push("Client staging config ENVIRONMENT must be staging");

  const databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const database = deliveryDatabase(config);
  if (databases.length !== 1 || !database) errors.push("Client staging config must contain exactly one DELIVERY_DB binding");
  if (database) {
    if (database.database_name !== "client-data-staging") errors.push("DELIVERY_DB must target client-data-staging");
    if (!populated(database.database_id) || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(database.database_id)) errors.push("DELIVERY_DB must have a concrete staging database_id");
    if (database.migrations_dir !== MIGRATION_DIRECTORY) errors.push(`DELIVERY_DB migrations_dir must be ${MIGRATION_DIRECTORY}`);
    if (Object.hasOwn(database, "migrations_pattern")) errors.push("Base Client staging config must not contain migrations_pattern");
  }

  const migration = path.join(base, "apps", "client", MIGRATION_DIRECTORY, MIGRATION_FILE);
  try {
    const stat = fs.lstatSync(migration);
    if (!stat.isFile() || stat.isSymbolicLink()) errors.push(`${MIGRATION_FILE} must be a regular canonical migration file`);
  } catch {
    errors.push(`canonical migration is missing: apps/client/${MIGRATION_PATTERN}`);
  }
  return errors;
}

export function buildExpandConfig(source, base = root) {
  const errors = validateSourceConfig(source, base);
  if (errors.length) throw new Error(errors.join("\n"));
  const candidate = structuredClone(source);
  deliveryDatabase(candidate).migrations_pattern = MIGRATION_PATTERN;
  return candidate;
}

export function validateExpandConfig(source, candidate, base = root) {
  const errors = validateSourceConfig(source, base);
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [...errors, "expand-only config must be a JSON object"];

  const candidateDatabase = deliveryDatabase(candidate);
  if (!candidateDatabase) {
    errors.push("expand-only config is missing DELIVERY_DB");
    return errors;
  }
  if (candidateDatabase.migrations_pattern !== MIGRATION_PATTERN) {
    errors.push(`DELIVERY_DB migrations_pattern must select exactly ${MIGRATION_PATTERN}`);
  }

  const comparable = structuredClone(candidate);
  delete deliveryDatabase(comparable)?.migrations_pattern;
  if (!isDeepStrictEqual(comparable, source)) {
    errors.push("expand-only config drifted from the staging config outside migrations_pattern");
  }

  const configDirectory = path.join(base, "apps", "client");
  const selectedPath = path.resolve(configDirectory, candidateDatabase.migrations_pattern ?? "");
  const canonicalPath = path.resolve(configDirectory, MIGRATION_PATTERN);
  if (selectedPath !== canonicalPath) errors.push("migrations_pattern does not resolve to the canonical 0179 migration");
  return errors;
}

function parseArguments(argv) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("usage: node scripts/staging-client-expand-0179-config.mjs --write|--check");
  }
  return argv[0];
}

export function run(argv = process.argv.slice(2), base = root) {
  const mode = parseArguments(argv);
  const sourcePath = path.join(base, SOURCE_CONFIG);
  const outputPath = path.join(base, OUTPUT_CONFIG);
  if (!fs.existsSync(sourcePath)) throw new Error(`${SOURCE_CONFIG} is missing; render and validate the ordinary staging configs first`);
  const source = readJson(sourcePath);

  if (mode === "--check") {
    if (!fs.existsSync(outputPath)) throw new Error(`${OUTPUT_CONFIG} is missing; generate it with --write`);
    const errors = validateExpandConfig(source, readJson(outputPath), base);
    if (errors.length) throw new Error(`expand-only config is invalid:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    console.log(`Validated ${OUTPUT_CONFIG}: it preserves the staging configuration and selects only ${MIGRATION_FILE}.`);
    return OUTPUT_CONFIG;
  }

  const candidate = buildExpandConfig(source, base);
  if (fs.existsSync(outputPath)) {
    const errors = validateExpandConfig(source, readJson(outputPath), base);
    if (errors.length) throw new Error(`${OUTPUT_CONFIG} already exists but is invalid or stale:\n${errors.map((error) => `- ${error}`).join("\n")}\nRemove it explicitly before generating a replacement.`);
    console.log(`${OUTPUT_CONFIG} already exists and is valid; no file was changed.`);
    return OUTPUT_CONFIG;
  }

  const temporary = `${outputPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(candidate, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, outputPath);
  } finally {
    if (fs.existsSync(temporary)) fs.rmSync(temporary);
  }
  console.log(`Wrote ignored ${OUTPUT_CONFIG}. No SQL was copied and no Cloudflare action was performed.`);
  return OUTPUT_CONFIG;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) { console.error(`Client 0179 expand config failed: ${error.message}`); process.exitCode = 1; }
}
