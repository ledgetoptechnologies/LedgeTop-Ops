import { readFileSync, readdirSync } from "node:fs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";

const migrations = [
  "0179_service_assignment_policy_proof_v2.sql",
  "0180_service_assignment_policy_v1_contract.sql",
  "0181_service_assignment_request_policy_reviews.sql",
] as const;

const proof = JSON.stringify({
  version: 2,
  sourceId: "project-alpha:secondary",
  reviewId: "review-secondary-1",
  reviewRevision: 1,
  workspaceId: "workspace-secondary",
  localProjectId: "local-project-secondary",
  subjectType: "project",
  subjectPublicId: "project-secondary",
  generationId: "assignment-generation-1",
  sourceGeneration: "assignment-source-1",
  sourceSequence: 2,
  directoryGenerationId: "directory-generation-1",
  directorySourceSequence: 3,
  evaluatedAt: "2026-08-31T12:00:00.000Z",
  expiresAt: "2026-08-31T12:05:00.000Z",
});

describe("service-assignment policy proof expand and contract migrations", () => {
  let runtime: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    runtime = new Miniflare({
      compatibilityDate: "2026-08-06",
      modules: true,
      script: "export default {fetch(){return new Response('ok')}}",
      d1Databases: { POLICY_PROOF_DB: "service-assignment-policy-proof-migration" },
    });
    db = await runtime.getD1Database("POLICY_PROOF_DB") as unknown as D1Database;
  });

  afterAll(async () => runtime.dispose());

  async function migrate(name: typeof migrations[number]) {
    const sql = readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8");
    const statements = splitD1MigrationStatements(sql);
    if (statements.length) await db.batch(statements.map(statement => db.prepare(statement)));
  }

  it("orders expand, writer drain contract, then source review without rewriting history", async () => {
    const names = readdirSync(new URL("../migrations/", import.meta.url))
      .filter(name => /^01(?:79|80|81)_.*\.sql$/.test(name)).sort();
    expect(names).toEqual([...migrations]);

    await db.batch([
      db.prepare(`CREATE TABLE client_service_request_drafts(
        id TEXT PRIMARY KEY,note TEXT NOT NULL,service_assignment_policy_json TEXT)`),
      db.prepare(`CREATE TABLE client_service_requests(
        id TEXT PRIMARY KEY,note TEXT NOT NULL,service_assignment_policy_json TEXT)`),
      db.prepare(`CREATE TABLE pa_service_assignment_receiver_grants(
        source_id TEXT PRIMARY KEY,capability TEXT,contract_version INTEGER,state TEXT)`),
      db.prepare(`CREATE TABLE pa_service_assignment_receiver_workspaces(
        source_id TEXT,workspace_id TEXT,state TEXT)`),
      db.prepare(`CREATE TABLE pa_service_assignment_source_capabilities(
        source_id TEXT,contract_version INTEGER,state TEXT)`),
      db.prepare(`CREATE TABLE pa_portal_source_authorities(
        source_id TEXT PRIMARY KEY,state TEXT,active_revision INTEGER)`),
      db.prepare(`CREATE TABLE pa_portal_source_authority_revisions(
        source_id TEXT,revision INTEGER,PRIMARY KEY(source_id,revision))`),
      db.prepare(`INSERT INTO client_service_request_drafts
        (id,note,service_assignment_policy_json) VALUES ('historical-draft','before','{"version":1}')`),
      db.prepare(`INSERT INTO client_service_requests
        (id,note,service_assignment_policy_json) VALUES ('historical-request','before','{"version":1}')`),
    ]);

    await migrate(migrations[0]);
    // Expand remains compatible with an old writer while the fleet drains.
    await db.prepare(`INSERT INTO client_service_request_drafts
      (id,note,service_assignment_policy_json) VALUES ('rolling-v1','old writer','{"version":1}')`).run();
    await db.prepare(`INSERT INTO client_service_request_drafts
      (id,note,service_assignment_policy_v2_json) VALUES ('v2-draft','new writer',?)`).bind(proof).run();
    await db.prepare(`INSERT INTO client_service_requests
      (id,note,service_assignment_policy_v2_json) VALUES ('v2-request','new writer',?)`).bind(proof).run();

    const missingReview = JSON.stringify({ ...JSON.parse(proof), reviewId: undefined });
    await expect(db.prepare(`INSERT INTO client_service_request_drafts
      (id,note,service_assignment_policy_v2_json) VALUES ('missing-review','bad',?)`)
      .bind(missingReview).run()).rejects.toThrow();
    const extraKey = JSON.stringify({ ...JSON.parse(proof), extra: true });
    await expect(db.prepare(`INSERT INTO client_service_requests
      (id,note,service_assignment_policy_v2_json) VALUES ('extra-key','bad',?)`)
      .bind(extraKey).run()).rejects.toThrow();
    const invalidSource = JSON.stringify({ ...JSON.parse(proof), sourceId: "project-alpha:UPPER" });
    await expect(db.prepare(`INSERT INTO client_service_requests
      (id,note,service_assignment_policy_v2_json) VALUES ('bad-source','bad',?)`)
      .bind(invalidSource).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE client_service_request_drafts
      SET service_assignment_policy_json='{"version":1}' WHERE id='v2-draft'`).run()).rejects.toThrow();

    await migrate(migrations[1]);
    await db.prepare(`UPDATE client_service_request_drafts SET note='after' WHERE id='historical-draft'`).run();
    expect(await db.prepare(`SELECT note,service_assignment_policy_json proof
      FROM client_service_request_drafts WHERE id='historical-draft'`).first()).toEqual({
        note: "after", proof: '{"version":1}',
      });
    await db.prepare(`UPDATE client_service_request_drafts SET service_assignment_policy_json=NULL
      WHERE id='rolling-v1'`).run();
    await expect(db.prepare(`UPDATE client_service_request_drafts SET service_assignment_policy_json='{"version":1}'
      WHERE id='rolling-v1'`).run()).rejects.toThrow("legacy-service-assignment-policy-proof-disabled");
    await expect(db.prepare(`INSERT INTO client_service_requests
      (id,note,service_assignment_policy_json) VALUES ('late-v1','old writer','{"version":1}')`).run())
      .rejects.toThrow("legacy-service-assignment-policy-proof-disabled");
    await db.prepare(`INSERT INTO client_service_request_drafts
      (id,note,service_assignment_policy_v2_json) VALUES ('post-contract-v2','new writer',?)`).bind(proof).run();

    await migrate(migrations[2]);
    expect(await db.prepare(`SELECT COUNT(*) count FROM pa_service_assignment_request_policy_reviews`)
      .first<number>("count")).toBe(0);
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  }, 60_000);
});
