import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { currentMainSource, parseProductionOps0226RunArgs, runProductionOps0226 } from './production-ops-staff-login-0226-run.mjs';
import { PRODUCTION_OPS_0226_PRE_READ_QUERY, PRODUCTION_OPS_0226_TARGET } from './production-ops-staff-login-0226-once.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = 'c'.repeat(40);

function setup({ confirm = async () => false } = {}) {
  const calls = { assertTarget: 0, reads: [], compiles: [], executes: [], events: [] };
  const provider = {
    async assertTarget(target) { calls.assertTarget++; assert.deepEqual(target, PRODUCTION_OPS_0226_TARGET); return { databaseId: target.databaseId, name: target.databaseName }; },
    async readSnapshot(options) { calls.reads.push(options); return { observedAt: '2026-11-02T18:00:00.000Z', sentinel: 'synthetic snapshot' }; },
  };
  const plan = { sourceCommit: source, planSha256: 'd'.repeat(64), expiresAt: '2026-11-02T18:05:00.000Z',
    target: PRODUCTION_OPS_0226_TARGET, preflight: { observedAt: '2026-11-02T18:00:00.000Z', ledgerCount: 225,
      ledgerSha256: 'e'.repeat(64), schemaObjectCount: 2449, schemaSha256: 'f'.repeat(64), nativeStaffControlEnabled: 0,
      protectedAuthorityStateSHA256: 'a'.repeat(64) } };
  const receipt = { planSha256: plan.planSha256, migrationSha256: 'b'.repeat(64), target: PRODUCTION_OPS_0226_TARGET,
    before: { ledgerCount: 225, schemaObjectCount: 2449, protectedAuthorityStateSHA256: 'a'.repeat(64) },
    after: { ledgerCount: 226, schemaObjectCount: 2472, protectedAuthorityStateSHA256: 'a'.repeat(64),
      loginObjectsAdded: 23, seededControlRows: 1, aliasRowsAdded: 0 }, mutationCalls: 1 };
  const operator = {
    compile(snapshot, options) { calls.compiles.push({ snapshot, options }); return plan; },
    async executeOnce(options) { calls.executes.push(options); return receipt; },
  };
  return { calls, plan, provider, operator, receipt, confirm, deps: {
    token: 'synthetic-token-long-enough', sourceCommit: source, confirm,
    showPreview(preview) { calls.events.push({ type: 'preview', preview }); },
    providerFactory: () => provider, operatorFactory: () => operator,
  } };
}

function fakeGit({ head = source, remote = source, branch = 'main', changes = '' } = {}) {
  return (_file, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return `${root}\n`;
    if (args[0] === 'branch' && args[1] === '--show-current') return `${branch}\n`;
    if (args[0] === 'status') return `${changes}\n`;
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return `${head}\n`;
    if (args[0] === 'ls-remote' && args[1] === '--exit-code' && args[2] === 'origin' && args[3] === 'refs/heads/main')
      return `${remote}\trefs/heads/main\n`;
    throw new Error('unexpected git command');
  };
}

test('only the read-only check or explicit apply-with-absolute-journal forms are accepted', () => {
  assert.deepEqual(parseProductionOps0226RunArgs(['--check']), { mode: 'check', journalPath: null });
  assert.deepEqual(parseProductionOps0226RunArgs(['--apply', '--journal', path.resolve('audit.jsonl')]),
    { mode: 'apply', journalPath: path.resolve('audit.jsonl') });
  assert.throws(() => parseProductionOps0226RunArgs(['--apply', '--journal', 'relative.jsonl']), /runner_usage/u);
  assert.throws(() => parseProductionOps0226RunArgs(['--apply']), /runner_usage/u);
});

test('apply source must be a clean local main at the current origin main commit', () => {
  assert.equal(currentMainSource(fakeGit()), source);
  assert.throws(() => currentMainSource(fakeGit({ remote: 'e'.repeat(40) })), /runner_main_branch_stale/u);
  assert.throws(() => currentMainSource(fakeGit({ branch: 'codex/stale' })), /runner_main_branch_required/u);
  assert.throws(() => currentMainSource(fakeGit({ changes: ' M source.mjs' })), /runner_working_tree_not_clean/u);
  assert.throws(() => currentMainSource(fakeGit({ remote: 'unavailable' })), /runner_remote_main_ref_unavailable/u);
});

test('check verifies and previews the exact target without mutation or confirmation', async () => {
  const state = setup({ confirm: async () => { throw new Error('confirmation must not run'); } });
  const result = await runProductionOps0226(['--check'], state.deps);
  assert.equal(state.calls.assertTarget, 1);
  assert.deepEqual(state.calls.reads, [{ target: PRODUCTION_OPS_0226_TARGET, phase: 'immediate-prewrite', query: PRODUCTION_OPS_0226_PRE_READ_QUERY }]);
  assert.equal(state.calls.compiles.length, 1);
  assert.equal(state.calls.executes.length, 0);
  assert.equal(result.writesPerformed, 0);
  assert.equal(result.preflight.ledgerCount, 225);
  assert.equal(JSON.stringify(result).includes('synthetic snapshot'), false);
});

test('apply requires an affirmative exact confirmation before one execution', async () => {
  const state = setup({ confirm: async word => { state.calls.events.push({ type: 'confirm', word }); return word === 'APPLY 0226'; } });
  const journalPath = path.resolve('private-audit', 'production-0226.jsonl');
  const result = await runProductionOps0226(['--apply', '--journal', journalPath], state.deps);
  assert.deepEqual(state.calls.events.map(event => event.type), ['preview', 'confirm']);
  assert.equal(state.calls.events[0].preview.preflight.ledgerCount, 225);
  assert.equal(state.calls.events[1].word, 'APPLY 0226');
  assert.equal(state.calls.executes.length, 1);
  assert.equal(state.calls.executes[0].journalPath, journalPath);
  assert.equal(state.calls.executes[0].plan, state.plan);
  assert.equal(result.mode, 'applied');
  assert.equal(result.mutationCalls, 1);
  assert.equal(result.after.seededControlRows, 1);
  assert.equal(result.after.aliasRowsAdded, 0);
});

test('declined confirmation performs no execution', async () => {
  const state = setup({ confirm: async word => { state.calls.events.push({ type: 'confirm', word }); return false; } });
  const result = await runProductionOps0226(['--apply', '--journal', path.resolve('audit.jsonl')], state.deps);
  assert.deepEqual(state.calls.events.map(event => event.type), ['preview', 'confirm']);
  assert.equal(state.calls.executes.length, 0);
  assert.equal(result.mode, 'cancelled');
  assert.equal(result.writesPerformed, 0);
});

test('receipt schema calls the seeded row a control row, not a login binding', () => {
  const operatorSource = fs.readFileSync(new URL('./production-ops-staff-login-0226-once.mjs', import.meta.url), 'utf8');
  assert.match(operatorSource, /seededControlRows: 1/u);
  assert.doesNotMatch(operatorSource, /seededLoginRows/u);
});
