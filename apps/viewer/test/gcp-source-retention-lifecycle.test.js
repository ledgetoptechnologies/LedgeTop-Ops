'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { GcpRepository } = require('../server/gcpRepository');
const { GcpSourceOriginals, sourceText } = require('../server/gcpSourceOriginals');
const { parseGcpInterchange } = require('../server/gcpImport');
const { applyStorageMutation } = require('../server/storageLifecycle');

function fixture(t) {
  const database = openDatabase(':memory:');
  assert.equal(database.prepare('SELECT name FROM schema_migrations WHERE version=46').get().name,
    'viewer_gcp_permanent_source_originals');
  const processing = new ProcessingRepository(database), gcp = new GcpRepository(database);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-gcp-originals-'));
  const rootIdentity = fs.statSync(root, { bigint: true });
  const storage = { removed: 0,
    resolve(key, relative) {
      assert.ok(['datasets', 'trash'].includes(key));
      const base = path.join(root, key), value = path.resolve(base, relative);
      assert.ok(value.startsWith(base + path.sep));
      return value;
    },
    pathExistsStrict(key, relative) { return fs.existsSync(this.resolve(key, relative)); },
    moveExact(a, source, b, destination) {
      const target = this.resolve(b, destination); fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(this.resolve(a, source), target);
    },
    removeExact(key, relative) {
      assert.equal(key, 'trash'); const target = this.resolve(key, relative);
      assert.ok(target.startsWith(path.join(root, 'trash') + path.sep));
      fs.rmSync(target, { recursive: true }); this.removed += 1;
    },
  };
  const project = processing.createProject({ displayName: 'Synthetic GCP retention' });
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('point_id,label,latitude,longitude,elevation_m\r\nA,Target,44.5,-88.1,250\r\n')]);
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Flight',
    storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const file = storage.resolve('datasets', dataset.relativePath + '/control.csv');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  processing.finalizeDataset(dataset.id, [{ id: 'csv-one', relativePath: 'control.csv', byteSize: bytes.length,
    sha256, contentType: 'text/csv' }], sha256);
  t.after(() => {
    database.close();
    const current = fs.statSync(root, { bigint: true });
    assert.equal(current.dev, rootIdentity.dev); assert.equal(current.ino, rootIdentity.ino);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'ltds-gcp-originals-'));
    fs.rmSync(root, { recursive: true });
  });
  return { database, processing, gcp, project, dataset, bytes, file, storage };
}

function setInput(context) {
  const content = sourceText(context.bytes), parsed = parseGcpInterchange({ format: 'generic-csv-v1', content });
  return { datasetId: context.dataset.id, displayName: 'Control', sourceFormat: 'generic-csv-v1',
    sourceFilename: 'control.csv', sourceSha256: parsed.sourceSha256, sourceContent: content,
    sourceBytes: context.bytes, crs: parsed.crs, elevationUnits: parsed.elevationUnits,
    provenance: parsed.provenance, points: parsed.points, createdBy: 'synthetic-admin' };
}

test('set deletion and managed dataset trash/purge retain exact original bytes', t => {
  const c = fixture(t), set = c.gcp.importSet(setInput(c));
  assert.equal(set.sourceOriginal.fidelity, 'original_bytes');
  const originalId = set.sourceOriginal.id;
  assert.equal(c.gcp.deleteSet(set.id), true);
  const trash = applyStorageMutation(c.processing, c.storage, c.processing.beginTrashMutation(c.dataset.id, 'test'));
  const purge = c.processing.beginPurgeMutation(trash.trashId, 'test');
  assert.equal(applyStorageMutation(c.processing, c.storage, purge).status, 'complete');
  assert.equal(c.storage.removed, 1);
  assert.deepEqual(c.gcp.originals.get(originalId).bytes, c.bytes);
});

test('CSV not explicitly imported as a GCP set is archived before dataset deletion', t => {
  const c = fixture(t);
  const trash = applyStorageMutation(c.processing, c.storage, c.processing.beginTrashMutation(c.dataset.id, 'test'));
  applyStorageMutation(c.processing, c.storage, c.processing.beginPurgeMutation(trash.trashId, 'test'));
  const originals = new GcpSourceOriginals(c.database), retained = originals.list(c.dataset.id);
  assert.equal(retained.length, 1); assert.equal(retained[0].fidelity, 'original_bytes');
  assert.deepEqual(originals.get(retained[0].id).bytes, c.bytes);
});

test('legacy moved tree with an intent journal is retained from its trash destination', t => {
  const c=fixture(t),mutation=c.processing.beginTrashMutation(c.dataset.id,'test');
  // Reproduce an older-version crash after rename, before journal advancement
  // and before any original archive existed. Do not fabricate a new operation.
  c.storage.moveExact(mutation.sourceRootKey,mutation.sourceRelativePath,
    mutation.destinationRootKey,mutation.destinationRelativePath);
  assert.equal(c.gcp.originals.list(c.dataset.id).length,0);
  const completed=applyStorageMutation(c.processing,c.storage,mutation);
  assert.equal(completed.status,'complete');
  const retained=c.gcp.originals.list(c.dataset.id);
  assert.equal(retained.length,1);
  assert.deepEqual(c.gcp.originals.get(retained[0].id).bytes,c.bytes);
});

test('failed durability barrier preserves raw trash and leaves purge intent recoverable', t => {
  const c = fixture(t), trash = applyStorageMutation(c.processing, c.storage, c.processing.beginTrashMutation(c.dataset.id, 'test'));
  const purge = c.processing.beginPurgeMutation(trash.trashId, 'test');
  c.processing.database = { exec: sql => c.database.exec(sql), prepare: sql => sql === 'PRAGMA wal_checkpoint(FULL)'
    ? { get: () => ({ busy: 1 }) } : c.database.prepare(sql) };
  assert.throws(() => applyStorageMutation(c.processing, c.storage, purge),
    error => error.code === 'gcp_original_durability_unavailable');
  assert.equal(c.storage.removed, 0);
  assert.equal(c.processing.getStorageMutation(purge.id).status, 'intent');
  assert.ok(c.storage.pathExistsStrict('trash', purge.sourceRelativePath));
  c.processing.database = c.database;
  assert.equal(applyStorageMutation(c.processing, c.storage, purge).status, 'complete');
});

test('changed indexed CSV blocks trash before any filesystem move', t => {
  const c = fixture(t); fs.writeFileSync(c.file, Buffer.from('changed'));
  const mutation = c.processing.beginTrashMutation(c.dataset.id, 'test');
  assert.throws(() => applyStorageMutation(c.processing, c.storage, mutation),
    error => error.code === 'gcp_original_source_changed');
  assert.ok(fs.existsSync(c.file));
  assert.equal(c.processing.getStorageMutation(mutation.id).status, 'intent');
});

test('new text-only imports cannot claim original fidelity', t => {
  const c = fixture(t), input = setInput(c); delete input.sourceBytes;
  assert.throws(() => c.gcp.importSet(input), error => error.code === 'gcp_original_upload_required');
  assert.equal(c.gcp.originals.list(c.dataset.id).length, 0);
  assert.equal(c.gcp.listSets(c.dataset.id).length, 0);
});
