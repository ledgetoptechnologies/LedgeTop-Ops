import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSessionController } from '../review-session-controller.mjs';

const ORIGIN = 'https://viewer.example';
const CHANNEL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const REQUEST_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const GRANT = '11111111-2222-4333-8444-555555555555';
const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const CURRENT_EXPIRY = '2026-08-26T12:04:00.000Z';
const NEXT_EXPIRY = '2026-08-26T12:29:00.000Z';
const CONTEXT = Object.freeze({
  attemptId: 'attempt-one', modelId: 'model-one', modelVersionId: 'version-one', sessionTtlSeconds: 1800,
});

class FakeChannel {
  constructor(name) { this.name = name; this.posts = []; this.closed = false; this.onmessage = null; }
  postMessage(value) { this.posts.push(value); }
  emit(data) { return this.onmessage?.({ data }); }
  close() { this.closed = true; }
}

function harness(overrides = {}) {
  const channels = [];
  const calls = [];
  const timers = [];
  const controller = new ReviewSessionController({
    origin: ORIGIN,
    issueGrant: async context => {
      calls.push(context);
      return { grant: GRANT, sessionMode: 'review', ...CONTEXT };
    },
    createChannel: name => { const channel = new FakeChannel(name); channels.push(channel); return channel; },
    now: () => NOW,
    retryDelays: [10, 20],
    setTimer: (handler, delay) => { const timer = { handler, delay, cleared: false }; timers.push(timer); return timer; },
    clearTimer: timer => { timer.cleared = true; },
    ...overrides,
  });
  return { controller, channels, calls, timers };
}

function ready(channel, expiresAt = CURRENT_EXPIRY) {
  return channel.emit({ version: 1, type: 'ltds-viewer:ready', modelId: CONTEXT.modelId, expiresAt });
}

function expiring(channel, overrides = {}) {
  return channel.emit({
    version: 1, type: 'ltds-viewer:session-expiring', requestId: REQUEST_ID,
    modelId: CONTEXT.modelId, expiresAt: CURRENT_EXPIRY, ...overrides,
  });
}

function continuityStorage(){const values=new Map();return{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key),values};}

test('stalled grant issuance times out, retries once at a time, and ignores late grants', async () => {
  const requests = [];
  const f = harness({ issueGrant: (context, { signal }) => new Promise(resolve => requests.push({ resolve, signal })) });
  f.controller.track(CHANNEL_ID, CONTEXT);
  const channel = f.channels[0];
  await ready(channel);
  const pending = expiring(channel);
  assert.equal(requests.length, 1);
  assert.equal(f.controller.navigate(CHANNEL_ID, 'https://other.example/'), false);
  assert.equal(requests[0].signal.aborted, false, 'invalid navigation cannot cancel renewal');
  assert.equal(await expiring(channel, { requestId: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa' }), false);
  const deadline = f.timers.find(timer => timer.delay === 10_000 && !timer.cleared);
  deadline.handler();
  assert.equal(await pending, false);
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(f.controller.records.get(CHANNEL_ID).pending, false);
  const retry = f.timers.find(timer => timer.delay === 10 && !timer.cleared);
  assert.ok(retry);
  const retryPending = retry.handler();
  assert.equal(requests.length, 2);
  requests[0].resolve({ grant: GRANT, sessionMode: 'review', ...CONTEXT });
  await Promise.resolve();
  assert.equal(channel.posts.length, 0, 'late successful issuance cannot deliver an obsolete grant');
  requests[1].resolve({ grant: GRANT, sessionMode: 'review', ...CONTEXT });
  assert.equal(await retryPending, true);
  assert.equal(channel.posts.filter(item => item.type === 'ltds-viewer:renew-session').length, 1);
  assert.equal(await expiring(channel, { requestId: 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb' }), false);
  f.controller.dispose();
});

test('closing or revoking a controller aborts pending issuance and fences its late result', async () => {
  for (const revoke of [false, true]) {
    let resolve, signal;
    const f = harness({ issueGrant: (_, options) => { signal = options.signal; return new Promise(done => { resolve = done; }); } });
    f.controller.track(CHANNEL_ID, CONTEXT);
    const channel = f.channels[0];
    await ready(channel);
    const pending = expiring(channel);
    if (revoke) f.controller.unavailable(f.controller.records.get(CHANNEL_ID), 'authorization-required');
    else f.controller.dispose();
    assert.equal(signal.aborted, true);
    assert.equal(await pending, false);
    resolve({ grant: GRANT, sessionMode: 'review', ...CONTEXT });
    await Promise.resolve();
    assert.equal(channel.posts.some(item => item.type === 'ltds-viewer:renew-session'), false);
    assert.equal(f.timers.some(timer => !timer.cleared), false);
    assert.equal(f.controller.has(CHANNEL_ID), false);
  }
});

test('synchronous issuance failure clears its deadline and retries remain bounded', async () => {
  let calls = 0;
  const f = harness({ issueGrant: () => { calls++; throw new Error('transport unavailable'); } });
  f.controller.track(CHANNEL_ID, CONTEXT);
  await ready(f.channels[0]);
  assert.equal(await expiring(f.channels[0]), false);
  await f.timers.find(timer => timer.delay === 10 && !timer.cleared).handler();
  await f.timers.find(timer => timer.delay === 20 && !timer.cleared).handler();
  assert.equal(calls, 3);
  assert.equal(f.timers.some(timer => !timer.cleared), false);
  assert.equal(f.controller.records.get(CHANNEL_ID).pending, false);
  assert.equal(f.channels[0].posts.length, 0);
  f.controller.dispose();
});

test('same authenticated subject restores non-secret channels after workspace bounce and reissues through server',async()=>{
  const storage=continuityStorage(),first=harness({storage});first.controller.setAuthenticatedSubject('ops:one');first.controller.track(CHANNEL_ID,CONTEXT);await ready(first.channels[0]);
  const saved=JSON.parse([...storage.values.values()][0]);
  assert.deepEqual(Object.keys(saved).sort(),['records','subject']);assert.deepEqual(Object.keys(saved.records[0]).sort(),['channelId','context','updatedAt']);
  assert.doesNotMatch(JSON.stringify(saved),/accessToken|Bearer|grant|permissions|embedUrl/);
  first.controller.suspend({preserve:true});
  const restored=harness({storage});assert.equal(restored.channels.length,0,'browser metadata alone creates no authority or channel');
  restored.controller.setAuthenticatedSubject('ops:one');assert.equal(restored.controller.has(CHANNEL_ID),true);assert.equal(restored.calls.length,0);
  assert.deepEqual(restored.channels[0].posts[0],{version:1,type:'ltds-viewer:controller-ready',channelId:CHANNEL_ID,modelId:CONTEXT.modelId});
  assert.equal(await expiring(restored.channels[0]),true);
  assert.deepEqual(restored.calls,[CONTEXT]);assert.equal(restored.channels[0].posts.at(-1).grant,GRANT);
});

test('restored channels reject early/foreign requests and exact issued scope changes',async()=>{
  const storage=continuityStorage(),first=harness({storage});first.controller.setAuthenticatedSubject('ops:one');first.controller.track(CHANNEL_ID,CONTEXT);first.controller.suspend({preserve:true});
  const restored=harness({storage,issueGrant:async()=>({sessionMode:'review',...CONTEXT,modelVersionId:'changed-version',grant:GRANT})});restored.controller.setAuthenticatedSubject('ops:one');const channel=restored.channels[0];
  assert.equal(await expiring(channel,{modelId:'other'}),false);assert.equal(await expiring(channel,{expiresAt:NEXT_EXPIRY}),false);assert.equal(await expiring(channel),false);
  assert.equal(channel.posts.at(-1).reason,'scope-changed');assert.equal(channel.posts.some(message=>message.type==='ltds-viewer:renew-session'),false);
  assert.equal(JSON.parse([...storage.values.values()][0]).records.length,0);
});

test('changed subject, explicit sign-out, denial and aged/poisoned descriptors cannot restore model channels',async()=>{
  for(const reason of ['subject','signout','denial','aged','poisoned']){
    const storage=continuityStorage(),first=harness({storage});first.controller.setAuthenticatedSubject('ops:one');first.controller.track(CHANNEL_ID,CONTEXT);
    if(reason==='signout')first.controller.dispose();
    else if(reason==='denial'){await ready(first.channels[0]);first.controller.issueGrant=async()=>{throw Object.assign(Error('revoked'),{status:403});};await expiring(first.channels[0]);}
    else first.controller.suspend({preserve:true});
    if(reason==='aged'||reason==='poisoned'){const [key,text]=[...storage.values][0],saved=JSON.parse(text);if(reason==='aged')saved.records[0].updatedAt=NOW-86400001;else saved.records[0].context.accessToken='must-not-be-restored';storage.setItem(key,JSON.stringify(saved));}
    const restored=harness({storage});restored.controller.setAuthenticatedSubject(reason==='subject'?'ops:other':'ops:one');
    assert.equal(restored.controller.records.size,0,reason);assert.equal(restored.calls.length,0,reason);
  }
});

test('restored published scope and expired viewer request remain exact and server-authorized',async()=>{
  const storage=continuityStorage(),context={sessionMode:'published',outputId:'version-one',modelId:'model-one',modelVersionId:'version-one',sessionTtlSeconds:1800},first=harness({storage});
  first.controller.setAuthenticatedSubject('ops:one');first.controller.track(CHANNEL_ID,context);first.controller.suspend({preserve:true});
  const restored=harness({storage,issueGrant:async issued=>({...issued,grant:GRANT})});restored.controller.setAuthenticatedSubject('ops:one');
  assert.equal(await expiring(restored.channels[0],{expiresAt:new Date(NOW-60000).toISOString()}),true);
  assert.equal(restored.channels[0].posts.at(-1).type,'ltds-viewer:renew-session');
});

test('suspended issuance completion cannot deliver grants or schedule stale retry work',async()=>{
  let reject;
  const context=harness({issueGrant:()=>new Promise((_resolve,fail)=>{reject=fail;})});context.controller.track(CHANNEL_ID,CONTEXT);await ready(context.channels[0]);
  const pending=expiring(context.channels[0]);context.controller.suspend({preserve:true});reject(Error('late network failure'));await pending;
  assert.equal(context.timers.filter(timer=>!timer.cleared).length,0);assert.equal(context.channels[0].posts.length,0);
});

test('storage quota failure retires stale descriptors without disrupting active channels',()=>{
  const storage=continuityStorage(),first=harness({storage});first.controller.setAuthenticatedSubject('ops:one');first.controller.track(CHANNEL_ID,CONTEXT);
  storage.setItem=()=>{throw Error('quota exceeded');};
  assert.doesNotThrow(()=>first.controller.untrack(CHANNEL_ID));assert.equal(storage.values.size,0);
  const restored=harness({storage});assert.doesNotThrow(()=>restored.controller.setAuthenticatedSubject('ops:one'));assert.equal(restored.controller.records.size,0);
  assert.equal(restored.controller.track(CHANNEL_ID,CONTEXT),true,'unavailable persistence must not prevent a new authorized launch');
});

test('channel creation and advisory failures are isolated from authenticated workspace installation',()=>{
  for(const failure of ['creation','advisory']){
    const storage=continuityStorage(),first=harness({storage});first.controller.setAuthenticatedSubject('ops:one');first.controller.track(CHANNEL_ID,CONTEXT);first.controller.suspend({preserve:true});
    const restored=harness({storage,createChannel:()=>{if(failure==='creation')throw Error('unavailable');return{postMessage(){throw Error('closed')},close(){throw Error('already closed')}};}});
    assert.doesNotThrow(()=>restored.controller.setAuthenticatedSubject('ops:one'),failure);
    assert.equal(restored.controller.subject,'ops:one');assert.equal(restored.controller.records.size,0);
    assert.equal(JSON.parse([...storage.values.values()][0]).records.length,0);
  }
});

test('normal same-subject refresh preserves live controllers even when storage becomes unavailable',()=>{
  const storage=continuityStorage(),context=harness({storage});context.controller.setAuthenticatedSubject('ops:one');context.controller.track(CHANNEL_ID,CONTEXT);const record=context.controller.records.get(CHANNEL_ID);
  storage.getItem=()=>{throw Error('denied');};storage.setItem=()=>{throw Error('denied');};
  assert.equal(context.controller.setAuthenticatedSubject('ops:one'),true);assert.equal(context.controller.records.get(CHANNEL_ID),record);assert.equal(record.channel.closed,false);
});

test('authoritative denial retires persistence even if posting the denial fails',async()=>{
  const storage=continuityStorage(),context=harness({storage,issueGrant:async()=>{throw Object.assign(Error('revoked'),{status:403});}});
  context.controller.setAuthenticatedSubject('ops:one');context.controller.track(CHANNEL_ID,CONTEXT);await ready(context.channels[0]);
  context.channels[0].postMessage=()=>{throw Error('closed');};
  assert.equal(await expiring(context.channels[0]),false);assert.equal(context.controller.records.size,0);assert.equal(JSON.parse([...storage.values.values()][0]).records.length,0);
});

test('more than 32 live launches remain possible while continuity keeps only the last 32 descriptors',()=>{
  const storage=continuityStorage(),context=harness({storage});context.controller.setAuthenticatedSubject('ops:one');
  for(let index=0;index<40;index++)assert.equal(context.controller.track(`${index.toString(16).padStart(8,'0')}-bbbb-4ccc-8ddd-eeeeeeeeeeee`,CONTEXT),true);
  assert.equal(context.controller.records.size,40);const saved=JSON.parse([...storage.values.values()][0]);assert.equal(saved.records.length,32);assert.equal(saved.records[0].channelId.startsWith('00000008'),true);
});

test('isolated review channel navigates and issues one expiry-bound renewal grant', async () => {
  const { controller, channels, calls } = harness();
  assert.equal(controller.track(CHANNEL_ID, CONTEXT), true);
  const channel = channels[0];
  assert.equal(channel.name, `ltds-viewer-review:${CHANNEL_ID}`);
  assert.equal(controller.navigate(CHANNEL_ID, `${ORIGIN}/session/${GRANT}#reviewController=${CHANNEL_ID}`), true);
  assert.deepEqual(channel.posts.at(-1), { version: 1, type: 'ltds-viewer:navigate', url: `${ORIGIN}/session/${GRANT}#reviewController=${CHANNEL_ID}` });
  assert.equal(await ready(channel), true);
  assert.equal(await expiring(channel), true);
  assert.deepEqual(calls, [CONTEXT]);
  assert.deepEqual(channel.posts.at(-1), { version: 1, type: 'ltds-viewer:renew-session', requestId: REQUEST_ID, grant: GRANT });
  assert.equal(await expiring(channel), false, 'same request cannot mint another grant while redemption is pending');
  assert.equal(calls.length, 1);

  assert.equal(await channel.emit({ version: 1, type: 'ltds-viewer:session-renewed', requestId: REQUEST_ID, modelId: CONTEXT.modelId, expiresAt: NEXT_EXPIRY }), true);
  assert.equal(await expiring(channel), false, 'replayed request id and stale expiry stay rejected after renewal');
  controller.dispose();
  assert.equal(channel.closed, true);
});

test('a suspended Viewer may request an exact renewal after its recorded expiry', async () => {
  let clock = NOW;
  const { controller, channels, calls } = harness({ now: () => clock });
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  clock = Date.parse(CURRENT_EXPIRY) + 60_000;
  assert.equal(await expiring(channel), true);
  assert.equal(calls.length, 1);
  assert.equal(channel.posts.at(-1).type, 'ltds-viewer:renew-session');
});

test('same-expiry response clears the renewal race and permits a later retry', async () => {
  const { controller, channels, calls } = harness();
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  assert.equal(await expiring(channel), true);
  assert.equal(await channel.emit({
    version: 1, type: 'ltds-viewer:session-renewed', requestId: REQUEST_ID,
    modelId: CONTEXT.modelId, expiresAt: CURRENT_EXPIRY,
  }), true);
  const retryId = 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa';
  assert.equal(await expiring(channel, { requestId: retryId }), true);
  assert.equal(calls.length, 2);
  assert.equal(channel.posts.at(-1).requestId, retryId);
});

test('a delivered grant cannot leave the controller permanently awaiting a sleeping Viewer', async () => {
  const { controller, channels, calls, timers } = harness();
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  await expiring(channel);
  const responseTimer = timers.find(timer => timer.delay === 35_000 && !timer.cleared);
  assert.ok(responseTimer);
  responseTimer.handler();
  const retryId = 'dddddddd-eeee-4fff-8aaa-bbbbbbbbbbbb';
  assert.equal(await expiring(channel, { requestId: retryId }), true);
  assert.equal(calls.length, 2);
});

test('wrong shape, model, expiry, early request, and unknown channel mint nothing', async () => {
  const { controller, channels, calls } = harness();
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  assert.equal(await expiring(channel), false, 'expiry cannot be requested before Viewer ready binds the session');
  await ready(channel, '2026-08-26T12:20:00.000Z');
  assert.equal(await expiring(channel, { expiresAt: '2026-08-26T12:20:00.000Z' }), false, 'requests outside the five-minute renewal window fail closed');
  await ready(channel);
  assert.equal(await expiring(channel, { modelId: 'other-model' }), false);
  assert.equal(await expiring(channel, { expiresAt: '2026-08-26T12:03:59.000Z' }), false);
  assert.equal(await expiring(channel, { extra: true }), false);
  const unknown = new FakeChannel('ltds-viewer-review:unknown');
  assert.equal(await expiring(unknown), undefined);
  assert.equal(calls.length, 0);
});

test('mismatched issuance response is never delivered', async () => {
  const { controller, channels } = harness({ issueGrant: async () => ({ grant: GRANT, sessionMode: 'review', ...CONTEXT, modelId: 'wrong' }) });
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  assert.equal(await expiring(channel), false);
  assert.equal(controller.has(CHANNEL_ID), false);
  assert.equal(channel.posts.some(post => post.type === 'ltds-viewer:renew-session'), false);
});

test('an authoritative failed grant redemption closes the bounded renewal channel', async () => {
  const { controller, channels } = harness();
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  assert.equal(await expiring(channel), true);
  assert.equal(await channel.emit({
    version: 1, type: 'ltds-viewer:session-renewal-failed', requestId: REQUEST_ID,
    modelId: CONTEXT.modelId, retryable: false,
  }), true);
  assert.equal(controller.has(CHANNEL_ID), false);
  assert.equal(channel.closed, true);
});

test('a transient grant redemption failure keeps the channel available for a new request', async () => {
  const { controller, channels, calls } = harness();
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  await expiring(channel);
  assert.equal(await channel.emit({
    version: 1, type: 'ltds-viewer:session-renewal-failed', requestId: REQUEST_ID,
    modelId: CONTEXT.modelId, retryable: true,
  }), true);
  assert.equal(controller.has(CHANNEL_ID), true);
  const retryId = 'eeeeeeee-ffff-4aaa-8bbb-cccccccccccc';
  assert.equal(await expiring(channel, { requestId: retryId }), true);
  assert.equal(calls.length, 2);
});

test('transient issuance retries are bounded and workspace authorization failure closes the channel', async () => {
  let attempts = 0;
  const error = Object.assign(new Error('temporary'), { status: 503 });
  const { controller, channels, timers } = harness({ issueGrant: async () => { attempts += 1; throw attempts < 3 ? error : Object.assign(new Error('expired'), { status: 401 }); } });
  controller.track(CHANNEL_ID, CONTEXT);
  const channel = channels[0];
  await ready(channel);
  assert.equal(await expiring(channel), false);
  assert.equal(timers.filter(timer => !timer.cleared).length, 1);
  await timers.find(timer => !timer.cleared).handler();
  assert.equal(timers.filter(timer => !timer.cleared).length, 1);
  await timers.find(timer => !timer.cleared).handler();
  assert.equal(attempts, 3);
  assert.equal(controller.has(CHANNEL_ID), false);
  assert.equal(channel.closed, true);
  assert.equal(channel.posts.at(-1).type, 'ltds-viewer:session-unavailable');
  assert.equal(channel.posts.at(-1).requestId, REQUEST_ID);
  assert.equal(channel.posts.at(-1).reason, 'authorization-required');
});

test('published sessions renew through the same isolated channel with an immutable output scope', async () => {
  const context = { sessionMode: 'published', outputId: 'version-one', modelId: 'model-one',
    modelVersionId: 'version-one', sessionTtlSeconds: 1800 };
  const calls = [];
  const { controller, channels } = harness({ issueGrant: async value => {
    calls.push(value);
    return { grant: GRANT, sessionMode: 'published', modelId: context.modelId,
      modelVersionId: context.modelVersionId, sessionTtlSeconds: context.sessionTtlSeconds };
  } });
  assert.equal(controller.track(CHANNEL_ID, { ...context, outputId: 'different-version' }), false);
  assert.equal(controller.track(CHANNEL_ID, context), true);
  const channel = channels[0];
  await ready(channel);
  assert.equal(await expiring(channel), true);
  assert.deepEqual(calls, [context]);
  assert.ok(Object.isFrozen(calls[0]));
  assert.equal(channel.posts.at(-1).type, 'ltds-viewer:renew-session');
  assert.equal(await channel.emit({ version: 1, type: 'ltds-viewer:session-renewed',
    requestId: REQUEST_ID, modelId: context.modelId, expiresAt: NEXT_EXPIRY }), true);
});

test('published renewal refuses a new model version or a review grant', async () => {
  for (const change of [{ modelVersionId: 'version-two' }, { sessionMode: 'review' }]) {
    const context = { sessionMode: 'published', outputId: 'version-one', modelId: 'model-one',
      modelVersionId: 'version-one', sessionTtlSeconds: 1800 };
    const { controller, channels } = harness({ issueGrant: async () => ({ ...context, grant: GRANT, ...change }) });
    controller.track(CHANNEL_ID, context);
    await ready(channels[0]);
    assert.equal(await expiring(channels[0]), false);
    assert.equal(controller.has(CHANNEL_ID), false);
    assert.equal(channels[0].posts.at(-1).reason, 'scope-changed');
    assert.equal(channels[0].posts.some(message => message.grant), false);
  }
});
