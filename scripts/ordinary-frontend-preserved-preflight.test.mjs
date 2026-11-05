import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORDINARY_FRONTEND_PREFLIGHT_MODE,
  ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
  ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
  CANONICAL_INSTALLED_PROFILE_V4_SHA256,
  PROFILE,
  hash,
  canonical,
  ordinaryFrontendPreflightDescriptor,
  validateOrdinaryFrontendPreflightPreservation,
  validateCanonicalV4AssetAssociation,
  validateCanonicalV4AssetAssociationMetadata,
  validateInstallation,
  compileConfig,
} from './production-deploy.mjs';
import { eligibilityFlags } from './client-portal-release-profile.mjs';
import { validatePortalReleasePreflight } from '../apps/client/scripts/project-alpha-portal-receiver-preflight.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const acceptedProfile = JSON.parse(fs.readFileSync(path.join(HERE, 'test-fixtures/ordinary-frontend-accepted-profile-v3.test.json'), 'utf8'));
const acceptedCanonicalV4Profile = JSON.parse(fs.readFileSync(path.join(HERE, 'test-fixtures/ordinary-frontend-accepted-profile-v4.test.json'), 'utf8'));
const declaration = JSON.parse(fs.readFileSync(path.join(HERE, 'client-portal-release-profile.json'), 'utf8'));
const clone = value => structuredClone(value);
const viewerFlag = 'CLIENT_VIEWER_ENABLED';
const hierarchyFlag = 'CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED';

function syntheticPortalVars() {
  const client = Object.fromEntries(eligibilityFlags.map(flag => [flag, 'true']));
  const operations = Object.fromEntries(eligibilityFlags.map(flag => [flag, 'true']));
  Object.assign(client, {
    PROJECT_ALPHA_PORTAL_SYNC_ENABLED: 'true',
    PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED: 'false',
    CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: 'true',
    PROJECT_ALPHA_PORTAL_APPLICATION_KEY: 'synthetic-safe-id',
    CLIENT_PORTAL_CONTENT_AUDIT_ENABLED: 'false',
    CLIENT_PORTAL_REQUEST_V2_ENABLED: 'false',
    CLIENT_PORTAL_OPS_INQUIRIES_ENABLED: 'false',
    CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED: 'false',
    PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED: 'false',
    CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED: 'false',
    CLIENT_REQUEST_ATTACHMENTS_ENABLED: 'false',
    CLIENT_PORTAL_TEAM_ENABLED: 'false',
    CLIENT_VIEWER_ENABLED: 'true',
    CLIENT_VIEWER_SHARES_ENABLED: 'false',
    CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: 'false',
    CLIENT_PORTAL_PEER_ADMIN_ENABLED: 'false',
    CLIENT_PORTAL_ADDRESS_BOOK_ENABLED: 'false',
    CLIENT_PORTAL_ACCESS_ENROLLMENT_READY: 'false',
    CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: 'false',
    CLIENT_DELEGATED_SHARES_ENABLED: 'false',
    CLIENT_PORTAL_HIERARCHY_V2_ENABLED: 'true',
    CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: 'true',
    CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: 'true',
    CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: 'true',
    CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: 'true',
    AUTHENTICATED_DELIVERY_GRANTS_ENABLED: 'true',
    PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED: 'false',
    AUTHENTICATED_DELIVERY_CREATION_ENABLED: 'false',
    AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: 'false',
  });
  Object.assign(operations, {
    ENVIRONMENT: 'production',
    CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: 'true',
    AUTHENTICATED_DELIVERY_GRANTS_ENABLED: 'true',
    PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED: 'true',
    AUTHENTICATED_DELIVERY_CREATION_ENABLED: 'true',
    AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: 'false',
    PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED: 'false',
    CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: 'false',
    PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED: 'false',
    PROJECT_ALPHA_DELIVERY_GUEST_ENABLED: 'false',
  });
  client.ENVIRONMENT = 'production';
  client.CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED = 'false';
  client.CLIENT_PORTAL_PEER_ADMIN_ENABLED = 'false';
  client.CLIENT_PORTAL_ADDRESS_BOOK_ENABLED = 'false';
  client.CLIENT_PORTAL_INVITATION_EMAIL_ENABLED = 'false';
  client.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED = 'true';
  client.AUTHENTICATED_DELIVERY_GRANTS_ENABLED = 'true';
  client.PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED = 'false';
  client.AUTHENTICATED_DELIVERY_CREATION_ENABLED = 'false';
  client.AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED = 'false';
  client.PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED = 'false';
  return { client, operations };
}

test('accepted installed profile fixture is hash-only and pins the two retained true flags', () => {
  assert.equal(hash(canonical(acceptedProfile)), ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256);
  for (const [app, name] of [['operations', hierarchyFlag], ['client', viewerFlag]]) {
    assert.ok(acceptedProfile.workers[app].plainNames.includes(name));
    assert.equal(acceptedProfile.workers[app].plainValueSHA256[name], hash('true'));
  }
  const hasRawValueField = value => Array.isArray(value) ? value.some(hasRawValueField)
    : value && typeof value === 'object'
      ? Object.entries(value).some(([key, child]) => ['text','secretValue','plainValues','apiToken','accessToken','privateKey'].includes(key) || hasRawValueField(child))
      : false;
  assert.equal(hasRawValueField(acceptedProfile), false);
});

test('canonical v4 installed profile is a separately pinned hash-only ordinary preflight profile', () => {
  assert.equal(hash(canonical(acceptedCanonicalV4Profile)), CANONICAL_INSTALLED_PROFILE_V4_SHA256);
  for (const [app, name] of [['operations', hierarchyFlag], ['client', viewerFlag]]) {
    assert.ok(acceptedCanonicalV4Profile.workers[app].plainNames.includes(name));
    assert.equal(acceptedCanonicalV4Profile.workers[app].plainValueSHA256[name], hash('true'));
  }
  const hasRawValueField = value => Array.isArray(value) ? value.some(hasRawValueField)
    : value && typeof value === 'object'
      ? Object.entries(value).some(([key, child]) => ['text','secretValue','plainValues','apiToken','accessToken','privateKey'].includes(key) || hasRawValueField(child))
      : false;
  assert.equal(hasRawValueField(acceptedCanonicalV4Profile), false);
});

test('ordinary UI preflight is explicit, statically pinned, and only normalizes a private preflight copy', () => {
  const { client, operations } = syntheticPortalVars();
  const installedClient = { ...client }; delete installedClient.CLIENT_PORTAL_OPS_INQUIRIES_ENABLED;
  const before = { client: clone(installedClient), operations: clone(operations) };
  const strictErrors = validatePortalReleasePreflight(
    { name: 'ledgetop-clients', keep_vars: true, vars: client },
    { name: 'ledgetop-ops', keep_vars: true, vars: operations },
    declaration,
  );
  assert.deepEqual(strictErrors, [
    'Operations CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED must be exactly false for primary-explicit-folder-delivery',
    'CLIENT_VIEWER_ENABLED must remain exactly false for the portal release',
  ]);
  assert.deepEqual(ordinaryFrontendPreflightDescriptor(acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), {
    mode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
    profileSHA256: ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
  });
  assert.deepEqual(ordinaryFrontendPreflightDescriptor(acceptedCanonicalV4Profile, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE), {
    mode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
    profileSHA256: CANONICAL_INSTALLED_PROFILE_V4_SHA256,
  });
  assert.deepEqual(validateOrdinaryFrontendPreflightPreservation(installedClient, operations, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), {
    mode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
    profileSHA256: ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
  });
  assert.deepEqual(validateOrdinaryFrontendPreflightPreservation(installedClient, operations, acceptedCanonicalV4Profile,
    ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE), {
    mode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
    profileSHA256: CANONICAL_INSTALLED_PROFILE_V4_SHA256,
  });
  assert.deepEqual({ client: installedClient, operations }, before);
  assert.deepEqual(validatePortalReleasePreflight(
    { name: 'ledgetop-clients', keep_vars: true, vars: client },
    { name: 'ledgetop-ops', keep_vars: true, vars: operations },
    declaration,
  ), strictErrors);
});

test('ordinary UI compatibility rejects missing, unknown, altered-profile, or changed preserved flags', () => {
  const { client, operations } = syntheticPortalVars();
  const installedClient = { ...client }; delete installedClient.CLIENT_PORTAL_OPS_INQUIRIES_ENABLED;
  assert.deepEqual(ordinaryFrontendPreflightDescriptor(acceptedProfile, undefined), {
    mode: 'strict-default', profileSHA256: null,
  });
  assert.throws(() => ordinaryFrontendPreflightDescriptor(acceptedProfile, 'ordinary-frontend-any-profile'), /Unreviewed ordinary frontend preflight mode/);
  assert.throws(() => ordinaryFrontendPreflightDescriptor(PROFILE, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Unreviewed ordinary frontend accepted profile/);
  assert.throws(() => ordinaryFrontendPreflightDescriptor(acceptedCanonicalV4Profile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Unreviewed ordinary frontend accepted profile/);
  assert.throws(() => ordinaryFrontendPreflightDescriptor(acceptedProfile, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE), /Unreviewed ordinary frontend accepted profile/);
  const mutatedProfile = clone(acceptedProfile);
  mutatedProfile.workers.operations.script.named_handlers.find(row => row.name === 'ViewerSessionIssuer').handlers.pop();
  assert.throws(() => ordinaryFrontendPreflightDescriptor(mutatedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Unreviewed ordinary frontend accepted profile/);
  const mutatedV4Profile = clone(acceptedCanonicalV4Profile);
  mutatedV4Profile.workers.client.plainValueSHA256[viewerFlag] = hash('false');
  assert.throws(() => ordinaryFrontendPreflightDescriptor(mutatedV4Profile, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE), /Unreviewed ordinary frontend accepted profile/);
  const wrongValueProfile = clone(acceptedProfile);
  wrongValueProfile.workers.client.plainValueSHA256[viewerFlag] = hash('false');
  assert.throws(() => ordinaryFrontendPreflightDescriptor(wrongValueProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Unreviewed ordinary frontend accepted profile/);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation(client, operations, acceptedProfile), /Unreviewed ordinary frontend preflight mode/);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation({ ...installedClient, [viewerFlag]: false }, operations, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Client viewer flag differs/);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation({ ...installedClient, [viewerFlag]: 'false' }, operations, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Client viewer flag differs/);
  for (const value of ['false','true']) assert.throws(() => validateOrdinaryFrontendPreflightPreservation(
    { ...installedClient, CLIENT_PORTAL_OPS_INQUIRIES_ENABLED: value }, operations, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE),
  /default-off inquiries flag to remain absent/u);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation(installedClient, { ...operations, [hierarchyFlag]: 'false' }, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Operations hierarchy flag differs/);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation({ ...installedClient, CLIENT_PORTAL_CONTENT_AUDIT_ENABLED: 'true' }, operations, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Effective production release profile rejected/);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation(installedClient, { ...operations, AUTHENTICATED_DELIVERY_GRANTS_ENABLED: 'false' }, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Effective production release profile rejected/);
});

test('generic installation/config compilers reject ordinary mode unless the exact accepted profile is supplied', () => {
  assert.throws(() => validateInstallation({}, {
    profile: PROFILE,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'operations',
  }), /Unreviewed ordinary frontend accepted profile/);
  assert.throws(() => compileConfig({}, 'operations', '/not-uploaded/index.js', PROFILE, undefined,
    ORDINARY_FRONTEND_PREFLIGHT_MODE), /Unreviewed ordinary frontend accepted profile/);
  assert.throws(() => validateInstallation({}, {
    profile: acceptedProfile,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'ops-sync',
  }), /limited to Operations or Client UI plans/);
  assert.throws(() => validateInstallation({}, {
    profile: acceptedProfile,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'operations',
  }), /Existing complete production installation required/);
  assert.throws(() => validateInstallation({}, {
    profile: acceptedCanonicalV4Profile,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'operations',
  }), /Existing complete production installation required/);
  assert.throws(() => validateInstallation({}, {
    profile: acceptedCanonicalV4Profile,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'operations',
  }), /Unreviewed ordinary frontend accepted profile/);
  assert.throws(() => compileConfig({}, 'operations', '/not-uploaded/index.js', acceptedCanonicalV4Profile, undefined,
    ORDINARY_FRONTEND_PREFLIGHT_MODE), /Unreviewed ordinary frontend accepted profile/);
});

test('canonical v4 installed controls admit only an exact ops-sync capture and retain preserved flag checks', () => {
  const exactV4 = {
    profile: acceptedCanonicalV4Profile,
    selectedApp: 'ops-sync',
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'ops-sync',
  };
  // Reaching the complete-installation check proves the exact v4 sync context
  // passed its mode/profile/app gate; all existing installation checks follow.
  assert.throws(() => validateInstallation({}, exactV4), /Existing complete production installation required/);

  const alteredProfile = clone(acceptedCanonicalV4Profile);
  alteredProfile.workers['ops-sync'].plainValueSHA256.ENVIRONMENT = hash('production');
  assert.throws(() => validateInstallation({}, { ...exactV4, profile: alteredProfile }),
    /Unreviewed ordinary frontend accepted profile/);

  assert.throws(() => validateInstallation({}, { ...exactV4, profile: acceptedProfile,
    ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_PREFLIGHT_MODE }),
  /limited to Operations or Client UI plans/);
  assert.throws(() => validateInstallation({}, { ...exactV4, ordinaryFrontendApp: 'unknown-worker' }),
    /limited to Operations or Client UI plans/);
  assert.throws(() => validateInstallation({}, { ...exactV4, selectedApp: 'operations' }),
    /limited to Operations or Client UI plans/);
  assert.throws(() => validateInstallation({}, { ...exactV4, selectedApp: undefined, ordinaryFrontendApp: 'operations',
    assetAssociationOverrides: { operations: { baselineAssets: { config: {} } } } }), /Existing complete production installation required/,
  'asset association rebasing is accepted only after the exact v4 profile pin is validated');
  assert.throws(() => validateInstallation({}, { ...exactV4, selectedApp: undefined, ordinaryFrontendApp: 'operations',
    assetAssociationOverrides: { operations: { baselineAssets: { config: {} } } }, profile: { ...acceptedCanonicalV4Profile,
      onboardingAdminOrigin: 'https://tampered.invalid' } }), /Unreviewed ordinary frontend accepted profile/);
  assert.throws(() => validateInstallation({}, { ...exactV4, ordinaryFrontendApp: 'operations',
    assetAssociationOverrides: { client: 'f'.repeat(64) } }), /Unreviewed canonical v4 asset association override/);

  const { client, operations } = syntheticPortalVars();
  const installedClient = { ...client }; delete installedClient.CLIENT_PORTAL_OPS_INQUIRIES_ENABLED;
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation(installedClient,
    { ...operations, [hierarchyFlag]: 'false' }, acceptedCanonicalV4Profile,
    ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE), /Operations hierarchy flag differs/);
});

test('canonical v4 asset rebasing keeps every config control and permits only the pinned jwt association field to vary', () => {
  const baseline = { config: { base_path: '/', run_worker_first: ['/api/*'], html_handling: 'auto-trailing-slash' }, jwt: 'old-association' };
  const candidate = { config: clone(baseline.config), jwt: 'candidate-association' };
  assert.equal(validateCanonicalV4AssetAssociationMetadata(baseline, candidate), true);
  for (const changed of [
    { ...candidate, config: { ...candidate.config, run_worker_first: ['/other/*'] } },
    { ...candidate, config: { ...candidate.config, html_handling: 'none' } },
    { ...candidate, unexpected: 'unreviewed' },
    { config: clone(candidate.config) },
  ]) assert.throws(() => validateCanonicalV4AssetAssociationMetadata(baseline, changed), /asset association/u);
  assert.throws(() => validateCanonicalV4AssetAssociationMetadata(baseline, { ...candidate, config: {
    ...candidate.config, run_worker_first: ['/api/*', '/unreviewed/*'] } }), /asset association/u);
  const profileBaseline = { config: clone(acceptedCanonicalV4Profile.workers.operations.metadata.assets.config) };
  assert.throws(() => validateCanonicalV4AssetAssociation({ profile: acceptedCanonicalV4Profile, app: 'client',
    baselineAssets: profileBaseline, candidateAssets: profileBaseline }), /asset baseline/u,
  'the Operations baseline association cannot be substituted into Client or another worker profile');
  const alteredProfile = clone(acceptedCanonicalV4Profile); alteredProfile.workers.operations.assetsSHA256 = 'f'.repeat(64);
  assert.throws(() => validateCanonicalV4AssetAssociation({ profile: alteredProfile, app: 'operations',
    baselineAssets: profileBaseline, candidateAssets: profileBaseline }), /asset profile/u,
  'an altered v4 profile never authorizes a candidate rebase');
});
