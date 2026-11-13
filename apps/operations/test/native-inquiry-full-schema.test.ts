import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reviewedClientMigrationNames, reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";
// @ts-expect-error reviewed test-only JavaScript seed transformer
import { transformSeed } from "../../../scripts/staging-bootstrap.mjs";

it("applies both complete hash-admitted source schemas through the independent inquiry successors", async () => {
  const owner = { email: "inquiry-schema@staging.example.test", displayName: "Synthetic Staging Inquiry Schema Owner",
    clientStaffId: "staging-inquiry-schema-client-owner", operationsStaffId: "staging-inquiry-schema-operations-owner" };
  const applications = [
    { name: "operations", binding: "OPS_DB", directory: new URL("../migrations/", import.meta.url),
      admit: reviewedOperationsMigrationNames, physicalCount: 237,
      successors: ["0233_operations_portal_native_recipient_capability_intents.sql",
        "0234_operations_portal_native_inquiry_capability.sql", "0235_ops_principal_inquiries.sql"],
      emptyTables: ["operations_portal_native_inquiry_capability_commands", "operations_portal_native_inquiry_capability_heads",
        "operations_portal_native_inquiry_capability_closures", "operations_native_principal_inquiries",
        "operations_native_principal_inquiry_outbox", "operations_native_principal_inquiry_audit"] },
    { name: "delivery", binding: "DELIVERY_DB", directory: new URL("../../client/migrations/", import.meta.url),
      admit: reviewedClientMigrationNames, physicalCount: 162,
      successors: ["0243_operations_portal_native_inquiry_capability.sql"],
      emptyTables: ["operations_portal_native_inquiry_capability_commands", "operations_portal_native_inquiry_capability_heads",
        "operations_portal_native_inquiry_capability_receipts", "operations_portal_native_inquiry_capability_closures"] },
  ] as const;
  // Admission validates the entire physical inventory and all source/successor
  // hashes before enumeration. It does not expand the frozen release prefix.
  const admitted = applications.map(application => {
    application.admit(application.directory);
    const names = readdirSync(application.directory).filter(name => name.endsWith(".sql")).sort();
    expect(names).toHaveLength(application.physicalCount);
    // Later reviewed Logs/staff migrations follow inquiry SQL lexically. Check
    // the exact request subset without pretending it is the physical suffix;
    // admission above still rejects any unreviewed name or byte change.
    const requestSuccessors = new Set<string>(application.successors);
    expect(names.filter(name => requestSuccessors.has(name))).toEqual(application.successors);
    return { ...application, names };
  });
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: crypto.randomUUID(), DELIVERY_DB: crypto.randomUUID() } });
  try {
    for (const application of admitted) {
      const database = await runtime.getD1Database(application.binding) as unknown as D1Database;
      await database.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
      for (const name of application.names) {
        const raw = readFileSync(new URL(name, application.directory), "utf8").replace(/\r\n/g, "\n");
        const seed = application.name === "operations" ? "0002_seed_acl.sql" : "0002_seed_initial_staff.sql";
        const sql = name === seed ? transformSeed(application.name, raw, owner) as string : raw;
        await database.batch([...splitD1MigrationStatements(sql).map(statement => database.prepare(statement)),
          database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
      }
      const ledger = await database.prepare("SELECT name FROM d1_migrations ORDER BY name").all<{ name: string }>();
      expect(ledger.results.map(row => row.name)).toEqual(application.names);
      expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      for (const table of application.emptyTables) {
        expect(await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first("name")).toBe(table);
        expect(await database.prepare(`SELECT count(*) n FROM ${table}`).first("n")).toBe(0);
      }
      // A successfully created schema must not silently reference a missing
      // parent table even when its new request tables contain no rows yet.
      // D1 permits explicit PRAGMA foreign_key_list statements, but rejects
      // the SQLite table-valued pragma_foreign_key_list function with AUTH.
      const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
      const tableNames = new Set(tables.results.map(row => row.name));
      // D1's own metadata table is visible in sqlite_master but forbids PRAGMA
      // introspection. It is not an application table or migration prerequisite.
      const applicationTables = tables.results.filter(row => row.name !== "_cf_METADATA");
      const references = await database.batch<{ table: string }>(applicationTables.map(row =>
        database.prepare(`PRAGMA foreign_key_list("${row.name.replaceAll('"', '""')}")`)));
      const missingParents = references.flatMap((result, index) => {
        const child = applicationTables[index];
        if (!child) throw new Error("Unexpected D1 foreign-key inspection result index");
        return result.results.filter(row => !tableNames.has(row.table))
          .map(row => ({ child: child.name, parent: row.table }));
      });
      expect(missingParents).toEqual([]);
    }
  } finally { await runtime.dispose(); }
}, 300_000);
