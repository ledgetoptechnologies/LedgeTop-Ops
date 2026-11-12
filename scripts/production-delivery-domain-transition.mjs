import { PROFILE, ORDINARY_FRONTEND_PREFLIGHT_MODE, canonical, hash, need, validateInstallation, varsOf } from './production-deploy.mjs';
import { domainPhaseValues, domainRecognitionProfile } from './production-domain-recognition.mjs';

const FROM = 'portal-entry-canonical', TO = 'delivery-public-canonical';
const CHANGED = Object.freeze(['EXPECTED_HOST', 'PUBLIC_BASE_URL', 'PUBLIC_SHARE_ORIGIN',
  'LEGACY_CLIENT_ORIGINS', 'CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE']);

function validateDomainInstallation(snapshot, profile, ordinaryFrontendPreflightProfile) {
  if (ordinaryFrontendPreflightProfile === undefined) return validateInstallation(snapshot, { profile });
  return validateInstallation(snapshot, { profile, ordinaryFrontendPreflightProfile,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE, ordinaryFrontendApp: 'client' });
}

/** Offline declaration only. No reader, writer, deployment, credentials or
 * environment-driven override. The input must already match the exact approved
 * before profile; unknown changes never become a new baseline automatically.
 * Full private snapshots/settings must remain in the operator's private records.
 */
export function compileDeliveryDomainTransition(snapshot, baseline = PROFILE, { ordinaryFrontendPreflightProfile } = {}) {
  const beforeProfile = domainRecognitionProfile(FROM, baseline);
  const afterProfile = domainRecognitionProfile(TO, baseline);
  validateDomainInstallation(snapshot, beforeProfile, ordinaryFrontendPreflightProfile);
  const current = varsOf(snapshot.client);
  const target = domainPhaseValues(TO).client;
  const changes = Object.fromEntries(CHANGED.map(name => {
    need(typeof current[name] === 'string' && typeof target[name] === 'string', 'Delivery transition requires existing exact scalars');
    need(current[name] !== target[name], 'Delivery transition must start at the complete old public tuple');
    return [name, target[name]];
  }));
  for (const [app, spec] of Object.entries(beforeProfile.workers)) {
    const permitted = app === 'client' ? CHANGED : [];
    for (const [name, digest] of Object.entries(spec.plainValueSHA256))
      need(permitted.includes(name) || digest === afterProfile.workers[app].plainValueSHA256[name],
        'Delivery transition changes an unrelated scalar');
    const stripScalars = value => { const copy = structuredClone(value); delete copy.plainValueSHA256; return copy; };
    need(canonical(stripScalars(spec)) === canonical(stripScalars(afterProfile.workers[app])),
      'Delivery transition changes resources/runtime/assets');
  }
  const expected = structuredClone(snapshot);
  for (const bindings of [expected.client.version.resources.bindings, expected.client.settings.bindings]) {
    for (const name of CHANGED) {
      const binding = bindings.find(row => row.name === name);
      need(binding?.type === 'plain_text', 'Delivery transition cannot create or retype a binding');
      binding.text = changes[name];
    }
  }
  validateDomainInstallation(expected, afterProfile, ordinaryFrontendPreflightProfile);
  return { from: FROM, to: TO, worker: 'client', writesPerformed: false, activationEnabled: false,
    redirectEnabled: false, changes, expected, beforeProfile, afterProfile,
    // This complete settings draft preserves every original setting/binding;
    // callers must not replace it with a partial plain-text bindings document.
    settingsDraft: structuredClone(expected.client.settings),
    ...(ordinaryFrontendPreflightProfile === undefined ? {} : { ordinaryFrontendPreflightProfileSHA256: hash(canonical(ordinaryFrontendPreflightProfile)) }),
    unchangedOperationsSHA256: hash(canonical(snapshot.operations)),
    unchangedSyncSHA256: hash(canonical(snapshot['ops-sync'])),
    liveAcceptanceStillRequired: true };
}

/** Distinct offline next-step draft, not proof that Client acceptance passed.
 * Operators must retain actual synthetic public acceptance evidence before
 * applying any settings. This function performs no control-plane operation. */
export function compileDeliveryPublicLinkTransition(snapshot, baseline = PROFILE, { ordinaryFrontendPreflightProfile } = {}) {
  const from = TO, to = 'delivery-links-canonical';
  const beforeProfile = domainRecognitionProfile(from, baseline);
  const afterProfile = domainRecognitionProfile(to, baseline);
  validateDomainInstallation(snapshot, beforeProfile, ordinaryFrontendPreflightProfile);
  const value = domainPhaseValues(to).operations.PUBLIC_SHARE_ORIGIN;
  need(varsOf(snapshot.operations).PUBLIC_SHARE_ORIGIN === 'https://portal.ledgetopdroneservices.com',
    'Public link transition must start at the old public link origin');
  const expected = structuredClone(snapshot);
  for (const bindings of [expected.operations.version.resources.bindings, expected.operations.settings.bindings]) {
    const binding = bindings.find(row => row.name === 'PUBLIC_SHARE_ORIGIN');
    need(binding?.type === 'plain_text', 'Public link transition requires existing plain scalar');
    binding.text = value;
  }
  validateDomainInstallation(expected, afterProfile, ordinaryFrontendPreflightProfile);
  return { from, to, worker: 'operations', writesPerformed: false, activationEnabled: false, redirectEnabled: false,
    changes: { PUBLIC_SHARE_ORIGIN: value }, expected, beforeProfile, afterProfile,
    settingsDraft: structuredClone(expected.operations.settings),
    ...(ordinaryFrontendPreflightProfile === undefined ? {} : { ordinaryFrontendPreflightProfileSHA256: hash(canonical(ordinaryFrontendPreflightProfile)) }),
    clientPublicAcceptanceRequiredBeforeApply: true, liveAcceptanceStillRequired: true };
}

/** Offline final Ops transition. Public link generation has its own earlier
 * phase, so this changes only the existing Ops entry/callback origin scalars.
 * It is a plan for review, never a settings writer. */
export function compileOperationsCanonicalTransition(snapshot, baseline = PROFILE, { ordinaryFrontendPreflightProfile } = {}) {
  const from = 'delivery-links-canonical', to = 'staff-canonical';
  const beforeProfile = domainRecognitionProfile(from, baseline);
  const afterProfile = domainRecognitionProfile(to, baseline);
  validateDomainInstallation(snapshot, beforeProfile, ordinaryFrontendPreflightProfile);
  const current = varsOf(snapshot.operations);
  const target = domainPhaseValues(to).operations;
  const names = ['PUBLIC_BASE_URL', 'EXPECTED_HOST', 'CLIENT_ONBOARDING_ADMIN_ORIGIN'];
  const old = {
    PUBLIC_BASE_URL: 'https://ops.ledgetopdroneservices.com',
    EXPECTED_HOST: 'ops.ledgetopdroneservices.com',
    CLIENT_ONBOARDING_ADMIN_ORIGIN: 'https://ops.ledgetopdroneservices.com',
  };
  const changes = Object.fromEntries(names.map(name => {
    need(current[name] === old[name], 'Ops canonical transition must start at the complete old staff-origin tuple');
    need(typeof target[name] === 'string', 'Ops canonical transition requires existing exact scalars');
    return [name, target[name]];
  }));
  const expected = structuredClone(snapshot);
  for (const bindings of [expected.operations.version.resources.bindings, expected.operations.settings.bindings])
    for (const [name, value] of Object.entries(changes)) {
      const binding = bindings.find(row => row.name === name);
      need(binding?.type === 'plain_text', 'Ops canonical transition cannot create or retype a binding');
      binding.text = value;
    }
  validateDomainInstallation(expected, afterProfile, ordinaryFrontendPreflightProfile);
  return { from, to, worker: 'operations', writesPerformed: false, activationEnabled: false,
    redirectEnabled: false, changes, expected, beforeProfile, afterProfile,
    settingsDraft: structuredClone(expected.operations.settings),
    ...(ordinaryFrontendPreflightProfile === undefined ? {} : { ordinaryFrontendPreflightProfileSHA256: hash(canonical(ordinaryFrontendPreflightProfile)) }),
    publicShareOriginPreserved: 'https://delivery.ledgetop.app',
    clientPublicAcceptanceRequiredBeforeApply: true,
    operationsCanonicalWorkerCandidateRequiredBeforeApply: true,
    callbackPreservationWorkerMustPrecedeScalarTransition: true,
    preCallbackPreservationStatesMustExpireOrSettle: true,
    providerMustAllowCanonicalCallbackUriBeforeTransition: true,
    liveAcceptanceStillRequired: true };
}
