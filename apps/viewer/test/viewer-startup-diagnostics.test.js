'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../public/viewer-startup-diagnostics.js'), 'utf8');
const nonce = 'a'.repeat(32);
function fixture({ topLevel = false } = {}) {
  const sent = [], listeners = new Map(), timers = new Set();
  let now = 0;
  const parent = { postMessage: (message, origin) => sent.push({ message, origin }) };
  const window = { parent, addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); } };
  if (topLevel) window.parent = window;
  const context = vm.createContext({ window, URL, performance: { now: () => now },
    setTimeout: fn => { timers.add(fn); return fn; }, clearTimeout: fn => timers.delete(fn) });
  vm.runInContext(source, context);
  return { window, parent, sent, listeners, timers,
    mark: (...args) => window.__ltdsViewerStartupDiagnostics?.mark(...args),
    advance: ms => { now += ms; }, expire: () => { for (const fn of [...timers]) fn(); },
    probe: (overrides = {}) => listeners.get('message')?.({ source: parent, origin: 'https://portal.example',
      data: { version: 1, type: 'ltds-viewer:startup-probe', nonce }, ...overrides }),
  };
}
test('pre-probe history replays once, binds exact target origin, then streams bounded phases', () => {
  const f = fixture();
  f.mark('module-started');
  f.probe();
  assert.deepEqual(f.sent.map(x => x.message.phase), ['shell-loaded', 'module-started']);
  f.probe();
  f.probe({ origin: 'https://other.example' });
  f.probe({ data: { version: 1, type: 'ltds-viewer:startup-probe', nonce: 'b'.repeat(32) } });
  assert.equal(f.sent.length, 2);
  f.mark('redeem-http', 403);
  assert.equal(f.sent[2].message.status, 403);
  assert.equal(f.sent[2].message.sequence, 3);
  assert.ok(f.sent.every(x => x.origin === 'https://portal.example' && x.message.nonce === nonce));
});
test('rejects wrong source, opaque/non-HTTPS/noncanonical origins and invalid or extra probe fields', () => {
  const f = fixture();
  for (const override of [{ source: {} }, ...['null', '', 'http://portal.example', 'https://portal.example/path',
    'https://portal.example/', 'https://user@portal.example', 'https://portal.example:443'].map(origin => ({ origin })),
    ...[null, [], {}, { version: 1, type: 'ltds-viewer:startup-probe', nonce, token: 'secret' },
      { version: 2, type: 'ltds-viewer:startup-probe', nonce },
      { version: 1, type: 'ltds-viewer:startup-probe', nonce: nonce.toUpperCase() },
      { version: 1, type: 'ltds-viewer:ready', nonce }].map(data => ({ data }))]) f.probe(override);
  assert.equal(f.sent.length, 0);
  f.probe();
  assert.equal(f.sent.length, 1, 'invalid messages cannot seize the binding');
});
test('fixed TTL expires before a delayed probe or phase and removes handler/history', () => {
  for (const bound of [false, true]) {
    const f = fixture();
    if (bound) f.probe();
    f.advance(59_999); f.probe();
    const before = f.sent.length;
    f.advance(1); f.mark('bootstrap-failed'); f.probe();
    assert.equal(f.sent.length, before);
    assert.equal(f.listeners.size, 0);
    assert.equal(f.timers.size, 0);
  }
  const f = fixture(); f.expire(); f.probe();
  assert.equal(f.sent.length, 0);
});
test('caps messages at sixteen and projects only allowlisted enums/status with no raw input', () => {
  const f = fixture(); f.probe();
  f.mark('https://secret.example/token');
  f.mark({ error: 'secret' });
  f.mark('redeem-http', 'secret');
  f.mark('module-started', 'secret');
  for (let i = 0; i < 100; i++) f.mark('bootstrap-failed', { token: 'secret' });
  assert.equal(f.sent.length, 16);
  assert.equal(f.sent[1].message.status, 'other');
  assert.equal(f.sent[2].message.status, undefined);
  assert.equal(JSON.stringify(f.sent).includes('secret'), false);
  for (const [i, { message }] of f.sent.entries()) {
    assert.equal(message.sequence, i + 1);
    assert.equal(Object.keys(message).sort().join(','),
      message.phase === 'redeem-http' ? 'nonce,phase,sequence,status,type,version' : 'nonce,phase,sequence,type,version');
  }
});
test('top-level viewers install no channel; reply failure never interrupts startup', () => {
  const top = fixture({ topLevel: true });
  assert.equal(top.window.__ltdsViewerStartupDiagnostics, undefined);
  assert.equal(top.listeners.size, 0);
  const f = fixture(); f.parent.postMessage = () => { throw new Error('closed'); };
  assert.doesNotThrow(() => { f.probe(); f.mark('module-started'); });
});
test('classic shell script precedes the module and built output preserves its independent asset', () => {
  for (const file of ['index.html', 'dist/index.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const classic = html.indexOf('<script src="/viewer-startup-diagnostics.js"></script>');
    assert.ok(classic >= 0 && classic < html.indexOf('<script type="module"'), file);
  }
  assert.equal(fs.readFileSync(path.join(__dirname, '../dist/viewer-startup-diagnostics.js'), 'utf8'), source);
});
