import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewerStartupDiagnostics, VIEWER_DIAGNOSTICS_TTL_MS } from '../packages/ui/src/viewer-startup-diagnostics.ts';

const origin = 'https://viewer.ledgetopdroneservices.com';
const nonce = '0123456789abcdef0123456789abcdef';
function fixture() {
  let time = 1000;
  const sent = [], snapshots = [], timers = new Map();
  let nextTimer = 0;
  const target = { postMessage: (...args) => sent.push(args) };
  let current = target;
  const controller = createViewerStartupDiagnostics({ origin, nonce, source: () => current, now: () => time, onChange: value => snapshots.push(value),
    setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer: id => timers.delete(id),
  });
  const message = (phase = 'shell-loaded', sequence = 1, extra = {}) => ({ origin, source: target,
    data: { version: 1, type: 'ltds-viewer:startup-phase', nonce, phase, sequence, ...extra } });
  const tick = value => {
    while (true) {
      const due = [...timers].filter(([, timer]) => timer.at <= value).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      time = due[1].at; timers.delete(due[0]); due[1].callback();
    }
    time = value;
  };
  return { controller, sent, snapshots, target, message, timers, tick,
    time: value => { time = value; }, source: value => { current = value; } };
}

test('startup schedules independent probes at fixed offsets once within the existing four-send budget', () => {
  const f = fixture();
  f.controller.startProbes(); f.controller.startProbes();
  assert.equal(f.sent.length, 1);
  assert.equal(f.timers.size, 3);
  f.tick(1999); assert.equal(f.sent.length, 1);
  f.tick(2000); assert.equal(f.sent.length, 2);
  f.tick(6000); assert.equal(f.sent.length, 3);
  f.tick(21000); assert.equal(f.sent.length, 4);
  assert.equal(f.timers.size, 0);
  assert.equal(f.controller.probe(), false);
  const loaded = fixture(); loaded.controller.startProbes(); loaded.controller.frameLoaded(); loaded.controller.probe();
  loaded.tick(21000);
  assert.equal(loaded.sent.length, 4, 'onLoad and timed probes share one cap');
});

test('the first validated child reply cancels timers without accepting ready or sending any new authority', () => {
  const f = fixture(); f.controller.startProbes();
  assert.equal(f.controller.receive({ ...f.message(), origin: 'https://wrong.example' }), false);
  assert.equal(f.timers.size, 3, 'spoofed messages cannot stop the diagnostic schedule');
  assert.equal(f.controller.receive(f.message()), true);
  assert.equal(f.timers.size, 0);
  f.tick(21000);
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.controller.snapshot().stages, ['shell-loaded']);
  assert.ok(f.sent.every(([data]) => data.type === 'ltds-viewer:startup-probe' && Object.keys(data).sort().join(',') === 'nonce,type,version'));
});

test('close, replacement document and fixed expiry cancel remaining timers permanently', () => {
  for (const reason of ['unmount-or-source-change', 'reload', 'expiry', 'rollback']) {
    const f = fixture(); f.controller.startProbes();
    if (reason === 'unmount-or-source-change') f.controller.close();
    if (reason === 'reload') { f.controller.frameLoaded(); f.controller.frameLoaded(); }
    if (reason === 'expiry') { f.time(1000 + VIEWER_DIAGNOSTICS_TTL_MS); f.controller.probe(); }
    if (reason === 'rollback') { f.time(999); f.controller.probe(); }
    assert.equal(f.timers.size, 0, reason);
    f.tick(1000 + VIEWER_DIAGNOSTICS_TTL_MS + 1);
    assert.equal(f.sent.length, 1, reason);
    assert.equal(f.controller.receive(f.message()), false, reason);
  }
});

test('probes target only the exact bound Viewer; no URL, grant or identity is transmitted', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) assert.equal(f.controller.probe(), true);
  assert.equal(f.controller.probe(), false);
  assert.deepEqual(f.sent, Array.from({ length: 4 }, () => [{ version: 1, type: 'ltds-viewer:startup-probe', nonce }, origin]));
});

test('only exact origin, frame Window and nonce can contribute diagnostics', () => {
  const f = fixture();
  for (const event of [
    { ...f.message(), origin: 'https://viewer.ledgetopdroneservices.com.evil.test' },
    { ...f.message(), source: {} }, { ...f.message(), source: null },
    f.message('shell-loaded', 1, { nonce: 'a'.repeat(32) }),
  ]) assert.equal(f.controller.receive(event), false);
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.controller.receive(f.message()), true);
  f.source({});
  assert.equal(f.controller.receive(f.message('module-started', 2)), false);
});

test('unknown fields, arbitrary text/status and malformed sequence never enter snapshots', () => {
  const f = fixture();
  for (const data of [null, [], {}, 'secret',
    f.message('shell-loaded', 1, { url: 'https://example.test/private' }).data,
    f.message('shell-loaded', 1, { status: 200 }).data,
    f.message('redeem-http', 1, { status: 418 }).data,
    f.message('redeem-http', 1, { status: '401' }).data,
    f.message('unrecognized', 1).data,
    ...[0, -1, 1.5, 17, NaN, '1'].map(sequence => f.message('shell-loaded', sequence).data),
  ]) assert.equal(f.controller.receive({ ...f.message(), data }), false);
  assert.equal(f.snapshots.length, 0);
});

test('bounded monotonic milestones retain no message object or capability', () => {
  const f = fixture();
  const event = f.message('redeem-http', 3, { status: 403 });
  assert.equal(f.controller.receive(event), true);
  event.data.status = 200;
  assert.deepEqual(f.controller.snapshot(), { phase: 'redeem-http', sequence: 3, frameLoads: 0, status: 403, stages: ['redeem-http:403'] });
  assert.equal(Object.isFrozen(f.controller.snapshot()), true);
  assert.equal(f.controller.receive(f.message('module-started', 2)), false);
  assert.equal(f.controller.receive(f.message('redeem-http', 3, { status: 200 })), false);
  assert.equal(f.controller.receive(f.message('session-applied', 4)), true);
  assert.equal(f.controller.snapshot().status, 403);
  assert.deepEqual(f.controller.snapshot().stages, ['redeem-http:403', 'session-applied']);
  assert.equal(Object.isFrozen(f.controller.snapshot().stages), true);
  for (let sequence = 5; sequence <= 16; sequence++) assert.equal(f.controller.receive(f.message('ready-sent', sequence)), true);
  assert.equal(f.controller.receive(f.message('ready-sent', 17)), false);
});

test('TTL is fixed, cannot be extended by probes, and clock rollback fails closed', () => {
  const f = fixture();
  f.time(1000 + VIEWER_DIAGNOSTICS_TTL_MS - 1);
  assert.equal(f.controller.probe(), true);
  assert.equal(f.controller.receive(f.message()), true);
  f.time(1000 + VIEWER_DIAGNOSTICS_TTL_MS);
  assert.equal(f.controller.probe(), false);
  assert.equal(f.controller.receive(f.message('module-started', 2)), false);
  f.time(999);
  assert.equal(f.controller.receive(f.message('module-started', 2)), false);
});

test('frame loads are bounded, closure prevents subsequent events and probes', () => {
  const f = fixture();
  f.controller.frameLoaded();
  assert.equal(f.controller.receive(f.message('ready-sent', 7)), true);
  for (let i = 0; i < 25; i++) f.controller.frameLoaded();
  assert.deepEqual(f.controller.snapshot(), { phase: 'frame-reloaded', sequence: 7, frameLoads: 2, stages: ['ready-sent'] });
  assert.equal(f.controller.receive(f.message('shell-loaded', 1)), false);
  assert.equal(f.controller.receive(f.message('ready-sent', 8)), false);
  f.controller.close();
  assert.equal(f.controller.probe(), false);
  assert.equal(f.controller.receive(f.message()), false);
  const count = f.snapshots.length;
  f.controller.frameLoaded();
  assert.equal(f.snapshots.length, count);
});

test('postMessage failure stays optional and consumes the bounded probe budget', () => {
  const f = fixture();
  f.target.postMessage = () => { throw new Error('closed window'); };
  for (let i = 0; i < 5; i++) assert.equal(f.controller.probe(), false);
  assert.deepEqual(f.controller.snapshot(), { phase: 'awaiting-shell', sequence: 0, frameLoads: 0, stages: [] });
});

test('unsafe origin and invalid nonce configuration refuse before probing', () => {
  for (const badOrigin of ['http://viewer.test', 'https://viewer.test/path', 'https://viewer.test/'])
    assert.throws(() => createViewerStartupDiagnostics({ origin: badOrigin, nonce, source: () => null, onChange() {} }));
  for (const badNonce of ['', 'a'.repeat(31), 'A'.repeat(32)])
    assert.throws(() => createViewerStartupDiagnostics({ origin, nonce: badNonce, source: () => null, onChange() {} }));
});
