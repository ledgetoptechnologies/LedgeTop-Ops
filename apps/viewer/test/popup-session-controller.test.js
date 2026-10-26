'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const ORIGIN = 'https://ops.example.test';
const GRANT = '11111111-2222-4333-8444-555555555555';
const CHANNEL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// Execute the production routing, message listener and redemption handler. The
// synthetic peers deliberately model Window identity independently of origin.
function fixture(options = {}) {
  const posts = [], applied = [], failures = [], listeners = new Map();
  const peer = name => ({ closed: false, postMessage: (data, origin) => posts.push({ name, data, origin }) });
  const opener = peer('opener'), parent = peer('parent');
  const window = { opener, addEventListener: (type, listener) => listeners.set(type, listener) };
  window.parent = options.embedded ? parent : window;
  if (options.closed) opener.closed = true;
  if (options.noOpener) window.opener = null;
  const session = {
    subject: 'person-one', audience: 'ops', model: { id: 'model-one', activeVersion: { id: 'version-one' } },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
  let redemptions = 0, unavailable = 0;
  const context = vm.createContext({
    window, VIEW_MODE: options.mode || 'session',
    activeViewerSession: options.bootstrap ? null : session, PROJECT: session.model,
    reviewControllerCandidate: Object.hasOwn(options, 'marker') ? options.marker : null,
    REVIEW_CONTROLLER_ID: options.marker === CHANNEL_ID ? CHANNEL_ID : null,
    reviewSessionChannel: options.channel ? { postMessage: data => posts.push({ name: 'isolated', data }) } : null,
    sessionAllowedOrigins: options.origins || [ORIGIN],
    sessionRenewalAttempt: {}, sessionRenewalPending: true, sessionRenewalBlocked: false,
    pendingReviewRenewalRequestId: null, sessionAccessGeneration: 0,
    sessionRenewalBackoffIndex: 0, sessionRenewalMinimumDelayMs: 1000,
    AbortController,
    redeemViewerGrant: async () => {
      redemptions++;
      return options.redeemed || { ...session, expiresAt: new Date(Date.now() + 120_000).toISOString() };
    },
    clearSessionRenewalPending() {}, nextSessionRenewalBackoff() {},
    applyViewerSession: value => applied.push(value),
    postSessionRenewalFailure: (...args) => failures.push(args), retrySessionAccess() {},
    setSessionAccessState: (...args) => failures.push(args),
    pcApi: () => ({ accessUnavailable: () => unavailable++ }),
  });
  vm.runInContext(source.slice(source.indexOf('function sessionControlWindow()'), source.indexOf('function sessionAccessLabel(')), context);
  vm.runInContext(source.slice(source.indexOf('async function handleSessionRenewalMessage'), source.indexOf('if (reviewSessionChannel) reviewSessionChannel.onmessage')), context);
  // Capture completion without replacing the production listener's guards.
  vm.runInContext('const realRenewalHandler = handleSessionRenewalMessage; handleSessionRenewalMessage = (...args) => (lastRenewal = realRenewalHandler(...args));', context);
  const listenerStart = source.indexOf("window.addEventListener('message', event => {");
  vm.runInContext(source.slice(listenerStart, source.indexOf('\n});', listenerStart) + '\n});'.length), context);
  return {
    context, window, opener, parent, session, posts, applied, failures,
    redemptions: () => redemptions, unavailable: () => unavailable,
    async dispatch({ source: sender = opener, origin = ORIGIN, data = { version: 1, type: 'ltds-viewer:renew-session', grant: GRANT } } = {}) {
      context.lastRenewal = null;
      listeners.get('message')({ source: sender, origin, data });
      await context.lastRenewal;
    },
  };
}

test('a legacy popup without a fragment routes ready and renewal only through allowed opener origins', async () => {
  const f = fixture();
  assert.equal(f.context.sessionControlWindow(), f.opener);
  assert.equal(f.context.postToAllowedController({ version: 1, type: 'ltds-viewer:ready' }), true);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].origin, ORIGIN);
  assert.equal(f.posts[0].name, 'opener');
  await f.dispatch();
  assert.equal(f.redemptions(), 1);
  assert.equal(f.applied.length, 1);
  assert.equal(f.posts.at(-1).data.type, 'ltds-viewer:session-renewed');
  assert.equal(f.posts.at(-1).origin, ORIGIN);
});

test('the first redeemed session establishes popup routing before initialization and initial ready', () => {
  const f = fixture({ bootstrap: true, origins: [] });
  const writes = [], initialized = [], scheduled = [];
  const redeemed = {
    ...f.session, sessionId: 'first-session', accessToken: 'synthetic-browser-capability',
    allowedEmbedOrigins: [ORIGIN], permissions: { view: true, measure: true }, displayUnits: 'metric',
  };
  Object.assign(f.context, {
    TILES_URL: null, EPT_URL: null, sessionStorageKey: null, SESSION_STORAGE_PREFIX: 'test:',
    sessionStorage: { setItem: (...args) => writes.push(args) }, SHARE_PERMISSIONS: {},
    setDisplayUnits() {}, applyProjectConfig() {},
    init: () => initialized.push(f.context.activeViewerSession),
    state: { meshSource: 'none' }, tilesRenderer: null, viewerProductDownloads: null,
    scheduleLodAvailabilityRefresh() {}, stopLodAvailabilityRefresh() {},
    scheduleSessionRenewal: session => { scheduled.push(session); f.context.activeViewerSession = session; },
    recoverFailedLodTiles() {},
  });
  vm.runInContext(source.slice(source.indexOf('function applyViewerSession('), source.indexOf('async function bootstrapSession()')), f.context);
  assert.equal(f.context.activeViewerSession, null);
  assert.equal(f.context.sessionControlWindow(), null);
  f.context.applyViewerSession(redeemed, { initialize: true });
  assert.equal(initialized.length, 1);
  assert.equal(initialized[0], redeemed, 'initialization sees the redeemed session before any controller message');
  assert.equal(f.context.activeViewerSession, redeemed);
  assert.equal(f.context.sessionControlWindow(), f.opener);
  assert.equal(writes.length, 1);
  assert.equal(scheduled[0], redeemed);
  assert.equal(f.posts.length, 1, 'the actual initializer sends initial ready exactly once');
  assert.deepEqual(JSON.parse(JSON.stringify(f.posts[0])), {
    name: 'opener', origin: ORIGIN,
    data: { version: 1, type: 'ltds-viewer:ready', modelId: redeemed.model.id, expiresAt: redeemed.expiresAt },
  });
});

test('session diagnostics distinguish popup, iframe, isolated and unavailable controllers', () => {
  for (const [options, expected] of [
    [{}, 'popup'], [{ embedded: true }, 'embedded'],
    [{ marker: CHANNEL_ID, channel: true }, 'isolated'], [{ noOpener: true }, 'none'],
    [{ marker: CHANNEL_ID }, 'none'],
  ]) {
    const f = fixture(options);
    Object.assign(f.context, {
      sessionAccessState: 'active', sessionAccessReason: null,
      lodTileRecoveryPending: false, lastSessionAccessFailure: null,
    });
    vm.runInContext(source.slice(source.indexOf('function sessionDiagnostics()'), source.indexOf('function requestSessionRenewal(')), f.context);
    assert.equal(f.context.sessionDiagnostics().controller, expected);
  }
});

test('an embedding parent takes precedence over an available opener', async () => {
  const f = fixture({ embedded: true });
  assert.equal(f.context.sessionControlWindow(), f.parent);
  await f.dispatch();
  assert.equal(f.redemptions(), 0);
  await f.dispatch({ source: f.parent });
  assert.equal(f.redemptions(), 1);
  assert.equal(f.posts.at(-1).name, 'parent');
});

test('popup routing requires a redeemed session, permitted origins and a live opener', async t => {
  for (const options of [{ mode: 'view' }, { mode: 'embed' }, { mode: 'admin' }, { bootstrap: true }, { origins: [] }, { closed: true }, { noOpener: true }]) {
    await t.test(JSON.stringify(options), async () => {
      const f = fixture(options);
      assert.equal(f.context.sessionControlWindow(), null);
      assert.equal(f.context.postToAllowedController({ version: 1, type: 'ltds-viewer:ready' }), false);
      await f.dispatch();
      assert.equal(f.redemptions(), 0);
      assert.equal(f.posts.length, 0);
    });
  }
});

test('isolated review markers never fall back to an opener, even without BroadcastChannel', async t => {
  for (const marker of [CHANNEL_ID, '', 'malformed']) {
    await t.test(JSON.stringify(marker), async () => {
      const f = fixture({ marker });
      assert.equal(f.context.sessionControlWindow(), null);
      assert.equal(f.context.postToAllowedController({ version: 1, type: 'ltds-viewer:ready' }), false);
      await f.dispatch();
      assert.equal(f.redemptions(), 0);
      assert.equal(f.posts.length, 0);
    });
  }
  const isolated = fixture({ marker: CHANNEL_ID, channel: true });
  assert.equal(isolated.context.postToAllowedController({ version: 1, type: 'ltds-viewer:ready' }), true);
  assert.equal(isolated.posts[0].name, 'isolated');
  await isolated.dispatch();
  assert.equal(isolated.redemptions(), 0);
});

test('popup messages reject wrong Window, origin, protocol, type and malformed grants', async () => {
  const f = fixture();
  await f.dispatch({ source: {} });
  await f.dispatch({ origin: 'https://untrusted.example.test' });
  await f.dispatch({ origin: `${ORIGIN}.attacker.test` });
  await f.dispatch({ data: { version: 2, type: 'ltds-viewer:renew-session', grant: GRANT } });
  await f.dispatch({ data: { version: 1, type: 'ltds-viewer:controller-ready', grant: GRANT } });
  await f.dispatch({ data: { version: 1, type: 'ltds-viewer:renew-session', grant: 'malformed' } });
  await f.dispatch({ data: null });
  assert.equal(f.redemptions(), 0);
  assert.equal(f.applied.length, 0);
  assert.equal(f.posts.length, 0);
});

test('an allowed popup sender cannot change the redeemed model, version, subject or audience', async t => {
  const baseline = fixture().session;
  for (const changed of [
    { model: { ...baseline.model, id: 'model-two' } },
    { model: { ...baseline.model, activeVersion: { id: 'version-two' } } },
    { subject: 'person-two' }, { audience: 'client' },
  ]) {
    await t.test(JSON.stringify(changed), async () => {
      const f = fixture({ redeemed: { ...baseline, ...changed } });
      await f.dispatch();
      assert.equal(f.redemptions(), 1);
      assert.equal(f.applied.length, 0);
      assert.ok(f.failures.length > 0);
      assert.equal(f.posts.length, 0);
    });
  }
});
