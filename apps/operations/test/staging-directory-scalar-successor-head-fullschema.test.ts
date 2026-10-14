import { afterEach, expect, it } from "vitest";
import { readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readLocalScalarSuccessorTuple } from "../src/worker/staging-directory-scalar-successor-head";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const root = resolve(import.meta.dirname, "../../..");
const source = resolve(
  root,
  "scripts/staging-directory-scalar-authority-v184-fullschema.test.mjs",
);
const instrumented = resolve(
  root,
  "scripts/.scalar-successor-head-fullschema.instrumented.mjs",
);
afterEach(() => {
  try {
    unlinkSync(instrumented);
  } catch {}
});

it(
  "executes HEAD scalar successor SELECT after historical authority cleanup and canonical upgrade to 0203",
  { timeout: 240_000 },
  async () => {
    let text = readFileSync(source, "utf8");
    text = text
      .replace(
        "async function lifecycle(t,postHistoricalLifecycleHook){",
        "export async function lifecycle(t,postHistoricalLifecycleHook){",
      )
      .replace(/\ntest\("full 0001-0184[\s\S]*$/u, "\n");
    writeFileSync(instrumented, text, "utf8");
    const module = await import(
      `${pathToFileURL(instrumented).href}?run=${crypto.randomUUID()}`
    );
    const cleanups: Array<() => Promise<void>> = [];
    const t = {
      after(fn: () => Promise<void>) {
        cleanups.push(fn);
      },
    };
    try {
      await module.lifecycle(
        t,
        async (db: D1Database, target: Record<string, string>) => {
          const migrationDirectory = resolve(root, "apps/operations/migrations");
          // This fixture verifies the historical 0195-to-0203 upgrade. Later
          // migrations have their own release-chain and full-schema coverage.
          const names = readdirSync(migrationDirectory)
            .filter(name => /^\d{4}_.+\.sql$/u.test(name) && Number(name.slice(0, 4)) <= 203)
            .sort();
          expect(names).toHaveLength(203);
          expect(names.at(-1)).toBe("0203_effective_native_directory_enrollment_consumers.sql");
          expect((await db.prepare("SELECT count(*) count FROM d1_migrations").first<{count:number}>())!.count).toBe(195);
          // Frozen authority has been revoked under its exact 0195 ledger.
          // Upgrade with actual statements and ledger writes, never fake views.
          for (const name of names.slice(195)) await db.batch([
            ...splitD1MigrationStatements(readFileSync(resolve(migrationDirectory, name), "utf8")).map(sql => db.prepare(sql)),
            db.prepare("INSERT INTO d1_migrations(name) VALUES(?)").bind(name),
          ]);
          expect((await db.prepare("SELECT name FROM d1_migrations ORDER BY name").all<{name:string}>()).results.map(row => row.name)).toEqual(names);
          expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
          const ack = await db
            .prepare(
              "SELECT revision FROM project_alpha_directory_validated_recovery_relationship_acknowledgements WHERE client_record_id=? AND identity_valid=1",
            )
            .bind(target.clientRecordId)
            .first<{ revision: string }>();
          expect(ack).not.toBeNull();
          const requestId = "88888888-8888-4888-8888-888888888888",
            projection = "8".repeat(64);
          await db.batch([
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count,observed_at) VALUES('project-alpha:staging',?,?,?,'directory',?,'56',NULL,NULL,?,1,'2099-01-01T00:00:00.000Z')",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                requestId,
                "9".repeat(64),
              ),
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision) VALUES('project-alpha:staging',?,?,?,'directory',?,'client',?,?,1,'upsert',?,?,'active',?)",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                requestId,
                target.clientPublicId,
                ack!.revision,
                projection,
                target.clientRecordId,
                ack!.revision,
              ),
          ]);
          const row = await readLocalScalarSuccessorTuple(db);
          if (!row) {
            const summary: Record<string, unknown> = {};
            for (const [name, sql] of Object.entries({
              mapping:
                "SELECT count(*) count FROM project_alpha_active_directory_mappings WHERE source_id='project-alpha:staging' AND resource_type='client' AND record_id=?",
              ack: "SELECT count(*) count FROM project_alpha_directory_validated_recovery_relationship_acknowledgements WHERE client_record_id=? AND identity_valid=1",
              observation:
                "SELECT count(*) count FROM project_alpha_api_v2_directory_observations WHERE source_id='project-alpha:staging' AND resource_type='client' AND project_alpha_public_id=?",
              receipt:
                "SELECT count(*) count FROM project_alpha_api_v2_inventory_receipts WHERE source_id='project-alpha:staging' AND inventory_kind='directory'",
            })) {
              const statement = db.prepare(sql);
              const query =
                name === "receipt"
                  ? statement
                  : statement.bind(
                      name === "observation"
                        ? target.clientPublicId
                        : target.clientRecordId,
                    );
              summary[name] = (await query.first())?.count;
            }
            summary.rows = (
              await db
                .prepare(
                  "SELECT observation.resource_revision revision,observation.present,observation.projection_sha256 projection,receipt.authorization_generation generation,receipt.observed_at FROM project_alpha_api_v2_directory_observations observation JOIN project_alpha_api_v2_inventory_receipts receipt ON receipt.source_id=observation.source_id AND receipt.source_instance_id=observation.source_instance_id AND receipt.application_id=observation.application_id AND receipt.history_epoch_id=observation.history_epoch_id AND receipt.inventory_kind='directory' AND receipt.request_id=observation.request_id WHERE observation.source_id='project-alpha:staging' AND observation.resource_type='client' AND observation.project_alpha_public_id=? ORDER BY receipt.observed_at",
                )
                .bind(target.clientPublicId)
                .all()
            ).results;
            throw Error(`successor tuple absent ${JSON.stringify(summary)}`);
          }
          expect(row).toMatchObject({
            sourceId: "project-alpha:staging",
            sourceInstanceId: target.sourceInstanceId,
            applicationId: target.applicationId,
            historyEpoch: target.historyEpochId,
            externalId: target.clientRecordId,
            publicId: target.clientPublicId,
            mappingKind: "legacy",
          });
          expect(row!.origin).toMatch(/^https:\/\//u);
          expect(row!.revision).toMatch(/^[1-9][0-9]*$/u);
          expect(row!.projectionSha256).toMatch(/^[0-9a-f]{64}$/u);
          expect(row!.relationshipAuthorizationGeneration).toMatch(
            /^(0|[1-9][0-9]*)$/u,
          );
          const otherRequest = "99999999-9999-4999-8999-999999999999";
          await db.batch([
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count,observed_at) VALUES('project-alpha:staging',?,?,?,'directory',?,'56',NULL,NULL,?,1,'2099-01-01T00:00:00.001Z')",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                otherRequest,
                "a".repeat(64),
              ),
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256) VALUES('project-alpha:staging',?,?,?,'directory',?,'client',?,'1',1,'upsert',?)",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                otherRequest,
                "f".repeat(32),
                "b".repeat(64),
              ),
          ]);
          expect(await readLocalScalarSuccessorTuple(db)).toEqual(row);
          const changedRequest = "44444444-4444-4444-8444-444444444444";
          await db.batch([
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count,observed_at) VALUES('project-alpha:staging',?,?,?,'directory',?,'56',NULL,NULL,?,1,'2099-01-01T00:00:00.002Z')",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                changedRequest,
                "0".repeat(64),
              ),
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision) VALUES('project-alpha:staging',?,?,?,'directory',?,'client',?,?,1,'upsert',?,?,'active',?)",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                changedRequest,
                target.clientPublicId,
                String(Number(ack!.revision) + 1),
                "0".repeat(64),
                target.clientRecordId,
                String(Number(ack!.revision) + 1),
              ),
          ]);
          expect(await readLocalScalarSuccessorTuple(db)).toBeNull();
          const newerMatchRequest = "77777777-7777-4777-8777-777777777777";
          await db.batch([
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count,observed_at) VALUES('project-alpha:staging',?,?,?,'directory',?,'56',NULL,NULL,?,1,'2099-01-01T00:00:00.003Z')",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                newerMatchRequest,
                "e".repeat(64),
              ),
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision) VALUES('project-alpha:staging',?,?,?,'directory',?,'client',?,?,1,'upsert',?,?,'active',?)",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                newerMatchRequest,
                target.clientPublicId,
                ack!.revision,
                projection,
                target.clientRecordId,
                ack!.revision,
              ),
          ]);
          expect(await readLocalScalarSuccessorTuple(db)).toMatchObject({
            projectionSha256: projection,
            revision: ack!.revision,
          });
          const equalA = "66666666-6666-4666-8666-666666666666",
            equalB = "55555555-5555-4555-8555-555555555555";
          await db.batch([
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count,observed_at) VALUES('project-alpha:staging',?,?,?,'directory',?,'56',NULL,NULL,?,1,'2099-01-01T00:00:00.004Z')",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                equalA,
                "1".repeat(64),
              ),
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision) VALUES('project-alpha:staging',?,?,?,'directory',?,'client',?,?,1,'upsert',?,?,'active',?)",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                equalA,
                target.clientPublicId,
                ack!.revision,
                projection,
                target.clientRecordId,
                ack!.revision,
              ),
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count,observed_at) VALUES('project-alpha:staging',?,?,?,'directory',?,'56',NULL,NULL,?,1,'2099-01-01T00:00:00.004Z')",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                equalB,
                "2".repeat(64),
              ),
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision) VALUES('project-alpha:staging',?,?,?,'directory',?,'client',?,?,0,'delete',?,?,'tombstoned',?)",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                equalB,
                target.clientPublicId,
                String(Number(ack!.revision) + 1),
                "3".repeat(64),
                target.clientRecordId,
                String(Number(ack!.revision) + 1),
              ),
          ]);
          expect(await readLocalScalarSuccessorTuple(db)).toBeNull();
          const tombstoneRequest = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
          await db.batch([
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_inventory_receipts(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,authorization_generation,requested_cursor,next_cursor,page_sha256,item_count,observed_at) VALUES('project-alpha:staging',?,?,?,'directory',?,'56',NULL,NULL,?,1,'2099-01-01T00:00:00.005Z')",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                tombstoneRequest,
                "c".repeat(64),
              ),
            db
              .prepare(
                "INSERT INTO project_alpha_api_v2_directory_observations(source_id,source_instance_id,application_id,history_epoch_id,inventory_kind,request_id,resource_type,project_alpha_public_id,resource_revision,present,last_action,projection_sha256,binding_external_id,binding_status,binding_resource_revision) VALUES('project-alpha:staging',?,?,?,'directory',?,'client',?,?,0,'delete',?,?,'tombstoned',?)",
              )
              .bind(
                target.sourceInstanceId,
                target.applicationId,
                target.historyEpochId,
                tombstoneRequest,
                target.clientPublicId,
                String(Number(ack!.revision) + 1),
                "d".repeat(64),
                target.clientRecordId,
                String(Number(ack!.revision) + 1),
              ),
          ]);
          expect(await readLocalScalarSuccessorTuple(db)).toBeNull();
          const plans = (
            await db
              .prepare(
                "EXPLAIN QUERY PLAN SELECT * FROM project_alpha_active_directory_mappings WHERE source_id=? AND record_id=?",
              )
              .bind("project-alpha:staging", target.clientRecordId)
              .all()
          ).results;
          expect(plans.length).toBeGreaterThan(0);
        },
      );
    } finally {
      for (const cleanup of cleanups.reverse()) await cleanup();
    }
  },
);
