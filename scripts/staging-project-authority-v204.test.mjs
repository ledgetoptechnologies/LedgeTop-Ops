import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { compileBusinessAreaAuthorityPair204, applyBusinessAreaAuthorityPhase204,
  PURPOSE, PINNED_OPERATOR, PINNED_BUSINESS_AREA } from "./staging-project-authority-v204.mjs";
import { compileBusinessAreaAuthorityPair as compile203,
  applyBusinessAreaAuthorityPhase as apply203, PURPOSE as PURPOSE203 } from "./staging-project-authority-v203.mjs";
import { STAGING_TARGET } from "./staging-directory-authority-v203.mjs";
import { PROFILE, INITIAL_READ_SCOPES, STAGING_ORIGINS } from "./staging-ops-two-source-connection-profile-v1.mjs";

const root = path.resolve(import.meta.dirname, "..");
const requireOperations = createRequire(path.join(root, "apps/operations/package.json"));
const { Miniflare } = requireOperations("miniflare");
const { unstable_splitSqlQuery } = requireOperations("wrangler");
const all = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();
const uuid = n => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const sources = { profile: PROFILE, version: 1, sources: Object.fromEntries(
  Object.entries(STAGING_ORIGINS).map(([stage, baseUrl], index) => [stage, {
    sourceId: index ? "project-alpha:source-2-staging" : "project-alpha:staging", enabled: true, baseUrl,
    sourceInstanceId: uuid(index * 3 + 1), applicationId: uuid(index * 3 + 2), historyEpoch: uuid(index * 3 + 3),
    scopes: [...INITIAL_READ_SCOPES],
  }])) };
const projectGrantId = uuid(91);
const tables = ["native_project_grants", "native_project_grant_generations",
  "native_staff_bootstrap_approvals", "native_staff_bootstrap_receipts", "native_directory_grants",
  "native_directory_grant_history", "native_directory_grant_generations"];
const state = async db => Object.fromEntries(await Promise.all(tables.map(async table =>
  [table, await all(db, `SELECT * FROM ${table} ORDER BY 1,2`)])));

async function input(db) {
  const staff = PINNED_OPERATOR.staffId, now = new Date().toISOString();
  const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]));
  return { schemaVersion: 1, purpose: PURPOSE, staging: STAGING_TARGET,
    admission: pick(await first(db, "SELECT * FROM native_staff_admissions WHERE staff_id=?", staff),
      ["staff_id", "bound_access_subject", "active", "version"]),
    profile: pick(await first(db, "SELECT * FROM native_staff_profiles WHERE staff_id=?", staff),
      ["staff_id", "login_email", "display_name", "version"]),
    businessArea: await first(db, "SELECT * FROM native_business_areas WHERE id=?", PINNED_BUSINESS_AREA.id),
    generation: await first(db, "SELECT staff_id,generation FROM native_project_grant_generations WHERE staff_id=?", staff),
    grants: await all(db, "SELECT * FROM native_project_grants WHERE staff_id=? ORDER BY id", staff),
    sourceMetadata: sources,
    approval: { approvalId: crypto.randomUUID(), commandId: crypto.randomUUID(),
      revokeApprovalId: crypto.randomUUID(), revokeCommandId: crypto.randomUUID(), grantId: projectGrantId,
      issuedAt: new Date(Date.parse(now) - 1_000).toISOString(), expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
      provisionExecutedAt: now, revokeExecutedAt: now, changeTicket: "synthetic-project-current204-test", reviewer: staff },
  };
}

test("current204 project-only authority is exact, atomic and reverses only its scoped grant", { timeout: 300_000 }, async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pa-project-authority-204-"));
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {}", d1Databases: ["DB"] });
  try {
    const db = await runtime.getD1Database("DB"), staff = PINNED_OPERATOR.staffId;
    // The immutable204 compiler intentionally rejects later physical source chains.
    const reviewedRoot = path.join(temporary, "reviewed204");
    const directory = path.join(reviewedRoot, "apps/operations/migrations");
    fs.mkdirSync(directory, { recursive: true });
    const sourceDirectory = path.join(root, "apps/operations/migrations");
    for (const name of fs.readdirSync(sourceDirectory))
      if (/^\d{4}_.+\.sql$/.test(name) && Number(name.slice(0, 4)) <= 204)
        fs.copyFileSync(path.join(sourceDirectory, name), path.join(directory, name));
    const names = fs.readdirSync(directory).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    assert.equal(names.length, 204);
    await db.prepare("CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE)").run();
    for (const name of names) {
      const statements = unstable_splitSqlQuery(fs.readFileSync(path.join(directory, name), "utf8").replace(/\r\n/g, "\n"))
        .map(sql => sql.trim()).filter(sql => sql && !/^PRAGMA\s+foreign_keys\s*=\s*ON/i.test(sql));
      await db.batch([...statements.map(sql => db.prepare(sql)), db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name)]);
    }
    await db.batch([
      db.prepare("INSERT INTO native_staff_admissions(staff_id,bound_access_subject,active,admitted_by) VALUES(?,?,1,?)")
        .bind(staff, PINNED_OPERATOR.accessSubject, staff),
      db.prepare("INSERT INTO native_staff_profiles(staff_id,login_email,display_name) VALUES(?,?,?)")
        .bind(staff, PINNED_OPERATOR.email, PINNED_OPERATOR.displayName),
      db.prepare("INSERT INTO native_business_areas(id,name,active) VALUES(?,?,1)")
        .bind(PINNED_BUSINESS_AREA.id, PINNED_BUSINESS_AREA.name),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES('retained-directory-view',?,'directory.profile.view','allow','global',1,?)")
        .bind(staff, staff),
      db.prepare("INSERT INTO native_directory_grants(id,staff_id,permission,effect,scope_kind,active,granted_by) VALUES('retained-directory-deny',?,'directory.profile.edit','deny','global',0,?)")
        .bind(staff, staff),
      db.prepare("INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,active,version,granted_by) VALUES('retained-deny',?,'project.shared.sync','deny','global',0,1,?)")
        .bind(staff, staff),
      db.prepare("INSERT INTO native_project_grants(id,staff_id,capability,effect,scope_kind,business_area_id,active,version,granted_by) VALUES(?,?,'project.shared.sync','allow','business_area',?,0,1,?)")
        .bind(projectGrantId, staff, PINNED_BUSINESS_AREA.id, staff),
    ]);
    await db.batch([1, 0, 0].map(active => db.prepare(
      "UPDATE native_project_grants SET active=?,version=version+1 WHERE id=?").bind(active, projectGrantId)));
    const candidateInput = await input(db), packet = compileBusinessAreaAuthorityPair204(candidateInput, { root: reviewedRoot });
    const baseline = await state(db);
    assert.equal(baseline.native_directory_grants.length, 2);
    assert.ok(baseline.native_directory_grant_history.length >= 2);
    const sourceFixture = () => {
      const base = fs.mkdtempSync(path.join(temporary, "source-"));
      fs.mkdirSync(path.join(base, "apps/operations/migrations"), { recursive: true });
      fs.cpSync(directory, path.join(base, "apps/operations/migrations"), { recursive: true });
      return base;
    };
    await t.test("203 compiler remains positive only for archived203 source and refuses current204 ledger", async () => {
      const oldRoot = sourceFixture();
      fs.unlinkSync(path.join(oldRoot, "apps/operations/migrations", names.at(-1)));
      const oldInput = { ...candidateInput, purpose: PURPOSE203 };
      const oldPacket = compile203(oldInput, { root: oldRoot });
      assert.throws(() => compile203(oldInput), /exact reviewed migration chain/);
      await assert.rejects(apply203(db, oldPacket, "provision", { root: oldRoot, target: STAGING_TARGET }));
      assert.deepEqual(await state(db), baseline);
      assert.throws(() => compileBusinessAreaAuthorityPair204(candidateInput, { root: oldRoot }), /exact reviewed migration chain/);
    });
    await t.test("rejects mutated204, mixed prefixes, unknown205 and a different staging database", async () => {
      for (const name of [names[0], names.at(-1)]) {
        const changed = sourceFixture();
        fs.appendFileSync(path.join(changed, "apps/operations/migrations", name), " ");
        assert.throws(() => compileBusinessAreaAuthorityPair204(candidateInput, { root: changed }), /exact reviewed migration chain/);
      }
      const newer = sourceFixture();
      fs.writeFileSync(path.join(newer, "apps/operations/migrations/0205_unknown.sql"), "SELECT 1;");
      assert.throws(() => compileBusinessAreaAuthorityPair204(candidateInput, { root: newer }), /exact reviewed migration chain/);
      const stray = sourceFixture();
      fs.writeFileSync(path.join(stray, "apps/operations/migrations/unreviewed.sql"), "SELECT 1;");
      assert.throws(() => compileBusinessAreaAuthorityPair204(candidateInput, { root: stray }), /canonical migration names/);
      await assert.rejects(applyBusinessAreaAuthorityPhase204(db, packet, "provision",
        { target: { ...STAGING_TARGET, databaseId: uuid(88) } }), /trusted staging binding/);
      assert.throws(() => compileBusinessAreaAuthorityPair204({ ...candidateInput,
        generation: { ...candidateInput.generation, generation: Number.MAX_SAFE_INTEGER } }), /versions/);
      assert.throws(() => compileBusinessAreaAuthorityPair204({ ...candidateInput,
        grants: candidateInput.grants.map(row => row.id === projectGrantId
          ? { ...row, version: Number.MAX_SAFE_INTEGER } : row) }), /exact inactive project area grant/);
    });
    await t.test("full ledger membership rejects a renamed middle entry with unchanged count and maximum", async () => {
      await db.prepare("UPDATE d1_migrations SET name='0001_unknown.sql' WHERE name=?").bind(names[0]).run();
      await assert.rejects(applyBusinessAreaAuthorityPhase204(db, packet, "provision", { root: reviewedRoot, target: STAGING_TARGET }));
      assert.deepEqual(await state(db), baseline);
      await db.prepare("UPDATE d1_migrations SET name=? WHERE name='0001_unknown.sql'").bind(names[0]).run();
    });
    await t.test("a late grant failure rolls back approval creation and every audit mutation", async () => {
      await db.prepare(`CREATE TRIGGER fail_project_authority_test BEFORE UPDATE ON native_project_grants
        WHEN NEW.id='${projectGrantId}' BEGIN SELECT RAISE(ABORT,'test late grant failure'); END`).run();
      await assert.rejects(applyBusinessAreaAuthorityPhase204(db, packet, "provision", { root: reviewedRoot, target: STAGING_TARGET }));
      assert.deepEqual(await state(db), baseline);
      await db.prepare("DROP TRIGGER fail_project_authority_test").run();
    });
    await t.test("reactivates one exact inactive ID then closes it monotonically without touching directory grants or denies", async () => {
      assert.deepEqual(await applyBusinessAreaAuthorityPhase204(db, packet, "provision", { root: reviewedRoot, target: STAGING_TARGET }),
        { replayed: false, phase: "provision" });
      assert.equal((await first(db, "SELECT version FROM native_project_grants WHERE id=?", projectGrantId)).version, 5);
      const active = await state(db);
      assert.deepEqual(await applyBusinessAreaAuthorityPhase204(db, packet, "provision", { root: reviewedRoot, target: STAGING_TARGET }),
        { replayed: true, phase: "provision" });
      assert.deepEqual(await state(db), active);
      await db.prepare(`CREATE TRIGGER fail_project_revoke_test BEFORE UPDATE ON native_project_grants
        WHEN NEW.id='${projectGrantId}' AND NEW.active=0 BEGIN SELECT RAISE(ABORT,'test late cleanup failure'); END`).run();
      await assert.rejects(applyBusinessAreaAuthorityPhase204(db, packet, "revoke", { root: reviewedRoot, target: STAGING_TARGET }));
      assert.deepEqual(await state(db), active, "failed cleanup preserves the active grant and complete original audit lineage");
      await db.prepare("DROP TRIGGER fail_project_revoke_test").run();
      await applyBusinessAreaAuthorityPhase204(db, packet, "revoke", { root: reviewedRoot, target: STAGING_TARGET });
      const closed = await state(db);
      assert.deepEqual(closed.native_project_grants.find(row => row.id === projectGrantId),
        { ...baseline.native_project_grants.find(row => row.id === projectGrantId), version: 6 });
      assert.deepEqual(closed.native_project_grants.find(row => row.id === "retained-deny"),
        baseline.native_project_grants.find(row => row.id === "retained-deny"));
      for (const table of tables.filter(name => name.startsWith("native_directory_")))
        assert.deepEqual(closed[table], baseline[table]);
      assert.equal(closed.native_project_grant_generations[0].generation,
        baseline.native_project_grant_generations[0].generation + 2);
      await applyBusinessAreaAuthorityPhase204(db, packet, "revoke", { root: reviewedRoot, target: STAGING_TARGET });
      await applyBusinessAreaAuthorityPhase204(db, packet, "provision", { root: reviewedRoot, target: STAGING_TARGET });
      assert.deepEqual(await state(db), closed, "receipt replay must never reopen a revoked grant");
      assert.equal((await compileBusinessAreaAuthorityPair204(await input(db))).input.approval.grantId, projectGrantId);
      assert.deepEqual((await db.prepare("PRAGMA foreign_key_check").all()).results, []);
    });
  } finally {
    await runtime.dispose();
    assert.ok(temporary.startsWith(`${os.tmpdir()}${path.sep}`));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
