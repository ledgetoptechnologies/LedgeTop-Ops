import assert from "node:assert/strict";
import test from "node:test";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";
import {
  readDirectoryScalarQueuePreflight,
  validateDirectoryScalarQueuePreflightInput,
  validateDirectoryScalarQueueRuntime,
} from "./staging-directory-scalar-queue-preflight.mjs";

const input = Object.freeze({
  mutationId: "00000000-0000-4000-8000-000000000001",
  recordId: "00000000-0000-4000-8000-000000000002",
  expectedLocalVersion: 2,
  sourceId: "project-alpha:staging",
  afterProfile: { email: "updated@example.test", name: "Synthetic" },
});
const runtime = Object.freeze({
  NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED: "true",
  NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED: "false",
  PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED: "false",
  PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED: "false",
});
const commandId = "00000000-0000-4000-8000-000000000003";

function database(overrides = {}) {
  const rows = [
    { now_ms: 1000 },
    { current_version: 3, profile_json: JSON.stringify(input.afterProfile) },
    { matching_count: 1, command_id: commandId },
    { queue_count: 1 },
    { normal_count: 0, recovery_count: 0 },
    { latent_count: 0 },
  ].map((value, index) => overrides[index] ?? value);
  const seen = [];
  return {
    seen,
    prepare(sql) {
      assert.match(sql.trimStart(), /^SELECT\b/);
      const index = seen.length;
      const entry = { sql, params: [] };
      seen.push(entry);
      return {
        bind(...params) {
          entry.params = params;
          return { first: async () => rows[index] };
        },
        first: async () => rows[index],
      };
    },
  };
}

test("accepts one exact due scalar command and performs SELECTs only", async () => {
  const db = database();
  const result = await readDirectoryScalarQueuePreflight(db, STAGING_TARGET, input, runtime);
  assert.equal(result.commandId, commandId);
  assert.equal(result.localVersion, 3);
  assert.equal(result.mutationsPerformed, false);
  assert.equal(db.seen.length, 6);
  assert.deepEqual(db.seen[2].params, [1000, input.mutationId, input.recordId, 3,
    input.sourceId, JSON.stringify(input.afterProfile)]);
  assert.ok(db.seen.every(entry => /^SELECT\b/.test(entry.sql.trimStart())));
});

test("requires exact sealed input, runtime flags, and staging target", async () => {
  assert.throws(() => validateDirectoryScalarQueuePreflightInput({ ...input, extra: true }), /input shape/);
  assert.throws(() => validateDirectoryScalarQueuePreflightInput({ ...input, mutationId: "bad" }), /identity/);
  for (const [name, value] of [
    ["NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED", "false"],
    ["NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED", "true"],
    ["PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED", "true"],
    ["PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED", "true"],
  ]) assert.throws(() => validateDirectoryScalarQueueRuntime({ ...runtime, [name]: value }), /runtime required/);
  await assert.rejects(readDirectoryScalarQueuePreflight(database(), { ...STAGING_TARGET, databaseId: "wrong" }, input, runtime), /exact staging target/);
});

test("rejects current-version and current-profile drift", async () => {
  await assert.rejects(readDirectoryScalarQueuePreflight(database({ 1: { current_version: 2,
    profile_json: JSON.stringify(input.afterProfile) } }), STAGING_TARGET, input, runtime), /post-write plan/);
  await assert.rejects(readDirectoryScalarQueuePreflight(database({ 1: { current_version: 3,
    profile_json: JSON.stringify({ email: "other@example.test", name: "Synthetic" }) } }), STAGING_TARGET, input, runtime), /differs/);
});

test("rejects absent, duplicate, future, leased, or malformed matching command", async () => {
  for (const row of [
    { matching_count: 0, command_id: null },
    { matching_count: 2, command_id: commandId },
    { matching_count: 1, command_id: "not-a-uuid" },
  ]) await assert.rejects(readDirectoryScalarQueuePreflight(database({ 2: row }), STAGING_TARGET, input, runtime), /exactly one due pending/);
  const db = database();
  await readDirectoryScalarQueuePreflight(db, STAGING_TARGET, input, runtime);
  assert.match(db.seen[2].sql, /outbox\.state='pending'/);
  assert.match(db.seen[2].sql, /outbox\.next_attempt_at<=\?/);
});

test("rejects every competing queue and latent-materialization condition", async () => {
  await assert.rejects(readDirectoryScalarQueuePreflight(database({ 3: { queue_count: 2 } }), STAGING_TARGET, input, runtime), /other pending or leased profile/);
  await assert.rejects(readDirectoryScalarQueuePreflight(database({ 4: { normal_count: 1, recovery_count: 0 } }), STAGING_TARGET, input, runtime), /relationship commands/);
  await assert.rejects(readDirectoryScalarQueuePreflight(database({ 4: { normal_count: 0, recovery_count: 1 } }), STAGING_TARGET, input, runtime), /relationship commands/);
  await assert.rejects(readDirectoryScalarQueuePreflight(database({ 5: { latent_count: 1 } }), STAGING_TARGET, input, runtime), /unmaterialized intents/);
  const db = database();
  await readDirectoryScalarQueuePreflight(db, STAGING_TARGET, input, runtime);
  assert.match(db.seen[3].sql, /state IN \('pending','leased'\)/);
  assert.match(db.seen[5].sql, /state IN \('waiting','ready'\)/);
});

test("rejects malformed database readbacks", async () => {
  await assert.rejects(readDirectoryScalarQueuePreflight(database({ 0: { now_ms: "1000" } }), STAGING_TARGET, input, runtime), /clock readback/);
  await assert.rejects(readDirectoryScalarQueuePreflight(database({ 3: { queue_count: -1 } }), STAGING_TARGET, input, runtime), /profile queue readback/);
});
