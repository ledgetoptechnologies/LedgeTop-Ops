import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkspaceSessionRenewal } from '../workspace-renewal.mjs';

const TOKEN = 'workspace-token-000000000000000000000000';
const GRANT = 'workspace-grant-000000000000000000000000';
const ORIGIN = 'https://ops.example.test';

function harness({ fetchImpl } = {}) {
  const posted = [];
  const timers = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const controllerWindow = { closed: false, postMessage: (message, origin) => posted.push({ message, origin }) };
  const windowRef = {
    addEventListener: (type, listener) => windowListeners.set(type, listener),
    removeEventListener: (type, listener) => { if (windowListeners.get(type) === listener) windowListeners.delete(type); },
  };
  const documentRef = {
    visibilityState: 'visible',
    addEventListener: (type, listener) => documentListeners.set(type, listener),
    removeEventListener: (type, listener) => { if (documentListeners.get(type) === listener) documentListeners.delete(type); },
  };
  let expired = null;
  const sessions = [];
  const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  const envelope = {
    accessToken: TOKEN,
    session: { id: 'session-one', subject: 'ops:one', permissions: [], displayUnits: 'imperial', expiresAt },
    controllerOrigin: ORIGIN,
  };
  const renewal = new WorkspaceSessionRenewal({
    controllerWindow,
    envelope,
    accessToken: TOKEN,
    fetchImpl: fetchImpl || (async () => { throw new Error('unexpected fetch'); }),
    windowRef,
    documentRef,
    setTimer: (handler, delay) => { const timer = { handler, delay, cleared: false };timers.push(timer);return timer; },
    clearTimer: (timer) => { timer.cleared = true; },
    randomUUID: (() => { let value = 0;return () => `request-${++value}`; })(),
    onSession: (value) => sessions.push(value),
    onExpired: (reason) => { expired = reason; },
  });
  return { renewal, envelope, controllerWindow, posted, timers, windowListeners, documentListeners, sessions, expired: () => expired };
}

test('workspace renewal pins the exact opener, Ops origin, protocol, request and stable bearer/session', async () => {
  const calls = [];
  const context = harness({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          accessToken: TOKEN,
          session: { ...context.envelope.session, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() },
          controllerOrigin: context.envelope.controllerOrigin,
        }),
      };
    },
  });
  context.renewal.start();
  assert.deepEqual(context.posted[0], {
    origin: ORIGIN,
    message: { version: 1, type: 'ltds-viewer:workspace-ready', sessionId: 'session-one', subject: 'ops:one', expiresAt: context.envelope.session.expiresAt },
  });
  context.documentListeners.get('visibilitychange')();
  context.windowListeners.get('focus')();
  const request = context.posted.at(-1).message;
  assert.equal(request.type, 'ltds-viewer:workspace-session-expiring');
  assert.equal(context.posted.filter((entry) => entry.message.type === 'ltds-viewer:workspace-session-expiring').length, 1, 'focus and visibility coalesce while one renewal is pending');
  assert.deepEqual(Object.keys(request).sort(), ['expiresAt','requestId','sessionId','subject','type','version'].sort());

  await context.renewal.handleMessage({ source: {}, origin: ORIGIN, data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
  await context.renewal.handleMessage({ source: context.controllerWindow, origin: 'https://attacker.example', data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
  await context.renewal.handleMessage({ source: context.controllerWindow, origin: ORIGIN, data: { version: 2, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
  await context.renewal.handleMessage({ source: context.controllerWindow, origin: ORIGIN, data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT, extra: true } });
  assert.equal(calls.length, 0);

  await context.renewal.handleMessage({ source: context.controllerWindow, origin: ORIGIN, data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/v1/admin-sessions/redeem');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { grant: GRANT });
  assert.equal(context.sessions.length, 1);
  assert.equal(context.posted.at(-1).message.type, 'ltds-viewer:workspace-session-renewed');
  assert.deepEqual(Object.keys(context.posted.at(-1).message).sort(), ['expiresAt','requestId','sessionId','subject','type','version'].sort());
  assert.equal(context.posted.at(-1).origin, ORIGIN);
  assert.equal(context.expired(), null);
});

test('retryable renewal failures preserve the current session and stop after a bounded retry budget', async () => {
  let calls = 0;
  const context = harness({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({ error: 'temporarily unavailable' }) }) });
  context.renewal.start();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal(context.renewal.requestRenewal(attempt ? 'retry' : 'timer'), true);
    const request = context.posted.findLast((entry) => entry.message.type === 'ltds-viewer:workspace-session-expiring').message;
    await context.renewal.handleMessage({ source: context.controllerWindow, origin: ORIGIN, data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
    calls += 1;
  }
  assert.equal(context.renewal.requestRenewal('retry'), false);
  assert.equal(calls, 5);
  assert.equal(context.renewal.accessToken, TOKEN);
  assert.equal(context.sessions.length, 0);
  assert.equal(context.expired(), null);
  const failures = context.posted.filter((entry) => entry.message.type === 'ltds-viewer:workspace-session-renewal-failed');
  assert.equal(failures.length, 5);
  assert.ok(failures.every((entry) => entry.message.retryable === true));
  assert.ok(failures.every((entry) => Object.keys(entry.message).sort().join(',') === ['requestId','retryable','type','version'].sort().join(',')));
});

test('only authoritative 401 or actual expiry clears the workspace session', async () => {
  const unauthorized = harness({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'authentication required' }) }) });
  unauthorized.renewal.start();
  unauthorized.renewal.requestRenewal('timer');
  const request = unauthorized.posted.findLast((entry) => entry.message.type === 'ltds-viewer:workspace-session-expiring').message;
  await unauthorized.renewal.handleMessage({ source: unauthorized.controllerWindow, origin: ORIGIN, data: { version: 1, type: 'ltds-viewer:renew-workspace-session', requestId: request.requestId, grant: GRANT } });
  assert.equal(unauthorized.expired(), 'revoked');
  assert.equal(unauthorized.posted.findLast((entry) => entry.message.type === 'ltds-viewer:workspace-session-renewal-failed').message.retryable, false);

  const late = harness();
  late.renewal.start();
  const expiryTimer = late.timers.find((timer) => timer.delay > 60_000 && timer.delay < 3 * 60_000);
  expiryTimer.handler();
  assert.equal(late.expired(), null, 'an attached controller remains able to issue a fresh recovery grant');
  assert.equal(late.posted.at(-1).message.type, 'ltds-viewer:workspace-session-expiring');
  assert.equal(late.windowListeners.has('pageshow'), true);
});

test('malformed controller configuration fails closed before registering a message channel', () => {
  const context = harness();
  assert.throws(() => new WorkspaceSessionRenewal({
    controllerWindow: context.controllerWindow,
    envelope: { ...context.envelope, controllerOrigin: `${ORIGIN}/path` },
    accessToken: TOKEN,
    windowRef: { addEventListener() {}, removeEventListener() {} },
    documentRef: { addEventListener() {}, removeEventListener() {} },
  }), /invalid workspace controller response/);
});

test('workspace redemption stays single-flight through fetch/body and has a bounded abort deadline',async()=>{
  let resolveFetch,signal;
  const context=harness({fetchImpl:async(_url,init)=>{signal=init.signal;return new Promise(resolve=>{resolveFetch=resolve;});}});
  context.renewal.start();context.renewal.requestRenewal('timer');
  const request=context.posted.at(-1).message;
  const data={version:1,type:'ltds-viewer:renew-workspace-session',requestId:request.requestId,grant:GRANT};
  const pending=context.renewal.handleMessage({source:context.controllerWindow,origin:ORIGIN,data});
  assert.equal(context.renewal.requestRenewal('focus'),false);
  await context.renewal.handleMessage({source:context.controllerWindow,origin:ORIGIN,data});
  assert.equal(context.renewal.pendingRequestId,request.requestId);
  const watchdog=context.timers.findLast(timer=>timer.delay===10000&&!timer.cleared);
  assert.ok(watchdog);watchdog.handler();
  assert.equal(signal.aborted,true);assert.equal(context.renewal.pendingRequestId,null);
  resolveFetch({ok:true,status:200,json:async()=>context.envelope});await pending;
  assert.equal(context.sessions.length,0,'late successful completion cannot install a timed-out generation');
  assert.ok(context.timers.some(timer=>timer.delay===2000&&!timer.cleared));
});

test('disposed workspace redemption never installs session callbacks or new timers',async()=>{
  let resolveFetch,signal;
  const context=harness({fetchImpl:async(_url,init)=>{signal=init.signal;return new Promise(resolve=>{resolveFetch=resolve;});}});
  context.renewal.start();context.renewal.requestRenewal('timer');const request=context.posted.at(-1).message;
  const pending=context.renewal.handleMessage({source:context.controllerWindow,origin:ORIGIN,data:{version:1,type:'ltds-viewer:renew-workspace-session',requestId:request.requestId,grant:GRANT}});
  context.renewal.dispose();const timerCount=context.timers.length;
  resolveFetch({ok:true,status:200,json:async()=>context.envelope});await pending;
  assert.equal(signal.aborted,true);assert.equal(context.sessions.length,0);assert.equal(context.timers.length,timerCount);
  assert.ok(context.timers.every(timer=>timer.cleared));
});

test('closed controller and exhausted retry budget expire only after actual workspace expiry',()=>{
  for(const reason of ['closed','exhausted']){
    const context=harness();context.renewal.start();context.renewal.now=()=>Date.parse(context.envelope.session.expiresAt)+1;
    if(reason==='closed')context.controllerWindow.closed=true;else context.renewal.retryAttempt=5;
    assert.equal(context.renewal.requestRenewal('expiry'),false);assert.equal(context.expired(),reason==='closed'?'expired':null);if(reason==='exhausted'){assert.equal(context.renewal.paused,true);assert.equal(context.windowListeners.has('focus'),true);}context.renewal.dispose();
  }
});

test('concurrent API expiry waiters share renewal and resolve only after verified session installation',async()=>{
  const context=harness({fetchImpl:async()=>({ok:true,status:200,json:async()=>({...context.envelope,session:{...context.envelope.session,expiresAt:new Date(Date.now()+1800000).toISOString()}})})});
  context.renewal.start();const first=context.renewal.waitForRenewal(),second=context.renewal.waitForRenewal();
  assert.equal(context.posted.filter(x=>x.message.type==='ltds-viewer:workspace-session-expiring').length,1);
  const request=context.posted.at(-1).message;
  await context.renewal.handleMessage({source:context.controllerWindow,origin:ORIGIN,data:{version:1,type:'ltds-viewer:renew-workspace-session',requestId:request.requestId,grant:GRANT}});
  assert.deepEqual(await Promise.all([first,second]),[true,true]);assert.equal(context.sessions.length,1);assert.equal(context.renewal.renewalWaiters.size,0);
  context.renewal.dispose();
});

test('API renewal waiters are bounded, abortable, and fail closed without an authority transport',async()=>{
  const context=harness();context.renewal.start();
  const controller=new AbortController(),aborted=context.renewal.waitForRenewal({signal:controller.signal});controller.abort();assert.equal(await aborted,false);
  const timed=context.renewal.waitForRenewal({timeoutMs:25000});context.timers.findLast(t=>t.delay===25000&&!t.cleared).handler();assert.equal(await timed,false);
  const disposed=context.renewal.waitForRenewal();context.renewal.dispose();assert.equal(await disposed,false);assert.equal(context.renewal.renewalWaiters.size,0);
  const missing=harness();missing.controllerWindow.closed=true;assert.equal(await missing.renewal.waitForRenewal(),false);assert.equal(missing.posted.length,0);missing.renewal.dispose();
});

test('authoritative rejection settles API waiters without retrying protected work',async()=>{
  const context=harness({fetchImpl:async()=>({ok:false,status:401,json:async()=>({})})});context.renewal.start();const waiting=context.renewal.waitForRenewal();const request=context.posted.at(-1).message;
  await context.renewal.handleMessage({source:context.controllerWindow,origin:ORIGIN,data:{version:1,type:'ltds-viewer:renew-workspace-session',requestId:request.requestId,grant:GRANT}});
  assert.equal(await waiting,false);assert.equal(context.expired(),'revoked');assert.equal(context.sessions.length,0);
});
