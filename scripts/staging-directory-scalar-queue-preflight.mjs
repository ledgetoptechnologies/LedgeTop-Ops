import { isDeepStrictEqual as same } from "node:util";

import { STAGING_TARGET } from "./staging-onboarding-native-only-authority-packet.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const RUNTIME_KEYS = [
  "NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED",
  "NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED",
  "PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED",
  "PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED",
];

const fail = message => { throw Error(`staging-directory-scalar-queue-preflight: ${message}`); };
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
function exact(value, keys, label) {
  if (!plain(value) || !same(Object.keys(value).sort(), [...keys].sort())) fail(`${label} shape`);
}
function safeJson(value, label) {
  let encoded;
  try { encoded = JSON.stringify(value); } catch { fail(`${label} is not JSON-safe`); }
  if (encoded === undefined || Buffer.byteLength(encoded) > 256 * 1024) fail(`${label} is not bounded JSON`);
  return encoded;
}

export function validateDirectoryScalarQueuePreflightInput(input) {
  exact(input, ["mutationId", "recordId", "expectedLocalVersion", "sourceId", "afterProfile"], "input");
  if (!UUID.test(input.mutationId) || !UUID.test(input.recordId)
    || !Number.isSafeInteger(input.expectedLocalVersion) || input.expectedLocalVersion < 1
    || !SOURCE.test(input.sourceId) || !plain(input.afterProfile)) fail("sealed scalar identity is invalid");
  return Object.freeze({ ...structuredClone(input), afterProfileJson: safeJson(input.afterProfile, "after profile") });
}

export function validateDirectoryScalarQueueRuntime(runtime) {
  exact(runtime, RUNTIME_KEYS, "runtime flags");
  if (runtime.NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED !== "true"
    || runtime.NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED !== "false"
    || runtime.PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED !== "false"
    || runtime.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED !== "false") {
    fail("exact profile-on, drain-off, recovery-off runtime required");
  }
  return Object.freeze({ ...runtime });
}

function validateTarget(target) {
  if (!same(target, STAGING_TARGET)) fail("exact staging target required");
}
function integer(row, key, label) {
  if (!row || !Number.isSafeInteger(row[key]) || row[key] < 0) fail(`invalid ${label} readback`);
  return row[key];
}

/**
 * SELECT-only gate for the deliberately quiet scalar-drain window. The query
 * set is fixed here: callers can bind identities and evidence, never SQL.
 */
export async function readDirectoryScalarQueuePreflight(db, target, rawInput, rawRuntime) {
  if (!db || typeof db.prepare !== "function") fail("D1 binding required");
  validateTarget(target);
  const input = validateDirectoryScalarQueuePreflightInput(rawInput);
  validateDirectoryScalarQueueRuntime(rawRuntime);
  const now = await db.prepare("SELECT CAST(strftime('%s','now') AS INTEGER) * 1000 now_ms").first();
  const nowMs = integer(now, "now_ms", "clock");

  const current = await db.prepare(`SELECT record.current_version,revision.profile_json
    FROM operations_directory_records record
    JOIN operations_directory_revisions revision ON revision.record_id=record.record_id
      AND revision.version=record.current_version
    WHERE record.record_id=? AND record.record_kind='client'`).bind(input.recordId).first();
  if (!current || current.current_version !== input.expectedLocalVersion + 1
    || typeof current.profile_json !== "string") fail("current client version/profile is not the sealed post-write plan");
  let currentProfile;
  try { currentProfile = JSON.parse(current.profile_json); } catch { fail("current client profile is invalid JSON"); }
  if (!same(currentProfile, input.afterProfile)) fail("current client profile differs from the sealed plan");

  const matching = await db.prepare(`SELECT count(*) matching_count,min(outbox.command_id) command_id
    FROM project_alpha_directory_outbox outbox
    JOIN operations_directory_materializations materialization ON materialization.command_id=outbox.command_id
    JOIN operations_directory_intents intent ON intent.intent_id=materialization.intent_id
    WHERE outbox.state='pending' AND outbox.next_attempt_at<=?
      AND intent.mutation_id=? AND intent.record_id=? AND intent.record_version=? AND intent.source_id=?
      AND intent.state='materialized' AND outbox.source_id=intent.source_id
      AND json(intent.desired_payload_json)=json(?)
      AND outbox.resource_type='client' AND json_extract(outbox.command_json,'$.operation')='update'
      AND json_extract(outbox.command_json,'$.resourceType')='client'
      AND json_extract(outbox.command_json,'$.commandId')=outbox.command_id`)
    .bind(nowMs, input.mutationId, input.recordId, input.expectedLocalVersion + 1,
      input.sourceId, input.afterProfileJson).first();
  if (integer(matching, "matching_count", "matching command") !== 1
    || typeof matching.command_id !== "string" || !UUID.test(matching.command_id)) {
    fail("exactly one due pending sealed profile command required");
  }

  const profile = await db.prepare(`SELECT count(*) queue_count
    FROM project_alpha_directory_outbox WHERE state IN ('pending','leased')`).first();
  if (integer(profile, "queue_count", "profile queue") !== 1) {
    fail("other pending or leased profile commands exist");
  }
  const relationships = await db.prepare(`SELECT
      (SELECT count(*) FROM project_alpha_directory_relationship_outbox WHERE state IN ('pending','leased')) normal_count,
      (SELECT count(*) FROM project_alpha_directory_relationship_recovery_outbox WHERE state IN ('pending','leased')) recovery_count`).first();
  if (integer(relationships, "normal_count", "relationship queue") !== 0
    || integer(relationships, "recovery_count", "relationship recovery queue") !== 0) {
    fail("pending or leased relationship commands exist");
  }
  const latent = await db.prepare(`SELECT count(*) latent_count
    FROM operations_directory_intents intent
    WHERE intent.state IN ('waiting','ready')
      AND NOT EXISTS(SELECT 1 FROM operations_directory_materializations materialization
        WHERE materialization.intent_id=intent.intent_id)`).first();
  if (integer(latent, "latent_count", "latent intent") !== 0) {
    fail("waiting or ready unmaterialized intents exist");
  }
  return Object.freeze({
    mode: "read-only-scalar-queue-preflight",
    commandId: matching.command_id,
    recordId: input.recordId,
    mutationId: input.mutationId,
    sourceId: input.sourceId,
    localVersion: current.current_version,
    queue: Object.freeze({ profile: 1, relationship: 0, relationshipRecovery: 0, latentIntents: 0 }),
    mutationsPerformed: false,
  });
}
