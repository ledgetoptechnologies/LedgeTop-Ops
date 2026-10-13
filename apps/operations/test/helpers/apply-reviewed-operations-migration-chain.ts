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

/** Applies only the exact byte-reviewed Operations migration inventory. */
export async function applyReviewedOperationsMigrationChain(database: D1Database): Promise<readonly string[]> {
  const directory = new URL("../../../operations/migrations/", import.meta.url);
  const names = reviewedOperationsMigrationNames(directory);
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
