import assert from 'node:assert/strict';
import test from 'node:test';
import { createViewerSessionCapabilityStore, VIEWER_SESSION_STORAGE_PREFIX as PREFIX } from '../viewer-session-capability-store.mjs';

const KEY = `${PREFIX}11111111-2222-4333-8444-555555555555`;
const OTHER = `${PREFIX}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
function denied(name = 'SecurityError') {
  throw Object.assign(new Error('Synthetic storage failure'), { name });
}
function storage() {
  const values = new Map();
  return {
    values,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
}

test('denied storage getter cannot interrupt a page capability or revive it after clearing', () => {
  const store = createViewerSessionCapabilityStore({ storage: () => denied() });
  assert.equal(store.read(KEY), null);
  store.write(KEY, 'first-server-capability');
  assert.equal(store.read(KEY), 'first-server-capability');
  store.write(KEY, 'renewed-server-capability');
  assert.equal(store.read(KEY), 'renewed-server-capability');
  store.clear(KEY);
  assert.equal(store.read(KEY), null);
});

test('quota or denied writes retain the newest page capability rather than an older persisted value', async t => {
  for (const name of ['QuotaExceededError', 'SecurityError']) await t.test(name, () => {
    const persisted = storage();
    persisted.values.set(KEY, 'old-capability');
    const store = createViewerSessionCapabilityStore({ storage: () => ({ ...persisted, setItem: () => denied(name) }) });
    assert.equal(store.read(KEY), 'old-capability');
    store.write(KEY, 'new-capability');
    assert.equal(persisted.values.get(KEY), 'old-capability');
    assert.equal(store.read(KEY), 'new-capability');
  });
});

test('read denial does not affect a capability issued later to the current page', () => {
  const persisted = storage();
  const store = createViewerSessionCapabilityStore({ storage: () => ({ ...persisted, getItem: () => denied() }) });
  assert.equal(store.read(KEY), null);
  store.write(KEY, 'server-capability');
  assert.equal(store.read(KEY), 'server-capability');
});

test('failed removal leaves a page tombstone and never reads the stale persisted token again', () => {
  const persisted = storage();
  persisted.values.set(KEY, 'stale-capability');
  const store = createViewerSessionCapabilityStore({ storage: () => ({ ...persisted, removeItem: () => denied() }) });
  assert.equal(store.read(KEY), 'stale-capability');
  store.clear(KEY);
  assert.equal(persisted.values.get(KEY), 'stale-capability');
  assert.equal(store.read(KEY), null);
  store.write(KEY, 'new-server-capability');
  assert.equal(store.read(KEY), 'new-server-capability');
});

test('healthy persistence restores only an explicitly requested Viewer session key', () => {
  const persisted = storage();
  const firstPage = createViewerSessionCapabilityStore({ storage: () => persisted });
  firstPage.write(KEY, 'one');
  firstPage.write(OTHER, 'two');
  const reloaded = createViewerSessionCapabilityStore({ storage: () => persisted });
  assert.equal(reloaded.read(KEY), 'one');
  assert.equal(reloaded.read(OTHER), 'two');
  reloaded.clear(KEY);
  assert.equal(persisted.values.has(KEY), false);
  assert.equal(reloaded.read(OTHER), 'two');
});

test('new page memory cannot invent a token when persistence is unavailable', () => {
  const firstPage = createViewerSessionCapabilityStore({ storage: () => denied() });
  firstPage.write(KEY, 'server-capability');
  const reloaded = createViewerSessionCapabilityStore({ storage: () => denied() });
  assert.equal(reloaded.read(KEY), null);
});

test('non-session namespaces, malformed keys and empty values never reach persistence', () => {
  let accesses = 0;
  const store = createViewerSessionCapabilityStore({ storage: () => { accesses++; return storage(); } });
  for (const key of [null, '', 'ltds-viewer-admin-token', 'ltds-viewer-review:channel', PREFIX, `${PREFIX}bad/key`]) {
    store.write(key, 'not-a-session-capability');
    assert.equal(store.read(key), null);
    store.clear(key);
  }
  store.write(KEY, '');
  store.write(KEY, null);
  assert.equal(accesses, 0);
});
