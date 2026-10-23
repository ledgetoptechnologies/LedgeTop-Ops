import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { buildManifest, buildScript, compareManifests, runPrefixedBuilds } from './ui-release-prefixed-builds.mjs';

const commit = 'a'.repeat(40);

test('builds use release-prefixed bases and the locked Vite, in a fixed order', () => {
  const script = buildScript(commit);
  assert.match(script, /cd apps\/client && WRANGLER_WRITE_LOGS=false node node_modules\/vite\/bin\/vite\.js build --base=\/_ui\/client\/a{40}\/\)/);
  assert.match(script, /cd apps\/operations && WRANGLER_WRITE_LOGS=false node node_modules\/vite\/bin\/vite\.js build --base=\/_ui\/operations\/a{40}\/\)/);
  const steps = [...script.matchAll(/STEP ([a-z-]+)/g)].map(match => match[1]);
  assert.deepEqual(steps, ['install-client', 'install-operations', 'install-sync', 'build-client', 'build-operations', 'complete']);
  assert.ok(script.startsWith('set -eu\n'));
});

test('a release must be named by its full commit', () => {
  for (const bad of ['abc123', 'A'.repeat(40), `${commit}; rm -rf /`, ''])
    assert.throws(() => buildScript(bad), /full lowercase SHA/);
  assert.throws(() => runPrefixedBuilds({ repo: process.cwd(), commit: 'HEAD', output: path.join(os.tmpdir(), 'unused') }), /full lowercase SHA/);
});

test('manifests list every file once with size and digest, sorted by path', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-prefixed-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'assets'));
  fs.writeFileSync(path.join(root, 'index.html'), '<html>');
  fs.writeFileSync(path.join(root, 'assets', 'b.js'), 'b');
  fs.writeFileSync(path.join(root, '.assetsignore'), 'wrangler.json\n');
  assert.deepEqual(buildManifest(root).map(file => [file.path, file.size]),
    [['/.assetsignore', 14], ['/assets/b.js', 1], ['/index.html', 6]]);
  assert.equal(buildManifest(root)[2].sha256, crypto.createHash('sha256').update('<html>').digest('hex'));
});

test('comparison reports missing, resized and changed files', () => {
  const file = (p, sha, size = 1) => ({ path: p, size, sha256: sha.repeat(64) });
  assert.deepEqual(compareManifests([file('/a', '1')], [file('/a', '1')]), []);
  assert.deepEqual(compareManifests([file('/a', '1'), file('/b', '2')], [file('/a', '3'), file('/c', '4', 2)]).map(d => d.path),
    ['/a', '/b', '/c']);
});

test('output must be a new directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-prefixed-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.throws(() => runPrefixedBuilds({ repo: process.cwd(), commit: head, output: root }), /new directory/);
  assert.deepEqual(fs.readdirSync(root), []);
});
