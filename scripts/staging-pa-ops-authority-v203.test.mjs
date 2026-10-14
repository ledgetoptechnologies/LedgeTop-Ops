import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { applyPaOpsAuthority203, compilePaOpsAuthority203, prepareAuthority203, runReviewedApply, STAFF } from "./staging-pa-ops-authority-v203.mjs";
import { STAGING_TARGET } from "./staging-directory-authority-v203.mjs";
import { PINNED_BUSINESS_AREA, PINNED_OPERATOR } from "./staging-project-authority-v203.mjs";
import { PROFILE, INITIAL_READ_SCOPES, STAGING_ORIGINS } from "./staging-ops-two-source-connection-profile-v1.mjs";

const root = path.resolve(import.meta.dirname, "..");
const requireOperations = createRequire(path.join(root, "apps/operations/package.json"));
const { Miniflare } = requireOperations("miniflare");
const { unstable_splitSqlQuery } = requireOperations("wrangler");
const id = n => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const all = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();
function sources() {
  return { profile: PROFILE, version: 1, sources: Object.fromEntries(Object.entries(STAGING_ORIGINS).map(([stage, baseUrl], index) => [stage, {
    sourceId: index ? "project-alpha:source-2-staging" : "project-alpha:staging", enabled: true, baseUrl,
    sourceInstanceId: id(index * 3 + 1), applicationId: id(index * 3 + 2), historyEpoch: id(index * 3 + 3), scopes: [...INITIAL_READ_SCOPES],
  }])) };
}
async function state(db) {
  return Object.fromEntries(await Promise.all(["native_directory_grants", "native_directory_grant_history", "native_directory_grant_generations",
    "native_project_grants", "native_project_grant_generations", "native_staff_bootstrap_approvals", "native_staff_bootstrap_receipts"]
    .map(async table => [table, await all(db, `SELECT * FROM ${table} ORDER BY 1,2`)])));
}

test("current203 paired authority is atomic, source-bound, reversible and preserves every original deny", { timeout: 300_000 }, async t => {
  const runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
    script: "export default {fetch(){return new Response('local203-authority')}}", d1Databases: ["DB"] });
  try {
    const db = await runtime.getD1Database("DB");
    const directory = path.join(root, "apps/operations/migrations");
    const names = fs.readdirSync(directory).filter(name => name.endsWith(".sql")).sort();
    assert.equal(names.length, 203);
    await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
    for (const name of names) {
      const sql = fs.readFileSync(path.join(directory, name), "utf8").replace(/\r\n/g, "\n");
      const statements = unstable_splitSqlQuery(sql).map(value => value.trim()).filter(value => value && !/^PRAGMA\s+foreign_keys\s*=\s*ON/i.test(value));
      await db.batch([...statements.map(value => db.prepare(value)), db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
    }
    await db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
      .bind(STAFF, PINNED_OPERATOR.accessSubject, STAFF).run();
    await db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
      .bind(STAFF, PINNED_OPERATOR.email, PINNED_OPERATOR.displayName).run();
    await db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,?,1)")
      .bind(PINNED_BUSINESS_AREA.id, PINNED_BUSINESS_AREA.name).run();
    for (const [grantId, permission, effect, active] of [["original-view", "directory.profile.view", "allow", 1],
      ["original-directory-deny", "directory.profile.edit", "deny", 0]]) {
      await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES(?,?,?,?,'global',?,?)")
        .bind(grantId, STAFF, permission, effect, active, STAFF).run();
    }
    await db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,business_area_id,active,granted_by) VALUES(?,?,'directory.profile.edit','allow','business_area',?,0,?)")
      .bind(id(90), STAFF, PINNED_BUSINESS_AREA.id, STAFF).run();
    await db.prepare("INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,granted_by) VALUES('original-project-deny',?,'project.shared.sync','deny','global',0,?)")
      .bind(STAFF, STAFF).run();
    await db.prepare("INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,business_area_id,active,granted_by) VALUES(?,?,'project.shared.sync','allow','business_area',?,0,?)")
      .bind(id(91), STAFF, PINNED_BUSINESS_AREA.id, STAFF).run();

    await t.test("late project authority drift rolls back directory grants, history and approvals", async () => {
      const packet = await prepareAuthority203(db, sources());
      await db.prepare("UPDATE native_project_grants SET active=1,version=version+1 WHERE id='original-project-deny'").run();
      const before = await state(db);
      await assert.rejects(applyPaOpsAuthority203(db, packet, "provision", { target: STAGING_TARGET }));
      assert.deepEqual(await state(db), before);
      await assert.rejects(prepareAuthority203(db, sources()), /applicable project deny/);
      await db.prepare("UPDATE native_project_grants SET active=0,version=version+1 WHERE id='original-project-deny'").run();
    });

    let packet;
    const originalDirectory = await all(db, "SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id", STAFF);
    const originalProjects = await all(db, "SELECT * FROM native_project_grants WHERE staff_id=? ORDER BY id", STAFF);
    await t.test("provision enables exactly four scoped allows using reviewed inactive identities and replay creates nothing", async () => {
      packet = await prepareAuthority203(db, sources());
      assert.equal(packet.input.directory.approval.grantIds[0], id(90));
      assert.equal(packet.input.project.approval.grantId, id(91));
      assert.equal(packet.directory.input.schemaVersion, 3);
      assert.equal(JSON.parse(packet.directory.approval.independent_binding_verification_json).migrations.count, 203);
      const result = await applyPaOpsAuthority203(db, packet, "provision", { target: STAGING_TARGET });
      assert.equal(result.status, "applied");
      assert.equal((await all(db, "SELECT * FROM native_directory_grants WHERE staff_id=? AND active=1 AND scope_kind='business_area'", STAFF)).length, 3);
      assert.equal((await all(db, "SELECT * FROM native_project_grants WHERE staff_id=? AND active=1 AND scope_kind='business_area'", STAFF)).length, 1);
      const before = await state(db);
      assert.equal((await applyPaOpsAuthority203(db, packet, "provision", { target: STAGING_TARGET })).status, "replayed");
      assert.deepEqual(await state(db), before);
    });

    await t.test("revoke disables only the fresh four IDs and preserves original inactive denies", async () => {
      const revoke = await prepareAuthority203(db, sources(), packet);
      await db.prepare(`CREATE TRIGGER reject_test_project_cleanup BEFORE UPDATE ON native_project_grants
        WHEN OLD.id='${id(91)}' AND NEW.active=0 BEGIN SELECT RAISE(ABORT,'late cleanup rollback'); END`).run();
      const failedClosePrestate = await state(db);
      await assert.rejects(applyPaOpsAuthority203(db, revoke, "revoke", { target: STAGING_TARGET }));
      assert.deepEqual(await state(db), failedClosePrestate, "late project cleanup failure rolls back directory cleanup and audit rows");
      await db.prepare("DROP TRIGGER reject_test_project_cleanup").run();
      assert.equal((await applyPaOpsAuthority203(db, revoke, "revoke", { target: STAGING_TARGET })).status, "applied");
      const directoryRows = await all(db, "SELECT * FROM native_directory_grants WHERE staff_id=? ORDER BY id", STAFF);
      const projectRows = await all(db, "SELECT * FROM native_project_grants WHERE staff_id=? ORDER BY id", STAFF);
      assert.deepEqual(directoryRows.filter(row => originalDirectory.some(original => original.id === row.id)), originalDirectory);
      assert.deepEqual(projectRows.filter(row => originalProjects.some(original => original.id === row.id)),
        originalProjects.map(row => row.id === id(91) ? { ...row, version: row.version + 2 } : row));
      for (const grantId of packet.input.directory.approval.grantIds)
        assert.equal((await first(db, "SELECT active FROM native_directory_grants WHERE id=?", grantId)).active, 0);
      assert.equal((await first(db, "SELECT active FROM native_project_grants WHERE id=?", packet.input.project.approval.grantId)).active, 0);
      const before = await state(db);
      assert.equal((await applyPaOpsAuthority203(db, revoke, "revoke", { target: STAGING_TARGET })).status, "replayed");
      assert.equal((await applyPaOpsAuthority203(db, packet, "provision", { target: STAGING_TARGET })).status, "replayed");
      assert.deepEqual(await state(db), before);
      assert.deepEqual(await all(db, "PRAGMA foreign_key_check"), []);
    });

    await t.test("wrong target, drifted packet and disabled source cannot mutate", async () => {
      await assert.rejects(applyPaOpsAuthority203(db, packet, "provision", { target: { ...STAGING_TARGET, environment: "production" } }));
      const altered = structuredClone(packet); altered.directory.statements.pop();
      await assert.rejects(applyPaOpsAuthority203(db, altered, "provision", { target: STAGING_TARGET }));
      const badSource = structuredClone(packet.input); badSource.directory.sourceMetadata.sources.stageTwo.enabled = false;
      assert.throws(() => compilePaOpsAuthority203(badSource));
      const wrongArea = structuredClone(packet.input); wrongArea.directory.businessArea.id = "drone-services-staging";
      assert.throws(() => compilePaOpsAuthority203(wrongArea));
      const mismatchedPrincipal = structuredClone(packet.input); mismatchedPrincipal.directory.admission.bound_access_subject = "another-principal";
      assert.throws(() => compilePaOpsAuthority203(mismatchedPrincipal));
      await assert.rejects(runReviewedApply(["apply"]));
      let submitted = false;
      const partialReceiptDb = { prepare() { return { bind(commandId) { return {
        async first() { return commandId === packet.directory.receipt.command_id ? packet.directory.receipt : null; },
      }; } }; }, async batch() { submitted = true; } };
      await assert.rejects(applyPaOpsAuthority203(partialReceiptDb, packet, "provision", { target: STAGING_TARGET }));
      assert.equal(submitted, false, "partial lineage never resubmits an unreviewed half-window");
    });

    await t.test("expired approval cannot open a new window", async () => {
      const fresh = await prepareAuthority203(db, sources());
      const input = structuredClone(fresh.input), now = Date.now();
      for (const approval of [input.directory.approval, input.project.approval]) {
        approval.issuedAt = new Date(now - 7200_000).toISOString();
        approval.expiresAt = new Date(now - 3600_000).toISOString();
      }
      input.directory.approval.executedAt = new Date(now - 5400_000).toISOString();
      input.project.approval.provisionExecutedAt = input.directory.approval.executedAt;
      input.project.approval.revokeExecutedAt = input.directory.approval.executedAt;
      const expired = compilePaOpsAuthority203(input), before = await state(db);
      await assert.rejects(applyPaOpsAuthority203(db, expired, "provision", { target: STAGING_TARGET }));
      assert.deepEqual(await state(db), before);
    });
  } finally { await runtime.dispose(); }
});
