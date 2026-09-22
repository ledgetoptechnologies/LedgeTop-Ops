import { readFileSync, readdirSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const runtimes: Miniflare[] = [];
afterAll(async () => { for (const runtime of runtimes) await runtime.dispose(); });

const sourceId = "project-alpha:primary";
const sourceInstanceId = "33333333-3333-4333-8333-333333333333";
const applicationId = "44444444-4444-4444-8444-444444444444";
const historyEpochId = "55555555-5555-4555-8555-555555555555";
const reviewerStaffId = "staff-beau-koltz";
const reviewerAccessSubject = "access|migration-chain-reviewer";

type AcquisitionFixture = {
  stem: string;
  recordId: string;
  kind: "organization" | "client";
  publicId: string;
  requestHash: string;
  reviewHash: string;
  acquisitionHash: string;
  profileHash: string;
  bindingHash: string;
};

async function seedAcquisitionFixture(database: D1Database, fixture: AcquisitionFixture) {
  const id = (part: string) => `${fixture.stem}${part}000000-0000-4000-8000-000000000001`;
  const reviewId = id("1"), commandId = id("2"), acquiredReceiptId = id("3");
  const claimId = id("4"), nativeOwnerEpochId = id("5");
  await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(
    receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
    resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_id,
    reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,
    reviewer_admission_version,reviewer_profile_version,reviewed_at,reviewed_local_record_version)
    VALUES(?,?,?,?,?,?,?,?,?,?,'7',?,?,?,?,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),1)`)
    .bind(reviewId,fixture.requestHash,fixture.recordId,sourceId,sourceInstanceId,applicationId,historyEpochId,
      fixture.kind,fixture.recordId,fixture.publicId,id("6"),fixture.reviewHash,reviewerStaffId,reviewerAccessSubject).run();
  await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(
    command_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
    resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_receipt_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,'7',?)`).bind(commandId,fixture.requestHash,fixture.recordId,sourceId,
      sourceInstanceId,applicationId,historyEpochId,fixture.kind,fixture.recordId,fixture.publicId,reviewId).run();
  for (const [version,state,part] of [[1,"pending","7"],[2,"acknowledged","8"]] as const) {
    await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events(
      command_id,state_version,transition_id,request_sha256,state,occurred_at)
      VALUES(?,?,?,?,?,strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
      .bind(commandId,version,id(part),fixture.requestHash,state).run();
  }
  await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(
    command_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
    project_alpha_public_id,project_alpha_revision,destination_origin,pa_request_id,pa_replayed,response_sha256)
    VALUES(?,?,?,?,?,?,?,'7','https://pa.example.test',?,0,?)`).bind(commandId,sourceInstanceId,
      applicationId,historyEpochId,fixture.kind,fixture.recordId,fixture.publicId,id("9"),fixture.acquisitionHash).run();
  await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(
    receipt_id,request_sha256,command_id,record_id,source_id,source_instance_id,application_id,
    history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,
    acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'7',?,?,?)`).bind(acquiredReceiptId,fixture.requestHash,commandId,
      fixture.recordId,sourceId,sourceInstanceId,applicationId,historyEpochId,fixture.kind,fixture.recordId,
      fixture.publicId,fixture.acquisitionHash,fixture.profileHash,fixture.bindingHash).run();
  await database.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings(
    receipt_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,
    resource_type,external_id,project_alpha_public_id) VALUES(?,?,?,?,?,?,?,?,?)`).bind(acquiredReceiptId,
      fixture.recordId,sourceId,sourceInstanceId,applicationId,historyEpochId,fixture.kind,fixture.recordId,
      fixture.publicId).run();
  await database.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims(
    claim_id,receipt_id,native_owner_epoch_id,record_id,source_id,source_instance_id,application_id,
    history_epoch_id,resource_type,external_id,project_alpha_public_id,expected_local_record_version,
    actor_id,request_sha256) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).bind(claimId,acquiredReceiptId,
      nativeOwnerEpochId,fixture.recordId,sourceId,sourceInstanceId,applicationId,historyEpochId,fixture.kind,
      fixture.recordId,fixture.publicId,reviewerStaffId,fixture.requestHash).run();
  await database.prepare("INSERT INTO project_alpha_acquired_mapping_activation(receipt_id) VALUES(?)")
    .bind(acquiredReceiptId).run();
  return { reviewId, acquiredReceiptId, claimId };
}

async function activateFixture(database: D1Database, fixture: AcquisitionFixture,
  ids: Awaited<ReturnType<typeof seedAcquisitionFixture>>, activationId: string) {
  return database.prepare(`INSERT INTO project_alpha_existing_directory_binding_activation_receipts(
    activation_id,review_receipt_id,idempotency_key,acquired_receipt_id,native_owner_claim_id,
    record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
    project_alpha_public_id,project_alpha_revision,local_record_version,request_sha256,
    acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256,
    activated_by_staff_id,directory_grant_generation)
    VALUES(?,?,?, ?,?,?,?,?,?,?,?,?,?,'7',1,?,?,?,?,?,1)`)
    .bind(activationId,ids.reviewId,activationId,ids.acquiredReceiptId,ids.claimId,fixture.recordId,sourceId,
      sourceInstanceId,applicationId,historyEpochId,fixture.kind,fixture.recordId,fixture.publicId,
      fixture.requestHash,fixture.acquisitionHash,fixture.profileHash,fixture.bindingHash,reviewerStaffId).run();
}

describe("existing PA directory acquisition migration chain", () => {
  it("applies the clean sequential chain through 0132 without creating adoption state", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    runtimes.push(runtime);
    const database = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory)
      .filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0132").sort();
    expect(migrations.at(-1)).toBe("0132_operations_directory_acquired_relationship_dependencies.sql");
    for (const migration of migrations) {
      await database.batch(splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8"))
        .map(statement => database.prepare(statement)));
    }
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_activation_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_adoption_bind_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_adoption_review_producer_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_active_directory_mappings").first("count(*)")).toBe(0);
    expect(await database.prepare(`SELECT count(*) FROM sqlite_master WHERE type='trigger'
      AND name LIKE 'project_alpha_project_adoption_bind_receipts_%'`).first("count(*)")).toBe(8);
    expect(await database.prepare(`SELECT count(*) FROM sqlite_master WHERE type='trigger'
      AND name='project_alpha_existing_directory_binding_activation_exact'`).first("count(*)")).toBe(1);
    expect(await database.prepare(`SELECT count(*) FROM sqlite_master WHERE type='trigger'
      AND name='project_alpha_existing_directory_binding_activation_relationship'`).first("count(*)")).toBe(1);
    expect(await database.prepare(`SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (
      'project_alpha_project_adoption_review_producer_receipts_exact',
      'project_alpha_project_adoption_review_producer_receipts_no_update',
      'project_alpha_project_adoption_review_producer_receipts_no_delete')`).first("count(*)")).toBe(3);
  });

  it("applies through 0132 without changing populated canonical history or activating acquired mappings", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    runtimes.push(runtime);
    const database = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory)
      .filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0132").sort();
    expect(migrations.at(-1)).toBe("0132_operations_directory_acquired_relationship_dependencies.sql");
    const recordId = "11111111-1111-4111-8111-111111111111";
    const profile = JSON.stringify({ name: "Synthetic Existing", email: "existing@example.test", phone: null,
      address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null }, clientType: "business" });
    const historyTables = ["operations_directory_records", "operations_directory_revisions",
      "operations_directory_audit", "operations_directory_intents"];
    async function history() {
      const rows = await database.batch<Record<string, unknown>>(historyTables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY record_id`)));
      return rows.map(result => result.results);
    }
    let before: Awaited<ReturnType<typeof history>> | undefined;
    for (const migration of migrations) {
      await database.batch(splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8"))
        .map(statement => database.prepare(statement)));
      if (migration.startsWith("0054_")) {
        await database.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,
          external_id,command_json,destination_base_url,expected_source_instance_id,origin_snapshot_json,next_attempt_at)
          VALUES('legacy-command','project-alpha:primary','44444444-4444-4444-8444-444444444444','client',
            'legacy-external','{}','https://pa.example.test','33333333-3333-4333-8333-333333333333','{}',0)`).run();
        await database.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
          project_alpha_public_id,source_instance_id,application_id,command_id)
          VALUES('project-alpha:primary','client','legacy-external',?,'33333333-3333-4333-8333-333333333333',
            '44444444-4444-4444-8444-444444444444','legacy-command')`).bind("f".repeat(32)).run();
      }
      if (migration.startsWith("0055_")) {
        await database.batch([
          database.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)").bind(recordId),
          database.prepare("INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,1,'fixture-mutation',?)").bind(recordId, profile),
          database.prepare("INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json) VALUES('fixture-audit','fixture-mutation',?,1,'system','fixture-import',?)")
            .bind(recordId, JSON.stringify({ recordId, profile: JSON.parse(profile) })),
          database.prepare(`INSERT INTO operations_directory_intents(intent_id,mutation_id,record_id,record_version,source_id,
            source_instance_uuid,application_uuid,destination_origin,external_canonical_id,desired_payload_json,state)
            VALUES('fixture-intent','fixture-mutation',?,1,'project-alpha:primary',?,?,?, ?,?,'ready')`)
            .bind(recordId, recordId, "33333333-3333-4333-8333-333333333333", "https://pa.example.test", recordId, profile),
        ]);
      }
      if (migration.startsWith("0110_")) before = await history();
      if (migration.startsWith("0111_")) {
        await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(
          receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,
          review_id,reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,reviewer_admission_version,reviewer_profile_version,reviewed_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
          "22222222-2222-4222-8222-222222222222", "a".repeat(64), recordId, "project-alpha:primary", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555", "client", "fixture-external", "b".repeat(32), "1",
          "66666666-6666-4666-8666-666666666666", "c".repeat(64), "fixture-reviewer", "access|fixture-reviewer", 1, 1, "2026-09-14T12:35:56.789Z").run();
      }
    }
    expect(before).toBeDefined();
    expect(await history()).toEqual(before);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_review_evidence").first("count(*)")).toBe(1);
    expect(await database.prepare("SELECT reviewed_local_record_version FROM project_alpha_existing_directory_binding_review_evidence WHERE receipt_id='22222222-2222-4222-8222-222222222222'").first()).toEqual({ reviewed_local_record_version: null });
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_acquisition_commands").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_acquisition_events").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_acquired_mapping_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_acquisition_response_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_acquired_canonical_mappings").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_acquired_native_owner_claims").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_acquired_mapping_activation").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_revision_refresh_commands").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_revision_refresh_events").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_revision_refresh_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_v2_canonical_intents").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_v2_canonical_settlement_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_v2_canonical_activation_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_adoption_review_evidence").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_adoption_review_reservations").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_activation_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_adoption_bind_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_adoption_review_producer_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare("SELECT mapping_kind FROM project_alpha_active_directory_mappings WHERE provenance_id='legacy-command'").first("mapping_kind")).toBe("legacy");
    expect(await database.prepare("SELECT count(*) FROM project_alpha_directory_mappings WHERE command_id='legacy-command'").first("count(*)")).toBe(1);
    await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(
      receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_id,
      reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,
      reviewer_admission_version,reviewer_profile_version,reviewed_at,reviewed_local_record_version)
      VALUES('77777777-7777-4777-8777-777777777777',?,?,'project-alpha:primary',
        '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555','client','legacy-external',?,'1',
        '88888888-8888-4888-8888-888888888888',?,'fixture-reviewer','access|fixture-reviewer',1,1,
        '2026-09-14T12:35:56.789Z',1)`).bind("a".repeat(64),recordId,"f".repeat(32),"c".repeat(64)).run();
    await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(
      command_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_receipt_id)
      VALUES('99999999-9999-4999-8999-999999999999',?,?,'project-alpha:primary',
        '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555','client','legacy-external',?,'1',
        '77777777-7777-4777-8777-777777777777')`).bind("a".repeat(64),recordId,"f".repeat(32)).run();
    for (const [version,state,id] of [[1,"pending","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      [2,"acknowledged","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]] as const) {
      await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events(
        command_id,state_version,transition_id,request_sha256,state,occurred_at)
        VALUES('99999999-9999-4999-8999-999999999999',?,?,?,?,
          '2026-09-14T12:35:56.789Z')`).bind(version,id,"a".repeat(64),state).run();
    }
    await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(
      command_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
      project_alpha_public_id,project_alpha_revision,destination_origin,pa_request_id,pa_replayed,response_sha256)
      VALUES('99999999-9999-4999-8999-999999999999','33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555',
        'client','legacy-external',?,'1','https://pa.example.test',
        'cccccccc-cccc-4ccc-8ccc-cccccccccccc',0,?)`).bind("f".repeat(32),"d".repeat(64)).run();
    await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(
      receipt_id,request_sha256,command_id,record_id,source_id,source_instance_id,application_id,
      history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,
      acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256)
      VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd',?,
        '99999999-9999-4999-8999-999999999999',?,'project-alpha:primary',
        '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555','client','legacy-external',?,'1',?,?,?)`)
      .bind("a".repeat(64),recordId,"f".repeat(32),"b".repeat(64),"c".repeat(64),"d".repeat(64)).run();
    await expect(database.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings(
      receipt_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id)
      VALUES('dddddddd-dddd-4ddd-8ddd-dddddddddddd',?,'project-alpha:primary',
        '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555','client','legacy-external',?)`)
      .bind(recordId,"f".repeat(32)).run()).rejects.toThrow(/collides with legacy mapping/);
    expect(await database.prepare("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='project_alpha_existing_directory_binding_acquired_mapping_receipts_response_required'").first("count(*)")).toBe(1);
    expect(await database.prepare("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='project_alpha_existing_directory_binding_review_evidence_local_record_version_current'").first("count(*)")).toBe(1);
    expect(await database.prepare("SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name='project_alpha_existing_directory_binding_acquired_mapping_receipts_review_local_revision_current'").first("count(*)")).toBe(1);
  });

  it("preserves canonical history while a non-colliding acquired chain remains inactive through 0118", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    runtimes.push(runtime);
    const database = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory)
      .filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0118").sort();
    const recordId = "12121212-1212-4121-8121-121212121212";
    const profile = JSON.stringify({ name: "Synthetic Acquired", email: "acquired@example.test", phone: null,
      address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null }, clientType: "business" });
    const historyTables = ["operations_directory_records", "operations_directory_revisions",
      "operations_directory_audit", "operations_directory_intents"];
    async function history() {
      const rows = await database.batch<Record<string, unknown>>(historyTables.map(table => database.prepare(`SELECT * FROM ${table} ORDER BY record_id`)));
      return rows.map(result => result.results);
    }
    let before: Awaited<ReturnType<typeof history>> | undefined;
    for (const migration of migrations) {
      await database.batch(splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8"))
        .map(statement => database.prepare(statement)));
      if (migration.startsWith("0054_")) {
        await database.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,
          external_id,command_json,destination_base_url,expected_source_instance_id,origin_snapshot_json,next_attempt_at)
          VALUES('full-chain-legacy-command','project-alpha:primary','44444444-4444-4444-8444-444444444444','client',
            'legacy-external','{}','https://pa.example.test','33333333-3333-4333-8333-333333333333','{}',0)`).run();
        await database.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
          project_alpha_public_id,source_instance_id,application_id,command_id)
          VALUES('project-alpha:primary','client','legacy-external',?,'33333333-3333-4333-8333-333333333333',
            '44444444-4444-4444-8444-444444444444','full-chain-legacy-command')`).bind("f".repeat(32)).run();
      }
      if (migration.startsWith("0055_")) {
        await database.batch([
          database.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)").bind(recordId),
          database.prepare("INSERT INTO operations_directory_revisions(record_id,version,mutation_id,profile_json) VALUES(?,1,'full-chain-mutation',?)").bind(recordId, profile),
          database.prepare("INSERT INTO operations_directory_audit(audit_id,mutation_id,record_id,record_version,actor_type,actor_id,command_json) VALUES('full-chain-audit','full-chain-mutation',?,1,'system','fixture-import',?)")
            .bind(recordId, JSON.stringify({ recordId, profile: JSON.parse(profile) })),
          database.prepare(`INSERT INTO operations_directory_intents(intent_id,mutation_id,record_id,record_version,source_id,
            source_instance_uuid,application_uuid,destination_origin,external_canonical_id,desired_payload_json,state)
            VALUES('full-chain-intent','full-chain-mutation',?,1,'project-alpha:primary',?,?,?, ?,?,'ready')`)
            .bind(recordId, recordId, "33333333-3333-4333-8333-333333333333", "https://pa.example.test", recordId, profile),
        ]);
      }
      if (migration.startsWith("0110_")) before = await history();
    }
    expect(before).toBeDefined();

    const ids = {
      review: "22222222-2222-4222-8222-222222222223", command: "33333333-3333-4333-8333-333333333334",
      pending: "55555555-5555-4555-8555-555555555556", acknowledged: "66666666-6666-4666-8666-666666666667",
      receipt: "77777777-7777-4777-8777-777777777778", claim: "88888888-8888-4888-8888-888888888889",
      nativeEpoch: "99999999-9999-4999-8999-999999999990",
    };
    const externalId = "acquired-external";
    const publicId = "e".repeat(32);
    const requestHash = "a".repeat(64);
    await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(
      receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_id,
      reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,
      reviewer_admission_version,reviewer_profile_version,reviewed_at,reviewed_local_record_version)
      VALUES(?,?,?,'project-alpha:primary','33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555',
        'client',?,?,'1','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',?,'fixture-reviewer',
        'access|fixture-reviewer',1,1,'2026-09-14T12:35:56.789Z',1)`)
      .bind(ids.review, requestHash, recordId, externalId, publicId, "b".repeat(64)).run();
    await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_commands(
      command_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_receipt_id)
      VALUES(?,?,?,'project-alpha:primary','33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555',
        'client',?,?,'1',?)`).bind(ids.command, requestHash, recordId, externalId, publicId, ids.review).run();
    for (const [version, state, transitionId] of [[1, "pending", ids.pending], [2, "acknowledged", ids.acknowledged]] as const) {
      await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_events(
        command_id,state_version,transition_id,request_sha256,state,occurred_at)
        VALUES(?,?,?,?,?,'2026-09-14T12:35:56.789Z')`).bind(ids.command, version, transitionId, requestHash, state).run();
    }
    await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquisition_response_receipts(
      command_id,source_instance_id,application_id,history_epoch_id,resource_type,external_id,
      project_alpha_public_id,project_alpha_revision,destination_origin,pa_request_id,pa_replayed,response_sha256)
      VALUES(?,'33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555','client',?,?,'1','https://pa.example.test',
        'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc',0,?)`).bind(ids.command, externalId, publicId, "c".repeat(64)).run();
    await database.prepare(`INSERT INTO project_alpha_existing_directory_binding_acquired_mapping_receipts(
      receipt_id,request_sha256,command_id,record_id,source_id,source_instance_id,application_id,
      history_epoch_id,resource_type,external_id,project_alpha_public_id,project_alpha_revision,
      acquisition_evidence_sha256,profile_evidence_sha256,binding_status_evidence_sha256)
      VALUES(?,?,?,?,'project-alpha:primary','33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555',
        'client',?,?,'1',?,?,?)`).bind(ids.receipt, requestHash, ids.command, recordId, externalId, publicId,
        "b".repeat(64), "c".repeat(64), "d".repeat(64)).run();
    await database.prepare(`INSERT INTO project_alpha_acquired_canonical_mappings(
      receipt_id,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id)
      VALUES(?,?,'project-alpha:primary','33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555',
        'client',?,?)`).bind(ids.receipt, recordId, externalId, publicId).run();
    await database.prepare(`INSERT INTO project_alpha_acquired_native_owner_claims(
      claim_id,receipt_id,native_owner_epoch_id,record_id,source_id,source_instance_id,application_id,
      history_epoch_id,resource_type,external_id,project_alpha_public_id,expected_local_record_version,actor_id,request_sha256)
      VALUES(?,?,?,?,'project-alpha:primary','33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444','55555555-5555-4555-8555-555555555555',
        'client',?,?,1,'fixture-owner',?)`).bind(ids.claim, ids.receipt, ids.nativeEpoch, recordId, externalId, publicId, requestHash).run();
    await database.prepare("INSERT INTO project_alpha_acquired_mapping_activation(receipt_id) VALUES(?)").bind(ids.receipt).run();

    expect(await history()).toEqual(before);
    expect(await database.prepare("SELECT activation_state, native_owner_epoch_id FROM project_alpha_acquired_canonical_mappings WHERE receipt_id=?").bind(ids.receipt).first())
      .toEqual({ activation_state: "inactive", native_owner_epoch_id: null });
    expect(await database.prepare("SELECT state FROM project_alpha_acquired_mapping_activation WHERE receipt_id=?").bind(ids.receipt).first("state")).toBe("inactive");
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_review_evidence").first("count(*)")).toBe(1);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_acquisition_commands").first("count(*)")).toBe(1);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_acquisition_events").first("count(*)")).toBe(2);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_acquisition_response_receipts").first("count(*)")).toBe(1);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_acquired_mapping_receipts").first("count(*)")).toBe(1);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_acquired_canonical_mappings").first("count(*)")).toBe(1);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_acquired_native_owner_claims").first("count(*)")).toBe(1);
    await expect(database.prepare(`INSERT INTO project_alpha_existing_directory_binding_review_evidence(
      receipt_id,request_sha256,record_id,source_id,source_instance_id,application_id,history_epoch_id,
      resource_type,external_id,project_alpha_public_id,project_alpha_revision,review_id,
      reviewed_binding_evidence_sha256,reviewer_staff_id,reviewer_access_subject,
      reviewer_admission_version,reviewer_profile_version,reviewed_at,reviewed_local_record_version)
      VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccd',?,?, 'project-alpha:primary',
        '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',
        '55555555-5555-4555-8555-555555555555','client','stale-external',?,'1',
        'dddddddd-dddd-4ddd-8ddd-ddddddddddde',?,'fixture-reviewer','access|fixture-reviewer',1,1,
        '2026-09-14T12:35:56.789Z',2)`).bind(requestHash, recordId, "d".repeat(32), "b".repeat(64)).run())
      .rejects.toThrow(/local record version is stale/);
  });

  it("upgrades populated 0125 activation state through 0132 without changing protected rows", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    runtimes.push(runtime);
    const database = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const preexistingRecordId = "a0000000-0000-4000-8000-000000000001";
    const standaloneRecordId = "b0000000-0000-4000-8000-000000000001";
    const parentedRecordId = "c0000000-0000-4000-8000-000000000001";
    const reusedRecordId = "d0000000-0000-4000-8000-000000000001";
    const migrations = readdirSync(directory)
      .filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0126").sort();
    expect(migrations.at(-1)).toBe("0126_project_alpha_project_active_directory_mapping_bridge.sql");
    for (const migration of migrations) {
      const statements = splitD1MigrationStatements(readFileSync(new URL(migration, directory), "utf8"));
      if (migration.startsWith("0081_")) {
        for (const statement of statements) {
          if (statement.includes("CREATE TRIGGER operations_directory_client_organizations_insert_guard")) {
            await database.prepare(`INSERT INTO operations_directory_client_organizations(
              client_record_id,organization_record_id,relationship_version) VALUES(?,?,1)`)
              .bind(parentedRecordId,preexistingRecordId).run();
          }
          await database.prepare(statement).run();
        }
      } else {
        await database.batch(statements.map(statement => database.prepare(statement)));
      }
      if (migration.startsWith("0055_")) {
        await database.batch([
          database.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'organization',1)").bind(preexistingRecordId),
          database.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)").bind(standaloneRecordId),
          database.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)").bind(parentedRecordId),
          database.prepare("INSERT INTO operations_directory_records(record_id,record_kind,current_version) VALUES(?,'client',1)").bind(reusedRecordId),
        ]);
      }
      if (migration.startsWith("0054_")) {
        await database.batch([
          database.prepare(`INSERT INTO project_alpha_directory_outbox(command_id,source_id,application_id,resource_type,
            external_id,command_json,destination_base_url,expected_source_instance_id,origin_snapshot_json,next_attempt_at)
            VALUES('upgrade-legacy-command','project-alpha:primary','44444444-4444-4444-8444-444444444444',
              'client','upgrade-legacy','{}','https://pa.example.test',
              '33333333-3333-4333-8333-333333333333','{}',0)`),
          database.prepare(`INSERT INTO project_alpha_directory_mappings(source_id,resource_type,external_id,
            project_alpha_public_id,source_instance_id,application_id,command_id)
            VALUES('project-alpha:primary','client','upgrade-legacy','ffffffffffffffffffffffffffffffff',
              '33333333-3333-4333-8333-333333333333','44444444-4444-4444-8444-444444444444',
              'upgrade-legacy-command')`),
        ]);
      }
    }

    await database.batch([
      database.prepare(`INSERT INTO native_staff_admissions(
        staff_id,bound_access_subject,active,admitted_by,version) VALUES(?,?,1,?,1)`)
        .bind(reviewerStaffId,reviewerAccessSubject,reviewerStaffId),
      database.prepare(`INSERT INTO native_staff_profiles(staff_id,login_email,display_name,version)
        VALUES(?,'migration-reviewer@example.test','Migration Reviewer',1)`).bind(reviewerStaffId),
      database.prepare(`INSERT INTO native_directory_grants(
        id,staff_id,permission,effect,scope_kind,active,granted_by)
        VALUES('migration-chain-identity-link',?,'directory.identity.link','allow','global',1,?)`)
        .bind(reviewerStaffId,reviewerStaffId),
    ]);

    const preexisting: AcquisitionFixture = {
      stem: "a", recordId: preexistingRecordId, kind: "organization",
      publicId: "1".repeat(32), requestHash: "0".repeat(64), reviewHash: "1".repeat(64),
      acquisitionHash: "2".repeat(64), profileHash: "3".repeat(64), bindingHash: "1".repeat(64),
    };
    const preexistingIds = await seedAcquisitionFixture(database, preexisting);
    await activateFixture(database,preexisting,preexistingIds,"a9000000-0000-4000-8000-000000000001");

    await database.batch(splitD1MigrationStatements(`
      CREATE TABLE delivery_public_shares(id TEXT PRIMARY KEY,url TEXT NOT NULL,payload BLOB NOT NULL);
      CREATE TABLE delivery_records(id TEXT PRIMARY KEY,payload BLOB NOT NULL);
      INSERT INTO delivery_public_shares VALUES('share','https://public.example.test/s/keep',x'00ff80');
      INSERT INTO delivery_records VALUES('delivery',x'ff0001');
    `).map(statement => database.prepare(statement)));

    const preservedQueries = [
      database.prepare("SELECT * FROM project_alpha_directory_mappings WHERE command_id='upgrade-legacy-command'"),
      database.prepare("SELECT * FROM delivery_public_shares WHERE id='share'"),
      database.prepare("SELECT * FROM delivery_records WHERE id='delivery'"),
      database.prepare("SELECT * FROM operations_directory_delivery_checkpoint WHERE singleton_id=1"),
      database.prepare("SELECT * FROM project_alpha_acquired_canonical_mappings WHERE receipt_id=?").bind(preexistingIds.acquiredReceiptId),
      database.prepare("SELECT * FROM project_alpha_existing_directory_binding_activation_receipts WHERE activation_id='a9000000-0000-4000-8000-000000000001'"),
    ];
    const preserved = (await database.batch<Record<string,unknown>>(preservedQueries)).map(result => result.results);
    const readPreserved = async () => (await database.batch<Record<string,unknown>>([
      database.prepare("SELECT * FROM project_alpha_directory_mappings WHERE command_id='upgrade-legacy-command'"),
      database.prepare("SELECT * FROM delivery_public_shares WHERE id='share'"),
      database.prepare("SELECT * FROM delivery_records WHERE id='delivery'"),
      database.prepare("SELECT * FROM operations_directory_delivery_checkpoint WHERE singleton_id=1"),
      database.prepare("SELECT * FROM project_alpha_acquired_canonical_mappings WHERE receipt_id=?").bind(preexistingIds.acquiredReceiptId),
      database.prepare("SELECT * FROM project_alpha_existing_directory_binding_activation_receipts WHERE activation_id='a9000000-0000-4000-8000-000000000001'"),
    ])).map(result => result.results);

    await database.batch(splitD1MigrationStatements(readFileSync(
      new URL("0127_project_alpha_existing_directory_binding_activation_evidence_transition.sql",directory),"utf8"))
      .map(statement => database.prepare(statement)));
    expect(await readPreserved()).toEqual(preserved);
    const exactTrigger = await database.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger'
      AND name='project_alpha_existing_directory_binding_activation_exact'`).first<string>("sql");
    expect(exactTrigger).toContain("review.reviewed_binding_evidence_sha256<>acquired.binding_status_evidence_sha256");
    expect(exactTrigger).not.toContain("review.reviewed_binding_evidence_sha256=acquired.binding_status_evidence_sha256");

    await database.batch(splitD1MigrationStatements(readFileSync(
      new URL("0128_project_alpha_project_adoption_bind_bridge.sql",directory),"utf8"))
      .map(statement => database.prepare(statement)));
    expect(await readPreserved()).toEqual(preserved);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_adoption_bind_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare(`SELECT count(*) FROM sqlite_master WHERE type='trigger'
      AND name LIKE 'project_alpha_project_adoption_bind_receipts_%'`).first("count(*)")).toBe(8);
    const bridgeColumns = await database.prepare("PRAGMA table_info(project_alpha_project_adoption_bind_receipts)").all<{name:string}>();
    expect(bridgeColumns.results.map(column => column.name)).toEqual([
      "bridge_id","reservation_id","command_id","request_sha256","external_project_id",
      "local_version","local_projection_sha256","created_at",
    ]);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_activation_receipts").first("count(*)")).toBe(1);

    await database.batch(splitD1MigrationStatements(readFileSync(
      new URL("0129_project_alpha_existing_directory_binding_activation_relationship.sql",directory),"utf8"))
      .map(statement => database.prepare(statement)));
    expect(await readPreserved()).toEqual(preserved);

    await database.batch(splitD1MigrationStatements(readFileSync(
      new URL("0130_project_alpha_project_adoption_review_producer.sql",directory),"utf8"))
      .map(statement => database.prepare(statement)));
    expect(await readPreserved()).toEqual(preserved);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_adoption_review_producer_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare(`SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (
      'project_alpha_project_adoption_review_producer_receipts_exact',
      'project_alpha_project_adoption_review_producer_receipts_no_update',
      'project_alpha_project_adoption_review_producer_receipts_no_delete')`).first("count(*)")).toBe(3);

    await database.batch(splitD1MigrationStatements(readFileSync(
      new URL("0131_project_alpha_project_active_directory_mapping_guards.sql",directory),"utf8"))
      .map(statement => database.prepare(statement)));
    expect(await readPreserved()).toEqual(preserved);
    const canonicalGuards = await database.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
      AND name IN ('operations_shared_projects_bound_refresh_guard','operations_shared_projects_no_update',
        'operations_shared_project_revisions_bound_guard') ORDER BY name`).all<{name:string;sql:string}>();
    expect(canonicalGuards.results).toHaveLength(3);
    expect(canonicalGuards.results.every(row => row.sql.includes('project_alpha_active_directory_mappings'))).toBe(true);
    expect(canonicalGuards.results.find(row => row.name === 'operations_shared_project_revisions_bound_guard')!.sql)
      .not.toContain('project_alpha_project_mappings');
    expect(canonicalGuards.results.find(row => row.name === 'operations_shared_projects_no_update')!.sql)
      .toContain('project_alpha_project_mappings');

    await database.batch(splitD1MigrationStatements(readFileSync(
      new URL("0132_operations_directory_acquired_relationship_dependencies.sql",directory),"utf8"))
      .map(statement => database.prepare(statement)));
    expect(await readPreserved()).toEqual(preserved);
    const dependencyColumns = await database.prepare(
      "PRAGMA table_info(operations_directory_intent_relationship_dependencies)").all<{name:string}>();
    expect(dependencyColumns.results.map(column => column.name)).toContain("parent_activation_id");
    const dependencyGuard = await database.prepare(`SELECT sql FROM sqlite_master WHERE type='trigger'
      AND name='operations_directory_intent_relationship_dependencies_insert_guard'`).first<string>("sql");
    expect(dependencyGuard).toContain("evidence_kind='acquired_mapping'");
    expect(dependencyGuard).toContain("project_alpha_active_directory_mappings");
    const resolved = await database.prepare(`SELECT sql FROM sqlite_master WHERE type='view'
      AND name='operations_directory_intent_relationship_resolved'`).first<string>("sql");
    expect(resolved).toContain("parent_activation_id");
    expect(resolved).toContain("mapping_kind='acquired'");
    const schemaObjects = await database.prepare(
      `SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL`,
    ).all<{name:string;sql:string}>();
    expect(schemaObjects.results.filter(object =>
      object.sql.includes("operations_directory_intent_relationship_dependencies_legacy"),
    )).toEqual([]);
    expect(await database.prepare(`SELECT count(*) FROM sqlite_master WHERE type='trigger' AND name IN (
      'operations_directory_write_fences_exhausted',
      'operations_directory_materializations_relationship_guard',
      'operations_directory_materializations_reserve')`).first("count(*)")).toBe(3);

    const standalone: AcquisitionFixture = {
      stem: "b", recordId: standaloneRecordId, kind: "client",
      publicId: "2".repeat(32), requestHash: "4".repeat(64), reviewHash: "4".repeat(64),
      acquisitionHash: "5".repeat(64), profileHash: "6".repeat(64), bindingHash: "7".repeat(64),
    };
    const parented: AcquisitionFixture = {
      stem: "c", recordId: parentedRecordId, kind: "client",
      publicId: "3".repeat(32), requestHash: "8".repeat(64), reviewHash: "8".repeat(64),
      acquisitionHash: "9".repeat(64), profileHash: "a".repeat(64), bindingHash: "b".repeat(64),
    };
    const reused: AcquisitionFixture = {
      stem: "d", recordId: reusedRecordId, kind: "client",
      publicId: "4".repeat(32), requestHash: "c".repeat(64), reviewHash: "c".repeat(64),
      acquisitionHash: "d".repeat(64), profileHash: "e".repeat(64), bindingHash: "c".repeat(64),
    };
    const standaloneIds = await seedAcquisitionFixture(database,standalone);
    await expect(activateFixture(database,standalone,standaloneIds,"b9000000-0000-4000-8000-000000000001"))
      .resolves.toBeDefined();
    const parentedIds = await seedAcquisitionFixture(database,parented);
    await expect(activateFixture(database,parented,parentedIds,"c9000000-0000-4000-8000-000000000001"))
      .resolves.toBeDefined();
    const reusedIds = await seedAcquisitionFixture(database,reused);
    await expect(activateFixture(database,reused,reusedIds,"d9000000-0000-4000-8000-000000000001"))
      .rejects.toThrow(/current exact authority and evidence/);

    expect(await database.prepare("SELECT count(*) FROM project_alpha_existing_directory_binding_activation_receipts").first("count(*)")).toBe(3);
    expect(await database.prepare("SELECT count(*) FROM project_alpha_project_adoption_bind_receipts").first("count(*)")).toBe(0);
    expect(await database.prepare(`SELECT count(*) FROM project_alpha_active_directory_mappings
      WHERE mapping_kind='acquired'`).first("count(*)")).toBe(3);
    expect(await readPreserved()).toEqual(preserved);
  }, 60_000);
});
