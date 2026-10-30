'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { validCapability, supportsReservations, action } = require('../server/processingReservationProtocol');
const { NodeOdmProvider } = require('../server/nodeOdmProvider');
const { ProviderCredentials } = require('../server/providerCredentials');

test('accepts only canonical 32-byte capability and explicit supported advertisement', () => {
  const capability = crypto.randomBytes(32).toString('base64url');
  assert.equal(validCapability(capability), true);
  assert.equal(validCapability(capability + '='), false);
  assert.equal(validCapability('A'.repeat(42) + 'B'), false);
  assert.equal(supportsReservations({}), false);
  assert.equal(supportsReservations({ ledgetopReservations: { version: 1, capabilityEncoding: 'base64url-32', retention: 'indefinite', runningCancellation: 'requires_inspection', remaining: 5 } }), true);
});

test('sends capability only in header and accepts an existing tombstone on reserve', async () => {
  const capability = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const provider = { request: async (route, init) => {
    assert.equal(route, '/task/ledgetop/reserve');
    assert.equal(init.headers['X-LedgeTop-Capability'], capability);
    assert.equal(init.body.toString(), `uuid=${id}`);
    return Response.json({ state: 'cancelled' });
  } };
  assert.deepEqual(await action(provider, 'reserve', id, capability), { state: 'cancelled' });
});

test('does not mistake an ambiguous coordinator reply for cancellation', async () => {
  const provider = { request: async () => Response.json({ state: 'pending' }) };
  await assert.rejects(action(provider, 'cancel', crypto.randomUUID(), crypto.randomBytes(32).toString('base64url')), { code: 'reservation_outcome_unresolved' });
});

test('reserved task requests carry the capability only in headers', async () => {
  const capability = crypto.randomBytes(32).toString('base64url');
  const id = crypto.randomUUID();
  const adapter = new NodeOdmProvider({ endpoint: 'https://example.test', token: 'provider-token', attemptCapability: capability,
    fetchImpl: async (url, init) => {
      assert.equal(init.headers.get('X-LedgeTop-Capability'), capability);
      assert.equal(init.headers.get('set-uuid'), id);
      assert.equal(url.toString().includes(capability), false);
      return Response.json({ uuid: id });
    } });
  await adapter.initialize({ uuid: id, name: 'test', options: {} });
});

test('capability-bearing provider connections require TLS', () => {
  assert.throws(()=>new NodeOdmProvider({endpoint:'http://example.test',attemptCapability:crypto.randomBytes(32).toString('base64url')}),/requires HTTPS/);
});

test('encrypted attempt capability is bound to provider, attempt, task and retained key', () => {
  const id = () => crypto.randomUUID();
  const provider = id(), attempt = id(), task = id(), capability = crypto.randomBytes(32).toString('base64url');
  const key = crypto.randomBytes(32).toString('hex');
  const credentials = new ProviderCredentials({ activeKeyId: 'k1', keys: { k1: key } });
  const record = credentials.sealAttemptCapability(provider, attempt, task, capability);
  assert.equal(record.ciphertext.includes(capability), false);
  assert.equal(credentials.openAttemptCapability(provider, attempt, task, record), capability);
  assert.throws(() => credentials.openAttemptCapability(provider, id(), task, record), { code: 'attempt_capability_unavailable' });
  assert.throws(() => new ProviderCredentials({ keys: {} }).openAttemptCapability(provider, attempt, task, record), { code: 'attempt_capability_unavailable' });
});

test('probe advertises only a complete supported reservation extension', async () => {
  const info = { version: '2.2.3', engine: 'ODM', engineVersion: '1.0', taskQueueCount: 0, maxImages: 1000,
    ledgetopReservations: { version: 1, capabilityEncoding: 'base64url-32', retention: 'indefinite', runningCancellation: 'requires_inspection', remaining: 9 } };
  const adapter = new NodeOdmProvider({ endpoint: 'http://localhost', fetchImpl: async url => Response.json(url.pathname === '/info' ? info : []) });
  assert.deepEqual((await adapter.capabilities()).capabilities.reservations, { version: 1, remaining: 9 });
  info.ledgetopReservations.version = 2;
  assert.equal((await adapter.capabilities()).capabilities.reservations, undefined);
});
