import crypto from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

let runtime: Miniflare | undefined;
afterEach(async () => { await runtime?.dispose(); runtime = undefined; });

const hash = (value: string | Buffer) => crypto.createHash("sha256").update(value).digest("hex");

it("upgrades the exact cloned live-173 lineage through the reviewed local suffix", async () => {
  const directory = new URL("../migrations/", import.meta.url);
  const names = readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
  const base = names.slice(0, 173);
  const suffix = names.slice(173);
  expect(base.at(-1)).toBe("0173_operations_directory_intent_acquired_destination_transition.sql");
  expect(hash(base.join("\n"))).toBe("46d20b48362be8052f5b2fd35ec4ccefee2c267476a2a076af87a955c4cfca3a");
  expect(hash(base.map(name => `${name}\0${hash(readFileSync(new URL(name, directory)))}`).join("\n")))
    .toBe("cd35de12e87325fb6de854f4ecba47e5172e115f75830af9f4a908710d10a450");
  expect(suffix).toEqual([
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

  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  const db = await runtime.getD1Database("OPS_DB") as D1Database;
  const apply = async (name: string) => {
    const sql = readFileSync(new URL(name, directory), "utf8");
    await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
  };
  for (const name of base) await apply(name);
  await db.prepare("CREATE TABLE lineage_upgrade_sentinel(id TEXT PRIMARY KEY,value TEXT NOT NULL)").run();
  await db.prepare("INSERT INTO lineage_upgrade_sentinel VALUES('pre-suffix','preserved')").run();
  await db.batch(splitD1MigrationStatements(`
    CREATE TABLE delivery_public_shares(
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      payload BLOB NOT NULL
    );
    CREATE TABLE delivery_records(
      id TEXT PRIMARY KEY,
      payload BLOB NOT NULL
    );
    INSERT INTO delivery_public_shares
      VALUES('share','https://public.example.test/s/keep',x'00010280ff');
    INSERT INTO delivery_records VALUES('delivery',x'ff0080417f');
  `).map(statement => db.prepare(statement)));
  const deliveryBefore = {
    publicShares: (await db.prepare(`SELECT id,url,hex(payload) payload_hex
      FROM delivery_public_shares ORDER BY id`).all()).results,
    deliveries: (await db.prepare(`SELECT id,hex(payload) payload_hex
      FROM delivery_records ORDER BY id`).all()).results,
  };

  for (const name of suffix) await apply(name);

  expect(await db.prepare("SELECT value FROM lineage_upgrade_sentinel WHERE id='pre-suffix'")
    .first<{ value: string }>()).toEqual({ value: "preserved" });
  expect({
    publicShares: (await db.prepare(`SELECT id,url,hex(payload) payload_hex
      FROM delivery_public_shares ORDER BY id`).all()).results,
    deliveries: (await db.prepare(`SELECT id,hex(payload) payload_hex
      FROM delivery_records ORDER BY id`).all()).results,
  }).toEqual(deliveryBefore);
  const finalizationColumns = await db.prepare("PRAGMA table_info(project_alpha_directory_read_adoption_finalizations)")
    .all<{ name: string }>();
  expect(finalizationColumns.results.map(column => column.name)).toEqual(expect.arrayContaining([
    "acquisition_external_id", "acquisition_identity_mode",
  ]));
  const guard = await db.prepare(`SELECT sql FROM sqlite_master
    WHERE type='trigger' AND name='operations_directory_intents_write_guard'`).first<{ sql: string }>();
  expect(guard?.sql).toContain("fence.operation_kind='update'");
  expect(guard?.sql).toContain("mapping.mapping_kind='acquired'");
  expect(await db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name='project_alpha_project_inbound_proposals'`).first())
    .toEqual({ name: "project_alpha_project_inbound_proposals" });
}, 180_000);
