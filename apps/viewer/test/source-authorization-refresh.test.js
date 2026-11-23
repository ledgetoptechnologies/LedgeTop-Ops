'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SourceAuthorizationValidator } = require('../server/sourceAuthorization');

const SECRET = 'source-authorization-test-secret-000000000000000';
const START = 1_000_000;
const share = (expiresAt = null) => ({ id: 'share-one', modelId: 'model-one', shareClass: 'client', sourceAuthorization: { type: 'client_grant', id: 'authorization-one', version: 2, subject: 'client-subject', expiresAt } });
const json = (value, active, overrides = {}) => new Response(JSON.stringify({ active, authorizationId: value.sourceAuthorization.id, authorizationVersion: 2, subject: 'client-subject', modelId: value.modelId, expiresAt: value.sourceAuthorization.expiresAt, ...overrides }), { status: 200, headers: { 'content-type': 'application/json' } });
const turn = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let index = 0; index < 4; index += 1) await turn(); };

// Operations on a fake clock: a call is decided when it arrives (the least
// favourable moment for revocation lag) and answered latency later.
function simulation({ latency = 0, decide = () => true, value = share(), timeoutMs } = {}) {
  const sim = { at: START, calls: [], inFlight: 0, maxInFlight: 0 };
  sim.validator = new SourceAuthorizationValidator({
    enabled: true, baseUrl: 'https://incoming.example.com', keyId: 'viewer-v1', secret: SECRET, timeoutMs, now: () => sim.at, monotonic: () => sim.at - START,
    fetchImpl: () => {
      const call = { at: sim.at, due: sim.at + (typeof latency === 'function' ? latency(sim) : latency), decision: decide(sim.at, sim.calls.length) };
      sim.calls.push(call);
      sim.inFlight += 1; sim.maxInFlight = Math.max(sim.maxInFlight, sim.inFlight);
      return new Promise((resolve, reject) => { call.answer = () => {
        call.answer = null; sim.inFlight -= 1;
        if (call.decision instanceof Error) reject(call.decision);
        else resolve(typeof call.decision === 'boolean' ? json(value, call.decision) : call.decision);
      }; });
    },
  });
  sim.answerDue = async () => { for (const call of sim.calls) if (call.answer && call.due <= sim.at) call.answer(); await settle(); };
  // Resolves to a record: allowed stays undefined while the request waits.
  sim.request = async () => {
    const record = { at: sim.at };
    sim.validator.allows(value).then((allowed) => { record.allowed = allowed; record.answeredAt = sim.at; });
    await settle();
    record.waited = record.allowed === undefined;
    return record;
  };
  sim.advance = async (ms) => { sim.at += ms; await sim.answerDue(); };
  return sim;
}

test('continuous requests wait only for the first check', async () => {
  const sim = simulation({ latency: 400 }), records = [];
  for (let elapsed = 0; elapsed < 20_000; elapsed += 100) { records.push(await sim.request()); await sim.advance(100); }
  const waited = records.filter((record) => record.waited);
  assert.ok(waited.every((record) => record.at < START + 400), 'only requests during the first check wait');
  assert.ok(records.every((record) => record.allowed === true));
  assert.equal(sim.maxInFlight, 1);
  assert.ok(sim.calls.length <= 7, `one check per 3 s, not one per request (${sim.calls.length})`);
  sim.calls.slice(1).forEach((call, index) => assert.ok(call.at - sim.calls[index].at >= 3000));
});

test('a revoked share ends within five seconds at every moment and latency', async () => {
  let worst = 0;
  for (const latency of [0, 400, 1900, 2900]) {
    for (let revokeAfter = 50; revokeAfter <= 9000; revokeAfter += 450) {
      const revokedAt = START + revokeAfter, sim = simulation({ latency, decide: (at) => at < revokedAt }), records = [];
      for (let elapsed = 0; elapsed <= revokeAfter + 12_000; elapsed += 50) { records.push(await sim.request()); await sim.advance(50); }
      const last = Math.max(...records.filter((record) => record.allowed).map((record) => record.answeredAt));
      worst = Math.max(worst, last - revokedAt);
      assert.ok(last <= revokedAt + 5000, `latency ${latency}, revoked at ${revokeAfter}: still allowed ${last - revokedAt} ms later`);
      assert.ok(records.filter((record) => record.at >= revokedAt + 5000).every((record) => record.allowed !== true));
      assert.equal(sim.maxInFlight, 1);
    }
  }
  assert.ok(worst > 0 && worst <= 5000, `worst lag ${worst} ms`);
});

test('an idle share is revoked exactly at the five-second limit, with no background work', async () => {
  const sim = simulation({ decide: (at) => at === START });
  await sim.request(); await sim.answerDue();
  sim.at = START + 2999; assert.equal((await sim.request()).allowed, true);
  assert.equal(sim.calls.length, 1, 'no refresh before three seconds');
  sim.at = START + 5000;
  const record = await sim.request();
  assert.equal(record.waited, true, 'an expired allow is never served while a check runs');
  await sim.answerDue();
  assert.equal(record.allowed, false);
});

test('a refusal from the background check takes effect at once', async () => {
  for (const refusal of [false, () => json(share(), true, { modelId: 'other' }), () => new Response('gone', { status: 404 }), () => new Response('no', { status: 403 }), () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } })]) {
    const sim = simulation({ latency: 200, decide: (_at, index) => (index === 0 ? true : typeof refusal === 'function' ? refusal() : refusal) });
    const first = await sim.request(); await sim.advance(200);
    assert.equal(first.allowed, true);
    sim.at = START + 3000;
    assert.equal((await sim.request()).allowed, true, 'served while the refresh runs');
    await sim.advance(200);
    const denied = await sim.request();
    assert.equal(denied.allowed, false, 'denied long before the old allow would have expired');
    assert.equal(denied.waited, false);
    assert.equal(sim.calls.length, 2);
  }
});

test('when Operations cannot decide, access ends exactly when it did before and recovers on the next answer', async () => {
  for (const failure of [() => new Error('unreachable'), () => new Response('', { status: 503 }), () => new Response('', { status: 429 })]) {
    let failing = false;
    const sim = simulation({ latency: 20, decide: () => (failing ? failure() : true) });
    const first = await sim.request(); await sim.advance(20);
    assert.equal(first.allowed, true);
    failing = true;
    let lastAllowed = 0;
    for (let at = START + 2900; at <= START + 9000; at += 25) {
      sim.at = at; await sim.answerDue();
      const record = await sim.request();
      if (record.waited) { await sim.advance(20); at = sim.at; }
      if (record.allowed) lastAllowed = record.at;
      assert.equal(Boolean(record.allowed), record.at < START + 5000, `request at +${record.at - START}`);
    }
    assert.ok(lastAllowed >= START + 4950 && lastAllowed < START + 5000);
    assert.equal(sim.maxInFlight, 1);
    sim.calls.slice(1).forEach((call, index) => assert.ok(call.at - sim.calls[index].at >= 1000, 'failed checks are retried at most once a second'));
    failing = false;
    sim.at += 2000;
    const recovered = await sim.request(); await sim.advance(20);
    assert.equal(recovered.allowed, true);
  }
});

test('a background check that never answers is aborted and never extends access', async () => {
  let at = START, calls = 0, aborted = 0;
  const value = share(), validator = new SourceAuthorizationValidator({
    enabled: true, baseUrl: 'https://incoming.example.com', keyId: 'viewer-v1', secret: SECRET, timeoutMs: 250, now: () => at, monotonic: () => at - START,
    fetchImpl: (_url, { signal }) => {
      calls += 1;
      if (calls === 1) return Promise.resolve(json(value, true));
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted += 1; reject(signal.reason); }));
    },
  });
  assert.equal(await validator.allows(value), true);
  at = START + 4000;
  assert.equal(await validator.allows(value), true, 'served without waiting for the hung check');
  at = START + 5000;
  const started = performance.now();
  assert.equal(await validator.allows(value), false, 'joins the hung check and is denied when it is aborted');
  assert.ok(performance.now() - started < 5000);
  assert.equal(calls, 2); assert.equal(aborted, 1);
  assert.equal(validator.pending.size, 0);
});

test('a hung or aborted response body is not a decision', async () => {
  const value = share();
  let calls = 0, at = START;
  const validator = new SourceAuthorizationValidator({
    enabled: true, baseUrl: 'https://incoming.example.com', keyId: 'viewer-v1', secret: SECRET, timeoutMs: 250, now: () => at, monotonic: () => at - START,
    fetchImpl: async (_url, { signal }) => {
      calls += 1;
      if (calls === 1) return json(value, true);
      return new Response(new ReadableStream({ start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason)); } }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.equal(await validator.allows(value), true);
  at = START + 3000;
  assert.equal(await validator.allows(value), true);
  while (validator.pending.size) await new Promise((resolve) => setTimeout(resolve, 20));
  at = START + 3900;
  assert.equal(await validator.allows(value), true, 'the old allow keeps its own limit');
  at = START + 5000;
  assert.equal(await validator.allows(value), false, 'and no more than that');
});

test('concurrent requests share one refresh and one expiry check', async () => {
  for (const outcome of [true, false, new Error('unreachable')]) {
    const sim = simulation({ latency: 2500, decide: (_at, index) => (index === 0 ? true : outcome) });
    const first = await sim.request(); await sim.advance(2500);
    assert.equal(first.allowed, true);
    sim.at = START + 3000;
    const served = await Promise.all(Array.from({ length: 500 }, () => sim.validator.allows(share())));
    assert.equal(served.every(Boolean), true, 'the whole burst is served without waiting');
    assert.equal(sim.calls.length, 2);
    sim.at = START + 5000;
    const waiting = Promise.all(Array.from({ length: 500 }, () => sim.validator.allows(share())));
    await settle();
    assert.equal(sim.calls.length, 2, 'requests at the limit join the refresh that is already running');
    await sim.advance(500);
    assert.deepEqual(new Set(await waiting), new Set([outcome === true]));
    assert.equal(sim.maxInFlight, 1);
    assert.equal(sim.validator.pending.size, 0);
  }
});

test('an answer that arrives at or after its own five-second limit is no allow, for the caller and for every joiner', async () => {
  // The fetch timeout does not protect this case: the reply is already there,
  // but the process only gets to it late.
  for (const [latency, expected] of [[4999, true], [5000, false], [5400, false]]) {
    const sim = simulation({ latency });
    const caller = await sim.request();
    sim.at = START + 1000;
    const joiner = await sim.request();
    assert.equal(caller.waited && joiner.waited, true);
    sim.at = START + latency; await sim.answerDue();
    assert.equal(caller.allowed, expected, `caller at ${latency} ms`);
    assert.equal(joiner.allowed, expected, `joiner at ${latency} ms`);
    const next = await sim.request();
    if (expected) assert.equal(next.allowed, true);
    else assert.equal(next.waited, true, 'a late allow is not cached: the next request waits for a new check');
  }
});

test('a late background answer is no allow and is not cached', async () => {
  const sim = simulation({ latency: (current) => (current.calls.length ? 5200 : 0) });
  await sim.request(); await sim.answerDue();
  sim.at = START + 3000;
  assert.equal((await sim.request()).allowed, true, 'served while the refresh runs');
  sim.at = START + 5100;
  const joiner = await sim.request();
  assert.equal(joiner.waited, true);
  sim.at = START + 8200; await sim.answerDue();
  assert.equal(joiner.allowed, false, 'the joined check outlived its own limit');
  const next = await sim.request();
  assert.equal(next.waited, true);
  assert.equal(sim.maxInFlight, 1);
});

test('an allow published in time but picked up after its limit is no allow', async () => {
  let clock = 0;
  const value = share(), validator = new SourceAuthorizationValidator({ enabled: true, baseUrl: 'https://incoming.example.com', keyId: 'viewer-v1', secret: SECRET, now: () => START, monotonic: () => clock, fetchImpl: async () => json(value, true) });
  const start = validator.start.bind(validator);
  validator.start = (...args) => start(...args).then((lease) => { clock += 5000; return lease; });
  assert.equal(await validator.allows(value), false);
  validator.start = start;
  assert.equal(await validator.allows(value), true);
});

test('the source expiry still ends access, also for an allow from a background check', async () => {
  const expiresAt = new Date(START + 6000).toISOString();
  const sim = simulation({ value: share(expiresAt) });
  for (let elapsed = 0; elapsed <= 9000; elapsed += 100) {
    const record = await sim.request(); await sim.answerDue();
    assert.equal(Boolean(record.allowed), elapsed < 6000, `+${elapsed}`);
    await sim.advance(100);
  }
  assert.ok(sim.calls.length >= 2);
});

test('background checks never reject unhandled', async () => {
  const rejections = [], listen = (error) => rejections.push(error);
  process.on('unhandledRejection', listen);
  try {
    const sim = simulation({ decide: (_at, index) => (index === 0 ? true : new Error('unreachable')) });
    await sim.request(); await sim.answerDue();
    sim.at = START + 3500; await sim.request(); await sim.answerDue();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { process.off('unhandledRejection', listen); }
  assert.deepEqual(rejections, []);
});

// Wall and monotonic clocks that move independently.
function clocks({ value = share(), decide = () => true } = {}) {
  const c = { wall: START, mono: 0, calls: 0, value };
  c.validator = new SourceAuthorizationValidator({
    enabled: true, baseUrl: 'https://incoming.example.com', keyId: 'viewer-v1', secret: SECRET, now: () => c.wall, monotonic: () => c.mono,
    fetchImpl: async () => { c.calls += 1; const result = decide(c.calls); if (result instanceof Error) throw result; return json(value, result); },
  });
  c.allows = () => c.validator.allows(c.value);
  return c;
}

test('a published allow never outlives five seconds on either clock, whatever the other does', async () => {
  const wallMoves = { backwards: (ms) => START - 3_600_000 + ms, 'steadily backwards': (ms) => START - ms, 'not moving': () => START, normal: (ms) => START + ms };
  for (const [label, wall] of Object.entries(wallMoves)) {
    // Operations allows once and is unreachable afterwards, so only the first lease can allow.
    const c = clocks({ decide: (call) => (call === 1 ? true : new Error('unreachable')) });
    assert.equal(await c.allows(), true);
    for (const ms of [1, 2999, 3000, 4999]) {
      c.mono = ms; c.wall = wall(ms);
      assert.equal(await c.allows(), true, `wall ${label}, +${ms}`);
      await settle();
    }
    for (const ms of [5000, 5001, 9000, 60_000]) {
      c.mono = ms; c.wall = wall(ms);
      assert.equal(await c.allows(), false, `wall ${label}, +${ms}`);
    }
  }
  // The other way round: the monotonic clock stands still (a paused host) or
  // runs slow, and the wall clock ends the lease.
  for (const mono of [() => 0, (ms) => ms / 10]) {
    const c = clocks({ decide: (call) => (call === 1 ? true : new Error('unreachable')) });
    assert.equal(await c.allows(), true);
    for (const [ms, expected] of [[4999, true], [5000, false], [3_600_000, false]]) {
      c.wall = START + ms; c.mono = mono(ms);
      assert.equal(await c.allows(), expected, `wall +${ms}`);
      await settle();
    }
  }
});

test('wall-clock changes do not delay the background check or lengthen a denial', async () => {
  const refreshed = clocks();
  assert.equal(await refreshed.allows(), true);
  refreshed.wall -= 3_600_000; refreshed.mono = 3000;
  assert.equal(await refreshed.allows(), true); await settle();
  assert.equal(refreshed.calls, 2, 'refreshed on the monotonic age');
  refreshed.mono = 7999;
  assert.equal(await refreshed.allows(), true, 'the refreshed lease runs from its own start'); await settle();
  assert.equal(refreshed.calls, 3);

  const denied = clocks({ decide: (call) => call > 1 });
  assert.equal(await denied.allows(), false);
  denied.wall -= 3_600_000; denied.mono = 999;
  assert.equal(await denied.allows(), false); assert.equal(denied.calls, 1);
  denied.mono = 1000;
  assert.equal(await denied.allows(), true, 'a denial is remembered for one second only');
  assert.equal(denied.calls, 2);
});

test('failed background checks are retried once a second when the wall clock is set back', async () => {
  const c = clocks({ decide: (call) => (call === 1 ? true : new Error('unreachable')) });
  assert.equal(await c.allows(), true);
  c.wall -= 3_600_000;
  for (const [ms, calls] of [[3000, 2], [3999, 2], [4000, 3], [4999, 3]]) {
    c.mono = ms;
    assert.equal(await c.allows(), true); await settle();
    assert.equal(c.calls, calls, `+${ms}`);
  }
});

test('the wall-clock source expiry and the lease are both enforced', async () => {
  const value = share(new Date(START + 2000).toISOString());
  const forwards = clocks({ value });
  assert.equal(await forwards.allows(), true);
  forwards.wall = START + 1999; assert.equal(await forwards.allows(), true);
  forwards.wall = START + 2000; assert.equal(await forwards.allows(), false, 'the source has expired on the wall clock');

  const backwards = clocks({ value, decide: (call) => (call === 1 ? true : new Error('unreachable')) });
  assert.equal(await backwards.allows(), true);
  backwards.wall -= 3_600_000; backwards.mono = 1999;
  assert.equal(await backwards.allows(), true);
  backwards.mono = 2000;
  assert.equal(await backwards.allows(), false, 'setting the clock back does not lengthen the allow');
});
