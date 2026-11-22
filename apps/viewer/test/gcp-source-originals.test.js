'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { GcpSourceOriginals, MAX_GCP_SOURCE_BYTES, migrateGcpSourceOriginals, sourceText } = require('../server/gcpSourceOriginals');
const { parseGcpInterchange } = require('../server/gcpImport');

function fixture(t, { legacy = false } = {}) {
  const database = new DatabaseSync(':memory:');
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE datasets(id TEXT PRIMARY KEY,project_id TEXT,status TEXT);
    CREATE TABLE gcp_sets(id TEXT PRIMARY KEY,dataset_id TEXT,source_file_id TEXT,
      source_filename TEXT,source_content TEXT,created_by TEXT);
    INSERT INTO datasets VALUES ('dataset-1','project-1','finalized');`);
  if (legacy) database.prepare('INSERT INTO gcp_sets VALUES (?,?,?,?,?,?)')
    .run('legacy-set', 'dataset-1', null, 'old.csv', 'Name,Elevation\r\nA,10\r\n', 'admin-1');
  migrateGcpSourceOriginals(database);
  t.after(() => database.close());
  return { database, originals: new GcpSourceOriginals(database) };
}

const input = (bytes) => ({ datasetId: 'dataset-1', projectId: 'project-1',
  fileName: 'control.csv', bytes, actorId: 'admin-1' });

test('original octets including UTF-8 BOM and CRLF survive deletion of set and dataset', (t) => {
  const { database, originals } = fixture(t);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Name,Elevation\r\nA,10\r\n')]);
  const retained = originals.retain(input(bytes));
  database.prepare('INSERT INTO gcp_sets(id,dataset_id,source_original_id) VALUES (?,?,?)')
    .run('set-1', 'dataset-1', retained.id);
  database.exec("DELETE FROM gcp_sets WHERE id='set-1'; DELETE FROM datasets WHERE id='dataset-1';");
  const recovered = originals.get(retained.id);
  assert.deepEqual(recovered.bytes, bytes);
  assert.equal(recovered.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(recovered.fidelity, 'original_bytes');
  assert.equal(sourceText(recovered.bytes).charCodeAt(0), 0xfeff);
});

test('ordinary SQL updates and deletes cannot remove or replace a retained original', (t) => {
  const { database, originals } = fixture(t), saved = originals.retain(input(Buffer.from('a,b\n1,2\n')));
  assert.throws(() => database.prepare('UPDATE viewer_gcp_source_originals SET content=? WHERE id=?')
    .run(Buffer.from('changed'), saved.id), /immutable/);
  assert.throws(() => database.prepare('DELETE FROM viewer_gcp_source_originals WHERE id=?').run(saved.id), /permanently retained/);
  assert.deepEqual(originals.get(saved.id).bytes, Buffer.from('a,b\n1,2\n'));
});

test('retry deduplicates exact bytes; dataset movement preserves origin without adding access', (t) => {
  const { originals } = fixture(t), bytes = Buffer.from('a,b\r\n1,2\r\n');
  const saved = originals.retain(input(bytes));
  assert.equal(originals.retain(input(bytes)).id, saved.id);
  assert.equal(originals.retain({ ...input(bytes), projectId: 'project-2' }).originProjectId, 'project-1');
  assert.notEqual(originals.retain(input(Buffer.from('a,b\n1,2\n'))).id, saved.id);
  assert.equal(originals.get(saved.id, 'other-dataset'), null);
  assert.equal(Object.hasOwn(originals.describe(saved.id, 'dataset-1'), 'bytes'), false);
});

test('legacy migration retains available text honestly without claiming original file fidelity', (t) => {
  const { database, originals } = fixture(t, { legacy: true });
  const set = database.prepare("SELECT source_original_id FROM gcp_sets WHERE id='legacy-set'").get();
  assert.ok(set.source_original_id);
  const saved = originals.get(set.source_original_id);
  assert.equal(saved.fidelity, 'legacy_utf8_snapshot');
  assert.equal(saved.bytes.toString('utf8'), 'Name,Elevation\r\nA,10\r\n');
  database.exec("DELETE FROM gcp_sets WHERE id='legacy-set'");
  assert.equal(originals.get(saved.id).fidelity, 'legacy_utf8_snapshot');
});

test('checkpoint busy refuses acknowledgment and a later retry retains the same original', (t) => {
  const { database, originals } = fixture(t);
  const proxy = { exec: (sql) => database.exec(sql), prepare: (sql) => sql === 'PRAGMA wal_checkpoint(FULL)'
    ? { get: () => ({ busy: 1 }) } : database.prepare(sql) };
  const blocked = new GcpSourceOriginals(proxy), bytes = Buffer.from('a,b\n1,2\n');
  assert.throws(() => blocked.retain(input(bytes)), (error) => error.code === 'gcp_original_durability_unavailable');
  const rows = originals.list('dataset-1'); assert.equal(rows.length, 1);
  assert.equal(originals.retain(input(bytes)).id, rows[0].id);
});

test('invalid size and encoding cannot be silently re-encoded as an original', (t) => {
  const { originals } = fixture(t);
  assert.throws(() => originals.retain(input(Buffer.alloc(MAX_GCP_SOURCE_BYTES + 1))), /size_invalid/);
  assert.throws(() => sourceText(Buffer.from([0xff, 0xfe])), /encoding_unsupported/);
  const bytes = Buffer.from([0xff, 0xfe, 0x61, 0x00]);
  assert.deepEqual(originals.get(originals.retain(input(bytes)).id).bytes, bytes);
});

test('an empty indexed CSV can be retained without treating it as valid GCP input', (t) => {
  const { originals } = fixture(t), saved = originals.retain(input(Buffer.alloc(0)));
  assert.equal(saved.byteSize, 0); assert.deepEqual(originals.get(saved.id).bytes, Buffer.alloc(0));
});

test('GeoJSON preview can interpret a BOM while its checksum still binds the original octets', () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify({ type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-88.1, 44.5, 250] },
      properties: { point_id: 'A', label: 'A' } }] }))]);
  const parsed = parseGcpInterchange({ format: 'generic-geojson-v1', content: sourceText(bytes) });
  assert.equal(parsed.sourceSha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(parsed.points.length, 1);
});
