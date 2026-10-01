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
    baseCount: 143,
    baseNamesSha256: "30f054b5af20d478ebbe8572be2372f171a6307ccc0713fc8beb3a5014cce063",
    baseContentsSha256: "1277fb9d6cd57dc36fb75d2ab4c8fff3ea04ada563b38a8374aa970089aa5b88",
    remoteBaseline: "0222_verified_recipient_delivery_cross_manager_revoke.sql",
    finalMigration: "0228_operations_portal_native_content_start_audit.sql",
    candidates: Object.freeze({
      "0224_operations_portal_native_recipient_authority.sql": "5835ae5f2a825a9073b21c43f4507f7873b6a25c1019cf161cb66e1c6275a8b0",
      "0226_operations_portal_native_workspace_cleanup.sql": "0cc2acd02386f84cf3938f7fe5514a162878dfbc89a13516c12e759eb285bfc3",
      "0227_operations_portal_native_delivery_authority.sql": "1ad80368d40f9fac270a60cbb8833f9a7e647679dbccd2424af55ca18921e07d",
      "0228_operations_portal_native_content_start_audit.sql": "441a11ca0992479f953de662de42041d35c9e41342bc345d59396fdcde569040",
    }),
    expectedAppliedMigrations: Object.freeze([
      "0223_operations_portal_workspace_publications.sql",
      "0224_operations_portal_native_recipient_authority.sql",
      "0225_operations_portal_workspace_publication_cancellations.sql",
      "0226_operations_portal_native_workspace_cleanup.sql",
      "0227_operations_portal_native_delivery_authority.sql",
      "0228_operations_portal_native_content_start_audit.sql",
    ]),
  }),
  operations: Object.freeze({
    binding: "OPS_DB",
    databaseName: "ltds-ops-staging",
    databaseId: "78b34173-b168-4e3d-9832-bb9d245cc6b8",
    workerName: "ledgetop-ops-staging",
    baseCount: 154,
    baseNamesSha256: "8c1557d412ccdf708e1af03e84a3e74b5cdd030e40dcca4611e3f0e794340189",
    baseContentsSha256: "d138d25feb4bb40ced50773d3d28ab9975d45e15f8956200539d196060682588",
    remoteBaseline: "0151_verified_recipient_delivery_authority_outbox.sql",
    finalMigration: "0164_project_alpha_directory_read_adoption_authority_recheck.sql",
    candidates: Object.freeze({
      "0154_operations_portal_native_recipient_authority.sql": "01d7aa68c70c5321c4f6974051a25ed0dd8b2fdd6db9f348f01334147c8a777d",
      "0156_operations_portal_workspace_publication_invocations.sql": "0cc8d7ab4b9ccd906c1c83b52db37e9fde702449973d81dd0490f52c47e8a819",
      "0157_operations_portal_native_workspace_cleanup.sql": "14c2e291ec972fb2293d15a52df69c8a3711279d3d4fb7dbf5a19c65c5ee0e1b",
      "0158_operations_portal_native_delivery_authority.sql": "034c830a00eab4ac259493e4af36d2eab2ab4f91883278fc1cbf578fffefb35b",
      "0159_operations_portal_native_delivery_recovery_invocations.sql": "9858a8da92f7cd96a73197eea499e8a6417aca3da3c0e61fc4062e701806a142",
      "0160_operations_portal_native_recipient_labels.sql": "f9174b07d194e1ccd8cadbfdee7d151a25e8d355489f4c10926534f9d93db06e",
      "0161_project_alpha_api_v2_inventory_observations.sql": "1b6fbb3b3ce8b50dbb553fd38ec8544c25f88a2837d8523b5ddeb0494534bd45",
      "0162_project_alpha_directory_read_adoption_claims.sql": "4bd97d25bd96a0a872bd3106ab936ab3fe1806b7456aec6cf02c92195715d1b0",
      "0163_project_alpha_directory_read_adoption_field_review_receipts.sql": "ef4abf5411e8fd4e10d4daeb94dd4ca3469ae7d179d2b135a9d04ca4a0cf12aa",
      "0164_project_alpha_directory_read_adoption_authority_recheck.sql": "e54cf701bf8943f13223b998b8c4e8209232762c86834b1e7a384b8775ddb5a4",
    }),
    expectedAppliedMigrations: Object.freeze([
      "0152_operations_portal_workspace_reservations.sql",
      "0153_operations_portal_workspace_publication_outbox.sql",
      "0154_operations_portal_native_recipient_authority.sql",
      "0155_operations_portal_workspace_publication_cancellations.sql",
      "0156_operations_portal_workspace_publication_invocations.sql",
      "0157_operations_portal_native_workspace_cleanup.sql",
      "0158_operations_portal_native_delivery_authority.sql",
      "0159_operations_portal_native_delivery_recovery_invocations.sql",
      "0160_operations_portal_native_recipient_labels.sql",
      "0161_project_alpha_api_v2_inventory_observations.sql",
      "0162_project_alpha_directory_read_adoption_claims.sql",
      "0163_project_alpha_directory_read_adoption_field_review_receipts.sql",
      "0164_project_alpha_directory_read_adoption_authority_recheck.sql",
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
    if (sha256(fs.readFileSync(file)) !== expected) throw new Error(`${application} native candidate changed: ${name}`);
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
      if (sha256(fs.readFileSync(generated)) !== file.sha256) throw new Error(`${profile.application} generated migration changed: ${file.name}`);
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
