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
    expect(operations).toHaveLength(182);
    expect(operations.at(-1)).toBe("0182_project_alpha_directory_relationship_recovery_guard.sql");
    expect(operations.slice(-13)).toEqual([
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
    ]);
    expect(operations).toContain("0154_operations_portal_native_recipient_authority.sql");
    expect(operations).toContain("0158_operations_portal_native_delivery_authority.sql");
    expect(client).toHaveLength(147);
    expect(client.at(-1)).toBe("0228_operations_portal_native_content_start_audit.sql");
    expect(client).toContain("0224_operations_portal_native_recipient_authority.sql");
    expect(client).toContain("0227_operations_portal_native_delivery_authority.sql");
  });

  it("rejects changed or missing reviewed migration bytes", () => {
    const operations = copyMigrations("operations");
    writeFileSync(join(operations.directory, "0001_operations.sql"), "-- tampered reviewed migration\n");
    expect(() => reviewedOperationsMigrationNames(operations.url))
      .toThrow("reviewed-operations-migration-content-contract-mismatch");

    const client = copyMigrations("client");
    unlinkSync(join(client.directory, "0001_initial.sql"));
    expect(() => reviewedClientMigrationNames(client.url))
      .toThrow("reviewed-delivery-migration-file-invalid:0001_initial.sql");
  });
});
