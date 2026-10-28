'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const auth = require('../server/auth');
const { config } = require('../server/config');
const { requireAdmin, COOKIE_NAME } = require('../server/adminAuth');

test('legacy admin cookie mutations require the exact Viewer origin', () => {
  const prior = { enabled: config.emergencyAdminEnabled, base: config.publicBaseUrl, password: config.adminPassword };
  config.emergencyAdminEnabled = true;
  config.publicBaseUrl = 'https://viewer.example.test';
  config.adminPassword = 'long-emergency-admin-test-password';
  try {
    const cookie = auth.sign({ role: 'admin' }, 60_000);
    function attempt(origin, authorization) {
      let status = null;
      let next = false;
      const req = {
        method: 'POST', protocol: 'https', headers: { authorization },
        cookies: { [COOKIE_NAME]: cookie },
        get: (name) => name === 'origin' ? origin : 'viewer.example.test',
      };
      const res = { status(code) { status = code; return this; }, json() { return this; } };
      requireAdmin(req, res, () => { next = true; });
      return { status, next };
    }
    assert.deepEqual(attempt('https://attacker.example.test'), { status: 403, next: false });
    assert.deepEqual(attempt(undefined), { status: 403, next: false });
    assert.deepEqual(attempt('https://viewer.example.test'), { status: null, next: true });
    assert.deepEqual(attempt(undefined, `Bearer ${config.adminPassword}`), { status: null, next: true });
    assert.deepEqual(attempt(undefined, 'Bearer invalid'), { status: 403, next: false });
  } finally {
    config.emergencyAdminEnabled = prior.enabled;
    config.publicBaseUrl = prior.base;
    config.adminPassword = prior.password;
  }
});
