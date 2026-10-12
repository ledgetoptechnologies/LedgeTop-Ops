import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OPERATIONS_CURRENT_SOURCE_MIGRATION_CHAIN } from "./staging-bootstrap.mjs";

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
    finalMigration: "0230_operations_portal_native_delivery_terminal_cancellations.sql",
    candidates: Object.freeze({
      "0229_operations_portal_native_delivery_regrant.sql": "1ac5f5df43dca126b28c05b50803a158ed54618c3e136669d06005cbaf56e3a9",
      "0230_operations_portal_native_delivery_terminal_cancellations.sql": "484231c43eee9957f6d1427bf8caedd409db78f40a7aca08115cbc85e1951c77",
    }),
    expectedAppliedMigrations: Object.freeze([
      "0229_operations_portal_native_delivery_regrant.sql",
      "0230_operations_portal_native_delivery_terminal_cancellations.sql",
    ]),
    historicalExpectedAppliedMigrations: Object.freeze([]),
    historicalCandidateNames: Object.freeze([]),
  }),
  operations: Object.freeze({
    binding: "OPS_DB",
    databaseName: "ltds-ops-staging",
    databaseId: "78b34173-b168-4e3d-9832-bb9d245cc6b8",
    workerName: "ledgetop-ops-staging",
    baseCount: 173,
    baseNamesSha256: "46d20b48362be8052f5b2fd35ec4ccefee2c267476a2a076af87a955c4cfca3a",
    baseContentsSha256: "cd35de12e87325fb6de854f4ecba47e5172e115f75830af9f4a908710d10a450",
    remoteBaseline: "0183_project_alpha_binding_standalone_relationship_rows.sql",
    finalMigration: "0199_native_directory_profile_binding_continuations.sql",
    currentRepositoryChain: OPERATIONS_CURRENT_SOURCE_MIGRATION_CHAIN,
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
      "0183_project_alpha_binding_standalone_relationship_rows.sql": "70b155e7ff2bda667832f14a5bea72523dd3e0fb285ce91f48c3e4a44e05ccac",
      "0184_project_alpha_directory_relationship_generation_recovery.sql": "12ccc3ccc3c3ad56edb8b21245a279581548c509d884b0ed5df6041988225f3b",
      "0185_project_alpha_directory_binding_generation_epochs.sql": "3c536f6e8ea3c745e0167d3a81308abbac7e9b24c127a95a3a8ab1d7c9fcd39e",
      "0186_project_alpha_directory_conflict_evidence_binding.sql": "6d19b3e6be44382c51681444e95a501845f8f3958e83930c5fba50501951fd92",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql": "ded89fe037cfb56f9ddf4316a4ddcc67c8ae00e58d66eebec9a8129c6536eb28",
      "0188_client_hub_native_project_preparations.sql": "5c455a13128a912a716d75b2dbba9bcde64bfd8479495036d4f63bbf3a7098bc",
      "0189_client_hub_native_project_uncertain_recovery.sql": "e7ee262257b677589cf089e0157fdf09863f3e14c2852b5da6bb51eff717a745",
      "0190_client_hub_native_project_preparation_authority.sql": "a662cd4a50c5eaee7a02bf720b1e5399d5d05712022fdd1426413fc707a83882",
      "0191_operations_portal_native_billing_authority.sql": "46b1adb3e6addb91ae108762af9cc8c855ec7a9ccc2e988d5dce056e697ffdfc",
      "0192_ops_service_definition_authority.sql": "8a2d278e0a3a852b08d23efcb9c278a44ba3ea01da89742bba5d3909c3b1d8b9",
      "0193_operations_portal_native_delivery_dead_conflict_recovery.sql": "2454b60512fa5aec38942d9bd62338f753b527c2e4319e6e7e391509f59bfa56",
      "0194_operations_portal_native_delivery_terminal_cancellations.sql": "75a8852921ff81e2926c97acc1636a38fc7dae13b45e653cceda93c23f962f6d",
      "0195_client_hub_native_project_current_owner_observation.sql": "aaa8b35e502ed634cd38ed16c5a870a91f63c0ee578a031aec15744e7947ea44",
      "0196_native_directory_maintenance_authority.sql": "84fe7276bb83bb72da6637d5b6827b56e80094c14acbc872935c444fb2a3870a",
      "0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql": "9cf2194a57cf7888c768d492c78cacf842e3f6c6814d3f395e6fa8f4d0a31a76",
      "0198_native_directory_active_binding_revision_refresh.sql": "a51026608eb70a0645540cfe12bad51feb7a97f924e0b2c3b83837a3ae2fa7c3",
      "0199_native_directory_profile_binding_continuations.sql": "056007062980460404fe85093cb796b855b91c23351a323457e91d5b053a2006",
    }),
    expectedAppliedMigrations: Object.freeze([
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
      "0188_client_hub_native_project_preparations.sql",
      "0189_client_hub_native_project_uncertain_recovery.sql",
      "0190_client_hub_native_project_preparation_authority.sql",
      "0191_operations_portal_native_billing_authority.sql",
      "0192_ops_service_definition_authority.sql",
      "0193_operations_portal_native_delivery_dead_conflict_recovery.sql",
      "0194_operations_portal_native_delivery_terminal_cancellations.sql",
      "0195_client_hub_native_project_current_owner_observation.sql",
      "0196_native_directory_maintenance_authority.sql",
      "0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql",
      "0198_native_directory_active_binding_revision_refresh.sql",
      "0199_native_directory_profile_binding_continuations.sql",
    ]),
    historical195ExpectedAppliedMigrations: Object.freeze([
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
      "0188_client_hub_native_project_preparations.sql",
      "0189_client_hub_native_project_uncertain_recovery.sql",
      "0190_client_hub_native_project_preparation_authority.sql",
      "0191_operations_portal_native_billing_authority.sql",
      "0192_ops_service_definition_authority.sql",
      "0193_operations_portal_native_delivery_dead_conflict_recovery.sql",
      "0194_operations_portal_native_delivery_terminal_cancellations.sql",
      "0195_client_hub_native_project_current_owner_observation.sql",
    ]),
    historical194ExpectedAppliedMigrations: Object.freeze([
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
      "0188_client_hub_native_project_preparations.sql",
      "0189_client_hub_native_project_uncertain_recovery.sql",
      "0190_client_hub_native_project_preparation_authority.sql",
      "0191_operations_portal_native_billing_authority.sql",
      "0192_ops_service_definition_authority.sql",
      "0193_operations_portal_native_delivery_dead_conflict_recovery.sql",
      "0194_operations_portal_native_delivery_terminal_cancellations.sql",
    ]),
    historicalExpectedAppliedMigrations: Object.freeze([
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
    ]),
    historical190ExpectedAppliedMigrations: Object.freeze([
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
      "0188_client_hub_native_project_preparations.sql",
      "0189_client_hub_native_project_uncertain_recovery.sql",
      "0190_client_hub_native_project_preparation_authority.sql",
    ]),
    historical192ExpectedAppliedMigrations: Object.freeze([
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
      "0188_client_hub_native_project_preparations.sql",
      "0189_client_hub_native_project_uncertain_recovery.sql",
      "0190_client_hub_native_project_preparation_authority.sql",
      "0191_operations_portal_native_billing_authority.sql",
      "0192_ops_service_definition_authority.sql",
    ]),
    historicalCandidateNames: Object.freeze([
      "0174_project_alpha_directory_preserved_external_identity.sql",
      "0175_operations_directory_acquired_parent_enrollment_identity.sql",
      "0176_operations_directory_acquired_intent_authority.sql",
      "0177_operations_directory_acquired_intent_update_authority.sql",
      "0178_project_alpha_project_inbound_reconciliation.sql",
      "0179_project_alpha_acquired_native_identity_collision.sql",
      "0180_project_alpha_project_v2_recovery_authorization.sql",
      "0181_project_alpha_directory_create_generation_recovery.sql",
      "0182_project_alpha_directory_relationship_recovery_guard.sql",
      "0183_project_alpha_binding_standalone_relationship_rows.sql",
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
    ]),
    historical190CandidateNames: Object.freeze([
      "0174_project_alpha_directory_preserved_external_identity.sql",
      "0175_operations_directory_acquired_parent_enrollment_identity.sql",
      "0176_operations_directory_acquired_intent_authority.sql",
      "0177_operations_directory_acquired_intent_update_authority.sql",
      "0178_project_alpha_project_inbound_reconciliation.sql",
      "0179_project_alpha_acquired_native_identity_collision.sql",
      "0180_project_alpha_project_v2_recovery_authorization.sql",
      "0181_project_alpha_directory_create_generation_recovery.sql",
      "0182_project_alpha_directory_relationship_recovery_guard.sql",
      "0183_project_alpha_binding_standalone_relationship_rows.sql",
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
      "0188_client_hub_native_project_preparations.sql",
      "0189_client_hub_native_project_uncertain_recovery.sql",
      "0190_client_hub_native_project_preparation_authority.sql",
    ]),
    historical192CandidateNames: Object.freeze([
      "0174_project_alpha_directory_preserved_external_identity.sql",
      "0175_operations_directory_acquired_parent_enrollment_identity.sql",
      "0176_operations_directory_acquired_intent_authority.sql",
      "0177_operations_directory_acquired_intent_update_authority.sql",
      "0178_project_alpha_project_inbound_reconciliation.sql",
      "0179_project_alpha_acquired_native_identity_collision.sql",
      "0180_project_alpha_project_v2_recovery_authorization.sql",
      "0181_project_alpha_directory_create_generation_recovery.sql",
      "0182_project_alpha_directory_relationship_recovery_guard.sql",
      "0183_project_alpha_binding_standalone_relationship_rows.sql",
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
      "0188_client_hub_native_project_preparations.sql",
      "0189_client_hub_native_project_uncertain_recovery.sql",
      "0190_client_hub_native_project_preparation_authority.sql",
      "0191_operations_portal_native_billing_authority.sql",
      "0192_ops_service_definition_authority.sql",
    ]),
    historical194CandidateNames: Object.freeze([
      "0174_project_alpha_directory_preserved_external_identity.sql",
      "0175_operations_directory_acquired_parent_enrollment_identity.sql",
      "0176_operations_directory_acquired_intent_authority.sql",
      "0177_operations_directory_acquired_intent_update_authority.sql",
      "0178_project_alpha_project_inbound_reconciliation.sql",
      "0179_project_alpha_acquired_native_identity_collision.sql",
      "0180_project_alpha_project_v2_recovery_authorization.sql",
      "0181_project_alpha_directory_create_generation_recovery.sql",
      "0182_project_alpha_directory_relationship_recovery_guard.sql",
      "0183_project_alpha_binding_standalone_relationship_rows.sql",
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
      "0188_client_hub_native_project_preparations.sql",
      "0189_client_hub_native_project_uncertain_recovery.sql",
      "0190_client_hub_native_project_preparation_authority.sql",
      "0191_operations_portal_native_billing_authority.sql",
      "0192_ops_service_definition_authority.sql",
      "0193_operations_portal_native_delivery_dead_conflict_recovery.sql",
      "0194_operations_portal_native_delivery_terminal_cancellations.sql",
    ]),
    historical195CandidateNames: Object.freeze([
      "0174_project_alpha_directory_preserved_external_identity.sql",
      "0175_operations_directory_acquired_parent_enrollment_identity.sql",
      "0176_operations_directory_acquired_intent_authority.sql",
      "0177_operations_directory_acquired_intent_update_authority.sql",
      "0178_project_alpha_project_inbound_reconciliation.sql",
      "0179_project_alpha_acquired_native_identity_collision.sql",
      "0180_project_alpha_project_v2_recovery_authorization.sql",
      "0181_project_alpha_directory_create_generation_recovery.sql",
      "0182_project_alpha_directory_relationship_recovery_guard.sql",
      "0183_project_alpha_binding_standalone_relationship_rows.sql",
      "0184_project_alpha_directory_relationship_generation_recovery.sql",
      "0185_project_alpha_directory_binding_generation_epochs.sql",
      "0186_project_alpha_directory_conflict_evidence_binding.sql",
      "0187_operations_portal_native_delivery_literal_prefix_guard.sql",
      "0188_client_hub_native_project_preparations.sql",
      "0189_client_hub_native_project_uncertain_recovery.sql",
      "0190_client_hub_native_project_preparation_authority.sql",
      "0191_operations_portal_native_billing_authority.sql",
      "0192_ops_service_definition_authority.sql",
      "0193_operations_portal_native_delivery_dead_conflict_recovery.sql",
      "0194_operations_portal_native_delivery_terminal_cancellations.sql",
      "0195_client_hub_native_project_current_owner_observation.sql",
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
  const repositoryNames = entries.filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name).sort();
  const currentRepositoryChain = contract.currentRepositoryChain;
  const hasCurrentAppend = currentRepositoryChain
    && repositoryNames.includes(currentRepositoryChain.appendedMigration);
  if (hasCurrentAppend) {
    const appendedFile = path.join(directory, currentRepositoryChain.appendedMigration);
    requireRegularFile(appendedFile, `${application} current repository append`);
    if (repositoryNames.length !== currentRepositoryChain.count
      || repositoryNames.at(-1) !== currentRepositoryChain.finalMigration
      || sha256(repositoryNames.join("\n")) !== currentRepositoryChain.namesSha256
      || migrationChainDigest(directory, repositoryNames) !== currentRepositoryChain.contentsSha256
      || sha256(fs.readFileSync(appendedFile)) !== currentRepositoryChain.appendedSha256) {
      throw new Error(`${application} current repository migration inventory changed`);
    }
  }
  const names = hasCurrentAppend
    ? repositoryNames.filter((name) => name !== currentRepositoryChain.appendedMigration)
    : repositoryNames;
  const candidateNames = Object.keys(contract.candidates).sort();
  const candidateSet = new Set(candidateNames);
  const baseNames = names.filter((name) => !candidateSet.has(name));
  if (baseNames.length !== contract.baseCount || sha256(baseNames.join("\n")) !== contract.baseNamesSha256) {
    throw new Error(`${application} pinned base migration inventory changed`);
  }
  if (migrationChainDigest(directory, baseNames) !== contract.baseContentsSha256) {
    throw new Error(`${application} pinned base migration contents changed`);
  }
  const historicalCandidateNames = contract.historicalCandidateNames ?? candidateNames;
  const historical190CandidateNames = contract.historical190CandidateNames ?? candidateNames;
  const historical192CandidateNames = contract.historical192CandidateNames ?? candidateNames;
  const historical194CandidateNames = contract.historical194CandidateNames ?? candidateNames;
  const historical195CandidateNames = contract.historical195CandidateNames ?? candidateNames;
  // Preserve the exact previously reviewed 0196 window; 0197 alone is not a reviewed successor.
  const historical196CandidateNames = contract.historical195CandidateNames
    ? [...contract.historical195CandidateNames, "0196_native_directory_maintenance_authority.sql"] : candidateNames;
  const historical198CandidateNames = application === "operations" ? candidateNames.filter(name => !name.startsWith("0199_")) : candidateNames;
  const presentCandidateNames = candidateNames.filter((name) => names.includes(name));
  const currentChain = JSON.stringify(presentCandidateNames) === JSON.stringify(candidateNames);
  const historicalChain = JSON.stringify(presentCandidateNames) === JSON.stringify(historicalCandidateNames);
  const historical190Chain = JSON.stringify(presentCandidateNames) === JSON.stringify(historical190CandidateNames);
  const historical192Chain = JSON.stringify(presentCandidateNames) === JSON.stringify(historical192CandidateNames);
  const historical194Chain = JSON.stringify(presentCandidateNames) === JSON.stringify(historical194CandidateNames);
  const historical195Chain = JSON.stringify(presentCandidateNames) === JSON.stringify(historical195CandidateNames);
  const historical196Chain = JSON.stringify(presentCandidateNames) === JSON.stringify(historical196CandidateNames);
  const historical198Chain = JSON.stringify(presentCandidateNames) === JSON.stringify(historical198CandidateNames);
  const selectedCandidateNames = currentChain ? candidateNames : historical198Chain ? historical198CandidateNames : historical196Chain ? historical196CandidateNames
    : historical195Chain ? historical195CandidateNames
    : historical194Chain ? historical194CandidateNames
    : historical192Chain ? historical192CandidateNames
    : historical190Chain ? historical190CandidateNames
    : historicalChain ? historicalCandidateNames : null;
  if (!selectedCandidateNames) throw new Error(`${application} migration directory is not an exact reviewed historical or current chain`);
  for (const name of selectedCandidateNames) {
    const expected = contract.candidates[name];
    const file = path.join(directory, name);
    requireRegularFile(file, `${application} native candidate ${name}`);
    const contents = fs.readFileSync(file);
    if (contents.includes(13)) throw new Error(`${application} native candidate must use LF-only line endings: ${name}`);
    if (sha256(contents) !== expected) throw new Error(`${application} native candidate changed: ${name}`);
  }
  if (names.length !== baseNames.length + selectedCandidateNames.length) {
    throw new Error(`${application} migration directory contains an unreviewed SQL file`);
  }
  const finalNames = [...baseNames, ...selectedCandidateNames].sort();
  const baselineIndex = finalNames.indexOf(contract.remoteBaseline);
  const expectedAppliedMigrations = finalNames.slice(baselineIndex + 1);
  const reviewedAppliedMigrations = currentChain
    ? contract.expectedAppliedMigrations : historical198Chain
      ? contract.expectedAppliedMigrations.filter(name => !name.startsWith("0199_")) : historical196Chain
      ? [...contract.historical195ExpectedAppliedMigrations, "0196_native_directory_maintenance_authority.sql"] : historical195Chain
      ? contract.historical195ExpectedAppliedMigrations : historical194Chain
      ? contract.historical194ExpectedAppliedMigrations : historical192Chain
      ? contract.historical192ExpectedAppliedMigrations : historical190Chain
      ? contract.historical190ExpectedAppliedMigrations : contract.historicalExpectedAppliedMigrations;
  const reviewedFinalMigration = reviewedAppliedMigrations.at(-1) ?? contract.remoteBaseline;
  if (baselineIndex < 0 || JSON.stringify(expectedAppliedMigrations) !== JSON.stringify(reviewedAppliedMigrations)
    || finalNames.at(-1) !== reviewedFinalMigration) {
    throw new Error(`${application} native migration range is not the exact reviewed contiguous suffix`);
  }
  return {
    directory,
    baseNames,
    finalNames,
    expectedRemoteAppliedMigrations: finalNames.slice(0, baselineIndex + 1),
    expectedAppliedMigrations,
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
    const files = source.expectedAppliedMigrations.map((name) => ({
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
      reviewedFinalChain: { count: source.finalNames.length, finalMigration: source.finalNames.at(-1),
        namesSha256: sha256(source.finalNames.join("\n")) },
      requiredRemoteBaseline: contract.remoteBaseline,
      expectedAppliedMigrations: [...source.expectedAppliedMigrations],
      finalMigration: source.finalNames.at(-1),
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
