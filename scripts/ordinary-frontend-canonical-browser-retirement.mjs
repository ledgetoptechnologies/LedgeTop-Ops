import { canonical, hash, need, ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256 } from './production-deploy.mjs';
import { NATIVE_DELIVERY_APP_PORTAL_OVERLAP_PRODUCTION_PROFILE,
  NATIVE_DELIVERY_APP_DELIVERY_OVERLAP_PRODUCTION_PROFILE } from '../apps/client/src/worker/operations-native-delivery-deployment.ts';

export const CANONICAL_BROWSER_RETIREMENT_SELECTOR = 'canonical-browser-retirement-v1';

const TARGETS = Object.freeze({
  operations: Object.freeze({
    OPERATIONS_ORIGINS: 'https://ops.ledgetop.app',
  }),
  client: Object.freeze({
    CLIENT_PORTAL_ORIGINS: 'https://portal.ledgetop.app',
    CLIENT_PORTAL_RETIRED_ORIGINS: 'https://portal.ledgetopdroneservices.com,https://portal.ledgetoptechnologies.com,https://client.ledgetopdroneservices.com',
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: NATIVE_DELIVERY_APP_DELIVERY_OVERLAP_PRODUCTION_PROFILE,
  }),
});

const SOURCE_VALUES = Object.freeze({
  operations: Object.freeze({
    OPERATIONS_ORIGINS: 'https://ops.ledgetop.app,https://ops.ledgetopdroneservices.com,https://ops.ledgetoptechnologies.com',
  }),
  client: Object.freeze({
    CLIENT_PORTAL_ORIGINS: 'https://portal.ledgetop.app,https://portal.ledgetopdroneservices.com,https://portal.ledgetoptechnologies.com',
    CLIENT_PORTAL_RETIRED_ORIGINS: 'https://client.ledgetopdroneservices.com',
    CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: NATIVE_DELIVERY_APP_PORTAL_OVERLAP_PRODUCTION_PROFILE,
  }),
});

const equal = (left, right) => canonical(left) === canonical(right);
const bindingBudget = rows => rows.filter(row => ['plain_text', 'json', 'secret_text', 'secret_key'].includes(row.type)).length;

/** Exact scalar delta for the ordinary retained release path. The accepted
 * predecessor profile remains the immutable v3 profile; no scalar is added,
 * removed, retyped, or omitted. */
export function compileCanonicalBrowserRetirementTransition(snapshot, { app, profile,
  selector = CANONICAL_BROWSER_RETIREMENT_SELECTOR, predecessorProfileSHA256 = hash(canonical(profile)),
  clientVersionId } = {}) {
  need(selector === CANONICAL_BROWSER_RETIREMENT_SELECTOR, 'Unknown canonical browser transition selector');
  need(['operations', 'client'].includes(app) && profile
    && predecessorProfileSHA256 === ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
  'Canonical browser transition requires the exact accepted v3 predecessor profile');
  const state = snapshot?.[app], spec = profile.workers?.[app];
  need(state?.version?.resources?.bindings && state?.settings?.bindings && spec,
    'Canonical browser transition requires the complete selected-worker installation');
  const source = SOURCE_VALUES[app], target = TARGETS[app], before = {}, changes = {};
  const expectedBindings = structuredClone(state.version.resources.bindings);
  for (const [name, targetValue] of Object.entries(target)) {
    const row = expectedBindings.find(binding => binding.name === name);
    const settingsRow = state.settings.bindings.find(binding => binding.name === name);
    need(row?.type === 'plain_text' && settingsRow?.type === 'plain_text'
      && row.text === source[name] && settingsRow.text === source[name]
      && spec.plainValueSHA256?.[name] === hash(source[name]),
    `Canonical browser transition predecessor drifted: ${name}`);
    before[name] = source[name];
    if (row.text !== targetValue) {
      changes[name] = targetValue;
      row.text = targetValue;
    }
  }
  if (app === 'client') {
    const nav = expectedBindings.find(binding => binding.name === 'CANONICAL_BROWSER_NAVIGATION_ENABLED');
    const navSettings = state.settings.bindings.find(binding => binding.name === 'CANONICAL_BROWSER_NAVIGATION_ENABLED');
    need(nav?.type === 'plain_text' && navSettings?.type === 'plain_text'
      && nav.text === 'true' && navSettings.text === 'true'
      && spec.plainValueSHA256?.CANONICAL_BROWSER_NAVIGATION_ENABLED === hash('true'),
    'Canonical browser navigation must already be enabled in the accepted profile');
    for (const name of ['PUBLIC_BASE_URL', 'PUBLIC_SHARE_ORIGIN', 'CLIENT_PORTAL_ORIGIN', 'LEGACY_CLIENT_ORIGINS']) {
      const row = expectedBindings.find(binding => binding.name === name);
      const settingsRow = state.settings.bindings.find(binding => binding.name === name);
      need(row?.type === 'plain_text' && settingsRow?.type === 'plain_text'
        && row.text === settingsRow.text && hash(row.text) === spec.plainValueSHA256?.[name],
      `Canonical browser transition cannot change or omit the preserved Client scalar ${name}`);
    }
  } else {
    const client = snapshot.client;
    need(typeof clientVersionId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(clientVersionId)
      && client?.version?.id === clientVersionId && client?.modern?.id === clientVersionId
      && client?.latest === clientVersionId && client?.deployment?.versions?.length === 1
      && client.deployment.versions[0].version_id === clientVersionId && client.deployment.versions[0].percentage === 100,
    'Operations retirement requires the exact active Client candidate version from the preceding canonical retirement release');
    for (const [name, value] of Object.entries(TARGETS.client)) {
      const row = client.version.resources.bindings.find(binding => binding.name === name);
      const settingsRow = client.settings.bindings.find(binding => binding.name === name);
      need(row?.type === 'plain_text' && settingsRow?.type === 'plain_text'
        && row.text === value && settingsRow.text === value,
      `Operations retirement requires the complete canonical Client predecessor tuple: ${name}`);
    }
    const nav = client.version.resources.bindings.find(binding => binding.name === 'CANONICAL_BROWSER_NAVIGATION_ENABLED');
    const navSettings = client.settings.bindings.find(binding => binding.name === 'CANONICAL_BROWSER_NAVIGATION_ENABLED');
    need(nav?.type === 'plain_text' && navSettings?.type === 'plain_text'
      && nav.text === 'true' && navSettings.text === 'true',
    'Operations retirement requires Client canonical browser navigation to remain enabled');
  }
  need(equal(expectedBindings.map(row => row.name).sort(), state.version.resources.bindings.map(row => row.name).sort())
    && bindingBudget(expectedBindings) === bindingBudget(state.version.resources.bindings)
    && bindingBudget(expectedBindings) <= 128,
  'Canonical browser transition changes binding capacity or the complete binding inventory');
  const clientRetirement = app === 'operations' ? Object.freeze({ versionId: clientVersionId,
    sourceScalars: SOURCE_VALUES.client, targetScalars: TARGETS.client }) : null;
  return Object.freeze({ selector, app, sourceScalars: Object.freeze(before), targetScalars: Object.freeze({ ...target }),
    changes: Object.freeze(changes), expectedBindings: Object.freeze(expectedBindings),
    ...(clientRetirement ? { clientRetirement } : {}),
    predecessorProfileSHA256,
    effectiveTextSecretBudget: bindingBudget(expectedBindings), activationEnabled: true });
}

/** Verifies a postactivation capture by restoring only the selected finite
 * scalar delta in a private clone, then passing the complete predecessor state
 * through the original 6073 profile validator. */
export function normalizeCanonicalBrowserRetirementPoststate(snapshot, before, transition,
  { includeSelectedTransition = true } = {}) {
  need(transition?.selector === CANONICAL_BROWSER_RETIREMENT_SELECTOR
    && transition.app && transition.sourceScalars && transition.targetScalars,
  'Pinned canonical browser transition required for poststate normalization');
  const normalized = structuredClone(snapshot);
  if (transition.app === 'operations' && transition.clientRetirement) {
    const { versionId, sourceScalars, targetScalars } = transition.clientRetirement;
    need(normalized.client?.version?.id === versionId && normalized.client?.modern?.id === versionId
      && normalized.client?.latest === versionId && before?.client?.version?.id === versionId,
    'Client retirement candidate identity changed across the Operations cutover');
    for (const [name, oldValue] of Object.entries(sourceScalars)) {
      const targetValue = targetScalars[name];
      for (const bindings of [normalized.client.version.resources.bindings, normalized.client.settings.bindings]) {
        const row = bindings.find(binding => binding.name === name);
        need(row?.type === 'plain_text' && row.text === targetValue,
          `Canonical Client predecessor tuple changed during Operations release: ${name}`);
        row.text = oldValue;
      }
    }
  }
  if (includeSelectedTransition) {
    const app = transition.app;
    for (const [name, oldValue] of Object.entries(transition.sourceScalars)) {
      const targetValue = transition.targetScalars[name];
      for (const bindings of [normalized[app]?.version?.resources?.bindings, normalized[app]?.settings?.bindings]) {
        const row = bindings?.find(binding => binding.name === name);
        need(row?.type === 'plain_text' && row.text === targetValue,
          `Canonical browser poststate has unexpected scalar ${name}`);
        row.text = oldValue;
      }
      const oldVersion = before?.[app]?.version?.resources?.bindings?.find(binding => binding.name === name);
      const oldSettings = before?.[app]?.settings?.bindings?.find(binding => binding.name === name);
      need(oldVersion?.type === 'plain_text' && oldSettings?.type === 'plain_text'
        && oldVersion.text === oldValue && oldSettings.text === oldValue,
      `Canonical browser predecessor scalar evidence is incomplete: ${name}`);
    }
  }
  return normalized;
}

export function normalizeCanonicalBrowserRetirementPredecessor(snapshot, transition) {
  need(transition?.selector === CANONICAL_BROWSER_RETIREMENT_SELECTOR,
    'Pinned canonical browser transition required for predecessor normalization');
  const normalized = structuredClone(snapshot);
  if (transition.app === 'operations' && transition.clientRetirement) {
    const { versionId, sourceScalars, targetScalars } = transition.clientRetirement;
    need(normalized.client?.version?.id === versionId && normalized.client?.modern?.id === versionId
      && normalized.client?.latest === versionId && normalized.client?.deployment?.versions?.length === 1
      && normalized.client.deployment.versions[0].version_id === versionId
      && normalized.client.deployment.versions[0].percentage === 100,
    'Operations predecessor requires the exact active Client candidate version');
    for (const [name, oldValue] of Object.entries(sourceScalars)) for (const bindings of [
      normalized.client.version.resources.bindings, normalized.client.settings.bindings,
    ]) {
      const row = bindings.find(binding => binding.name === name);
      need(row?.type === 'plain_text' && row.text === targetScalars[name],
        `Operations predecessor lacks the complete Client retirement tuple: ${name}`);
      row.text = oldValue;
    }
  }
  return normalized;
}

export function validateCanonicalBrowserRetirementTarget(transition, expectedBindings) {
  need(transition?.selector === CANONICAL_BROWSER_RETIREMENT_SELECTOR
    && equal(expectedBindings, transition.expectedBindings),
  'Canonical browser candidate bindings differ from the exact finite transition');
  return true;
}
