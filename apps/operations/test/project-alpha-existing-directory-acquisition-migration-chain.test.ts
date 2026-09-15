import { readFileSync, readdirSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const runtimes: Miniflare[] = [];
afterAll(async () => { for (const runtime of runtimes) await runtime.dispose(); });

describe("existing PA directory acquisition migration chain", () => {
  it("applies through 0120 without changing populated canonical history or activating acquired mappings", async () => {
    const runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    runtimes.push(runtime);
    const database = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    const migrations = readdirSync(directory)
      .filter(name => /^\d{4}_.+\.sql$/.test(name) && name.slice(0, 4) <= "0120").sort();
    expect(migrations.at(-1)).toBe("0120_project_alpha_project_v2_canonical_settlement.sql");
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
});
