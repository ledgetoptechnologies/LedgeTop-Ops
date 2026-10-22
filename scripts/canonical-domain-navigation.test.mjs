import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalDomainNavigationRedirect } from '../packages/shared/src/canonical-domain-navigation.ts';

const request = (path='/', origin='https://ops.ledgetopdroneservices.com', method='GET') => ({method,url:`${origin}${path}`});
const ops = {enabled:true,surface:'operations'};
const portal = {enabled:true,surface:'portal'};

test('canonical navigation is disabled by default and requires the exact boolean opt-in', () => {
  for (const enabled of [undefined,null,false,'true','false',1,{},[]])
    assert.equal(canonicalDomainNavigationRedirect(request(),{surface:'operations',enabled}),null);
  assert.equal(canonicalDomainNavigationRedirect(request(),{enabled:true,surface:'unknown'}),null);
});

test('old Operations entry pages redirect reversibly to the fixed canonical root with path and query intact', () => {
  for (const origin of ['https://ops.ledgetopdroneservices.com','https://ops.ledgetoptechnologies.com']) {
    for (const method of ['GET','HEAD']) for (const path of ['/', '/dashboard', '/airspace', '/operations/', '/delivery', '/team', '/administration', '/clients?q=synthetic%40example.invalid&scope=ltds']) {
      const response=canonicalDomainNavigationRedirect(request(path,origin,method),ops);
      assert.equal(response.status,302);
      assert.equal(response.headers.get('Location'),`https://ledgetop.app${path}`);
      assert.equal(response.headers.get('Cache-Control'),'no-store');
      assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
      assert.equal(response.headers.get('Set-Cookie'),null);
      assert.equal(response.body,null);
    }
  }
});

test('ordinary source-bound Client Hub bookmarks survive navigation', () => {
  const path='/clients/sources/project-alpha%3Aprimary/business/organizations/synthetic-client?q=name';
  assert.equal(canonicalDomainNavigationRedirect(request(path),ops).headers.get('Location'),`https://ledgetop.app${path}`);
});

test('portal browser pages go only to the separate canonical portal and retain project/workspace selection', () => {
  for (const origin of ['https://portal.ledgetopdroneservices.com','https://portal.ledgetoptechnologies.com','https://client.ledgetopdroneservices.com']) {
    for (const path of ['/portal','/portal/projects/synthetic-project?workspace=synthetic-workspace','/portal/account?workspace=synthetic','/portal/feedback/synthetic-feedback','/portal/requests/new'])
      assert.equal(canonicalDomainNavigationRedirect(request(path,origin),portal).headers.get('Location'),`https://portal.ledgetop.app${path}`);
    assert.equal(canonicalDomainNavigationRedirect(request('/?q=preserved',origin),portal).headers.get('Location'),'https://portal.ledgetop.app/portal?q=preserved');
  }
});

test('POST/PUT/PATCH/DELETE/OPTIONS and other non-navigation methods never redirect', () => {
  for (const method of ['POST','PUT','PATCH','DELETE','OPTIONS','TRACE','CONNECT','get'])
    for (const configuration of [ops,portal])
      assert.equal(canonicalDomainNavigationRedirect(request('/','https://ops.ledgetopdroneservices.com',method),configuration),null);
});

test('public links, APIs, downloads, capabilities, uploads, Viewer and assets keep their existing host', () => {
  const excluded=[
    '/s/existing-public-id','/s/existing-public-id#fragment-secret','/client-share/existing-id',
    '/api/public/shares/existing-id/manifest','/api/public/shares/existing-id/bulk-download',
    '/api/client/profile','/api/internal/client-request-attachments/id/scanned','/api/agent/v1/clients',
    '/api/viewer/workspace/session-renewal','/api/project-alpha/events','/api/upload',
    '/assets/app.js','/health','/r/invitation','/onboarding/synthetic-token','/portal/operations-recipient-enrollment/id',
    '/portal/recipient-enrollment/id','/portal/invitation/id','/viewer','/viewer/session/callback',
    '/administration/client-portal/operations-workspaces','/clients/onboarding/capability',
    '/cdn-cgi/access/login','/cdn-cgi/access/logout','/cdn-cgi/access/get-identity',
  ];
  for (const path of excluded) {
    assert.equal(canonicalDomainNavigationRedirect(request(path),ops),null,path);
    assert.equal(canonicalDomainNavigationRedirect(request(path,'https://portal.ledgetopdroneservices.com'),portal),null,path);
  }
});

test('capability and login query parameters are not redirected by the generic navigation policy', () => {
  for (const key of ['token','handoffToken','secret','password','signature','assertion','authorization','credential','code','state','key','ticket','nonce','auth','returnTo','redirect_uri','redirect_url','__cf_access_message','access_code','authorization_code','oauth_state','invitation','invite_code','grant','next','unknown_filter','access%5Fcode']) {
    assert.equal(canonicalDomainNavigationRedirect(request(`/?${key}=synthetic`),ops),null,key);
    assert.equal(canonicalDomainNavigationRedirect(request(`/portal?${key}=synthetic`,'https://portal.ledgetopdroneservices.com'),portal),null,key);
  }
});

test('new canonical domains, unrelated origins, staging and malformed origins cannot create redirect loops or open redirects', () => {
  for (const origin of ['https://ledgetop.app','https://portal.ledgetop.app','https://evil.invalid','http://ops.ledgetopdroneservices.com','https://ops.ledgetopdroneservices.com:8443','https://ops.ledgetopdroneservices.com.evil.invalid','https://ops-staging.ledgetopdroneservices.com','https://ops.ledgetopdroneservices.com.'])
    for (const configuration of [ops,portal]) assert.equal(canonicalDomainNavigationRedirect(request('/',origin),configuration),null);
  for (const url of ['not-a-url','https://user:pass@ops.ledgetopdroneservices.com/','//ops.ledgetopdroneservices.com/'])
    assert.equal(canonicalDomainNavigationRedirect({method:'GET',url},ops),null);
  assert.equal(canonicalDomainNavigationRedirect(request('/?next=https%3A%2F%2Fevil.invalid'),ops),null);
  assert.equal(canonicalDomainNavigationRedirect(request('/?q=https%3A%2F%2Fevil.invalid'),ops).headers.get('Location'),'https://ledgetop.app/?q=https%3A%2F%2Fevil.invalid');
});

test('ambiguous or encoded route separators cannot enter a whitelisted browser namespace', () => {
  for (const path of ['//evil.invalid','/clients//evil.invalid','/clients/%2fapi','/clients/%5capi','/clients/%00','/clients/%0A','/clients/%0d','/unknown','/assets','/api','/portal/account/not-a-page'])
    assert.equal(canonicalDomainNavigationRedirect(request(path),ops),null,path);
});

test('encoded capability words and ambiguous encoded segments stay with their original handler', () => {
  for (const path of ['/clients/%6Fnboarding/synthetic-token','/clients/%65nrollment/synthetic-token',
    '/clients/%69nvitation/synthetic','/clients/%6Fauth/synthetic','/clients/%63allback/synthetic',
    '/clients/recipient-%65nrollment/synthetic','/clients/%69nvitations/synthetic','/clients/%73ession/synthetic',
    '/clients/%256Fnboarding/synthetic','/clients/%252fapi','/clients/%','/clients/%GG','/clients/%C0%AF'])
    assert.equal(canonicalDomainNavigationRedirect(request(path),ops),null,path);
  const ordinary='/clients/sources/project-alpha%3Aprimary/business/organizations/synthetic-id?Q=synthetic&scope=ltds';
  assert.equal(canonicalDomainNavigationRedirect(request(ordinary),ops).headers.get('Location'),`https://ledgetop.app${ordinary}`);
});
