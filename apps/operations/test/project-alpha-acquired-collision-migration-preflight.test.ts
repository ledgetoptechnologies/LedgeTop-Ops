import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

async function fixture() {
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
  const db = await runtime.getD1Database("OPS_DB") as D1Database;
  await db.batch(splitD1MigrationStatements(`
    CREATE TABLE project_alpha_directory_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,resource_type TEXT,
      external_id TEXT,project_alpha_public_id TEXT
    );
    CREATE TABLE project_alpha_acquired_canonical_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,resource_type TEXT,
      record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,receipt_id TEXT
    );
    CREATE TABLE project_alpha_acquired_native_owner_claims(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,resource_type TEXT,
      record_id TEXT,external_id TEXT,project_alpha_public_id TEXT,receipt_id TEXT
    );
    CREATE TRIGGER project_alpha_acquired_canonical_mappings_legacy_collision
      BEFORE INSERT ON project_alpha_acquired_canonical_mappings BEGIN SELECT 'old canonical guard'; END;
    CREATE TRIGGER project_alpha_acquired_canonical_mappings_native_identity_collision
      BEFORE INSERT ON project_alpha_acquired_canonical_mappings BEGIN SELECT 'old canonical identity guard'; END;
    CREATE TRIGGER project_alpha_acquired_native_owner_claims_legacy
      BEFORE INSERT ON project_alpha_acquired_native_owner_claims BEGIN SELECT 'old claim guard'; END;
    CREATE TRIGGER project_alpha_directory_mappings_acquired_collision
      BEFORE INSERT ON project_alpha_directory_mappings BEGIN SELECT 'old legacy guard'; END;
  `).map(statement => db.prepare(statement)));
  return { runtime, db };
}

const migration = readFileSync(new URL("../migrations/0179_project_alpha_acquired_native_identity_collision.sql", import.meta.url), "utf8");
const scope = ["project-alpha:primary", "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333", "client"];

describe("0179 acquired/legacy identity collision preflight", () => {
  it.each([
    ["acquired record ID", "canonical_mappings", "ops-record-42", "a".repeat(32)],
    ["acquired external ID", "canonical_mappings", "pa-record-99", "a".repeat(32)],
    ["acquired public ID", "canonical_mappings", "legacy-record-42", "b".repeat(32)],
    ["owner-claim record ID", "native_owner_claims", "ops-record-42", "a".repeat(32)],
  ])("rejects a pre-existing %s collision and rolls back trigger replacement", async (_label, ownerTable, legacyExternal, legacyPublicId) => {
    const { runtime, db } = await fixture();
    try {
      await db.batch([
        db.prepare(`INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?)`)
          .bind(...scope, legacyExternal, legacyPublicId),
        db.prepare(`INSERT INTO project_alpha_acquired_${ownerTable}
          (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
          VALUES(?,?,?,?,?,?,?,?)`)
          .bind(...scope, "ops-record-42", "pa-record-99", "b".repeat(32), "receipt-42"),
      ]);
      await expect(db.batch(splitD1MigrationStatements(migration).map(statement => db.prepare(statement))))
        .rejects.toThrow(/CHECK constraint failed/);
      const triggers = await db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (
        'project_alpha_acquired_canonical_mappings_legacy_collision',
        'project_alpha_acquired_canonical_mappings_native_identity_collision',
        'project_alpha_acquired_native_owner_claims_legacy',
        'project_alpha_directory_mappings_acquired_collision') ORDER BY name`).all();
      expect(triggers.results).toHaveLength(4);
      expect(triggers.results.every(row => String(row.sql).includes("old "))).toBe(true);
    } finally { await runtime.dispose(); }
  });

  it("rejects legacy-public-to-acquired-external and acquired cross-column aliases before replacing guards", async () => {
    const { runtime, db } = await fixture();
    try {
      await db.batch([
        db.prepare(`INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?)`)
          .bind(...scope, "legacy-external", "acquired-external"),
        db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings
          (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
          VALUES(?,?,?,?,?,?,?,?)`)
          .bind(...scope, "ops-record-a", "acquired-external", "public-a", "receipt-a"),
      ]);
      await expect(db.batch(splitD1MigrationStatements(migration).map(statement => db.prepare(statement))))
        .rejects.toThrow(/CHECK constraint failed/);
      const oldGuard = await db.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger'
        AND name='project_alpha_acquired_canonical_mappings_native_identity_collision'`).first();
      expect(String(oldGuard?.sql)).toContain("old canonical identity guard");

      const secondFixture = await fixture();
      try {
        await secondFixture.db.batch([
          secondFixture.db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings
            (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
            VALUES(?,?,?,?,?,?,?,?)`)
            .bind(...scope, "ops-record-a", "external-a", "public-a", "receipt-a"),
          secondFixture.db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings
            (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
            VALUES(?,?,?,?,?,?,?,?)`)
            .bind(...scope, "ops-record-b", "ops-record-a", "public-b", "receipt-b"),
        ]);
        await expect(secondFixture.db.batch(splitD1MigrationStatements(migration).map(statement => secondFixture.db.prepare(statement))))
          .rejects.toThrow(/CHECK constraint failed/);
      } finally { await secondFixture.runtime.dispose(); }
    } finally { await runtime.dispose(); }
  });

  it("applies the reviewed guards when existing acquired and legacy identities are disjoint", async () => {
    const { runtime, db } = await fixture();
    try {
      await db.batch([
        db.prepare(`INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?)`)
          .bind(...scope, "legacy-record-42", "a".repeat(32)),
        db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings
          (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
          VALUES(?,?,?,?,?,?,?,?)`)
          .bind(...scope, "ops-record-99", "pa-record-99", "b".repeat(32), "receipt-99"),
      ]);
      await expect(db.batch(splitD1MigrationStatements(migration).map(statement => db.prepare(statement))))
        .resolves.toBeDefined();
      const guards = await db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (
        'project_alpha_acquired_canonical_mappings_legacy_collision',
        'project_alpha_acquired_canonical_mappings_native_identity_collision',
        'project_alpha_acquired_native_owner_claims_legacy',
        'project_alpha_acquired_native_owner_claims_native_identity_collision',
        'project_alpha_directory_mappings_acquired_collision') ORDER BY name`).all();
      expect(guards.results).toHaveLength(5);
      expect(guards.results.every(row => !String(row.sql).includes("old "))).toBe(true);
    } finally { await runtime.dispose(); }
  });

  it("keeps cross-ID collisions blocked after migration in both insertion directions, including owner claims", async () => {
    const { runtime, db } = await fixture();
    try {
      await db.batch(splitD1MigrationStatements(migration).map(statement => db.prepare(statement)));

      const collisionFromAcquiredPublicId = "a".repeat(32);
      await db.prepare(`INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?)`)
        .bind(...scope, collisionFromAcquiredPublicId, "b".repeat(32)).run();

      await expect(db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings
        (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
        VALUES(?,?,?,?,?,?,?,?)`)
        .bind(...scope, "ops-record-canonical", "pa-record-canonical", collisionFromAcquiredPublicId, "receipt-canonical").run())
        .rejects.toThrow(/acquired canonical mapping collides with legacy mapping/);
      await expect(db.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims
        (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
        VALUES(?,?,?,?,?,?,?,?)`)
        .bind(...scope, "ops-record-claim", "pa-record-claim", collisionFromAcquiredPublicId, "receipt-claim").run())
        .rejects.toThrow(/native owner claim collides with legacy mapping/);

      const canonicalPublicId = "c".repeat(32);
      await db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings
        (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
        VALUES(?,?,?,?,?,?,?,?)`)
        .bind(...scope, "ops-record-canonical-reverse", "pa-record-canonical-reverse", canonicalPublicId, "receipt-canonical-reverse").run();
      await expect(db.prepare(`INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?)`)
        .bind(...scope, canonicalPublicId, "d".repeat(32)).run())
        .rejects.toThrow(/legacy mapping collides with acquired reservation/);

      const claimPublicId = "e".repeat(32);
      await db.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims
        (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
        VALUES(?,?,?,?,?,?,?,?)`)
        .bind(...scope, "ops-record-claim-reverse", "pa-record-claim-reverse", claimPublicId, "receipt-claim-reverse").run();
      await expect(db.prepare(`INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?)`)
        .bind(...scope, claimPublicId, "f".repeat(32)).run())
        .rejects.toThrow(/legacy mapping collides with acquired reservation/);

      const acquiredExternal = "pa-external-cross-column";
      await db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings
        (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
        VALUES(?,?,?,?,?,?,?,?)`)
        .bind(...scope, "ops-record-acquired", acquiredExternal, "1".repeat(32), "receipt-acquired").run();
      await expect(db.prepare(`INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?)`)
        .bind(...scope, "new-legacy-external", acquiredExternal).run())
        .rejects.toThrow(/legacy mapping collides with acquired reservation/);

      await expect(db.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings
        (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
        VALUES(?,?,?,?,?,?,?,?)`)
        .bind(...scope, acquiredExternal, "another-external", "2".repeat(32), "receipt-alias").run())
        .rejects.toThrow(/acquired identity collides with an existing native identity/);

      await db.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims
        (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
        VALUES(?,?,?,?,?,?,?,?)`)
        .bind(...scope, "ops-record-acquired", acquiredExternal, "1".repeat(32), "receipt-acquired").run();
      await expect(db.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims
        (source_id,source_instance_id,application_id,resource_type,record_id,external_id,project_alpha_public_id,receipt_id)
        VALUES(?,?,?,?,?,?,?,?)`)
        .bind(...scope, acquiredExternal, "2".repeat(32), "another-public", "receipt-alias").run())
        .rejects.toThrow(/native owner claim collides with an existing native identity/);
    } finally { await runtime.dispose(); }
  });
});
