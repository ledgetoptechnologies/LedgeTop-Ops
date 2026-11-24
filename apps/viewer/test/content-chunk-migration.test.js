'use strict';
// Migration 87 on copies of populated databases at 83, 85 and 86. 86 belongs to
// a change that may merge before or after this one, so it is injected here.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MIGRATIONS, applyMigrations, openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { readSchemaVersion } = require('../server/runtimeIdentity');

const composed = [...MIGRATIONS];
const migration = composed.find(item => item.version === 87);
const purge = composed.find(item => item.version === 86) || { version: 86, name: 'trash_container_purge_started', sql: 'ALTER TABLE storage_trash ADD COLUMN purge_started_at TEXT;' };
const upTo = version => [...composed.filter(item => item.version <= version && item.version !== 86), ...(version >= 86 ? [purge] : [])].sort((a, b) => a.version - b.version);

function withMigrations(list, run) {
  MIGRATIONS.splice(0, MIGRATIONS.length, ...list);
  try { return run(); } finally { MIGRATIONS.splice(0, MIGRATIONS.length, ...composed); }
}

function populated(t, version) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `viewer-content-chunks-${version}-`)), source = path.join(root, 'source.sqlite'), copy = path.join(root, 'copy.sqlite');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = new DatabaseSync(source);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  withMigrations(upTo(version), () => applyMigrations(database));
  assert.equal(readSchemaVersion(database), version);
  const size = 5 * 1048576, digest = 'a'.repeat(64);
  new ViewerRepository(database).upsertModelVersion({ modelId: 'model', versionId: 'version', provider: 'ltds-processing', providerModelId: 'p', providerVersionId: 'v', displayName: 'Synthetic', status: 'ready', makeActive: true,
    assets: [{ kind: 'ortho', rootKey: 'models', relativePath: 'ortho.tif', byteSize: size, sha256: digest, chunks: [{ chunkIndex: 0, byteOffset: 0, byteSize: 4194304, sha256: 'b'.repeat(64) }, { chunkIndex: 1, byteOffset: 4194304, byteSize: 1048576, sha256: 'c'.repeat(64) }] }],
    cameraPhotos: [{ filename: 'A.JPG', rootKey: 'datasets', relativePath: 'A.JPG', contentType: 'image/jpeg', byteSize: size, sha256: 'd'.repeat(64) }] });
  database.prepare('VACUUM INTO ?').run(copy);
  database.close();
  return { source, copy };
}

const schema = database => database.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'content_chunk_%' ORDER BY type,name").all();
function contents(database) {
  return Object.fromEntries(schema(database).filter(row => row.type === 'table' && row.name !== 'schema_migrations')
    .map(({ name }) => [name, JSON.stringify(database.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all())]));
}
const fileDigest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

for (const version of [83, 85, 86]) test(`a populated copy at ${version} upgrades to 87 without changing any existing row or object`, t => {
  const { source, copy } = populated(t, version), original = fileDigest(source);
  let database = new DatabaseSync(copy);
  withMigrations(upTo(86), () => applyMigrations(database));
  const before = { schema: schema(database), contents: contents(database), ledger: database.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all() };
  database.close();

  database = withMigrations(upTo(87), () => openDatabase(copy));
  assert.equal(readSchemaVersion(database), 87);
  assert.deepEqual(schema(database), before.schema);
  assert.deepEqual(contents(database), before.contents);
  assert.deepEqual(database.prepare('SELECT version,name FROM schema_migrations WHERE version<87 ORDER BY version').all(), before.ledger);
  assert.equal(migration.verify(database), true);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM content_chunk_sets').get().n, 0, 'the migration itself hashes nothing');
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  const stamp = database.prepare('SELECT applied_at FROM schema_migrations WHERE version=87').get().applied_at;
  withMigrations(upTo(87), () => applyMigrations(database));
  assert.equal(database.prepare('SELECT applied_at FROM schema_migrations WHERE version=87').get().applied_at, stamp, 'a replay is a no-op');
  database.close();
  assert.equal(fileDigest(source), original, 'only the copy was migrated');
});

test('87 may be recorded before 86 and 86 still applies afterwards', t => {
  const { copy } = populated(t, 85), database = new DatabaseSync(copy);
  withMigrations([...upTo(85), migration], () => applyMigrations(database));
  assert.equal(readSchemaVersion(database), 87);
  withMigrations(upTo(87), () => applyMigrations(database));
  assert.ok(database.prepare('PRAGMA table_info(storage_trash)').all().some(column => column.name === 'purge_started_at'));
  assert.equal(migration.verify(database), true);
  database.close();
});

test('87 refuses a foreign stamp, missing objects and unstamped tables of the same name', t => {
  for (const spoil of [
    database => database.prepare("INSERT INTO schema_migrations VALUES (87,'something_else','now')").run(),
    database => database.prepare("INSERT INTO schema_migrations VALUES (87,'content_chunk_sets','now')").run(),
    database => database.exec('CREATE TABLE content_chunk_failures(x)'),
  ]) {
    const { copy } = populated(t, 85), database = new DatabaseSync(copy);
    withMigrations(upTo(86), () => applyMigrations(database));
    spoil(database);
    const before = database.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all();
    assert.throws(() => withMigrations(upTo(87), () => applyMigrations(database)));
    assert.deepEqual(database.prepare('SELECT name,sql FROM sqlite_master ORDER BY name').all(), before, 'a refused upgrade leaves no half-made table');
    database.close();
  }
});

test('rollback: the previous release opens an upgraded database, and the documented drop is reversible', t => {
  const { copy } = populated(t, 86);
  withMigrations(upTo(87), () => openDatabase(copy)).close();
  const previous = withMigrations(upTo(86), () => openDatabase(copy));
  assert.equal(new ViewerRepository(previous).getModel('model').activeVersion.assets.length, 1);
  const drop = fs.readFileSync(path.join(__dirname, '../docs/CONTENT_CHUNK_BACKFILL.md'), 'utf8').match(/^ {4}(DROP|DELETE) .*;$/gm);
  assert.equal(drop.length, 3);
  previous.exec(drop.join('\n'));
  assert.equal(readSchemaVersion(previous), 86);
  previous.close();
  const again = withMigrations(upTo(87), () => openDatabase(copy));
  assert.equal(migration.verify(again), true);
  again.close();
});
