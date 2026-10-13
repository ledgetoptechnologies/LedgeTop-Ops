import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { listProjectAlphaDirectoryReadAdoptionCandidates } from "../src/worker/project-alpha-directory-read-adoption-candidates";
import type { Env } from "../src/worker/types";

let runtime: Miniflare;
let database: D1Database;
let env: Pick<Env, "OPS_DB">;

const instance = "10000000-0000-4000-8000-000000000001";
const application = "20000000-0000-4000-8000-000000000002";
const epoch = "30000000-0000-4000-8000-000000000003";

async function migrate(): Promise<void> {
  const prerequisites = `
    CREATE TABLE project_alpha_directory_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_acquired_canonical_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT);
    CREATE TABLE project_alpha_project_mappings(
      source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT,
      external_project_id TEXT,project_alpha_public_id TEXT);
  `;
  await database.batch(splitD1MigrationStatements(prerequisites).map(statement => database.prepare(statement)));
  const migration = readFileSync(new URL("../migrations/0161_project_alpha_api_v2_inventory_observations.sql", import.meta.url), "utf8");
  await database.batch(splitD1MigrationStatements(migration).map(statement => database.prepare(statement)));
  await database.prepare(`CREATE TABLE project_alpha_directory_read_adoption_reviews(
    review_id TEXT PRIMARY KEY,source_id TEXT,source_instance_id TEXT,application_id TEXT,
    resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT)`).run();
}

async function seedPage(sourceId: string, requestId: string, resources: ReadonlyArray<{
  type: "client" | "organization"; publicId: string; externalId?: string;
  revision?: string; status?: "active" | "tombstoned";
}>): Promise<void> {
  await database.prepare(`INSERT INTO project_alpha_api_v2_inventory_receipts(
      source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,
      authorization_generation,requested_cursor,next_cursor,page_sha256,item_count)
    VALUES(?,?,?,?, 'directory',?,'7',NULL,NULL,?,?)`).bind(
      sourceId, instance, application, epoch, requestId, requestId.replaceAll("-", "").padEnd(64, "a").slice(0, 64), resources.length,
    ).run();
  for (const resource of resources) {
    const revision = resource.revision ?? "3", externalId = resource.externalId;
    await database.prepare(`INSERT INTO project_alpha_api_v2_directory_observations(
        source_id,source_instance_id,application_id,history_epoch_id,request_id,resource_type,
        project_alpha_public_id,resource_revision,present,last_action,projection_sha256,
        binding_external_id,binding_status,binding_resource_revision)
      VALUES(?,?,?,?,?,?,?,?,1,'upsert',?,?,?,?)`).bind(
        sourceId, instance, application, epoch, requestId, resource.type, resource.publicId, revision,
        resource.publicId.padEnd(64, "0"), externalId ?? null, externalId ? resource.status ?? "active" : null,
        externalId ? revision : null,
      ).run();
  }
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, script: "export default {}", compatibilityDate: "2026-08-06",
    d1Databases: { DB: "directory-candidate-test" } });
  database = await runtime.getD1Database("DB");
  env = { OPS_DB: database };
  await migrate();
});

afterAll(async () => runtime.dispose());

describe("Project Alpha Directory read-adoption candidates", () => {
  it("keyset-pages only current conflict-free unmapped and unreserved active bindings", async () => {
    const sourceId = "project-alpha:candidate-page";
    const firstPublicId = "1".repeat(32), secondPublicId = "2".repeat(32);
    const mappedPublicId = "3".repeat(32), reservedPublicId = "4".repeat(32);
    const conflictedPublicId = "5".repeat(32), unboundPublicId = "6".repeat(32);
    await seedPage(sourceId, "41000000-0000-4000-8000-000000000004", [
      { type: "client", publicId: firstPublicId, externalId: "pa-client-one" },
      { type: "organization", publicId: secondPublicId, externalId: "pa-org-two" },
      { type: "client", publicId: mappedPublicId, externalId: "pa-client-mapped" },
      { type: "client", publicId: reservedPublicId, externalId: "pa-client-reserved" },
      { type: "client", publicId: conflictedPublicId, externalId: "pa-client-conflicted" },
      { type: "client", publicId: unboundPublicId },
    ]);
    await database.batch([
      database.prepare(`INSERT INTO project_alpha_directory_mappings VALUES(?,?,?,?,?,?,?)`)
        .bind(sourceId, instance, application, epoch, "client", "pa-client-mapped", mappedPublicId),
      database.prepare(`INSERT INTO project_alpha_directory_read_adoption_reviews VALUES(?,?,?,?,?,?,?)`)
        .bind("71000000-0000-4000-8000-000000000007", sourceId, instance, application,
          "client", "pa-client-reserved", reservedPublicId),
      database.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(
          source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
          project_alpha_public_id,external_id,request_id,prior_reference,conflict_kind,details_json)
        VALUES(?,?,?,?, 'directory','client',?,?,?,'prior','revision_reuse_mismatch','{}')`)
        .bind(sourceId, instance, application, epoch, conflictedPublicId, "pa-client-conflicted",
          "81000000-0000-4000-8000-000000000008"),
    ]);

    const before = await database.batch([
      database.prepare("SELECT count(*) n FROM project_alpha_directory_mappings"),
      database.prepare("SELECT count(*) n FROM project_alpha_acquired_canonical_mappings"),
      database.prepare("SELECT count(*) n FROM project_alpha_directory_read_adoption_reviews"),
    ]);
    const first = await listProjectAlphaDirectoryReadAdoptionCandidates(env, { sourceId, limit: 1 });
    expect(first?.items).toEqual([{
      source: { sourceId, sourceInstanceId: instance, applicationId: application, historyEpoch: epoch },
      resourceType: "client", projectAlphaPublicId: firstPublicId, resourceRevision: "3",
      authorizationGeneration: "7",
      binding: { externalId: "pa-client-one", status: "active", resourceRevision: "3" },
      conflictState: "clear",
    }]);
    expect(first?.nextCursor).toEqual(expect.any(String));
    await expect(listProjectAlphaDirectoryReadAdoptionCandidates(env, {
      sourceId: "project-alpha:another-source", limit: 1, cursor: first?.nextCursor ?? undefined,
    })).resolves.toBeNull();
    const second = await listProjectAlphaDirectoryReadAdoptionCandidates(env, {
      sourceId, limit: 1, cursor: first?.nextCursor ?? undefined,
    });
    expect(second?.items.map(item => item.projectAlphaPublicId)).toEqual([secondPublicId]);
    expect(second?.nextCursor).toBeNull();
    expect(JSON.stringify([first, second])).not.toMatch(/name|email|phone|profile|projectionSha/i);

    const after = await database.batch([
      database.prepare("SELECT count(*) n FROM project_alpha_directory_mappings"),
      database.prepare("SELECT count(*) n FROM project_alpha_acquired_canonical_mappings"),
      database.prepare("SELECT count(*) n FROM project_alpha_directory_read_adoption_reviews"),
    ]);
    expect(after.map(result => result.results)).toEqual(before.map(result => result.results));
  });

  it("fails closed for source-wide conflicts and malformed bounds or cursors", async () => {
    const sourceId = "project-alpha:candidate-conflict";
    await seedPage(sourceId, "42000000-0000-4000-8000-000000000004", [
      { type: "client", publicId: "7".repeat(32), externalId: "pa-client-seven" },
    ]);
    await database.prepare(`INSERT INTO project_alpha_api_v2_inventory_conflicts(
        source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,resource_type,
        request_id,prior_reference,conflict_kind,details_json)
      VALUES(?,?,?,?, 'directory','source',?,'prior-source','source_identity_changed','{}')`)
      .bind(sourceId, instance, application, epoch, "82000000-0000-4000-8000-000000000008").run();
    await expect(listProjectAlphaDirectoryReadAdoptionCandidates(env, { sourceId, limit: 25 }))
      .resolves.toEqual({ items: [], nextCursor: null });
    await expect(listProjectAlphaDirectoryReadAdoptionCandidates(env, { sourceId, limit: 101 }))
      .resolves.toBeNull();
    await expect(listProjectAlphaDirectoryReadAdoptionCandidates(env, { sourceId, limit: 25, cursor: "bad" }))
      .resolves.toBeNull();
    await expect(listProjectAlphaDirectoryReadAdoptionCandidates(env, { sourceId: "invalid", limit: 25 }))
      .resolves.toBeNull();
  });
});
