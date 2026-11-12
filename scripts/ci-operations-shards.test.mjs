// Binds the automatic release's required CI job names to the actual ci.yml packages matrix, and proves the
// Operations shards still cover the whole suite once (typecheck, pre-suite checks and build run exactly once).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_MAIN_JOBS } from './production-auto-ci.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ci = fs.readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8').replace(/\r\n/gu, '\n');
const block = (() => {
  const start = ci.indexOf('\n  packages:\n');
  assert.ok(start > 0, 'packages job exists');
  const rest = ci.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/u);
  return next < 0 ? rest : rest.slice(0, next + 1);
})();
const entries = [...block.matchAll(/^ {10}- \{ package: ([a-z0-9-]+), shard: (\d+) \}$/gmu)].map(m => ({ pkg: m[1], shard: Number(m[2]) }));
const step = name => {
  const at = block.indexOf(`      - name: ${name}\n`);
  assert.ok(at >= 0, `step ${name}`);
  const next = block.indexOf('\n      - name: ', at + 1);
  return block.slice(at, next < 0 ? undefined : next);
};
// GitHub's job name expression: matrix.shard && format('{0}-{1}', package, shard) || package.
const jobName = ({ pkg, shard }) => (shard ? `${pkg}-${shard}` : pkg);

test('the packages matrix produces exactly the package-family names the release requires', () => {
  assert.match(block, /^ {4}name: \$\{\{ matrix\.shard && format\('\{0\}-\{1\}', matrix\.package, matrix\.shard\) \|\| matrix\.package \}\}$/mu);
  const names = entries.map(jobName).sort();
  assert.deepEqual(names, ['client', 'operations-1', 'operations-2', 'operations-3', 'operations-4', 'ops-sync', 'thumbnail-renderer']);
  for (const name of names) assert.ok(REQUIRED_MAIN_JOBS.includes(name), `${name} is required for release`);
  assert.ok(!REQUIRED_MAIN_JOBS.includes('operations'), 'no stale unsharded name that CI never produces');
  assert.equal(REQUIRED_MAIN_JOBS.length, 13);
  assert.equal(new Set(REQUIRED_MAIN_JOBS).size, 13);
});

test('the Operations shards are 1..N of N and every other package runs its full suite unsharded', () => {
  const shards = entries.filter(e => e.pkg === 'operations').map(e => e.shard).sort((a, b) => a - b);
  assert.deepEqual(shards, [1, 2, 3, 4]);
  assert.ok(entries.filter(e => e.pkg !== 'operations').every(e => e.shard === 0));
  const testStep = step('Test');
  assert.match(testStep, /run: npm test\$\{\{ matrix\.shard > 0 && format\(' -- --shard=\{0\}\/4', matrix\.shard\) \|\| '' \}\}/u);
  assert.equal(Number(/--shard=\{0\}\/(\d+)/u.exec(testStep)[1]), shards.length, 'the shard denominator equals the number of shards');
});

test('typecheck, the Operations pre-suite checks and the build run exactly once per package', () => {
  assert.match(step('Typecheck'), /if: matrix\.shard <= 1\n/u);
  assert.match(step('Check reviewed migration inventory before the full Operations suite'), /if: matrix\.package == 'operations' && matrix\.shard == 1\n/u);
  assert.match(step('Check Operations origin and Viewer routes before the full suite'), /if: matrix\.package == 'operations' && matrix\.shard == 1\n/u);
  assert.match(step('Build deployable application'), /if: matrix\.package != 'thumbnail-renderer' && matrix\.shard <= 1\n/u);
  // Exactly one entry per package satisfies shard <= 1.
  for (const pkg of new Set(entries.map(e => e.pkg))) assert.equal(entries.filter(e => e.pkg === pkg && e.shard <= 1).length, 1, pkg);
});
