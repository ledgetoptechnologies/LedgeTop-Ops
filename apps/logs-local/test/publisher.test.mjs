// The image publishing workflow's policy, checked statically (nothing is built or published here), and the build
// stamp the image carries. Temp files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readBuildStamp } from '../src/build-stamp.mjs';

const workflow = fs.readFileSync(fileURLToPath(new URL('../../../.github/workflows/publish-logs-local.yml', import.meta.url)), 'utf8');
const onBlock = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'));

test('main-only push trigger: no manual, pull-request, tag, schedule or other-branch triggers', () => {
  assert.match(onBlock, /\n  push:\n    branches: \[main\]\n/);
  for (const banned of ['workflow_dispatch', 'pull_request', 'pull_request_target', 'tags:', 'schedule', 'workflow_run', 'repository_dispatch', 'release'])
    assert.ok(!onBlock.includes(banned), banned);
  assert.ok(!workflow.includes('workflow_dispatch') && !workflow.includes('pull_request'));
  assert.equal((workflow.match(/if: \$\{\{ github\.ref == 'refs\/heads\/main' && github\.event_name == 'push' \}\}/g) ?? []).length, 2, 'every job is guarded');
});

test('least privilege: read-only by default, packages: write only for the publishing job, no secrets in build args', () => {
  assert.match(workflow, /\npermissions:\n  contents: read\n\njobs:/);
  assert.equal((workflow.match(/packages: write/g) ?? []).length, 1);
  assert.ok(!/build-args|secret-files|secrets:/.test(workflow));
  assert.equal((workflow.match(/secrets\./g) ?? []).length, 1, 'only the workflow token, for the registry login');
  assert.ok(workflow.includes('password: ${{ secrets.GITHUB_TOKEN }}'));
  assert.ok(!/visibility/i.test(workflow), 'package visibility is never changed');
  for (const line of workflow.split('\n').filter(l => l.includes('uses: '))) assert.match(line, /@[0-9a-f]{40} # v/, line.trim());
});

test('keyless only, immutable commit tag, exact-digest smoke before the only moving tag; never latest or full', () => {
  assert.match(workflow, /target: keyless\n/);
  assert.ok(!/target: full|:full|full-/.test(workflow), 'the full target is not built or published');
  assert.ok(!workflow.includes(':latest'), 'never promoted to latest');
  assert.ok(workflow.includes('tag=${image}:sha-${GITHUB_SHA}-keyless'));
  assert.ok(workflow.includes('Refuse to overwrite an existing commit tag'));
  assert.ok(workflow.includes('org.opencontainers.image.revision=${{ github.sha }}'));
  const smoke = workflow.indexOf('Smoke-test the exact published digest'), promote = workflow.indexOf('Promote the smoke-tested digest');
  assert.ok(smoke > 0 && promote > smoke, 'smoke runs before the moving tag');
  assert.ok(workflow.includes('build-stamp.mjs check "${GITHUB_SHA}" keyless'));
  assert.equal((workflow.match(/imagetools create/g) ?? []).length, 1);
  assert.ok(workflow.includes('--tag "${IMAGE}:keyless" "${IMAGE}@${EXPECTED_DIGEST}"'));
});

test('build stamp: absent in a source checkout, exact when written, refused when malformed or overwritten', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-stamp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readBuildStamp(path.join(dir, 'none.json')), null);
  const file = path.join(dir, 'stamp.json');
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 'a'.repeat(40), target: 'keyless', source: 'https://github.com/o/r' }));
  assert.deepEqual(readBuildStamp(file), { schemaVersion: 1, revision: 'a'.repeat(40), target: 'keyless', source: 'https://github.com/o/r' });
  for (const bad of [{ schemaVersion: 1, revision: 'abc', target: 'keyless', source: 's' }, { schemaVersion: 1, revision: 'a'.repeat(40), target: 'latest', source: 's' },
    { schemaVersion: 1, revision: 'a'.repeat(40), target: 'keyless', source: 's', extra: 1 }]) {
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => readBuildStamp(file), /build_stamp_invalid/);
  }
  // The CI writer refuses inexact input and never overwrites (run against a copy of the module tree).
  const stampModule = fileURLToPath(new URL('../src/build-stamp.mjs', import.meta.url));
  const writer = fileURLToPath(new URL('../scripts/write-build-stamp.mjs', import.meta.url));
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(path.join(tree, 'src'), { recursive: true }); fs.mkdirSync(path.join(tree, 'scripts'));
  fs.copyFileSync(stampModule, path.join(tree, 'src', 'build-stamp.mjs')); fs.copyFileSync(writer, path.join(tree, 'scripts', 'write-build-stamp.mjs'));
  const run = env => spawnSync(process.execPath, [path.join(tree, 'scripts', 'write-build-stamp.mjs')], { env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.notEqual(run({ GITHUB_SHA: 'short', TARGET: 'keyless', GITHUB_REPOSITORY: 'o/r' }).status, 0);
  assert.equal(run({ GITHUB_SHA: 'b'.repeat(40), TARGET: 'keyless', GITHUB_REPOSITORY: 'o/r' }).status, 0);
  assert.equal(readBuildStamp(path.join(tree, 'src', 'build-stamp.json')).revision, 'b'.repeat(40));
  assert.notEqual(run({ GITHUB_SHA: 'c'.repeat(40), TARGET: 'keyless', GITHUB_REPOSITORY: 'o/r' }).status, 0, 'never overwritten');
  const check = (commit, target) => spawnSync(process.execPath, [path.join(tree, 'src', 'build-stamp.mjs'), 'check', commit, target], { encoding: 'utf8' }).status;
  assert.equal(check('b'.repeat(40), 'keyless'), 0);
  assert.notEqual(check('b'.repeat(40), 'full'), 0);
  assert.notEqual(check('c'.repeat(40), 'keyless'), 0);
});
