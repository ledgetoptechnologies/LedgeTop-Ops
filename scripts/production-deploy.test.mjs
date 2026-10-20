import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { PROFILE, hash, canonical, validateInstallation, compileConfig, checkMode, capture, CloudflareReader, verifyCandidate, verifySourceMap, executeDeployment, validateBuildEnvironment, frontendInputHash } from './production-deploy.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ids = { operations: '11111111-1111-4111-8111-111111111111', client: '22222222-2222-4222-8222-222222222222', 'ops-sync': '33333333-3333-4333-8333-333333333333' };
const NEW = '44444444-4444-4444-8444-444444444444';
const clone = x => structuredClone(x);
const genuineMap = () => ({ version: 3, file: 'index.js', sources: ['fixture.ts'], sourcesContent: ['export const fixture = true;'], names: [], mappings: 'AAAA' });
function fixture() {
  const profile = clone(PROFILE), snapshot = {};
  for (const [app, spec] of Object.entries(profile.workers)) {
    const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', app, 'wrangler.jsonc'))).vars;
    const vars = Object.fromEntries(spec.plainNames.map(name => [name, defaults[name] ?? 'synthetic-fixture']));
    if (app === 'operations') Object.assign(vars, {
      CLIENT_ONBOARDING_ADMIN_ENABLED: 'true', CLIENT_ONBOARDING_ADMIN_ORIGIN: 'https://ops.ledgetopdroneservices.com',
      CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: 'true', CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED: 'true',
      CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS: '["synthetic-owner"]', CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE: '2026-10-20T00:00:00.000Z',
      PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED: 'true',
    });
    if (app === 'client') vars.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED = 'true';
    // Fixture has no private production values. Bind the test policy to its
    // synthetic values; the CLI always uses the committed production policy.
    for (const key of Object.keys(spec.plainValueSHA256)) spec.plainValueSHA256[key] = hash(vars[key]);
    const bindings = [...clone(spec.bindings), ...Object.entries(vars).map(([name, text]) => ({ name, type: 'plain_text', text }))];
    const resources = { script: { ...clone(spec.script), etag: 'a'.repeat(64), last_deployed_from: 'wrangler' }, script_runtime: clone(spec.runtime), bindings };
    snapshot[app] = {
      latest: ids[app], deployment: { id: ids[app], versions: [{ version_id: ids[app], percentage: 100 }], strategy: 'percentage' },
      version: { id: ids[app], resources }, settings: { ...clone(spec.settings), annotations: { 'workers/message': 'fixture', 'workers/triggered_by': 'fixture' }, bindings: clone(bindings) },
      modern: { id: ids[app], assets: app === 'ops-sync' ? undefined : { opaque: app + '-existing-assets' }, modules: [{ name: 'index.js', content_base64: Buffer.from('old').toString('base64') }] },
      schedules: { schedules: spec.crons.map(cron => ({ cron, created_on: 'original-timestamp' })) },
    };
    spec.assetsSHA256 = hash(canonical(snapshot[app].modern.assets ?? null));
  }
  return { profile, snapshot };
}
function readerFor(snapshot, candidate) {
  return { calls: [], async get(suffix) {
    this.calls.push(suffix);
    const app = Object.keys(PROFILE.workers).find(k => suffix.includes(PROFILE.workers[k].name + '/'));
    assert.ok(app, `Unexpected path ${suffix}`);const s = snapshot[app];
    if (suffix.endsWith('/deployments?per_page=1')) return clone({ deployments: [s.deployment] });
    if (suffix.endsWith('/versions?per_page=1')) return { items: [{ id: s.latest }] };
    if (suffix.endsWith('/settings')) return clone(s.settings);
    if (suffix.endsWith('/schedules')) return clone(s.schedules);
    const id = suffix.match(/versions\/([^?]+)/)?.[1];
    if (suffix.includes('/workers/workers/')) return clone(id === NEW ? candidate.modern : s.modern);
    return clone(id === NEW ? candidate.version : s.version);
  } };
}
test('recognized final profile: effective original scalars,<=128, all resources and10crons', () => {
  const { profile, snapshot } = fixture();assert.equal(validateInstallation(snapshot, { profile }), snapshot);
  assert.equal(PROFILE.workers.operations.crons.length, 10);
  assert.equal(PROFILE.workers.operations.plainNames.length + PROFILE.workers.operations.bindings.filter(x => x.type === 'secret_text').length, 128);
});
test('compiled config has no scalar override or assets upload and inherits every installed binding', () => {
  const { profile, snapshot } = fixture();
  for (const app of Object.keys(profile.workers)) {
    const cfg = compileConfig(snapshot, app, '/built/index.js', profile);
    assert.deepEqual(cfg.vars, {});assert.equal(cfg.keep_vars, true);assert.equal(cfg.unsafe.metadata.keep_assets, true);
    assert.equal(cfg.assets, undefined);assert.equal(cfg.containers, undefined);assert.equal(cfg.migrations, undefined);
    assert.ok(cfg.unsafe.bindings.every(x => x.type === 'inherit' && Object.keys(x).length === 2));
    assert.equal(cfg.unsafe.bindings.length, snapshot[app].version.resources.bindings.length);
    assert.equal(cfg.unsafe.metadata.annotations['workers/triggered_by'], undefined);
    assert.deepEqual(cfg.triggers.crons, profile.workers[app].crons);
  }
});
for (const [name, change] of [
  ['fresh/missing installation', x => { delete x.client; }],
  ['latest inactive version', x => { x.operations.latest = NEW; }],
  ['split active traffic', x => { x.operations.deployment.versions[0].percentage = 50; }],
  ['missing tenth cron', x => { x.operations.schedules.schedules.pop(); }],
  ['bridge absent', x => { x.client.version.resources.bindings = x.client.version.resources.bindings.filter(b => b.name !== 'CLIENT_ONBOARDING_RECIPIENT_BRIDGE');x.client.settings.bindings = clone(x.client.version.resources.bindings); }],
  ['unknown resource', x => { x.operations.version.resources.bindings.find(b => b.type === 'd1').id = 'foreign';x.operations.settings.bindings = clone(x.operations.version.resources.bindings); }],
  ['original scalar changed', x => { const r = x.operations.version.resources.bindings.find(b => b.name === 'PUBLIC_SHARE_ORIGIN');r.text = 'https://foreign.invalid';x.operations.settings.bindings = clone(x.operations.version.resources.bindings); }],
  ['operator flag reset', x => { x.operations.version.resources.bindings.find(b => b.name === 'CLIENT_ONBOARDING_ADMIN_ENABLED').text = 'false';x.operations.settings.bindings = clone(x.operations.version.resources.bindings); }],
  ['binding budget/defaults reintroduced', x => { x.operations.version.resources.bindings.push({ name: 'DROPBOX_IMPORT_ENABLED', type: 'plain_text', text: 'false' });x.operations.settings.bindings = clone(x.operations.version.resources.bindings); }],
  ['machine enabled', x => { x.operations.version.resources.bindings.push({ name: 'OPS_AGENT_READ_ENABLED', type: 'plain_text', text: 'true' });x.operations.settings.bindings = clone(x.operations.version.resources.bindings); }],
  ['exports changed', x => { x.operations.version.resources.script.named_handlers.pop(); }],
  ['opaque assets absent', x => { delete x.client.modern.assets; }],
]) test(`fail closed: ${name}`, () => {
  const { profile, snapshot } = fixture();change(snapshot);assert.throws(() => validateInstallation(snapshot, { profile }));
});
test('UI mode and changed frontend fingerprint fail before network', () => {
  assert.throws(() => checkMode('ui', PROFILE.frontendSHA256), /retained historical asset union/);
  assert.throws(() => checkMode('backend', 'changed'), /retained asset union/);
  assert.doesNotThrow(() => checkMode('backend', PROFILE.frontendSHA256));
});
test('frontend lock is portable across Git CRLF/LF text checkouts; binary assets remain byte-exact', () => {
  assert.equal(frontendInputHash('package-lock.json', Buffer.from('a\r\nb\r\n')), frontendInputHash('package-lock.json', Buffer.from('a\nb\n')));
  assert.notEqual(frontendInputHash('asset.png', Buffer.from('a\r\nb')), frontendInputHash('asset.png', Buffer.from('a\nb')));
});
test('production API process refuses proxy/TLS/Node injection before credentials', () => {
  for (const name of ['https_proxy', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY']) assert.throws(() => validateBuildEnvironment({ [name]: 'unsafe' }), /unsupported/);
  assert.doesNotThrow(() => validateBuildEnvironment({ CLOUDFLARE_API_TOKEN: 'synthetic', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32) }));
});
test('explicit build-environment smoke check prints only booleans with synthetic environment', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH', 'SYSTEMROOT', 'WINDIR'].includes(k.toUpperCase())));
  const argv = [path.join(ROOT, 'scripts/production-deploy.mjs'), '--check-build-environment'];
  const missing = spawnSync(process.execPath, argv, { env, encoding: 'utf8', windowsHide: true });
  assert.equal(missing.status, 1);assert.equal(JSON.parse(missing.stdout).apiTokenPresent, false);
  const present = spawnSync(process.execPath, argv, { env: { ...env, CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'synthetic-token-never-print-this' }, encoding: 'utf8', windowsHide: true });
  assert.equal(present.status, 0);assert.equal(JSON.parse(present.stdout).apiTokenPresent, true);
  assert.ok(!present.stdout.includes('synthetic-token'));
});
test('reader only sends fixed official GET with no redirect/retry or arbitrary endpoint', async () => {
  const calls = [];
  const reader = new CloudflareReader('a'.repeat(32), 'synthetic-token-for-tests-only', async (url, args) => {
    calls.push({ url, args });return { status: 200, async arrayBuffer() { return Buffer.from(JSON.stringify({ success: true, result: { items: [] }, result_info: { total_pages: 2 } })); } };
  });
  await reader.get('/workers/scripts/ledgetop-ops/versions?per_page=1');
  assert.equal(calls.length, 1);assert.equal(calls[0].args.method, 'GET');assert.equal(calls[0].args.redirect, 'error');
  assert.ok(calls[0].url.startsWith('https://api.cloudflare.com/client/v4/accounts/'));
  await assert.rejects(reader.get('/access/apps'), /Read endpoint/);
  await assert.rejects(reader.get('/workers/scripts'), /Incomplete/);
});
test('capture detects deployment changed during fresh GETs', async () => {
  const { snapshot } = fixture();const reader = readerFor(snapshot);
  const get = reader.get.bind(reader);let count = 0;
  reader.get = async suffix => { const value = await get(suffix);if (++count === 7) value.deployments[0].id = NEW;return value; };
  await assert.rejects(capture(reader), /changed during/);
});
test('head0 capture tolerates documented bounded list pages, not empty/unbounded lists', async () => {
  const { snapshot } = fixture();const reader = readerFor(snapshot);const get = reader.get.bind(reader);
  reader.get = async suffix => {
    const value = await get(suffix);
    if (suffix.endsWith('/deployments?per_page=1')) value.deployments.push(clone(value.deployments[0]));
    if (suffix.endsWith('/versions?per_page=1')) value.items.push({ id: NEW });
    return value;
  };
  const captured = await capture(reader);assert.equal(captured.operations.latest, ids.operations);
  reader.get = async suffix => suffix.endsWith('/versions?per_page=1') ? { items: [] } : get(suffix);
  await assert.rejects(capture(reader), /head missing/);
});
test('unselected head transition gets bounded GET-only recapture; selected transition still holds', async () => {
  const { snapshot } = fixture();const reader = readerFor(snapshot);const get = reader.get.bind(reader);let reads = 0;
  reader.get = async suffix => {
    const value = await get(suffix);
    if (suffix === '/workers/scripts/ledgetop-clients/deployments?per_page=1' && ++reads === 2) value.deployments[0].id = NEW;
    return value;
  };
  await capture(reader, { selectedApp: 'operations' });assert.equal(reads, 4);
  reads = 0;
  await assert.rejects(capture(reader, { selectedApp: 'client' }), /changed during/);
});
test('candidate verifies actual new bytes, opaque assets and unchanged resources', () => {
  const { snapshot } = fixture();const version = clone(snapshot.operations.version);version.id = NEW;
  const modern = { id: NEW, assets: snapshot.operations.modern.assets, modules: [{ name: 'index.js', content_base64: Buffer.from('new').toString('base64') }] };
  assert.doesNotThrow(() => verifyCandidate(snapshot, 'operations', version, modern, Buffer.from('new')));
  assert.throws(() => verifyCandidate(snapshot, 'operations', version, { ...modern, assets: { changed: true } }, Buffer.from('new')), /assets changed/);
  assert.throws(() => verifyCandidate(snapshot, 'operations', version, modern, Buffer.from('wrong')), /bytes differ/);
});
test('returned source map semantics match genuine sibling; paths may only normalize', () => {
  const original = genuineMap(), normalized = clone(original);normalized.sources[0] = '../../fixture.ts';
  assert.doesNotThrow(() => verifySourceMap(normalized, original));
  for (const key of ['mappings', 'sourcesContent', 'names']) {
    const changed = clone(original);changed[key] = typeof changed[key] === 'string' ? 'changed' : ['changed'];
    assert.throws(() => verifySourceMap(changed, original), /differs/);
  }
  const { snapshot } = fixture();const version = clone(snapshot.operations.version);version.id = NEW;
  const modern = { id: NEW, assets: snapshot.operations.modern.assets, modules: [{ name: 'index.js', content_base64: Buffer.from('new').toString('base64') }, { name: 'index.js.map', content_base64: Buffer.from(JSON.stringify(normalized)).toString('base64') }] };
  assert.equal(verifyCandidate(snapshot, 'operations', version, modern, Buffer.from('new'), original).returnedSourceMapSemanticsVerified, true);
  modern.modules[1].content_base64 = Buffer.from(JSON.stringify({ ...original, mappings: 'wrong' })).toString('base64');
  assert.throws(() => verifyCandidate(snapshot, 'operations', version, modern, Buffer.from('new'), original), /differs/);
});
async function flow(t, fail = null) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-deploy-fixture-'));t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const main = path.join(directory, 'index.js');fs.writeFileSync(main, 'new');fs.writeFileSync(main + '.map', JSON.stringify(genuineMap()));
  const { profile, snapshot } = fixture();const version = clone(snapshot.operations.version);version.id = NEW;version.resources.script.etag = 'b'.repeat(64);
  const modern = { id: NEW, assets: clone(snapshot.operations.modern.assets), modules: [{ name: 'index.js', content_base64: Buffer.from('new').toString('base64') }, { name: 'index.js.map', content_base64: Buffer.from(JSON.stringify(genuineMap())).toString('base64') }] };
  const reader = readerFor(snapshot, { version, modern });const calls = [];
  const runNative = async (cli, argv, out, phase) => {
    calls.push(phase);assert.equal(cli, 'fixture-cli');assert.ok(argv.includes('--config'));
    if (phase === 'upload') {
      snapshot.operations.latest = NEW;
      if (fail === 'native') throw new Error('ambiguous native failure');
      if (fail === 'assets') modern.assets = { changed: true };
      if (fail === 'concurrent') snapshot.client.schedules.schedules.pop();
      if (fail === 'concurrent-code') {
        const other = '55555555-5555-4555-8555-555555555555';
        snapshot.client.latest = other;snapshot.client.version.id = other;snapshot.client.modern.id = other;
        snapshot.client.version.resources.script.etag = 'c'.repeat(64);snapshot.client.deployment.versions = [{ version_id: other, percentage: 100 }];
      }
      return `Worker Version ID: ${NEW}\n`;
    }
    assert.deepEqual(argv.slice(0, 4), ['versions', 'deploy', `${NEW}@100%`, '--yes']);
    snapshot.operations.version = clone(version);snapshot.operations.modern = clone(modern);snapshot.operations.deployment.versions = [{ version_id: NEW, percentage: 100 }];snapshot.operations.deployment.id = NEW;
    snapshot.operations.settings.annotations['workers/triggered_by'] = 'wrangler';
    snapshot.operations.settings.annotations['workers/message'] = 'native deployment message';
    return 'Deployed';
  };
  const operation = executeDeployment({ app: 'operations', mode: 'backend', cli: 'fixture-cli', main, directory: path.join(directory, 'journal'), reader, runNative, fingerprint: PROFILE.frontendSHA256, profile });
  return { operation, calls, directory };
}
test('full injected flow: freshGET→oneinactiveupload→verify→separatenativeactivate→verify', async t => {
  const { operation, calls, directory } = await flow(t);const result = await operation;
  assert.equal(result.verifiedActive, true);assert.deepEqual(calls, ['upload', 'activate']);
  assert.ok(fs.existsSync(path.join(directory, 'journal/verified-active.json')));
});
test('unselected recognized code rollout allowed while its protected controls stay exact', async t => {
  const { operation, calls } = await flow(t, 'concurrent-code');assert.equal((await operation).verifiedActive, true);assert.deepEqual(calls, ['upload', 'activate']);
});
test('unselected inactive rolling candidate requires matching immutable metadata/assets', () => {
  const { snapshot, profile } = fixture();const s = snapshot.client;s.latest = NEW;
  s.latestVersion = clone(s.version);s.latestVersion.id = NEW;s.latestModern = clone(s.modern);s.latestModern.id = NEW;
  assert.doesNotThrow(() => validateInstallation(snapshot, { profile, selectedApp: 'operations' }));
  s.latestModern.assets = { wrong: true };
  assert.throws(() => validateInstallation(snapshot, { profile, selectedApp: 'operations' }), /rolling version changed/);
});
for (const failure of ['native', 'assets', 'concurrent']) test(`no activation or retry after ${failure} failure`, async t => {
  const { operation, calls } = await flow(t, failure);await assert.rejects(operation);assert.deepEqual(calls, ['upload']);
});
