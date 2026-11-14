// Package visibility observation for the publisher: private and linked to this repository, or stop. Fake fetch only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { classify, observe } from '../scripts/package-visibility.mjs';

const who = { owner: 'ledgetoptechnologies', name: 'logs-local', repository: 'ledgetoptechnologies/LedgeTop-Ops' };
const body = (patch = {}) => ({ name: 'logs-local', package_type: 'container', visibility: 'private',
  owner: { login: 'ledgetoptechnologies' }, repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' }, ...patch });
const reply = (status, json) => async () => new Response(json === undefined ? '' : JSON.stringify(json), { status });
const run = (phase, fetchImpl, extra = {}) => observe(phase, who.owner, who.name, { fetchImpl, token: 't', repository: who.repository, waitMs: 0, sleep: async () => {}, ...extra });

test('pre: private+linked ok, absent allowed (not proof of privacy), public/internal/other repo/errors stop', () => {
  assert.deepEqual([classify('pre', 200, body(), who).ok, classify('pre', 200, body(), who).state], [true, 'private']);
  assert.deepEqual(classify('pre', 404, null, who), { ok: true, state: 'absent' });
  for (const [status, b, state] of [[200, body({ visibility: 'public' }), 'public'], [200, body({ visibility: 'internal' }), 'internal'],
    [200, body({ repository: { full_name: 'someone/else' } }), 'other_repository'], [200, body({ repository: null }), 'other_repository'],
    [200, body({ package_type: 'npm' }), 'mismatch'], [200, body({ name: 'other' }), 'mismatch'], [200, body({ owner: { login: 'x' } }), 'mismatch'],
    [200, body({ visibility: undefined }), 'unknown'], [401, null, 'unknown'], [403, null, 'unknown'], [500, null, 'unknown'], [0, null, 'unknown']]) {
    const result = classify('pre', status, b, who);
    assert.equal(result.ok, false, `${status} ${state}`);
    assert.equal(result.state, state);
  }
});

test('post: ONLY an existing private package linked to this repository passes; 404 retried then stops', async () => {
  assert.equal((await run('post', reply(200, body()))).ok, true);
  let calls = 0;
  const absent = await run('post', async () => { calls++; return new Response('', { status: 404 }); }, { attempts: 4 });
  assert.deepEqual([absent.ok, absent.state, calls], [false, 'absent', 4]);
  let n = 0;
  const appears = await run('post', async () => (++n < 3 ? new Response('', { status: 404 }) : new Response(JSON.stringify(body()), { status: 200 })), { attempts: 5 });
  assert.deepEqual([appears.ok, appears.attempt], [true, 3]);
  for (const f of [reply(200, body({ visibility: 'public' })), reply(403, { message: 'x' }), reply(502), async () => { throw new Error('offline'); }]) {
    const r = await run('post', f);
    assert.equal(r.ok, false);
  }
  const publicAfter = await run('post', reply(200, body({ visibility: 'public' })), { attempts: 5 });
  assert.equal(publicAfter.attempt, 1, 'a definite public answer is never retried');
});

test('the observation holds no token and fails closed on bad usage', async () => {
  const r = await run('pre', reply(200, body()));
  assert.ok(!JSON.stringify(r).includes('Bearer') && !('token' in r));
  assert.deepEqual([r.visibility, r.repository, r.package, r.phase], ['private', 'ledgetoptechnologies/LedgeTop-Ops', 'logs-local', 'pre']);
  assert.equal((await observe('pre', who.owner, who.name, { fetchImpl: reply(200, body()), token: '', repository: who.repository })).state, 'usage');
  assert.equal((await observe('later', who.owner, who.name, { fetchImpl: reply(200, body()), token: 't', repository: who.repository })).state, 'usage');
});

test('workflow: visibility is observed before the push and required private before any receipt or alias, in both jobs', () => {
  const workflow = fs.readFileSync(fileURLToPath(new URL('../../../.github/workflows/publish-logs-local.yml', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
  for (const target of ['keyless', 'full']) {
    const at = workflow.indexOf(`\n  publish-${target}:\n`);
    const next = workflow.slice(at + 1).search(/\n  [a-z-]+:\n/);
    const job = next < 0 ? workflow.slice(at) : workflow.slice(at, at + 1 + next);
    const order = ['Refuse unless the commit tag is proven absent', 'Observe the package visibility before pushing', `Build and publish the ${target} linux/amd64 image`,
      'Verify the immutable tag resolves to the built digest', 'Require the package to be private before any receipt or alias', 'Smoke-test the exact published digest',
      'Write the deployment receipt', 'Upload the deployment receipt', 'Promote the smoke-tested digest'].map(step => job.indexOf(step));
    assert.ok(order.every(i => i > 0), target);
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${target}: step order`);
    assert.ok(job.includes('package-visibility.mjs pre "${{ steps.names.outputs.owner }}" logs-local package-pre.json'));
    assert.ok(job.includes('package-visibility.mjs post "${{ steps.names.outputs.owner }}" logs-local package-post.json'));
    assert.ok(job.includes('package:{visibility:$pkg[0].visibility,repository:$pkg[0].repository,observedAt:$pkg[0].observedAt}'), 'the receipt carries the observation');
    assert.equal((job.match(/GITHUB_TOKEN: \$\{\{ github\.token \}\}/g) ?? []).length, 2, 'the job token only for the two read-only observations');
  }
  assert.ok(!/visibility:\s*(public|private)\b|gh api .*-X|PATCH|PUT \/orgs/.test(workflow.replace(/package:\{visibility:\$pkg\[0\]\.visibility/g, '')), 'nothing changes visibility');
});
