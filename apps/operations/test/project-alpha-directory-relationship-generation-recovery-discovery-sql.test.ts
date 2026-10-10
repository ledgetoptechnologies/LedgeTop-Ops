import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const serviceSource = readFileSync(new URL("../src/worker/project-alpha-directory-relationship-generation-recovery-service.ts", import.meta.url), "utf8");
const discoverySql = serviceSource.match(/prepare\(`(SELECT predecessor\.command_id,[\s\S]*?LIMIT 2)`\)\.bind\(record, source\)/)?.[1];
if (!discoverySql) throw new Error("Exact relationship recovery discovery SQL was not found");

const client = "client-local", organization = "organization-local", source = "project-alpha:test";
const instance = "10000000-0000-4000-8000-000000000001", application = "10000000-0000-4000-8000-000000000002";
const epoch = "10000000-0000-4000-8000-000000000003", origin = "https://pa.example.test";
const clientPublic = "a".repeat(32), organizationPublic = "b".repeat(32);

function database(outcome: Record<string, unknown>): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE project_alpha_directory_relationship_outbox(command_id TEXT,mutation_id TEXT,client_record_id TEXT,
      relationship_version INTEGER,organization_record_id TEXT,source_id TEXT,source_instance_id TEXT,application_id TEXT,
      history_epoch_id TEXT,destination_origin TEXT,client_public_id TEXT,organization_public_id TEXT,
      expected_client_revision TEXT,expected_organization_revision TEXT,command_json TEXT,request_json TEXT,state TEXT,
      action TEXT,expected_current_organization_record_id TEXT,expected_current_organization_public_id TEXT,outcome_json TEXT,created_at TEXT);
    CREATE TABLE operations_directory_client_organizations(client_record_id TEXT,relationship_version INTEGER,organization_record_id TEXT);
    CREATE TABLE operations_directory_client_organization_history(client_record_id TEXT,relationship_version INTEGER,mutation_id TEXT,
      previous_organization_record_id TEXT,organization_record_id TEXT,client_record_version INTEGER,organization_record_version INTEGER);
    CREATE TABLE operations_directory_records(record_id TEXT,record_kind TEXT,current_version INTEGER);
    CREATE TABLE project_alpha_active_directory_mappings(record_id TEXT,resource_type TEXT,external_id TEXT,project_alpha_public_id TEXT,
      source_id TEXT,source_instance_id TEXT,application_id TEXT,history_epoch_id TEXT);
    CREATE TABLE native_directory_enrollments(record_id TEXT,destinations_json TEXT);
    CREATE TABLE project_alpha_directory_relationship_generation_recoveries(predecessor_command_id TEXT);`);
  db.prepare(`INSERT INTO operations_directory_client_organizations VALUES(?,2,?)`).run(client, organization);
  db.prepare(`INSERT INTO operations_directory_client_organization_history VALUES(?,2,'mutation',NULL,?,3,4)`).run(client, organization);
  db.prepare(`INSERT INTO operations_directory_records VALUES(?,'client',3),(?,'organization',4)`).run(client, organization);
  db.prepare(`INSERT INTO project_alpha_active_directory_mappings VALUES
    (?,'client','client-remote',?,?,?, ?,?),(?,'organization','organization-remote',?,?,?, ?,?)`)
    .run(client, clientPublic, source, instance, application, epoch,
      organization, organizationPublic, source, instance, application, epoch);
  const destination = (externalCanonicalId: string) => JSON.stringify([{ sourceId: source, sourceInstanceUUID: instance,
    applicationUUID: application, historyEpoch: epoch, origin, externalCanonicalId }]);
  db.prepare(`INSERT INTO native_directory_enrollments VALUES(?,?),(?,?)`)
    .run(client, destination("client-remote"), organization, destination("organization-remote"));
  const command = JSON.stringify({ commandId: "predecessor" });
  db.prepare(`INSERT INTO project_alpha_directory_relationship_outbox(command_id,mutation_id,client_record_id,relationship_version,
    organization_record_id,source_id,source_instance_id,application_id,history_epoch_id,destination_origin,client_public_id,
    organization_public_id,expected_client_revision,expected_organization_revision,command_json,request_json,state,action,
    expected_current_organization_record_id,expected_current_organization_public_id,outcome_json,created_at) VALUES
    ('predecessor','mutation',?,2,?,?,?,?,?,?,?,?,'7','9',?,json_object('request',1),'terminal','assign',NULL,NULL,?,'2026-01-01T00:00:00.000Z')`)
    .run(client, organization, source, instance, application, epoch, origin, clientPublic, organizationPublic, command, JSON.stringify(outcome));
  return db;
}

function discovered(outcome: Record<string, unknown>): number {
  const db = database(outcome);
  try { return db.prepare(discoverySql!).all(client, source).length; }
  finally { db.close(); }
}

describe("relationship recovery exact discovery SQL conflict marker", () => {
  it("accepts the canonical dispatcher-persisted 409 conflict", () => {
    expect(discovered({ directoryRelationshipDispatcher: "conflict", reason: "http_status", httpStatus: 409 })).toBe(1);
  });
  it.each([
    ["status-only shape", { status: "conflict", reason: "remote", httpStatus: 409 }],
    ["wrong dispatcher marker", { directoryRelationshipDispatcher: "uncertain", reason: "http_status", httpStatus: 409 }],
    ["wrong HTTP status", { directoryRelationshipDispatcher: "conflict", reason: "http_status", httpStatus: 500 }],
  ])("rejects %s", (_name, outcome) => expect(discovered(outcome)).toBe(0));
});
