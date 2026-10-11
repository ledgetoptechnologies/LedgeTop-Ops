import { readFileSync } from "node:fs";
import { splitD1MigrationStatements } from "../../../client/test/helpers/d1-migrations";
// Test artifact generator is a JavaScript CLI module without declarations.
// @ts-expect-error reviewed test-only JavaScript module
import { transformSeed } from "../../../../scripts/staging-bootstrap.mjs";
import { reviewedOperationsMigrationNames } from "./reviewed-operations-migration-chain";

const syntheticOwner = Object.freeze({
  email: "owner@staging.example.test",
  displayName: "Synthetic Staging Owner",
  clientStaffId: "staging-client-owner",
  operationsStaffId: "staging-operations-owner",
});

/** Validates the entire byte-reviewed source before applying current or frozen historical schema. */
export async function applyReviewedOperationsMigrationChain(database: D1Database,
  throughMigration?: "0196_native_directory_maintenance_authority.sql"): Promise<readonly string[]> {
  const directory = new URL("../../../operations/migrations/", import.meta.url);
  const reviewed = reviewedOperationsMigrationNames(directory);
  const last = throughMigration === undefined ? reviewed.length - 1 : reviewed.indexOf(throughMigration);
  if (last < 0) throw new Error("reviewed-operations-migration-prefix-missing");
  const names = reviewed.slice(0, last + 1);
  await database.prepare(`CREATE TABLE d1_migrations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`).run();
  for (const name of names) {
    const raw = readFileSync(new URL(name, directory), "utf8");
    const source = name === "0002_seed_acl.sql"
      ? transformSeed("operations", raw, syntheticOwner) as string
      : raw;
    await database.batch([
      ...splitD1MigrationStatements(source).map(statement => database.prepare(statement)),
      database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name),
    ]);
  }
  return names;
}
