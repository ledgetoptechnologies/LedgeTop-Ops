import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const STAGING_ACCOUNT_ID = "846c924bf17bf4f3dd15c97a4c5d1d51";
export const PROFILE_SCHEMA_VERSION = 1;

export const NATIVE_MIGRATION_PROFILES = Object.freeze({
  client: Object.freeze({
    binding: "DELIVERY_DB",
    databaseName: "client-data-staging",
    databaseId: "b6f653ab-9acd-4421-9ad0-207754b59aeb",
    workerName: "ledgetop-clients-staging",
    baseCount: 147,
    baseNamesSha256: "1adce32fb9cad385417f3f058664ecb105559c31a5efd8c87e9f642f97a45db9",
    baseContentsSha256: "8a6cb183feae5ec6490cb4710f02a3289a05421786b9593e6392803a1e890f5c",
    remoteBaseline: "0228_operations_portal_native_content_start_audit.sql",
    finalMigration: "0228_operations_portal_native_content_start_audit.sql",
    candidates: Object.freeze({}),
    expectedAppliedMigrations: Object.freeze([]),
  }),
  operations: Object.freeze({
    binding: "OPS_DB",
    databaseName: "ltds-ops-staging",
    databaseId: "78b34173-b168-4e3d-9832-bb9d245cc6b8",
    workerName: "ledgetop-ops-staging",
    baseCount: 173,
    baseNamesSha256: "46d20b48362be8052f5b2fd35ec4ccefee2c267476a2a076af87a955c4cfca3a",
    baseContentsSha256: "cd35de12e87325fb6de854f4ecba47e5172e115f75830af9f4a908710d10a450",
    remoteBaseline: "0181_project_alpha_directory_create_generation_recovery.sql",
    finalMigration: "0182_project_alpha_directory_relationship_recovery_guard.sql",
    candidates: Object.freeze({
      "0174_project_alpha_directory_preserved_external_identity.sql": "9e794a73b75e025edc04967888631b9336931eb16113f42d855bea3fcb30a158",
      "0175_operations_directory_acquired_parent_enrollment_identity.sql": "de022736243342f203fcf9a1cb22993e49c50bbb18c7b3b2fc95d8fb3fa48ed0",
      "0176_operations_directory_acquired_intent_authority.sql": "026de6421dd219afcf807d6bf24c62d59acb77c2c4b1da21dac3c87c5b0278f0",
      "0177_operations_directory_acquired_intent_update_authority.sql": "81ee5947ef7cb7e529542f88b1e431744daa7619243b22bd23eafc7cad0a3238",
      "0178_project_alpha_project_inbound_reconciliation.sql": "eb92d93138a75329003eb18c06d714a6fb8365fcc383982a58939a9ab6969e60",
      "0179_project_alpha_acquired_native_identity_collision.sql": "58a00c5c0c9ddf5892062d17b3e1e7bccd47705c97777454f042cb28cdb922f7",
      "0180_project_alpha_project_v2_recovery_authorization.sql": "deb385a1f97f2e82c7b4e634e19ae7fd406efe6368e89ac0085aed440a2a3528",
      "0181_project_alpha_directory_create_generation_recovery.sql": "8b0be2c23cb8a45dd1dd46e78067e00bfd8d5dbf2cc2294219e85d1e26915bd6",
      "0182_project_alpha_directory_relationship_recovery_guard.sql": "1aeef8de3a6f3fb4f08a2b3e6c69d02c6fb0cb9d2c092b4cb507ed1759992b0f",
    }),
    expectedAppliedMigrations: Object.freeze([
      "0182_project_alpha_directory_relationship_recovery_guard.sql",
    ]),
  }),
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function lstat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function requireRegularFile(file, label) {
  const stat = lstat(file);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
}

function requireRegularDirectory(directory, label) {
  const stat = lstat(directory);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink directory`);
}

function readJson(file, label) {
  requireRegularFile(file, label);
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`${label} must be strict JSON`); }
}

function migrationChainDigest(directory, names) {
  return sha256(names.map((name) => {
    const file = path.join(directory, name);
    requireRegularFile(file, `migration ${name}`);
    return `${name}\0${sha256(fs.readFileSync(file))}`;
  }).join("\n"));
}

function validateSourceConfig(base, application, contract) {
  const file = path.join(base, "apps", application, "wrangler.staging.json");
  const config = readJson(file, `${application} staging source config`);
  if (config.account_id !== STAGING_ACCOUNT_ID || config.name !== contract.workerName
    || config.vars?.ENVIRONMENT !== "staging") {
    throw new Error(`${application} staging source config must identify the exact staging account, Worker, and environment`);
  }
  const selected = (config.d1_databases ?? []).filter((item) => item?.binding === contract.binding);
  if (selected.length !== 1 || selected[0].database_name !== contract.databaseName
    || selected[0].database_id !== contract.databaseId) {
    throw new Error(`${application} staging source config must identify exact ${contract.databaseName} name and ID`);
  }
}

function validateSourceMigrations(base, application, contract) {
  const directory = path.join(base, "apps", application, "migrations");
  requireRegularDirectory(directory, `${application} migration directory`);
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.endsWith(".sql") && (!entry.isFile() || entry.isSymbolicLink())) {
      throw new Error(`${application} migration ${entry.name} must be a regular non-symlink file`);
    }
  }
  const names = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name).sort();
  const candidateNames = Object.keys(contract.candidates).sort();
  const candidateSet = new Set(candidateNames);
  const baseNames = names.filter((name) => !candidateSet.has(name));
  if (baseNames.length !== contract.baseCount || sha256(baseNames.join("\n")) !== contract.baseNamesSha256) {
    throw new Error(`${application} pinned base migration inventory changed`);
  }
  if (migrationChainDigest(directory, baseNames) !== contract.baseContentsSha256) {
    throw new Error(`${application} pinned base migration contents changed`);
  }
  for (const [name, expected] of Object.entries(contract.candidates)) {
    const file = path.join(directory, name);
    requireRegularFile(file, `${application} native candidate ${name}`);
    const contents = fs.readFileSync(file);
    if (contents.includes(13)) throw new Error(`${application} native candidate must use LF-only line endings: ${name}`);
    if (sha256(contents) !== expected) throw new Error(`${application} native candidate changed: ${name}`);
  }
  if (names.length !== baseNames.length + candidateNames.length) {
    throw new Error(`${application} migration directory contains an unreviewed SQL file`);
  }
  const finalNames = [...baseNames, ...candidateNames].sort();
  const baselineIndex = finalNames.indexOf(contract.remoteBaseline);
  if (baselineIndex < 0 || JSON.stringify(finalNames.slice(baselineIndex + 1)) !== JSON.stringify(contract.expectedAppliedMigrations)
    || finalNames.at(-1) !== contract.finalMigration) {
    throw new Error(`${application} native migration range is not the exact reviewed contiguous suffix`);
  }
  return {
    directory,
    baseNames,
    finalNames,
    expectedRemoteAppliedMigrations: finalNames.slice(0, baselineIndex + 1),
  };
}

function outputLocations(base, application) {
  const runDirectory = path.join(base, "apps", application, ".staging-bootstrap", "native-portal-migrations");
  return {
    runDirectory,
    migrationsDirectory: path.join(runDirectory, "migrations"),
    manifestPath: path.join(runDirectory, "manifest.json"),
    configPath: path.join(base, "apps", application, "wrangler.staging.native-migrations.json"),
  };
}

function requireEffectivelyIgnored(base, target) {
  const relative = path.relative(base, target).replaceAll(path.sep, "/");
  const ignored = spawnSync("git", ["check-ignore", "--no-index", "--quiet", "--", relative],
    { cwd: base, encoding: "utf8" });
  if (ignored.status !== 0) throw new Error(`generated output is not effectively ignored: ${relative}`);
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relative],
    { cwd: base, encoding: "utf8" });
  if (tracked.status === 0) throw new Error(`generated output must not be tracked: ${relative}`);
}

export function buildProfiles(base) {
  const ignoreFile = path.join(base, ".gitignore");
  requireRegularFile(ignoreFile, ".gitignore");
  const profiles = {};
  for (const [application, contract] of Object.entries(NATIVE_MIGRATION_PROFILES)) {
    validateSourceConfig(base, application, contract);
    const source = validateSourceMigrations(base, application, contract);
    const locations = outputLocations(base, application);
    const migrationsDir = ".staging-bootstrap/native-portal-migrations/migrations";
    const config = {
      $schema: "node_modules/wrangler/config-schema.json",
      name: `migration-only-${contract.databaseName}`,
      account_id: STAGING_ACCOUNT_ID,
      d1_databases: [{
        binding: contract.binding,
        database_name: contract.databaseName,
        database_id: contract.databaseId,
        migrations_dir: migrationsDir,
      }],
    };
    const files = contract.expectedAppliedMigrations.map((name) => ({
      name,
      sourcePath: path.join(source.directory, name),
      sha256: sha256(fs.readFileSync(path.join(source.directory, name))),
    }));
    const manifest = {
      schemaVersion: PROFILE_SCHEMA_VERSION,
      purpose: "staging-native-portal-migrations-only",
      application,
      target: { accountId: STAGING_ACCOUNT_ID, binding: contract.binding,
        databaseName: contract.databaseName, databaseId: contract.databaseId },
      pinnedBase: { count: contract.baseCount, namesSha256: contract.baseNamesSha256,
        contentsSha256: contract.baseContentsSha256 },
      reviewedFinalChain: { count: source.finalNames.length, finalMigration: contract.finalMigration,
        namesSha256: sha256(source.finalNames.join("\n")) },
      requiredRemoteBaseline: contract.remoteBaseline,
      expectedAppliedMigrations: [...contract.expectedAppliedMigrations],
      finalMigration: contract.finalMigration,
      migrations: files.map(({ name, sha256: digest }) => ({ name, sha256: digest })),
      remoteActionsPerformed: false,
    };
    profiles[application] = {
      application,
      contract,
      config,
      manifest,
      files,
      expectedRemoteAppliedMigrations: source.expectedRemoteAppliedMigrations,
      ...locations,
    };
    requireEffectivelyIgnored(base, locations.configPath);
    requireEffectivelyIgnored(base, locations.manifestPath);
    requireEffectivelyIgnored(base, path.join(locations.migrationsDirectory, ".ignore-probe.sql"));
    for (const { name } of files) {
      requireEffectivelyIgnored(base, path.join(locations.migrationsDirectory, name));
    }
  }
  return profiles;
}

function requireContained(base, target, label) {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} escapes the repository`);
}

function requireSafeAncestors(base, target, label) {
  const absoluteBase = path.resolve(base), absoluteTarget = path.resolve(target);
  requireContained(absoluteBase, absoluteTarget, label);
  let current = absoluteBase;
  for (const part of path.dirname(path.relative(absoluteBase, absoluteTarget)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = lstat(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error(`${label} ancestor ${path.relative(absoluteBase, current)} must be a regular non-symlink directory`);
    }
  }
}

function prepareDirectory(directory, allowedNames, label, allowedDirectories = new Set()) {
  if (!fs.existsSync(directory)) { fs.mkdirSync(directory, { recursive: true }); return; }
  requireRegularDirectory(directory, label);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const allowedFile = allowedNames.has(entry.name) && entry.isFile() && !entry.isSymbolicLink();
    const allowedDirectory = allowedDirectories.has(entry.name) && entry.isDirectory() && !entry.isSymbolicLink();
    if (!allowedFile && !allowedDirectory) {
      throw new Error(`${label} contains unexpected or unsafe entry ${entry.name}`);
    }
  }
}

export function writeProfiles(base, profiles = buildProfiles(base)) {
  for (const profile of Object.values(profiles)) {
    for (const target of [profile.runDirectory, profile.migrationsDirectory, profile.manifestPath, profile.configPath]) {
      requireSafeAncestors(base, target, "generated output");
    }
    prepareDirectory(profile.runDirectory, new Set(["manifest.json"]), `${profile.application} profile directory`, new Set(["migrations"]));
    if (!fs.existsSync(profile.migrationsDirectory)) fs.mkdirSync(profile.migrationsDirectory);
    prepareDirectory(profile.migrationsDirectory, new Set(profile.files.map(({ name }) => name)), `${profile.application} generated migration directory`);
    for (const { name, sourcePath } of profile.files) fs.copyFileSync(sourcePath, path.join(profile.migrationsDirectory, name));
    fs.writeFileSync(profile.manifestPath, `${JSON.stringify(profile.manifest, null, 2)}\n`, { flag: "w" });
    const existingConfig = lstat(profile.configPath);
    if (existingConfig && (!existingConfig.isFile() || existingConfig.isSymbolicLink())) {
      throw new Error(`${profile.application} generated config must be a regular non-symlink file`);
    }
    fs.writeFileSync(profile.configPath, `${JSON.stringify(profile.config, null, 2)}\n`, { flag: "w" });
  }
  return profiles;
}

export function validateGenerated(base, profiles = buildProfiles(base)) {
  for (const profile of Object.values(profiles)) {
    const config = readJson(profile.configPath, `${profile.application} generated migration config`);
    if (JSON.stringify(config) !== JSON.stringify(profile.config)) throw new Error(`${profile.application} generated migration config is stale`);
    for (const forbidden of ["main", "vars", "routes", "services", "assets", "triggers", "queues", "r2_buckets", "workflows"]) {
      if (Object.hasOwn(config, forbidden)) throw new Error(`${profile.application} migration-only config contains forbidden deployment field ${forbidden}`);
    }
    const manifest = readJson(profile.manifestPath, `${profile.application} generated migration manifest`);
    if (JSON.stringify(manifest) !== JSON.stringify(profile.manifest)) throw new Error(`${profile.application} generated migration manifest is stale`);
    requireRegularDirectory(profile.migrationsDirectory, `${profile.application} generated migration directory`);
    const names = fs.readdirSync(profile.migrationsDirectory).sort();
    if (JSON.stringify(names) !== JSON.stringify(profile.files.map(({ name }) => name))) {
      throw new Error(`${profile.application} generated migration range is stale or contains extras`);
    }
    for (const file of profile.files) {
      const generated = path.join(profile.migrationsDirectory, file.name);
      requireRegularFile(generated, `${profile.application} generated migration ${file.name}`);
      const contents = fs.readFileSync(generated);
      if (contents.includes(13)) throw new Error(`${profile.application} generated migration must use LF-only line endings: ${file.name}`);
      if (sha256(contents) !== file.sha256) throw new Error(`${profile.application} generated migration changed: ${file.name}`);
    }
  }
  return true;
}

export function run(argv = process.argv.slice(2), base = repositoryRoot) {
  if (argv.length !== 1 || !["--write", "--check"].includes(argv[0])) {
    throw new Error("usage: node scripts/staging-native-migration-profile.mjs --write|--check");
  }
  const profiles = buildProfiles(base);
  if (argv[0] === "--write") writeProfiles(base, profiles);
  validateGenerated(base, profiles);
  const action = argv[0] === "--write" ? "Wrote and verified" : "Verified";
  console.log(`${action} isolated staging-native migration-only profiles. No remote action was performed.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { run(); }
  catch (error) { console.error(`staging native migration profile failed: ${error.message}`); process.exitCode = 1; }
}
