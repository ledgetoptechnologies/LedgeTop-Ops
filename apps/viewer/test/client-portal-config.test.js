'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function portalOrigin(publicBaseUrl, override) {
  const env = { ...process.env, NODE_ENV: 'development', PUBLIC_BASE_URL: publicBaseUrl };
  delete env.CLIENT_PORTAL_BASE_URL;
  if (override !== undefined) env.CLIENT_PORTAL_BASE_URL = override;
  return JSON.parse(execFileSync(process.execPath,
    ['-e', "process.stdout.write(JSON.stringify(require('./server/config').config.clientPortalBaseUrl))"],
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
