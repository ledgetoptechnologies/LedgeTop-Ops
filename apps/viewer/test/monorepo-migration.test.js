'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MIGRATIONS, openDatabase } = require('../server/database');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'source-import.json'), 'utf8'));
const normalize = value => value.replace(/\r\n/g, '\n');

test('relocated Compose changes only the shared API/worker image from the imported release', () => {
  const baselineBytes = fs.readFileSync(path.join(root, manifest.baselineCompose.fixture));
  assert.equal(crypto.createHash('sha256').update(baselineBytes).digest('hex'), manifest.baselineCompose.sha256);
  const baseline = normalize(baselineBytes.toString('utf8'));
  assert.equal(baseline.split(manifest.previousImage).length - 1, 1, 'the upstream services shared one image anchor');
  const compose = normalize(fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8'));
  assert.equal(compose, baseline.replace(manifest.previousImage, manifest.image),
    'service names, health checks, commands, mounts, environment, ports and hardening must remain unchanged');
  assert.match(compose, /viewer-api:[\s\S]*<<: \*runtime/);
  assert.match(compose, /viewer-worker:[\s\S]*<<: \*runtime/);
});

test('the monorepo relocation preserves package identity and container runtime paths', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));
  assert.equal(packageJson.name, manifest.packageName);
  assert.equal(packageJson.engines.node, '>=24.0.0');
  assert.match(runtime, /WORKDIR \/app\b/);
  assert.match(runtime, /USER 568:568/);
  assert.match(runtime, /EXPOSE 8088/);
  assert.match(runtime, /CMD \["node", "server\/index\.js"\]/);
  assert.match(runtime, /COPY server \.\/server/);
  assert.match(runtime, /COPY --from=build \/app\/dist \.\/dist/);
  assert.match(runtime, /ARG VIEWER_SOURCE_COMMIT=unknown/);
  assert.match(runtime, /\/app\/source-commit\.txt/);
  assert.deepEqual(manifest.runtime.workerCommand, ['node', 'server/workerSupervisor.js']);
});

test('the current schema preserves imported catalog data without moving its SQLite file or model asset', t => {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-monorepo-continuity-'));
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }));
  const databasePath = path.join(storage, 'data', 'viewer.sqlite');
  const assetPath = path.join(storage, 'models', 'existing-model.bin');
  fs.mkdirSync(path.dirname(assetPath), { recursive: true });
  const asset = Buffer.from('existing synthetic client model: preserve byte for byte');
  fs.writeFileSync(assetPath, asset);
  let database = openDatabase(databasePath);
  try {
    database.prepare('INSERT INTO app_state (key,value,updated_at) VALUES (?,?,?)')
      .run('monorepo-migration-continuity', JSON.stringify({ asset: 'models/existing-model.bin', marker: 'unchanged' }), '2026-10-21T00:00:00.000Z');
    assert.equal(database.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, MIGRATIONS.at(-1).version);
    assert.equal(manifest.runtime.schemaVersion, 38, "the immutable import manifest records its original schema");
    assert.ok(MIGRATIONS.at(-1).version >= manifest.runtime.schemaVersion);
  } finally { database.close(); }
  const filesBefore = fs.readdirSync(path.dirname(databasePath)).sort();
  database = openDatabase(databasePath);
  try {
    assert.deepEqual(JSON.parse(database.prepare('SELECT value FROM app_state WHERE key=?').get('monorepo-migration-continuity').value),
      { asset: 'models/existing-model.bin', marker: 'unchanged' });
    assert.equal(database.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count, MIGRATIONS.length);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { database.close(); }
  assert.deepEqual(fs.readFileSync(assetPath), asset);
  assert.deepEqual(fs.readdirSync(path.dirname(databasePath)).sort(), filesBefore);
});

test('the import records its upstream identity and leaves unmerged UI work out of the source baseline', () => {
  assert.equal(manifest.upstream.commit, '44208101dff490e88069b9838730cc18ff08c544');
  assert.equal(manifest.upstream.tree, '4f1d12a2a7e805b15e6af2db27fb31b896d55270');
  assert.equal(manifest.destination, 'apps/viewer');
  assert.deepEqual(manifest.outstandingUpstreamPullRequests.map(pr => [pr.number, pr.included]), [[21, false], [10, false]]);
});
