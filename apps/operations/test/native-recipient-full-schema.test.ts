import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reviewedClientMigrationNames, reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";
// Existing reviewed test artifact generator; no declarations are provided.
// @ts-expect-error test-only JavaScript artifact module
import { transformSeed } from "../../../scripts/staging-bootstrap.mjs";

const owner = { email: "schema-owner@staging.example.test", displayName: "Synthetic Staging Schema Owner",
  clientStaffId: "staging-schema-client-owner", operationsStaffId: "staging-schema-operations-owner" };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Compatibility rehearsal, not release approval: validate the immutable base
 * inventory, then admit only these explicitly named local drafts. Unknown SQL
 * files cannot enter this fixture through directory enumeration. */
it("applies the real reviewed schemas plus the exact native drafts in release order", async () => {
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: crypto.randomUUID(), DELIVERY_DB: crypto.randomUUID() } });
  try {
    for (const application of ["operations", "client"] as const) {
      const directory = new URL(`../${application === "operations" ? "" : "../client/"}migrations/`, import.meta.url);
      const drafts = application === "operations"
        ? ["0154_operations_portal_native_recipient_authority.sql", "0156_operations_portal_workspace_publication_invocations.sql",
          "0157_operations_portal_native_workspace_cleanup.sql", "0158_operations_portal_native_delivery_authority.sql",
          "0159_operations_portal_native_delivery_recovery_invocations.sql",
          "0160_operations_portal_native_recipient_labels.sql"]
        : ["0224_operations_portal_native_recipient_authority.sql", "0226_operations_portal_native_workspace_cleanup.sql",
          "0227_operations_portal_native_delivery_authority.sql", "0228_operations_portal_native_content_start_audit.sql"];
      const reviewed = application === "operations"
        ? reviewedOperationsMigrationNames(directory) : reviewedClientMigrationNames(directory);
      // The reviewed inventory includes these pending candidate migrations and
      // verifies their bytes. Remove them from the baseline here, then admit
      // each exact draft once below in the deliberate release order.
      const base = reviewed.filter(name => !drafts.includes(name));
      expect(drafts.every(name => !base.includes(name))).toBe(true);
      const names = [...base, ...drafts].sort();
      const sources = new Map(names.map(name => [name, readFileSync(new URL(name, directory), "utf8")]));
      const draftHashes = new Map(drafts.map(name => [name, hash(sources.get(name)!)]));
      // Miniflare and generated platform types are independently declared; this
      // test-only adapter never crosses a production serialization boundary.
      const database = await runtime.getD1Database(application === "operations" ? "OPS_DB" : "DELIVERY_DB") as unknown as D1Database;
      await database.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
      for (const name of names) {
        const raw = sources.get(name)!;
        const seed = application === "operations" ? "0002_seed_acl.sql" : "0002_seed_initial_staff.sql";
        const source = name === seed ? transformSeed(application === "client" ? "delivery" : application,
          raw.replace(/\r\n/g, "\n"), owner) as string : raw;
        await database.batch([...splitD1MigrationStatements(source).map(statement => database.prepare(statement)),
          database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
      }
      const ledger = await database.prepare("SELECT name FROM d1_migrations ORDER BY name").all<{ name: string }>();
      expect(ledger.results.map(row => row.name)).toEqual(names);
      expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      for (const name of drafts) expect(hash(readFileSync(new URL(name, directory), "utf8"))).toBe(draftHashes.get(name));
      if (application === "operations") {
        const snapshots = await database.prepare("PRAGMA table_info(operations_portal_workspace_publication_snapshots)").all<{ name: string }>();
        expect(snapshots.results.map(column => column.name)).toContain("checkpoint_id");
        expect(snapshots.results.map(column => column.name)).not.toContain("operation_id");
        for (const table of ["operations_portal_native_recipient_intents", "operations_portal_native_authority_outbox",
          "operations_portal_native_recipient_labels",
          "operations_portal_workspace_publication_invocations", "operations_portal_native_workspace_cleanup_commands",
          "operations_portal_native_workspace_cleanup_outbox", "operations_portal_native_workspace_cleanup_receipts"]) {
          expect(await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first()).not.toBeNull();
        }
      } else {
        expect(await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operations_portal_native_authority_commands'").first()).not.toBeNull();
        expect(await database.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='operations_portal_native_delivery_live_heads'").first()).not.toBeNull();
        expect(await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='operations_portal_native_content_start_events'").first()).not.toBeNull();
      }
    }
  } finally { await runtime.dispose(); }
}, 300_000);
