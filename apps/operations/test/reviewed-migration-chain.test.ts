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
  it("selects only the immutable release inventories, not stopped physical drafts", () => {
    const operations = reviewedOperationsMigrationNames(new URL("../migrations/", import.meta.url));
    const client = reviewedClientMigrationNames(new URL("../../client/migrations/", import.meta.url));
    expect(operations).toHaveLength(154);
    expect(operations.at(-1)).toBe("0155_operations_portal_workspace_publication_cancellations.sql");
    expect(operations).not.toContain("0154_operations_portal_native_recipient_authority.sql");
    expect(client).toHaveLength(143);
    expect(client.at(-1)).toBe("0225_operations_portal_workspace_publication_cancellations.sql");
    expect(client).not.toContain("0224_operations_portal_native_recipient_authority.sql");
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
