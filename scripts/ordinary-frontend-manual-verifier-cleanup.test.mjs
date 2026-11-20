import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createJournaledAssetVerifierProvider } from './ordinary-frontend-retained-executor.mjs';
import { createAssetVerificationNonce } from './production-auto-verify.mjs';
import { newTemporaryVerifierName } from './production-auto-provider.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const version = '00000000-0000-4000-8000-000000000002';
const sourceCommit = 'b'.repeat(40);
const hash = value => createHash('sha256').update(value).digest('hex');
const ok = result => Response.json({ success: true, errors: [], result });
const absent = () => Response.json({ success: false, errors: [] }, { status: 404 });
const bindings = [{ name: 'SOURCE_ASSETS', type: 'service', service: 'ledgetop-ops', environment: 'production' }];

async function fixture(t, { beforeDelete = () => {} } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-verifier-cleanup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = path.join(directory, 'journal.jsonl');
  const rows = () => fs.readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
  const name = newTemporaryVerifierName(), script = `/workers/scripts/${name}`;
  let stored = null, enabled = false, tamper = false;
  const mutations = [], deletes = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url), prefix = `/client/v4/accounts/${NATIVE_STAFF_PRODUCTION_TARGET.accountId}`;
    assert.equal(parsed.origin, 'https://api.cloudflare.com');
    assert.ok(parsed.pathname.startsWith(prefix));
    const suffix = parsed.pathname.slice(prefix.length) + parsed.search;
    assert.equal(init.redirect, 'error');
    if (init.method !== 'GET') {
      assert.ok((init.method === 'PUT' || init.method === 'DELETE') && suffix === script
        || init.method === 'POST' && suffix === script + '/subdomain', 'only exact owned helper mutations');
      mutations.push({ method: init.method, suffix });
    }
    if (init.method === 'PUT') {
      const metadata = JSON.parse(init.body.get('metadata'));
      assert.deepEqual(metadata.bindings, bindings);
      stored = Buffer.from(await init.body.get('index.js').arrayBuffer());
      return ok({ id: version });
    }
    if (init.method === 'DELETE') {
      const intent = rows().at(-1);
      assert.equal(intent.phase, 'temporary-verifier-delete');
      assert.equal(intent.method, 'DELETE');
      assert.equal(intent.path, script);
      assert.equal(intent.name, name);
      assert.equal(intent.workerName, 'ledgetop-ops');
      assert.equal(intent.sourceCommit, sourceCommit);
      assert.equal(intent.sourceSHA256, hash(stored));
      assert.equal(intent.automaticRetry, false);
      beforeDelete(intent);
      deletes.push(suffix); stored = null; return ok({});
    }
    if (suffix === script + '/subdomain' && init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { enabled: true, previews_enabled: false });
      enabled = true; return ok({ enabled, previews_enabled: false });
    }
    if (suffix === script) return stored ? ok({ id: version }) : absent();
    if (suffix === script + '/versions?per_page=1') return ok({ items: [{ id: version }] });
    if (suffix === script + '/versions/' + version) return ok({ id: version, resources: { bindings } });
    if (suffix === `/workers/workers/${name}/versions/${version}?include=modules`)
      return ok({ id: version, modules: [{ name: 'index.js', content_base64: (tamper ? Buffer.from('changed') : stored).toString('base64') }] });
    if (suffix === script + '/settings') return ok({ bindings });
    if (suffix === script + '/subdomain') return ok({ enabled, previews_enabled: false });
    if (suffix === '/workers/subdomain') return ok({ subdomain: 'synthetic' });
    assert.fail('unreviewed synthetic provider path');
  };
  const provider = createJournaledAssetVerifierProvider({ accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
    token: 'synthetic-token-no-real-provider', fetchImpl, journalDirectory: directory, sourceCommit });
  const nonce = createAssetVerificationNonce();
  await provider.createVerifier({ name, workerName: 'ledgetop-ops', origin: 'https://ops.ledgetop.app',
    versionId: version, nonceHash: nonce.nonceHash,
    entries: [{ path: '/assets/synthetic.js', size: 1, sha256: hash('x'), contentType: 'application/javascript' }] });
  return { provider, name, directory, journal, rows, mutations, deletes, tamper: () => { tamper = true; } };
}

test('manual factory fsyncs cleanup intent before the exact owned helper DELETE and confirms absence', async t => {
  let durableRequestId;
  const originalSync = fs.fsyncSync;
  let state;
  t.mock.method(fs, 'fsyncSync', fd => {
    originalSync(fd);
    if (state) {
      const row = state.rows().at(-1);
      if (row.method === 'DELETE') durableRequestId = row.requestId;
    }
  });
  state = await fixture(t, { beforeDelete: intent => assert.equal(intent.requestId, durableRequestId) });
  const before = state.mutations.length;
  await assert.rejects(state.provider.removeVerifier('ledgetop-ops'));
  await assert.rejects(state.provider.removeVerifier('ops-ui-verify-' + '0'.repeat(24)));
  assert.equal(state.mutations.length, before, 'unowned production and helper targets dispatch nothing');
  await state.provider.removeVerifier(state.name);
  assert.equal(await state.provider.verifierAbsent(state.name), true);
  assert.equal(state.rows().filter(row => row.method === 'DELETE').length, 1);
  assert.equal(state.deletes.length, 1);
  await assert.rejects(state.provider.removeVerifier(state.name));
  assert.equal(state.deletes.length, 1, 'cleanup is never retried');
});

test('manual factory refuses DELETE when durable cleanup journaling fails', async t => {
  const state = await fixture(t);
  fs.renameSync(state.journal, path.join(state.directory, 'journal-before-failure.jsonl'));
  fs.mkdirSync(state.journal); // deterministic append failure, including on Windows and as root
  await assert.rejects(state.provider.removeVerifier(state.name), /production_provider_refused_or_uncertain_no_retry/);
  assert.equal(state.deletes.length, 0);
  assert.equal(state.mutations.filter(row => row.method === 'DELETE').length, 0);
  await assert.rejects(state.provider.removeVerifier(state.name));
  assert.equal(state.deletes.length, 0, 'a refused cleanup is not automatically retried');
});

test('manual factory preserves changed-helper readback refusal before cleanup intent or DELETE', async t => {
  const state = await fixture(t);
  state.tamper();
  await assert.rejects(state.provider.removeVerifier(state.name), /production_provider_refused_or_uncertain_no_retry/);
  assert.equal(state.rows().filter(row => row.method === 'DELETE').length, 0);
  assert.equal(state.deletes.length, 0);
});
