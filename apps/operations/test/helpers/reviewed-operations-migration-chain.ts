import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Test artifact contracts are JavaScript modules without declarations.
// @ts-expect-error reviewed test-only JavaScript module
import { BOOTSTRAP_APPS } from "../../../../scripts/staging-bootstrap.mjs";
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

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Returns only the exact reviewed release migration inventory. Unknown physical
 * SQL files are not silently admitted to a full-chain test. Both the ordered
 * names and every source byte must match the immutable bootstrap contract.
 */
function reviewedMigrationNames(directory: URL, application: "delivery" | "operations",
  initial: readonly string[]): readonly string[] {
  const names = [...initial, ...REQUIRED_STAGING_MIGRATIONS[application]] as string[];
  const contract = BOOTSTRAP_APPS[application] as {
    migrationCount: number;
    migrationNamesSha256: string;
    migrationContentsSha256: string;
  };
  if (names.length !== contract.migrationCount || new Set(names).size !== names.length
    || sha256(names.join("\n")) !== contract.migrationNamesSha256) {
    throw new Error(`reviewed-${application}-migration-name-contract-mismatch`);
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
  return names;
}

export function reviewedOperationsMigrationNames(directory: URL): readonly string[] {
  return reviewedMigrationNames(directory, "operations", initialOperationsMigrations);
}

export function reviewedClientMigrationNames(directory: URL): readonly string[] {
  return reviewedMigrationNames(directory, "delivery", initialClientMigrations);
}
