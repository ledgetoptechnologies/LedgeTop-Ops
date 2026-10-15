import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const instance = "10000000-0000-4000-8000-000000000001";
const application = "20000000-0000-4000-8000-000000000002";
const epoch = "30000000-0000-4000-8000-000000000003";
const hash = "a".repeat(64);

async function migrate(db: D1Database, name: string): Promise<void> {
  const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
  await db.batch(splitD1MigrationStatements(sql).map(statement => db.prepare(statement)));
}

async function setup(): Promise<{ runtime: Miniflare; db: D1Database }> {
  const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
    script: "export default {}", d1Databases: ["OPS_DB"] });
  const db = await runtime.getD1Database("OPS_DB") as D1Database;
  await db.batch(splitD1MigrationStatements(`
    CREATE TABLE project_alpha_directory_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_project_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      external_project_id TEXT,project_alpha_public_id TEXT);
  `).map(statement => db.prepare(statement)));
  await migrate(db, "0161_project_alpha_api_v2_inventory_observations.sql");
  return { runtime, db };
}

async function receipt(db: D1Database, source: string, request: string, generation: string): Promise<void> {
  await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(
    source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,
    authorization_generation,page_sha256,item_count) VALUES(?,?,?,?,'directory',?,?,?,1)`)
    .bind(source, instance, application, epoch, request, generation, request.replaceAll("-", "").padEnd(64, "0").slice(0, 64)).run();
}

async function observation(db: D1Database, source: string, request: string, publicId: string,
  bindingRevision: string, projection = hash, present = true,
  externalId = "synthetic-client", status: "active" | "tombstoned" = "active"): Promise<void> {
  await db.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(
    source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,
    project_alpha_public_id,resource_revision,present,last_action,projection_sha256,
    binding_external_id,binding_status,binding_resource_revision)
    VALUES(?,?,?,?,?,'client',?,'2',?,?,?,?,?,?)`)
    .bind(source, instance, application, epoch, request, publicId, present ? 1 : 0,
      present ? "upsert" : "delete", projection, externalId, status, bindingRevision).run();
}

async function reuseConflicts(db: D1Database, source: string): Promise<number> {
  return await db.prepare(`SELECT count(*) n FROM project_alpha_api_v2_inventory_conflicts
    WHERE source_id=? AND conflict_kind='revision_reuse_mismatch'`).bind(source).first<number>("n") ?? -1;
}

describe("Project Alpha Directory binding authorization epochs", () => {
  it("requires exact immutable conflict evidence before discounting a historical false positive", async () => {
    const { runtime, db } = await setup();
    try {
      const validSource = "project-alpha:evidence-valid", validPublicId = "e".repeat(32);
      const validPrior = "81000000-0000-4000-8000-000000000001";
      const validCurrent = "82000000-0000-4000-8000-000000000002";
      await receipt(db, validSource, validPrior, "55");
      await observation(db, validSource, validPrior, validPublicId, "1");
      await receipt(db, validSource, validCurrent, "58");
      await observation(db, validSource, validCurrent, validPublicId, "2");
      expect(await reuseConflicts(db, validSource)).toBe(1);

      await migrate(db, "0185_project_alpha_directory_binding_generation_epochs.sql");
      await migrate(db, "0186_project_alpha_directory_conflict_evidence_binding.sql");
      expect(await db.prepare(`SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current
        WHERE source_id=?`).bind(validSource).first<number>("has_conflict")).toBe(0);

      for (const evidence of [
        { source: "project-alpha:evidence-external", publicId: "f".repeat(32),
          prior: "83000000-0000-4000-8000-000000000003",
          current: "84000000-0000-4000-8000-000000000004",
          externalId: "wrong-client", details: JSON.stringify({
            observedProjectionSha256: hash, priorProjectionSha256: hash }) },
        { source: "project-alpha:evidence-hash", publicId: "0".repeat(32),
          prior: "85000000-0000-4000-8000-000000000005",
          current: "86000000-0000-4000-8000-000000000006",
          externalId: "synthetic-client", details: JSON.stringify({
            observedProjectionSha256: "b".repeat(64), priorProjectionSha256: hash }) },
      ]) {
        await receipt(db, evidence.source, evidence.prior, "55");
        await observation(db, evidence.source, evidence.prior, evidence.publicId, "1");
        await receipt(db, evidence.source, evidence.current, "58");
        await observation(db, evidence.source, evidence.current, evidence.publicId, "2");
        expect(await reuseConflicts(db, evidence.source)).toBe(0);
        await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(
          source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
          project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
          VALUES(?,?,?,?, 'directory','client',?,?,?,?, 'revision_reuse_mismatch','2',?)`)
          .bind(evidence.source, instance, application, epoch, evidence.publicId, evidence.externalId,
            evidence.current, evidence.prior, evidence.details).run();
        expect(await db.prepare(`SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current
          WHERE source_id=?`).bind(evidence.source).first<number>("has_conflict")).toBe(1);
      }
    } finally { await runtime.dispose(); }
  }, 60_000);

  it("retains but precisely resolves the legacy binding-only false positive", async () => {
    const { runtime, db } = await setup();
    try {
      const source = "project-alpha:binding-legacy", publicId = "1".repeat(32);
      const prior = "41000000-0000-4000-8000-000000000001";
      const current = "42000000-0000-4000-8000-000000000002";
      await receipt(db, source, prior, "55"); await observation(db, source, prior, publicId, "1");
      await receipt(db, source, current, "58"); await observation(db, source, current, publicId, "2");
      expect(await reuseConflicts(db, source)).toBe(1);

      const unrelatedBefore = await db.prepare(`SELECT name,sql FROM sqlite_master
        WHERE type='trigger' AND name<>'project_alpha_api_v2_directory_revision_reuse' ORDER BY name`).all();
      await migrate(db, "0185_project_alpha_directory_binding_generation_epochs.sql");
      const unrelatedAfter = await db.prepare(`SELECT name,sql FROM sqlite_master
        WHERE type='trigger' AND name<>'project_alpha_api_v2_directory_revision_reuse' ORDER BY name`).all();

      expect(unrelatedAfter.results).toEqual(unrelatedBefore.results);
      expect(await reuseConflicts(db, source)).toBe(1);
      expect(await db.prepare(`SELECT request_id,has_conflict
        FROM project_alpha_api_v2_directory_observations_current WHERE source_id=?`).bind(source).first())
        .toEqual({ request_id: current, has_conflict: 0 });

      await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(
        source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
        project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
        VALUES(?,?,?,?, 'directory','client',?,?,?,'missing-prior','revision_reuse_mismatch','2','{}')`)
        .bind(source, instance, application, epoch, publicId, "synthetic-client", current).run();
      expect(await db.prepare(`SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current
        WHERE source_id=?`).bind(source).first<number>("has_conflict")).toBe(1);

      const sameSource = "project-alpha:binding-same", samePublicId = "9".repeat(32);
      const samePrior = "43000000-0000-4000-8000-000000000003";
      const sameCurrent = "44000000-0000-4000-8000-000000000004";
      await receipt(db, sameSource, samePrior, "55"); await observation(db, sameSource, samePrior, samePublicId, "1");
      await receipt(db, sameSource, sameCurrent, "55"); await observation(db, sameSource, sameCurrent, samePublicId, "2");
      expect(await db.prepare(`SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current
        WHERE source_id=?`).bind(sameSource).first<number>("has_conflict")).toBe(1);

      await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(
        source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
        project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
        VALUES(?,?,?,?, 'directory','client',?,?,?,'unrelated','external_id_collision','2','{}')`)
        .bind(source, instance, application, epoch, publicId, "synthetic-client", current).run();
      expect(await db.prepare(`SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current
        WHERE source_id=?`).bind(source).first<number>("has_conflict")).toBe(1);
    } finally { await runtime.dispose(); }
  }, 60_000);

  it("allows only binding-only deltas backed by a strictly newer full receipt identity", async () => {
    const { runtime, db } = await setup();
    try {
      await migrate(db, "0185_project_alpha_directory_binding_generation_epochs.sql");
      const cases = [
        { suffix: "newer", prior: "55", next: "58", binding: "2", projection: hash, present: true, conflicts: 0 },
        { suffix: "digit-9", prior: "9", next: "10", binding: "2", projection: hash, present: true, conflicts: 0 },
        { suffix: "digit-99", prior: "99", next: "100", binding: "2", projection: hash, present: true, conflicts: 0 },
        { suffix: "same", prior: "55", next: "55", binding: "2", projection: hash, present: true, conflicts: 1 },
        { suffix: "lower", prior: "56", next: "55", binding: "2", projection: hash, present: true, conflicts: 1 },
        { suffix: "hash", prior: "55", next: "58", binding: "1", projection: "b".repeat(64), present: true, conflicts: 1 },
        { suffix: "action", prior: "55", next: "58", binding: "1", projection: hash, present: false, conflicts: 1 },
      ] as const;
      for (const [index, item] of cases.entries()) {
        const source = `project-alpha:epoch-${item.suffix}`, publicId = String(index + 2).repeat(32);
        const prior = `51000000-0000-4000-8000-00000000000${index}`;
        const next = `61000000-0000-4000-8000-00000000000${index}`;
        await receipt(db, source, prior, item.prior); await observation(db, source, prior, publicId, "1");
        await receipt(db, source, next, item.next); await observation(db, source, next, publicId,
          item.binding, item.projection, item.present);
        expect(await reuseConflicts(db, source), item.suffix).toBe(item.conflicts);
      }

      const externalSource = "project-alpha:epoch-external", externalPublicId = "a".repeat(32);
      const externalPrior = "71000000-0000-4000-8000-000000000001";
      const externalNext = "72000000-0000-4000-8000-000000000002";
      await receipt(db, externalSource, externalPrior, "55");
      await observation(db, externalSource, externalPrior, externalPublicId, "1");
      await receipt(db, externalSource, externalNext, "58");
      await observation(db, externalSource, externalNext, externalPublicId, "2", hash, true, "changed-client");
      expect(await reuseConflicts(db, externalSource)).toBe(0);
      expect(await db.prepare(`SELECT count(*) n FROM project_alpha_api_v2_inventory_conflicts
        WHERE source_id=? AND conflict_kind='public_id_binding_changed'`)
        .bind(externalSource).first<number>("n")).toBe(1);

      const statusSource = "project-alpha:epoch-status", statusPublicId = "b".repeat(32);
      const statusPrior = "73000000-0000-4000-8000-000000000003";
      const statusNext = "74000000-0000-4000-8000-000000000004";
      await receipt(db, statusSource, statusPrior, "55");
      await observation(db, statusSource, statusPrior, statusPublicId, "1");
      await receipt(db, statusSource, statusNext, "58");
      await observation(db, statusSource, statusNext, statusPublicId, "2", hash, true,
        "synthetic-client", "tombstoned");
      expect(await reuseConflicts(db, statusSource)).toBe(0);

      const inconsistentSource = "project-alpha:epoch-inconsistent", inconsistentPublicId = "c".repeat(32);
      const inconsistentPrior = "75000000-0000-4000-8000-000000000005";
      const inconsistentNext = "76000000-0000-4000-8000-000000000006";
      await receipt(db, inconsistentSource, inconsistentPrior, "55");
      await observation(db, inconsistentSource, inconsistentPrior, inconsistentPublicId, "1");
      await receipt(db, inconsistentSource, inconsistentNext, "58");
      await observation(db, inconsistentSource, inconsistentNext, inconsistentPublicId, "2");
      await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(
        source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
        project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
        VALUES(?,?,?,?, 'directory','client',?,?,?,?,'revision_reuse_mismatch','3','{}')`)
        .bind(inconsistentSource, instance, application, epoch, inconsistentPublicId,
          "synthetic-client", inconsistentNext, inconsistentPrior).run();
      expect(await db.prepare(`SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current
        WHERE source_id=?`).bind(inconsistentSource).first<number>("has_conflict")).toBe(1);

      const misboundSource = "project-alpha:epoch-misbound", misboundPublicId = "d".repeat(32);
      const otherSource = "project-alpha:epoch-other";
      const otherRequest = "77000000-0000-4000-8000-000000000007";
      const misboundRequest = "78000000-0000-4000-8000-000000000008";
      await receipt(db, otherSource, otherRequest, "55");
      await observation(db, otherSource, otherRequest, misboundPublicId, "1");
      await receipt(db, misboundSource, misboundRequest, "58");
      await observation(db, misboundSource, misboundRequest, misboundPublicId, "2");
      await db.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(
        source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
        project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,observed_revision,details_json)
        VALUES(?,?,?,?, 'directory','client',?,?,?,?,'revision_reuse_mismatch','2','{}')`)
        .bind(misboundSource, instance, application, epoch, misboundPublicId,
          "synthetic-client", misboundRequest, otherRequest).run();
      expect(await db.prepare(`SELECT has_conflict FROM project_alpha_api_v2_directory_observations_current
        WHERE source_id=?`).bind(misboundSource).first<number>("has_conflict")).toBe(1);
    } finally { await runtime.dispose(); }
  }, 60_000);
});
