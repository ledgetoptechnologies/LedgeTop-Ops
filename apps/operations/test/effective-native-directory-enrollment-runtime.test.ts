import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { nativeDirectoryOrganizationChoices } from "../src/worker/native-directory-profile-editor-record";
import type { Env } from "../src/worker/types";

const consumers = [
  "native-directory-profile-editor-record.ts",
  "native-directory-profile-routes.ts",
  "native-directory-profile-writer.ts",
  "native-directory-relationship-writer.ts",
  "native-directory-lifecycle-writer.ts",
  "project-alpha-directory-client-intent-materializer.ts",
  "project-alpha-directory-relationship-generation-recovery-service.ts",
] as const;

describe("effective native Directory enrollment runtime consumers", () => {
  it("routes every enrollment read through the versioned effective projection", () => {
    for (const name of consumers) {
      const source = readFileSync(new URL(`../src/worker/${name}`, import.meta.url), "utf8");
      expect(source, name).toContain("effective_native_directory_enrollments");
      expect(source, name).not.toMatch(/(?:FROM|JOIN)\s+native_directory_enrollments\b/);
    }
  });

  it("keeps native create destinations record-pinned while update reads accept acquired external IDs", () => {
    const routes = readFileSync(new URL("../src/worker/native-directory-profile-routes.ts", import.meta.url), "utf8");
    expect(routes).toContain("storedDestination(value, record)");
    expect(routes).toContain("configuredDestination(env, selected.sourceId, record)");
    expect(routes.match(/storedDestination\(value, null\)/g)).toHaveLength(3);
    expect(routes).toContain("configuredDestination(env, enrolled.sourceId, enrolled.externalCanonicalId)");
    expect(routes).toContain("configuredDestination(env, destination.sourceId, destination.externalCanonicalId)");
  });

  it("binds an enrolled external ID into the exact active organization mapping proof", () => {
    const editor = readFileSync(new URL("../src/worker/native-directory-profile-editor-record.ts", import.meta.url), "utf8");
    expect(editor).toContain("mapping.record_id=? AND mapping.external_id=?");
    expect(editor).toContain("destination.externalCanonicalId");
    expect(editor).not.toContain("row.externalCanonicalId !== recordId");
  });

  it("reads native fallback through the effective view and accepts an exact acquired external mapping", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    try {
      const db = await runtime.getD1Database("OPS_DB");
      const schema = `CREATE TABLE operations_directory_records(record_id TEXT,record_kind TEXT,current_version INTEGER);
        CREATE TABLE operations_directory_revisions(record_id TEXT,version INTEGER,profile_json TEXT);
        CREATE TABLE native_directory_enrollments(record_id TEXT,destinations_json TEXT,create_admission_id TEXT,created_at TEXT);
        CREATE VIEW effective_native_directory_enrollments AS SELECT record_id,destinations_json,0 enrollment_version,
          'native_create' enrollment_kind,create_admission_id provenance_id,created_at FROM native_directory_enrollments;
        CREATE TABLE project_alpha_active_directory_mappings(source_id TEXT,source_instance_id TEXT,application_id TEXT,
          history_epoch_id TEXT,resource_type TEXT,record_id TEXT,external_id TEXT,project_alpha_public_id TEXT);`;
      await db.batch(splitD1MigrationStatements(schema).map(sql => db.prepare(sql)));
      const recordId = "ops:organization:legacy", externalId = "pa:organization:42";
      const destination = { sourceId: "project-alpha:primary", sourceInstanceUUID: "11111111-1111-4111-8111-111111111111",
        applicationUUID: "22222222-2222-4222-8222-222222222222", historyEpoch: "33333333-3333-4333-8333-333333333333",
        origin: "https://pa.example.test", externalCanonicalId: externalId };
      await db.batch([
        db.prepare("INSERT INTO operations_directory_records VALUES(?,'organization',7)").bind(recordId),
        db.prepare("INSERT INTO operations_directory_revisions VALUES(?,7,?)").bind(recordId, JSON.stringify({ name: "Legacy Organization" })),
        db.prepare("INSERT INTO native_directory_enrollments VALUES(?,?,?,?)")
          .bind(recordId, JSON.stringify([destination]), "native-admission", "2026-01-01T00:00:00.000Z"),
        db.prepare("INSERT INTO project_alpha_active_directory_mappings VALUES(?,?,?,?,?,?,?,?)")
          .bind(destination.sourceId,destination.sourceInstanceUUID,destination.applicationUUID,destination.historyEpoch,
            "organization",recordId,externalId,"a".repeat(32)),
      ]);
      const env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
        [destination.sourceId]: { sourceId: destination.sourceId, enabled: true, baseUrl: destination.origin,
          apiKey: "synthetic", sourceInstanceId: destination.sourceInstanceUUID, applicationId: destination.applicationUUID,
          historyEpoch: destination.historyEpoch },
      } }) } as unknown as Env;
      await expect(nativeDirectoryOrganizationChoices(env)).resolves.toEqual([{
        recordId, expectedVersion: 7, name: "Legacy Organization", sourceIds: [destination.sourceId],
      }]);
      await db.prepare("UPDATE project_alpha_active_directory_mappings SET external_id='wrong'").run();
      await expect(nativeDirectoryOrganizationChoices(env)).resolves.toEqual([]);
    } finally { await runtime.dispose(); }
  });
});


