import { PROFILE, hash, canonical, need, validateInstallation } from './production-deploy.mjs';

// A finite nonsecret recognition declaration, not a settings writer. The CLI
// selects a recognized installed phase; it never applies these scalar values.
const DOMAIN_PHASES = Object.freeze({
  'portal-overlap': {
    operations: {
      OPERATIONS_ORIGINS: 'https://ops.ledgetop.app,https://ops.ledgetopdroneservices.com,https://ops.ledgetoptechnologies.com',
      CLIENT_PORTAL_ORIGINS: 'https://portal.ledgetop.app,https://portal.ledgetopdroneservices.com,https://portal.ledgetoptechnologies.com,https://client.ledgetopdroneservices.com',
    },
    client: {
      CLIENT_PORTAL_ORIGIN: 'https://portal.ledgetop.app',
      CLIENT_PORTAL_ORIGINS: 'https://portal.ledgetop.app,https://portal.ledgetopdroneservices.com,https://portal.ledgetoptechnologies.com',
      CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_EXPECTED_HOST: 'portal.ledgetop.app',
      CLIENT_PORTAL_OPERATIONS_NATIVE_AUTHORITY_EXPECTED_HOST: 'portal.ledgetop.app',
      CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE: '{"version":1,"accountId":"846c924bf17bf4f3dd15c97a4c5d1d51","workerName":"ledgetop-clients","databaseBinding":"DELIVERY_DB","databaseId":"7f40a7b7-c3ec-470e-a626-e798867f71f8","portalOrigin":"https://portal.ledgetop.app","publicShareOrigin":"https://portal.ledgetopdroneservices.com","privateRequestOrigins":["https://portal.ledgetop.app","https://portal.ledgetopdroneservices.com"]}',
    },
  },
});
const portal = DOMAIN_PHASES['portal-overlap'];
// Explicit finite states below; arbitrary overrides are rejected.
const phases = {
  baseline: { operations: {}, client: {} },
  'ops-alias-preparation': { operations: portal.operations, client: {} },
  'client-private-overlap': portal,
  'portal-entry-canonical': { operations: { ...portal.operations,
    DELIVERY_BASE_URL: 'https://portal.ledgetop.app',
  }, client: portal.client },
  'staff-canonical': { operations: { ...portal.operations,
    DELIVERY_BASE_URL: 'https://portal.ledgetop.app',
    PUBLIC_BASE_URL: 'https://ops.ledgetop.app', EXPECTED_HOST: 'ops.ledgetop.app',
    CLIENT_ONBOARDING_ADMIN_ORIGIN: 'https://ops.ledgetop.app',
  }, client: portal.client },
};
export function domainPhaseValues(phase) {
  need(Object.hasOwn(phases, phase), 'Unknown reviewed domain phase');
  return structuredClone(phases[phase]);
}
export function domainRecognitionProfile(phase, baseline = PROFILE) {
  const values = domainPhaseValues(phase), profile = structuredClone(baseline);
  for (const [app, vars] of Object.entries(values)) for (const [name, value] of Object.entries(vars)) {
    need(profile.workers[app].plainNames.includes(name), 'Domain phase cannot add a scalar');
    profile.workers[app].plainValueSHA256[name] = hash(value);
  }
  if (phase === 'staff-canonical') profile.onboardingAdminOrigin = 'https://ops.ledgetop.app';
  return profile;
}
export function validateDomainSnapshot(snapshot, phase) {
  return validateInstallation(snapshot, { profile: domainRecognitionProfile(phase) });
}
export function domainRecognitionDiff(phase) {
  const profile = domainRecognitionProfile(phase), values = domainPhaseValues(phase);
  return { phase, writesPerformed: false, deploymentEnabled: false,
    scalarValues: values,
    preservedResourceProfileSHA256: hash(canonical(Object.fromEntries(Object.entries(PROFILE.workers).map(([app,w]) => [app, {bindings:w.bindings,settings:w.settings,script:w.script,runtime:w.runtime,crons:w.crons,assetsSHA256:w.assetsSHA256}])))),
    frontendSHA256: profile.frontendSHA256 };
}
