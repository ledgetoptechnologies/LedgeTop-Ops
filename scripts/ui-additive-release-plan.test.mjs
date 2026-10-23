import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PROFILE, canonical, hash } from './production-deploy.mjs';
import { domainPhaseValues } from './production-domain-recognition.mjs';
import { compileUiAdditiveReleasePlan, validateUiAdditiveReleasePlan,
  validateUiAdditivePreparationInstallation } from './ui-additive-release-plan.mjs';

const clone = value => structuredClone(value);
const omit = 'CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE';
function fixture() {
  const profile = clone(PROFILE), snapshot = {}, phase = domainPhaseValues('portal-entry-canonical');
  let index = 1;
  for (const [app, spec] of Object.entries(profile.workers)) {
    const defaults = JSON.parse(fs.readFileSync(new URL(`../apps/${app}/wrangler.jsonc`, import.meta.url))).vars;
    const vars = Object.fromEntries(spec.plainNames.map(name => [name, defaults[name] ?? 'synthetic-fixture']));
    if (app === 'operations') Object.assign(vars, {
      CLIENT_ONBOARDING_ADMIN_ENABLED: 'true', CLIENT_ONBOARDING_ADMIN_ORIGIN: 'https://ops.ledgetopdroneservices.com',
      PUBLIC_BASE_URL: 'https://ops.ledgetopdroneservices.com', EXPECTED_HOST: 'ops.ledgetopdroneservices.com',
      CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: 'true', CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED: 'true',
      CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS: '["synthetic-owner"]', CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE: '2026-10-20T00:00:00.000Z',
      PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED: 'true',
    });
    if (app === 'client') vars.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED = 'true';
    Object.assign(vars, phase[app]);
    for (const name of spec.plainNames) spec.plainValueSHA256[name] = hash(vars[name]);
    const bindings = [...clone(spec.bindings), ...Object.entries(vars).map(([name, text]) => ({ name, type: 'plain_text', text }))];
    const digit = String(index++), id = `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
    const resources = { script: clone(spec.script), script_runtime: clone(spec.runtime), bindings };
    snapshot[app] = { latest: id, version: { id, resources },
      deployment: { versions: [{ version_id: id, percentage: 100 }] },
      settings: { ...clone(spec.settings), bindings: clone(bindings) },
      modern: { id, assets: app === 'ops-sync' ? undefined : { config: { base_path: '/',
        html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application',
        run_worker_first: clone(spec.metadata.assets.config.run_worker_first) } } },
      schedules: { schedules: spec.crons.map(cron => ({ cron })) } };
    spec.assetsSHA256 = hash(canonical(snapshot[app].modern.assets ?? null));
  }
  return { snapshot, options: { profile, mains: { operations: '/reviewed/ops.mjs', client: '/reviewed/client.mjs' } } };
}
function poststate(snapshot, plan) {
  const result = clone(snapshot);
  for (const app of ['operations', 'client']) {
    const s = result[app], config = plan.configs[app], before = s.version.resources.bindings;
    const bindings = config.unsafe.bindings.map(binding => binding.type === 'inherit'
      ? clone(before.find(row => row.name === binding.name)) : clone(binding));
    s.version.resources.bindings = bindings; s.settings.bindings = clone(bindings);
    s.version.resources.script_runtime = clone(plan.expectedProfile.workers[app].runtime);
    s.modern.assets = clone(plan.expectations[app].expectedAssetsMetadata);
  }
  return result;
}
function changeBinding(snapshot, app, name, change) {
  for (const rows of [snapshot[app].version.resources.bindings, snapshot[app].settings.bindings]) change(rows.find(row => row.name === name), rows);
}

test('offline preparation preserves inputs and exact retained bindings, exports, crons, assets and controls', () => {
  const { snapshot, options } = fixture(), original = clone({ snapshot, options });
  const plan = compileUiAdditiveReleasePlan(snapshot, options);
  assert.deepEqual({ snapshot, options }, original);
  assert.equal(Object.isFrozen(snapshot.operations.settings.compatibility_flags), false);
  assert.equal(plan.liveNamespaceProof, false); assert.equal(plan.deploymentEnabled, false); assert.equal(plan.assetsUpload, false);
  assert.equal(plan.selectedHtml, false); assert.ok(Object.isFrozen(plan.configs.operations.unsafe.bindings));
  assert.deepEqual(plan.omittedScalars.map(x => [x.application, x.name, x.originalValueSHA256]), [['operations', omit, hash('false')]]);
  for (const app of ['operations', 'client']) {
    const cfg = plan.configs[app], spec = options.profile.workers[app], expected = plan.expectedProfile.workers[app];
    assert.equal(cfg.keep_vars, false); assert.deepEqual(cfg.unsafe.metadata.keep_bindings, []);
    assert.equal(cfg.unsafe.metadata.keep_assets, true); assert.deepEqual(cfg.vars, {});
    assert.equal(cfg.assets, undefined); assert.equal(cfg.unsafe.metadata.assets.jwt, undefined);
    assert.deepEqual(cfg.unsafe.metadata.assets.config.run_worker_first, [...spec.metadata.assets.config.run_worker_first, '/_ui', '/_ui/*']);
    const retained = snapshot[app].version.resources.bindings.filter(x => app !== 'operations' || x.name !== omit);
    assert.deepEqual(cfg.unsafe.bindings.filter(x => x.type === 'inherit').map(x => x.name), retained.map(x => x.name));
    assert.deepEqual(cfg.unsafe.bindings.filter(x => x.type !== 'inherit'), [
      { name: 'UI_RELEASE_ASSETS', type: 'service', service: 'ledgetop-ui-assets', environment: 'production' },
      { name: 'UI_ACTIVE_RELEASE', type: 'plain_text', text: '' },
    ]);
    assert.deepEqual(expected.settings, spec.settings); assert.deepEqual(expected.script, spec.script); assert.deepEqual(expected.crons, spec.crons);
    assert.notEqual(expected.assetsSHA256, spec.assetsSHA256);
    assert.equal(expected.assetsSHA256, hash(canonical(plan.expectations[app].expectedAssetsMetadata)));
    const expectedMetadata = clone(snapshot[app].modern.assets);
    expectedMetadata.config.run_worker_first.push('/_ui', '/_ui/*');
    assert.deepEqual(plan.expectations[app].expectedAssetsMetadata, expectedMetadata);
    assert.equal(plan.expectations[app].assetsConfigSHA256, hash(canonical(cfg.unsafe.metadata.assets.config)));
    assert.equal(plan.expectations[app].effectiveTextSecretBudget, app === 'operations' ? 128 : 92);
  }
  assert.ok(plan.expectedProfile.workers.client.plainNames.includes(omit));
  assert.deepEqual(plan.expectedProfile.workers['ops-sync'], options.profile.workers['ops-sync']);
  assert.equal(validateUiAdditiveReleasePlan(snapshot, plan, options), plan);
  assert.doesNotThrow(() => validateUiAdditivePreparationInstallation(poststate(snapshot, plan), plan, snapshot, options));
});

for (const [name, mutate] of [
  ['scalar', s => changeBinding(s, 'operations', 'DELIVERY_BASE_URL', row => { row.text = 'https://wrong.example'; })],
  ['origin', s => changeBinding(s, 'operations', 'PUBLIC_BASE_URL', row => { row.text = 'https://ops.ledgetop.app'; })],
  ['unrelated flag', s => changeBinding(s, 'operations', 'CLIENT_VIEWER_SESSION_ISSUER_ENABLED', row => { row.text = 'unreviewed'; })],
  ['maintenance true', s => changeBinding(s, 'operations', omit, row => { row.text = 'true'; })],
  ['secret omitted', s => changeBinding(s, 'operations', 'OPERATIONS_SESSION_SECRET', (row, rows) => rows.splice(rows.indexOf(row), 1))],
  ['resource', s => { s.operations.version.resources.bindings.find(x => x.type === 'service').service = 'wrong'; }],
  ['cron', s => { s.client.schedules.schedules.push({ cron: '* * * * *' }); }],
  ['settings', s => { s.operations.settings.logpush = true; }],
  ['exports', s => { s.operations.version.resources.script.named_handlers.push({ name: 'Unreviewed', handlers: ['fetch'] }); }],
  ['assets config metadata', s => { s.client.modern.assets = { other: true }; }],
  ['new selector occupied', s => { for (const rows of [s.client.version.resources.bindings, s.client.settings.bindings]) rows.push({ name: 'UI_ACTIVE_RELEASE', type: 'plain_text', text: '' }); }],
  ['new service occupied', s => { for (const rows of [s.operations.version.resources.bindings, s.operations.settings.bindings]) rows.push({ name: 'UI_RELEASE_ASSETS', type: 'service', service: 'other' }); }],
]) test(`rejects unrecognized baseline ${name}`, () => {
  const { snapshot, options } = fixture(); mutate(snapshot);
  assert.throws(() => compileUiAdditiveReleasePlan(snapshot, options));
});

for (const [name, mutate] of [
  ['selected HTML', p => { p.configs.client.unsafe.bindings.find(x => x.name === 'UI_ACTIVE_RELEASE').text = 'a'.repeat(40); }],
  ['renderer routing', p => { p.configs.operations.unsafe.metadata.assets.config.run_worker_first.push('/viewer/*'); }],
  ['assets directory', p => { p.configs.operations.assets = { directory: 'dist' }; }],
  ['assets JWT', p => { p.configs.client.unsafe.metadata.assets.jwt = 'unreviewed'; }],
  ['wildcard retention', p => { p.configs.operations.unsafe.metadata.keep_bindings = ['plain_text']; }],
  ['keep vars', p => { p.configs.operations.keep_vars = true; }],
  ['secret omission', p => { p.configs.operations.unsafe.bindings = p.configs.operations.unsafe.bindings.filter(x => x.name !== 'OPERATIONS_SESSION_SECRET'); }],
  ['unknown stage', p => { p.stage = 'activate'; }],
]) test(`rejects changed reviewed configuration: ${name}`, () => {
  const { snapshot, options } = fixture(), plan = clone(compileUiAdditiveReleasePlan(snapshot, options)); mutate(plan);
  assert.throws(() => validateUiAdditiveReleasePlan(snapshot, plan, options), /changed/);
});

test('requires exact stage, complete baseline, original false hash and full Operations budget', () => {
  const { snapshot, options } = fixture();
  assert.throws(() => compileUiAdditiveReleasePlan(snapshot, { ...options, stage: 'select-html' }), /stage/);
  assert.throws(() => compileUiAdditiveReleasePlan({ operations: snapshot.operations }, options), /complete/);
  assert.throws(() => compileUiAdditiveReleasePlan(snapshot, { ...options, mains: { operations: 'only' } }), /paths/);
  const altered = clone(options); altered.profile.workers.operations.plainValueSHA256[omit] = hash('true');
  changeBinding(snapshot, 'operations', omit, row => { row.text = 'true'; });
  assert.throws(() => compileUiAdditiveReleasePlan(snapshot, altered), /original reviewed false/);
});

test('rejects a synthetic recognized baseline that lacks the reviewed full128 Operations budget', () => {
  const { snapshot, options } = fixture(), name = 'OPERATIONS_SESSION_SECRET', spec = options.profile.workers.operations;
  changeBinding(snapshot, 'operations', name, (row, rows) => rows.splice(rows.indexOf(row), 1));
  spec.bindings = spec.bindings.filter(row => row.name !== name);
  assert.throws(() => compileUiAdditiveReleasePlan(snapshot, options), /full128/);
});

test('pinned Wrangler metadata overrides prevent plaintext and secret wildcard retention', t => {
  const runtime = process.env.UI_RELEASE_WRANGLER_RUNTIME
    ?? new URL('../apps/operations/node_modules/wrangler/wrangler-dist/cli.js', import.meta.url);
  if (!fs.existsSync(runtime)) { t.skip('Install the locked Operations dependencies or set UI_RELEASE_WRANGLER_RUNTIME for pinned metadata qualification'); return; }
  const bytes = fs.readFileSync(runtime), source = bytes.toString('utf8');
  assert.equal(hash(bytes), PROFILE.wranglerRuntimeSHA256, 'Only the reviewed Wrangler runtime may qualify metadata');
  const keepStart = source.indexOf('  let keep_bindings = void 0;');
  const keepEnd = source.indexOf('  const metadata2 = {', keepStart);
  const overrideStart = source.indexOf('  if (options?.unsafe?.metadata !== void 0)', keepEnd);
  const overrideEnd = source.indexOf('  formData.set("metadata", JSON.stringify(metadata2));', overrideStart);
  assert.ok(keepStart >= 0 && keepEnd > keepStart && overrideStart > keepEnd && overrideEnd > overrideStart);
  // Execute only the exact hash-pinned, pure metadata fragments. Never import
  // the CLI, run a process, access credentials, or create an upload request.
  const metadata = new Function('options', 'keepVars', 'keepSecrets', 'keepBindings',
    source.slice(keepStart, keepEnd) + '\nconst metadata2 = { keep_bindings };\n'
    + source.slice(overrideStart, overrideEnd) + '\nreturn metadata2;');
  assert.deepEqual(metadata({}, true, true).keep_bindings, ['plain_text', 'json', 'secret_text', 'secret_key']);
  const { snapshot, options } = fixture(), plan = compileUiAdditiveReleasePlan(snapshot, options);
  const unsafeStart = source.indexOf('        for (const { type: unsafeType, name: name2, ...data } of info3.bindings ?? []) {');
  const unsafeEnd = source.indexOf('        break;', unsafeStart);
  const emitStart = source.indexOf('  for (const [bindingName, config5] of Object.entries(bindings2 ?? {})) {');
  const emitEnd = source.indexOf('  const manifestModuleName = ', emitStart);
  assert.ok(unsafeStart > 0 && unsafeEnd > unsafeStart && emitStart > 0 && emitEnd > emitStart);
  const uploadBindings = new Function('info3', 'const output = {};\n'
    + source.slice(unsafeStart, unsafeEnd) + '\nconst bindings2=output,metadataBindings=[];\n'
    + 'function isUnsafeBindingType(type) { return type.startsWith("unsafe_"); }\n'
    + source.slice(emitStart, emitEnd) + '\nreturn metadataBindings;');
  for (const config of Object.values(plan.configs)) {
    const uploaded = metadata(config, config.keep_vars, true);
    assert.deepEqual(uploaded.keep_bindings, []);
    assert.equal(uploaded.keep_assets, true);
    assert.equal(uploaded.assets.jwt, undefined);
    assert.deepEqual(uploadBindings(config.unsafe), config.unsafe.bindings,
      'Hash-pinned native binding conversion must preserve the complete explicit list and service shape');
  }
});

for (const [name, mutate] of [
  ['removed flag resurrected', s => { for (const rows of [s.operations.version.resources.bindings, s.operations.settings.bindings]) rows.push({ name: omit, type: 'plain_text', text: 'false' }); }],
  ['Client flag lost', s => changeBinding(s, 'client', omit, (row, rows) => rows.splice(rows.indexOf(row), 1))],
  ['selected HTML', s => changeBinding(s, 'client', 'UI_ACTIVE_RELEASE', row => { row.text = 'a'.repeat(40); })],
  ['different service', s => changeBinding(s, 'client', 'UI_RELEASE_ASSETS', row => { row.service = 'wrong'; })],
  ['foreign service environment', s => changeBinding(s, 'client', 'UI_RELEASE_ASSETS', row => { row.environment = 'staging'; })],
  ['named service entrypoint', s => changeBinding(s, 'client', 'UI_RELEASE_ASSETS', row => { row.entrypoint = 'Named'; })],
  ['empty service entrypoint', s => changeBinding(s, 'client', 'UI_RELEASE_ASSETS', row => { row.entrypoint = ''; })],
  ['null service entrypoint', s => changeBinding(s, 'client', 'UI_RELEASE_ASSETS', row => { row.entrypoint = null; })],
  ['extra route', s => { s.operations.version.resources.script_runtime.assets.raw_run_worker_first.push('/viewer/*'); }],
  ['secret changed', s => changeBinding(s, 'operations', 'OPERATIONS_SESSION_SECRET', row => { row.name = 'NEW_SECRET'; })],
  ['stale assets config', s => { s.operations.modern.assets.config.run_worker_first.splice(-2); }],
  ['extra assets JSON field', s => { s.client.modern.assets.unreviewed = true; }],
  ['other assets config delta', s => { s.operations.modern.assets.config.html_handling = 'none'; }],
]) test(`poststate refuses ${name}`, () => {
  const { snapshot, options } = fixture(), plan = compileUiAdditiveReleasePlan(snapshot, options), after = poststate(snapshot, plan);
  mutate(after); assert.throws(() => validateUiAdditivePreparationInstallation(after, plan, snapshot, options));
});

test('deserialized forged expected profiles cannot authorize their own poststate', () => {
  const { snapshot, options } = fixture(), plan = clone(compileUiAdditiveReleasePlan(snapshot, options));
  const after = poststate(snapshot, plan);
  changeBinding(after, 'client', 'UI_ACTIVE_RELEASE', row => { row.text = 'a'.repeat(40); });
  plan.expectedProfile.workers.client.plainValueSHA256.UI_ACTIVE_RELEASE = hash('a'.repeat(40));
  assert.throws(() => validateUiAdditivePreparationInstallation(after, plan, snapshot, options), /plan changed/);
  assert.throws(() => validateUiAdditivePreparationInstallation(after, plan), /complete/);
});
