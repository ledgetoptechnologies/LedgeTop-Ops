import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { domainPhaseValues, domainRecognitionProfile, domainRecognitionDiff } from './production-domain-recognition.mjs';
import { PROFILE, hash, canonical, validateInstallation, compileConfig, checkMode, capture, CloudflareReader, verifyCandidate, verifySourceMap, executeDeployment, validateBuildEnvironment, frontendInputHash, reviewedFrontendDigest, frontendFingerprint, parseDeploymentArguments, inspectProductionInstallation, buildModulePath, readStaffCutoverReview, deploymentSourceCommit } from './production-deploy.mjs';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ids = { operations: '11111111-1111-4111-8111-111111111111', client: '22222222-2222-4222-8222-222222222222', 'ops-sync': '33333333-3333-4333-8333-333333333333' };
const NEW = '44444444-4444-4444-8444-444444444444';
const clone = x => structuredClone(x);

test('worker-only Viewer source compatibility admits just the reviewed exact path and SHA', () => {
  const file = 'packages/shared/src/viewer-service.ts';
  const candidate = '075afdc83aee2c288a10be47441e1fd7cf141edfc8a2c9936ba7102d005024b6';
  const baseline = 'a7f1b2160fb85c06d99213edbc4ef69c0df8f0e96de6284b7d312c2520f91b0f';
  assert.equal(reviewedFrontendDigest(file, candidate), baseline);
  for (const other of ['package.json', 'packages/shared/src/other.ts', './' + file, file.toUpperCase()])
    assert.equal(reviewedFrontendDigest(other, candidate), candidate);
  const changed = hash('any additional worker or browser source change');
  assert.equal(reviewedFrontendDigest(file, changed), changed);
  assert.equal(frontendInputHash(file, Buffer.from('changed source')), hash('changed source'));
});

test('only the exact reviewed Viewer and Windows staging manifests alias the locked frontend baseline', () => {
  const raw = fs.readFileSync(path.join(ROOT, 'package.json'));
  const normalized = raw.toString('utf8').replaceAll('\r\n', '\n');
  assert.equal(hash(normalized), 'c2c9b2f65bf33250158efa14ee67ac20432518ce4b33f20b45c23042ca3f2ebf');
  // Undo precisely the 730e3d18 root manifest delta, preserving bytes. This
  // must reproduce main77's reviewed manifest, including all other fields.
  const historical = normalized
    .replace(' scripts/windows-files-staging-preflight.test.mjs', '')
    .replace('    "staging:windows-files:preflight": "node scripts/windows-files-staging-preflight.mjs --read-only",\n', '')
    .replace('    "staging:windows-files:preflight:test": "node --test scripts/windows-files-staging-preflight.test.mjs",\n', '');
  assert.equal(hash(historical), 'f8eb91b8e39b62df7d7a13b6474f96297e05110c443899c1b109fa2a0062a1d0');
  const baseline = '3c5cf8119ffa8eb65d2216db89a583ba79b91a7ada75cbae8aec0856af59ae31';
  for (const manifest of [normalized, historical]) {
    assert.equal(frontendInputHash('package.json', Buffer.from(manifest)), baseline);
    assert.equal(frontendInputHash('package.json', Buffer.from(manifest.replaceAll('\n', '\r\n'))), baseline);
  }
  for (const alter of [
    value => { value.scripts['viewer:build'] += ' --changed'; },
    value => { value.scripts.build = 'changed'; },
    value => { value.scripts['staging:windows-files:preflight'] += ' --changed'; },
    value => { value.scripts['staging:windows-files:preflight:test'] = 'node other.mjs'; },
    value => { value.scripts.test += ' scripts/unreviewed.test.mjs'; },
    value => { value.scripts.unreviewed = 'node unreviewed.mjs'; },
    value => { value.dependencies = { 'unreviewed-package': '1.0.0' }; },
  ]) {
    const value = JSON.parse(normalized); alter(value);
    for (const ending of ['\n', '\r\n']) {
      const text = JSON.stringify(value, null, 2).replaceAll('\n', ending);
      const bytes = Buffer.from(text);
      assert.equal(frontendInputHash('package.json', bytes), hash(text.replaceAll('\r\n', '\n')));
      assert.notEqual(frontendInputHash('package.json', bytes), baseline);
    }
  }
  assert.equal(frontendInputHash('apps/client/package.json', raw), hash(normalized));
  assert.equal(frontendInputHash('packages/shared/src/unreviewed.ts', raw), hash(normalized));
  for (const other of ['./package.json', 'PACKAGE.JSON'])
    assert.equal(frontendInputHash(other, raw), hash(normalized));
  assert.throws(() => checkMode('ui', PROFILE.frontendSHA256), /UI deployment denied/);
});

test('Windows shared source changes remain protected: manifest compatibility does not authorize a production release', () => {
  const fingerprint = frontendFingerprint(ROOT);
  assert.notEqual(fingerprint, PROFILE.frontendSHA256);
  assert.throws(() => checkMode('backend', fingerprint), /retained asset union/);
  // Reconstruct main77's protected source in a temporary copy, with exact
  // before/after pins. This is test-only evidence, NOT a production alias.
  const temporaryParent = fs.realpathSync(os.tmpdir());
  const temporary = fs.mkdtempSync(path.join(temporaryParent, 'production-frontend-manifest-'));
  try {
    const copy = relative => {
      const source = path.join(ROOT, relative);
      if (!fs.existsSync(source)) return;
      const worker = path.join(source, 'worker');
      fs.cpSync(source, path.join(temporary, relative), { recursive: true, filter: file => {
        if (file === worker) return false;
        assert.equal(fs.lstatSync(file).isSymbolicLink(), false, 'Test copy refuses repository symlinks');
        return true;
      } });
    };
    for (const app of ['client', 'operations'])
      for (const relative of ['src', 'public', 'index.html', 'vite.config.ts', 'package.json', 'package-lock.json'])
        copy(`apps/${app}/${relative}`);
    for (const relative of ['package.json', 'package-lock.json', 'packages/shared/src']) copy(relative);
    const authority = 'packages/shared/src/operations-portal-native-delivery-authority.ts';
    const source = fs.readFileSync(path.join(temporary, authority), 'utf8').replaceAll('\r\n', '\n');
    assert.equal(hash(source), 'e10a371519d29333185706af6353cd701ce4553e3711b945205c860b12cc60bd');
    assert.equal(reviewedFrontendDigest(authority, hash(source)), hash(source));
    const start = source.indexOf('/** Private successor proof; original grant authorization is never rewritten. */\n');
    const end = source.indexOf('export interface OperationsPortalNativeDeliveryAuthorizationReaderBinding {\n', start);
    assert.ok(start >= 0 && end > start);
    const historical = source.slice(0, start) + source.slice(end);
    assert.equal(hash(historical), 'c7cd7dabf0a3c16fca643b1d2b1070f773b9ad6549de8c06e48cd5410a6c70ef');
    fs.writeFileSync(path.join(temporary, authority), historical);
    const queue = 'packages/shared/src/windows-queue-reference.ts';
    const digest = hash(fs.readFileSync(path.join(temporary, queue), 'utf8').replaceAll('\r\n', '\n'));
    assert.equal(digest, '55a51ea413aa2a38b444f7ce7eb618cb152e52f1f340ce8a03b5c65cc9911747');
    assert.equal(reviewedFrontendDigest(queue, digest), digest);
    fs.rmSync(path.join(temporary, queue));
    assert.equal(frontendFingerprint(temporary), PROFILE.frontendSHA256);
  } finally {
    assert.equal(fs.lstatSync(temporary).isSymbolicLink(), false);
    const resolved = fs.realpathSync(temporary);
    assert.equal(path.dirname(resolved), temporaryParent, 'Cleanup stays directly in the owned temporary parent');
    assert.match(path.basename(resolved), /^production-frontend-manifest-[A-Za-z0-9]{6}$/);
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
const genuineMap = () => ({ version: 3, file: 'index.js', sources: ['fixture.ts'], sourcesContent: ['export const fixture = true;'], names: [], mappings: 'AAAA' });
function fixture() {
  const profile = clone(PROFILE), snapshot = {};
  for (const [app, spec] of Object.entries(profile.workers)) {
    const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', app, 'wrangler.jsonc'))).vars;
    const vars = Object.fromEntries(spec.plainNames.map(name => [name, defaults[name] ?? 'synthetic-fixture']));
    if (app === 'operations') Object.assign(vars, {
      DELIVERY_BASE_URL: 'https://portal.ledgetopdroneservices.com',
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

test('finite domain recognition preserves all resources, public namespaces and protected scalar hashes', () => {
  assert.deepEqual(domainRecognitionProfile('baseline'), PROFILE);
  assert.deepEqual(domainRecognitionProfile('ops-alias-preparation').workers.client, PROFILE.workers.client);
  for (const phase of ['baseline','ops-alias-preparation','client-private-overlap'])
    assert.equal(domainRecognitionProfile(phase).workers.operations.plainValueSHA256.DELIVERY_BASE_URL,
      PROFILE.workers.operations.plainValueSHA256.DELIVERY_BASE_URL);
  for (const phase of ['portal-entry-canonical','staff-canonical'])
    assert.equal(domainRecognitionProfile(phase).workers.operations.plainValueSHA256.DELIVERY_BASE_URL,
      hash('https://portal.ledgetop.app'));
  for (const phase of ['baseline', 'ops-alias-preparation', 'client-private-overlap', 'portal-entry-canonical', 'staff-canonical']) {
    const { profile: base, snapshot } = fixture();
    const values = domainPhaseValues(phase), profile = domainRecognitionProfile(phase, base);
    for (const [app, vars] of Object.entries(values)) for (const [name, text] of Object.entries(vars)) {
      for (const bindings of [snapshot[app].version.resources.bindings, snapshot[app].settings.bindings])
        bindings.find(row => row.name === name).text = text;
    }
    assert.equal(validateInstallation(snapshot, { profile }), snapshot);
    for (const [app, worker] of Object.entries(base.workers)) {
      const next = profile.workers[app];
      for (const key of Object.keys(worker).filter(key => key !== 'plainValueSHA256')) assert.deepEqual(next[key], worker[key]);
      for (const [name, sha] of Object.entries(worker.plainValueSHA256))
        if (!Object.hasOwn(values[app] ?? {}, name)) assert.equal(next.plainValueSHA256[name], sha);
    }
    for (const [app, name] of [['operations','PUBLIC_SHARE_ORIGIN'],['client','PUBLIC_BASE_URL'],['client','PUBLIC_SHARE_ORIGIN'],['client','EXPECTED_HOST'],['client','LEGACY_CLIENT_ORIGINS']])
      assert.equal(profile.workers[app].plainValueSHA256[name], base.workers[app].plainValueSHA256[name]);
    const wrong = clone(snapshot);
    for (const bindings of [wrong.client.settings.bindings, wrong.client.version.resources.bindings])
      bindings.find(row => row.name === 'PUBLIC_SHARE_ORIGIN').text = 'https://portal.ledgetop.app';
    assert.throws(() => validateInstallation(wrong, { profile }), /scalar configuration changed/);
    const resource = clone(snapshot); resource.client.version.resources.bindings.find(row => row.type === 'd1').id = NEW;
    assert.throws(() => validateInstallation(resource, { profile }), /bindings differ|resource/);
    const flag = clone(snapshot);
    for (const bindings of [flag.operations.settings.bindings, flag.operations.version.resources.bindings])
      bindings.find(row => row.name === 'CLIENT_ONBOARDING_ADMIN_ENABLED').text = 'false';
    assert.throws(() => validateInstallation(flag, { profile }), /scalar configuration|normal onboarding/);
    const secret = clone(snapshot);
    for (const bindings of [secret.client.settings.bindings, secret.client.version.resources.bindings])
      bindings.push({name:'UNREVIEWED_SECRET',type:'secret_text'});
    assert.throws(() => validateInstallation(secret, { profile }), /resource or secret binding/);
    assert.equal(domainRecognitionDiff(phase).writesPerformed, false);
    assert.equal(domainRecognitionDiff(phase).deploymentEnabled, false);
  }
  assert.throws(() => domainRecognitionProfile('arbitrary'), /Unknown reviewed domain phase/);
  const arbitrary = fixture(); arbitrary.profile.onboardingAdminOrigin = 'https://unreviewed.example';
  assert.throws(() => validateInstallation(arbitrary.snapshot, {profile:arbitrary.profile}), /Unreviewed canonical admin origin/);
  const changed = domainPhaseValues('client-private-overlap'); changed.client.CLIENT_PORTAL_ORIGIN = 'https://unreviewed.example';
  assert.equal(domainPhaseValues('client-private-overlap').client.CLIENT_PORTAL_ORIGIN, 'https://portal.ledgetop.app');
  // Two Worker updates cannot be atomic. Every permitted intermediate state
  // above passes; generating new entry URLs before the Client update does not.
  const {profile: base, snapshot: unsafe} = fixture();
  base.workers.client.plainValueSHA256.CLIENT_PORTAL_ORIGIN = hash('https://portal.ledgetopdroneservices.com');
  for (const bindings of [unsafe.client.settings.bindings, unsafe.client.version.resources.bindings])
    bindings.find(row => row.name === 'CLIENT_PORTAL_ORIGIN').text = 'https://portal.ledgetopdroneservices.com';
  for (const bindings of [unsafe.operations.settings.bindings, unsafe.operations.version.resources.bindings])
    bindings.find(row => row.name === 'DELIVERY_BASE_URL').text = 'https://portal.ledgetop.app';
  for (const phase of ['baseline','ops-alias-preparation','client-private-overlap','portal-entry-canonical','staff-canonical'])
    assert.throws(() => validateInstallation(unsafe, {profile:domainRecognitionProfile(phase,base)}), /scalar configuration changed/);
});

test('strict CLI defaults to baseline and only admits finite explicit phase names', () => {
  assert.deepEqual(parseDeploymentArguments([]), {kind:'check'});
  const execute=['--worker','operations','--mode','backend','--execute'];
  assert.deepEqual(parseDeploymentArguments(execute), {kind:'execute',app:'operations',mode:'backend',phase:'baseline'});
  for (const phase of ['baseline','ops-alias-preparation','client-private-overlap','portal-entry-canonical','staff-canonical']) {
    assert.equal(parseDeploymentArguments([...execute,'--domain-phase',phase]).phase,phase);
    assert.deepEqual(parseDeploymentArguments(['--inspect','--domain-phase',phase]),{kind:'inspect',phase});
  }
  for (const args of [
    ['--inspect'],['--inspect','--domain-phase','unknown'],['--inspect','--domain-phase','baseline','--execute'],
    [...execute,'--profile','arbitrary.json'],[...execute,'--domain-phase','unknown'],
    [...execute,'--domain-phase','baseline','--domain-phase','staff-canonical'],
    ['--worker','operations','--mode','ui','--execute'],['--domain-phase','staff-canonical',...execute],
  ]) assert.throws(()=>parseDeploymentArguments(args), /Use --worker|Unknown reviewed domain phase|UI deployment denied/);
});

test('inspection returns only IDs, hashes and booleans through GET-only recognition, without native commands', async()=>{
  const {profile,snapshot}=fixture(),reader=readerFor(snapshot);
  const receipt=await inspectProductionInstallation(reader,'baseline',profile);
  assert.deepEqual(receipt.activeVersionIds,ids);
  assert.equal(receipt.protectedProfileSHA256,hash(canonical(profile)));
  assert.equal(receipt.readOnly,true);assert.equal(receipt.uploadEnabled,false);assert.equal(receipt.activationEnabled,false);
  assert.deepEqual(Object.keys(receipt).sort(),['recognizedPhase','activeVersionIds','protectedProfileSHA256','frontendSHA256','recognized','readOnly','uploadEnabled','activationEnabled','rawSnapshotPrinted'].sort());
  assert.ok(reader.calls.length>0);assert.ok(reader.calls.every(url=>url.startsWith('/workers/')));
  assert.ok(!JSON.stringify(receipt).includes('synthetic-fixture'));
  const invalid=readerFor(snapshot);
  await assert.rejects(inspectProductionInstallation(invalid,'unknown',profile),/Unknown reviewed domain phase/);
  assert.deepEqual(invalid.calls,[]);
});

test('unknown phase and malformed inspection refuse before credentials or network',()=>{
  for(const args of [['--inspect','--domain-phase','unknown'],['--inspect','--domain-phase','baseline','--execute']]){
    const child=spawnSync(process.execPath,['scripts/production-deploy.mjs',...args],{cwd:ROOT,encoding:'utf8',env:{PATH:process.env.PATH}});
    assert.equal(child.status,1);assert.equal(child.stdout,'');
    assert.match(JSON.parse(child.stderr).message,/Unknown reviewed domain phase|Use --worker/);
  }
});
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

test('malformed conventional tokens fail generically before Headers or transport can echo them', () => {
  const marker = 'OFFLINE-SECRET-MARKER-1234567890';
  for (const suffix of ['\r\nBAD', '\n', '\r', '\r\n', '\tBAD', ' BAD', '\x7f', '\u00e9', '\u200b']) {
    let calls = 0;
    assert.throws(() => new CloudflareReader('a'.repeat(32), marker + suffix, () => { calls++;throw new Error('transport must not run'); }), error => {
      assert.equal(error.message, 'Conventional CLOUDFLARE_ACCOUNT_ID/API_TOKEN required');
      assert.ok(!error.message.includes(marker));return true;
    });
    assert.equal(calls, 0);
  }
});

test('malformed-token constructor error remains redacted when printed by a CLI process', () => {
  const marker = 'OFFLINE-SECRET-MARKER-1234567890';
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH', 'SYSTEMROOT', 'WINDIR'].includes(k.toUpperCase())));
  const code = `import { CloudflareReader } from './scripts/production-deploy.mjs';try {new CloudflareReader('a'.repeat(32),process.env.CLOUDFLARE_API_TOKEN,()=>{throw new Error('transport prohibited')});process.exitCode=2;}catch(error){console.error(JSON.stringify({HELD:true,message:error.message,automaticRetry:false}));process.exitCode=1;}`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: { ...env, CLOUDFLARE_API_TOKEN: marker + '\r\nBAD' }, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 1);assert.ok(!child.stdout.includes(marker) && !child.stderr.includes(marker));
  assert.equal(JSON.parse(child.stderr).message, 'Conventional CLOUDFLARE_ACCOUNT_ID/API_TOKEN required');
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
async function flow(t, fail = null, app = 'operations', staffOptions = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'prod-deploy-fixture-'));t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const main = buildModulePath(app, directory);fs.mkdirSync(path.dirname(main), { recursive: true });
  fs.writeFileSync(main, staffOptions.unchanged ? 'old' : 'new');fs.writeFileSync(main + '.map', JSON.stringify(genuineMap()));
  const { profile, snapshot } = fixture();const version = clone(snapshot[app].version);version.id = NEW;version.resources.script.etag = 'b'.repeat(64);
  const modern = { id: NEW, assets: clone(snapshot[app].modern.assets), modules: [{ name: 'index.js', content_base64: Buffer.from('new').toString('base64') }, { name: 'index.js.map', content_base64: Buffer.from(JSON.stringify(genuineMap())).toString('base64') }] };
  const reader = readerFor(snapshot, { version, modern });const calls = [];
  const runNative = async (cli, argv, out, phase) => {
    calls.push(phase);assert.equal(cli, 'fixture-cli');assert.ok(argv.includes('--config'));
    if (phase === 'upload') {
      snapshot[app].latest = NEW;
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
    snapshot[app].version = clone(version);snapshot[app].modern = clone(modern);snapshot[app].deployment.versions = [{ version_id: NEW, percentage: 100 }];snapshot[app].deployment.id = NEW;
    snapshot[app].settings.annotations['workers/triggered_by'] = 'wrangler';
    snapshot[app].settings.annotations['workers/message'] = 'native deployment message';
    return 'Deployed';
  };
  // This injected transport receipt tests the release phase boundary, not the
  // independent D1 readiness verifier's cohort/bootstrap policy or live access.
  const sourceCommit = 'e'.repeat(40), staffCalls = [];
  const review = { syntheticTransportFixture: true };
  const readStaffCutover = async args => {
    assert.equal(args.sourceCommit, sourceCommit);assert.deepEqual(args.review, review);
    staffCalls.push([...calls]);
    if (staffCalls.length === staffOptions.failAt) throw new Error('native staff readiness unavailable');
    const receipt = { schemaVersion: 1, sourceCommit, accountId: '846c924bf17bf4f3dd15c97a4c5d1d51',
      databaseId: '6ebf7514-d306-4615-ae56-ad869c874dbd', reviewSha256: 'a'.repeat(64), cohortSha256: 'b'.repeat(64),
      observedAt: new Date().toISOString(), staffCount: 2, generation: 7 };
    if (staffCalls.length === staffOptions.changeAt) receipt.generation++;
    if (staffOptions.receipt) Object.assign(receipt, staffOptions.receipt);
    return receipt;
  };
  const operation = executeDeployment({ app, mode: 'backend', cli: 'fixture-cli', main, directory: path.join(directory, 'journal'), reader, runNative,
    fingerprint: PROFILE.frontendSHA256, profile, sourceCommit,
    staffCutoverReview: staffOptions.missing ? undefined : review, readStaffCutover });
  return { operation, calls, directory, staffCalls };
}

test('Ops and Sync qualify staff handoff before upload, before activation and after activation', async t => {
  for (const app of ['operations','ops-sync']) {
    const { operation, staffCalls, directory } = await flow(t, null, app);
    assert.equal((await operation).verifiedActive, true);
    assert.deepEqual(staffCalls, [[], ['upload'], ['upload','activate']]);
    for (const phase of ['before-upload','before-activate','after-activate'])
      assert.ok(fs.existsSync(path.join(directory, `journal/native-staff-${phase}.json`)));
  }
});

test('missing or unavailable handoff prevents the first native upload for both affected Workers', async t => {
  for (const app of ['operations','ops-sync']) for (const staffOptions of [{missing:true},{failAt:1}]) {
    const { operation, calls } = await flow(t, null, app, staffOptions);
    await assert.rejects(operation, /native staff|native staff handoff/i);assert.deepEqual(calls, []);
  }
});

test('unchanged runtime bytes still require current staff handoff readiness', async t => {
  for (const app of ['operations','ops-sync']) {
    for (const options of [{missing:true},{failAt:1}]) {
      const { operation, calls } = await flow(t, null, app, {...options, unchanged:true});
      await assert.rejects(operation, /native staff/i);assert.deepEqual(calls, []);
    }
    const { operation, calls, staffCalls } = await flow(t, null, app, {unchanged:true});
    assert.deepEqual(await operation, {unchanged:true,noUpload:true});
    assert.deepEqual(calls, []);assert.deepEqual(staffCalls, [[]]);
  }
});

test('changed or unavailable handoff holds inactive candidate without activation or replay', async t => {
  for (const staffOptions of [{failAt:2},{changeAt:2}]) {
    const { operation, calls } = await flow(t, null, 'operations', staffOptions);
    await assert.rejects(operation, /native staff/i);assert.deepEqual(calls, ['upload']);
  }
});

test('post-activation handoff loss never returns a verified-active receipt or retries', async t => {
  for (const options of [{failAt:3},{changeAt:3}]) {
    const { operation, calls, directory } = await flow(t, null, 'ops-sync', options);
    await assert.rejects(operation, /native staff/i);assert.deepEqual(calls, ['upload','activate']);
    assert.equal(fs.existsSync(path.join(directory, 'journal/verified-active.json')), false);
  }
});

test('malformed, stale, wrong-source or wrong-target staff receipts fail before any upload', async t => {
  for (const receipt of [{schemaVersion:2},{sourceCommit:'f'.repeat(40)},{accountId:'c'.repeat(32)},
    {databaseId:NEW},{staffCount:0},{staffCount:1025},{generation:-1},{generation:0.5},
    {reviewSha256:'wrong'},{cohortSha256:'wrong'},{observedAt:'invalid'},
    {observedAt:new Date(Date.now()-120_000).toISOString()},{observedAt:new Date(Date.now()+120_000).toISOString()}]) {
    const { operation, calls } = await flow(t, null, 'operations', {receipt});
    await assert.rejects(operation, /Fresh exact native staff/);assert.deepEqual(calls, []);
  }
});

test('Client-only deployment neither reads nor requires the unrelated staff handoff packet', async t => {
  const { operation, calls, staffCalls } = await flow(t, null, 'client', {missing:true,failAt:1});
  assert.equal((await operation).verifiedActive, true);assert.deepEqual(calls, ['upload','activate']);assert.deepEqual(staffCalls, []);
});

test('staff packet CLI options are explicit and packet reads are bounded with redacted failures', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-review-packet-test-'));
  t.after(() => fs.rmSync(directory, {recursive:true,force:true}));
  const file = path.join(directory, 'candidate.native-staff-review.json');
  fs.writeFileSync(file, JSON.stringify({test:'private-identity-not-for-errors'}));
  const args = ['--worker','operations','--mode','backend','--execute','--staff-cutover-review',file];
  assert.equal(parseDeploymentArguments(args).staffReviewPath, file);
  assert.equal(parseDeploymentArguments([...args,'--domain-phase','staff-canonical']).phase, 'staff-canonical');
  assert.deepEqual(readStaffCutoverReview(file), {test:'private-identity-not-for-errors'});
  for (const invalid of ['relative.json', file+'\0']) {
    assert.throws(() => parseDeploymentArguments([...args.slice(0,6),invalid]), /absolute private/);
    assert.throws(() => readStaffCutoverReview(invalid), /absolute private/);
  }
  assert.throws(() => parseDeploymentArguments([...args,'--staff-cutover-review',file]), /unique/);
  assert.throws(() => parseDeploymentArguments([...args.slice(0,1),'client',...args.slice(2)]), /Ops or Sync/);
  for (const body of ['private-identity-not-for-errors', 'x'.repeat(1024*1024+1)]) {
    fs.writeFileSync(file, body);
    assert.throws(() => readStaffCutoverReview(file), error => !error.message.includes('private-identity') && /packet/.test(error.message));
  }
  assert.throws(() => readStaffCutoverReview(directory), /packet/);
});

test('source qualification rejects override injection before invoking git', () => {
  assert.throws(() => deploymentSourceCommit(ROOT, {GIT_DIR:'unreviewed'}), /Git source overrides/);
  assert.throws(() => deploymentSourceCommit(ROOT, {GIT_CONFIG_COUNT:'1'}), /Git source overrides/);
});

test('source qualification pins a real clean checkout and rejects tracked or untracked source drift', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staff-source-pin-test-'));
  t.after(() => {
    assert.equal(fs.realpathSync(directory), directory);
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, {recursive:true,force:true});
  });
  const git = args => {
    const result = spawnSync('git', ['-c','commit.gpgsign=false','-c','core.hooksPath='+path.join(directory,'no-hooks'),...args],
      {cwd:directory,encoding:'utf8',windowsHide:true,shell:false});
    assert.equal(result.status, 0, 'Owned synthetic Git fixture failed');return result.stdout.trim();
  };
  git(['init']);git(['config','core.fsmonitor','false']);
  const file = path.join(directory, 'worker.mjs');fs.writeFileSync(file, 'export default 1;\n');
  git(['add','worker.mjs']);git(['-c','user.name=Synthetic Fixture','-c','user.email=fixture@example.invalid','commit','--no-gpg-sign','-m','synthetic']);
  const commit = git(['rev-parse','HEAD']);
  assert.equal(deploymentSourceCommit(directory), commit);
  fs.writeFileSync(file, 'export default 2;\n');
  assert.throws(() => deploymentSourceCommit(directory), /exact clean/);
  fs.writeFileSync(file, 'export default 1;\n');
  fs.writeFileSync(path.join(directory,'unreviewed-module.mjs'), 'export default 3;\n');
  assert.throws(() => deploymentSourceCommit(directory), /exact clean/);
});
test('full injected flow: freshGET→oneinactiveupload→verify→separatenativeactivate→verify', async t => {
  const { operation, calls, directory } = await flow(t);const result = await operation;
  assert.equal(result.verifiedActive, true);assert.deepEqual(calls, ['upload', 'activate']);
  assert.ok(fs.existsSync(path.join(directory, 'journal/verified-active.json')));
});

test('Sync uses the observed flat Wrangler build plus genuine sibling map through the guarded flow', async t => {
  const { operation, calls, directory } = await flow(t, null, 'ops-sync');
  assert.ok(fs.existsSync(path.join(directory, 'apps/ops-sync/dist/index.js')));
  assert.ok(fs.existsSync(path.join(directory, 'apps/ops-sync/dist/index.js.map')));
  assert.equal(fs.existsSync(path.join(directory, 'apps/ops-sync/dist/ledgetop_ops_sync/index.js')), false);
  assert.equal((await operation).verifiedActive, true);
  assert.deepEqual(calls, ['upload', 'activate']);
  assert.equal(buildModulePath('operations', directory), path.join(directory, 'apps/operations/dist/ledgetop_ops/index.js'));
  assert.equal(buildModulePath('client', directory), path.join(directory, 'apps/client/dist/ledgetop_clients/index.js'));
  assert.throws(() => buildModulePath('foreign', directory), /Unknown Worker/);
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
