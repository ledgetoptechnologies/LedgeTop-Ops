// The REAL command line as a child process: the real entry, the real provider module and the production ids, with a
// fake token. The preload records and refuses every network attempt, so nothing can leave the machine.
// No npm dependencies. This file exists because a top-level await in the entry deadlocked with the provider import
// (exit 13, zero requests) while every test that injected a provider passed.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OPS_0227_0244_FILES, OPS_PRODUCTION_DATABASE } from './production-ops-0227-0244-ordered-once.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = 'scripts/production-ops-0227-0244-ordered-once.mjs';
const PRELOAD = pathToFileURL(path.join(ROOT, 'scripts/production-ops-0227-0244-cli-test-preload.mjs')).href;
const TOKEN = 'synthetic-token-for-offline-tests-only';
const BLOCKED = 'ops_0227_0244_provider:request_uncertain_no_retry';
const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ops-0227-0244-cli-')));
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }));
let counter = 0;
const file = name => path.join(tmp, `${++counter}-${name}`);

const ids = target => ['--account-id', target.accountId, '--database-id', target.databaseId, '--database-name', target.databaseName];
const PRODUCTION = ids(OPS_PRODUCTION_DATABASE);
const REHEARSAL = ids({ accountId: 'a'.repeat(32), databaseId: '00000000-0000-4000-8000-000000000001', databaseName: 'ops-rehearsal-copy' });

function run(args, { root = ROOT, token = TOKEN, extraEnv = {} } = {}) {
  const log = file('network.log');
  fs.writeFileSync(log, '');
  const env = { OPS_TEST_NETWORK_LOG: log, ...(token === null ? {} : { CLOUDFLARE_API_TOKEN: token }), ...extraEnv };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
  const child = spawnSync(process.execPath, ['--import', PRELOAD, path.join(root, TOOL), ...args],
    { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  assert.equal(child.error, undefined);
  const network = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const result = { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr, network };
  // True for every case: the process settled, it did not deadlock, and the token is never printed.
  assert.notEqual(result.status, 13, result.stderr);
  assert.doesNotMatch(result.stderr, /top-level await/u);
  assert.ok(!`${result.stdout}${result.stderr}${JSON.stringify(network)}`.includes(TOKEN));
  return result;
}
const readReceipt = name => {
  const text = fs.readFileSync(name, 'utf8');
  assert.ok(!text.includes(TOKEN));
  return JSON.parse(text);
};
function assertReachedNetwork(result, databaseId) {
  assert.equal(result.status, 1);
  assert.equal(result.stderr, `${BLOCKED}\n`);
  assert.match(result.stdout, /^Ordered plan [a-f0-9]{64} \(prior ledger 226 -> 236\):\n/u);
  // Exactly one attempt: the read-only metadata request, with a token, and no retry.
  assert.deepEqual(result.network, [{ kind: 'fetch', method: 'GET',
    url: `https://api.cloudflare.com/client/v4/accounts/<account>/d1/database/${databaseId}`, auth: true }]);
}
function assertRefusedReceipt(name, mode, code, phase = 'command-line') {
  const receipt = readReceipt(name);
  assert.equal(receipt.status, 'refused');
  assert.equal(receipt.mode, mode);
  assert.deepEqual(receipt.stop, { step: null, phase, code });
  assert.equal(receipt.writesPerformed, 0);
  return receipt;
}

test('dry run on production: the real command reaches the first request and stops there', () => {
  const receipt = file('dry.json');
  const result = run([...PRODUCTION, '--receipt', receipt]);
  assertReachedNetwork(result, OPS_PRODUCTION_DATABASE.databaseId);
  assert.equal(assertRefusedReceipt(receipt, 'dry-run', BLOCKED).target.environment, 'production');
  const explicit = run(['--dry-run', ...PRODUCTION]);
  assertReachedNetwork(explicit, OPS_PRODUCTION_DATABASE.databaseId);
});

test('reconcile on production: the real command reaches the first request and stops there', () => {
  const receipt = file('reconcile.json');
  assertReachedNetwork(run(['--reconcile', ...PRODUCTION, '--receipt', receipt]), OPS_PRODUCTION_DATABASE.databaseId);
  assertRefusedReceipt(receipt, 'reconcile', BLOCKED);
});

test('rehearsal execute: the real command reaches the first request and stops there', () => {
  const receipt = file('rehearsal.json');
  assertReachedNetwork(run(['--execute', '--rehearsal', '--receipt', receipt, ...REHEARSAL]), '00000000-0000-4000-8000-000000000001');
  assertRefusedReceipt(receipt, 'execute', BLOCKED);
});

/** A copy of exactly what the command needs, outside this repository. */
function copyTree(root) {
  const scripts = fs.readdirSync(path.join(ROOT, 'scripts')).filter(name => /^production-ops-(?:0227-0244|staff-login-0226)-.*\.mjs$/u.test(name) && !name.endsWith('.test.mjs'));
  const files = [...scripts.map(name => `scripts/${name}`), 'scripts/fixtures/production-ops-0227-0244-wrangler-wire-statements.json',
    ...OPS_0227_0244_FILES.map(({ name }) => `apps/operations/migrations/${name}`)];
  for (const name of files) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, name), path.join(root, name));
  }
  return root;
}
const executeArgs = receipt => ['--execute', '--receipt', receipt, '--approval-ref', 'approval-synthetic', ...PRODUCTION];

test('production execute: the real source check refuses outside a main checkout, before any request', () => {
  const root = copyTree(file('not-a-repository'));
  const receipt = file('execute.json');
  const result = run(executeArgs(receipt), { root, extraEnv: { GIT_CEILING_DIRECTORIES: tmp } });
  const code = 'ops_0227_0244:source_check_failed:production_ops_0226_runner_git_source_unavailable';
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout.trim().split('\n').at(-1)), { status: 'refused', mode: 'execute',
    stop: { step: null, phase: 'source-check', code }, nextStep: null, finalLedger: null, writesPerformed: 0 });
  assert.deepEqual(result.network, []);
  assertRefusedReceipt(receipt, 'execute', code, 'source-check');
});

let hasGit = true;
try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { hasGit = false; }
test('production execute: with a clean main equal to a local origin, the real command reaches the first request', {
  skip: !hasGit && 'git is not installed' }, () => {
  const origin = file('origin.git'), root = file('main-checkout');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' });
  git(tmp, 'init', '--quiet', '--bare', origin);
  git(tmp, 'init', '--quiet', root);
  git(root, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  git(root, 'config', 'core.autocrlf', 'false');
  copyTree(root);
  git(root, 'add', '--all');
  git(root, 'commit', '--quiet', '-m', 'synthetic');
  git(root, 'remote', 'add', 'origin', origin);
  git(root, 'push', '--quiet', 'origin', 'main');
  const receipt = file('execute-main.json');
  assertReachedNetwork(run(executeArgs(receipt), { root }), OPS_PRODUCTION_DATABASE.databaseId);
  const recorded = assertRefusedReceipt(receipt, 'execute', BLOCKED);
  assert.equal(recorded.approvalRef, 'approval-synthetic');

  // A stale main is still refused by the same real check, before any request.
  git(root, 'commit', '--quiet', '--allow-empty', '-m', 'ahead');
  const stale = file('execute-stale.json');
  assert.deepEqual(run(executeArgs(stale), { root }).network, []);
  assertRefusedReceipt(stale, 'execute', 'ops_0227_0244:source_check_failed:production_ops_0226_runner_main_branch_stale', 'source-check');
});

test('a missing token, a bad argument and an existing receipt stop before any request', () => {
  const receipt = file('no-token.json');
  const missing = run([...PRODUCTION, '--receipt', receipt], { token: null });
  assert.equal(missing.status, 1);
  assert.equal(missing.stderr, 'ops_0227_0244:cloudflare_token_missing\n');
  assert.deepEqual(missing.network, []);
  assertRefusedReceipt(receipt, 'dry-run', 'ops_0227_0244:cloudflare_token_missing');

  const before = fs.readFileSync(receipt);
  const replay = run([...PRODUCTION, '--receipt', receipt]);
  assert.equal(replay.status, 1);
  assert.equal(replay.stderr, 'ops_0227_0244:receipt_exists_no_replay\n');
  assert.deepEqual(replay.network, []);
  assert.ok(fs.readFileSync(receipt).equals(before), 'an existing receipt is never changed');

  const usage = run(['--nope']);
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /^ops_0227_0244:usage\nusage: /u);
  assert.deepEqual(usage.network, []);
});

test('a run that never settles exits 1 and says so; importing the module runs nothing', () => {
  const hung = run(PRODUCTION, { extraEnv: { OPS_TEST_FETCH_HANGS: '1' } });
  assert.equal(hung.status, 1);
  assert.equal(hung.stderr, 'ops_0227_0244:command_line_unsettled\n');
  assert.equal(hung.network.length, 1);

  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(path.join(ROOT, TOOL)).href)})`],
    { encoding: 'utf8', timeout: 60_000 });
  assert.deepEqual([imported.status, imported.stdout, imported.stderr], [0, '', '']);
});
