/** Synthetic, offline-only canonical-v4-shaped installation for the StaffDirectory release tests.
 * It reuses the structure of the hash-only v4 profile fixture, binds every scalar to a synthetic
 * value, and recomputes the profile's scalar and asset digests from those values. The resulting
 * profile digest is therefore not the reviewed production digest; tests pass it only through the
 * offline `reviewedPreflightProfiles` seam. No production value appears here. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonical, hash, ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE } from '../production-deploy.mjs';
import { eligibilityFlags } from '../client-portal-release-profile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const clone = value => structuredClone(value);

export const SYNTHETIC_IDS = Object.freeze({
  operations: '11111111-1111-4111-8111-111111111111',
  client: '22222222-2222-4222-8222-222222222222',
  'ops-sync': '33333333-3333-4333-8333-333333333333',
  held: '55555555-5555-4555-8555-555555555555',
  candidate: '77777777-7777-4777-8777-777777777777',
});

function syntheticVars(app, names) {
  let defaults = {};
  try { defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', app, 'wrangler.jsonc'), 'utf8')).vars ?? {}; } catch { defaults = {}; }
  const portal = Object.fromEntries(eligibilityFlags.map(flag => [flag, 'true']));
  const fixed = app === 'operations' ? {
    ...portal, ENVIRONMENT: 'production', CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: 'true',
    AUTHENTICATED_DELIVERY_GRANTS_ENABLED: 'true', PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED: 'true',
    AUTHENTICATED_DELIVERY_CREATION_ENABLED: 'true', AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: 'false',
    PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED: 'false', CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: 'false',
    PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED: 'false', PROJECT_ALPHA_DELIVERY_GUEST_ENABLED: 'false',
    CLIENT_ONBOARDING_ADMIN_ENABLED: 'true', CLIENT_ONBOARDING_ADMIN_ORIGIN: 'https://ops.ledgetop.app',
    CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: 'true', CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED: 'true',
    CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS: '["synthetic-owner"]',
    CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE: '2026-10-20T00:00:00.000Z',
    PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED: 'true',
  } : app === 'client' ? {
    ...portal, ENVIRONMENT: 'production', PROJECT_ALPHA_PORTAL_SYNC_ENABLED: 'true',
    PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED: 'false', CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED: 'true',
    PROJECT_ALPHA_PORTAL_APPLICATION_KEY: 'synthetic-safe-id', CLIENT_PORTAL_CONTENT_AUDIT_ENABLED: 'false',
    CLIENT_PORTAL_REQUEST_V2_ENABLED: 'false', CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED: 'false',
    PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED: 'false', CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED: 'false',
    CLIENT_REQUEST_ATTACHMENTS_ENABLED: 'false', CLIENT_PORTAL_TEAM_ENABLED: 'false', CLIENT_VIEWER_ENABLED: 'true',
    CLIENT_VIEWER_SHARES_ENABLED: 'false', CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED: 'false',
    CLIENT_PORTAL_PEER_ADMIN_ENABLED: 'false', CLIENT_PORTAL_ADDRESS_BOOK_ENABLED: 'false',
    CLIENT_PORTAL_ACCESS_ENROLLMENT_READY: 'false', CLIENT_PORTAL_INVITATION_EMAIL_ENABLED: 'false',
    CLIENT_DELEGATED_SHARES_ENABLED: 'false', CLIENT_PORTAL_HIERARCHY_V2_ENABLED: 'true',
    CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED: 'true', CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED: 'true',
    CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED: 'true', CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED: 'true',
    AUTHENTICATED_DELIVERY_GRANTS_ENABLED: 'true', PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED: 'false',
    AUTHENTICATED_DELIVERY_CREATION_ENABLED: 'false', AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED: 'false',
    CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: 'true',
  } : {};
  return Object.fromEntries(names.map(name => [name,
    Object.hasOwn(fixed, name) ? fixed[name] : typeof defaults[name] === 'string' ? defaults[name] : 'synthetic-fixture']));
}

/** Returns { profile, snapshot, reviewedPreflightProfiles } with Ops active alone at 100%. */
export function syntheticCanonicalV4Installation() {
  const profile = JSON.parse(fs.readFileSync(path.join(HERE, 'ordinary-frontend-accepted-profile-v4.test.json'), 'utf8'));
  const snapshot = {};
  for (const [app, spec] of Object.entries(profile.workers)) {
    const id = SYNTHETIC_IDS[app];
    const vars = syntheticVars(app, spec.plainNames);
    spec.plainValueSHA256 = Object.fromEntries(Object.keys(spec.plainValueSHA256).map(name => [name, hash(vars[name])]));
    const bindings = [...clone(spec.bindings), ...Object.entries(vars).map(([name, text]) => ({ name, type: 'plain_text', text }))];
    const resources = { script: { ...clone(spec.script), etag: 'a'.repeat(64), last_deployed_from: 'wrangler' },
      script_runtime: clone(spec.runtime), bindings };
    snapshot[app] = {
      latest: id, deployment: { id, versions: [{ version_id: id, percentage: 100 }], strategy: 'percentage',
        created_on: '2026-11-01T00:00:00.000000Z' },
      version: { id, resources },
      settings: { ...clone(spec.settings), annotations: { 'workers/message': 'synthetic' }, bindings: clone(bindings) },
      modern: { id, ...(app === 'ops-sync' ? {} : { assets: { config: { base_path: '/', html_handling: 'auto-trailing-slash',
        not_found_handling: 'single-page-application' } } }),
      modules: [{ name: 'index.js', content_base64: Buffer.from(`synthetic ${app} baseline`).toString('base64') }] },
      schedules: { schedules: spec.crons.map(cron => ({ cron, created_on: 'synthetic' })) },
    };
    spec.assetsSHA256 = hash(canonical(snapshot[app].modern.assets ?? null));
  }
  const reviewedPreflightProfiles = Object.freeze({ [ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE]: hash(canonical(profile)) });
  return { profile, snapshot, reviewedPreflightProfiles };
}
