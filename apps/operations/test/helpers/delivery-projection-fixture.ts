import { Miniflare } from "miniflare";

// Small real-D1 consumer fixture. The full populated migration gate lives in
// Client's delivery-source-migration.test.ts; this isolates projection behavior.
export async function deliveryProjectionFixture() {
  const runtime = new Miniflare({ modules: true,
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["DELIVERY_DB"] });
  const db = await runtime.getD1Database("DELIVERY_DB") as D1Database;
  const schema = [
    `CREATE TABLE client_accounts(id TEXT PRIMARY KEY,display_name TEXT,status TEXT NOT NULL,
      project_alpha_client_id TEXT,project_alpha_organization_id TEXT,project_alpha_source_id TEXT,updated_at TEXT)`,
    `CREATE TABLE projects(id TEXT PRIMARY KEY,project_alpha_project_id TEXT,project_alpha_source_id TEXT,
      client_name TEXT,project_name TEXT,status TEXT,summary TEXT,site_address TEXT,service_address TEXT,
      project_contact_name TEXT,project_contact_email TEXT,project_contact_phone TEXT,next_milestone TEXT,
      source_updated_at TEXT,active INTEGER NOT NULL DEFAULT 1,updated_at TEXT)`,
    `CREATE TABLE client_project_grants(account_id TEXT,project_id TEXT,can_request_service INTEGER NOT NULL DEFAULT 0,
      revoked_at TEXT,PRIMARY KEY(account_id,project_id))`,
    `CREATE TABLE client_folder_associations(id TEXT PRIMARY KEY,scope_type TEXT,account_id TEXT,project_id TEXT,revoked_at TEXT)`,
    `CREATE TABLE client_delivery_grants(account_id TEXT,project_id TEXT,revoked_at TEXT,PRIMARY KEY(account_id,project_id))`,
    `CREATE TABLE client_member_project_grants(account_id TEXT,project_id TEXT,revoked_at TEXT,PRIMARY KEY(account_id,project_id))`,
  ];
  await db.batch(schema.map(sql => db.prepare(sql)));
  for (const [key, source] of [["a", "project-alpha:primary"], ["b", "project-alpha:secondary"]]) {
    await db.batch([
      db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_client_id,project_alpha_source_id)
        VALUES(?,'Client before','active','70',?)`).bind(`${key}-client`, source),
      db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_organization_id,project_alpha_source_id)
        VALUES(?,'Organization before','active','80',?)`).bind(`${key}-org`, source),
      ...["50", "51", "99"].map(id => db.prepare(`INSERT INTO projects(id,project_alpha_project_id,project_alpha_source_id,client_name,project_name,status,active)
        VALUES(?,?,?,'Client before','Project before','active',?)`).bind(`${key}-${id}`, id, source, id === "51" ? 0 : 1)),
      db.prepare("INSERT INTO client_project_grants(account_id,project_id,can_request_service) VALUES(?,?,1)").bind(`${key}-client`, `${key}-50`),
      db.prepare("INSERT INTO client_folder_associations(id,scope_type,account_id,project_id) VALUES(?,'project',?,?)").bind(`${key}-folder`, `${key}-client`, `${key}-50`),
      db.prepare("INSERT INTO client_folder_associations(id,scope_type,account_id,project_id) VALUES(?,'project',?,?)").bind(`${key}-inactive-folder`, `${key}-client`, `${key}-51`),
      db.prepare("INSERT INTO client_folder_associations(id,scope_type,account_id) VALUES(?,'client',?)").bind(`${key}-client-folder`, `${key}-client`),
      db.prepare("INSERT INTO client_delivery_grants(account_id,project_id) VALUES(?,?)").bind(`${key}-client`, `${key}-50`),
      db.prepare("INSERT INTO client_member_project_grants(account_id,project_id) VALUES(?,?)").bind(`${key}-client`, `${key}-50`),
    ]);
  }
  // Local provenance stays NULL. Existing primary account grants may still
  // label local projects; cleanup must keep suspended local client folders
  // closed without sweeping active local records as missing Alpha entities.
  await db.batch([
    db.prepare(`INSERT INTO client_accounts(id,display_name,status,project_alpha_source_id)
      VALUES('local-active-client','Local active','active',NULL),
        ('local-suspended-client','Local suspended','suspended',NULL)`),
    db.prepare(`INSERT INTO projects(id,project_alpha_project_id,project_alpha_source_id,client_name,project_name,status,active)
      VALUES('local-client-project',NULL,NULL,'Local client before','Local client project','active',1),
        ('local-org-project',NULL,NULL,'Local organization before','Local organization project','active',1)`),
    db.prepare(`INSERT INTO client_project_grants(account_id,project_id)
      VALUES('a-client','local-client-project'),('a-org','local-org-project')`),
    db.prepare(`INSERT INTO client_folder_associations(id,scope_type,account_id)
      VALUES('local-active-folder','client','local-active-client'),
        ('local-suspended-folder','client','local-suspended-client')`),
  ]);
  return { runtime, db };
}

export async function secondaryDeliverySnapshot(db: D1Database) {
  const queries = [
    "SELECT * FROM client_accounts WHERE project_alpha_source_id='project-alpha:secondary' ORDER BY id",
    "SELECT * FROM projects WHERE project_alpha_source_id='project-alpha:secondary' ORDER BY id",
    ...["client_project_grants", "client_folder_associations", "client_delivery_grants", "client_member_project_grants"]
      .map(table => `SELECT * FROM ${table} WHERE account_id IN (SELECT id FROM client_accounts WHERE project_alpha_source_id='project-alpha:secondary') ORDER BY project_id`),
  ];
  const rows = [];
  for (const sql of queries) rows.push((await db.prepare(sql).all()).results);
  return rows;
}
