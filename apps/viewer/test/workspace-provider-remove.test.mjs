import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { attemptProviderName, removeProcessingProvider, removeProviderConfirmation } from '../workspace-provider-remove.mjs';

const source = fs.readFileSync(new URL('../workspace-projects.js', import.meta.url), 'utf8');

function providerDetailFor(provider, { write = true } = {}) {
  const context = {
    state: { section: 'providers', selectedProviderId: provider.id, providers: [provider], presets: [] },
    api: async () => ({}), can: (permission) => permission !== 'viewer.providers.write' || write, render() {}, Map, Date,
    providerName: (value) => value, esc: (value) => String(value), available: (value) => String(value),
    dateTime: (value) => value, badge: (value) => value, empty: (value) => value,
    button: (action, id, label) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
    dangerButton: (action, id, label) => `<button class="danger-button" data-action="${action}" data-id="${id}">${label}</button>`,
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(source.indexOf('const providerCapabilityRefreshes='), source.indexOf('function providerForm('))}\nthis.providerDetail=providerDetail;`, context);
  return context.providerDetail(provider);
}

test('each node offers a Remove node action to writers only', () => {
  const provider = { id: 'node-old', type: 'nodeodm', displayName: 'Old node', capabilities: {}, enabled: false };
  const html = providerDetailFor(provider);
  assert.match(html, /<button class="danger-button" data-action="remove-provider" data-id="node-old">Remove node<\/button>/);
  assert.doesNotMatch(providerDetailFor(provider, { write: false }), /remove-provider/);
});

test('the remove action is dispatched behind the provider write permission', () => {
  const writeGate = source.indexOf("if(!can('viewer.providers.write'))return;if(action==='edit-provider')");
  const handler = source.indexOf("if(action==='remove-provider')");
  assert.ok(writeGate > 0 && handler > writeGate, 'remove-provider is handled after the write-permission gate');
  assert.match(source.slice(handler, handler + 400), /removeProcessingProvider\(\{provider,confirm:/);
});

test('removal asks for confirmation naming the node and sends nothing when cancelled', async () => {
  const provider = { id: 'node/old', displayName: 'Hangar node' };
  const prompts = [], calls = [];
  const removed = await removeProcessingProvider({
    provider,
    confirm: async (message, options) => { prompts.push({ message, options }); return false; },
    mutate: async (...args) => { calls.push(args); return { removed: true }; },
  });
  assert.equal(removed, false);
  assert.equal(calls.length, 0);
  assert.match(prompts[0].message, /Remove "Hangar node"\?/);
  assert.match(prompts[0].message, /can't be undone/);
  assert.deepEqual(prompts[0].options, { title: 'Remove node', submitLabel: 'Remove node', destructive: true });
  assert.deepEqual(removeProviderConfirmation(provider).options, prompts[0].options);
});

test('confirmed removal deletes the node and reports refusals without claiming success', async () => {
  const provider = { id: 'node/old', displayName: 'Hangar node' };
  const calls = [];
  const confirmed = await removeProcessingProvider({
    provider,
    confirm: async () => true,
    mutate: async (...args) => { calls.push(args); return { removed: true, provider: { id: provider.id } }; },
  });
  assert.equal(confirmed, true);
  assert.deepEqual(calls, [['/api/v1/processing/providers/node%2Fold', { method: 'DELETE', body: {} }, 'Removed Hangar node']]);

  // mutate() toasts the server's refusal (busy or last enabled node) and resolves undefined.
  const refused = await removeProcessingProvider({ provider, confirm: async () => true, mutate: async () => undefined });
  assert.equal(refused, false);
});

test('old tasks keep a removed node name', () => {
  const providers = [{ id: 'live', displayName: 'Live node' }];
  assert.equal(attemptProviderName({ providerId: 'live', providerDisplayName: 'Stale label' }, providers), 'Live node');
  assert.equal(attemptProviderName({ providerId: 'gone', providerDisplayName: 'Old node', providerRemoved: true }, providers), 'Old node (removed)');
  assert.equal(attemptProviderName({ providerId: 'gone', providerDisplayName: 'Old node' }, providers), 'Old node');
  assert.equal(attemptProviderName({ providerId: 'gone' }, providers), null);
  assert.equal(attemptProviderName(null, providers), null);
  assert.match(source, /taskFact\('Provider',attemptProviderName\(attempt,state\.providers\)\)/);
});
