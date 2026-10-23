import { canonical, hash, need, compileConfig, validateInstallation } from './production-deploy.mjs';
import { domainRecognitionProfile } from './production-domain-recognition.mjs';

export const PREPARATION_STAGE = 'primary-binding-preparation';
const APPS = ['operations', 'client'];
const OMIT = 'CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE';
const SERVICE = { name: 'UI_RELEASE_ASSETS', type: 'service', service: 'ledgetop-ui-assets', environment: 'production' };
const SELECTOR = { name: 'UI_ACTIVE_RELEASE', type: 'plain_text', text: '' };
const ROUTES = ['/_ui', '/_ui/*'];
const equal = (a, b) => canonical(a) === canonical(b);
const sorted = rows => [...rows].sort((a, b) => a.name.localeCompare(b.name));
const budget = rows => rows.filter(x => ['plain_text', 'json', 'secret_text', 'secret_key'].includes(x.type)).length;
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Offline preparation only. This does not read a provider, run Wrangler,
 * upload code/assets, select HTML, or establish live namespace availability.
 * A profile override is solely for synthetic fixtures; callers using production
 * state must retain the default complete portal-entry-canonical recognition. */
export function compileUiAdditiveReleasePlan(snapshot, {
  stage = PREPARATION_STAGE, mains,
  profile = domainRecognitionProfile('portal-entry-canonical'),
} = {}) {
  need(stage === PREPARATION_STAGE, 'Unknown preparation stage; selected HTML and renderer routing are not permitted');
  // The reused compiler retains a few array references; isolate them before
  // freezing the returned plan so caller-owned inputs remain untouched.
  snapshot = structuredClone(snapshot);
  profile = structuredClone(profile);
  validateInstallation(snapshot, { profile });
  need(mains && equal(Object.keys(mains).sort(), [...APPS].sort())
    && APPS.every(app => typeof mains[app] === 'string' && mains[app].length > 0), 'Exact primary Worker main paths required');
  const expectedProfile = structuredClone(profile), configs = {}, expectations = {};
  for (const app of APPS) {
    const spec = profile.workers[app], state = snapshot[app];
    const original = state.version.resources.bindings;
    for (const name of [SERVICE.name, SELECTOR.name]) need(!original.some(x => x.name === name), `${app}: new binding name already occupied`);
    const routes = spec.metadata.assets?.config?.run_worker_first;
    need(Array.isArray(routes) && ROUTES.every(route => !routes.includes(route)), `${app}: preparation routes already occupied or missing baseline`);
    need(equal(routes, spec.runtime.assets?.raw_run_worker_first)
      && equal(routes, spec.runtime.assets?.static_routing?.user_worker), `${app}: assets routing representations differ`);
    need(equal(routes, state.modern.assets?.config?.run_worker_first), `${app}: captured assets config routing differs`);
    let retained = original;
    if (app === 'operations') {
      const removed = original.filter(x => x.name === OMIT);
      need(removed.length === 1 && removed[0].type === 'plain_text' && removed[0].text === 'false'
        && spec.plainValueSHA256[OMIT] === hash('false'), 'Operations omission requires the original reviewed false flag hash');
      need(budget(original) === 128, 'Operations preparation requires the reviewed full128 text/secret budget');
      retained = original.filter(x => x.name !== OMIT);
    }
    const bindings = sorted([...structuredClone(retained), structuredClone(SERVICE), structuredClone(SELECTOR)]);
    need(budget(bindings) <= 128, `${app}: effective text/secret budget exceeds128`);
    const config = compileConfig(snapshot, app, mains[app], profile);
    // Wrangler keep_vars would resurrect an omitted plaintext flag. Its final
    // unsafe.metadata override also disables implicit secret-type retention.
    // Every retained secret/scalar/resource is inherited explicitly by name.
    config.keep_vars = false;
    config.unsafe.bindings = [...retained.map(x => ({ name: x.name, type: 'inherit' })), structuredClone(SERVICE), structuredClone(SELECTOR)];
    config.unsafe.metadata.keep_bindings = [];
    config.unsafe.metadata.assets.config.run_worker_first.push(...ROUTES);
    configs[app] = config;
    const expected = expectedProfile.workers[app];
    expected.bindings = sorted([...expected.bindings, structuredClone(SERVICE)]);
    expected.plainNames = [...expected.plainNames.filter(name => app !== 'operations' || name !== OMIT), SELECTOR.name].sort();
    if (app === 'operations') {
      delete expected.plainValueSHA256[OMIT];
      expected.forbiddenPlainNames = [...expected.forbiddenPlainNames, OMIT];
    }
    expected.plainValueSHA256[SELECTOR.name] = hash('');
    expected.metadata.assets.config.run_worker_first.push(...ROUTES);
    expected.runtime.assets.raw_run_worker_first.push(...ROUTES);
    expected.runtime.assets.static_routing.user_worker.push(...ROUTES);
    // The modern API exposes asset CONFIG, not a namespace identity. Recognize
    // exactly that config delta without claiming preservation of live bytes.
    const expectedAssetsMetadata = structuredClone(state.modern.assets);
    expectedAssetsMetadata.config.run_worker_first.push(...ROUTES);
    expected.assetsSHA256 = hash(canonical(expectedAssetsMetadata));
    expectations[app] = {
      bindingNames: bindings.map(x => x.name),
      resourceBindings: structuredClone(expected.bindings),
      scalarNames: [...expected.plainNames], scalarValueSHA256: structuredClone(expected.plainValueSHA256),
      effectiveTextSecretBudget: budget(bindings),
      assetsConfigSHA256: hash(canonical(expected.metadata.assets.config)),
      runtimeAssetsSHA256: hash(canonical(expected.runtime.assets)),
      expectedAssetsMetadata,
      assetsMetadataConfigOnlySHA256: expected.assetsSHA256,
    };
  }
  return freeze({ schemaVersion: 1, stage, offlineOnly: true, deploymentEnabled: false,
    liveNamespaceProof: false, serviceBindingProviderShapeQualified: false, selectedHtml: false, assetsUpload: false,
    remainingRemoteGates: ['Prove the retained live asset namespace and bytes separately from config-only metadata',
      'Qualify the exact default-HTTP service binding provider shape; no entrypoint normalization is admitted'],
    omittedScalars: [{ application: 'operations', name: OMIT, originalValueSHA256: hash('false'),
      reason: 'Missing and false both disable maintenance; free exactly one reviewed scalar slot.' }],
    configs, expectations, expectedProfile });
}

/** Exact complete provider poststate recognition, not evidence of installation.
 * Active version identifiers may advance, but every reviewed resource, scalar,
 * runtime/export, schedule and asset configuration must match. Modern asset
 * metadata is config only; this cannot prove the underlying live namespace. */
export function validateUiAdditivePreparationInstallation(snapshot, plan, baseline, options) {
  validateUiAdditiveReleasePlan(baseline, plan, options);
  return validateInstallation(snapshot, { profile: plan.expectedProfile });
}

export function validateUiAdditiveReleasePlan(snapshot, plan, options) {
  need(equal(plan, compileUiAdditiveReleasePlan(snapshot, options)), 'Reviewed preparation plan changed');
  return plan;
}
