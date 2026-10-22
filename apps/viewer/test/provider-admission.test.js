'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { admitProviderEndpoint, canonicalProviderEndpoint, parseProviderCidrs } = require('../server/providerAdmission');

const cidrs = parseProviderCidrs('192.168.50.0/24, 192.168.10.0/24, fd00::/8');

test('provider admission accepts configured LAN CIDRs and preserves exact origins', () => {
  assert.deepEqual(admitProviderEndpoint('http://192.168.50.80:30048', { allowedCidrs: cidrs }), {
    ok: true, origin: 'http://192.168.50.80:30048', admission: 'cidr',
  });
  assert.equal(admitProviderEndpoint('https://node.example.test', { exactOrigins: ['https://node.example.test'] }).ok, true);
  assert.equal(admitProviderEndpoint('https://node.example.test', { allowedCidrs: cidrs }).ok, false, 'CIDRs never authorize DNS names');
  assert.equal(admitProviderEndpoint('http://192.168.51.80:30048', { allowedCidrs: cidrs }).ok, false);
  assert.equal(admitProviderEndpoint('http://[fd00::50]:30048', { allowedCidrs: cidrs }).ok, true);
  assert.equal(admitProviderEndpoint('http://192.168.50.80:30048', {}).ok, false, 'empty admission policy fails closed');
});

test('provider admission rejects dangerous addresses and non-origin URL components', () => {
  const broad = parseProviderCidrs('0.0.0.0/0,::/0');
  for (const endpoint of [
    'http://127.0.0.1:3000', 'http://127.1:3000', 'http://localhost:3000',
    'http://169.254.169.254/latest', 'http://0.0.0.0:3000', 'http://224.0.0.1:3000',
    'http://192.0.2.1:3000', 'http://[::1]:3000', 'http://[fe80::1]:3000', 'http://[ff02::1]:3000',
  ]) assert.equal(admitProviderEndpoint(endpoint, { allowedCidrs: broad, exactOrigins: [canonicalProviderEndpoint(endpoint)?.origin].filter(Boolean) }).ok, false, endpoint);

  for (const endpoint of [
    'http://user:pass@192.168.50.80:30048', 'http://192.168.50.80:30048/nodeodm',
    'http://192.168.50.80:30048/?token=x', 'http://192.168.50.80:30048/#fragment',
  ]) assert.equal(admitProviderEndpoint(endpoint, { allowedCidrs: cidrs }).code, 'invalid_provider_endpoint', endpoint);
});

test('provider CIDR parser rejects malformed networks', () => {
  for (const value of ['192.168.50.0', '192.168.50.0/33', 'not-an-ip/24', '::1/129'])
    assert.throws(() => parseProviderCidrs(value), /invalid CIDR/);
});
