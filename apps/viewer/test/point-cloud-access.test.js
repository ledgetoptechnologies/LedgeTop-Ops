'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { installPointCloudAccess } = require('../public/pointcloud-access.js');

function fixture() {
  const timers = new Set(), calls = [], events = [];
  let live = false;
  const win = {
    location: { origin: 'https://viewer.example', href: 'https://viewer.example/pointcloud.html' },
    fetch: async (input, init) => { calls.push({ input, init }); return { status: live ? 200 : 403 }; },
    setTimeout: fn => { timers.add(fn); return fn; },
    clearTimeout: fn => timers.delete(fn),
  };
  const access = installPointCloudAccess({ window: win, eptUrl: '/session-assets/scoped/model/cloud/ept.json',
    onRequired: () => events.push('required'), onRestored: () => events.push('restored'),
    onUnavailable: () => events.push('unavailable') });
  return { win, access, timers, calls, events, setLive: () => { live = true; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('old EPT response arriving after renewal retries current capability once without another grant', async () => {
  const f = fixture();
  f.access.dispose();
  let deliver;
  const calls = [], events = [], options = { signal: new AbortController().signal };
  f.win.fetch = async (input, init) => {
    calls.push({ input, init });
    return calls.length === 1 ? new Promise(resolve => { deliver = resolve; }) : { status: 200 };
  };
  const access = installPointCloudAccess({ window: f.win, eptUrl: '/session-assets/scoped/model/cloud/ept.json',
    onRequired: () => events.push('required'), onUnavailable: () => events.push('unavailable') });
  const pending = f.win.fetch('/session-assets/scoped/model/cloud/ept-data/0-0-0-0.laz', options);
  access.renewed('/session-assets/fresh/model/cloud/ept.json');
  deliver({ status: 403 });
  assert.equal((await pending).status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].input, 'https://viewer.example/session-assets/fresh/model/cloud/ept-data/0-0-0-0.laz');
  assert.equal(calls[1].init, options);
  assert.deepEqual(events, []);
});

test('disposed EPT wrapper never retries a late denial after renewal', async () => {
  const f = fixture(); f.access.dispose();
  let deliver, calls = 0;
  f.win.fetch = () => { calls += 1; return new Promise(resolve => { deliver = resolve; }); };
  const access = installPointCloudAccess({ window: f.win, eptUrl: '/session-assets/scoped/model/cloud/ept.json' });
  const pending = f.win.fetch('/session-assets/scoped/model/cloud/ept.json');
  access.renewed(); access.dispose(); deliver({ status: 403 });
  assert.equal((await pending).status, 403);
  assert.equal(calls, 1);
});

test('concurrent EPT metadata/hierarchy/LAZ denial waits for a grant and retries each GET once', async () => {
  const f = fixture();
  const pending = ['ept.json', 'ept-hierarchy/0-0-0-0.json', 'ept-data/0-0-0-0.laz']
    .map(suffix => f.win.fetch(`/session-assets/scoped/model/cloud/${suffix}`));
  await tick();
  assert.deepEqual(f.events, ['required']);
  assert.equal(f.calls.length, 3);
  assert.equal(f.timers.size, 1);
  f.setLive();
  f.access.renewed();
  assert.deepEqual((await Promise.all(pending)).map(response => response.status), [200, 200, 200]);
  assert.equal(f.calls.length, 6);
  assert.deepEqual(f.events, ['required', 'restored']);
  assert.equal(f.timers.size, 0);
});

test('unrelated requests and mutations cannot trigger an EPT renewal', async () => {
  const f = fixture();
  for (const [input, init] of [
    ['/api/v1/admin-sessions/current'], ['https://other.example/session-assets/scoped/model/cloud/ept.json'],
    ['/session-assets/scoped/model/other/ept.json'], ['/session-assets/scoped/model/cloud/ept.json', { method: 'POST' }],
  ]) assert.equal((await f.win.fetch(input, init)).status, 403);
  assert.deepEqual(f.events, []);
});

test('unavailable authorization releases pending requests without retrying or hiding the failure', async () => {
  const f = fixture();
  const request = f.win.fetch('/session-assets/scoped/model/cloud/ept.json');
  await tick();
  [...f.timers][0]();
  assert.equal((await request).status, 403);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.events, ['required', 'unavailable']);
});

test('a denied retry remains terminal and cannot create an automatic grant loop', async () => {
  const f = fixture();
  const request = f.win.fetch('/session-assets/scoped/model/cloud/ept.json');
  await tick();
  f.access.renewed();
  assert.equal((await request).status, 403);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.events, ['required', 'restored', 'unavailable']);
});

test('aborting one waiting node prevents its retry after renewal', async () => {
  const f = fixture();
  const abort = new AbortController();
  const request = f.win.fetch('/session-assets/scoped/model/cloud/ept.json', { signal: abort.signal });
  await tick();
  abort.abort();
  await assert.rejects(request, { name: 'AbortError' });
  f.setLive();
  f.access.renewed();
  assert.equal(f.calls.length, 1);
});

test('renewal updates cached EPT capability roots for retried and future child requests', async () => {
  const f = fixture();
  const request = f.win.fetch('/session-assets/scoped/model/cloud/ept-data/0-0-0-0.laz');
  await tick();
  f.setLive();
  f.access.renewed('/session-assets/fresh/model/cloud/ept.json');
  assert.equal((await request).status, 200);
  await f.win.fetch('/session-assets/scoped/model/cloud/ept-hierarchy/1-0-0-0.json');
  assert.equal(f.calls[1].input, 'https://viewer.example/session-assets/fresh/model/cloud/ept-data/0-0-0-0.laz');
  assert.equal(f.calls[2].input, 'https://viewer.example/session-assets/fresh/model/cloud/ept-hierarchy/1-0-0-0.json');
});
