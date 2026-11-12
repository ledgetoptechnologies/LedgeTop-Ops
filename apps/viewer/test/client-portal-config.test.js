'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { expectedViewerAutomationOrigin } = require('../server/config');

function portalOrigin(publicBaseUrl, override) {
  const env = { ...process.env, NODE_ENV: 'development', PUBLIC_BASE_URL: publicBaseUrl };
  delete env.CLIENT_PORTAL_BASE_URL;
  if (override !== undefined) env.CLIENT_PORTAL_BASE_URL = override;
  return JSON.parse(execFileSync(process.execPath,
    ['-e', "process.stdout.write(JSON.stringify(require('./server/config').config.clientPortalBaseUrl))"],
    { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' }));
}

function clientShareConfigProblems(expectedHost, automationUrl) {
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PUBLIC_BASE_URL: `https://${expectedHost}`,
    EXPECTED_HOST: expectedHost,
    OPS_BASE_URL: 'https://ops-staging.ledgetopdroneservices.com',
    OPS_CONTROLLER_ORIGINS: 'https://ops-staging.ledgetopdroneservices.com',
    ALLOWED_EMBED_ORIGINS: 'https://ops-staging.ledgetopdroneservices.com',
    SESSION_SECRET: 's'.repeat(32),
    SERVICE_AUTH_KEY_ID: 'staging-v1',
    SERVICE_AUTH_SECRET: 'k'.repeat(32),
    CLIENT_VIEWER_SHARES_ENABLED: 'true',
    OPS_AUTOMATION_BASE_URL: automationUrl,
    VIEWER_EVENT_KEY_ID: 'viewer-staging-v1',
    VIEWER_EVENT_SECRET: 'e'.repeat(32),
    PROCESSING_PLATFORM_ENABLED: 'false',
  };
  return JSON.parse(execFileSync(process.execPath,
    ['-e', "process.stdout.write(JSON.stringify(require('./server/config').validate()))"],
    { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' }));
}

test('only the canonical production Viewer defaults to the production portal', () => {
  assert.equal(portalOrigin('https://viewer.ledgetopdroneservices.com'), 'https://portal.ledgetop.app');
  assert.equal(portalOrigin('https://viewer-staging.example.test'), '');
  assert.equal(portalOrigin('http://localhost:8080'), '');
  assert.equal(portalOrigin(''), '');
});

test('explicit portal configuration supports staging, disabling and malformed rejection', () => {
  assert.equal(portalOrigin('https://viewer-staging.example.test', 'https://portal-staging.example.test'),
    'https://portal-staging.example.test');
  assert.equal(portalOrigin('https://viewer.ledgetopdroneservices.com', ''), '');
  assert.equal(portalOrigin('https://viewer.ledgetopdroneservices.com', 'https://portal.example.test/path'), '');
  assert.equal(portalOrigin('https://viewer.ledgetopdroneservices.com', 'https://user:secret@portal.example.test'), '');
});

test('client Viewer automation is pinned to the exact matching LTDS production or staging host', () => {
  assert.equal(expectedViewerAutomationOrigin('viewer.ledgetopdroneservices.com'),
    'https://incoming.ledgetopdroneservices.com');
  assert.equal(expectedViewerAutomationOrigin('viewer-staging.ledgetopdroneservices.com'),
    'https://incoming-staging.ledgetopdroneservices.com');
  assert.equal(expectedViewerAutomationOrigin('viewer-staging.ledgetoptechnologies.com'), '');
  assert.equal(expectedViewerAutomationOrigin('viewer.example.test'), '');
});

test('client Viewer sharing accepts the matching staging automation origin and rejects mismatches', () => {
  assert.deepEqual(clientShareConfigProblems('viewer-staging.ledgetopdroneservices.com',
    'https://incoming-staging.ledgetopdroneservices.com'), []);
  assert.ok(clientShareConfigProblems('viewer-staging.ledgetopdroneservices.com',
    'https://incoming.ledgetopdroneservices.com').some(problem => problem.includes('OPS_AUTOMATION_BASE_URL')));
  assert.ok(clientShareConfigProblems('viewer-staging.ledgetoptechnologies.com',
    'https://incoming-staging.ledgetopdroneservices.com').some(problem => problem.includes('OPS_AUTOMATION_BASE_URL')));
});
