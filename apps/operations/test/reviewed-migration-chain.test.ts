import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { reviewedClientMigrationNames, reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";

const temporaryDirectories: string[] = [];
function copyMigrations(application: "client" | "operations"): { directory: string; url: URL } {
  const base = mkdtempSync(join(tmpdir(), `ltds-reviewed-${application}-`));
  temporaryDirectories.push(base);
  const directory = join(base, "migrations");
  cpSync(new URL(`../../${application}/migrations/`, import.meta.url), directory, { recursive: true });
  return { directory, url: pathToFileURL(`${directory}/`) };
}

afterEach(() => {
  const temporaryRoot = resolve(tmpdir());
  for (const directory of temporaryDirectories.splice(0)) {
    const target = resolve(directory);
    assert.notEqual(target, temporaryRoot);
    assert.ok(target.startsWith(`${temporaryRoot}${sep}`));
    assert.ok(basename(target).startsWith("ltds-reviewed-"));
    rmSync(target, { recursive: true, force: true });
  }
});

describe("reviewed release migration fixtures", () => {
  it("selects the immutable release inventories including the promoted native portal migrations", () => {
    const operations = reviewedOperationsMigrationNames(new URL("../migrations/", import.meta.url));
    const client = reviewedClientMigrationNames(new URL("../../client/migrations/", import.meta.url));
    expect(operations).toHaveLength(199);
    expect(operations.at(-1)).toBe("0199_native_directory_profile_binding_continuations.sql");
    expect(operations.slice(-30)).toEqual([
      "0170_project_alpha_active_directory_project_guard.sql",
      "0171_project_alpha_active_directory_update_guard.sql",
      "0172_project_alpha_active_directory_consumer_guards.sql",
      "0173_operations_directory_intent_acquired_destination_transition.sql",
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
      "0196_native_directory_maintenance_authority.sql",
      "0197_operations_portal_native_delivery_cancellation_checkpoint_scope.sql",
      "0198_native_directory_active_binding_revision_refresh.sql",
      "0199_native_directory_profile_binding_continuations.sql",
    ]);
    expect(operations).toContain("0154_operations_portal_native_recipient_authority.sql");
    expect(operations).toContain("0158_operations_portal_native_delivery_authority.sql");
    expect(client).toHaveLength(149);
    expect(client.at(-1)).toBe("0230_operations_portal_native_delivery_terminal_cancellations.sql");
    expect(client).toContain("0224_operations_portal_native_recipient_authority.sql");
    expect(client).toContain("0227_operations_portal_native_delivery_authority.sql");
    expect(client).toContain("0229_operations_portal_native_delivery_regrant.sql");
  });

  it("rejects changed or missing reviewed migration bytes", () => {
    const operations = copyMigrations("operations");
    writeFileSync(join(operations.directory, "0001_operations.sql"), "-- tampered reviewed migration\n");
    expect(() => reviewedOperationsMigrationNames(operations.url))
      .toThrow("reviewed-operations-migration-content-contract-mismatch");

    const client = copyMigrations("client");
    unlinkSync(join(client.directory, "0001_initial.sql"));
    expect(() => reviewedClientMigrationNames(client.url))
      .toThrow("reviewed-delivery-migration-physical-inventory-mismatch");
  });

  it("rejects unreviewed physical SQL files in full-chain mode but permits intentional reviewed prefixes", () => {
    const operations = copyMigrations("operations");
    writeFileSync(join(operations.directory, "0200_unreviewed.sql"), "-- unreviewed\n");
    expect(() => reviewedOperationsMigrationNames(operations.url))
      .toThrow("reviewed-operations-migration-physical-inventory-mismatch");
    expect(reviewedOperationsMigrationNames(operations.url, { rejectExtras: false })).toHaveLength(199);
  });

  it("validates the exact appended 0200 source independently without granting it historical-chain authority", () => {
    const operations = copyMigrations("operations");
    writeFileSync(join(operations.directory, "0200_native_directory_active_binding_refresh_supersessions.sql"), "-- changed current source\n");
    expect(() => reviewedOperationsMigrationNames(operations.url))
      .toThrow("reviewed-operations-current-source-content-contract-mismatch");
    expect(reviewedOperationsMigrationNames(operations.url, { rejectExtras: false })).toHaveLength(199);
  });

  it.each([
    "0201_native_directory_lifecycle.sql",
    "0202_reviewed_import_enrollment.sql",
    "0203_effective_native_directory_enrollment_consumers.sql",
  ])("rejects tampered or missing current suffix %s without expanding the release prefix", name => {
    const tampered = copyMigrations("operations");
    writeFileSync(join(tampered.directory, name), "-- changed reviewed suffix\n");
    expect(() => reviewedOperationsMigrationNames(tampered.url))
      .toThrow("reviewed-operations-current-source-content-contract-mismatch");
    expect(reviewedOperationsMigrationNames(tampered.url, { rejectExtras: false })).toHaveLength(199);

    const missing = copyMigrations("operations");
    unlinkSync(join(missing.directory, name));
    expect(() => reviewedOperationsMigrationNames(missing.url))
      .toThrow("reviewed-operations-migration-physical-inventory-mismatch");
    expect(reviewedOperationsMigrationNames(missing.url, { rejectExtras: false })).toHaveLength(199);
  });
});
