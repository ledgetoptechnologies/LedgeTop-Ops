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
  "0206_native_directory_existing_import.sql": "0af4b3a078eda8a701fdfc1e898e5dc539831537e0d2a461f6acee124ce6b7c2",
  "0207_shared_directory_profiles.sql": "cdd4947b8bf5ab672184ed3e4f8f3fb0b4afbd0edd0707e1772569f66f4f3d49",
  "0208_shared_profile_portal_authority.sql": "a00f580d85f8e857399a2520437836e3a1f09e7bddba1b4a6b27a6b66f3e9688",
  "0209_shared_profile_portal_native_writes.sql": "635ee4f206e95ca584097159b1bd9a8489ea77cb900aa5c1106832d42b7e0f8f",
});

const clientSuccessors = Object.freeze({
  "0232_shared_profile_edit_authority.sql": "3c2b3ddbdb920739c8f4ab8f437808749f5f83581b098518c5efd41c2e0b0073",
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
