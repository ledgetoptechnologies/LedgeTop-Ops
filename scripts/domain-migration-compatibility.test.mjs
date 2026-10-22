import assert from 'node:assert/strict';
import test from 'node:test';
import {
  configuredPublicShareOrigin, configuredPublicRequestOrigins, configuredClientPortalOrigins,
  configuredLegacyClientOrigins, requestHostAllowed, legacyClientRedirectLocation,
  clientPortalRequestOriginAllowed,
} from '../apps/client/src/worker/origin-policy.ts';
import { handoffLegacyPublicShare, parseDeliveryRoute, consumeDeliveryRoute, openDeliveryRoute } from '../apps/client/src/client/route.ts';
import { createSessionCookie, verifySessionCookie } from '../apps/client/src/worker/security.ts';
import { requestHostAllowed as operationsHostAllowed } from '../apps/operations/src/worker/host-admission.ts';
import { nativeDeliveryDeploymentEnabled, NATIVE_DELIVERY_PORTAL_PRODUCTION_PROFILE } from '../apps/client/src/worker/operations-native-delivery-deployment.ts';

const OLD_PUBLIC = 'https://portal.ledgetopdroneservices.com';
const OLD_CLIENT = 'https://client.ledgetopdroneservices.com';
const OLD_PRIVATE = 'https://portal.ledgetoptechnologies.com';
const NEW_PORTAL = 'https://portal.ledgetop.app';
const finalPortal = {
  ENVIRONMENT: 'production', EXPECTED_HOST: 'portal.ledgetop.app',
  PUBLIC_BASE_URL: NEW_PORTAL, PUBLIC_SHARE_ORIGIN: NEW_PORTAL,
  CLIENT_PORTAL_ORIGIN: NEW_PORTAL, CLIENT_PORTAL_ORIGINS: NEW_PORTAL,
  LEGACY_CLIENT_ORIGINS: `${OLD_PUBLIC},${OLD_CLIENT}`,
  CLIENT_PORTAL_RETIRED_ORIGINS: `${OLD_PUBLIC},${OLD_CLIENT},${OLD_PRIVATE}`,
};

test('new canonical public tuple retains only the exact historical bearer hosts', () => {
  assert.equal(configuredPublicShareOrigin(finalPortal), NEW_PORTAL);
  assert.deepEqual(configuredPublicRequestOrigins(finalPortal), [NEW_PORTAL, OLD_PUBLIC, OLD_CLIENT]);
  for (const origin of [NEW_PORTAL, OLD_PUBLIC, OLD_CLIENT]) {
    for (const path of ['/s/synthetic-public-id', '/client-share/synthetic-public-id', '/api/public/shares/synthetic-public-id/manifest', '/api/public/shares/synthetic-public-id/session']) {
      assert.equal(requestHostAllowed(`${origin}${path}`, finalPortal), true, `${origin}${path}`);
      assert.equal(legacyClientRedirectLocation(`${origin}${path}`, finalPortal), null);
    }
  }
  for (const origin of [OLD_PRIVATE, 'https://unrelated.invalid', 'https://ledgetop.app']) {
    assert.equal(requestHostAllowed(`${origin}/s/synthetic-public-id`, finalPortal), false);
    assert.equal(requestHostAllowed(`${origin}/api/public/shares/synthetic-public-id/session`, finalPortal), false);
  }
});

test('a partial public-origin/expected-host cutover fails closed instead of silently sharing another namespace', () => {
  for (const patch of [
    { PUBLIC_BASE_URL: OLD_PUBLIC }, { PUBLIC_SHARE_ORIGIN: OLD_PUBLIC },
    { EXPECTED_HOST: 'portal.ledgetopdroneservices.com' },
  ]) {
    const env = { ...finalPortal, ...patch };
    assert.equal(configuredPublicShareOrigin(env), null);
    assert.equal(requestHostAllowed(`${NEW_PORTAL}/s/synthetic-public-id`, env), false);
  }
});

test('a presentation-only new portal alias does not create another public bearer namespace', () => {
  const env = { ...finalPortal, EXPECTED_HOST: 'portal.ledgetopdroneservices.com',
    PUBLIC_BASE_URL: OLD_PUBLIC, PUBLIC_SHARE_ORIGIN: OLD_PUBLIC, CLIENT_PORTAL_ORIGIN: OLD_PUBLIC,
    CLIENT_PORTAL_ORIGINS: `${OLD_PUBLIC},${OLD_PRIVATE},${NEW_PORTAL}`,
    LEGACY_CLIENT_ORIGINS: OLD_CLIENT, CLIENT_PORTAL_RETIRED_ORIGINS: '' };
  assert.ok(configuredClientPortalOrigins(env));
  assert.equal(requestHostAllowed(`${NEW_PORTAL}/portal/projects`, env), true);
  assert.equal(requestHostAllowed(`${NEW_PORTAL}/api/client/me`, env), true);
  assert.equal(requestHostAllowed(`${NEW_PORTAL}/s/synthetic-public-id`, env), false);
  assert.equal(requestHostAllowed(`${NEW_PORTAL}/api/internal/project-alpha/portal-v2`, env), false);
  assert.equal(requestHostAllowed(`${NEW_PORTAL}/api/client-onboarding/claim`, env), false);
  assert.equal(clientPortalRequestOriginAllowed(new Request(`${NEW_PORTAL}/api/client/me`, {headers:{Origin:NEW_PORTAL}}),env), true);
  assert.equal(clientPortalRequestOriginAllowed(new Request(`${NEW_PORTAL}/api/client/me`, {headers:{Origin:OLD_PUBLIC}}),env), false);
});

test('the current policy refuses overlapping retired-public and active-private aliases after canonical promotion', () => {
  const unsafe = { ...finalPortal, CLIENT_PORTAL_ORIGINS: `${NEW_PORTAL},${OLD_PUBLIC}`, CLIENT_PORTAL_RETIRED_ORIGINS: '' };
  assert.equal(configuredLegacyClientOrigins(unsafe), null);
  assert.equal(requestHostAllowed(`${OLD_PUBLIC}/s/synthetic-public-id`, unsafe), false);
  // A staged alias addition can work, but a full promotion needs reviewed
  // transition semantics, not a blind replacement of the canonical variables.
});

test('old private navigation keeps encoded path and query while public sessions and APIs remain local', () => {
  const entry = `${OLD_PUBLIC}/portal/projects/a%2Fb?folder=opaque_ref&view=list`;
  assert.equal(legacyClientRedirectLocation(entry, finalPortal), `${NEW_PORTAL}/portal/projects/a%2Fb?folder=opaque_ref&view=list`);
  for (const path of ['/s/synthetic-public-id?folder=opaque_ref', '/client-share/synthetic-public-id', '/api/public/shares/synthetic-public-id/download', '/api/client/me', '/api/internal/project-alpha/portal-v2', '/assets/client.js', '/health']) {
    assert.equal(legacyClientRedirectLocation(`${OLD_PUBLIC}${path}`, finalPortal), null, path);
  }
  assert.equal(requestHostAllowed(`${OLD_PUBLIC}/api/client/me`,finalPortal),false);
  assert.equal(requestHostAllowed(`${NEW_PORTAL}/api/internal/project-alpha/portal-v2`,finalPortal),true);
});

test('historical fragment links preserve opaque credentials before any cookie exchange', () => {
  const navigate = [];
  const path = '/s/synthetic-public-id', query='?folder=opaque_ref&view=list', fragment='#Synthetic_secret-123';
  assert.equal(handoffLegacyPublicShare({hostname:'client.ledgetopdroneservices.com',pathname:path,search:query,hash:fragment},url=>navigate.push(url)),true);
  assert.deepEqual(navigate,[`${OLD_PUBLIC}${path}${query}${fragment}`]);
  assert.equal(requestHostAllowed(navigate[0],finalPortal),true);
  const replaced=[];
  assert.deepEqual(consumeDeliveryRoute({pathname:path,search:query,hash:fragment},{state:null,replaceState:(...args)=>replaced.push(args)}),{publicId:'synthetic-public-id',secret:'Synthetic_secret-123'});
  assert.deepEqual(replaced,[[null,'',`${path}${query}`]]);
});

test('fragment-less legacy sessions and legacy single-token links remain recoverable', async () => {
  const navigate=[];
  for (const hostname of ['client.ledgetopdroneservices.com','portal.ledgetopdroneservices.com']) {
    assert.equal(handoffLegacyPublicShare({hostname,pathname:'/s/synthetic-public-id',search:'?folder=opaque_ref',hash:''},url=>navigate.push(url)),false);
  }
  assert.deepEqual(navigate,[]);
  const token='s'.repeat(43);
  assert.deepEqual(parseDeliveryRoute(`/s/${token}`,''),{publicId:token,secret:token});
  const secret='synthetic-domain-test-key-'.repeat(3), expiry=Date.now()+60_000;
  const cookie=await createSessionCookie(secret,'synthetic-key','synthetic-share',1,expiry);
  assert.match(cookie,/^__Host-ltds_delivery=/);
  assert.match(cookie,/; Path=\/;/);
  assert.match(cookie,/; HttpOnly; Secure; SameSite=Lax$/);
  assert.doesNotMatch(cookie,/Domain=/i);
  const value=decodeURIComponent(cookie.split(';')[0].split('=').slice(1).join('='));
  assert.deepEqual(await verifySessionCookie(secret,'synthetic-key',value),{shareId:'synthetic-share',shareVersion:1,expiresAt:expiry});
  const calls=[];
  await assert.rejects(openDeliveryRoute({publicId:'synthetic-public-id',secret:'synthetic-secret'},
    {createSession:async()=>({publicId:'synthetic-public-id',canonicalPath:'/s/synthetic-public-id'}),loadManifest:async()=>{calls.push('manifest');throw Error('temporary synthetic failure');}}),/temporary synthetic failure/);
  assert.deepEqual(calls,['manifest']);
});

test('Ops admits the canonical root only when explicitly configured and retains the two old hosts', () => {
  const env={ENVIRONMENT:'production',EXPECTED_HOST:'ledgetop.app',OPERATIONS_ORIGINS:'https://ledgetop.app,https://ops.ledgetopdroneservices.com,https://ops.ledgetoptechnologies.com'};
  for (const origin of env.OPERATIONS_ORIGINS.split(',')) assert.equal(operationsHostAllowed(`${origin}/api/session`,env),true);
  assert.equal(operationsHostAllowed('https://portal.ledgetop.app/api/session',env),false);
  assert.equal(operationsHostAllowed('https://ops.unrelated.invalid/api/session',env),false);
  assert.equal(operationsHostAllowed('https://ledgetop.app/api/session',{...env,OPERATIONS_ORIGINS:'https://ops.ledgetopdroneservices.com'}),false);
});

test('native delivery physical admission is a separate cutover gate, not implied by the new portal allowlist', () => {
  const profile={...finalPortal,CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE:NATIVE_DELIVERY_PORTAL_PRODUCTION_PROFILE};
  assert.equal(nativeDeliveryDeploymentEnabled(profile,'portal'),false);
  assert.equal(nativeDeliveryDeploymentEnabled(profile,'rpc'),false);
  const existing={...profile,EXPECTED_HOST:'portal.ledgetopdroneservices.com',PUBLIC_BASE_URL:OLD_PUBLIC,
    PUBLIC_SHARE_ORIGIN:OLD_PUBLIC,CLIENT_PORTAL_ORIGIN:OLD_PUBLIC};
  assert.equal(nativeDeliveryDeploymentEnabled(existing,'portal'),true);
  assert.equal(nativeDeliveryDeploymentEnabled(existing,'rpc'),true);
});
