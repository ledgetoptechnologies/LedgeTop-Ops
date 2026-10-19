import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MachineReadClient, machineConfig } from '../src/machine-client.mjs';
import { createMachineServer } from '../src/machine-server.mjs';

const origin = 'https://ops-staging.ledgetopdroneservices.com';
const config = { origin, credentialFile: process.platform === 'win32' ? 'C:/private/machine.json' : '/private/machine.json' };
const credential = { clientId: 'test.access', clientSecret: 'cfast_test-only-not-real' };
const reply = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
test('machine config has one exact staging origin and never accepts production or relative secret files', () => {
  assert.equal(machineConfig({ LTDS_MCP_MACHINE_CREDENTIAL_FILE: config.credentialFile }).origin, origin);
  for (const env of [{ LTDS_MCP_MACHINE_CREDENTIAL_FILE: 'relative.json' }, { LTDS_MCP_MACHINE_CREDENTIAL_FILE: config.credentialFile, LTDS_OPS_ORIGIN: 'https://ops.ledgetopdroneservices.com' }]) assert.throws(() => machineConfig(env));
});
test('three fixed reads send service credentials freshly each time, no cookies or human tokens', async () => {
  const calls = []; let reads = 0;
  const client = new MachineReadClient(config, { loadCredential: async () => { reads++; return credential; }, fetch: async (url, options) => { calls.push([url, options]); return reply({ ok: true }); } });
  await client.connection(); await client.findClients({ sourceId: 'project-alpha:staging', q: 'Client', limit: 2 });
  await client.getClient({ sourceId: 'project-alpha:staging', recordId: 'client-one' });
  assert.equal(reads, 3); assert.equal(calls.length, 3);
  for (const [url, options] of calls) {
    assert.ok(url.startsWith(`${origin}/api/agent/v1/`)); assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { Accept: 'application/json', 'CF-Access-Client-Id': credential.clientId, 'CF-Access-Client-Secret': credential.clientSecret });
  }
});
test('invalid source, traversal and excessive query stop before credentials or network', () => {
  const client = new MachineReadClient(config, { loadCredential: () => assert.fail('credential'), fetch: () => assert.fail('network') });
  for (const recordId of ['../other', 'client/other', 'client%2fother']) assert.throws(() => client.getClient({ sourceId: 'project-alpha:staging', recordId }));
  assert.throws(() => client.findClients({ sourceId: 'project-alpha:staging', limit: 26 })); assert.throws(() => client.findClients({}));
});
test('transport redacts secret values/keys and rejects redirects, HTML and response overflow', async () => {
  const clean = new MachineReadClient(config, { loadCredential: async () => credential, fetch: async () => reply({ name: credential.clientSecret, token: 'hidden', clientId: credential.clientId }) });
  assert.deepEqual(await clean.connection(), { name: '[redacted]', clientId: '[redacted]' });
  for (const response of [new Response('login', { status: 302 }), new Response('<html>login</html>'), new Response('x'.repeat(1048577), { headers: { 'Content-Type': 'application/json' } })]) {
    const client = new MachineReadClient(config, { loadCredential: async () => credential, fetch: async () => response });
    await assert.rejects(client.connection(), error => !error.message.includes(credential.clientSecret));
  }
});
test('real MCP discovery exposes exactly three reads and rejects all unsupported tools', async t => {
  const requests = [];
  const server = createMachineServer({ connection: async () => ({ principal: { kind: 'agent', id: 'one' } }), findClients: async args => { requests.push(args); return { clients: [] }; }, getClient: async args => args });
  const client = new Client({ name: 'machine-contract', version: '1' }); const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]); t.after(async () => { await client.close(); await server.close(); });
  const tools = await client.listTools(); assert.deepEqual(tools.tools.map(v => v.name).sort(), ['find_clients', 'get_client', 'get_connection']);
  assert.ok(tools.tools.every(v => v.annotations.readOnlyHint));
  for (const name of ['create_client', 'preview_delivery_access', 'get_client_access', 'list_delivery_folder', 'grant_delivery_access']) assert.equal((await client.callTool({ name, arguments: {} })).isError, true);
  assert.equal((await client.callTool({ name: 'find_clients', arguments: { sourceId: 'project-alpha:staging', limit: 1 } })).isError, undefined);
  assert.equal(requests.length, 1);
});
