// The hand-run promotion of a verified full candidate to `latest`, checked statically (nothing is published here).
// The registry-absence guard is executed with bash on synthetic error text. Temp files only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workflows = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));
const read = name => fs.readFileSync(path.join(workflows, name), 'utf8').replace(/\r\n/g, '\n');
const promote = read('promote-logs-local.yml');
const code = promote.replace(/^\s*#.*$/gm, '');
const stepAt = name => { const at = promote.indexOf(`- name: ${name}`); assert.ok(at > 0, name); return at; };
const stepOf = name => { const at = stepAt(name); const next = promote.indexOf('\n      - name: ', at + 1); return promote.slice(at, next < 0 ? undefined : next); };

test('manual and main-only, one promotion at a time, least privilege', () => {
  const on = promote.slice(promote.indexOf('\non:'), promote.indexOf('\npermissions:'));
  assert.match(on, /\n  workflow_dispatch:\n/);
  for (const banned of ['push:', 'pull_request', 'schedule', 'workflow_run', 'repository_dispatch']) assert.ok(!on.includes(banned), banned);
  assert.match(promote, /\n    if: \$\{\{ github\.ref == 'refs\/heads\/main' \}\}\n/);
  assert.match(promote, /\nconcurrency:\n  group: promote-logs-local-latest\n  cancel-in-progress: false\n/);
  assert.match(promote, /\npermissions:\n  contents: read\n\nconcurrency:/);
  assert.equal((promote.match(/packages: write/g) ?? []).length, 1);
  for (const line of promote.split('\n').filter(l => l.includes('uses: '))) assert.match(line, /@[0-9a-f]{40} # v/, line.trim());
});

test('inputs: exact commit and digest, approver record, and an opt-in first-time initialize that defaults off', () => {
  for (const input of ['commit', 'digest', 'approved_by', 'approval_reference'])
    assert.match(promote, new RegExp(`\\n      ${input}:\\n        description: [^\\n]+\\n        required: true\\n`), input);
  assert.match(promote, /\n      initialize_latest:\n[^]*?required: false\n        default: false\n        type: boolean\n/);
  const validate = stepOf('Validate requested candidate');
  assert.ok(validate.includes('^[0-9a-f]{40}$') && validate.includes('^sha256:[0-9a-f]{64}$'));
  assert.ok(validate.includes('approved_by is required') && validate.includes('approval_reference is required'));
  assert.ok(promote.includes('"approvedBy": "%s"') && promote.includes('"approvalReference": "%s"') && promote.includes('"approvalEnforced": false'));
});

test('only a verified FULL candidate of this repository main is promotable', () => {
  assert.ok(stepOf('Require the commit to be on main').includes('compare/$PROMOTE_COMMIT...$GITHUB_SHA'));
  const run = stepOf('Find the successful main publish run for the commit');
  assert.ok(run.includes('actions/workflows/publish-logs-local.yml/runs'));
  assert.ok(run.includes('.path == \\".github/workflows/publish-logs-local.yml\\"') && run.includes('.conclusion == \\"success\\"'));
  const receipt = stepOf("Verify the candidate's deployment receipt");
  assert.ok(receipt.includes('--name "logs-local-full-$PROMOTE_COMMIT"'));
  assert.ok(receipt.includes('.target == "full"') && receipt.includes('.digest == $digest') && receipt.includes('.commit == $commit'));
  const registry = stepOf('Verify the registry still holds the exact candidate');
  assert.ok(registry.includes('"$IMAGE_NAME:sha-$PROMOTE_COMMIT-full"'));
  assert.ok(registry.includes('"app.ledgetop.logs-local.target" }}\' "$VERIFY_IMAGE")" = full'));
  assert.ok(registry.includes('= "568:568"') && registry.includes('org.opencontainers.image.revision'));
  assert.ok(!code.includes('keyless'), 'keyless is never referenced as a promotion source');
});

test('fail closed: read latest, persist the rollback receipt, re-read, and only then write; read back after', () => {
  const read = stepAt('Read current latest and resolve the rollback target'), persist = stepAt('Persist the rollback receipt before moving latest'),
    upload = stepAt('Upload the rollback receipt'), move = stepAt('Move latest to the verified digest');
  assert.ok(read < persist && persist < upload && upload < move, 'receipt is recorded and uploaded before any mutation');
  assert.ok(!/continue-on-error/.test(promote));
  const writes = [...code.matchAll(/^(?!\s*echo ).*imagetools create[^\n]*/gm)].map(m => m[0].trim());
  assert.deepEqual(writes, ['docker buildx imagetools create --tag "$IMAGE_NAME:latest" "$IMAGE_NAME@$PROMOTE_DIGEST" || {'], 'exactly one registry write');
  const moveStep = stepOf('Move latest to the verified digest');
  const reread = moveStep.indexOf('if [[ "$CURRENT" != "$PREVIOUS_DIGEST" ]]'), write = moveStep.indexOf('docker buildx imagetools create --tag "$IMAGE_NAME:latest" "$IMAGE_NAME@$PROMOTE_DIGEST"');
  assert.ok(reread > 0 && write > reread, 'the re-read guard precedes the write');
  assert.ok(moveStep.indexOf('PROMOTED_DIGEST') > write, 'read back after the write');
  const previous = stepOf('Read current latest and resolve the rollback target');
  assert.ok(previous.includes('Use initialize_latest only for a first-time setup'));
  assert.ok(previous.includes('initialize_latest was requested but latest already exists'));
});

test('no other workflow writes the logs-local latest tag', () => {
  for (const name of fs.readdirSync(workflows).filter(n => /\.ya?ml$/.test(n))) {
    const text = read(name).replace(/^\s*#.*$/gm, '');
    if (name === 'promote-logs-local.yml' || !text.includes('logs-local')) continue;
    assert.ok(!/:latest\b/.test(text), `${name} must not touch a logs-local latest tag`);
  }
});

test('absence is accepted only from one unambiguous MANIFEST_UNKNOWN line naming the reference', t => {
  const body = promote.slice(promote.indexOf('manifest_unknown_only() {'), promote.indexOf('\n          }\n', promote.indexOf('manifest_unknown_only() {')) + 12);
  const probe = spawnSync('bash', ['-c', 'exit 0']);
  if (probe.error) return t.skip('bash is not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-promote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const check = text => {
    const file = path.join(dir, 'error.txt');
    fs.writeFileSync(file, text);
    return spawnSync('bash', ['-c', `${body}\nmanifest_unknown_only "$1" latest`, 'probe', file]).status;
  };
  assert.equal(check('ERROR: ghcr.io/ledgetoptechnologies/logs-local:latest: not found: MANIFEST_UNKNOWN: manifest unknown\n'), 0);
  assert.notEqual(check('ERROR: ghcr.io/ledgetoptechnologies/logs-local:latest: denied: MANIFEST_UNKNOWN\n'), 0, 'auth words');
  assert.notEqual(check('ERROR: logs-local:latest: MANIFEST_UNKNOWN\nsecond line\n'), 0, 'two lines');
  assert.notEqual(check('ERROR: logs-local:other: MANIFEST_UNKNOWN: manifest unknown\n'), 0, 'another reference');
  assert.notEqual(check('ERROR: logs-local:latest: NAME_UNKNOWN MANIFEST_UNKNOWN\n'), 0, 'another registry code');
  assert.notEqual(check('ERROR: logs-local:latest: 503 Service Unavailable\n'), 0);
});

test("GHCR's real one-line absent-tag answer is accepted only verbatim for the exact full reference", t => {
  const start = promote.indexOf('manifest_unknown_only() {');
  const end = promote.indexOf('\n          }\n', promote.indexOf('not_found_exact() {', start)) + 12;
  const body = promote.slice(start, end);
  assert.ok(body.includes('not_found_exact() {'));
  const probe = spawnSync('bash', ['-c', 'exit 0']);
  if (probe.error) return t.skip('bash is not available');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-promote-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const REF = 'ghcr.io/ledgetoptechnologies/logs-local:latest';
  // The same classification both callers use: the strict MANIFEST_UNKNOWN form, or the exact not-found line.
  const absent = (text, ref = REF) => {
    const file = path.join(dir, 'error.txt');
    fs.writeFileSync(file, text);
    return spawnSync('bash', ['-c', `${body}\nmanifest_unknown_only "$1" "\${2##*[:@]}" || not_found_exact "$1" "$2"`, 'probe', file, ref]).status === 0;
  };
  // Real output from the failed first promotion (run 44672369373).
  assert.equal(absent(`ERROR: ${REF}: not found\n`), true);
  assert.equal(absent(`ERROR: ${REF}: not found\r\n`), true, 'a CRLF line ending is still the same line');
  assert.equal(absent(`ERROR: ${REF}: not found`), true, 'no trailing newline');
  // Near misses stay unknown (abort).
  assert.equal(absent('ERROR: ghcr.io/ledgetoptechnologies/logs-local:other: not found\n'), false, 'another tag');
  assert.equal(absent('ERROR: ghcr.io/ledgetoptechnologies/other-image:latest: not found\n'), false, 'another image');
  assert.equal(absent('ERROR: logs-local:latest: not found\n'), false, 'a partial reference');
  assert.equal(absent(`ERROR: ${REF}: not found\nERROR: retrying\n`), false, 'an extra line');
  assert.equal(absent(`ERROR: ${REF}: not found: denied\n`), false, 'auth wording');
  assert.equal(absent(`ERROR: ${REF}: unauthorized: not found\n`), false);
  assert.equal(absent(`ERROR: ${REF}: dial tcp: i/o timeout\n`), false, 'network wording');
  assert.equal(absent(`ERROR: ${REF}: not found (503)\n`), false);
  assert.equal(absent(`  ERROR: ${REF}: not found\n`), false, 'not verbatim');
  assert.equal(absent(`ERROR: ${REF}: Not Found\n`), false, 'different wording');
  assert.equal(absent('\n'), false, 'empty');
  assert.equal(absent(`ERROR: ${REF}: not found\n`, 'ghcr.io/ledgetoptechnologies/logs-local:other'), false, 'requested ref differs');
  // Both the initial read and the pre-write re-read use it, for the exact full reference.
  assert.ok(promote.includes('|| not_found_exact "$RUNNER_TEMP/inspect-error.txt" "$ref"; then'));
  assert.ok(promote.includes('|| not_found_exact "$RUNNER_TEMP/reread-error.txt" "$IMAGE_NAME:latest"; }; then'));
  assert.equal((promote.match(/not_found_exact\(\) \{/g) ?? []).length, 2);
});
