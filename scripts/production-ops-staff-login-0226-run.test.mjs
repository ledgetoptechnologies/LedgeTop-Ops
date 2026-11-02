import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseProductionOps0226RunArgs, runProductionOps0226 } from './production-ops-staff-login-0226-run.mjs';
import { PRODUCTION_OPS_0226_PRE_READ_QUERY, PRODUCTION_OPS_0226_TARGET } from './production-ops-staff-login-0226-once.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = 'c'.repeat(40);

function setup({ confirm = async () => false } = {}) {
  const calls = { assertTarget: 0, reads: [], compiles: [], executes: [] };
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
    providerFactory: () => provider, operatorFactory: () => operator,
  } };
}

test('only the read-only check or explicit apply-with-absolute-journal forms are accepted', () => {
  assert.deepEqual(parseProductionOps0226RunArgs(['--check']), { mode: 'check', journalPath: null });
  assert.deepEqual(parseProductionOps0226RunArgs(['--apply', '--journal', path.resolve('audit.jsonl')]),
    { mode: 'apply', journalPath: path.resolve('audit.jsonl') });
  assert.throws(() => parseProductionOps0226RunArgs(['--apply', '--journal', 'relative.jsonl']), /runner_usage/u);
  assert.throws(() => parseProductionOps0226RunArgs(['--apply']), /runner_usage/u);
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
  const state = setup({ confirm: async word => word === 'APPLY 0226' });
  const journalPath = path.resolve('private-audit', 'production-0226.jsonl');
  const result = await runProductionOps0226(['--apply', '--journal', journalPath], state.deps);
  assert.equal(state.calls.executes.length, 1);
  assert.equal(state.calls.executes[0].journalPath, journalPath);
  assert.equal(state.calls.executes[0].plan, state.plan);
  assert.equal(result.mode, 'applied');
  assert.equal(result.mutationCalls, 1);
  assert.equal(result.after.seededControlRows, 1);
  assert.equal(result.after.aliasRowsAdded, 0);
});

test('declined confirmation performs no execution', async () => {
  const state = setup({ confirm: async () => false });
  const result = await runProductionOps0226(['--apply', '--journal', path.resolve('audit.jsonl')], state.deps);
  assert.equal(state.calls.executes.length, 0);
  assert.equal(result.mode, 'cancelled');
  assert.equal(result.writesPerformed, 0);
});

test('receipt schema calls the seeded row a control row, not a login binding', () => {
  const operatorSource = fs.readFileSync(new URL('./production-ops-staff-login-0226-once.mjs', import.meta.url), 'utf8');
  assert.match(operatorSource, /seededControlRows: 1/u);
  assert.doesNotMatch(operatorSource, /seededLoginRows/u);
});
