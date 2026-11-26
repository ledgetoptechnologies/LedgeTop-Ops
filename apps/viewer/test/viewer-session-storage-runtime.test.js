'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createViewerSessionCapabilityStore, VIEWER_SESSION_STORAGE_PREFIX: PREFIX } = require('../viewer-session-capability-store.mjs');
const { renderStaffNavigation } = require('../viewer-staff-navigation.mjs');
const { clientPortalTarget, renderClientNavigation } = require('../viewer-client-navigation.mjs');
const { viewerFailureState, visibleViewerReturn, clearViewerTerminalState, renderViewerTerminalState } = require('../viewer-terminal-state.mjs');
const { measurementAssetBearer } = require('../measurement-surface-client.mjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
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
    viewerFailureState, visibleViewerReturn, clearViewerTerminalState, renderViewerTerminalState,
    window, URL, AbortController, renderStaffNavigation, renderClientNavigation, clientPortalTarget, dom: {},
    document: { getElementById: () => null },
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
    state: { meshSource: 'none' }, tilesRenderer: null, viewerProductDownloads: null, propertyLines: null,
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
  assert.equal(tokenProviders.length, 4, 'admin calculation, personal workspace, surface and Marks providers are exercised');
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

test('denied bootstrap replaces viewer controls and uses only the configured portal origin', async () => {
  const f = fixture({ active: true, reject: true });
  const recovery = { hidden: true }, link = { hidden: true }, classes = [];
  f.context.document = { body: { classList: { add: name => classes.push(name) } },
    getElementById: id => ({ 'session-recovery': recovery, 'recovery-client-portal': link })[id] || null };
  f.context.window.parent = f.context.window;
  const originalFetch = f.context.fetch;
  f.context.fetch = async (url, options) => url === '/api/v1/session-recovery'
    ? { ok: true, json: async () => ({ clientPortalOrigin: 'https://portal.example.test' }) }
    : originalFetch(url, options);
  await f.context.bootstrapSession();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(classes, ['session-bootstrap-failed']);
  assert.equal(recovery.hidden, false);
  assert.equal(link.href, 'https://portal.example.test/portal');
  assert.equal(link.hidden, false);
  assert.equal(f.initialized.length, 0);
});

test('invalid recovery destination cannot become a link', async () => {
  const f = fixture({ active: true, reject: true });
  const link = { hidden: true };
  f.context.document = { body: { classList: { add() {} } },
    getElementById: id => id === 'session-recovery' ? {} : link };
  f.context.window.parent = f.context.window;
  const originalFetch = f.context.fetch;
  f.context.fetch = async (url, options) => url === '/api/v1/session-recovery'
    ? { ok: true, json: async () => ({ clientPortalOrigin: 'javascript:alert(1)' }) }
    : originalFetch(url, options);
  await f.context.bootstrapSession();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(link.hidden, true);
  assert.equal(link.href, undefined);
});

test('recovery link remains hidden while configuration is delayed or absent', async () => {
  // Author CSS must override the link display rule as well as the UA [hidden] rule.
  assert.match(html, /#session-recovery\s+a\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.match(html, /<a id="recovery-client-portal" hidden>/);
  const f = fixture({ active: true, reject: true });
  const link = { hidden: true }, recovery = { hidden: true };
  f.context.document = { body: { classList: { add() {} } },
    getElementById: id => id === 'session-recovery' ? recovery : link };
  f.context.window.parent = f.context.window;
  let complete;
  const originalFetch = f.context.fetch;
  f.context.fetch = (url, options) => url === '/api/v1/session-recovery'
    ? new Promise(resolve => { complete = resolve; }) : originalFetch(url, options);
  await f.context.bootstrapSession();
  assert.equal(recovery.hidden, false);
  assert.equal(link.hidden, true);
  assert.equal(link.href, undefined);
  complete({ ok: true, json: async () => ({ clientPortalOrigin: null }) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(link.hidden, true);
  assert.equal(link.href, undefined);
});

test('embedded recovery does not request or expose a portal destination', async () => {
  const f = fixture({ active: true, reject: true });
  const link = { hidden: true }, recovery = { hidden: true };
  const workspace = { hidden: false }, topLevelGuidance = { hidden: false }, embeddedGuidance = { hidden: true };
  f.context.document = { body: { classList: { add() {} } },
    getElementById: id => ({ 'session-recovery': recovery, 'recovery-client-portal': link,
      'recovery-workspace': workspace, 'recovery-top-level-guidance': topLevelGuidance,
      'recovery-embedded-guidance': embeddedGuidance })[id] || null };
  await f.context.bootstrapSession();
  assert.equal(recovery.hidden, false);
  assert.equal(link.hidden, true);
  assert.equal(link.href, undefined);
  assert.equal(workspace.hidden, true);
  assert.equal(topLevelGuidance.hidden, true);
  assert.equal(embeddedGuidance.hidden, false);
  assert.match(html, /id="recovery-embedded-guidance" hidden>Close this viewer and reopen the model from the Client Portal/);
  assert.deepEqual(f.calls.map(call => call.url), ['/api/v1/sessions/current']);
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


// Actual terminal renderer and bootstrap functions, with a minimal DOM facade.
// This checks production state/focus/actions, not browser accessibility-tree behavior.
function terminalDom(f) {
  const nodes = new Map();
  const document = {activeElement: null, createElement: tag => node('', tag), getElementById: id => nodes.get(id) || null};
  function node(id, tag = 'div') {
    const attributes = new Map(), classes = new Set();
    const n = {id, tagName: tag, hidden: false, textContent: '', style: {}, children: [], listeners: {}, focusCalls: 0,
      classList: {add: (...values) => values.forEach(x => classes.add(x)), remove: (...values) => values.forEach(x => classes.delete(x)), contains: x => classes.has(x)},
      setAttribute(key, value) { attributes.set(key, value); if (key === 'href') this.href = value; },
      removeAttribute(key) { attributes.delete(key); if (key === 'href') delete this.href; },
      getAttribute: key => attributes.get(key) ?? null, hasAttribute: key => attributes.has(key),
      addEventListener(key, callback) { this.listeners[key] = callback; },
      replaceChildren(...children) { this.children = children; },
      closest() { return this.hidden || this.parent?.hidden ? this : null; },
      focus() { this.focusCalls++; document.activeElement = this; },
    };
    if (id) nodes.set(id, n); return n;
  }
  document.body = node('body');
  for (const id of ['session-recovery','recovery-message','recovery-title','recovery-detail','recovery-retry-actions',
    'recovery-client-portal','recovery-workspace','recovery-top-level-guidance','recovery-embedded-guidance',
    'loading-overlay','loading-text','loading-progress','loading-cancel','loading-actions',
    'share-password-overlay','share-password-submit','share-password-error','share-password-input']) node(id);
  for (const id of ['session-recovery','recovery-client-portal','recovery-embedded-guidance']) nodes.get(id).hidden = true;
  nodes.get('recovery-workspace').setAttribute('href','/workspace');
  f.context.document = document;
  for (const id of ['loading-overlay','loading-text','loading-progress','loading-cancel','loading-actions',
    'share-password-overlay','share-password-submit','share-password-error','share-password-input'])
    f.context.dom[id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = nodes.get(id);
  f.context.location.reload = () => { document.reloads = (document.reloads || 0) + 1; };
  f.context.window.parent = f.context.window;
  vm.runInContext(source.slice(source.indexOf('function updateStatus('), source.indexOf('let errorHideTimer')), f.context);
  return {nodes, document, node};
}

test('actual initial bootstrap renders named focused terminal recovery for 401/403/404/410 without replay', async t => {
  for (const status of [401,403,404,410]) await t.test(String(status), async () => {
    const f = fixture({reject: status}), ui = terminalDom(f);
    await f.context.bootstrapSession();
    assert.equal(ui.nodes.get('session-recovery').hidden, false);
    assert.equal(ui.document.body.classList.contains('session-bootstrap-failed'), true);
    assert.equal(ui.nodes.get('recovery-message').getAttribute('role'), 'alert');
    assert.equal(ui.nodes.get('recovery-message').getAttribute('aria-labelledby'), 'recovery-title');
    assert.equal(ui.nodes.get('recovery-message').getAttribute('aria-describedby'), 'recovery-detail');
    assert.equal(ui.document.activeElement, ui.nodes.get('recovery-title'));
    assert.equal(ui.nodes.get('recovery-retry-actions').children.length, 0);
    if (status === 410) {
      assert.equal(ui.nodes.get('recovery-title').textContent, 'Link expired');
      assert.match(ui.nodes.get('recovery-detail').textContent, /new link/);
    }
    assert.equal(f.calls.filter(x => x.url.endsWith('/redeem')).length, 1);
    assert.equal(f.initialized.length, 0); assert.equal(f.context.activeViewerSession, null);
    assert.equal(f.calls[0].options.headers.Authorization, undefined);
    assert.equal(ui.document.reloads || 0, 0);
  });
  assert.match(html, /body\.session-bootstrap-failed #app \{ display: none; \}/);
  assert.match(html, /id="recovery-workspace" href="\/workspace"/);
});

test('ambiguous fresh grant failure offers reinitiation guidance, never a grant-reloading retry', async () => {
  const f = fixture({reject: 503}), ui = terminalDom(f);
  await f.context.bootstrapSession();
  assert.equal(ui.nodes.get('recovery-retry-actions').children.length, 0);
  assert.match(ui.nodes.get('recovery-detail').textContent, /start a new Viewer session/);
  assert.equal(ui.nodes.get('recovery-workspace').hidden, false);
  assert.equal(f.calls.filter(x => x.url.endsWith('/redeem')).length, 1);
});

test('active-session transient retry preserves only its existing capability; denial disarms it', async () => {
  const f = fixture({active: true, denied: false, reject: 503}), ui = terminalDom(f);
  await f.context.bootstrapSession();
  const retry = ui.nodes.get('recovery-retry-actions').children[0];
  assert.equal(retry.textContent, 'Try again');
  assert.equal(f.context.sessionCapabilities.read(KEY), 'persisted-old-capability');
  assert.equal(f.calls[0].url, '/api/v1/sessions/current');
  retry.listeners.click(); assert.equal(ui.document.reloads, 1);
  assert.equal(f.calls.filter(x => x.url.endsWith('/redeem')).length, 0);
  const denied = fixture({active: true, denied: false, reject: 403}); terminalDom(denied);
  await denied.context.bootstrapSession(); assert.equal(denied.context.sessionCapabilities.read(KEY), null);
});

test('actual share and project-share bootstrap gate retry by terminal status and preserve password handling', async t => {
  for (const kind of ['share','project']) for (const status of [401,403,404,410,429,503]) await t.test(`${kind} ${status}`, async () => {
    const f = fixture(), ui = terminalDom(f); f.context.SHARE_TOKEN = 'synthetic-share'; f.context.VIEW_MODE = kind === 'project' ? 'project' : 'view';
    f.context.fetch = async () => ({ok: false, status, json: async () => ({error: 'not rendered as a trusted destination'})});
    vm.runInContext(source.slice(source.indexOf('async function fetchProjectShareCatalog('), source.indexOf('function showSharePasswordPrompt()')), f.context);
    await (kind === 'project' ? f.context.bootstrapProjectShare() : f.context.bootstrapShare());
    assert.equal(ui.nodes.get('loading-overlay').classList.contains('final'), true);
    assert.equal(ui.nodes.get('loading-cancel').style.display, 'none');
    assert.equal(ui.nodes.get('loading-actions').children.length, [429,503].includes(status) ? 1 : 0);
    assert.equal(ui.document.activeElement, ui.nodes.get('loading-text'));
    assert.equal(ui.nodes.get('loading-overlay').getAttribute('aria-labelledby'), 'loading-text');
    if (status === 410) assert.match(ui.nodes.get('loading-progress').textContent, /new link/);
  });
  for (const kind of ['share','project']) {
    const f = fixture(); terminalDom(f); f.context.SHARE_TOKEN = 'password-protected'; let prompts = 0;
    f.context.fetch = async () => ({ok:false,status:401,json:async()=>({requiresPassword:true})});
    f.context.showSharePasswordPrompt = () => { prompts++; };
    vm.runInContext(source.slice(source.indexOf('async function fetchProjectShareCatalog('), source.indexOf('function showSharePasswordPrompt()')), f.context);
    await (kind === 'project' ? f.context.bootstrapProjectShare() : f.context.bootstrapShare());
    assert.equal(prompts,1);
  }
});

test('terminal Back requires an existing visible fixed link matching current server session', () => {
  const f = fixture(), ui = terminalDom(f), nav = ui.node('staff-navigation'), link = ui.node('staff-models','a');
  link.parent = nav; link.setAttribute('href','https://ops.example.test/viewer'); f.context.dom.staffModels = link;
  f.context.activeViewerSession = {audience:'ops',operationsOrigin:'https://ops.example.test'};
  const show = () => f.context.showFinalState(viewerFailureState({status:410}));
  show(); assert.equal(ui.nodes.get('loading-actions').children[0].href, link.href);
  for (const alter of [() => {nav.hidden=true;}, () => {nav.hidden=false;link.setAttribute('href','https://untrusted.example/viewer');},
    () => {link.setAttribute('href','https://ops.example.test/viewer');f.context.window.parent={};},
    () => {f.context.window.parent=f.context.window;f.context.activeViewerSession={audience:'client',clientPortalOrigin:'https://portal.example.test'};}]) {
    alter(); f.context.updateLoading('Loading'); show(); assert.equal(ui.nodes.get('loading-actions').children.length,0);
  }
});

test('terminal announcement/focus happens once per transition and resets without affecting loading focus', () => {
  const f = fixture(), ui = terminalDom(f), title = ui.nodes.get('loading-text');
  f.context.updateLoading('Loading','progress'); assert.equal(title.focusCalls,0);
  const failure = viewerFailureState({status:410}); f.context.showFinalState(failure); f.context.showFinalState(failure);
  assert.equal(title.focusCalls,1); assert.equal(title.getAttribute('tabindex'),'-1');
  f.context.updateLoading('Loading again','progress',true);
  assert.equal(title.focusCalls,1); assert.equal(ui.nodes.get('loading-overlay').getAttribute('role'),null);
  assert.equal(ui.nodes.get('loading-actions').hidden,true); f.context.showFinalState(failure); assert.equal(title.focusCalls,2);
  f.context.hideLoading(); assert.equal(ui.nodes.get('loading-overlay').classList.contains('hidden'),true);
  assert.equal(ui.nodes.get('loading-overlay').getAttribute('role'),null);
  assert.match(html, /#loading-overlay\.final \.spinner \{ display: none; \}/);
});


test('password unlock expiry or revocation becomes terminal; incorrect password and throttling retain their existing challenge', async t => {
  for (const status of [401,403,404,410,429]) await t.test(String(status), async () => {
    const f = fixture(), ui = terminalDom(f); f.context.SHARE_TOKEN = 'password-share'; f.context.VIEW_MODE = 'view';
    const input = ui.nodes.get('share-password-input'), overlay = ui.nodes.get('share-password-overlay');
    input.value = 'synthetic-password'; overlay.style.display = 'flex'; let posts = 0;
    f.context.fetch = async () => { posts++; return {ok:false,status,json:async()=>({error:'Incorrect password.'})}; };
    vm.runInContext(source.slice(source.indexOf('function hideSharePasswordPrompt()'),source.indexOf('function applyShareResult(')), f.context);
    f.context.bindSharePasswordForm(); await ui.nodes.get('share-password-submit').listeners.click();
    const terminal = [403,404,410].includes(status);
    assert.equal(ui.nodes.get('loading-overlay').classList.contains('final'),terminal);
    assert.equal(overlay.style.display,terminal?'none':'flex'); assert.equal(posts,1);
    assert.equal(ui.nodes.get('loading-actions').children.length,0);
    if (terminal) {
      assert.equal(input.value,''); assert.equal(ui.document.activeElement,ui.nodes.get('loading-text'));
      if(status===410)assert.match(ui.nodes.get('loading-progress').textContent,/new link/);
    } else assert.match(ui.nodes.get('share-password-error').textContent,status===401?/Incorrect password/:/Too many attempts/);
  });
});


test('successful unlock followed by catalog/task failure renders terminal recovery and retries only current GETs', async t => {
  for (const phase of ['catalog','task']) for (const status of [403,404,410,503]) await t.test(`${phase} ${status}`, async () => {
    const f = fixture(), ui = terminalDom(f); f.context.VIEW_MODE='project'; f.context.SHARE_TOKEN='post-unlock-share';
    f.context.URLSearchParams=URLSearchParams; f.context.location.search=''; f.context.PROJECT_SHARE_CATALOG=null;
    f.context.populateProjectSwitcher=()=>{}; f.context.applyShareResult=()=>{};
    ui.nodes.get('share-password-input').value='synthetic-password'; ui.nodes.get('share-password-overlay').style.display='flex';
    const calls=[], catalog={tasks:[{id:'task-one',displayName:'Synthetic task'}],nextCursor:null};
    f.context.fetch=async (url,options={})=>{
      calls.push({url,method:options.method||'GET'});
      if(options.method==='POST')return {ok:true,status:200,json:async()=>phase==='catalog'?{tasks:[],nextCursor:'next-page'}:catalog};
      const failed=phase==='catalog'||url.includes('/tasks/');
      return {ok:!failed,status:failed?status:200,json:async()=>failed?{error:'Synthetic denied or unavailable'}:catalog};
    };
    vm.runInContext(source.slice(source.indexOf('async function fetchProjectShareCatalog('),source.indexOf('function applyShareResult(')), f.context);
    f.context.bindSharePasswordForm(); await ui.nodes.get('share-password-submit').listeners.click();
    assert.equal(ui.nodes.get('share-password-overlay').style.display,'none');
    assert.equal(ui.nodes.get('loading-overlay').classList.contains('final'),true);
    assert.equal(ui.document.activeElement,ui.nodes.get('loading-text'));
    assert.equal(ui.nodes.get('loading-overlay').getAttribute('aria-labelledby'),'loading-text');
    assert.equal(calls.filter(x=>x.method==='POST').length,1);
    const actions=ui.nodes.get('loading-actions').children;
    assert.equal(actions.length,status===503?1:0);
    if(status===503){
      await actions[0].listeners.click();
      await ui.nodes.get('loading-actions').children[0].listeners.click();
      assert.equal(calls.filter(x=>x.method==='POST').length,1,'Repeated Try again cannot replay password POST');
      assert(calls.slice(1).every(x=>x.method==='GET'&&x.url.startsWith('/api/project-share/post-unlock-share')));
      assert.equal(ui.document.reloads||0,0,'retry stays within the current share GET bootstrap');
    }
    if(status===410)assert.match(ui.nodes.get('loading-progress').textContent,/new link/);
  });
});

test('successful unlock followed by renewed catalog/task password challenge returns focus to usable password form', async t => {
  for(const phase of ['catalog','task'])await t.test(phase,async()=>{
    const f=fixture(),ui=terminalDom(f);f.context.VIEW_MODE='project';f.context.SHARE_TOKEN='renewed-password-share';
    f.context.URLSearchParams=URLSearchParams;f.context.location.search='';f.context.PROJECT_SHARE_CATALOG=null;
    f.context.populateProjectSwitcher=()=>{};f.context.applyShareResult=()=>assert.fail('challenge must not initialize a model');
    const calls=[];ui.nodes.get('share-password-input').value='synthetic-password';ui.nodes.get('share-password-overlay').style.display='flex';
    f.context.fetch=async(url,options={})=>{
      calls.push(options.method||'GET');
      return options.method==='POST'?{ok:true,status:200,json:async()=>phase==='catalog'?{tasks:[],nextCursor:'next-page'}:{tasks:[{id:'task-one'}],nextCursor:null}}
        :{ok:false,status:401,json:async()=>({requiresPassword:true})};
    };
    vm.runInContext(source.slice(source.indexOf('async function fetchProjectShareCatalog('),source.indexOf('function applyShareResult(')),f.context);
    f.context.bindSharePasswordForm();await ui.nodes.get('share-password-submit').listeners.click();
    assert.equal(ui.nodes.get('share-password-overlay').style.display,'flex');
    assert.equal(ui.nodes.get('share-password-submit').disabled,false);
    assert.equal(ui.nodes.get('share-password-input').value,'');
    assert.equal(ui.document.activeElement,ui.nodes.get('share-password-input'));
    assert.equal(ui.nodes.get('loading-overlay').classList.contains('hidden'),true);
    assert.equal(ui.nodes.get('loading-overlay').classList.contains('final'),false);
    assert.equal(calls.filter(x=>x==='POST').length,1);
  });
});
