import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from '../src/server.mjs';
import { buildTools } from '../src/tools.mjs';
import { AccessClientError } from '../src/access-client.mjs';

const mutationId = '00000000-0000-4000-8000-000000000001';
const target = { sourceId: 'project-alpha:primary', rootNamespace: 'business', kind: 'standalone', publicId: 'local-id' };
const grant = { folderBindingId: 'binding', audienceType: 'principal', audiencePublicId: 'person', reasonCode: 'owner_request' };
const profile = { name: 'Example', email: '', phone: '', clientType: 'business', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '', country: '' };

async function connected(t, api, config = {}) {
  const server = createServer(api, config);
  const client = new Client({ name: 'integration-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('real MCP handshake advertises read tools only by default, and rejects hidden writes', async t => {
  const client = await connected(t, { session: async () => ({ user: { id: 'owner' } }), request: () => assert.fail('no request') });
  const result = await client.listTools();
  assert.equal(result.tools.length, 10);
  assert.ok(result.tools.every(v => v.annotations.readOnlyHint));
  assert.ok(result.tools.find(v => v.name === 'preview_delivery_access'));
  const denied = await client.callTool({ name: 'create_client', arguments: {} });
  assert.equal(denied.isError, true);
  const session = await client.callTool({ name: 'get_connection', arguments: {} });
  assert.deepEqual(JSON.parse(session.content[0].text), { user: { id: 'owner' } });
});

test('client lookup preserves canonical namespace IDs and forces source-specific records', async t => {
  const requests = [];
  const client = await connected(t, { request: async (...args) => { requests.push(args); return { items: [] }; } });
  await client.callTool({ name: 'find_clients', arguments: { q: 'A & B', limit: 20 } });
  const url = new URL(requests[0][0], 'https://example.test');
  assert.equal(url.searchParams.get('q'), 'A & B');
  assert.equal(url.searchParams.get('grouping'), 'records');
  await client.callTool({ name: 'get_client', arguments: target });
  assert.equal(requests[1][0], '/api/client-hub/sources/project-alpha%3Aprimary/business/standalone/local-id');
  for (const publicId of ['..', '../other', 'x/y', 'x\\y']) {
    const denied = await client.callTool({ name: 'get_client', arguments: { ...target, publicId } });
    assert.equal(denied.isError, true);
  }
  assert.equal(requests.length, 2);
});

test('creation uses one explicit mutation ID for both stages and preserves pending state', async t => {
  const calls = [];
  const client = await connected(t, { request: async (path, options) => {
    calls.push({ path, options });
    return calls.length === 1 ? { status: 'prepared' } : { status: 'pending', destinations: [{ state: 'pending' }] };
  } }, { allowWrites: true });
  const input = { mutationId, sourceIds: ['project-alpha:primary'], scopes: [{ businessAreaId: 'area', divisionId: null }], profile,
    relationship: { organizationRecordId: null, expectedOrganizationVersion: null } };
  const result = await client.callTool({ name: 'create_client', arguments: input });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.idempotencyKey, mutationId);
  assert.equal(calls[1].options.idempotencyKey, mutationId);
  assert.deepEqual(calls[0].options.body, { ...input, kind: 'client' });
  assert.deepEqual(calls[1].options.body, input);
  assert.equal(JSON.parse(result.content[0].text).result.status, 'pending');
});

test('admission failure never submits a create, and uncertain errors do not leak transport data', async t => {
  let calls = 0;
  const client = await connected(t, { request: async () => { calls++; throw Error('secret=jwt; csrf=hidden'); } }, { allowWrites: true });
  const input = { mutationId, sourceIds: ['project-alpha:primary'], scopes: [{ businessAreaId: 'area', divisionId: null }], profile,
    relationship: { organizationRecordId: null, expectedOrganizationVersion: null } };
  const result = await client.callTool({ name: 'create_client', arguments: input });
  assert.equal(result.isError, true);
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(result), /secret=|csrf=|jwt/);
});

test('grants require preview context, preserve payload and logical ID, and reject extra headers', async t => {
  const calls = [];
  const client = await connected(t, { request: async (...a) => { calls.push(a); return { replayed: false }; } }, { allowWrites: true });
  const bad = await client.callTool({ name: 'grant_delivery_access', arguments: { ...grant, operationId: mutationId } });
  assert.equal(bad.isError, true);
  const contextVersion = 'a'.repeat(64);
  await client.callTool({ name: 'grant_delivery_access', arguments: { ...grant, operationId: mutationId, expectedContextVersion: contextVersion } });
  assert.deepEqual(calls[0], ['/api/delivery/authenticated-grants', { method: 'POST', body: { ...grant, expectedContextVersion: contextVersion }, idempotencyKey: mutationId }]);
  await client.callTool({ name: 'revoke_delivery_access', arguments: { grantId: 'logical-grant', operationId: mutationId, expectedVersion: 3, reasonCode: 'owner_request' } });
  assert.equal(calls[1][0], '/api/delivery/authenticated-grants/logical-grant/revoke');
  assert.equal(calls[1][1].body.expectedVersion, 3);
  const extra = await client.callTool({ name: 'get_client', arguments: { ...target, headers: { Authorization: 'bad' } } });
  assert.equal(extra.isError, true);
  assert.equal(calls.length, 2);
});

test('tool contract uses exact client options and validates audience search bounds', async () => {
  const calls = [];
  const tools = buildTools({ request: async p => calls.push(p) });
  await tools.find(v => v.name === 'get_client_creation_options').execute({});
  assert.equal(calls[0], '/api/client-hub/directory/create-options?kind=client');
  const schema = tools.find(v => v.name === 'find_grant_audiences').schema;
  assert.equal(schema.safeParse({ folderBindingId: 'binding', q: 'a' }).success, false);
  assert.equal(schema.safeParse({ folderBindingId: 'binding', q: 'a'.repeat(101) }).success, false);
});

test('actual child-process stdio discovers tools without an Access login or network call', async t => {
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../src/cli.mjs', import.meta.url))],
    env: { PATH: process.env.PATH ?? '', LTDS_OPS_ORIGIN: 'https://ops.ledgetopdroneservices.com', LTDS_MCP_AGENT_ID: 'stdio-test' }, stderr: 'pipe' });
  const client = new Client({ name: 'stdio-test', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
});

test('existing public link lookup uses one exact read route without creating or widening a share', async t => {
  const calls = [];
  const existing = { share: { shareUrl: 'https://portal.example.test/s/synthetic#synthetic-secret' } };
  const client = await connected(t, { request: async (...args) => { calls.push(args); return existing; } });
  const prefix = 'Jobs/Clients/A & B/';
  const result = await client.callTool({ name: 'get_existing_public_link', arguments: { prefix, itemRef: 'opaque_file_ref' } });
  const url = new URL(calls[0][0], 'https://example.test');
  assert.equal(url.pathname, '/api/delivery/shares/active');
  assert.deepEqual([...url.searchParams], [['prefix', prefix], ['itemRef', 'opaque_file_ref']]);
  assert.equal(calls[0].length, 1); // Default GET: no mutation body or create endpoint.
  assert.deepEqual(JSON.parse(result.content[0].text), existing);
  for (const args of [{ prefix: '' }, { prefix: 'x\n' }, { prefix: 'x'.repeat(1025) }, { prefix, itemRef: '../x' }, { prefix, method: 'POST' }]) {
    assert.equal((await client.callTool({ name: 'get_existing_public_link', arguments: args })).isError, true);
  }
  assert.equal(calls.length, 1);
});

test('missing and denied existing public links never fall back to create or another identity', async t => {
  const calls = [];
  const client = await connected(t, { request: async (...args) => {
    calls.push(args);
    if (calls.length === 1) return { share: null };
    throw new AccessClientError('Operations request failed (HTTP 403).');
  } });
  const input = { name: 'get_existing_public_link', arguments: { prefix: 'Jobs/Synthetic/' } };
  assert.deepEqual(JSON.parse((await client.callTool(input)).content[0].text), { share: null });
  const denied = await client.callTool(input);
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /HTTP 403/);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.length === 1 && call[0].startsWith('/api/delivery/shares/active?')));
});

test('safe authentication diagnostics survive MCP while arbitrary errors stay hidden', async t => {
  const client = await connected(t, { session: async () => { throw new AccessClientError('Cloudflare Access session is missing or expired. Run the explicit login command.'); } });
  const result = await client.callTool({ name: 'get_connection', arguments: {} });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Run the explicit login command/);
});

test('CLI doctor preserves safe missing-executable diagnostic without echoing private paths', async () => {
  await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'doctor'], {
    env: { ...process.env, LTDS_CLOUDFLARED_PATH: 'nonexistent-private-executable-name' }, windowsHide: true,
  }), error => {
    assert.match(error.stderr, /Check cloudflared installation/);
    assert.doesNotMatch(error.stderr, /nonexistent-private-executable-name|ENOENT/);
    assert.equal(error.stdout, '');
    return true;
  });
});
