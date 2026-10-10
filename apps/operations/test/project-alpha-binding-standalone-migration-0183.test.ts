import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const source = "project-alpha:primary", instance = "11111111-1111-4111-8111-111111111111";
const application = "22222222-2222-4222-8222-222222222222", epoch = "33333333-3333-4333-8333-333333333333";
let runtime: Miniflare, db: D1Database;
let relationshipHistoryBefore: Record<string, unknown>[], unrelatedTriggersBefore: Record<string, unknown>[];

async function apply(name: string) {
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}
async function review(id: string, record: string, type: "client" | "organization", external = `pa-${record}`,
  publicId = crypto.randomUUID().replaceAll("-", ""), sourceId = source) {
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence
    (receipt_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
    VALUES(?,?,?,?,?,?,?,?,?)`).bind(id, record, sourceId, instance, application, epoch, type, external, publicId).run();
  return { id, record, type, external, publicId, sourceId };
}
async function activate(item: Awaited<ReturnType<typeof review>>, activation = `activation-${item.id}`) {
  return db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts
    (activation_id,review_receipt_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(activation, item.id, item.record, item.sourceId, instance, application, epoch,
      item.type, item.external, item.publicId).run();
}
async function seedParentMapping(record: string, sourceId = source, activation = `parent-${record}`) {
  await db.prepare("INSERT OR IGNORE INTO operations_directory_records VALUES(?,'organization')").bind(record).run();
  await db.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts
    (activation_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id)
    VALUES(?,?,?,?,?,?,'organization',?,?)`).bind(activation, record, sourceId, instance, application, epoch,
      `pa-${record}-${activation}`, crypto.randomUUID().replaceAll("-", "")).run();
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06", script: "export default {}",
    d1Databases: { OPS_DB: crypto.randomUUID() } });
  db = await runtime.getD1Database("OPS_DB") as D1Database;
  const fixtureSchema = `
    CREATE TABLE operations_directory_records(record_id TEXT PRIMARY KEY,record_kind TEXT NOT NULL);
    CREATE TABLE operations_directory_client_organizations(client_record_id TEXT PRIMARY KEY,organization_record_id TEXT,relationship_version INTEGER NOT NULL);
    CREATE TABLE operations_directory_client_organization_history(client_record_id TEXT,relationship_version INTEGER,organization_record_id TEXT,
      PRIMARY KEY(client_record_id,relationship_version));
    CREATE TABLE project_alpha_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_existing_directory_binding_review_evidence(receipt_id TEXT PRIMARY KEY,record_id TEXT,source_id TEXT,
      source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_existing_directory_binding_activation_receipts(activation_id TEXT PRIMARY KEY,review_receipt_id TEXT,record_id TEXT,
      source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TRIGGER project_alpha_existing_directory_binding_activation_relationship BEFORE INSERT ON project_alpha_existing_directory_binding_activation_receipts
      BEGIN SELECT 1; END;
    CREATE TRIGGER project_alpha_existing_directory_binding_activation_no_update BEFORE UPDATE ON project_alpha_existing_directory_binding_activation_receipts
      BEGIN SELECT RAISE(ABORT,'immutable'); END;
    CREATE TRIGGER project_alpha_existing_directory_binding_activation_no_delete BEFORE DELETE ON project_alpha_existing_directory_binding_activation_receipts
      BEGIN SELECT RAISE(ABORT,'immutable'); END;
  `;
  await db.batch(splitD1MigrationStatements(fixtureSchema).map(statement => db.prepare(statement)));
  await apply("0129_project_alpha_existing_directory_binding_activation_relationship.sql");
  await db.batch([
    db.prepare("INSERT INTO operations_directory_records VALUES('history-client','client')"),
    db.prepare("INSERT INTO operations_directory_client_organizations VALUES('history-client',NULL,2)"),
    db.prepare("INSERT INTO operations_directory_client_organization_history VALUES('history-client',1,'old-parent')"),
    db.prepare("INSERT INTO operations_directory_client_organization_history VALUES('history-client',2,NULL)"),
  ]);
  relationshipHistoryBefore = (await db.prepare(
    "SELECT * FROM operations_directory_client_organization_history ORDER BY relationship_version").all()).results;
  unrelatedTriggersBefore = (await db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
    AND name IN ('project_alpha_existing_directory_binding_activation_no_update',
      'project_alpha_existing_directory_binding_activation_no_delete') ORDER BY name`).all()).results;
  await apply("0183_project_alpha_binding_standalone_relationship_rows.sql");
}, 30_000);
afterAll(async () => runtime?.dispose());

describe("0183 standalone relationship-row binding fence", () => {
  it("replaces only the relationship trigger and preserves relationship data and keys", async () => {
    await apply("0183_project_alpha_binding_standalone_relationship_rows.sql");
    expect((await db.prepare("SELECT * FROM operations_directory_client_organization_history ORDER BY relationship_version").all()).results)
      .toEqual(relationshipHistoryBefore);
    expect((await db.prepare("PRAGMA table_info(operations_directory_client_organizations)").all<{ name: string; pk: number }>()).results
      .find(column => column.name === "client_record_id")?.pk).toBe(1);
    expect((await db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
      AND name IN ('project_alpha_existing_directory_binding_activation_no_update',
        'project_alpha_existing_directory_binding_activation_no_delete') ORDER BY name`).all()).results).toEqual(unrelatedTriggersBefore);
  });

  it("accepts canonical NULL and historical absent standalone relationships", async () => {
    for (const [stem, withNull] of [["null", true], ["absent", false]] as const) {
      const record = `${stem}-client`; await db.prepare("INSERT INTO operations_directory_records VALUES(?,'client')").bind(record).run();
      if (withNull) await db.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,NULL,1)").bind(record).run();
      await expect(activate(await review(`${stem}-review`, record, "client"))).resolves.toBeDefined();
    }
  });

  it.each(["unmapped", "wrong-source", "ambiguous"])("rejects a non-NULL %s parent", async mode => {
    const record = `${mode}-client`, parent = `${mode}-parent`;
    await db.batch([db.prepare("INSERT INTO operations_directory_records VALUES(?,'client')").bind(record),
      db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization')").bind(parent),
      db.prepare("INSERT INTO operations_directory_client_organizations VALUES(?,?,1)").bind(record, parent)]);
    if (mode === "wrong-source") await seedParentMapping(parent, "project-alpha:secondary");
    if (mode === "ambiguous") {
      await seedParentMapping(parent, source, `${parent}-one`);
      await seedParentMapping(parent, source, `${parent}-two`);
    }
    await expect(activate(await review(`${mode}-review`, record, "client"))).rejects.toThrow(/mapping or relationship/);
  });

  it("retains legacy identity collision rejection and leaves organizations unchanged", async () => {
    const collision = await review("collision-review", "collision-client", "client", "pa-collision", "c".repeat(32));
    await db.prepare("INSERT INTO operations_directory_records VALUES('collision-client','client')").run();
    await db.prepare(`INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?, 'client',?,?)`)
      .bind(source, instance, application, epoch, collision.external, collision.publicId).run();
    await expect(activate(collision)).rejects.toThrow(/mapping or relationship/);

    const organization = await review("organization-review", "organization-record", "organization");
    await db.prepare("INSERT INTO operations_directory_records VALUES('organization-record','organization')").run();
    await db.prepare("INSERT INTO operations_directory_client_organizations VALUES('organization-record','unmapped-parent',1)").run();
    await expect(activate(organization)).resolves.toBeDefined();
  });
});
