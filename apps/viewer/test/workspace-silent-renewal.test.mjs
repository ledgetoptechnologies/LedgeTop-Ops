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
function guarded({ statuses, renew, expired = false, current = () => true }) {
  const calls = [];
  const context = vm.createContext({ DOMException, Date, calls,
    workspaceRenewal: renew && { expiresAtMs: Date.now() + (expired ? -1 : 60_000), waitForRenewal: renew },
    fetch: async (path, init) => { calls.push({ path, init }); return { status: statuses[calls.length - 1] }; },
    responseError: (message, status) => Object.assign(new Error(message), { status }) });
  vm.runInContext(`${workspace.slice(workspace.indexOf('async function guardedFetch('), workspace.indexOf('async function workspaceFetch('))}\nthis.run=guardedFetch;`, context);
  const check = () => { if (!current()) throw Object.assign(new Error('changed'), { code: 'recovery_session_changed' }); };
  return { calls, run: init => context.run('/poll', init, check) };
}

test('a background poll that lands on expiry waits for silent renewal instead of asking for sign-in', async () => {
  const poll = guarded({ statuses: [401, 200], renew: async () => true });
  assert.equal((await poll.run({ method: 'GET' })).status, 200); assert.equal(poll.calls.length, 2, 'one retry');
  const twice = guarded({ statuses: [401, 401], renew: async () => true });
  assert.equal((await twice.run({ method: 'GET' })).status, 401); assert.equal(twice.calls.length, 2, 'never loops');
  let waited = null;
  const expired = guarded({ statuses: [200], expired: true, renew: async options => { waited = options; return true; } });
  assert.equal((await expired.run({ method: 'GET' })).status, 200); assert.equal(waited.whileExpired, true);
  const write = guarded({ statuses: [401], renew: async () => true });
  await assert.rejects(write.run({ method: 'POST' }), { status: 409 }); assert.equal(write.calls.length, 1, 'writes are not replayed');
  let same = true;
  const changed = guarded({ statuses: [401], renew: async () => { same = false; return true; }, current: () => same });
  await assert.rejects(changed.run({ method: 'GET' }), { code: 'recovery_session_changed' }); assert.equal(changed.calls.length, 1);
  const denied = guarded({ statuses: [401], renew: async () => false });
  assert.equal((await denied.run({ method: 'GET' })).status, 401);
  assert.equal((await guarded({ statuses: [401] }).run({ method: 'GET' })).status, 401);
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
