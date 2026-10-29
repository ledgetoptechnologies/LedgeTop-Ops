'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createViewerSessionCapabilityStore, VIEWER_SESSION_STORAGE_PREFIX: PREFIX } = require('../viewer-session-capability-store.mjs');
const { renderStaffNavigation } = require('../viewer-staff-navigation.mjs');
const { renderClientNavigation } = require('../viewer-client-navigation.mjs');
const { measurementAssetBearer } = require('../measurement-surface-client.mjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const GRANT = '11111111-2222-4333-8444-555555555555';
const KEY = `${PREFIX}synthetic-session`;

function blocked(name = 'SecurityError') { throw Object.assign(new Error('Synthetic storage denial'), { name }); }
function fixture({ denied = 'getter', active = false, reject = false } = {}) {
  const calls = [], loading = [], posts = [], initialized = [], values = new Map([[KEY, 'persisted-old-capability']]);
  const session = {
    sessionId: 'synthetic-session', accessToken: 'initial-server-capability', sessionMode: 'published',
    subject: 'person-one', audience: 'client', displayUnits: 'imperial', permissions: { view: true, measure: true },
    model: { id: 'model-one', activeVersion: { id: 'version-one' } },
    allowedEmbedOrigins: ['https://portal.example'], expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  let next = session;
  const storage = {
    getItem: key => denied === 'get' ? blocked() : values.get(key) ?? null,
    setItem: (key, value) => denied === 'set' ? blocked('QuotaExceededError') : values.set(key, value),
    removeItem: key => denied === 'remove' ? blocked() : values.delete(key),
  };
  const startupPhases = [];
  const window = { parent: { postMessage: (message, origin) => posts.push({ message, origin }) },
    __ltdsViewerStartupDiagnostics: { mark: (...args) => startupPhases.push(args) } };
  Object.defineProperty(window, 'sessionStorage', { get: () => denied === 'getter' ? blocked() : storage });
  const sessionCapabilities = createViewerSessionCapabilityStore({ storage: () => window.sessionStorage });
  const context = vm.createContext({
    window, URL, AbortController, renderStaffNavigation, renderClientNavigation, dom: {},
    VIEW_MODE: 'session', SESSION_GRANT: active ? null : GRANT, SESSION_STORAGE_PREFIX: PREFIX,
    sessionStorageKey: active ? KEY : null, sessionCapabilities,
    location: { href: `https://viewer.example/session/${active ? 'active/synthetic-session' : GRANT}` },
    history: { replaceState() {} },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      const deniedResponse = reject || (url.endsWith('/current') && !options.headers?.Authorization);
      return { ok: !deniedResponse, status: deniedResponse ? (typeof reject === 'number' ? reject : 401) : 200,
        json: async () => deniedResponse ? { error: 'Viewer authorization required' } : next };
    },
    TILES_URL: null, EPT_URL: null, ORTHO_URL: null, DSM_URL: null, DTM_URL: null,
    SHARE_PERMISSIONS: {}, PROJECT: null, activeViewerSession: null,
    sessionAllowedOrigins: [], reviewSessionChannel: null, reviewControllerCandidate: null,
    state: { meshSource: 'none' }, tilesRenderer: null, viewerProductDownloads: null,
    sessionAccessGeneration: 0, sessionRenewalBlocked: false, sessionRenewalPending: false,
    sessionRenewalAttempt: null, sessionRenewalResponseTimer: null, pendingReviewRenewalRequestId: null,
    sessionRenewalBackoffIndex: 0, sessionRenewalMinimumDelayMs: 1000,
    setDisplayUnits() {}, applyProjectConfig() {},
    init: () => initialized.push(context.activeViewerSession),
    updateLoading: (...args) => loading.push(args),
    scheduleLodAvailabilityRefresh() {}, stopLodAvailabilityRefresh() {},
    scheduleSessionRenewal() {}, recoverFailedLodTiles() {}, setSessionAccessState() {},
    clearTimeout() {}, nextSessionRenewalBackoff() {}, retrySessionAccess() {},
    postSessionRenewalFailure() {}, pcApi: () => ({ renewAccess() {}, accessUnavailable() {} }),
    measurementAssetBearer: value => measurementAssetBearer(value, 'https://viewer.example'),
  });
  Object.defineProperty(context, 'sessionStorage', { get: () => window.sessionStorage });
  // Execute the production API/header, controller, initializer, bootstrap and
  // renewal functions. The capability store above is the actual imported helper.
  for (const [start, end] of [
    ['async function redeemViewerGrant(', 'function stopLodAvailabilityRefresh('],
    ['function sessionControlWindow()', 'function sessionAccessLabel('],
    ['function clearSessionRenewalPending(', 'function nextSessionRenewalBackoff('],
    ['function applyViewerSession(', 'async function handleSessionRenewalMessage'],
    ['async function handleSessionRenewalMessage', 'if (reviewSessionChannel) reviewSessionChannel.onmessage'],
  ]) vm.runInContext(source.slice(source.indexOf(start), source.indexOf(end)), context);
  const tokenProviders = source.split('\n').filter(line => /^\s*token:\s*\(\)\s*=>/.test(line) && line.includes('sessionStorageKey'))
    .map(line => vm.runInContext(`(${line.trim().slice('token:'.length).replace(/,$/, '')})`, context));
  assert.equal(tokenProviders.length, 3, 'admin calculation, personal workspace and surface providers are exercised');
  return { context, session, values, calls, loading, posts, initialized, tokenProviders, sessionCapabilities, startupPhases,
    setNext(value) { next = value; } };
}

test('actual bootstrap emits bounded startup milestones without capability or error text', async () => {
  const f = fixture();
  await f.context.bootstrapSession();
  assert.deepEqual(f.startupPhases, [['redeem-started'], ['redeem-http', 200], ['session-applied'],
    ['init-returned'], ['ready-sent']]);
  const rejected = fixture({ reject: 403 });
  await rejected.context.bootstrapSession();
  assert.deepEqual(rejected.startupPhases, [['redeem-started'], ['redeem-http', 403], ['bootstrap-failed']]);
  const failedInit = fixture();
  failedInit.context.init = () => { throw new Error('private model URL or error'); };
  await failedInit.context.bootstrapSession();
  assert.deepEqual(failedInit.startupPhases, [['redeem-started'], ['redeem-http', 200], ['session-applied'],
    ['bootstrap-failed']]);
  const noController = fixture();
  noController.context.postToAllowedController = () => false;
  await noController.context.bootstrapSession();
  assert.deepEqual(noController.startupPhases, [['redeem-started'], ['redeem-http', 200], ['session-applied'],
    ['init-returned']], 'missing controller must not look like a ready message was sent');
});

test('fresh authorized bootstrap, headers and all model token providers work with denied storage', async t => {
  for (const denied of ['getter', 'get', 'set']) await t.test(denied, async () => {
    const f = fixture({ denied });
    await f.context.bootstrapSession();
    assert.equal(f.initialized.length, 1);
    assert.equal(f.posts.length, 1);
    assert.equal(f.posts[0].message.type, 'ltds-viewer:ready');
    assert.equal(f.posts[0].message.modelId, 'model-one');
    assert.equal(f.posts[0].origin, 'https://portal.example');
    assert.equal(f.calls[0].options.headers.Authorization, undefined, 'a new grant starts without an invented bearer');
    assert.deepEqual(JSON.parse(f.calls[0].options.body), { grant: GRANT });
    await f.context.currentViewerSession();
    assert.equal(f.calls.at(-1).options.headers.Authorization, 'Bearer initial-server-capability');
    for (const token of f.tokenProviders) assert.equal(token(), 'initial-server-capability');
  });
});

test('renewal sends the current capability and installs the newest token even when persistence fails', async t => {
  for (const denied of ['getter', 'set']) await t.test(denied, async () => {
    const f = fixture({ denied });
    await f.context.bootstrapSession();
    f.setNext({ ...f.session, accessToken: 'renewed-server-capability', expiresAt: new Date(Date.now() + 600_000).toISOString() });
    f.context.sessionRenewalAttempt = {};
    f.context.sessionRenewalPending = true;
    await f.context.handleSessionRenewalMessage({ version: 1, type: 'ltds-viewer:renew-session', grant: GRANT });
    assert.equal(f.calls.at(-1).url, '/api/v1/sessions/redeem');
    assert.equal(f.calls.at(-1).options.headers.Authorization, 'Bearer initial-server-capability');
    assert.equal(f.posts.at(-1).message.type, 'ltds-viewer:session-renewed');
    await f.context.currentViewerSession();
    assert.equal(f.calls.at(-1).options.headers.Authorization, 'Bearer renewed-server-capability');
    for (const token of f.tokenProviders) assert.equal(token(), 'renewed-server-capability');
    if (denied === 'set') assert.equal(f.values.get(KEY), 'persisted-old-capability');
  });
});

test('unavailable persistence on reload fails visibly without issuing or inventing authorization', async () => {
  const f = fixture({ denied: 'getter', active: true });
  await f.context.bootstrapSession();
  assert.equal(f.initialized.length, 0);
  assert.equal(f.posts.length, 0);
  assert.deepEqual(f.calls.map(call => call.url), ['/api/v1/sessions/current']);
  assert.equal(f.calls[0].options.headers.Authorization, undefined);
  assert.equal(f.loading.at(-1)[0], 'Viewer session unavailable');
  assert.equal(f.sessionCapabilities.read(KEY), null);
});

test('bootstrap denial cannot throw during cleanup or revive stale storage after failed removal', async () => {
  const f = fixture({ denied: 'remove', active: true, reject: true });
  await f.context.bootstrapSession();
  assert.equal(f.calls[0].options.headers.Authorization, 'Bearer persisted-old-capability');
  assert.equal(f.loading.at(-1)[0], 'Viewer session unavailable');
  assert.equal(f.values.get(KEY), 'persisted-old-capability');
  assert.equal(f.sessionCapabilities.read(KEY), null);
  for (const token of f.tokenProviders) assert.equal(token(), null);
  await assert.rejects(f.context.currentViewerSession(), { status: 401 });
  assert.equal(f.calls.at(-1).options.headers.Authorization, undefined);
  assert.equal(f.posts.length, 0);
});

test('storage fallback never authorizes a renewal that changes model, version, subject or audience', async t => {
  for (const changed of [{ model: { id: 'other-model', activeVersion: { id: 'version-one' } } },
    { model: { id: 'model-one', activeVersion: { id: 'other-version' } } }, { subject: 'other-person' }, { audience: 'ops' }]) {
    await t.test(JSON.stringify(changed), async () => {
      const f = fixture();
      await f.context.bootstrapSession();
      f.setNext({ ...f.session, ...changed, accessToken: 'rejected-server-capability' });
      f.context.sessionRenewalAttempt = {};
      await f.context.handleSessionRenewalMessage({ version: 1, type: 'ltds-viewer:renew-session', grant: GRANT });
      assert.equal(f.context.activeViewerSession, f.session);
      assert.equal(f.context.PROJECT, f.session.model);
      assert.equal(f.sessionCapabilities.read(KEY), 'initial-server-capability');
      assert.equal(f.posts.length, 1, 'no renewed event is emitted');
    });
  }
});

test('expired or revoked fresh grants still fail visibly without an ambient bearer fallback', async t => {
  for (const status of [410, 403]) await t.test(String(status), async () => {
    const f = fixture({ denied: 'getter', reject: status });
    await f.context.bootstrapSession();
    assert.equal(f.initialized.length, 0);
    assert.equal(f.posts.length, 0);
    assert.equal(f.context.sessionStorageKey, null);
    assert.equal(f.context.activeViewerSession, null);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, '/api/v1/sessions/redeem');
    assert.equal(f.calls[0].options.headers.Authorization, undefined);
    assert.equal(f.loading.at(-1)[0], 'Viewer session unavailable');
    for (const token of f.tokenProviders) assert.equal(token(), null);
  });
});
