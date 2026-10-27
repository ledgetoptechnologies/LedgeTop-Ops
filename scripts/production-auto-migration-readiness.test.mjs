import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_MIGRATION_QUERY,
  PRODUCTION_MIGRATION_TARGET,
  readProductionMigrationReadiness,
  validateMigrationLedgerRows,
  validateProductionMigrationReadiness,
} from './production-auto-migration-readiness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const ACCOUNT = PRODUCTION_MIGRATION_TARGET.accountId;
const DB_OPS = PRODUCTION_MIGRATION_TARGET.databases[0].databaseId;
const DB_CLIENT = PRODUCTION_MIGRATION_TARGET.databases[1].databaseId;
const TOKEN = 'synthetic-offline-token';
const fixedNow = new Date('2026-10-27T18:00:00.000Z');
const names = (directory) => readdirSync(path.join(ROOT, directory)).filter((name) => name.endsWith('.sql')).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
function rowsFor(list) {
  return list.map((name, index) => ({ name, id: 10 + index * 3 }));
}
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
function makeFetch({ alterRows, identity, providerError, oversized, record } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers['Accept-Encoding'], 'identity');
    assert.equal(init.headers.Authorization, 'Bearer ' + TOKEN);
    assert.equal(init.headers['Content-Type'], 'application/json');
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, 'https://api.cloudflare.com');
    assert.match(parsed.pathname, /^\/client\/v4\/accounts\/[a-f0-9]{32}\/d1\/database\/[0-9a-f-]{36}\/query$/);
    const body = JSON.parse(init.body);
    assert.deepEqual(body, { sql: PRODUCTION_MIGRATION_QUERY, params: [] });
    const databaseId = parsed.pathname.includes(DB_OPS) ? DB_OPS : parsed.pathname.includes(DB_CLIENT) ? DB_CLIENT : null;
    assert.ok(databaseId);
    const directory = databaseId === DB_OPS ? 'apps/operations/migrations' : 'apps/client/migrations';
    let ledgerRows = rowsFor(names(directory));
    if (alterRows) ledgerRows = alterRows(databaseId, ledgerRows);
    if (record) record(databaseId, parsed, init);
    if (oversized) return new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 });
    if (providerError) return jsonResponse({ success: false, errors: [{ code: 1000, message: 'private-provider-text' }], result: [] }, 200);
    const meta = { changes: 0, rows_written: 0 };
    if (identity) meta.database_id = identity(databaseId);
    return jsonResponse({ success: true, errors: [], result: [{ success: true, results: ledgerRows, meta }] });
  };
  return { fetchImpl, calls };
}
function tempRepository(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'auto-migration-readiness-'));
  t.after(() => {
    const resolved = path.resolve(root);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('auto-migration-readiness-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  for (const directory of ['apps/operations/migrations', 'apps/client/migrations']) {
    mkdirSync(path.join(root, directory), { recursive: true });
    for (const name of ['0001_first.sql', '0003_nonconsecutive.sql']) {
      writeFileSync(path.join(root, directory, name), 'CREATE TABLE fixture_' + name.slice(0, 4) + ' (id INTEGER);\n');
    }
  }
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'config', 'core.autocrlf', 'false']);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'offline-test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Offline Test']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'synthetic source inventory']);
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const inventoryNames = {
    [DB_OPS]: namesFrom(root, 'apps/operations/migrations'),
    [DB_CLIENT]: namesFrom(root, 'apps/client/migrations'),
  };
  return { root, commit, inventoryNames };
}
function namesFrom(root, directory) {
  return readdirSync(path.join(root, directory)).filter((name) => name.endsWith('.sql')).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
}
function fetchForRepository(repo, { onQuery, stallFetch = false, stallBody = false } = {}) {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer ' + TOKEN);
    const parsed = new URL(String(url));
    const databaseId = parsed.pathname.includes(DB_OPS) ? DB_OPS : parsed.pathname.includes(DB_CLIENT) ? DB_CLIENT : null;
    assert.ok(databaseId);
    if (onQuery) onQuery(databaseId, calls.length);
    if (stallFetch) return new Promise(() => {});
    if (stallBody) {
      return new Response(new ReadableStream({ pull() { return new Promise(() => {}); } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    const results = repo.inventoryNames[databaseId].map((name, index) => ({ name, id: index * 5 + 2 }));
    return jsonResponse({ success: true, result: [{ success: true, results, meta: { changes: 0 } }] });
  };
  return { fetchImpl, calls };
}
async function readRepository(repo, fetchImpl, extra = {}) {
  return readProductionMigrationReadiness({
    sourceCommit: repo.commit, root: repo.root, token: TOKEN, fetchImpl,
    now: () => fixedNow, monotonicNow: () => 0, ...extra,
  });
}

test('reads both actual source inventories against fixed ordered D1 ledgers', async () => {
  assert.equal(names('apps/operations/migrations').length, 231);
  assert.equal(names('apps/client/migrations').length, 160);
  const fixture = makeFetch();
  const result = await readProductionMigrationReadiness({
    sourceCommit: COMMIT, root: ROOT, token: TOKEN, fetchImpl: fixture.fetchImpl,
    now: () => fixedNow, monotonicNow: () => 0,
  });
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'sourceCommit', 'accountId', 'observedAt', 'databases']);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.accountId, ACCOUNT);
  assert.equal(result.databases[0].databaseId, DB_OPS);
  assert.equal(result.databases[0].migrationCount, 231);
  assert.equal(result.databases[1].databaseId, DB_CLIENT);
  assert.equal(result.databases[1].migrationCount, 160);
  assert.ok(result.databases.every((row) => /^[a-f0-9]{64}$/.test(row.sourceInventorySha256)
    && /^[a-f0-9]{64}$/.test(row.ledgerNamesSha256)));
  assert.equal(fixture.calls.length, 2);
  assert.ok(fixture.calls.every((call) => call.url.startsWith('https://api.cloudflare.com/client/v4/accounts/' + ACCOUNT + '/d1/database/')));
  assert.ok(JSON.stringify(result).includes('sourceInventorySha256'));
  assert.equal(JSON.stringify(result).includes('0001_'), false);
});

test('ledger order follows migration IDs, not filename-number assumptions', () => {
  const expected = ['0001_first.sql', '0003_gap.sql', '0199_a.sql', '0199_z.sql'];
  const rows = expected.map((name, index) => ({ name, id: 4 + index * 7 }));
  assert.match(validateMigrationLedgerRows(expected, rows, { changes: 0 }), /^[a-f0-9]{64}$/);
});

for (const [label, mutate] of [
  ['missing', (rows) => rows.slice(1)],
  ['extra', (rows) => [...rows, { name: '9999_extra.sql', id: 9999 }]],
  ['duplicate', (rows) => [rows[0], { ...rows[1], name: rows[0].name }]],
  ['reordered', (rows) => [rows[1], rows[0]]],
  ['malformed id', (rows) => [{ ...rows[0], id: '1' }, ...rows.slice(1)]],
  ['duplicate id', (rows) => [rows[0], { ...rows[1], id: rows[0].id }]],
]) {
  test('rejects ' + label + ' ordered ledger rows', () => {
    assert.throws(() => validateMigrationLedgerRows(['0001_a.sql', '0003_b.sql'], mutate([
      { name: '0001_a.sql', id: 3 }, { name: '0003_b.sql', id: 8 },
    ]), { changes: 0 }));
  });
}

test('rejects provider write evidence and optional target substitution', async () => {
  assert.throws(() => validateMigrationLedgerRows(['0001_a.sql'], [{ name: '0001_a.sql', id: 1 }], { rows_written: 1 }));
  const fixture = makeFetch({ identity: () => '00000000-0000-4000-8000-000000000000' });
  await assert.rejects(readProductionMigrationReadiness({
    sourceCommit: COMMIT, root: ROOT, token: TOKEN, fetchImpl: fixture.fetchImpl,
    now: () => fixedNow, monotonicNow: () => 0,
  }), (error) => error.code === 'provider_database_identity_mismatch');
});

test('rejects provider errors and oversized/truncated response rows without retry', async () => {
  const failed = makeFetch({ providerError: true });
  await assert.rejects(readProductionMigrationReadiness({
    sourceCommit: COMMIT, root: ROOT, token: TOKEN, fetchImpl: failed.fetchImpl,
    now: () => fixedNow, monotonicNow: () => 0,
  }), (error) => error.code === 'provider_envelope_invalid' && !error.message.includes('private-provider-text'));
  assert.equal(failed.calls.length, 1);

  const large = makeFetch({ oversized: true });
  await assert.rejects(readProductionMigrationReadiness({
    sourceCommit: COMMIT, root: ROOT, token: TOKEN, fetchImpl: large.fetchImpl,
    now: () => fixedNow, monotonicNow: () => 0,
  }), (error) => error.code === 'provider_body_too_large');
  assert.equal(large.calls.length, 1);

  const truncated = makeFetch({ alterRows: (_id, rows) => rows.slice(0, -1) });
  await assert.rejects(readProductionMigrationReadiness({
    sourceCommit: COMMIT, root: ROOT, token: TOKEN, fetchImpl: truncated.fetchImpl,
    now: () => fixedNow, monotonicNow: () => 0,
  }), (error) => error.code === 'migration_ledger_count_mismatch');
  assert.equal(truncated.calls.length, 1);

  const sentinel = makeFetch({ alterRows: (_id, rows) => [...rows, ...Array.from({ length: 1025 - rows.length }, (_, index) => ({ name: 'sentinel_' + index + '.sql', id: 10000 + index }))] });
  await assert.rejects(readProductionMigrationReadiness({
    sourceCommit: COMMIT, root: ROOT, token: TOKEN, fetchImpl: sentinel.fetchImpl,
    now: () => fixedNow, monotonicNow: () => 0,
  }), (error) => error.code === 'migration_ledger_count_mismatch');
  assert.equal(sentinel.calls.length, 1);
});

test('rejects credential controls and monotonic-clock regression before provider access', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; throw new Error('should_not_fetch'); };
  await assert.rejects(readProductionMigrationReadiness({
    sourceCommit: COMMIT, root: ROOT, token: TOKEN + '\n', fetchImpl,
    now: () => fixedNow, monotonicNow: () => 0,
  }), (error) => error.code === 'migration_readiness_input_invalid');
  assert.equal(called, false);
  let ticks = 0;
  await assert.rejects(readProductionMigrationReadiness({
    sourceCommit: COMMIT, root: ROOT, token: TOKEN, fetchImpl,
    now: () => fixedNow, monotonicNow: () => (ticks++ === 0 ? 100 : 99),
  }), (error) => error.code === 'readiness_monotonic_clock_regressed');
  assert.equal(called, false);
});

test('accepts clean CRLF-filtered migration checkout while hashing exact commit blobs', async (t) => {
  const repo = tempRepository(t);
  execFileSync('git', ['-C', repo.root, 'config', 'core.autocrlf', 'true']);
  writeFileSync(path.join(repo.root, '.gitattributes'), '*.sql text\n');
  execFileSync('git', ['-C', repo.root, 'add', '.gitattributes', 'apps/operations/migrations', 'apps/client/migrations']);
  execFileSync('git', ['-C', repo.root, 'commit', '-qm', 'pin SQL line endings']);
  repo.commit = execFileSync('git', ['-C', repo.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  for (const directory of ['apps/operations/migrations', 'apps/client/migrations']) {
    for (const name of readdirSync(path.join(repo.root, directory))) {
      const file = path.join(repo.root, directory, name);
      writeFileSync(file, readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n'));
    }
  }
  const fixture = fetchForRepository(repo);
  const result = await readRepository(repo, fixture.fetchImpl);
  assert.deepEqual(result.databases.map((row) => row.migrationCount), [2, 2]);
  assert.equal(fixture.calls.length, 2);
});

test('rejects assume-unchanged local migration edits by comparing canonical blob ids', async (t) => {
  const repo = tempRepository(t);
  const relative = 'apps/operations/migrations/0001_first.sql';
  execFileSync('git', ['-C', repo.root, 'update-index', '--assume-unchanged', relative]);
  writeFileSync(path.join(repo.root, relative), 'CREATE TABLE hidden_edit (id INTEGER);\n');
  const fixture = fetchForRepository(repo);
  await assert.rejects(readRepository(repo, fixture.fetchImpl), (error) => error.code === 'source_migration_bytes_changed');
  assert.equal(fixture.calls.length, 0);
});

test('rejects dirty and untracked migration inventory before provider access', async (t) => {
  const repo = tempRepository(t);
  writeFileSync(path.join(repo.root, 'apps/client/migrations/0001_first.sql'), 'changed\n');
  const dirty = fetchForRepository(repo);
  await assert.rejects(readRepository(repo, dirty.fetchImpl), (error) => error.code === 'source_migration_bytes_changed');
  assert.equal(dirty.calls.length, 0);
  writeFileSync(path.join(repo.root, 'apps/client/migrations/0001_first.sql'), 'CREATE TABLE fixture_0001 (id INTEGER);\n');
  writeFileSync(path.join(repo.root, 'apps/operations/migrations/0004_untracked.sql'), 'CREATE TABLE untracked (id INTEGER);\n');
  const untracked = fetchForRepository(repo);
  await assert.rejects(readRepository(repo, untracked.fetchImpl), (error) => error.code === 'source_migration_inventory_changed');
  assert.equal(untracked.calls.length, 0);
});

test('rechecks source HEAD and local blob bytes after both fake ledger reads', async (t) => {
  const repo = tempRepository(t);
  const relative = 'apps/operations/migrations/0003_nonconsecutive.sql';
  const fixture = fetchForRepository(repo, { onQuery: (_databaseId, count) => {
    if (count === 1) {
      execFileSync('git', ['-C', repo.root, 'update-index', '--assume-unchanged', relative]);
      writeFileSync(path.join(repo.root, relative), 'CREATE TABLE changed_during_read (id INTEGER);\n');
    }
  } });
  await assert.rejects(readRepository(repo, fixture.fetchImpl), (error) => error.code === 'source_migration_bytes_changed_during_read');
  assert.equal(fixture.calls.length, 2);
});

test('rejects a migration-tree commit created during the fake D1 read', async (t) => {
  const repo = tempRepository(t);
  const fixture = fetchForRepository(repo, { onQuery: (_databaseId, count) => {
    if (count === 1) {
      const file = path.join(repo.root, 'apps/client/migrations/0005_during_read.sql');
      writeFileSync(file, 'CREATE TABLE during_read (id INTEGER);\n');
      execFileSync('git', ['-C', repo.root, 'add', 'apps/client/migrations/0005_during_read.sql']);
      execFileSync('git', ['-C', repo.root, 'commit', '-qm', 'change migration tree during query']);
    }
  } });
  await assert.rejects(readRepository(repo, fixture.fetchImpl), (error) => error.code === 'source_commit_changed_during_read');
  assert.equal(fixture.calls.length, 2);
});

for (const stalled of ['fetch', 'body']) {
  test('bounds stalled ' + stalled + ' with abortable timers', async (t) => {
    const repo = tempRepository(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const fixture = fetchForRepository(repo, { stallFetch: stalled === 'fetch', stallBody: stalled === 'body' });
    const pending = readRepository(repo, fixture.fetchImpl);
    t.mock.timers.tick(10_000);
    await assert.rejects(pending, (error) => error.code === 'request_timeout');
    assert.equal(fixture.calls.length, 1);
  });
}

test('rejects stale, future, source-drifted and target-swapped readiness receipts', () => {
  const value = {
    schemaVersion: 1, sourceCommit: COMMIT, accountId: ACCOUNT,
    observedAt: fixedNow.toISOString(),
    databases: [
      { databaseId: DB_OPS, sourceInventorySha256: 'a'.repeat(64), ledgerNamesSha256: 'b'.repeat(64), migrationCount: 231 },
      { databaseId: DB_CLIENT, sourceInventorySha256: 'c'.repeat(64), ledgerNamesSha256: 'd'.repeat(64), migrationCount: 160 },
    ],
  };
  assert.equal(validateProductionMigrationReadiness(value, { sourceCommit: COMMIT, now: fixedNow.getTime() }).sourceCommit, COMMIT);
  assert.throws(() => validateProductionMigrationReadiness(value, { sourceCommit: COMMIT, now: fixedNow.getTime() + 60_001 }));
  assert.throws(() => validateProductionMigrationReadiness(value, { sourceCommit: COMMIT, now: fixedNow.getTime() - 1 }));
  assert.throws(() => validateProductionMigrationReadiness(value, { sourceCommit: '0'.repeat(40), now: fixedNow.getTime() }));
  const swapped = structuredClone(value);
  [swapped.databases[0], swapped.databases[1]] = [swapped.databases[1], swapped.databases[0]];
  assert.throws(() => validateProductionMigrationReadiness(swapped, { sourceCommit: COMMIT, now: fixedNow.getTime() }));
  const drift = structuredClone(value);
  drift.databases[1].sourceInventorySha256 = 'x'.repeat(64);
  assert.throws(() => validateProductionMigrationReadiness(drift, { sourceCommit: COMMIT, now: fixedNow.getTime() }));
});

