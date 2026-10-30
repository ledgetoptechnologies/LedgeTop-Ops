import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import {
  APPEND_PLAN_SHA256, MANIFEST_SHA256, SOURCE_COMMIT, classifySource38Inventory,
} from './gate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.resolve(here, '../../..');
const manifestBytes = readFileSync(path.join(here, 'reconciliation-manifest.json'));
const appendPlanBytes = readFileSync(path.join(here, 'append-plan.json'));
const manifest = JSON.parse(manifestBytes);
const plan = JSON.parse(appendPlanBytes);
const sourceFilesByApp = new Map();

function pinnedSourceFiles(app) {
  if (sourceFilesByApp.has(app)) return sourceFilesByApp.get(app);
  const db = manifest.databases[app];
  const dir = app === 'operations' ? 'apps/operations/migrations' : 'apps/client/migrations';
  const treeEntries = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD', '--', dir], { cwd: repository });
  const prefix = `${dir}/`;
  const currentByName = new Map();
  for (const entry of treeEntries.toString().split('\0').filter(Boolean)) {
    const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/u.exec(entry);
    assert.ok(match, 'current Git HEAD contains regular migration blobs');
    assert.ok(match[2].startsWith(prefix), 'migration belongs to expected directory');
    currentByName.set(match[2].slice(prefix.length), match[1]);
  }
  assert.deepEqual([...currentByName.keys()].sort(), db.sourceMigrations.map(row => row.name).slice().sort(),
    'current Git HEAD has exactly the pinned profile migration names');
  for (const row of db.sourceMigrations) assert.equal(currentByName.get(row.name), row.gitBlobOid,
    `current Git HEAD blob matches profile for ${row.name}`);
  const response = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repository,
    input: Buffer.from(`${db.sourceMigrations.map(row => currentByName.get(row.name)).join('\n')}\n`),
    maxBuffer: 32 * 1024 * 1024,
  });
  const files = [];
  let offset = 0;
  for (const row of db.sourceMigrations) {
    const headerEnd = response.indexOf(10, offset);
    assert.notEqual(headerEnd, -1, 'pinned Git blob header exists');
    const match = /^([a-f0-9]{40}) blob ([0-9]+)$/u.exec(response.subarray(offset, headerEnd).toString());
    assert.ok(match, 'pinned Git object is a blob');
    assert.equal(match[1], row.gitBlobOid);
    const size = Number(match[2]);
    const bodyStart = headerEnd + 1;
    const bytes = response.subarray(bodyStart, bodyStart + size);
    assert.equal(bytes.length, size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), row.sha256,
      `current Git HEAD blob bytes match profile for ${row.name}`);
    assert.equal(response[bodyStart + size], 10, 'Git blob terminator exists');
    files.push({ name: row.name, bytes });
    offset = bodyStart + size + 1;
  }
  assert.equal(offset, response.length, 'no trailing Git blob output');
  sourceFilesByApp.set(app, files);
  return files;
}

function fixture(app, kind = 'base') {
  const db = manifest.databases[app];
  const sourceFiles = pinnedSourceFiles(app);
  const pending = plan.apps[app].appendInExactSourceOrder;
  const full = [...db.orderedRows, ...pending.map(({ ledgerId, name }) => ({ name, id: ledgerId }))];
  return {
    manifestBytes, appendPlanBytes, sourceCommit: SOURCE_COMMIT, app, databaseId: db.databaseId,
    sourceRows: db.sourceMigrations, sourceFiles, localMigrationNames: db.sourceMigrations.map(row => row.name),
    ledgerRows: kind === 'full' ? full : db.orderedRows,
    statementMeta: { changes: 0, changed_db: false },
  };
}

test('pins exact candidate bytes and classifies both base ledgers as held', () => {
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), MANIFEST_SHA256);
  assert.equal(createHash('sha256').update(appendPlanBytes).digest('hex'), APPEND_PLAN_SHA256);
  for (const app of ['operations', 'client']) {
    const result = classifySource38Inventory(fixture(app));
    assert.equal(result.held, true);
    assert.equal(result.applicationReady, false);
    assert.equal(result.executesDdl, false);
    assert.equal(result.authorizesMigration, false);
    assert.equal(result.authorizesFeatureActivation, false);
    assert.equal(result.classification, 'held-preserved-base-awaiting-reviewed-successor');
  }
});

test('pins candidate JSON and migration source line endings to LF', () => {
  const paths = [
    'scripts/production-auto-migration-profile/source38-inventory-v2/reconciliation-manifest.json',
    'scripts/production-auto-migration-profile/source38-inventory-v2/append-plan.json',
    'scripts/production-auto-migration-profile/source38-inventory-v2/candidate-receipt.json',
    'apps/operations/migrations/0001_operations.sql',
    'apps/client/migrations/0001_initial.sql',
  ];
  const attributes = execFileSync('git', ['check-attr', 'text', 'eol', '--', ...paths], { cwd: repository, encoding: 'utf8' });
  for (const file of paths) {
    assert.ok(attributes.includes(`${file}: text: set`));
    assert.ok(attributes.includes(`${file}: eol: lf`));
  }
});

test('preserves candidate JSON digests in a fresh autocrlf checkout', () => {
  const paths = [
    '.gitattributes',
    'scripts/production-auto-migration-profile/source38-inventory-v2/reconciliation-manifest.json',
    'scripts/production-auto-migration-profile/source38-inventory-v2/append-plan.json',
    'scripts/production-auto-migration-profile/source38-inventory-v2/candidate-receipt.json',
  ];
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'source38-autocrlf-'));
  const tempIndex = path.join(tempRoot, 'index');
  const checkoutRoot = path.join(tempRoot, 'checkout');
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
  try {
    execFileSync('git', ['read-tree', 'HEAD'], { cwd: repository, env });
    execFileSync('git', ['add', '--', paths[0]], { cwd: repository, env });
    execFileSync('git', ['add', '--', ...paths.slice(1)], { cwd: repository, env });
    const prefix = `${checkoutRoot.replaceAll('\\', '/')}/`;
    execFileSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.eol=crlf', 'checkout-index', '--force', `--prefix=${prefix}`, '--', ...paths], { cwd: repository, env });
    for (const relativePath of paths.slice(1)) {
      const expected = createHash('sha256').update(readFileSync(path.join(repository, relativePath))).digest('hex');
      const actual = createHash('sha256').update(readFileSync(path.join(checkoutRoot, relativePath))).digest('hex');
      assert.equal(actual, expected, `${relativePath} digest survives autocrlf checkout`);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(tempRoot)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tempRoot).startsWith('source38-autocrlf-'));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('rejects changed artifact hashes, source commit, source rows, bytes, and local names', () => {
  const input = fixture('client');
  assert.throws(() => classifySource38Inventory({ ...input, manifestBytes: Buffer.from(' ') }), { code: 'inventory_manifest_unpinned' });
  assert.throws(() => classifySource38Inventory({ ...input, appendPlanBytes: Buffer.from(appendPlanBytes).fill(0, 0, 1) }), { code: 'inventory_append_plan_unpinned' });
  assert.throws(() => classifySource38Inventory({ ...input, sourceCommit: '1'.repeat(40) }), { code: 'inventory_source_commit_mismatch' });
  assert.throws(() => classifySource38Inventory({ ...input, sourceRows: input.sourceRows.slice(1) }), { code: 'inventory_current_source_mismatch' });
  const badBytes = input.sourceFiles.map(file => ({ ...file, bytes: Buffer.from(file.bytes) }));
  badBytes[0].bytes[0] ^= 1;
  assert.throws(() => classifySource38Inventory({ ...input, sourceFiles: badBytes }), { code: 'inventory_source_bytes_mismatch' });
  assert.throws(() => classifySource38Inventory({ ...input, localMigrationNames: input.localMigrationNames.slice().reverse() }), { code: 'inventory_current_source_mismatch' });
});

test('rejects unknown partial, reordered, wrong database, and write metadata evidence', () => {
  const input = fixture('operations');
  assert.throws(() => classifySource38Inventory({ ...input, ledgerRows: input.ledgerRows.slice(0, -1) }), { code: 'inventory_unknown_or_partial_ledger' });
  assert.throws(() => classifySource38Inventory({ ...input, ledgerRows: input.ledgerRows.slice().reverse() }), { code: 'inventory_base_ledger_mismatch' });
  assert.throws(() => classifySource38Inventory({ ...input, databaseId: '00000000-0000-0000-0000-000000000000' }), { code: 'inventory_database_target_mismatch' });
  assert.throws(() => classifySource38Inventory({ ...input, statementMeta: { changes: 1 } }), { code: 'inventory_write_metadata_detected' });
  assert.throws(() => classifySource38Inventory({ ...input, statementMeta: { changed_db: true } }), { code: 'inventory_write_metadata_detected' });
  assert.throws(() => classifySource38Inventory({ ...input, statementMeta: {} }), { code: 'inventory_read_metadata_insufficient' });
});

test('uses the reviewed client source count 161 and preserves its historical ledger rows', () => {
  const input = fixture('client');
  const result = classifySource38Inventory(input);
  assert.equal(result.sourceMigrationCount, 161);
  assert.equal(result.ledgerRowCount, 158);
  assert.deepEqual(result.historicalRowsPreserved, [
    { id: 31, name: '0112_thumbnail_renderer_coordination.sql' },
    { id: 32, name: '0113_thumbnail_backfill_controls.sql' },
  ]);
});

test('classifies only the exact fully appended inventory and remains non-authorizing', () => {
  for (const app of ['operations', 'client']) {
    const result = classifySource38Inventory(fixture(app, 'full'));
    assert.equal(result.classification, 'held-complete-source-inventory-awaiting-reviewed-successor');
    assert.equal(result.held, true);
    assert.equal(result.applicationReady, false);
    assert.equal(result.executesDdl, false);
    assert.equal(result.authorizesMigration, false);
    assert.deepEqual(result.appendEnvelope, []);
  }
});

test('takes only supplied evidence and performs no provider mutation', () => {
  let providerCalls = 0;
  const result = classifySource38Inventory({ ...fixture('operations'), provider: new Proxy({}, {
    get() { providerCalls++; throw new Error('provider access forbidden'); },
  }) });
  assert.equal(providerCalls, 0);
  assert.equal(result.executesDdl, false);
  assert.equal(result.applicationReady, false);
});
