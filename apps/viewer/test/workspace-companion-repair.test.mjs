import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../workspace-projects.js', import.meta.url), 'utf8');
const start = source.indexOf('async function createCompanionRepair(');
const end = source.indexOf('async function refreshOperations(', start);
assert.ok(start >= 0 && end > start);

function fixture({ write = true, operations = [], reject = false } = {}) {
  const calls = [];
  const control = { disabled: false, textContent: 'Restore missing products' };
  const state = { busy: false, operations, projects: [] };
  const context = vm.createContext({
    state, content: { querySelector: () => control },
    shell: { setAttribute() {}, removeAttribute() {} },
    CSS: { escape: value => value }, crypto: { randomUUID: () => 'test-request' },
    can: permission => write && permission === 'viewer.processing.write',
    esc: value => String(value).replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    button: (...args) => JSON.stringify(args),
    toast: (...args) => calls.push(['toast', ...args]),
    rememberOperation: operation => calls.push(['remember', operation]),
    scheduleOperationRefresh: delay => calls.push(['refresh', delay]),
    api: async (...args) => {
      calls.push(['api', ...args]);
      if (reject) throw new Error('source integrity failed');
      return { operation: { id: 'repair', type: 'lod_recovery', companionRepair: true, status: 'queued' } };
    },
  });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext(source.slice(source.indexOf('function operationTitle('), source.indexOf('function operationProgress(')), context);
  return { context, calls, state, control };
}

const output = {
  id: 'version',
  companionRepairAction: {
    kind: 'new_version', eligible: true, missingAssetKinds: ['ortho', 'ept'],
    endpoint: '/api/v1/processing/outputs/version/companion-repair-attempts',
  },
};

test('product restore is explicit, permission-gated, and version-bound', async () => {
  const f = fixture();
  assert.match(f.context.companionRepairAction(output), /Restore missing products/);
  assert.equal(f.calls.length, 0, 'rendering a repair action must not enqueue work');
  assert.equal(fixture({ write: false }).context.companionRepairAction(output), '');
  await f.context.createCompanionRepair(output.id, '/api/v1/processing/outputs/other/companion-repair-attempts');
  assert.equal(f.calls.some(call => call[0] === 'api'), false);
  await f.context.createCompanionRepair(output.id, output.companionRepairAction.endpoint);
  const request = f.calls.find(call => call[0] === 'api');
  assert.equal(request[1], output.companionRepairAction.endpoint);
  assert.equal(request[2].method, 'POST');
  assert.equal(request[2].headers['Idempotency-Key'], 'test-request');
  assert.equal(Object.keys(request[2].body).length, 0, 'no client-supplied paths or hashes');
  assert.equal(f.state.busy, false);
  assert.equal(f.control.textContent, 'Product restore queued');
  assert.equal(f.calls.filter(call => call[0] === 'api').length, 1, 'never publish or import automatically');
});

for (const representation of [{ type: 'lod_recovery', companionRepair: true }, { type: 'companion_repair' }]) {
test(`product restore recognizes ${representation.type} and retries the existing operation`, () => {
  const f = fixture({ operations: [{ id: 'repair', sourceOutputId: 'version', ...representation, status: 'failed' }] });
  const action = JSON.parse(f.context.companionRepairAction(output));
  assert.deepEqual(action.slice(0, 3), ['retry-operation', 'repair', 'Retry product restore']);
  f.state.operations[0].retryable = false;
  assert.match(f.context.companionRepairAction(output), /Product restore failed/);
  assert.doesNotMatch(f.context.companionRepairAction(output), /restore-products/);
  f.state.operations[0].status = 'queued';
  assert.match(f.context.companionRepairAction(output), /Restoring products/);
  assert.equal(f.context.operationTitle(f.state.operations[0]), 'Restore missing products');
});
}

test('normal LOD recovery is not mistaken for a companion restore', () => {
  for (const companionRepair of [false, undefined, 'true']) {
    const f = fixture({ operations: [{ id: 'repair', sourceOutputId: 'version', type: 'lod_recovery', companionRepair, status: 'failed' }] });
    assert.match(f.context.companionRepairAction(output), /Restore missing products/);
    assert.doesNotMatch(f.context.companionRepairAction(output), /retry-operation/);
    assert.equal(f.context.operationTitle(f.state.operations[0]), '3D tile recovery version');
  }
});

test('product restore releases busy state after a rejected source verification', async () => {
  const f = fixture({ reject: true });
  await f.context.createCompanionRepair(output.id, output.companionRepairAction.endpoint);
  assert.equal(f.state.busy, false);
  assert.equal(f.control.disabled, false);
  assert.equal(f.control.textContent, 'Restore missing products');
  assert.ok(f.calls.some(call => call[0] === 'toast' && call[1] === 'source integrity failed' && call[2] === true));
  assert.equal(f.calls.some(call => call[0] === 'remember'), false);
});

test('workspace dispatch and background retry permissions include product repairs', () => {
  assert.match(source, /if\(action==='restore-products'\)return createCompanionRepair\(id,element\.dataset\.endpoint\)/);
  assert.match(source, /const repair=companionRepairAction\(output\);if\(repair\)return repair/);
  assert.match(source, /recovery=\['lod_recovery','companion_repair'\]\.includes\(operation\.type\),canRetry=/);
});
