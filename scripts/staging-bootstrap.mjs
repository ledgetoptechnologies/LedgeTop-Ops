import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BOOTSTRAP_SCHEMA_VERSION = 1;
export const BOOTSTRAP_APPS = Object.freeze({
  delivery: Object.freeze({
    source: "client",
    workerName: "ledgetop-clients-staging",
    binding: "DELIVERY_DB",
    databaseName: "client-data-staging",
    seed: "0002_seed_initial_staff.sql",
    migrationCount: 133,
    migrationNamesSha256: "cc894e956eee368da2bfdbe1e90f8f0f2698b42c111f2e01e31837fb8ab6552d",
    migrationContentsSha256: "918cb7b5772e7a489854818fc167f62e4f20899be62a3f6b22c6fc756ab91210",
  }),
  operations: Object.freeze({
    source: "operations",
    workerName: "ledgetop-ops-staging",
    binding: "OPS_DB",
    databaseName: "ltds-ops-staging",
    seed: "0002_seed_acl.sql",
    migrationCount: 140,
    migrationNamesSha256: "46b43d408fd903c655f759ed958fa38d00c7c95fbd577291bef36cdeb8f050c9",
    migrationContentsSha256: "03f9edf795d53c0ab4d2629b23124e2b9671375a4ae88ce064b16bd7961a07ae",
  }),
});

const canonicalPeople = Object.freeze([
  "beaukoltz@ledgetopdroneservices.com", "kstirn@ledgetopdroneservices.com",
  "staff-beau-koltz", "staff-kollins-stirn", "initial-beau-koltz", "initial-kollins-stirn",
]);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;
const populated = (value) => typeof value === "string" && value.trim().length > 0 && !/[<>]/.test(value);

function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function requireRegularFile(file, label) {
  const stat = lstat(file);
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}

function requireRegularDirectory(directory, label) {
  const stat = lstat(directory);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`);
}

function validateOutputAncestors(base, target) {
  const absoluteBase = path.resolve(base);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(absoluteBase, absoluteTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`generated output must remain below ${absoluteBase}`);
  let current = absoluteBase;
  const parentParts = path.dirname(relative).split(path.sep).filter((part) => part && part !== ".");
  for (const part of parentParts) {
    current = path.join(current, part);
    const stat = lstat(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`generated output ancestor ${path.relative(base, current)} must be a regular non-symlink directory`);
  }
}

function databaseIdentities(config) {
  if (!Array.isArray(config?.d1_databases)) return [];
  return config.d1_databases.map(({ binding, database_name, database_id }) => ({ binding, database_name, database_id }))
    .sort((left, right) => String(left.binding).localeCompare(String(right.binding)));
}

export function validateOwner(owner) {
  const errors = [];
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) return ["owner must be a JSON object"];
  const allowed = ["email", "displayName", "clientStaffId", "operationsStaffId"];
  for (const key of allowed) if (!populated(owner[key])) errors.push(`owner.${key} is required and must not contain a placeholder`);
  for (const key of Object.keys(owner)) if (!allowed.includes(key)) errors.push(`unexpected owner field ${key}`);
  if (populated(owner.email) && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner.email)) errors.push("owner.email must be an email address");
  for (const key of ["clientStaffId", "operationsStaffId"]) {
    if (populated(owner[key]) && !/^staging-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(owner[key])) errors.push(`owner.${key} must be a staging-prefixed lowercase identifier`);
  }
  const lowered = Object.values(owner).filter((value) => typeof value === "string").map((value) => value.toLowerCase());
  for (const value of canonicalPeople) if (lowered.includes(value)) errors.push(`owner must not reuse canonical identity ${value}`);
  if (populated(owner.displayName) && !/staging/i.test(owner.displayName)) errors.push("owner.displayName must visibly identify the synthetic staging account");
  return errors;
}

function replaceExact(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + 1) >= 0) throw new Error(`canonical ${label} seed shape changed; review the generator before proceeding`);
  return source.replace(before, after);
}

export function transformSeed(app, source, owner) {
  const ownerErrors = validateOwner(owner);
  if (ownerErrors.length) throw new Error(ownerErrors.join("\n"));
  let output = source;
  if (app === "delivery") {
    const canonical = "INSERT OR IGNORE INTO staff_users (id, email, display_name, role)\nVALUES ('initial-beau-koltz', 'beaukoltz@ledgetopdroneservices.com', 'Beau', 'admin');\n\nINSERT OR IGNORE INTO staff_users (id, email, display_name, role)\nVALUES ('initial-kollins-stirn', 'kstirn@ledgetopdroneservices.com', 'Kollins', 'staff');";
    const synthetic = `-- Fresh-staging derivative only; canonical migration remains unchanged.\nINSERT OR IGNORE INTO staff_users (id, email, display_name, role)\nVALUES (${sqlString(owner.clientStaffId)}, ${sqlString(owner.email.toLowerCase())}, ${sqlString(owner.displayName)}, 'admin');`;
    output = replaceExact(output, canonical, synthetic, "Client 0002");
  } else if (app === "operations") {
    output = replaceExact(output,
      "INSERT INTO divisions (id,name,code) VALUES ('division-chippewa-falls','Chippewa Falls','chippewa-falls');",
      "INSERT INTO divisions (id,name,code) VALUES ('division-staging','Synthetic Staging','staging');", "Operations division");
    output = replaceExact(output,
      "INSERT INTO staff_users (id,email,display_name) VALUES ('staff-beau-koltz','beaukoltz@ledgetopdroneservices.com','Beau Koltz');\nINSERT INTO staff_users (id,email,display_name) VALUES ('staff-kollins-stirn','kstirn@ledgetopdroneservices.com','Kollins Stirn');\nINSERT INTO staff_divisions (staff_id,division_id,is_primary) VALUES ('staff-kollins-stirn','division-chippewa-falls',1);",
      `-- Fresh-staging derivative only; canonical migration remains unchanged.\nINSERT INTO staff_users (id,email,display_name) VALUES (${sqlString(owner.operationsStaffId)},${sqlString(owner.email.toLowerCase())},${sqlString(owner.displayName)});\nINSERT INTO staff_divisions (staff_id,division_id,is_primary) VALUES (${sqlString(owner.operationsStaffId)},'division-staging',1);`, "Operations staff");
    output = replaceExact(output,
      " ('assignment-beau-owner','staff-beau-koltz','role-owner','global',NULL,'global'),\n ('assignment-kollins-manager','staff-kollins-stirn','role-division-manager','division','division-chippewa-falls','division-chippewa-falls');",
      ` ('assignment-staging-owner',${sqlString(owner.operationsStaffId)},'role-owner','global',NULL,'global');`, "Operations assignments");
  } else throw new Error(`unsupported bootstrap app ${app}`);
  for (const value of canonicalPeople) if (output.toLowerCase().includes(value)) throw new Error(`${app} derived seed retained canonical identity ${value}`);
  return output;
}

function database(config, entry) {
  return config?.d1_databases?.find((item) => item?.binding === entry.binding);
}

export function buildArtifacts(base, owner) {
  const errors = validateOwner(owner);
  if (errors.length) throw new Error(errors.join("\n"));
  const artifacts = {};
  for (const [app, entry] of Object.entries(BOOTSTRAP_APPS)) {
    const appDir = path.join(base, "apps", entry.source);
    const sourceConfigPath = path.join(appDir, "wrangler.staging.json");
    if (!fs.existsSync(sourceConfigPath)) throw new Error(`${path.relative(base, sourceConfigPath)} is missing; render and validate ordinary staging configs first`);
    requireRegularFile(sourceConfigPath, `${app} staging config`);
    const config = readJson(sourceConfigPath);
    const selected = database(config, entry);
    const expectedDatabase = STAGING_INVENTORY[app].d1_databases.find((item) => item.binding === entry.binding);
    if (config.name !== entry.workerName || config.account_id !== STAGING_ACCOUNT_ID || config.vars?.ENVIRONMENT !== "staging") throw new Error(`${app} bootstrap source must be the exact staging account and Worker config`);
    if (!isDeepStrictEqual(databaseIdentities(config), databaseIdentities(STAGING_INVENTORY[app]))) throw new Error(`${app} bootstrap source must contain the complete exact reviewed staging D1 binding inventory`);
    if (!selected || selected.database_name !== entry.databaseName || selected.database_id !== expectedDatabase?.database_id) throw new Error(`${app} bootstrap source must target the exact reviewed staging D1 database ID`);
    if (selected.migrations_dir !== "migrations" || Object.hasOwn(selected, "migrations_pattern")) throw new Error(`${app} bootstrap source must use the unfiltered canonical migrations directory`);
    const sourceDir = path.join(appDir, "migrations");
    requireRegularDirectory(sourceDir, `${app} canonical migration directory`);
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    for (const item of entries) {
      if (item.name.endsWith(".sql") && (!item.isFile() || item.isSymbolicLink())) throw new Error(`${app} canonical migration ${item.name} must be a regular non-symlink file`);
    }
    const names = entries.filter((item) => item.isFile() && !item.isSymbolicLink() && item.name.endsWith(".sql")).map((item) => item.name).sort();
    if (names.length !== entry.migrationCount || sha256(names.join("\n")) !== entry.migrationNamesSha256) throw new Error(`${app} canonical migration inventory must be the exact complete ordered ${entry.migrationCount}-file chain`);
    if (!names.includes(entry.seed)) throw new Error(`${app} canonical seed ${entry.seed} is missing`);
    const canonicalFiles = names.map((name) => {
      const sourcePath = path.join(sourceDir, name);
      requireRegularFile(sourcePath, `${app} canonical migration ${name}`);
      const source = fs.readFileSync(sourcePath, "utf8");
      return { name, source, sourceSha256: sha256(source) };
    });
    const sourceChainSha256 = sha256(canonicalFiles.map(({ name, sourceSha256 }) => `${name}\0${sourceSha256}`).join("\n"));
    if (sourceChainSha256 !== entry.migrationContentsSha256) throw new Error(`${app} canonical migration contents do not match the reviewed full-chain digest`);
    const files = canonicalFiles.map(({ name, source, sourceSha256 }) => {
      const generated = name === entry.seed ? transformSeed(app, source, owner) : source;
      return { name, source, generated, sourceSha256, generatedSha256: sha256(generated), transformed: source !== generated };
    });
    const changed = files.filter(({ transformed }) => transformed).map(({ name }) => name);
    if (!isDeepStrictEqual(changed, [entry.seed])) throw new Error(`${app} bootstrap must transform exactly ${entry.seed}`);
    const outputConfig = structuredClone(config);
    database(outputConfig, entry).migrations_dir = ".staging-bootstrap/migrations";
    const manifest = {
      schemaVersion: BOOTSTRAP_SCHEMA_VERSION, app, workerName: entry.workerName,
      databaseName: entry.databaseName, databaseId: selected.database_id,
      owner: { emailSha256: sha256(owner.email.trim().toLowerCase()), staffId: app === "delivery" ? owner.clientStaffId : owner.operationsStaffId },
      sourceMigrationDirectory: `apps/${entry.source}/migrations`, sourceChainSha256, transformedFiles: changed,
      migrations: files.map(({ name, sourceSha256, generatedSha256, transformed }) => ({ name, sourceSha256, generatedSha256, transformed })),
    };
    artifacts[app] = { entry, files, config: outputConfig, manifest };
  }
  return artifacts;
}

function expectedFiles(base, artifacts) {
  const files = new Map();
  for (const { entry, files: migrations, config, manifest } of Object.values(artifacts)) {
    const generatedDir = path.join(base, "apps", entry.source, ".staging-bootstrap");
    for (const migration of migrations) files.set(path.join(generatedDir, "migrations", migration.name), migration.generated);
    files.set(path.join(generatedDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    files.set(path.join(base, "apps", entry.source, "wrangler.staging.bootstrap.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  return files;
}

export function validateGenerated(base, artifacts) {
  const errors = [];
  const expected = expectedFiles(base, artifacts);
  for (const [file, content] of expected) {
    try { validateOutputAncestors(base, file); }
    catch (error) { errors.push(error.message); continue; }
    const stat = lstat(file);
    if (!stat) errors.push(`${path.relative(base, file)} is missing`);
    else if (!stat.isFile() || stat.isSymbolicLink()) errors.push(`${path.relative(base, file)} must be a regular non-symlink file`);
    else if (fs.readFileSync(file, "utf8") !== content) errors.push(`${path.relative(base, file)} is stale or was edited`);
  }
  for (const { entry, files } of Object.values(artifacts)) {
    const directory = path.join(base, "apps", entry.source, ".staging-bootstrap", "migrations");
    const stat = lstat(directory);
    if (stat) {
      if (!stat.isDirectory() || stat.isSymbolicLink()) { errors.push(`${path.relative(base, directory)} must be a regular non-symlink directory`); continue; }
      const entries = fs.readdirSync(directory, { withFileTypes: true });
      for (const item of entries) if (item.name.endsWith(".sql") && (!item.isFile() || item.isSymbolicLink())) errors.push(`${path.relative(base, path.join(directory, item.name))} must be a regular non-symlink file`);
      const actual = entries.filter((item) => item.isFile() && !item.isSymbolicLink() && item.name.endsWith(".sql")).map((item) => item.name).sort();
      const wanted = files.map(({ name }) => name);
      if (!isDeepStrictEqual(actual, wanted)) errors.push(`${path.relative(base, directory)} has missing or unexpected SQL files`);
    }
  }
  return errors;
}

export function writeGenerated(base, artifacts) {
  const expected = expectedFiles(base, artifacts);
  const existingErrors = validateGenerated(base, artifacts);
  for (const file of expected.keys()) validateOutputAncestors(base, file);
  const anyExisting = [...expected.keys()].some((file) => lstat(file));
  if (anyExisting) {
    if (existingErrors.length) throw new Error(`generated bootstrap artifacts already exist but are invalid or stale:\n${existingErrors.map((error) => `- ${error}`).join("\n")}\nRemove the ignored artifacts explicitly before regenerating.`);
    return [...expected.keys()].map((file) => path.relative(base, file));
  }
  for (const [file, content] of expected) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    validateOutputAncestors(base, file);
    fs.writeFileSync(file, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
  }
  return [...expected.keys()].map((file) => path.relative(base, file));
}

function parseArguments(argv) {
  let mode = "";
  let valuesFile = "";
  for (let index = 0; index < argv.length; index += 1) {
    if (["--write", "--check"].includes(argv[index]) && !mode) mode = argv[index];
    else if (argv[index] === "--values" && argv[index + 1]) valuesFile = argv[++index];
    else throw new Error(`unknown or incomplete argument ${argv[index]}`);
  }
  if (!mode || !valuesFile) throw new Error("usage: node scripts/staging-bootstrap.mjs --write|--check --values <local-owner-json>");
  return { mode, valuesFile };
}

export function run(argv = process.argv.slice(2), base = root) {
  const { mode, valuesFile } = parseArguments(argv);
  const owner = readJson(path.resolve(base, valuesFile)).owner;
  const artifacts = buildArtifacts(base, owner);
  if (mode === "--check") {
    const errors = validateGenerated(base, artifacts);
    if (errors.length) throw new Error(`fresh-staging bootstrap artifacts are invalid:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    console.log("Fresh-staging bootstrap artifacts match canonical migrations and the supplied synthetic owner. No remote action was performed.");
    return [];
  }
  const written = writeGenerated(base, artifacts);
  console.log(`Wrote ignored fresh-staging bootstrap artifacts (${written.length} files). Canonical migrations were not changed. No remote action was performed.`);
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) { console.error(`Fresh-staging bootstrap failed: ${error.message}`); process.exitCode = 1; }
}
