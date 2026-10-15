import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createPrivateEvidenceDirectory } from "./staging-native-authority-packet-rehearsal.mjs";
import { STAGING_TARGET } from "./staging-directory-authority-v203.mjs";
import { PINNED_BUSINESS_AREA, PINNED_OPERATOR } from "./staging-project-authority-v203.mjs";
import { PROFILE, INITIAL_READ_SCOPES, STAGING_ORIGINS } from "./staging-ops-two-source-connection-profile-v1.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
// Historical positive tests use the unchanged compiler against its actual203
// source inventory. The new204 suite separately proves203 refuses newer source
// and ledger inventories; adding204 must not silently widen this old tool.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pa-authority-frozen203-"));
fs.cpSync(path.join(repositoryRoot, "scripts"), path.join(root, "scripts"), { recursive: true });
const historicalMigrations = path.join(root, "apps/operations/migrations");
fs.mkdirSync(historicalMigrations, { recursive: true });
for (const name of fs.readdirSync(path.join(repositoryRoot, "apps/operations/migrations"))
  .filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0203"))
  fs.copyFileSync(path.join(repositoryRoot, "apps/operations/migrations", name), path.join(historicalMigrations, name));
const { applyPaOpsAuthority203, compilePaOpsAuthority203, prepareAuthority203, readAuthorityPacket203,
  run: runAuthority203, runReviewedApply, authorityArtifact203, MAX_AUTHORITY_ARTIFACT_BYTES, STAFF } =
  await import(pathToFileURL(path.join(root, "scripts/staging-pa-ops-authority-v203.mjs")).href);
test.after(() => {
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith("pa-authority-frozen203-"));
  fs.rmSync(root, { recursive: true, force: true });
});
const requireOperations = createRequire(path.join(repositoryRoot, "apps/operations/package.json"));
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

    // Match the observed current staging directory input (74,412 bytes) with
    // portable fixture identities and genuine immutable history triggers.
    // This exercises the actual audit-table constraints during paired cleanup,
    // rather than merely padding a file or raising a reader limit.
    let sized = await prepareAuthority203(db, sources());
    for (let count = 0; Buffer.byteLength(JSON.stringify(sized.input.directory)) < 74_412 && count < 20; count++) {
      await db.batch(Array.from({ length: 25 }, () => db.prepare("UPDATE native_directory_grants SET active=1 WHERE id='original-view'")));
      sized = await prepareAuthority203(db, sources());
    }
    assert.ok(Buffer.byteLength(JSON.stringify(sized.input.directory)) >= 74_412);
    assert.ok(Buffer.byteLength(`${JSON.stringify(sized, null, 2)}\n`) > 2_000_000);

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
      const cleanupInputBytes = Buffer.byteLength(JSON.stringify(revoke.input.directory));
      assert.ok(cleanupInputBytes > 240_000, "current-sized real lineage exceeds the historical compiler cap");
      assert.ok(cleanupInputBytes <= 262_144, "canonical cleanup plan remains within the actual audit table constraint");
      assert.ok(Buffer.byteLength(JSON.stringify(revoke.input)) < 500_000);
      assert.ok(Buffer.byteLength(`${JSON.stringify(revoke, null, 2)}\n`) > MAX_AUTHORITY_ARTIFACT_BYTES,
        "duplicated cleanup SQL must not be persisted as the review artifact");
      assert.ok(Buffer.byteLength(`${JSON.stringify(authorityArtifact203(revoke), null, 2)}\n`) < MAX_AUTHORITY_ARTIFACT_BYTES);
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

    await t.test("apply and cleanup readers accept legitimate >2MB prepared packets and enforce the same 4MB boundary before any connection", async () => {
      let large, serialized;
      for (let count = 25; count <= 300; count += 25) {
        const input = structuredClone(packet.input), template = input.directory.history.find(row => row.grant_id === "original-view");
        input.directory.history = [...input.directory.history.filter(row => row.grant_id !== "original-view"),
          ...Array.from({ length: count }, (_, index) => ({ ...template, grant_version: index + 1, grant_generation: index + 1 }))];
        input.directory.generation.generation = count;
        large = compilePaOpsAuthority203(input);
        serialized = `${JSON.stringify(large, null, 2)}\n`;
        if (Buffer.byteLength(serialized) > 2_000_000) break;
      }
      assert.ok(Buffer.byteLength(serialized) > 2_000_000, "fixture reproduces the legitimate compiled SQL amplification");
      assert.ok(Buffer.byteLength(JSON.stringify(large.input)) < 500_000, "input budget remains unchanged");
      const evidence = createPrivateEvidenceDirectory(root, crypto.randomUUID());
      const filename = evidence.provisionPath, sourceFile = path.join(evidence.evidenceDir, "sources.json"), backupFile = path.join(evidence.evidenceDir, "backup.sql");
      const missingConfig = path.join(evidence.evidenceDir, "missing-binding.json");
      try {
        fs.writeFileSync(filename, serialized, { flag: "wx", mode: 0o600 });
        fs.writeFileSync(sourceFile, JSON.stringify(sources()), { flag: "wx", mode: 0o600 });
        const backup = "CREATE TABLE fixture(id TEXT);\n--" + "x".repeat(2000);
        fs.writeFileSync(backupFile, backup, { flag: "wx", mode: 0o600 });
        assert.deepEqual(readAuthorityPacket203(filename), large);
        const applyArgs = ["apply", "--config", missingConfig, "--packet", filename, "--phase", "provision",
          "--plan-sha256", large.planSha256, "--backup", backupFile, "--backup-sha256",
          crypto.createHash("sha256").update(backup).digest("hex"), "--confirm-reviewed-staging-authority"];
        // Missing config is checked synchronously before Wrangler/proxy startup.
        // Seeing this error proves both CLI paths accepted the large artifact.
        await assert.rejects(runReviewedApply(applyArgs), /config must be an existing regular file/);
        await assert.rejects(runAuthority203(["prepare-revoke", "--config", missingConfig, "--sources", sourceFile,
          "--prior", filename]), /config must be an existing regular file/);
        fs.writeFileSync(filename, `${JSON.stringify(authorityArtifact203(large), null, 2)}\n`);
        assert.deepEqual(readAuthorityPacket203(filename), large, "new compact preparation is locally recompiled");
        await assert.rejects(runReviewedApply(applyArgs), /config must be an existing regular file/);
        await assert.rejects(runAuthority203(["prepare-revoke", "--config", missingConfig, "--sources", sourceFile,
          "--prior", filename]), /config must be an existing regular file/);
        fs.writeFileSync(filename, serialized);
        fs.appendFileSync(filename, " ".repeat(MAX_AUTHORITY_ARTIFACT_BYTES - Buffer.byteLength(serialized)));
        assert.deepEqual(readAuthorityPacket203(filename), large, "exact boundary remains accepted");
        fs.appendFileSync(filename, " ");
        assert.throws(() => readAuthorityPacket203(filename), /validation failed/);
        await assert.rejects(runReviewedApply(applyArgs), /validation failed/);
        await assert.rejects(runAuthority203(["prepare-revoke", "--config", missingConfig, "--sources", sourceFile,
          "--prior", filename]), /validation failed/);
      } finally {
        assert.equal(path.dirname(evidence.evidenceDir), path.join(root, ".backups/staging-native-authority"));
        for (const file of [filename, sourceFile, backupFile]) if (fs.existsSync(file)) fs.unlinkSync(file);
        fs.rmdirSync(evidence.evidenceDir);
      }
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
