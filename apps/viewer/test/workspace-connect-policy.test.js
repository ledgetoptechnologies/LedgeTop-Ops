'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { workspaceConnectSources } = require('../server/workspaceConnectPolicy');

const base = "'self' blob: https://server.arcgisonline.com";
test('workspace CSP permits only its exact configured production or staging Ops authority', () => {
  for (const ops of ['https://ops.ledgetopdroneservices.com', 'https://ops-staging.ledgetopdroneservices.com']) {
    for (const pathname of ['/workspace', '/workspace/', '/workspace/grant', '/workspace.html', '/WORKSPACE/grant']) {
      assert.equal(workspaceConnectSources(pathname, ops), `${base} ${ops}`);
    }
    for (const pathname of ['/', '/index.html', '/session/grant', '/view/token', '/embed/token', '/workspaceish', '/api/v1/health']) {
      assert.equal(workspaceConnectSources(pathname, ops), base);
    }
  }
});

test('workspace CSP rejects malformed, wildcard, credentialed and non-origin Ops URLs', () => {
  for (const ops of ['', undefined, '*', 'https://*.example.test', 'https://ops.example.test/path',
    'https://ops.example.test/', 'https://user:secret@ops.example.test', 'https://ops.example.test?x=1',
    'http://ops.example.test', 'https://ops.example.test#fragment', 'https://ops.example.test https://foreign.test']) {
    assert.equal(workspaceConnectSources('/workspace', ops), base, String(ops));
  }
});
