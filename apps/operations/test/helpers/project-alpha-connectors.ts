import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { splitD1MigrationStatements } from "../../../client/test/helpers/d1-migrations";

/** Real registry schema, including ownership/revision triggers and deferred FKs. */
export async function applyConnectorSchema(db: D1Database) {
  const migration = readFileSync(new URL("../../migrations/0035_project_alpha_connectors.sql", import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(migration).map(sql => db.prepare(sql)));
}

export async function registerVisibleTestSource(db: D1Database, sourceId: string, displayName = "Secondary business") {
  const exists = await db.prepare("SELECT source_id FROM pa_connectors WHERE source_id=?").bind(sourceId).first();
  if (!exists) {
    const key = createHash("sha256").update(sourceId).digest("hex"), primary = sourceId === "project-alpha:primary";
    await db.batch([
      db.prepare(`INSERT INTO pa_connector_signing_keys(fingerprint,source_id,algorithm) VALUES(?,?,'ed25519')`).bind(key, sourceId),
      db.prepare(`INSERT INTO pa_connectors(source_id,producer_binding_id,snapshot_origin,application_key,snapshot_base_path,
        profile,display_name,read_visible,created_by) VALUES(?,?,?,'ltds','/api/exports',?,?,?,'fixture')`)
        .bind(sourceId, key.slice(0, 20), `https://${key.slice(0, 20)}.example.test`, primary ? "primary_legacy" : "business_data", displayName, primary ? 1 : 0),
      db.prepare(`INSERT INTO pa_connector_revisions(source_id,revision,credential_ref,snapshot_base_path,access_issuer,
        access_audience,access_subject,current_key_id,current_key_fingerprint,created_by)
        VALUES(?,1,'TEST','/api/exports','https://access.example.test','test-audience','test-subject','key-1',?,'fixture')`).bind(sourceId, key),
    ]);
  }
  await db.prepare("UPDATE pa_connectors SET read_visible=1,display_name=?,version=version+1 WHERE source_id=?").bind(displayName, sourceId).run();
}
