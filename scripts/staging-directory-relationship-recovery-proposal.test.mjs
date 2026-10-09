import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const migrations = path.join(root, "apps/operations/migrations");
const read = filename => fs.readFileSync(filename, "utf8").replace(/\r\n/g, "\n");
const original = read(path.join(migrations, "0172_project_alpha_active_directory_consumer_guards.sql"));
const recovery = read(path.join(migrations, "0181_project_alpha_directory_create_generation_recovery.sql"));
const proposal = read(path.join(root, "scripts/proposals/0182_project_alpha_directory_relationship_recovery_guard.sql"));
const liveStart = "DROP VIEW project_alpha_directory_live_relationship_commands;";
const revisionStart = "DROP VIEW project_alpha_directory_relationship_revision_evidence;";
const revisionComment = "-- The 0181 recovery-aware revision view";

test("local relationship proposal changes exactly one pending source in the live-command view", () => {
  const originalBody = original.slice(original.indexOf(liveStart)).trim();
  const proposalBody = proposal.slice(proposal.indexOf(liveStart), proposal.indexOf(revisionComment)).trim();
  assert.ok(originalBody.startsWith(liveStart));
  assert.equal(originalBody.split("project_alpha_directory_outbox pending").length, 2);
  assert.equal(proposalBody, originalBody.replace(
    "project_alpha_directory_outbox pending", "project_alpha_directory_unsettled_commands pending"));
});

test("revision-evidence proposal changes only the materialized acknowledgement identity predicate", () => {
  const originalBody = recovery.slice(recovery.indexOf(revisionStart)).trim();
  const proposalBody = proposal.slice(proposal.indexOf(revisionStart)).trim();
  const predicate = "  CASE WHEN json_extract(outbox.outcome_json,'$.response.sourceInstanceId')=intent.source_instance_uuid";
  const unchangedTail = "FROM operations_directory_intents intent";
  assert.equal(proposalBody.slice(0, proposalBody.indexOf(predicate)), originalBody.slice(0, originalBody.indexOf(predicate)));
  assert.equal(proposalBody.slice(proposalBody.indexOf(unchangedTail)), originalBody.slice(originalBody.indexOf(unchangedTail)));
  assert.match(proposalBody, /CASE json_extract\(materialization\.command_json,'\$\.operation'\)[\s\S]*WHEN 'create'[\s\S]*WHEN 'update'[\s\S]*ELSE 0 END/);
  assert.match(proposalBody, /materialization\.command_json=outbox\.command_json/);
  assert.match(proposalBody, /expectedProjectAlphaPublicId/);
  assert.match(proposalBody, /project_alpha_active_directory_mappings mapping/);
  assert.match(proposalBody, /requestId'\),15,1\)='4'/);
  assert.match(proposalBody, /requestId'\),20,1\) GLOB '\[89ab\]'/);
  assert.match(proposalBody, /replace\(json_extract\(outbox\.outcome_json,'\$\.response\.requestId'\),'-',''\) NOT GLOB '\*\[\^0-9a-f\]\*'/);
  assert.match(proposalBody, /authorizationGeneration'[\s\S]*9223372036854775807/);
  assert.match(proposalBody, /resource\.revision'[\s\S]*>=\s*json_extract\(materialization\.command_json,'\$\.expectedRevision'\)/);
  assert.doesNotMatch(proposalBody, /expectedRevision'[\s\S]{0,300}CAST\(CAST/);
});

test("complete canonical schema accepts proposal and preserves the existing relationship insert guard", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const names = fs.readdirSync(migrations).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    assert.equal(names.length, 181);
    assert.equal(names.at(-1), "0181_project_alpha_directory_create_generation_recovery.sql");
    for (const name of names) db.exec(read(path.join(migrations, name)));
    const before = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='project_alpha_directory_relationship_outbox_insert_guard'").get();
    assert.ok(before?.sql.includes("project_alpha_directory_live_relationship_commands"));
    db.exec(proposal);
    assert.deepEqual(db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name='project_alpha_directory_relationship_outbox_insert_guard'").get(), before);
    const view = db.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='project_alpha_directory_live_relationship_commands'").get();
    assert.ok(view.sql.includes("project_alpha_directory_unsettled_commands pending"));
    assert.ok(!view.sql.includes("project_alpha_directory_outbox pending"));
    const revisions = db.prepare("SELECT sql FROM sqlite_schema WHERE type='view' AND name='project_alpha_directory_relationship_revision_evidence'").get();
    assert.ok(revisions.sql.includes("WHEN 'create'"));
    assert.ok(revisions.sql.includes("WHEN 'update'"));
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});
