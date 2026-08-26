import { readFileSync } from "node:fs";
import { splitD1MigrationStatements } from "../../../client/test/helpers/d1-migrations";

/** Thin directory fixtures already have source-bearing pa_* tables. Reuse the
 * real immutable mapping contract without replaying 0033's ALTER/backfill work.
 * Call only on fixtures that have not applied the complete migration chain. */
export async function applyBusinessPartySchema(db: D1Database): Promise<void> {
  const projection = readFileSync(new URL("../../migrations/0033_projection_sources.sql", import.meta.url), "utf8");
  const definitions = splitD1MigrationStatements(projection);
  const required = [
    /^CREATE TABLE pa_projection_record_ids\s*\(/,
    /^CREATE TRIGGER pa_projection_record_ids_no_replacement\b/,
    /^CREATE TRIGGER pa_projection_record_ids_no_reassignment\b/,
    /^CREATE TRIGGER pa_projection_record_ids_no_delete\b/,
  ];
  const mapping = required.map(pattern => {
    const matches = definitions.filter(statement => pattern.test(statement.replace(/^\s*--.*$/gm, "").trim()));
    if (matches.length !== 1) throw new Error("Business party fixture requires the exact 0033 mapping contract");
    return matches[0]!;
  });
  await db.batch(mapping.map(statement => db.prepare(statement)));
  const parties = readFileSync(new URL("../../migrations/0036_business_parties.sql", import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(parties).map(statement => db.prepare(statement)));
}

/** Real staff-policy tables for route fixtures whose older ACL paths are mocked.
 * The business-party reader and its transaction predicates remain unmocked. */
export async function applyBusinessPartyStaffSchema(db: D1Database): Promise<void> {
  const definitions = splitD1MigrationStatements(readFileSync(new URL("../../migrations/0001_operations.sql", import.meta.url), "utf8"));
  const tables = ["divisions", "staff_users", "permissions", "roles", "role_permissions", "staff_role_assignments", "staff_permission_overrides"];
  const statements = tables.map(table => {
    const matches = definitions.filter(statement => new RegExp(`^CREATE TABLE ${table}\\s*\\(`)
      .test(statement.replace(/^\s*--.*$/gm, "").trim()));
    if (matches.length !== 1) throw new Error("Business party fixture requires the exact staff-policy table");
    return matches[0]!;
  });
  const localDefinitions = splitD1MigrationStatements(readFileSync(new URL("../../migrations/0011_r2_crud_jobs.sql", import.meta.url), "utf8"));
  const local = localDefinitions.filter(statement => /^CREATE TABLE IF NOT EXISTS local_staff_role_assignments\s*\(/
    .test(statement.replace(/^\s*--.*$/gm, "").trim()));
  if (local.length !== 1) throw new Error("Business party fixture requires the exact local staff-policy table");
  await db.batch([...statements, local[0]!].map(statement => db.prepare(statement)));
}
