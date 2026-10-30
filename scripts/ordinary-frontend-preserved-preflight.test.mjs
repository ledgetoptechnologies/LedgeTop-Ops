import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ORDINARY_FRONTEND_PREFLIGHT_MODE,
  ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
  PROFILE,
  hash,
  canonical,
  ordinaryFrontendPreflightDescriptor,
  validateOrdinaryFrontendPreflightPreservation,
  validateInstallation,
  compileConfig,
} from './production-deploy.mjs';
import { eligibilityFlags } from './client-portal-release-profile.mjs';
import { validatePortalReleasePreflight } from '../apps/client/scripts/project-alpha-portal-receiver-preflight.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const acceptedProfile = JSON.parse(fs.readFileSync(path.join(HERE, 'test-fixtures/ordinary-frontend-accepted-profile-v3.test.json'), 'utf8'));
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

test('ordinary UI preflight is explicit, statically pinned, and only normalizes a private preflight copy', () => {
  const { client, operations } = syntheticPortalVars();
  const before = { client: clone(client), operations: clone(operations) };
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
  assert.deepEqual(validateOrdinaryFrontendPreflightPreservation(client, operations, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), {
    mode: ORDINARY_FRONTEND_PREFLIGHT_MODE,
    profileSHA256: ORDINARY_FRONTEND_ACCEPTED_PROFILE_SHA256,
  });
  assert.deepEqual({ client, operations }, before);
  assert.deepEqual(validatePortalReleasePreflight(
    { name: 'ledgetop-clients', keep_vars: true, vars: client },
    { name: 'ledgetop-ops', keep_vars: true, vars: operations },
    declaration,
  ), strictErrors);
});

test('ordinary UI compatibility rejects missing, unknown, altered-profile, or changed preserved flags', () => {
  const { client, operations } = syntheticPortalVars();
  assert.deepEqual(ordinaryFrontendPreflightDescriptor(acceptedProfile, undefined), {
    mode: 'strict-default', profileSHA256: null,
  });
  assert.throws(() => ordinaryFrontendPreflightDescriptor(acceptedProfile, 'ordinary-frontend-any-profile'), /Unreviewed ordinary frontend preflight mode/);
  assert.throws(() => ordinaryFrontendPreflightDescriptor(PROFILE, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Unreviewed ordinary frontend accepted profile/);
  const mutatedProfile = clone(acceptedProfile);
  mutatedProfile.workers.operations.script.named_handlers.find(row => row.name === 'ViewerSessionIssuer').handlers.pop();
  assert.throws(() => ordinaryFrontendPreflightDescriptor(mutatedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Unreviewed ordinary frontend accepted profile/);
  const wrongValueProfile = clone(acceptedProfile);
  wrongValueProfile.workers.client.plainValueSHA256[viewerFlag] = hash('false');
  assert.throws(() => ordinaryFrontendPreflightDescriptor(wrongValueProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Unreviewed ordinary frontend accepted profile/);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation(client, operations, acceptedProfile), /Unreviewed ordinary frontend preflight mode/);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation({ ...client, [viewerFlag]: false }, operations, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Client viewer flag differs/);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation({ ...client, [viewerFlag]: 'false' }, operations, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Client viewer flag differs/);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation(client, { ...operations, [hierarchyFlag]: 'false' }, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Operations hierarchy flag differs/);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation({ ...client, CLIENT_PORTAL_CONTENT_AUDIT_ENABLED: 'true' }, operations, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Effective production release profile rejected/);
  assert.throws(() => validateOrdinaryFrontendPreflightPreservation(client, { ...operations, AUTHENTICATED_DELIVERY_GRANTS_ENABLED: 'false' }, acceptedProfile, ORDINARY_FRONTEND_PREFLIGHT_MODE), /Effective production release profile rejected/);
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
});
