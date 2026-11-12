import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTION_AUTO_HOLD_CODES, isProductionAutoHoldCode } from './production-auto-hold-codes.mjs';
import { releaseLiteralCodes } from './test-fixtures/release-literal-codes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
function thrownCodes() {
  const codes = new Set();
  const modules = fs.readdirSync(here).sort().filter(name => /^production-auto-.*\.mjs$/u.test(name)
    && !name.endsWith('.test.mjs') && name !== 'production-auto-hold-codes.mjs');
  modules.push('production-auto-migration-profile/installed-schema-preservation-v1/installed-schema-preservation.mjs');
  for (const name of modules) {
    const source = fs.readFileSync(path.join(here, name), 'utf8');
    for (const code of releaseLiteralCodes(source)) codes.add(code);
  }
  return codes;
}

test('literal coverage crosses callback semicolons and ignores comments and quoted code', () => {
  assert.deepEqual([...releaseLiteralCodes(`
    need(rows.every(row => { const value = row.value; return valid(value); }), 'callback_refused');
    fail('nested_refused'); throw Object.assign(new Error('opaque text'), {code:'owned_code'});
    const need = (value, code = 'default_refused') => {};
    // Error('comment_private_name')
    const text = "Error('quoted_private_name')";
  `)].sort(), ['callback_refused','default_refused','nested_refused','owned_code']);
});

test('the reviewed hold-code list matches exactly the literal codes the release modules throw', () => {
  const thrown = thrownCodes(), listed = new Set(PRODUCTION_AUTO_HOLD_CODES);
  assert.deepEqual([...thrown].filter(code => !listed.has(code)), [], 'a release module throws a code missing from the reviewed list');
  assert.deepEqual([...listed].filter(code => !thrown.has(code)), [], 'the reviewed list names a code no release module throws');
  assert.equal(listed.size, PRODUCTION_AUTO_HOLD_CODES.length, 'no duplicates');
  assert.ok(Object.isFrozen(PRODUCTION_AUTO_HOLD_CODES));
});

test('lookup is exact: no prefixes, case variants or non-strings', () => {
  assert.equal(isProductionAutoHoldCode('runtime_predecessor_invalid'), true);
  for (const value of ['runtime_predecessor_invalid ', 'RUNTIME_PREDECESSOR_INVALID', 'runtime_predecessor', 'client_jane_smith', '', null, 42, {}])
    assert.equal(isProductionAutoHoldCode(value), false, String(value));
});

test('every fixed coordinator refusal sentence has exactly one reviewed code', async () => {
  const { PRODUCTION_AUTO_COORDINATOR_REASONS } = await import('./production-auto-hold-codes.mjs');
  const source = fs.readFileSync(path.join(here, 'production-auto-coordinate.mjs'), 'utf8');
  const sentences = new Set([...source.matchAll(/'([A-Z][^']{8,140})'\)/gu)].map(match => match[1])
    .filter(text => !text.startsWith('Automatic release held')));
  assert.deepEqual([...sentences].filter(text => !PRODUCTION_AUTO_COORDINATOR_REASONS.has(text)), [], 'coordinator sentence without a code');
  assert.deepEqual([...PRODUCTION_AUTO_COORDINATOR_REASONS.keys()].filter(text => !sentences.has(text)), [], 'code for a sentence the coordinator no longer throws');
  const codes = [...PRODUCTION_AUTO_COORDINATOR_REASONS.values()];
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.every(code => /^coordinator_[a-z0-9_]+$/u.test(code)));
});
