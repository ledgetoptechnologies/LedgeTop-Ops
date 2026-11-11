import { readFileSync } from 'node:fs';

export const MANIFEST_PATH = new URL('../docs/cloudflare/legacy-public-routing-cutover.json', import.meta.url);
export const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));

const allowedPrefixes = manifest.routing.legacyDelivery.patterns.map(pattern => {
  const slash = pattern.indexOf('/');
  const host = pattern.slice(0, slash);
  const path = pattern.slice(slash);
  return { host, prefix: path.slice(0, -1) };
});

/** Model host/path route matching. The wildcard is a path-prefix wildcard;
 * query strings do not broaden a path match. */
export function legacyDeliveryRouteMatches(input) {
  const url = input instanceof URL ? input : new URL(input);
  return allowedPrefixes.some(({ host, prefix }) => url.hostname === host && url.pathname.startsWith(prefix));
}

export function validateManifest(value = manifest) {
  const errors = [];
  const expectedPatterns = [
    'delivery.ledgetopdroneservices.com/s/*',
    'delivery.ledgetopdroneservices.com/client-share/*',
    'delivery.ledgetopdroneservices.com/api/public/*',
    'delivery.ledgetopdroneservices.com/assets/*',
  ];
  const expectedRedirects = [
    ['legacy-delivery-host-broad-redirect', 'ledgetopdroneservices.com'],
    ['legacy-technologies-portal-broad-redirect', 'ledgetoptechnologies.com'],
  ];
  const patternSet = [...(value.routing?.legacyDelivery?.patterns ?? [])].sort();
  if (value.schemaVersion !== 1 || value.status !== 'proposal-source-only') errors.push('manifest must remain a source-only v1 proposal');
  if (value.routing.legacyDelivery.worker !== 'ledgetop-clients') errors.push('legacy delivery must target the Client Worker');
  if (JSON.stringify(patternSet) !== JSON.stringify([...expectedPatterns].sort()))
    errors.push('legacy delivery patterns must contain the exact production hostname and four public prefixes');
  if (value.routing.legacyTechnologiesPortal.existingCustomDomain !== value.legacyTechnologiesPortalHost
    || value.routing.legacyTechnologiesPortal.addOrRemoveWorkerRoute !== false)
    errors.push('Technologies portal custom domain must remain an existing domain without route mutation');
  if (!Array.isArray(value.redirectRules) || value.redirectRules.length !== expectedRedirects.length
    || expectedRedirects.some(([role, zone]) => !value.redirectRules.some(rule => rule.role === role && rule.zone === zone
      && rule.ruleId === null && rule.ruleIdStatus === 'must-be-filled-from-fresh-readback')))
    errors.push('exactly the two intended zone/role targets must remain unresolved until production fresh readback');
  if (JSON.stringify(value.workerAdmission.headers) !== JSON.stringify(['Cookie', 'Authorization', 'Range', 'If-Range', 'Origin']))
    errors.push('host-bound session and range header set must remain exact');
  if (JSON.stringify(value.workerAdmission.legacyDeliveryHost) !== JSON.stringify(['/s/*', '/client-share/*', '/api/public/*', '/assets/*'])
    || !value.workerAdmission.capabilityQueryHandling.includes('Preserve request query unchanged at the legacy host'))
    errors.push('Worker admission paths and legacy capability-query handling must remain exact');
  if (value.staging?.deliveryHost !== 'delivery-staging.ledgetopdroneservices.com'
    || value.staging?.technologiesPortalHost !== 'portal-staging.ledgetoptechnologies.com'
    || value.staging?.productionRuleChangesAllowed !== false) errors.push('staging must be a distinct no-production-mutation phase');
  const gates = value.gates.join('\n');
  if (!gates.includes('SHA-256 hashes') || !gates.includes('48 hours') || !gates.includes('binding names/presence')
    || !gates.includes('Never read, print, compare, or copy secret values'))
    errors.push('staging and production asset hash, binding-only secret, and retention gates are required');
  const sessionGate = gates.match(/Phase 2 - production preproof: using synthetic identities[^\n]*/)?.[0] ?? '';
  if (!sessionGate.includes('browser does not send each __Host- cookie to the other host')
    || !sessionGate.includes('requests with no valid cookie are denied')
    || !sessionGate.includes('Do not claim the signed cookie payload is cryptographically hostname-bound')
    || sessionGate.includes('a cookie/session from one host is denied on the other'))
    errors.push('session gate must test browser cookie scope and unauthenticated denial without asserting cryptographic host binding');
  const orderedGates = [
    'Phase 1 - staging only: fresh-read',
    'Phase 1 - staging only: verify non-secret',
    'Phase 1 - staging only: deploy/route',
    'Phase 1 - staging only: inventory exact old and new browser asset URLs',
    'Phase 2 - production preparation:',
    'Phase 2 - production preproof: inventory every exact old asset URL',
    'Phase 2 - production preproof: using synthetic identities',
    'Phase 2 - production cutover: add only the four exact legacy delivery Worker routes',
    'Phase 2 - production cutover: only after route-state readback succeeds, disable exactly the two reviewed broad redirect IDs',
    'Record actual production cutover time',
  ];
  const positions = orderedGates.map(gate => gates.indexOf(gate));
  if (positions.some(position => position < 0) || positions.some((position, i) => i > 0 && position <= positions[i - 1]))
    errors.push('staging phase must precede production preparation');
  const rollback = value.rollback.join('\n');
  if (!value.rollback[0]?.includes('Re-enable the two recorded production broad redirect rule IDs')
    || !value.rollback[0]?.includes('before removing any of the four added Worker routes')
    || !value.rollback[1]?.startsWith('After redirect state is confirmed')
    || !value.rollback[1]?.includes('remove only the four routes'))
    errors.push('rollback must restore and verify redirects before route removal');
  if (value.activation.automatic !== false || value.activation.providerMutation !== false
    || value.activation.requiredFreshReadback !== true) errors.push('manifest must not auto-activate or mutate providers');
  if (!value.rollback.length || !value.rollback.some(step => step.includes('secret values')))
    errors.push('rollback and secret-value protections are required');
  return errors;
}

if (process.argv[1] && new URL(`file://${process.argv[1].replaceAll('\\', '/')}`).href === import.meta.url) {
  const errors = validateManifest();
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else {
    console.log('Legacy public routing manifest is structurally valid; provider IDs and activation remain gated on fresh readback.');
  }
}
