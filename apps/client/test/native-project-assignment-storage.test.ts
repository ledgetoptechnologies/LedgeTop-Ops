import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { describe, expect, it } from "vitest";
import { splitD1MigrationStatements } from "./helpers/d1-migrations";
import { serializeNativeProjectAssignmentProof, nativeProjectAssignmentStorageReady } from "../src/worker/client-portal/native-project-assignment-storage";
import type { Env } from "../src/worker/types";
import { serializeServiceAssignmentPolicyProof, type ServiceAssignmentPolicyProof } from "../src/worker/client-portal/service-assignment-policy";

const proof: ServiceAssignmentPolicyProof = {
  version: 2, sourceId: "project-alpha:secondary", reviewId: "review-secondary", reviewRevision: 1,
  workspaceId: "native-workspace", localProjectId: null, nativeProject: true,
  subjectType: "project", subjectPublicId: "native-project", generationId: "assignment-generation",
  sourceGeneration: "source-generation", sourceSequence: 1, directoryGenerationId: "directory-generation",
  directorySourceSequence: 1, evaluatedAt: "2026-10-25T00:00:00.000Z", expiresAt: "2026-10-25T00:05:00.000Z",
};

describe("native project assignment proof additive storage", () => {
  it("preserves every native provenance field without changing the old serializer", () => {
    const original = serializeServiceAssignmentPolicyProof(proof)!;
    expect(JSON.parse(serializeNativeProjectAssignmentProof(proof)))
      .toEqual({ ...JSON.parse(original), version: 3 });
    expect(serializeServiceAssignmentPolicyProof(proof)).toBe(original);
    expect(() => serializeNativeProjectAssignmentProof({ ...proof, nativeProject: false })).toThrow();
    expect(() => serializeNativeProjectAssignmentProof({ ...proof, localProjectId: "invented-local-id" })).toThrow();
  });

  it("expands old rows and writers unchanged and rejects incomplete, conflicting or mismatched native proof", async () => {
    const runtime = new Miniflare({ compatibilityDate: "2026-08-06", modules: true,
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: { DB: "native-proof-migration" } });
    try {
      const db = await runtime.getD1Database("DB") as unknown as D1Database;
      for (const table of ["client_service_request_drafts", "client_service_requests"]) {
        await db.prepare(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,note TEXT,service_assignment_policy_json TEXT,
          project_id TEXT,portal_workspace_id TEXT,portal_identity_id TEXT,portal_project_public_id TEXT,
          catalog_source_id TEXT)`).run();
      }
      const migrate = async (name: string) => {
        const statements = splitD1MigrationStatements(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
        await db.batch(statements.map(sql => db.prepare(sql)));
      };
      await migrate("0179_service_assignment_policy_proof_v2.sql");
      const legacy = serializeServiceAssignmentPolicyProof({ ...proof, nativeProject: false, localProjectId: "local-project" });
      const root = serializeServiceAssignmentPolicyProof({ ...proof, nativeProject: false, subjectType: "organization", localProjectId: null });
      for (const table of ["client_service_request_drafts", "client_service_requests"]) {
        await db.prepare(`INSERT INTO ${table}(id,note,service_assignment_policy_v2_json) VALUES ('old-legacy','original',?),('old-root','original',?)`)
          .bind(legacy, root).run();
      }
      const before = await db.prepare("SELECT * FROM client_service_request_drafts ORDER BY id").all<Record<string, unknown>>();
      const expand = splitD1MigrationStatements(readFileSync(new URL("../migrations/0239_native_project_assignment_proof_v3.sql", import.meta.url), "utf8"));
      const firstAlter = expand.findIndex(sql => /ALTER TABLE client_service_request_drafts/i.test(sql));
      expect(firstAlter).toBeGreaterThanOrEqual(0);
      await db.batch(expand.slice(0, firstAlter + 1).map(sql => db.prepare(sql)));
      expect(await nativeProjectAssignmentStorageReady({ DELIVERY_DB: db } as Env)).toBe(false);
      await db.batch(expand.slice(firstAlter + 1).map(sql => db.prepare(sql)));
      expect(await nativeProjectAssignmentStorageReady({ DELIVERY_DB: db } as Env)).toBe(true);
      const after = await db.prepare("SELECT * FROM client_service_request_drafts ORDER BY id").all<Record<string, unknown>>();
      expect(after.results.map(({ native_project_assignment_proof_v3_json, ...row }) => row)).toEqual(before.results);
      expect(after.results.every(row => row.native_project_assignment_proof_v3_json === null)).toBe(true);
      const native = serializeNativeProjectAssignmentProof(proof);
      for (const table of ["client_service_request_drafts", "client_service_requests"]) {
        const insert = (id: string, value: string) => db.prepare(`INSERT INTO ${table}
          (id,portal_workspace_id,portal_identity_id,portal_project_public_id,catalog_source_id,native_project_assignment_proof_v3_json)
          VALUES (?,'native-workspace','native-identity','native-project','project-alpha:secondary',?)`).bind(id, value).run();
        await insert("new-native", native);
        for (const [key, value] of Object.entries({ version: 2, nativeProject: 1, localProjectId: "invented-local-id",
          subjectType: "organization", sourceId: "project-alpha:other", workspaceId: "another-workspace",
          subjectPublicId: "another-project", reviewRevision: null, sourceSequence: 0,
          expiresAt: "2026-10-25T00:06:00.000Z", reviewId: null })) {
          await expect(insert(`invalid-${key}`, JSON.stringify({ ...JSON.parse(native), [key]: value }))).rejects.toThrow();
        }
        const missing = JSON.parse(native); delete missing.reviewId;
        await expect(insert("missing-field", JSON.stringify(missing))).rejects.toThrow();
        await expect(insert("extra-field", JSON.stringify({ ...JSON.parse(native), extra: true }))).rejects.toThrow();
        await expect(insert("malformed", "{")).rejects.toThrow();
        await expect(db.prepare(`UPDATE ${table} SET service_assignment_policy_v2_json=? WHERE id='new-native'`).bind(legacy).run()).rejects.toThrow();
        await expect(db.prepare(`UPDATE ${table} SET portal_project_public_id='changed-project' WHERE id='new-native'`).run()).rejects.toThrow();
        // Rollback/old writers can still insert and edit their own NULL-v3 rows.
        await db.prepare(`INSERT INTO ${table}(id,note,service_assignment_policy_v2_json) VALUES ('old-writer-after-expand','old',?)`).bind(root).run();
        await db.prepare(`UPDATE ${table} SET note='updated by old writer' WHERE id='old-root'`).run();
        expect(await db.prepare(`SELECT native_project_assignment_proof_v3_json FROM ${table} WHERE id='new-native'`)
          .first("native_project_assignment_proof_v3_json")).toBe(native);
      }
      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    } finally { await runtime.dispose(); }
  }, 60_000);
});
