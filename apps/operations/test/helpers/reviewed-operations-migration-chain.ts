import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Test artifact contracts are JavaScript modules without declarations.
// @ts-expect-error reviewed test-only JavaScript module
import { BOOTSTRAP_APPS, CLIENT_CURRENT_SOURCE_MIGRATION_CHAIN, OPERATIONS_LATEST_SOURCE_MIGRATION_CHAIN } from "../../../../scripts/staging-bootstrap.mjs";
// @ts-expect-error reviewed test-only JavaScript module
import { REQUIRED_STAGING_MIGRATIONS } from "../../../../scripts/staging-requirements.mjs";

const initialOperationsMigrations = Object.freeze([
  "0001_operations.sql",
  "0002_seed_acl.sql",
  "0003_airspace_retention.sql",
  "0004_project_alpha_authority.sql",
  "0005_project_alpha_ops_acl.sql",
  "0006_airspace_sync_fingerprints.sql",
  "0007_pa_projection_fingerprints.sql",
  "0008_project_units_task_assignments.sql",
  "0009_project_managers.sql",
  "0010_delivery_reliability.sql",
  "0011_r2_crud_jobs.sql",
  "0012_incoming_request_acl.sql",
  "0013_dropbox_import.sql",
]);

const initialClientMigrations = Object.freeze([
  "0001_initial.sql",
  "0002_seed_initial_staff.sql",
  "0003_delivery_platform.sql",
  "0004_stream_resumable.sql",
  "0005_share_lifecycle.sql",
  "0006_download_quota.sql",
  "0007_aliases_workflow_jobs.sql",
  "0008_trash_tombstones.sql",
  "0090_aliases_incoming_requests.sql",
  "0091_client_notifications.sql",
  "0092_preview_derivative_identity.sql",
  "0093_reusable_incoming_uploads.sql",
  "0094_cloud_transfers.sql",
  "0095_trash_object_manifests.sql",
]);

// Separately reviewed application successors are byte-validated, but never
// enter the frozen Operations199/Client149 inventories returned by this helper.
const operationsSuccessors = Object.freeze({
  "0226_staff_personnel_scan_leases.sql": "3bb7249081a785cf3b63de975aad86fe931fb93ea191011706aaab67d4af2fc2",
  "0225_staff_personnel_documents.sql": "a6f7694f70cf370fa605ac44ee685f8235e8c2676877bb296ca955de8a1d0f11",
  "0222_employee_read_roots.sql": "1b91e7eebe6580df7a780a8b473e3325fde2d9a8a8dc37282bc40c6f32e8edda",
  "0223_employee_read_provisioning.sql": "d55a0d5e16f37f231e0938516a1ee7248b0e3b4190e8de5e6c68e1e9a3e1810a",
  "0224_windows_portal_publication_chain_index.sql": "4252667cceb62ca9bbbb3efd8804a7dc69f58dae1396240f0109fbac6abbcd15",
  "0221_portal_correspondence_lifecycle_write_guards.sql": "10aba7d094dbcf35276d95552f8d518fbfeed41ca8ce91f04818e1c863793e18",
  "0220_directory_profile_generation_recovery.sql": "87285f8df2703fc4d4ee09dba92f96008ecbefa74a3a6692ca18c65f359b37c2",
  "0219_staging_agent_read_authority.sql": "622f41e5e61b9389fa2d01ad40bd38a3483b75be5e9f36e17786f7f6f22f272d",
  "0218_client_onboarding_shared_company_approval.sql": "623a3303ed58f260866735a1d4c769c12f8ffeae5e7dc2d4ad6a774b7c88801b",
  "0217_client_onboarding_shared_company_plans.sql": "6178a51a9a7153ed3224569cdd98cd5080986f941009731bb5eb53b3bddfd934",
  "0213_client_onboarding_notification_attempts.sql": "6247935f8aab5f63998951a3945857b23967242586e153412bd75d0e33a02b6c",
  "0214_client_onboarding_portal_activation.sql": "120bc89960d04ead6fd772285775aa574a2b6071a982c03c91dfb8f0f37463a4",
  "0215_local_project_division_authority.sql": "62556fe4aa0af571d0c85eab197bea498ba73e76d6408a2a87f376d0c99f58c4",
  "0216_client_onboarding_existing_company.sql": "f60c4c9c8784fd2660c655cb691e2f7d96350e0caf25cc3d0b21d002f177049a",
  "0212_primary_portal_directory_correspondence.sql": "3ac44b2cda2182a1bff154da4e6909d7ace02ba7ac17f1cbc4fc734796935d6f",
  "0211_native_directory_create_observations.sql": "cb5ef5f3f0986e71f4a4f5ea7736306e1ef23ddf97e509d2a2566f1b52dbbca7",
  "0206_native_directory_existing_import.sql": "0af4b3a078eda8a701fdfc1e898e5dc539831537e0d2a461f6acee124ce6b7c2",
  "0207_shared_directory_profiles.sql": "cdd4947b8bf5ab672184ed3e4f8f3fb0b4afbd0edd0707e1772569f66f4f3d49",
  "0208_shared_profile_portal_authority.sql": "a00f580d85f8e857399a2520437836e3a1f09e7bddba1b4a6b27a6b66f3e9688",
  "0209_shared_profile_portal_native_writes.sql": "635ee4f206e95ca584097159b1bd9a8489ea77cb900aa5c1106832d42b7e0f8f",
  "0210_admin_finance_summary_permission.sql": "723c8c17880a9a8909422422b55275a8aadcf424ff7ba3bcc93f92c52917fe9d",
});

const clientSuccessors = Object.freeze({
  "0235_windows_portal_successor_candidates.sql": "50046477dda2efe378d4b01c7de9f4ff2383d1511cf56c4c7a9633b4e41c0841",
  "0236_windows_portal_successor_content_start_audit.sql": "fcbc6f9f802dee3e2bfe592f1476f485b24d7f5414ca86143ddd9a299e82ffcf",
  "0232_shared_profile_edit_authority.sql": "3c2b3ddbdb920739c8f4ab8f437808749f5f83581b098518c5efd41c2e0b0073",
  "0233_explicit_primary_workspace_folder_ownership.sql": "7d419b99aab73086c60571cd854d49b62351d5c43ad4347e5da1a1e2fb18878a",
  // Reviewed reenrollment receipts preserve revoked identity history and fence
  // secondary membership changes; this never expands the frozen Client149 prefix.
  "0234_pa_principal_reenrollment.sql": "40d6e811b19ade969ecfd68a6ea223e80cf67e8adadf818e7b1f885befa1a49b",
});

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Returns only the exact reviewed release migration inventory. Unknown physical
 * SQL files are not silently admitted to a full-chain test. Both the ordered
 * names and every source byte must match the immutable bootstrap contract.
 */
function reviewedMigrationNames(directory: URL, application: "delivery" | "operations",
  initial: readonly string[], rejectExtras: boolean): readonly string[] {
  const contract = BOOTSTRAP_APPS[application] as {
    migrationCount: number;
    migrationNamesSha256: string;
    migrationContentsSha256: string;
  };
  const required = REQUIRED_STAGING_MIGRATIONS[application] as readonly string[];
  const names = [...initial, ...required.slice(0, contract.migrationCount - initial.length)] as string[];
  // Current source suffixes are reviewed independently; they must not become
  // part of the immutable bootstrap/release prefix returned by this helper.
  const currentSource = application === "operations"
    ? OPERATIONS_LATEST_SOURCE_MIGRATION_CHAIN : CLIENT_CURRENT_SOURCE_MIGRATION_CHAIN;
  const currentNames = [...new Set([...names, ...Object.keys(currentSource.appendedMigrations)])].sort();
  if (names.length !== contract.migrationCount || new Set(names).size !== names.length
    || sha256(names.join("\n")) !== contract.migrationNamesSha256) {
    throw new Error(`reviewed-${application}-migration-name-contract-mismatch`);
  }
  if (rejectExtras) {
    const directoryStat = lstatSync(fileURLToPath(directory));
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error(`reviewed-${application}-migration-directory-invalid`);
    const physical = readdirSync(fileURLToPath(directory), { withFileTypes: true })
      .filter(entry => /\.sql$/i.test(entry.name));
    const physicalNames = physical.map(entry => entry.name).sort();
    const successors = application === "operations" ? operationsSuccessors : clientSuccessors;
    const expectedNames = [...currentNames, ...Object.keys(successors)].sort();
    if (physical.some(entry => !/^\d{4}_.+\.sql$/.test(entry.name) || !entry.isFile() || entry.isSymbolicLink())
      || JSON.stringify(physicalNames) !== JSON.stringify(expectedNames)) {
      throw new Error(`reviewed-${application}-migration-physical-inventory-mismatch`);
    }
    const reviewedPrefix = physicalNames.slice(0, currentSource.count);
    if (reviewedPrefix.length !== currentSource.count
      || reviewedPrefix.at(-1) !== currentSource.finalMigration
      || sha256(reviewedPrefix.join("\n")) !== currentSource.namesSha256) {
      throw new Error(`reviewed-${application}-current-source-name-contract-mismatch`);
    }
  }
  const contents = names.map(name => {
    const url = new URL(name, directory), path = fileURLToPath(url);
    let stat;
    try { stat = lstatSync(path); }
    catch { throw new Error(`reviewed-${application}-migration-file-invalid:${name}`); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`reviewed-${application}-migration-file-invalid:${name}`);
    return `${name}\0${sha256(readFileSync(path))}`;
  });
  if (sha256(contents.join("\n")) !== contract.migrationContentsSha256) {
    throw new Error(`reviewed-${application}-migration-content-contract-mismatch`);
  }
  if (rejectExtras) {
    const currentContents = currentNames.map(name => {
      const path = fileURLToPath(new URL(name, directory));
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`reviewed-${application}-migration-file-invalid:${name}`);
      return `${name}\0${sha256(readFileSync(path))}`;
    });
    if (sha256(currentContents.join("\n")) !== currentSource.contentsSha256) {
      throw new Error(`reviewed-${application}-current-source-content-contract-mismatch`);
    }
    const successors = application === "operations" ? operationsSuccessors : clientSuccessors;
    for (const [name, expectedHash] of Object.entries(successors)) {
      // Canonical Git SQL is LF; accept the same bytes in a CRLF checkout.
      const normalized = readFileSync(fileURLToPath(new URL(name, directory)), "utf8").replace(/\r\n/g, "\n");
      if (sha256(normalized) !== expectedHash) throw new Error(`reviewed-${application}-successor-content-contract-mismatch`);
    }
  }
  return names;
}

export function reviewedOperationsMigrationNames(directory: URL, { rejectExtras = true }: Readonly<{ rejectExtras?: boolean }> = {}): readonly string[] {
  return reviewedMigrationNames(directory, "operations", initialOperationsMigrations, rejectExtras);
}

export function reviewedClientMigrationNames(directory: URL): readonly string[] {
  return reviewedMigrationNames(directory, "delivery", initialClientMigrations, true);
}
