'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const ReferenceProtocol = require('../server/referenceProtocol');
const { MIGRATIONS, openDatabase } = require('../server/database');
const { PreparedSubmissionOutbox, MAX_BODY_BYTES, canonicalEnvelope, canonicalizeJcs } = require('../server/preparedSubmissionOutbox');
const { buildSourceIntakeManifests } = require('../server/sourceIntakeManifestV2');
const {
  MAX_SOURCE_INTAKE_V2_CANONICAL_NODES,
  MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
  MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS,
} = require('../server/sourceIntakeLimitsV2');

const ATTEMPT_ID = '00000000-0000-4000-8000-000000000001';
const TASK_ID = '00000000-0000-4000-8000-000000000002';
const DATASET_ID = '00000000-0000-4000-8000-000000000003';
const PROVIDER_TASK_ID = '00000000-0000-4000-8000-000000000004';
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function makeScaleFixture(count = MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS) {
  const files = Array.from({ length: count }, (_, index) => {
    const id = `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`;
    const name = `photo-${String(index).padStart(5, '0')}-${'x'.repeat(239)}.jpg`;
    return { id, name, relativePath: `raw/${name}`, byteSize: 1, sha256: 'e'.repeat(64),
      processingRole: 'auto', mimeType: 'image/jpeg' };
  });
  const pipelineManifest = {
    id: 'viewer-scale-10k', revision: 1, sha256: '0'.repeat(64), totalBytes: count,
    objectCount: count, inputCounts: { images: count, lidarObjects: 0, points: 0 },
    objects: files.map((file) => ({ id: file.id, name: file.name, byteSize: file.byteSize,
      sha256: file.sha256, kind: 'image', mediaType: 'image/jpeg' })),
  };
  pipelineManifest.sha256 = ReferenceProtocol.manifestSha256(pipelineManifest);
  const dataset = { id: DATASET_ID, manifestSha256: 'a'.repeat(64), status: 'finalized',
    storageMode: 'managed', rootKey: 'datasets', files };
  const attempt = { id: ATTEMPT_ID, taskId: TASK_ID };
  const snapshot = { attemptId: ATTEMPT_ID, datasetId: DATASET_ID, intentSha256: 'f'.repeat(64) };
  const processing = { database: { isTransaction: true, prepare: () => ({ all: () => [], get: () => undefined }) } };
  const manifests = buildSourceIntakeManifests(processing, { dataset, attempt, snapshot, pipelineManifest });
  return { dataset, pipelineManifest, manifests };
}

function applyThroughVersion(database, maxVersion) {
  database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((item) => item.version <= maxVersion)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      migration.after?.(database);
      database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

test('V2 accepts a 10,000-object closure with maximum legal names while V1 stays capped at 4 MiB', () => {
  assert.equal(MAX_BODY_BYTES, 4 * 1024 * 1024);
  assert.equal(MAX_SOURCE_INTAKE_V2_METADATA_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_SOURCE_INTAKE_V2_CANONICAL_NODES, 300_000);
  assert.equal(MAX_SOURCE_INTAKE_V2_MANIFEST_OBJECTS, 10_000);
  assert.throws(() => canonicalizeJcs({ value: 'x'.repeat(MAX_BODY_BYTES) }),
    { code: 'prepared_envelope_too_large' });

  const { dataset, pipelineManifest, manifests } = makeScaleFixture();
  assert.equal(dataset.files[0].name.length, 255);
  assert.ok(Buffer.byteLength(JSON.stringify(pipelineManifest), 'utf8') > 4 * 1024 * 1024);
  assert.throws(() => ReferenceProtocol.validateManifest(pipelineManifest), { code: 'METADATA_LIMIT' });
  assert.equal(ReferenceProtocol.validateManifest(pipelineManifest, {
    maxBytes: MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
  }), pipelineManifest);
  assert.equal(manifests.sourceManifest.objects.length, 10_000);

  const prepared = (manifest) => canonicalEnvelope({
    schemaVersion: 3,
    protocol: 'ltds-viewer-prepared-envelope-jcs-v3',
    viewerTaskId: TASK_ID,
    viewerAttemptId: ATTEMPT_ID,
    activationId: '00000000-0000-4000-8000-000000000007',
    submission: { submissionId: ATTEMPT_ID, manifest },
  });
  assert.throws(() => prepared(pipelineManifest), { code: 'prepared_envelope_too_large' });
  const ordinaryNameManifest = {
    ...pipelineManifest,
    objects: pipelineManifest.objects.map((object, index) => ({ ...object,
      name: `DJI_${String(index).padStart(5, '0')}_20261104_123456.JPG` })),
  };
  ordinaryNameManifest.sha256 = ReferenceProtocol.manifestSha256(ordinaryNameManifest);
  assert.equal(ordinaryNameManifest.objects[0].name.length, 29);
  const ordinaryPrepared = prepared(ordinaryNameManifest);
  assert.ok(ordinaryPrepared.bytes.length < MAX_BODY_BYTES);

  const request = {
    schemaVersion: 2, submissionId: ATTEMPT_ID, viewerTaskId: TASK_ID, providerTaskId: PROVIDER_TASK_ID,
    sourceManifest: manifests.sourceManifest, derivedManifest: manifests.derivedManifest,
    manifest: manifests.pipelineManifest, pipeline: { odm: { requested: true, options: {}, optionsFingerprint: 'b'.repeat(64) },
      treedar: { requested: false, inputObjectIds: [], provenanceReceiptId: null }, gaussian_splat: { requested: false } },
    capabilityFingerprint: 'c'.repeat(64), sourceAttestation: { proof: { attemptId: ATTEMPT_ID, taskId: TASK_ID },
      signature: 's'.repeat(86), attestationSha256: 'd'.repeat(64) },
  };
  const canonical = canonicalizeJcs(request, {
    maxBytes: MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
    maxNodes: MAX_SOURCE_INTAKE_V2_CANONICAL_NODES,
  });
  assert.ok(canonical.length > 4 * 1024 * 1024);
  assert.ok(canonical.length <= MAX_SOURCE_INTAKE_V2_METADATA_BYTES);

  const tooMany = { ...dataset, files: [...dataset.files, { ...dataset.files[0], id: '00000000-0000-4000-8000-999999999999' }] };
  assert.throws(() => buildSourceIntakeManifests({ database: { isTransaction: true, prepare: () => ({ all: () => [], get: () => undefined }) } }, {
    dataset: tooMany,
    attempt: { id: ATTEMPT_ID, taskId: TASK_ID },
    snapshot: { attemptId: ATTEMPT_ID, datasetId: DATASET_ID, intentSha256: 'f'.repeat(64) },
    pipelineManifest,
  }), { code: 'source_intake_manifest_binding_invalid' });
});

test('V2 byte and canonical node limits reject one-over values without relaxing V1', () => {
  const outbox = new PreparedSubmissionOutbox({ prepare() {}, exec() {} });
  assert.throws(() => outbox.persistSourceIntakeRequest(ATTEMPT_ID,
    'x'.repeat(MAX_SOURCE_INTAKE_V2_METADATA_BYTES + 1)), { code: 'source_intake_request_too_large' });
  assert.doesNotThrow(() => canonicalizeJcs(new Array(MAX_SOURCE_INTAKE_V2_CANONICAL_NODES - 1).fill(null), {
    maxBytes: MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
    maxNodes: MAX_SOURCE_INTAKE_V2_CANONICAL_NODES,
  }));
  assert.throws(() => canonicalizeJcs(new Array(MAX_SOURCE_INTAKE_V2_CANONICAL_NODES).fill(null), {
    maxBytes: MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
    maxNodes: MAX_SOURCE_INTAKE_V2_CANONICAL_NODES,
  }), { code: 'prepared_envelope_limit' });
});

test('migration expands only the V2 source request check and preserves existing outbox bytes, hashes and guards', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-v2-metadata-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'viewer.sqlite');
  const old = new DatabaseSync(databasePath);
  old.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  applyThroughVersion(old, 74);
  const sourceCanonical = '{"retained":true,"schemaVersion":2}';
  const sourceDigest = sha(sourceCanonical);
  const envelope = canonicalEnvelope({
    schemaVersion: 3,
    protocol: 'ltds-viewer-prepared-envelope-jcs-v3',
    viewerTaskId: TASK_ID,
    viewerAttemptId: ATTEMPT_ID,
    activationId: '00000000-0000-4000-8000-000000000007',
    submission: { submissionId: ATTEMPT_ID },
  });
  old.prepare(`INSERT INTO viewer_prepared_submission_outbox (
    submission_id,viewer_task_id,viewer_attempt_id,local_job_id,coordinator_origin,authenticated_principal,
    environment,protocol,envelope_canonical,envelope_sha256,state,created_at,updated_at,coordinator_authority_id,
    source_intake_canonical,source_intake_sha256
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?)`).run(
    ATTEMPT_ID, TASK_ID, ATTEMPT_ID, 'local-job', 'https://processing.example', 'viewer-staging', 'staging',
    'ltds-viewer-prepared-envelope-jcs-v3', envelope.text, envelope.sha256, 'prepared',
    '2026-11-05T00:00:00.000Z', '2026-11-05T00:00:00.000Z', '00000000-0000-4000-8000-000000000005',
    sourceCanonical, sourceDigest);
  const before = old.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(ATTEMPT_ID);
  const beforeObjects = old.prepare(`SELECT type,name,sql FROM sqlite_master WHERE tbl_name=?
    AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`).all('viewer_prepared_submission_outbox');
  old.close();

  const upgraded = openDatabase(databasePath);
  const after = upgraded.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(ATTEMPT_ID);
  assert.deepEqual({ ...after }, { ...before });
  const replay = new PreparedSubmissionOutbox(upgraded).getIntent(ATTEMPT_ID);
  assert.equal(replay.envelopeCanonical, envelope.text);
  assert.equal(replay.envelopeSha256, envelope.sha256);
  assert.equal(replay.sourceIntakeCanonical, sourceCanonical);
  assert.equal(replay.sourceIntakeSha256, sourceDigest);
  const afterObjects = upgraded.prepare(`SELECT type,name,sql FROM sqlite_master WHERE tbl_name=?
    AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`).all('viewer_prepared_submission_outbox');
  assert.deepEqual(afterObjects.map((item) => [item.type, item.name]), beforeObjects.map((item) => [item.type, item.name]));
  const tableSql = upgraded.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='viewer_prepared_submission_outbox'").get().sql;
  assert.match(tableSql, /length\(source_intake_canonical\)<=16777216/);
  const largeCanonical = JSON.stringify({ retained: 'x'.repeat(4 * 1024 * 1024) });
  assert.ok(Buffer.byteLength(largeCanonical, 'utf8') > 4 * 1024 * 1024);
  assert.ok(Buffer.byteLength(largeCanonical, 'utf8') <= MAX_SOURCE_INTAKE_V2_METADATA_BYTES);
  upgraded.prepare(`INSERT INTO viewer_prepared_submission_outbox (
    submission_id,viewer_task_id,viewer_attempt_id,local_job_id,coordinator_origin,authenticated_principal,
    environment,protocol,envelope_canonical,envelope_sha256,state,created_at,updated_at,coordinator_authority_id,
    source_intake_canonical,source_intake_sha256
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,?,?,?,?)`).run(
    PROVIDER_TASK_ID, '00000000-0000-4000-8000-000000000006', PROVIDER_TASK_ID, 'local-job-2',
    'https://processing.example', 'viewer-staging', 'staging', 'ltds-viewer-prepared-envelope-jcs-v3',
    '{"large":"envelope"}', 'b'.repeat(64), 'prepared', '2026-11-05T00:00:00.000Z',
    '2026-11-05T00:00:00.000Z', '00000000-0000-4000-8000-000000000005', largeCanonical, sha(largeCanonical));
  assert.throws(() => upgraded.prepare('DELETE FROM viewer_prepared_submission_outbox WHERE submission_id=?').run(ATTEMPT_ID),
    /prepared submission outbox is retained/);
  assert.throws(() => upgraded.prepare('UPDATE viewer_prepared_submission_outbox SET source_intake_canonical=? WHERE submission_id=?')
    .run('{}', ATTEMPT_ID), /prepared source intake request is immutable/);
  assert.equal(upgraded.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  upgraded.close();
});
