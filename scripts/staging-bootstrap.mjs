import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { STAGING_ACCOUNT_ID, STAGING_INVENTORY } from "./staging-requirements.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BOOTSTRAP_SCHEMA_VERSION = 1;
export const DISPOSABLE_REHEARSAL_SCHEMA_VERSION = 1;
export const BOOTSTRAP_APPS = Object.freeze({
  delivery: Object.freeze({
    source: "client",
    workerName: "ledgetop-clients-staging",
    binding: "DELIVERY_DB",
    databaseName: "client-data-staging",
    seed: "0002_seed_initial_staff.sql",
    migrationCount: 149,
    migrationNamesSha256: "adec3554555949068ac785d0720c6dcddc8813489c98b5c88e88c0afd23ee659",
    migrationContentsSha256: "f0131c4467cbe6046c5da7c54f0bcd604cc39f743d9a98082d3ff59a7d34c1f1",
    historicalMigrationChains: Object.freeze([Object.freeze({
      count: 147,
      namesSha256: "1adce32fb9cad385417f3f058664ecb105559c31a5efd8c87e9f642f97a45db9",
      contentsSha256: "8a6cb183feae5ec6490cb4710f02a3289a05421786b9593e6392803a1e890f5c",
    })]),
  }),
  operations: Object.freeze({
    source: "operations",
    workerName: "ledgetop-ops-staging",
    binding: "OPS_DB",
    databaseName: "ltds-ops-staging",
    seed: "0002_seed_acl.sql",
    migrationCount: 199,
    migrationNamesSha256: "7be05fcb2b54c3a345b76b1f37e3dbbf33c0f4278b6cabe8307a064549c33821",
    migrationContentsSha256: "9fd14f1d7bb71719c532e11ed55963a05b962ae433fd1ead8be400752b550a53",
    historicalMigrationChains: Object.freeze([Object.freeze({
      count: 198,
      namesSha256: "d88ba83a54c045e5eb416fb912324047d68160f9f198e6b56591f0f0909788f2",
      contentsSha256: "47369a1c36e64853cf8e82c874af734ff0c2745bef416cca9c3a01cae16f8409",
    }), Object.freeze({
      count: 196,
      namesSha256: "c8f55f7a543d1e51d69abce753c2ce54a4640c35fd93c2769c8e971bb8162106",
      contentsSha256: "5dd50102b800eb3b49c9c5f41adb6f1ce44005425118b718ecc544e7f0b49c03",
    }), Object.freeze({
      count: 195,
      namesSha256: "3aecb42400d7a5e95687cca3eb256e880aa306dd4184747c0171f6301ffb71fd",
      contentsSha256: "46d06078251512d73faf9b96f277165d2a7a01e8c7d97d3e775dde0a167ef9da",
    }), Object.freeze({
      count: 194,
      namesSha256: "21797f48e9c38621119a6e78eb431594609ae5520aea9036f1e5db288a984a10",
      contentsSha256: "156c845b6185e89ae18533015055b0c0e09f6939348a165da68a1a3c10eabc25",
    }), Object.freeze({
      count: 187,
      namesSha256: "ce00ad1a6b67cb8a7f0ed5e197ebd5fbdfabd2566dc3c402f1eee79302036951",
      contentsSha256: "3e0f92864210aab88c97220e50649a46d4ec8d6367262ea8f42ca75ce17a8567",
    }), Object.freeze({
      count: 190,
      namesSha256: "1c42cda3e4a770e59da42fecb2eaa9063abbe415eb500d5cde22b5755fc0ddbf",
      contentsSha256: "7e6f75368c5aed14209b092e026458894c6509324c8fdbedcf96c8df2ac0f260",
    }), Object.freeze({
      count: 192,
      namesSha256: "2ac701ff1485af80b9b2edfcd0ce1b8cb9a413a925bf799d6531069eabb1f78c",
      contentsSha256: "148ff7d7b73ec90af81730f48520f2b7e4f0c1d80eebe32143c6a088d5f81e62",
    })]),
  }),
});
export const PRODUCTION_DATABASE_IDENTITIES = Object.freeze([
  Object.freeze({ databaseName: "client-data", databaseId: "7f40a7b7-c3ec-470e-a626-e798867f71f8" }),
  Object.freeze({ databaseName: "ltds-ops", databaseId: "6ebf7514-d306-4615-ae56-ad869c874dbd" }),
]);
const PRODUCTION_CONFIG_DATABASES = Object.freeze({
  client: Object.freeze([{ binding: "DELIVERY_DB", database_name: PRODUCTION_DATABASE_IDENTITIES[0].databaseName, database_id: PRODUCTION_DATABASE_IDENTITIES[0].databaseId }]),
  operations: Object.freeze([
    { binding: "DELIVERY_DB", database_name: PRODUCTION_DATABASE_IDENTITIES[0].databaseName, database_id: PRODUCTION_DATABASE_IDENTITIES[0].databaseId },
    { binding: "OPS_DB", database_name: PRODUCTION_DATABASE_IDENTITIES[1].databaseName, database_id: PRODUCTION_DATABASE_IDENTITIES[1].databaseId },
  ]),
  "ops-sync": Object.freeze([
    { binding: "DELIVERY_DB", database_name: PRODUCTION_DATABASE_IDENTITIES[0].databaseName, database_id: PRODUCTION_DATABASE_IDENTITIES[0].databaseId },
    { binding: "OPS_DB", database_name: PRODUCTION_DATABASE_IDENTITIES[1].databaseName, database_id: PRODUCTION_DATABASE_IDENTITIES[1].databaseId },
  ]),
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

function validatePathAncestors(base, target, label) {
  const absoluteBase = path.resolve(base);
  const absoluteTarget = path.resolve(target);
  const relative = path.relative(absoluteBase, absoluteTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must remain below ${absoluteBase}`);
  let current = absoluteBase;
  const parentParts = path.dirname(relative).split(path.sep).filter((part) => part && part !== ".");
  for (const part of parentParts) {
    current = path.join(current, part);
    const stat = lstat(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`${label} ancestor ${path.relative(base, current)} must be a regular non-symlink directory`);
  }
}
const validateOutputAncestors = (base, target) => validatePathAncestors(base, target, "generated output");

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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RUN_ID = /^[a-z0-9](?:[a-z0-9-]{1,18}[a-z0-9])$/;
const exactKeys = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

function reservedDatabaseIdentities(base) {
  const identities = [];
  for (const inventory of Object.values(STAGING_INVENTORY)) identities.push(...databaseIdentities(inventory));
  for (const source of ["client", "operations", "ops-sync"]) {
    const file = path.join(base, "apps", source, "wrangler.jsonc");
    requireRegularFile(file, `${source} production config`);
    let config;
    try { config = readJson(file); }
    catch { throw new Error(`${source} production config must be strict JSON`); }
    const databases = databaseIdentities(config);
    if (!isDeepStrictEqual(databases, [...PRODUCTION_CONFIG_DATABASES[source]].sort((left, right) => left.binding.localeCompare(right.binding))))
      throw new Error(`${source} production config D1 identities differ from the reviewed production inventory`);
    identities.push(...databases);
  }
  return identities;
}

export function validateDisposableTargets(base, targets) {
  if (!exactKeys(targets, ["runId", "applications"]) || !RUN_ID.test(targets.runId ?? "")
    || !exactKeys(targets.applications, Object.keys(BOOTSTRAP_APPS))) throw new Error("disposable rehearsal targets require a strict runId and exactly delivery and operations applications");
  const reserved = reservedDatabaseIdentities(base), seenNames = new Set(), seenIds = new Set();
  for (const [app, entry] of Object.entries(BOOTSTRAP_APPS)) {
    const target = targets.applications[app];
    const expectedName = `${entry.databaseName}-rehearsal-${targets.runId}`;
    if (!exactKeys(target, ["databaseName", "databaseId"]) || target.databaseName !== expectedName || !UUID.test(target.databaseId ?? "")) {
      throw new Error(`${app} disposable rehearsal target must use exact name ${expectedName} and a lowercase UUIDv4 ID`);
    }
    if (seenNames.has(target.databaseName) || seenIds.has(target.databaseId)) throw new Error("disposable rehearsal database names and IDs must be distinct");
    if (reserved.some(({ database_name, database_id }) => database_name === target.databaseName || database_id === target.databaseId)) {
      throw new Error(`${app} disposable rehearsal target must not reuse a configured staging or production database identity`);
    }
    seenNames.add(target.databaseName); seenIds.add(target.databaseId);
  }
  return targets;
}

export function buildArtifacts(base, owner, options = {}) {
  const errors = validateOwner(owner);
  if (errors.length) throw new Error(errors.join("\n"));
  if (!exactKeys(options, []) && !exactKeys(options, ["disposableTargets"])) throw new Error("unexpected bootstrap build option");
  const requestedDisposable = options.disposableTargets ?? null;
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
    const namesSha256 = sha256(names.join("\n"));
    const reviewedChains = [{ count: entry.migrationCount, namesSha256: entry.migrationNamesSha256,
      contentsSha256: entry.migrationContentsSha256 }, ...(entry.historicalMigrationChains ?? [])];
    const reviewedChain = reviewedChains.find(chain => names.length === chain.count && namesSha256 === chain.namesSha256);
    if (!reviewedChain) throw new Error(`${app} canonical migration inventory must be an exact complete reviewed chain `
      + `(found ${names.length} files, names sha256 ${namesSha256})`);
    if (!names.includes(entry.seed)) throw new Error(`${app} canonical seed ${entry.seed} is missing`);
    const canonicalFiles = names.map((name) => {
      const sourcePath = path.join(sourceDir, name);
      requireRegularFile(sourcePath, `${app} canonical migration ${name}`);
      const source = fs.readFileSync(sourcePath, "utf8");
      return { name, source, sourceSha256: sha256(source) };
    });
    const sourceChainSha256 = sha256(canonicalFiles.map(({ name, sourceSha256 }) => `${name}\0${sourceSha256}`).join("\n"));
    if (sourceChainSha256 !== reviewedChain.contentsSha256) throw new Error(`${app} canonical migration contents do not match the reviewed full-chain digest`);
    const files = canonicalFiles.map(({ name, source, sourceSha256 }) => {
      const generated = name === entry.seed ? transformSeed(app, source, owner) : source;
      return { name, source, generated, sourceSha256, generatedSha256: sha256(generated), transformed: source !== generated };
    });
    const changed = files.filter(({ transformed }) => transformed).map(({ name }) => name);
    if (!isDeepStrictEqual(changed, [entry.seed])) throw new Error(`${app} bootstrap must transform exactly ${entry.seed}`);
    const runDirectory = ".staging-bootstrap", outputConfig = structuredClone(config);
    database(outputConfig, entry).migrations_dir = ".staging-bootstrap/migrations";
    const manifest = {
      schemaVersion: BOOTSTRAP_SCHEMA_VERSION, app, workerName: entry.workerName,
      databaseName: entry.databaseName, databaseId: selected.database_id,
      owner: { emailSha256: sha256(owner.email.trim().toLowerCase()), staffId: app === "delivery" ? owner.clientStaffId : owner.operationsStaffId },
      sourceMigrationDirectory: `apps/${entry.source}/migrations`, sourceChainSha256, transformedFiles: changed,
      migrations: files.map(({ name, sourceSha256, generatedSha256, transformed }) => ({ name, sourceSha256, generatedSha256, transformed })),
    };
    artifacts[app] = { entry, files, config: outputConfig, manifest, runDirectory,
      configFilename: "wrangler.staging.bootstrap.json" };
  }
  // Validate every canonical source config and migration byte before a target
  // identity can influence any generated artifact.
  if (requestedDisposable) {
    const disposable = validateDisposableTargets(base, requestedDisposable);
    for (const [app, artifact] of Object.entries(artifacts)) {
      const { entry } = artifact, target = disposable.applications[app];
      artifact.runDirectory = `.staging-bootstrap/rehearsals/${disposable.runId}`;
      artifact.configFilename = `wrangler.staging.bootstrap.${disposable.runId}.json`;
      artifact.config = {
        name: `${entry.workerName}-rehearsal-${disposable.runId}`,
        account_id: STAGING_ACCOUNT_ID,
        vars: { ENVIRONMENT: "staging" },
        d1_databases: [{ binding: entry.binding, database_name: target.databaseName, database_id: target.databaseId,
          migrations_dir: `${artifact.runDirectory}/migrations` }],
      };
      const { workerName, databaseName, databaseId, ...commonManifest } = artifact.manifest;
      artifact.manifest = { ...commonManifest, schemaVersion: DISPOSABLE_REHEARSAL_SCHEMA_VERSION,
        mode: "disposable-remote-rehearsal", runId: disposable.runId,
        canonicalSource: { workerName, databaseName, databaseId },
        disposableTarget: { workerName: artifact.config.name, databaseName: target.databaseName, databaseId: target.databaseId } };
    }
  }
  return artifacts;
}

function expectedFiles(base, artifacts) {
  const files = new Map();
  for (const { entry, files: migrations, config, manifest, runDirectory, configFilename } of Object.values(artifacts)) {
    const generatedDir = path.join(base, "apps", entry.source, runDirectory);
    for (const migration of migrations) files.set(path.join(generatedDir, "migrations", migration.name), migration.generated);
    files.set(path.join(generatedDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    files.set(path.join(base, "apps", entry.source, configFilename), `${JSON.stringify(config, null, 2)}\n`);
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
  for (const { entry, files, runDirectory } of Object.values(artifacts)) {
    const directory = path.join(base, "apps", entry.source, runDirectory, "migrations");
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
  let targetsFile = "";
  for (let index = 0; index < argv.length; index += 1) {
    if (["--write", "--check"].includes(argv[index]) && !mode) mode = argv[index];
    else if (argv[index] === "--values" && argv[index + 1]) valuesFile = argv[++index];
    else if (argv[index] === "--disposable-targets" && argv[index + 1]) targetsFile = argv[++index];
    else throw new Error(`unknown or incomplete argument ${argv[index]}`);
  }
  if (!mode || !valuesFile) throw new Error("usage: node scripts/staging-bootstrap.mjs --write|--check --values <local-owner-json> [--disposable-targets <local-target-json>]");
  return { mode, valuesFile, targetsFile };
}

function readLocalJson(base, filename, label) {
  const resolvedBase = path.resolve(base), file = path.resolve(resolvedBase, filename), relative = path.relative(resolvedBase, file);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must remain below the repository root`);
  validatePathAncestors(resolvedBase, file, label);
  requireRegularFile(file, label);
  try { return readJson(file); }
  catch { throw new Error(`${label} must be strict JSON`); }
}

export function run(argv = process.argv.slice(2), base = root) {
  const { mode, valuesFile, targetsFile } = parseArguments(argv);
  const owner = readJson(path.resolve(base, valuesFile)).owner;
  const disposableTargets = targetsFile ? readLocalJson(base, targetsFile, "disposable rehearsal target input") : undefined;
  const artifacts = buildArtifacts(base, owner, disposableTargets ? { disposableTargets } : {});
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
