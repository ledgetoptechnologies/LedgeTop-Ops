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
import { tagState } from '../scripts/tag-state.mjs';

const smoke = fs.readFileSync(fileURLToPath(new URL('../scripts/smoke-image.sh', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

const workflow = fs.readFileSync(fileURLToPath(new URL('../../../.github/workflows/publish-logs-local.yml', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const jobOf = name => { const at = workflow.indexOf(`\n  ${name}:\n`); assert.ok(at > 0, name); const next = workflow.slice(at + 1).search(/\n  [a-z-]+:\n/); return next < 0 ? workflow.slice(at) : workflow.slice(at, at + 1 + next); };
const RUST = 'rust@sha256:a044f7ab9a762f95be2ee7eb2c49e4d4a4ec60011210de9f7da01d552cae3a55';
const onBlock = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'));

test('main-only push trigger: no manual, pull-request, tag, schedule or other-branch triggers', () => {
  assert.match(onBlock, /\n  push:\n    branches: \[main\]\n/);
  for (const banned of ['workflow_dispatch', 'pull_request', 'pull_request_target', 'tags:', 'schedule', 'workflow_run', 'repository_dispatch', 'release'])
    assert.ok(!onBlock.includes(banned), banned);
  assert.ok(!workflow.includes('workflow_dispatch') && !workflow.includes('pull_request'));
  assert.equal((workflow.match(/if: \$\{\{ github\.ref == 'refs\/heads\/main' && github\.event_name == 'push' \}\}/g) ?? []).length, 3, 'every job is guarded');
});

test('least privilege: read-only by default, packages: write only for the two publishing jobs, one non-secret build arg', () => {
  assert.match(workflow, /\npermissions:\n  contents: read\n\njobs:/);
  assert.equal((workflow.match(/packages: write/g) ?? []).length, 2);
  assert.ok(!jobOf('verify').includes('packages: write'));
  assert.ok(!/secret-files|secrets:/.test(workflow));
  // The only build argument anywhere is the immutable Rust base digest for the full image.
  assert.equal((workflow.match(/build-args:/g) ?? []).length, 1);
  assert.ok(jobOf('publish-full').includes(`build-args: |\n            RUST_IMAGE=${RUST}\n`));
  assert.ok(!jobOf('publish-keyless').includes('build-args'));
  assert.equal((workflow.match(/secrets\./g) ?? []).length, 2, 'only the workflow token, for each registry login');
  assert.ok(workflow.includes('password: ${{ secrets.GITHUB_TOKEN }}'));
  assert.ok(!/visibility/i.test(workflow), 'package visibility is never changed');
  for (const line of workflow.split('\n').filter(l => l.includes('uses: '))) assert.match(line, /@[0-9a-f]{40} # v/, line.trim());
});

test('two independent images, each with an immutable commit tag, exact-digest smoke before its own moving tag; never latest', () => {
  assert.ok(!workflow.includes(':latest'), 'never promoted to latest');
  assert.equal((workflow.match(/imagetools create/g) ?? []).length, 2);
  for (const target of ['keyless', 'full']) {
    const job = jobOf(`publish-${target}`), other = target === 'full' ? 'keyless' : 'full';
    assert.ok(job.includes(`          target: ${target}\n`), target);
    assert.ok(job.includes(`tag=\${image}:sha-\${GITHUB_SHA}-${target}`));
    assert.ok(job.includes(`          TARGET: ${target}\n`), 'the stamp names this target');
    assert.ok(job.includes('Refuse unless the commit tag is proven absent'));
    assert.ok(job.includes('node apps/logs-local/scripts/tag-state.mjs "${code}" inspect-stderr.txt "${TAG}"'));
    assert.ok(job.includes('org.opencontainers.image.revision=${{ github.sha }}'));
    assert.ok(job.includes(`app.ledgetop.logs-local.target=${target}`));
    const smokeAt = job.indexOf('Smoke-test the exact published digest'), receiptAt = job.indexOf('Write the deployment receipt'),
      promote = job.indexOf('Promote the smoke-tested digest'), upload = job.indexOf('Upload the deployment receipt');
    assert.ok(smokeAt > 0 && receiptAt > smokeAt && promote > receiptAt && upload > promote, `${target}: smoke, then receipt, then the moving tag`);
    assert.ok(job.includes(`smoke-image.sh "\${{ steps.names.outputs.image }}@\${{ steps.build.outputs.digest }}" "\${GITHUB_SHA}" ${target}`));
    assert.ok(job.includes(`--tag "\${IMAGE}:${target}" "\${IMAGE}@\${EXPECTED_DIGEST}"`), `${target} promotes only its own tag`);
    assert.ok(!job.includes(`:${other}"`), `${target} never touches the ${other} tag`);
    assert.ok(!job.includes(`target: ${other}`));
  }
  const full = jobOf('publish-full');
  assert.ok(full.includes('parserRevision:"e2e0775670a8391b4f7ecc40fca4cb01ea4a90fa"'), 'the receipt names the parser revision');
  assert.ok(full.includes(`rustImage:"${RUST}"`) && full.includes('parserSha256:$parser'));
  assert.ok(full.includes('PARSER_SHA256: ${{ steps.smoke.outputs.parser_sha256 }}'), 'the parser hash comes from the smoke');
  assert.ok(!full.includes('--entrypoint sha256sum'), 'no extra uncapped container outside the smoke');
  assert.ok(smoke.includes('build-stamp.mjs check "$commit" "$target"'));
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

test('the immutable-tag check proceeds only on a proven not-found; every other failure stops the run', () => {
  const ref = 'ghcr.io/o/logs-local:sha-' + 'a'.repeat(40) + '-keyless';
  assert.equal(tagState(0, '', ref), 'present');
  for (const absent of [`ERROR: ${ref}: not found`, `${ref}: not found`, `ERROR: ${ref}: MANIFEST_UNKNOWN: manifest unknown`])
    assert.equal(tagState(1, absent, ref), 'absent', absent);
  for (const [code, stderr] of [[1, ''], [1, `ERROR: ${ref}: unexpected status from HEAD request: 401 Unauthorized`], [1, 'denied: permission_denied'],
    [1, 'TOOMANYREQUESTS: rate limit'], [1, 'dial tcp: i/o timeout'], [1, 'unexpected status: 503 Service Unavailable'], [1, 'connection reset by peer'],
    [1, 'context deadline exceeded'], [1, `ERROR: ${ref}: not found\n401`], [1, 'MANIFEST_UNKNOWN\n401'], [1, 'MANIFEST_UNKNOWN: manifest unknown'],
    [1, 'ERROR: ghcr.io/o/other:tag: not found'], [1, `ERROR: ${ref}: not found\nsomething else happened`],
    [124, 'MANIFEST_UNKNOWN'], [124, `ERROR: ${ref}: not found`], [127, 'timeout: docker: not found'], [137, ''], [2, `ERROR: ${ref}: not found`]])
    assert.equal(tagState(code, stderr, ref), 'unknown', `${code} ${stderr}`);
  assert.equal(tagState(1, `ERROR: ${ref}: not found`, undefined), 'unknown', 'no reference, no absence');
  assert.match(workflow, /timeout-minutes: 15\n/);
  assert.match(workflow, /timeout-minutes: 45\n/);
});

test('the smoke test is bounded and always cleans up what it owns', () => {
  assert.ok(smoke.includes('set -euo pipefail'));
  assert.ok(smoke.includes('--cpus 1 --memory 1g --memory-swap 1g --pids-limit 256 --network none --read-only --tmpfs /tmp:size=8m'));
  assert.ok(smoke.includes('trap cleanup EXIT\n'));
  assert.ok(smoke.includes("trap 'exit 130' INT") && smoke.includes("trap 'exit 143' TERM"), 'interrupts end the script');
  assert.match(smoke, /docker rm -f "\$name"/);
  assert.match(smoke, /sudo rm -rf -- "\$data"/);
  for (const line of smoke.split('\n').filter(l => /docker (run|pull)/.test(l))) assert.match(line, /^\s*(test "\$\(|[a-z_]+="\$\()?timeout \d+ docker/, line.trim());
  assert.ok(smoke.includes('@sha256:[0-9a-f]{64}$'), 'only an exact digest is smoke-tested');
  assert.match(workflow, /Smoke-test the exact published digest\n        timeout-minutes: 10\n/);
});

test('the smoke proves the parser per target and that a blank key leaves the decoder waiting (synthetic config only)', () => {
  assert.ok(smoke.includes('[[ "$target" == keyless || "$target" == full ]]'));
  assert.ok(smoke.includes('--entrypoint "$parser" "$ref"'));
  assert.ok(smoke.includes('test "$parser_code" = "2"'), 'full: the parser loads and runs (usage exit)');
  assert.ok(smoke.includes('test "$probe_code" = "0"'), 'keyless: the parser is PROVEN absent (a probe error fails)');
  assert.ok(smoke.includes('test "$probe_code" = "3"'), 'full: the parser is proven present before it is run');
  assert.ok(smoke.includes(`process.exit(e.code === 'ENOENT' ? 0 : 5)`), 'only ENOENT counts as absent');
  assert.ok(smoke.includes('--name "${run_id}-hash" "${limits[@]}" --entrypoint sha256sum'), 'the hash run is owned and capped');
  assert.ok(smoke.includes('echo "parser_sha256=${parser_sha}" >> "$GITHUB_OUTPUT"'));
  assert.ok(smoke.includes('DJI_API_KEY=\n'), 'the key stays blank');
  assert.ok(smoke.includes('test "$state" = "waiting_for_key"'));
  assert.ok(smoke.includes('--tmpfs /work:size=64m,mode=0700,uid=568,gid=568'));
  assert.ok(!/DJI_API_KEY=[^\n]+/.test(smoke), 'no key value anywhere');
  for (const name of ['stamp', 'user', 'probe', 'parser', 'hash', 'start', 'run']) assert.ok(smoke.includes(`"\${run_id}-${name}"`), name);
});
