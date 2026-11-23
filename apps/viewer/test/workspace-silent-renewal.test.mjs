// Silent workspace renewal: scheduling, the same-site route, one renewal across
// tabs that share a session, and asking for sign-in only when it really ended.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { WORKSPACE_RENEWAL_LEAD_MS, WorkspaceSessionRenewal } from '../workspace-renewal.mjs';
import { createWorkspaceRecovery } from '../workspace-recovery.mjs';
import controller from '../server/controllerOrigins.js';

const PINNED = 'https://ops.other-site.test', SAME_SITE = 'https://ops.viewer-site.test', VIEWER = 'https://viewer.viewer-site.test';
const PATH = '/api/viewer/workspace/session-renewal', REDEEM = '/api/v1/admin-sessions/redeem', CURRENT = '/api/v1/admin-sessions/current';
const ID = 'a7e240dc-985d-4bda-a7b8-17ad766a4438', SESSION = 'workspace_session_0000000000000001';
const TOKEN = 't'.repeat(40), GRANT = 'g'.repeat(40), CSRF = 'c'.repeat(43), MINUTE = 60_000;
const tick = async (n = 12) => { for (let i = 0; i < n; i += 1) await new Promise(resolve => setImmediate(resolve)); };

function json(url, body, status = 200) {
  const response = new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: url.startsWith('/') ? VIEWER + url : url });
  return response;
}

function harness({ lifetime = 30 * MINUTE, renewalOrigin = SAME_SITE, respond, windowExtra = {}, expiry = null, random = () => 0 } = {}) {
  let clock = Date.now();
  const start = clock, calls = [], timers = [], events = [], listeners = new Map();
  const envelope = { accessToken: TOKEN, controllerOrigin: PINNED, ...(renewalOrigin ? { renewalOrigin } : {}),
    session: { id: SESSION, subject: 'ops:staff', permissions: [], expiresAt: new Date(start + lifetime).toISOString() } };
  const nextExpiry = () => new Date(expiry ?? clock + 30 * MINUTE).toISOString();
  const defaults = (url, init) => {
    if (url === REDEEM) return json(url, { ...envelope, session: { ...envelope.session, expiresAt: nextExpiry() } });
    if (url === CURRENT) return json(url, { error: 'authentication_required' }, 401);
    if (url.endsWith('/challenge')) return json(url, { protocolVersion: 1, challenge: CSRF, expiresAt: Math.floor(clock / 1000) + 120 });
    return json(url, { protocolVersion: 1, requestId: JSON.parse(init.body).requestId, sessionId: SESSION, grant: GRANT,
      grantExpiresAt: new Date(clock + MINUTE).toISOString(), sessionTtlSeconds: 1800, redeemUrl: VIEWER + REDEEM }, 201);
  };
  const renewal = new WorkspaceSessionRenewal({
    controllerWindow: null, envelope, accessToken: TOKEN, random, now: () => clock, randomUUID: () => ID,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return (await respond?.({ url, init, defaults, clock })) ?? defaults(url, init); },
    windowRef: { location: { origin: VIEWER }, addEventListener: (key, value) => listeners.set(key, value), removeEventListener: key => listeners.delete(key),
      open: () => assert.fail('silent renewal never opens a window'), ...windowExtra },
    documentRef: { visibilityState: 'visible', addEventListener: (key, value) => listeners.set(key, value), removeEventListener: key => listeners.delete(key) },
    setTimer: (handler, delay) => { const timer = { handler, delay, due: clock + delay, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
    onSession: value => events.push(['session', value.session.expiresAt]), onExpired: reason => events.push(['expired', reason]),
    onPaused: () => events.push(['paused']), onResumed: () => events.push(['resumed']), onSignInRequired: () => events.push(['sign-in']),
  });
  renewal.start();
  // Fires due timers in order, letting each one's network work settle.
  async function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const next = timers.filter(timer => !timer.cleared && timer.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      clock = Math.max(clock, next.due); next.cleared = true; next.handler(); await tick();
    }
    clock = until;
  }
  return { renewal, envelope, calls, timers, events, listeners, advance, now: () => clock, start, names: () => events.map(event => event[0]) };
}
const urls = context => context.calls.map(call => call.url);

test('renewal starts 60% of the way through a 30-minute session, earlier with jitter, and repeats indefinitely', async () => {
  assert.equal(WORKSPACE_RENEWAL_LEAD_MS, 12 * MINUTE);
  for (const random of [() => 0, () => 0.999]) {
    const context = harness({ random });
    const timer = context.timers.find(item => item.delay < 30 * MINUTE);
    assert.ok(timer.delay >= 0.5 * 30 * MINUTE && timer.delay <= 0.7 * 30 * MINUTE, String(timer.delay));
    context.renewal.dispose();
  }
  const context = harness();
  await context.advance(8 * 60 * MINUTE);
  assert.deepEqual([...new Set(context.names())], ['session'], 'eight idle hours: no pause, prompt or expiry');
  assert.ok(context.renewal.expiresAtMs > context.now());
  assert.ok(context.events.length >= 25 && context.events.length <= 28, String(context.events.length));
  context.renewal.dispose();
});

test('focus and visibility renew only once due, and never hammer Operations', async () => {
  const context = harness();
  context.listeners.get('focus')(); context.listeners.get('visibilitychange')(); await tick();
  assert.equal(context.calls.length, 0, 'not due yet');
  context.renewal.dispose();
  // Operations capped the session at its own sign-in expiry 10 minutes from now.
  const capped = harness({ lifetime: 10 * MINUTE, expiry: Date.now() + 10 * MINUTE });
  capped.listeners.get('focus')(); capped.listeners.get('visibilitychange')(); await tick();
  assert.equal(capped.calls.filter(call => call.url === REDEEM).length, 1, 'coalesced');
  for (let i = 0; i < 20; i += 1) { capped.listeners.get('focus')(); await tick(4); }
  assert.equal(capped.calls.filter(call => call.url === REDEEM).length, 1, 'no repeat within 30 seconds');
  capped.renewal.dispose();
});

test('a session that cannot outlive the Operations sign-in renews a bounded number of times and never past it', async () => {
  const end = Date.now() + 10 * MINUTE;
  const context = harness({ lifetime: 10 * MINUTE, expiry: end });
  await context.advance(10 * MINUTE - 1000);
  const renewals = context.calls.filter(call => call.url === REDEEM).length;
  assert.ok(renewals >= 2 && renewals <= 12, String(renewals));
  assert.equal(context.renewal.expiresAtMs, Date.parse(new Date(end).toISOString()));
  context.renewal.dispose();
});

test('the same-site Operations host is used first and is told the pinned controller, never a credential', async () => {
  const context = harness();
  await context.advance(18 * MINUTE + 1000);
  assert.deepEqual(urls(context), [SAME_SITE + PATH + '/challenge', SAME_SITE + PATH, REDEEM]);
  const body = JSON.parse(context.calls[1].init.body);
  assert.deepEqual(body, { protocolVersion: 1, requestId: ID, sessionId: SESSION, subject: 'ops:staff', controllerOrigin: PINNED });
  assert.ok(!JSON.stringify(context.calls.slice(0, 2)).includes(TOKEN));
  for (const call of context.calls.slice(0, 2)) assert.equal(call.init.credentials, 'include');
  assert.equal(context.renewal.controllerOrigin, PINNED);
  context.renewal.dispose();
});

test('a same-site host that is blocked, hangs or is refused falls back to the pinned controller', async () => {
  for (const mode of ['blocked', 'hang', 'unauthenticated', 'old-operations']) {
    const context = harness({ respond: ({ url, init }) => {
      if (!url.startsWith(SAME_SITE)) return undefined;
      if (mode === 'blocked') throw new TypeError('Failed to fetch');
      if (mode === 'hang') return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
      if (mode === 'unauthenticated') return json(url, { error: 'Cloudflare Access authentication required' }, 401);
      return url.endsWith('/challenge') ? undefined : json(url, { error: 'Invalid renewal request' }, 400);
    } });
    await context.advance(18 * MINUTE + 10_000);
    assert.deepEqual(context.names(), ['session'], mode);
    const body = JSON.parse(context.calls.find(call => call.url === PINNED + PATH).init.body);
    assert.equal(body.controllerOrigin, undefined, 'the pinned controller receives exactly the old request');
    context.renewal.dispose();
  }
});

test('a same-site refusal of this account ends the session only when the pinned controller cannot answer', async () => {
  for (const reachable of [true, false]) {
    const context = harness({ respond: ({ url }) => {
      if (url.startsWith(SAME_SITE)) return json(url, { error: 'Global viewer.view permission required' }, 403);
      if (url.startsWith(PINNED) && !reachable) throw new TypeError('Failed to fetch');
      return undefined;
    } });
    await context.advance(18 * MINUTE + 1000);
    assert.deepEqual(context.events.map(event => event[0] === 'expired' ? event : event[0]), reachable ? ['session'] : [['expired', 'revoked']]);
    context.renewal.dispose();
  }
});

test('an authoritative signed-out answer asks for sign-in; a lost permission revokes', async () => {
  for (const [status, error, reason] of [[401, 'Cloudflare Access authentication required', 'signed-out'],
    [403, 'This Operations staff account is not bound to the current Access identity', 'revoked']]) {
    const context = harness({ respond: ({ url }) => url.startsWith('https:') ? json(url, { error }, status) : undefined });
    await context.advance(18 * MINUTE + 1000);
    assert.deepEqual(context.events, [['expired', reason]]);
    assert.ok(!urls(context).includes(REDEEM));
  }
});

test('network failures back off, keep the live session to its end, and renew silently when the network returns', async () => {
  let online = false;
  const context = harness({ respond: () => { if (!online) throw new TypeError('offline'); } });
  await context.advance(29 * MINUTE);
  assert.deepEqual(context.names(), [], 'nothing visible while the session is still valid');
  const attempts = context.calls.filter(call => call.url.startsWith(PINNED)).length;
  assert.ok(attempts >= 8 && attempts <= 60, String(attempts));
  online = true;
  await context.advance(61_000);
  assert.deepEqual(context.names(), ['session']);
  context.renewal.dispose();
});

test('an offline laptop past expiry pauses without a prompt, then resumes on wake', async () => {
  let online = false;
  const context = harness({ respond: () => { if (!online) throw new TypeError('offline'); } });
  await context.advance(5 * 60 * MINUTE);
  assert.deepEqual(context.names(), ['paused']);
  online = true; context.listeners.get('online')(); await tick();
  assert.deepEqual(context.names(), ['paused', 'session', 'resumed']);
  context.renewal.dispose();
});

test('an unreadable refusal prompts once, only after real expiry and only once Viewer confirms the session is over', async () => {
  // Access answers a signed-out fetch with a cross-site redirect: a plain TypeError.
  const context = harness({ respond: ({ url }) => { if (url.startsWith('https:')) throw new TypeError('Failed to fetch'); } });
  await context.advance(30 * MINUTE - 1);
  assert.deepEqual(context.names(), []);
  await context.advance(10_000);
  assert.deepEqual(context.names(), ['paused', 'sign-in']);
  await context.advance(60 * MINUTE);
  assert.deepEqual(context.names(), ['paused', 'sign-in'], 'asked once; silent attempts continue');
  assert.equal(context.renewal.expiresAtMs, context.start + 30 * MINUTE, 'access still ends within the 30 minutes already granted');
  context.renewal.dispose();
});

test('signing in to Operations elsewhere resumes the paused tab by itself', async () => {
  let signedIn = false;
  const context = harness({ respond: ({ url }) => { if (url.startsWith('https:') && !signedIn) throw new TypeError('Failed to fetch'); } });
  await context.advance(31 * MINUTE);
  assert.ok(context.names().includes('sign-in'));
  signedIn = true;
  await context.advance(2 * MINUTE);
  assert.deepEqual(context.names().slice(-2), ['session', 'resumed']);
  context.renewal.dispose();
});

test('an opener that closes between the two closed checks counts as one failed attempt, not two', async () => {
  for (const direct of [true, false]) {
    const context = harness({ lifetime: 2 * MINUTE, respond: ({ url }) => { if (url.startsWith('https:')) throw new TypeError('Failed to fetch'); } });
    await context.advance(MINUTE);
    const { renewal } = context;
    for (const timer of context.timers) timer.cleared = true; // Only this attempt's own timers from here on.
    renewal.now = () => Date.parse(context.envelope.session.expiresAt) + 1;
    let reads = 0, posted = 0;
    // Open for the caller's check, closed by the time the message would be posted.
    renewal.controllerWindow = { get closed() { reads += 1; return reads >= (direct ? 2 : 3); }, postMessage: () => { posted += 1; } };
    renewal.pendingRequestId = null; renewal.retryAttempt = 0; renewal.expiredFailures = 0;
    let confirmations = 0; renewal.confirmSignInRequired = () => { confirmations += 1; };
    const before = context.timers.length;
    if (direct) { renewal.retryAttempt = 1; renewal.fallbackToOpener(ID); }
    else { renewal.requestRenewal('expiry'); await tick(); }
    const label = direct ? 'fallback alone' : 'through a whole attempt';
    assert.equal(posted, 0, label); assert.ok(reads >= 2, label);
    assert.equal(renewal.retryAttempt, 1, label); assert.equal(renewal.expiredFailures, 1, label);
    assert.equal(confirmations, 0, `${label}: one failure cannot reach the two-attempt sign-in check`);
    assert.equal(context.timers.slice(before).filter(timer => timer.delay === 2_000 && !timer.cleared).length, 1, `${label}: exactly one retry`);
    assert.equal(renewal.pendingRequestId, null, label);
    // The next attempt, with the opener really gone, is the second failure.
    renewal.controllerWindow = { closed: true };
    renewal.requestRenewal('retry'); await tick();
    assert.equal(renewal.expiredFailures, 2, label); assert.equal(confirmations, 1, label);
    renewal.dispose();
  }
});

test('an Operations outage it can read never turns into a sign-in prompt', async () => {
  const context = harness({ respond: ({ url }) => url.startsWith('https:') ? json(url, { error: 'Workspace renewal is temporarily unavailable' }, 503) : undefined });
  await context.advance(60 * MINUTE);
  assert.deepEqual(context.names(), ['paused']);
  context.renewal.dispose();
});

test('a Viewer failure while redeeming an Operations grant is not a sign-in problem', async () => {
  const context = harness({ respond: ({ url }) => url === REDEEM ? json(url, { error: 'unavailable' }, 503) : undefined });
  await context.advance(45 * MINUTE);
  assert.deepEqual(context.names(), ['paused']);
  context.renewal.dispose();
});

function sharedBrowser() {
  const held = new Set(), queue = [], channels = new Set();
  const next = name => { const index = queue.findIndex(item => item.name === name); if (index >= 0) queue.splice(index, 1)[0].run(); };
  const locks = { async request(name, options, callback) {
    if (held.has(name)) {
      if (options.ifAvailable) return callback(null);
      await new Promise(run => queue.push({ name, run }));
    }
    held.add(name);
    try { return await callback({ name }); } finally { held.delete(name); next(name); }
  } };
  class BroadcastChannel {
    constructor(name) { this.name = name; channels.add(this); }
    postMessage(data) { for (const channel of channels) if (channel !== this && channel.name === this.name) queueMicrotask(() => channel.onmessage?.({ data: structuredClone(data) })); }
    close() { channels.delete(this); }
  }
  return { navigator: { locks }, BroadcastChannel };
}

test('tabs sharing one session renew once; the others adopt it from Viewer with their own bearer', async () => {
  const browser = sharedBrowser();
  let expiresAt = null, grants = 0;
  const tab = () => {
    const context = harness({ windowExtra: browser, respond: async ({ url, defaults, init }) => {
      if (url === REDEEM) { const body = await defaults(url, init).json(); expiresAt = body.session.expiresAt; return json(url, body); }
      if (url === CURRENT) return expiresAt ? json(url, { ...context.envelope, accessToken: undefined, session: { ...context.envelope.session, expiresAt } }) : undefined;
      if (url.endsWith('/session-renewal')) grants += 1;
      return undefined;
    } });
    return context;
  };
  const tabs = [tab(), tab(), tab()];
  await Promise.all(tabs.map(context => context.advance(18 * MINUTE + 1000)));
  await tick(40);
  assert.equal(grants, 1);
  for (const context of tabs) {
    assert.equal(new Date(context.renewal.expiresAtMs).toISOString(), expiresAt);
    assert.ok(context.names().includes('session')); assert.ok(!context.names().includes('paused'));
    for (const call of context.calls.filter(item => item.url === CURRENT)) assert.equal(call.init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(context.renewal.pendingRequestId, null);
    context.renewal.dispose();
  }
});

test('a cross-tab message is only a hint: forged expiries, other sessions and other people install nothing', async () => {
  for (const body of [null, { subject: 'ops:other' }, { id: 'workspace_session_0000000000000002' }]) {
    const browser = sharedBrowser();
    const context = harness({ windowExtra: browser, respond: ({ url }) => url === CURRENT && body
      ? json(url, { ...context.envelope, session: { ...context.envelope.session, ...body, expiresAt: new Date(Date.now() + 60 * MINUTE).toISOString() } }) : undefined });
    const forger = new browser.BroadcastChannel('ltds-viewer-workspace-renewal');
    const message = { version: 1, type: 'renewed', sessionId: SESSION, expiresAt: new Date(Date.now() + 90 * MINUTE).toISOString() };
    forger.postMessage({ ...message, sessionId: 'another_session_00000001' }); forger.postMessage({ ...message, grant: GRANT }); await tick();
    assert.equal(context.calls.length, 0);
    forger.postMessage(message); await tick();
    assert.deepEqual(urls(context), [CURRENT]); assert.deepEqual(context.names(), []);
    assert.equal(context.renewal.expiresAtMs, Date.parse(context.envelope.session.expiresAt));
    context.renewal.dispose();
  }
});

test('the sign-in dialog closes itself and releases waiting uploads when access returns silently', async () => {
  const listeners = new Map(), storage = new Map(), log = [];
  const dialog = { className: '', set innerHTML(_value) {}, querySelector: () => ({}), addEventListener() {}, showModal: () => log.push('shown'), close: () => log.push('closed'), remove: () => log.push('removed') };
  const recovery = createWorkspaceRecovery({
    windowRef: { location: { origin: VIEWER }, addEventListener: (key, value) => listeners.set(key, value), removeEventListener() {},
      sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
      open: () => assert.fail('must not open a tab') },
    documentRef: { createElement: () => dialog, body: { append() {} } }, fetchImpl: () => assert.fail('must not redeem'),
    getSession: () => ({ session: { id: SESSION, subject: 'ops:staff' }, accessToken: TOKEN, controllerOrigin: PINNED }),
    install() {}, onFatal: () => assert.fail('not fatal'), onPaused: () => log.push('paused'), onResumed: () => log.push('resumed'),
  });
  assert.equal(recovery.resume(), false, 'nothing to resume');
  void recovery.pause(); const waiting = recovery.wait();
  assert.equal(recovery.resume(), true); await waiting;
  assert.deepEqual(log, ['shown', 'paused', 'closed', 'removed', 'resumed']);
  assert.equal(recovery.isPaused(), false);
});

const workspace = fs.readFileSync(new URL('../workspace-projects.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const between = (from, to) => { const start = workspace.indexOf(from), end = workspace.indexOf(to, start); assert.ok(start >= 0 && end > start, from); return workspace.slice(start, end); };
const line = start => { const found = workspace.split('\n').find(value => value.startsWith(start)); assert.ok(found, start); return found; };

// The shipped guards, api(), folder loader, quiet task poll and installWorkspaceSession
// (its real onSession/onResumed order) around the real WorkspaceSessionRenewal.
function page({ expiresIn = 30 * MINUTE, server, renew = true, lifetime = 30 * MINUTE }) {
  let clock = Date.now();
  const requests = [], log = [], timers = [];
  const envelope = { accessToken: TOKEN, controllerOrigin: PINNED, session: { id: SESSION, subject: 'ops:staff', permissions: ['viewer.projects.read'], expiresAt: new Date(clock + expiresIn).toISOString() } };
  const fetchImpl = async (url, init = {}) => {
    if (url.startsWith(PINNED)) {
      if (!renew) throw new TypeError('Failed to fetch');
      if (url.endsWith('/challenge')) return json(url, { protocolVersion: 1, challenge: CSRF, expiresAt: Math.floor(clock / 1000) + 120 });
      return json(url, { protocolVersion: 1, requestId: ID, sessionId: SESSION, grant: GRANT, grantExpiresAt: new Date(clock + MINUTE).toISOString(), sessionTtlSeconds: 1800, redeemUrl: VIEWER + REDEEM }, 201);
    }
    if (url === REDEEM) return json(url, { ...envelope, session: { ...envelope.session, expiresAt: new Date(clock + lifetime).toISOString() } });
    requests.push({ url, method: init.method, authorization: init.headers.Authorization });
    return server({ url, init, count: requests.length, context, advance: ms => { clock += ms; } });
  };
  const windowRef = { location: { origin: VIEWER }, addEventListener() {}, removeEventListener() {} };
  class TestDate extends Date { static now() { return clock; } }
  const context = vm.createContext({
    Date: TestDate, DOMException, queueMicrotask, JSON, Promise, Map, Set, Error, Object, Array, Number, crypto: { randomUUID: () => ID }, fetch: fetchImpl,
    sessionStorage: { getItem: () => PINNED, setItem() {} }, TOKEN_KEY: 'token', OPS_ORIGIN_KEY: 'origin', LIVE_ATTEMPT_STATUSES: new Set(['running']),
    state: { token: TOKEN, adminSession: null, section: 'dashboard', selectedProjectId: 'p', tasks: [{ id: 't', projectId: 'p', datasetId: 'd', latestAttempt: { id: 'a', status: 'running' } }], taskDetails: {}, expandedTaskId: 't', busy: false },
    folderCache: new Map(), treeState: { projects: new Set(), folders: new Set() }, projectDataGeneration: 0, folderAuthorizationGeneration: 0, activeFolderMutation: null,
    workspaceAuthorizationClearing: false, workspaceController: null, can: () => true, openProjectIds: () => ['p'], clearFolderUndo() {}, revealTreeFolder() {},
    shell: { setAttribute() {}, removeAttribute() {} }, paintProjectTree: id => log.push(`painted ${id}`), toast: (message, bad) => log.push(`toast ${bad} ${message}`),
    storageUsagePoll: { stop() {}, sync() {} }, scheduleOperationRefresh() {}, clearInterval() {}, clearTimeout() {}, setInterval: () => { log.push('poll restarted'); return 1; },
    reviewSessionController: { setAuthenticatedSubject() {}, suspend: () => log.push('suspended') }, access: () => log.push('signed out'), renderNav() {},
    workspaceRecovery: { wait: async () => {}, isPaused: () => false, resume: () => log.push('resumed'), pause: () => log.push('dialog') },
    responseError: (message, status) => Object.assign(new Error(message), { status }), clientAccessDiagnostic: () => ({}),
    validateWorkspaceSessionEnvelope: value => ({ session: value.session, controllerOrigin: value.controllerOrigin }),
    clearWorkspaceAuthorization: reason => log.push(`cleared ${reason}`), beginWorkspaceReauthorization: () => log.push('dialog'),
    WorkspaceSessionRenewal: class extends WorkspaceSessionRenewal {
      constructor(options) {
        super({ ...options, fetchImpl, windowRef, documentRef: { addEventListener() {}, removeEventListener() {} }, now: () => clock, randomUUID: () => ID, random: () => 0,
          setTimer: (handler, delay) => { const timer = { handler, delay, cleared: false }; timers.push(timer); return timer; }, clearTimer: timer => { timer.cleared = true; } });
      }
    },
  });
  // The renderer's own rule for a project whose folders are not cached.
  const loadOnPaint = line('  if(!folderCache.has(project.id)&&isProjectOpen(project.id))');
  vm.runInContext(['let workspaceRenewal=null;', line('function isProjectOpen('), between('function invalidateFolderAuthorization(', '\nfunction folderRequestOptions('),
    between('function repaintFolderAuthorization(', '\nasync function mutateFolder('), between('async function mutateFolder(', '\nfunction folderPath(').replace(/\/\/ Expands the saved path[\s\S]*$/, ''),
    between('async function guardedFetch(', '\nasync function authenticatedDownload'), between('const taskDetailRefreshes=', '\nfunction releaseGcpImage('),
    line('function installWorkspaceSession('), `function render(){const project={id:'p'};${loadOnPaint}}`,
    'this.page={installWorkspaceSession,loadProjectFolders,refreshTaskDetails,mutateFolder,folderAuthorizationGuard,taskDetailRefreshes,renewal:()=>workspaceRenewal};'].join('\n'), context);
  context.page.installWorkspaceSession(envelope);
  return { context, page: context.page, requests, log, timers, advance: ms => { clock += ms; } };
}

test('a folder read discarded by a renewal is replaced by the repaint, with a fresh guard (real onSession order)', async () => {
  for (const when of ['before-send', 'after-401']) {
    const f = page({ server: ({ count, advance }) => {
      if (when === 'after-401' && count === 1) { advance(31 * MINUTE); return json('/x', { error: 'authentication_required' }, 401); }
      return json('/x', { folders: [{ id: 'folder', projectId: 'p' }] });
    } });
    const before = f.context.state.adminSession, guard = f.page.folderAuthorizationGuard('p');
    if (when === 'before-send') f.advance(31 * MINUTE);
    await f.page.loadProjectFolders('p'); await tick(40);
    // The renewal kept the bearer and session ID, and still retired every older guard.
    assert.equal(f.context.state.token, TOKEN); assert.equal(f.context.state.adminSession.id, SESSION); assert.notEqual(f.context.state.adminSession, before);
    assert.equal(guard(), false, when);
    assert.equal(f.requests.length, when === 'before-send' ? 1 : 2, 'the discarded read was not re-sent; only the repaint asked again');
    const entry = f.context.folderCache.get('p');
    assert.deepEqual(entry.folders.map(folder => folder.id), ['folder'], when); assert.equal(entry.error, null); assert.equal(entry.loading, false);
    assert.ok(f.log.includes('painted p')); assert.ok(!f.log.some(item => /cleared|dialog|signed out|toast/.test(item)), f.log.join());
    f.page.renewal().dispose();
  }
});

test('a quiet task poll discarded by a renewal changes nothing and the next tick asks again', async () => {
  let next = false, asked = 0;
  const f = page({ server: ({ url, context, advance }) => {
    if (url.endsWith('/folders')) return json(url, { folders: [] });
    if (!next) { advance(31 * MINUTE); return json(url, { error: 'authentication_required' }, 401); }
    if ((asked += 1) === 5) context.state.tasks = []; return json(url, {});
  } });
  const tasks = f.context.state.tasks;
  await f.page.refreshTaskDetails('t', true); await tick(20);
  assert.equal(f.context.state.tasks, tasks); assert.deepEqual(Object.keys(f.context.state.taskDetails), []);
  assert.equal(f.page.taskDetailRefreshes.size, 0, 'not stuck as in progress');
  assert.ok(f.log.includes('poll restarted'), 'the paused poll timer is running again');
  next = true;
  await f.page.refreshTaskDetails('t', true);
  assert.equal(asked, 1 + 4, 'the whole poll ran again with its new guard'); assert.ok(!f.log.some(item => /cleared|dialog|signed out|toast/.test(item)), f.log.join());
  f.page.renewal().dispose();
});

test('a guarded write is never sent twice: not sent across an expiry, not repeated after a 401, and never silent', async () => {
  for (const when of ['before-send', 'after-401']) {
    const f = page({ server: ({ init, advance }) => {
      if (init.method === 'GET') return json('/x', { folders: [] });
      advance(31 * MINUTE); return json('/x', { error: 'authentication_required' }, 401);
    } });
    if (when === 'before-send') f.advance(31 * MINUTE);
    let succeeded = false;
    await f.page.mutateFolder('p', '/api/v1/projects/p/folders', { method: 'POST', body: {}, headers: { 'Idempotency-Key': 'one' } }, 'Saved', f.page.folderAuthorizationGuard('p'), () => { succeeded = true; });
    await tick(40);
    assert.equal(f.requests.filter(item => item.method === 'POST').length, when === 'before-send' ? 0 : 1, when);
    assert.equal(succeeded, false); assert.equal(f.context.state.busy, false);
    assert.deepEqual(f.log.filter(item => item.startsWith('toast')), ['toast true Access was renewed before that change was saved. Try it again.']);
    f.page.renewal().dispose();
  }
});

test('a server that keeps answering 401 after a renewal is handled once, never renewed in a loop', async () => {
  const f = page({ server: () => json('/x', { error: 'authentication_required' }, 401) });
  await f.page.loadProjectFolders('p'); await tick(80);
  assert.equal(f.requests.length, 2, 'the original read and the one repaint');
  assert.deepEqual(f.log.filter(item => item.startsWith('cleared')), ['cleared undefined']);
  f.page.renewal().dispose();
});

test('a 401 that renewal cannot fix still reaches the existing handling once', async () => {
  const f = page({ renew: false, server: () => json('/x', { error: 'authentication_required' }, 401) });
  const done = f.page.loadProjectFolders('p'); await tick(20);
  f.timers.findLast(timer => timer.delay === 25_000 && !timer.cleared).handler();
  await done;
  assert.equal(f.requests.length, 1); assert.deepEqual(f.log.filter(item => item.startsWith('cleared')), ['cleared undefined']);
  f.page.renewal().dispose();
});

// Every answer either endpoint can give, and what the attempt as a whole means.
const ANSWERS = {
  unreadable: () => { throw new TypeError('Failed to fetch'); },
  hang: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))),
  html: url => { const response = new Response('<p>sign in</p>', { status: 200, headers: { 'Content-Type': 'text/html' } }); Object.defineProperty(response, 'url', { value: url }); return response; },
  outage503: url => json(url, { error: 'Workspace renewal is temporarily unavailable' }, 503),
  limited429: url => json(url, { error: 'Workspace renewal rate limit exceeded' }, 429),
  disabled404: url => json(url, { error: 'Not found' }, 404),
  rejected400: url => json(url, { error: 'Invalid renewal request' }, 400),
  csrf403: url => json(url, { error: 'Renewal CSRF challenge is invalid or expired' }, 403),
  signedOut401: url => json(url, { error: 'Cloudflare Access authentication required' }, 401),
  denied403: url => json(url, { error: 'Global viewer.view permission required' }, 403),
};
const OUTAGES = ['outage503', 'limited429'], SILENT = ['unreadable', 'hang', 'html'];
const expected = (alternate, pinned) => pinned === 'signedOut401' ? 'signed-out' : pinned === 'denied403' ? 'revoked'
  : alternate === 'denied403' && SILENT.includes(pinned) ? 'revoked'
    : OUTAGES.includes(alternate) || OUTAGES.includes(pinned) ? 'outage' : 'unknown';

for (const alternate of Object.keys(ANSWERS)) test(`every pinned answer after a same-site "${alternate}" keeps the whole attempt's meaning`, async () => {
  for (const pinned of Object.keys(ANSWERS)) {
    const label = `${alternate} + ${pinned}`, outcome = expected(alternate, pinned);
    const context = harness({ respond: ({ url, init }) => url.startsWith(SAME_SITE) ? ANSWERS[alternate](url, init) : url.startsWith(PINNED) ? ANSWERS[pinned](url, init) : undefined });
    // While the session is live nothing is shown unless Operations refused this identity.
    await context.advance(30 * MINUTE - 1);
    if (outcome === 'signed-out' || outcome === 'revoked') { assert.deepEqual(context.events, [['expired', outcome]], label); continue; }
    assert.deepEqual(context.names(), [], label);
    // After real expiry Viewer itself answers 401: only that plus no outage asks for sign-in.
    await context.advance(10 * MINUTE);
    assert.deepEqual(context.names(), outcome === 'outage' ? ['paused'] : ['paused', 'sign-in'], label);
    assert.ok(!urls(context).includes(REDEEM), label);
    context.renewal.dispose();
  }
});

test('without a same-site host every pinned answer keeps its own meaning', async () => {
  for (const pinned of Object.keys(ANSWERS)) {
    const outcome = expected(null, pinned);
    const context = harness({ renewalOrigin: null, respond: ({ url, init }) => url.startsWith('https:') ? ANSWERS[pinned](url, init) : undefined });
    await context.advance(40 * MINUTE);
    assert.deepEqual(context.events.map(event => event[0] === 'expired' ? event[1] : event[0]),
      outcome === 'outage' ? ['paused'] : outcome === 'unknown' ? ['paused', 'sign-in'] : [outcome], pinned);
    context.renewal.dispose();
  }
});

test('an outage that ends becomes an ordinary renewal, and one that turns into a refusal is not hidden by it', async () => {
  let mode = 'outage503';
  const context = harness({ respond: ({ url, init }) => url.startsWith(SAME_SITE) ? ANSWERS[mode]?.(url, init) : url.startsWith(PINNED) ? ANSWERS.unreadable(url, init) : undefined });
  await context.advance(40 * MINUTE);
  assert.deepEqual(context.names(), ['paused']);
  mode = 'signedOut401'; await context.advance(10 * MINUTE);
  assert.deepEqual(context.names(), ['paused', 'sign-in']);
  mode = null; await context.advance(2 * MINUTE);
  assert.deepEqual(context.names().slice(-2), ['session', 'resumed']);
  context.renewal.dispose();
});

test('the page wires sign-in to the existing dialog and silent success to closing it', () => {
  const install = workspace.split('\n').find(line => line.startsWith('function installWorkspaceSession('));
  assert.match(install, /onSignInRequired:\(\)=>\{if\(!workspaceRecovery\.isPaused\(\)\)beginWorkspaceReauthorization\(\);\}/);
  assert.match(install, /workspaceRecovery\.resume\(\);\}\}\);workspaceRenewal\.start\(\)/);
  assert.match(workspace, /reason==='signed-out'/);
});

test('public and shared pages never load workspace renewal', () => {
  for (const file of ['main.js', 'index.html', 'review-launch.html']) {
    const text = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /workspace-renewal|session-renewal\/challenge|WorkspaceSessionRenewal/, file);
  }
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  assert.match(main, /function requestSessionRenewal\(reason = 'timer'\) \{\r?\n\s+if \(VIEW_MODE !== 'session'/);
});

test('only an approved Operations host on the Viewer site is offered, and only when the pinned one is elsewhere', () => {
  const config = { publicBaseUrl: VIEWER, opsControllerOrigins: [SAME_SITE, PINNED] };
  assert.deepEqual(controller.sameSiteRenewal(PINNED, config), { renewalOrigin: SAME_SITE });
  assert.deepEqual(controller.sameSiteRenewal(SAME_SITE, config), {}, 'already same-site');
  assert.deepEqual(controller.sameSiteRenewal(PINNED, { ...config, opsControllerOrigins: [PINNED] }), {}, 'nothing configured');
  assert.deepEqual(controller.sameSiteRenewal(PINNED, { ...config, publicBaseUrl: '' }), {});
  assert.deepEqual(controller.sameSiteRenewal(PINNED, { ...config, opsControllerOrigins: ['http://ops.viewer-site.test'] }), {}, 'HTTPS only');
});
