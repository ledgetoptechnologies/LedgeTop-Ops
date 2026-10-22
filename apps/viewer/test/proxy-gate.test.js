'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const {
  HEADER_NAME, constantTimeSecretEqual, createProxyGate, parseTrustedProxyAddresses,
} = require('../server/proxyGate');

const repositoryRoot = path.resolve(__dirname, '..');
const validSecret = 'proxy-gate-test-secret-00000000000000000000000';

test('proxy shared secret uses timing-safe equality and never accepts length mismatches', () => {
  assert.equal(constantTimeSecretEqual(validSecret, validSecret), true);
  assert.equal(constantTimeSecretEqual(validSecret, `${validSecret}x`), false);
  assert.equal(constantTimeSecretEqual(validSecret, ''), false);
  assert.match(constantTimeSecretEqual.toString(), /timingSafeEqual/);
});

test('trusted proxy allowlist accepts exact IP/CIDR sources and rejects malformed entries', () => {
  const allowlist = parseTrustedProxyAddresses('127.0.0.1,192.168.50.0/24,2001:db8::/32');
  assert.equal(allowlist.allows('::ffff:127.0.0.1'), true);
  assert.equal(allowlist.allows('192.168.50.44'), true);
  assert.equal(allowlist.allows('192.168.10.44'), false);
  assert.equal(allowlist.allows('2001:db8::5'), true);
  assert.throws(() => parseTrustedProxyAddresses('192.168.50.0/99'), /invalid trusted proxy CIDR/);
  assert.throws(() => parseTrustedProxyAddresses('not-an-address'), /invalid trusted proxy address/);
});

test('production proxy gate requires exact Host, trusted socket source, and header secret', () => {
  const config = {
    production: true, expectedHost: 'viewer.example.test', proxySharedSecret: validSecret,
    trustedProxyAllowlist: parseTrustedProxyAddresses('192.168.50.0/24'),
  };
  const run = ({ host = 'viewer.example.test', secret = validSecret, remoteAddress = '192.168.50.20' } = {}) => {
    const result = { next: false, status: null, body: null };
    const req = {
      headers: { host }, socket: { remoteAddress },
      get(name) { return name === HEADER_NAME ? secret : undefined; },
    };
    const res = { status(value) { result.status = value; return this; }, json(value) { result.body = value; return this; } };
    createProxyGate(config)(req, res, () => { result.next = true; });
    return result;
  };
  assert.equal(run().next, true);
  assert.equal(run({ host: '192.168.50.80' }).status, 421);
  assert.equal(run({ secret: '' }).status, 403);
  assert.equal(run({ secret: `${validSecret}x` }).status, 403);
  assert.equal(run({ remoteAddress: '192.168.10.20' }).status, 403);
  assert.doesNotMatch(JSON.stringify(run({ secret: `${validSecret}x` }).body), /proxy-gate-test-secret/);
});

test('production proxy gate defaults to exact Host only until optional hardening is enabled', () => {
  const config = { production: true, expectedHost: 'viewer.example.test', proxySharedSecret: '', trustedProxyAllowlist: parseTrustedProxyAddresses('') };
  let passed = false;
  createProxyGate(config)({ headers: { host: 'viewer.example.test' }, socket: { remoteAddress: '192.168.50.20' }, get() { return undefined; } },
    { status() { throw new Error('unexpected rejection'); } }, () => { passed = true; });
  assert.equal(passed, true);
});

function validateProduction(overrides) {
  const result = spawnSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./server/config').validate()))"], {
    cwd: repositoryRoot, encoding: 'utf8',
    env: {
      ...process.env, NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://viewer.example.test', EXPECTED_HOST: 'viewer.example.test',
      OPS_BASE_URL: 'https://ops.example.test', ALLOWED_EMBED_ORIGINS: 'https://ops.example.test',
      SESSION_SECRET: 'session-secret-that-is-at-least-32-characters', SERVICE_AUTH_SECRET: 'service-secret-that-is-at-least-32-characters',
      PROXY_SHARED_SECRET: validSecret, EMERGENCY_ADMIN_ENABLED: 'false', WEBODM_ENABLED: 'false',
      ...overrides,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('production validation permits disabled proxy hardening but rejects malformed configured values', () => {
  assert.deepEqual(validateProduction({ PROXY_SHARED_SECRET: '' }), []);
  assert.ok(validateProduction({ PROXY_SHARED_SECRET: 'too-short' }).some((problem) => problem.startsWith('PROXY_SHARED_SECRET')));
  assert.ok(validateProduction({ TRUSTED_PROXY_ADDRESSES: '192.168.50.0/99' }).some((problem) => problem.startsWith('TRUSTED_PROXY_ADDRESSES')));
  assert.deepEqual(validateProduction({ TRUSTED_PROXY_ADDRESSES: '127.0.0.1/32' }), []);
});
