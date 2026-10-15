import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { reviewedOperationsMigrationNames } from "./helpers/reviewed-operations-migration-chain";
// Existing reviewed test artifact generator; no declarations are provided.
// @ts-expect-error test-only JavaScript artifact module
import { transformSeed } from "../../../scripts/staging-bootstrap.mjs";

const owner = { email: "delivery-schema-owner@staging.example.test", displayName: "Synthetic Staging Delivery Schema Owner",
  clientStaffId: "staging-delivery-schema-client-owner",
  operationsStaffId: "staging-delivery-schema-operations-owner" };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

it("0187 changes only the native delivery folder guard's prefix predicate", () => {
  const directory = new URL("../migrations/", import.meta.url);
  const original = readFileSync(new URL("0158_operations_portal_native_delivery_authority.sql", directory), "utf8");
  const forward = readFileSync(new URL("0187_operations_portal_native_delivery_literal_prefix_guard.sql", directory), "utf8");
  const trigger = (source: string) => source.match(/CREATE TRIGGER operations_portal_native_delivery_grant_folder_guard[\s\S]*?END;/u)?.[0];
  const before = trigger(original), after = trigger(forward);
  expect(before).toBeDefined(); expect(after).toBeDefined();
  expect(before).toContain("NEW.selected_r2_prefix LIKE");
  expect(after).toContain("substr(NEW.selected_r2_prefix,1,length(NEW.base_r2_prefix))=NEW.base_r2_prefix COLLATE BINARY");
  expect(after!.replace("substr(NEW.selected_r2_prefix,1,length(NEW.base_r2_prefix))=NEW.base_r2_prefix COLLATE BINARY",
    "NEW.selected_r2_prefix LIKE replace(replace(replace(NEW.base_r2_prefix,'\\','\\\\'),'%','\\%'),'_','\\_') || '%' ESCAPE '\\'"))
    .toBe(before);
  expect((forward.match(/DROP TRIGGER /gu) ?? [])).toHaveLength(1);
  expect((forward.match(/CREATE TRIGGER /gu) ?? [])).toHaveLength(1);
});

it("applies the exact Ops native delivery authority draft after its reviewed prerequisites", async () => {
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: crypto.randomUUID() } });
  try {
    const directory = new URL("../migrations/", import.meta.url);
    const drafts = ["0154_operations_portal_native_recipient_authority.sql",
      "0156_operations_portal_workspace_publication_invocations.sql",
      "0157_operations_portal_native_workspace_cleanup.sql",
      "0158_operations_portal_native_delivery_authority.sql",
      "0159_operations_portal_native_delivery_recovery_invocations.sql"];
    const reviewed = reviewedOperationsMigrationNames(directory);
    // The reviewed inventory now contains this pending suffix; its helper
    // validates the exact source hashes. Reconstruct the pre-draft baseline
    // so these explicit draft migrations are applied once, not twice.
    const base = reviewed.filter(name => !drafts.includes(name));
    expect(drafts.every(name => !base.includes(name))).toBe(true);
    const names = [...base, ...drafts].sort(), migration = drafts.at(-1)!;
    const sourceHash = hash(readFileSync(new URL(migration, directory), "utf8"));
    const database = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await database.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
    for (const name of names) {
      const raw = readFileSync(new URL(name, directory), "utf8");
      const source = name === "0002_seed_acl.sql" ? transformSeed("operations", raw.replace(/\r\n/g, "\n"), owner) as string : raw;
      await database.batch([...splitD1MigrationStatements(source).map(statement => database.prepare(statement)),
        database.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
    }
    expect(hash(readFileSync(new URL(migration, directory), "utf8"))).toBe(sourceHash);
    expect((await database.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    for (const table of ["operations_portal_native_delivery_authority_commands",
      "operations_portal_native_delivery_authorizations", "operations_portal_native_delivery_authority_heads",
      "operations_portal_native_delivery_authority_outbox", "operations_portal_native_delivery_authority_receipts"]) {
      expect(await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .bind(table).first()).not.toBeNull();
    }
    for (const table of ["operations_portal_native_delivery_recovery_invocations",
      "operations_portal_native_delivery_recovery_invocation_audit"]) {
      expect(await database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .bind(table).first()).not.toBeNull();
    }
    expect(await database.prepare(`SELECT name FROM sqlite_master WHERE type='trigger'
      AND name='operations_portal_native_delivery_receipt_guard'`).first()).not.toBeNull();
  } finally { await runtime.dispose(); }
}, 300_000);
