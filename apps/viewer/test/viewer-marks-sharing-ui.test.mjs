import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from './browser-launch.mjs';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';
import { waitForDevToolsPort } from './devtools-port.mjs';
import { BoundedTestCdp as Cdp } from './bounded-test-cdp.mjs';
import { openMarksPanel } from './helpers/marks-panel.mjs';
import express from 'express';
import api from '../server/viewerMarkApi.js';
import { sharedViewerConfig } from '../server/shareApi.js';
import { measurementAssetBearer } from '../measurement-surface-client.mjs';

const mark = (name, extra = {}) => ({ name, note: '', geometry: { type: 'Point', coordinates: [-87, 43] }, categoryId: null,
  color: '#1e88e5', icon: 'pin', elevationNavd88M: null, ...extra });
const visible = node => Boolean(node && !node.hidden && (!node.parent || visible(node.parent)));
const change = async (p, value) => { p.q('[name=visibility]').value = value; await p.q('[name=visibility]').fire('change'); };

function marksPage(p, values = {}) {
  const source = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  let pending, admitted;
  const context = vm.createContext({ viewerMarks: { setScope: (next, options) => {
    admitted = { next, options }; return pending = p.marks.setScope(next, options);
  } }, PROJECT: { id: 'synthetic-model', activeVersion: { id: 'synthetic-v1' } },
  SHARE_PERMISSIONS: { view: true, measure: true }, VIEW_MODE: 'session', SHARE_TOKEN: 'opaque-link-token',
  measurementAssetBearer: value => measurementAssetBearer(value, 'https://viewer.example'),
  activeViewerSession: null, sessionStorageKey: 'synthetic-key', sessionCapabilities: { read: () => null },
  sessionAccessState: 'active', sessionAccessReason: null, ...values });
  vm.runInContext(source.slice(source.indexOf('function syncViewerMarks()'), source.indexOf('function syncViewerMarksView()')), context);
  return { context, async sync(values = {}) { Object.assign(context, values); context.syncViewerMarks(); await pending; return admitted; } };
}

test('page admits a verified view-only client, clears measured drafts and resets denied or expired access', async t => {
  const f = await openMarksPanel(t), staff = f.mount(), p = f.mount();
  t.after(() => { staff.marks.dispose(); p.marks.dispose(); });
  await staff.marks.setScope(f.scope('ops', 'staff'));
  await staff.store.create(mark('Shared', { visibility: 'shared', access: 'edit' }));
  const page = marksPage(p);
  const accept = async (permissions, subject = 'client-a', extra = {}) => {
    const scope = f.scope('client', subject, { permissions });
    return page.sync({ SHARE_PERMISSIONS: permissions, sessionCapabilities: { read: scope.token },
      activeViewerSession: { audience: 'client', subject, permissions, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...extra } });
  };
  const full = { view: true, measure: true, personalMeasurements: true };
  await accept(full);
  await p.place('43, -87'); await p.type('[name=name]', 'Measured draft');
  const key = page.context.activeViewerSession.subject;
  await accept(full);
  assert.equal(p.q('[name=name]').value, 'Measured draft', 'ordinary renewal keeps typing');
  f.requests.length = 0;
  const admitted = await accept({ ...full, measure: false });
  assert.ok(admitted.next);
  assert.equal(admitted.options.keepDraft, false);
  assert.deepEqual(f.requests, [['GET', '/api/v1/marks'], ['GET', '/api/v1/marks/shared']]);
  assert.equal(p.store.canWrite(), false);
  assert.doesNotMatch(p.values(), /Measured draft/);
  assert.equal(p.dom.window.sessionStorage.items.size, 0);
  await p.show('Shared');
  for (const label of ['Edit', 'Move', 'Delete', 'History']) assert.equal(visible(p.card(label)), false);
  assert.equal(p.marks.mapContextMenu({ lat: 43, lng: -87 }), false);
  assert.equal(page.context.activeViewerSession.subject, key);
  await accept(full);
  assert.doesNotMatch(p.values(), /Measured draft/);
  await p.place('43, -87'); await p.type('[name=name]', 'Other identity draft');
  await accept(full, 'client-b');
  assert.doesNotMatch(p.values(), /Other identity draft/);
  for (const [permissions, extra] of [[{ ...full, view: false }, {}], [full, { expiresAt: '2000-01-01T00:00:00Z' }]]) {
    f.requests.length = 0;
    assert.equal((await accept(permissions, 'client-b', extra)).next, null);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(p.store.state.marks, []);
    assert.equal(visible(p.q('.viewer-mark-add')), false);
  }
});

test('staff sharing choices default to edit and preserve existing view access until explicitly changed', async t => {
  const f = await openMarksPanel(t), p = f.mount();
  t.after(() => p.marks.dispose());
  await p.marks.setScope(f.scope('ops', 'staff-a'));
  await p.place('43, -87');
  assert.deepEqual(p.q('[name=visibility]').children.map(o => o.textContent), ['Shared, client can edit', 'Shared, view only', 'Only me']);
  assert.equal(p.q('[name=visibility]').value, 'shared');
  await p.type('[name=name]', 'Default'); await p.save();
  assert.equal(p.store.state.marks[0].access, 'edit');
  await p.open('Default'); await change(p, 'shared-view'); await p.save();
  assert.equal(p.store.state.marks[0].access, 'view');
  await p.open('Default'); await p.type('[name=note]', 'Retained'); await p.save();
  assert.equal(p.store.state.marks[0].access, 'view');
  await p.open('Default'); await change(p, 'private'); await p.save();
  assert.equal(p.store.state.marks[0].visibility, 'private');
});

test('client can edit shared content but cannot delete or control staff sharing; view-only and write=false hide actions', async t => {
  const f = await openMarksPanel(t), staff = f.mount(), client = f.mount();
  t.after(() => { staff.marks.dispose(); client.marks.dispose(); });
  await staff.marks.setScope(f.scope('ops', 'staff-a'));
  await staff.store.create(mark('Editable', { visibility: 'shared', access: 'edit' }));
  await staff.store.create(mark('Read only', { visibility: 'shared', access: 'view' }));
  await client.marks.setScope(f.scope('client', 'client-a'));
  await client.show('Editable');
  assert.equal(visible(client.card('Edit')), true);
  assert.equal(visible(client.card('Delete')), false);
  await client.card('Edit').click();
  assert.equal(visible(client.q('[name=visibility]')), false);
  await client.type('[name=note]', 'Client changed'); await client.save();
  assert.equal(client.store.state.marks.find(m => m.name === 'Editable').access, 'edit');
  await client.show('Read only');
  assert.equal(visible(client.card('Edit')), false);
  const viewOnly = f.scope('client', 'client-a', { permissions: { view: true, measure: false, personalMeasurements: true } });
  await client.marks.setScope({ ...viewOnly, key: `${viewOnly.key}:view-only` });
  await client.show('Editable');
  assert.equal(visible(client.card('Edit')), false);
  assert.equal(visible(client.card('Delete')), false);
});

test('shareAll uses actual capability and only existing eligible owned marks, preserving already shared access', async t => {
  const f = await openMarksPanel(t), p = f.mount(), other = f.mount();
  t.after(() => { p.marks.dispose(); other.marks.dispose(); });
  await p.marks.setScope(f.scope('ops', 'staff-a'));
  const privateMark = await p.store.create(mark('Private', { visibility: 'private' }));
  await p.store.create(mark('View', { visibility: 'shared', access: 'view' }));
  await other.marks.setScope(f.scope('ops', 'staff-b'));
  await other.store.create(mark('Other', { visibility: 'private' }));
  await p.q('.viewer-mark-layers').click();
  assert.equal(visible(p.button('Share all')), true);
  f.requests.length = 0;
  await p.button('Share all').click();
  assert.deepEqual(f.requests, [], 'nothing is sent before the question is answered');
  await p.confirm();
  assert.equal(p.store.find(privateMark.id).access, 'edit');
  assert.equal(p.store.state.marks.find(m => m.name === 'View').access, 'view');
  assert.deepEqual(f.requests, [['POST', '/api/v1/marks/batch/share']]);
  assert.equal(p.button('Share all').hidden, true);
  await p.marks.setScope(f.scope('client', 'client-a'));
  assert.equal(visible(p.button('Share all')), false);
});

test('history is newest first, shows client changes, and restores selected content through revert', async t => {
  const f = await openMarksPanel(t), staff = f.mount(), client = f.mount();
  t.after(() => { staff.marks.dispose(); client.marks.dispose(); });
  await staff.marks.setScope(f.scope('ops', 'staff-a'));
  const original = await staff.store.create(mark('Original', { visibility: 'shared', access: 'edit' }));
  await client.marks.setScope(f.scope('client', 'client-a'));
  await client.open('Original'); await client.type('[name=name]', 'Client edit'); await client.save();
  await client.open('Client edit'); await client.type('[name=note]', 'Second edit'); await client.save();
  await staff.store.refresh(); await staff.show('Client edit');
  assert.match(staff.q('.viewer-mark-view').textContent, /Changed by a client/);
  await staff.card('History').click();
  const rows = staff.q('.viewer-mark-history').children;
  assert.deepEqual(rows.map(r => r.querySelector('button').getAttribute('data-revert-revision')), ['2', '1']);
  f.requests.length = 0;
  await rows[1].querySelector('button').click();
  assert.equal(staff.store.find(original.id).name, 'Original');
  assert.equal(staff.store.find(original.id).access, 'edit');
  assert.equal(f.requests[0][0], 'POST'); assert.match(f.requests[0][1], /\/revert$/);
  await client.show('Client edit');
  assert.equal(visible(client.card('History')), false);
});

for (const mode of ['view', 'embed', 'project']) test(`public ${mode} scope reads shared marks with held page token and is read-only`, async t => {
  const f = await openMarksPanel(t);
  const staff = f.mount();
  t.after(() => staff.marks.dispose());
  await staff.marks.setScope(f.scope('ops', 'staff'));
  await staff.store.create(mark('Public shared', { visibility: 'shared', note: 'Staff-only note' }));
  const model = { id: 'synthetic-model', status: 'ready', metadata: {}, activeVersion: { id: 'synthetic-v1', status: 'ready',
    assets: [{ id: 'ortho', kind: 'ortho', relativePath: 'ortho.tif' }] } };
  const share = { id: 'synthetic-share', modelId: model.id, permissions: { view: true, measure: false, marks: true }, authorizationRevision: 0 };
  // Use the real page config signer, resolver and Marks routes, not synthetic responses.
  const cfg = { ...sharedViewerConfig(model, share), permissions: share.permissions };
  const app = express();
  app.use('/api/v1/marks', api.createViewerMarkApi({ database: f.database, rateLimited: () => false,
    getModel: () => model, getPublicShare: () => share, publicShareLive: () => true }));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const calls = [], signed = measurementAssetBearer(cfg.assets.ortho, 'https://viewer.example');
  assert.ok(signed);
  const p = f.mount({ request: async (url, init) => {
    calls.push([init.method, new URL(url).pathname]);
    assert.equal(init.headers.authorization === 'Bearer ' + signed, true);
    const response = await fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, init);
    assert.equal(response.status, 200);
    return response;
  } });
  t.after(() => p.marks.dispose());
  const page = marksPage(p, { PROJECT: cfg, SHARE_PERMISSIONS: cfg.permissions, VIEW_MODE: mode });
  await page.sync();
  assert.deepEqual(calls, [['GET', '/api/v1/marks'], ['GET', '/api/v1/marks/shared']]);
  assert.equal(p.store.canWrite(), false);
  await p.show('Public shared');
  assert.equal(p.q('.viewer-mark-card-note').hidden, true);
  assert.equal(p.store.state.marks[0].note, undefined);
  for (const label of ['Edit', 'Move', 'Delete', 'History']) assert.equal(visible(p.card(label)), false);
  assert.equal(visible(p.q('.viewer-mark-add')), false);
  assert.equal(p.marks.mapContextMenu({ lat: 43, lng: -87 }), false);
  assert.equal(p.marks.mapClick({ lat: 43, lng: -87 }), false);
  assert.equal(p.dom.window.sessionStorage.items.size, 0);
  assert.equal([...p.dom.window.localStorage.items.values()].some(v => v.includes(signed)), false);
  assert.equal(calls.every(([method]) => method === 'GET'), true);
  for (const permissions of [{ view: true, measure: true }, { view: true, marks: false }, { view: false, marks: true }]) {
    calls.length = 0;
    assert.equal((await page.sync({ SHARE_PERMISSIONS: permissions })).next, null);
    assert.deepEqual(calls, []);
    assert.deepEqual(p.store.state.marks, []);
  }
});

test('staff can manage a colleague shared mark, while history and Share all remain capability-gated', async t => {
  const f = await openMarksPanel(t), owner = f.mount(), colleague = f.mount();
  t.after(() => { owner.marks.dispose(); colleague.marks.dispose(); });
  await owner.marks.setScope(f.scope('ops', 'owner'));
  const shared = await owner.store.create(mark('Colleague mark', { visibility: 'shared', access: 'view' }));
  const scope = f.scope('ops', 'colleague');
  await colleague.marks.setScope(scope);
  await colleague.open('Colleague mark');
  // Sharing is the owner's: the control is not offered on a colleague's mark.
  assert.equal(visible(colleague.q('[name=visibility]')), false);
  await colleague.type('[name=note]', 'Staff edit'); await colleague.save();
  assert.equal(colleague.store.find(shared.id).access, 'view');
  assert.equal(visible(colleague.card('Delete')), true);
  const limited = f.mount({ request: async (url, init) => {
    const response = await fetch(url, init);
    if (!url.endsWith('/api/v1/marks')) return response;
    const data = await response.json();
    data.capabilities.history = false; data.capabilities.shareAll = false;
    return Response.json(data);
  } });
  t.after(() => limited.marks.dispose());
  await limited.marks.setScope(scope);
  await limited.store.create(mark('Not shared', { visibility: 'private' }));
  await limited.show('Colleague mark');
  assert.equal(visible(limited.card('History')), false);
  assert.equal(visible(limited.button('Share all')), false);
});

test('history and revert failures retain the current mark and expose the store warning', async t => {
  const f = await openMarksPanel(t);
  let refused = 'history';
  const p = f.mount({ request: (url, init) => url.endsWith('/' + refused)
    ? Promise.resolve(Response.json({ code: 'mark_rate_limited' }, { status: 429 })) : fetch(url, init) });
  t.after(() => p.marks.dispose());
  await p.marks.setScope(f.scope('ops', 'staff-a'));
  const current = await p.store.create(mark('Original', { visibility: 'shared', access: 'edit' }));
  await p.store.update(current, { name: 'Current' });
  await p.show('Current'); await p.card('History').click();
  assert.match(p.text(), /Too many requests/);
  assert.equal(p.q('.viewer-mark-history').hidden, true);
  refused = 'revert';
  await p.card('History').click();
  await p.q('[data-revert-revision="1"]').click();
  assert.equal(p.store.find(current.id).name, 'Current');
  assert.match(p.text(), /Too many requests/);
  assert.equal(p.q('.viewer-mark-history').hidden, false);
});

test('shareAll failure does not claim sharing succeeded or hide the retry action', async t => {
  const f = await openMarksPanel(t), p = f.mount({ request: (url, init) => url.endsWith('/batch/share')
    ? Promise.resolve(Response.json({ code: 'mark_rate_limited' }, { status: 429 })) : fetch(url, init) });
  t.after(() => p.marks.dispose());
  await p.marks.setScope(f.scope('ops', 'staff-a'));
  const current = await p.store.create(mark('Private', { visibility: 'private' }));
  await p.q('.viewer-mark-layers').click(); await p.button('Share all').click(); await p.confirm();
  assert.equal(p.store.find(current.id).visibility, 'private');
  assert.match(p.text(), /Too many requests/);
  assert.match(p.q('.viewer-mark-job').textContent, /0 of 1 changed/);
  assert.equal(visible(p.button('Resume')), true);
  assert.equal(visible(p.button('Share all')), true);
  assert.equal(p.button('Share all').disabled, true, 'the stopped job is resumed or closed first');
  await p.q('[aria-label="Close sharing status"]').click();
  assert.equal(p.button('Share all').disabled, false);
});

test('Chromium: staff Share all/history/revert and model-wide phone navigation, then synthetic public read-only UI', { timeout: 90_000 }, async t => {
  const binary = process.env.CHROME_PATH || ['/usr/bin/chromium', '/snap/bin/chromium', '/usr/bin/google-chrome'].find(p => fs.existsSync(p));
  assert.ok(binary, 'Chromium is required for this focused acceptance test');
  const root = fileURLToPath(new URL('../', import.meta.url));
  const f = await openMarksPanel(t), seed = f.mount(), client = f.mount();
  t.after(() => { seed.marks.dispose(); client.marks.dispose(); });
  const scope = f.scope('ops', 'browser-staff');
  await seed.marks.setScope(scope);
  const original = await seed.store.create(mark('Staff original', { visibility: 'shared', access: 'edit' }));
  await seed.store.create(mark('Unshared', { visibility: 'private' }));
  await client.marks.setScope(f.scope('client', 'browser-client'));
  await client.store.update(client.store.find(original.id), { name: 'Client changed' });
  const style = fs.readFileSync(path.join(root, 'index.html'), 'utf8').match(/<style>[\s\S]*?<\/style>/)[0];
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/node_modules/leaflet/dist/leaflet.css">${style}</head><body>
    <div id="viewer-wrap" style="height:100vh;width:100vw"><div id="leaflet-map" style="display:block;height:100%"></div><div id="viewer-marks-ui"></div></div><div id="panel-marks"></div>
    <script type="module">
    import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';
    import { mountViewerMarks } from '/viewer-marks.mjs';
    const map = L.map('leaflet-map').setView([43, -87], 18);
    window.marks = mountViewerMarks({ panel: document.querySelector('#panel-marks'), overlay: document.querySelector('#viewer-marks-ui'), L, getMap: () => map });
    marks.setView({ map: true });
    await marks.setScope({ mode: 'session', key: 'synthetic-staff', token: () => ${JSON.stringify(scope.token())} });
    window.publicRead = async () => {
      marks.dispose();
      window.reads = [];
      window.marks = mountViewerMarks({ panel: document.querySelector('#panel-marks'), overlay: document.querySelector('#viewer-marks-ui'), L, getMap: () => map,
        request: async (url, init) => { reads.push([init.method, url]); return Response.json(url.endsWith('/shared') ?
          { marks: [{ ...${JSON.stringify(mark('Public shared'))}, id: 'public-id', visibility: 'shared', access: 'view', editable: false, deletable: false, mine: false }], categories: [], next: null } :
          { marks: [], categories: [], capabilities: { write: false, staff: false, visibility: ['private'], shared: true } }); } });
      marks.setView({ map: true }); await marks.setScope({ mode: 'session', key: 'synthetic-public', readOnly: true, token: () => 'synthetic.page' });
    };
    window.ready = true;
    </script></body></html>`;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname.startsWith('/api/v1/marks')) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const response = await f.request(url.pathname + url.search, { method: req.method, headers: req.headers,
          ...(!['GET', 'HEAD'].includes(req.method) && { body: Buffer.concat(chunks) }) });
        res.writeHead(response.status, { 'content-type': 'application/json' }); res.end(await response.text()); return;
      }
      if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end(html); return; }
      const name = url.pathname.slice(1);
      const allowed = /^(viewer-mark[s\w-]*|utm-conversion)\.mjs$/.test(name) || ['server/viewerMarkGeometry.mjs', 'node_modules/leaflet/dist/leaflet-src.esm.js', 'node_modules/leaflet/dist/leaflet.css'].includes(name);
      if (!allowed) { res.writeHead(404); res.end(); return; }
      res.setHeader('content-type', name.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(fs.readFileSync(path.join(root, name)));
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const unlock = await acquireBrowserHarnessLock({ root });
  t.after(unlock);
  const browser = launchBrowser(binary, ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', 'about:blank'],
    { spawnOptions: { windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] } });
  t.after(() => browser.cleanup());
  const port = await waitForDevToolsPort(path.join(browser.profile, 'DevToolsActivePort'));
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const cdp = await Cdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
  t.after(() => cdp.close());
  await cdp.command('Page.enable');
  await cdp.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await cdp.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  const wait = async expression => {
    for (let i = 0; i < 160; i += 1) {
      if (await cdp.evaluate(expression).catch(() => false)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('Browser condition timed out: ' + expression);
  };
  await wait('window.ready === true');
  const press = selector => cdp.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await press('.viewer-mark-layers');
  assert.equal(await cdp.evaluate("!document.querySelector('.viewer-mark-box').hidden && document.querySelector('.viewer-mark-box').classList.contains('sheet')"), true);
  await cdp.evaluate("[...document.querySelectorAll('button')].find(b => b.textContent === 'Share all').click()");
  assert.equal(await cdp.evaluate("document.activeElement.textContent === 'Cancel' && !document.querySelector('.viewer-mark-confirm').hidden"), true);
  await cdp.evaluate("document.querySelector('.viewer-mark-confirm').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); [...document.querySelectorAll('.viewer-mark-confirm button')].find(b => b.textContent === 'Change').click()");
  await wait("marks.store.state.marks.find(m => m.name === 'Unshared').visibility === 'shared' && !marks.store.state.busy");
  await cdp.evaluate("[...document.querySelectorAll('.viewer-mark-list-item')].find(b => b.textContent.startsWith('Client changed')).click()");
  assert.equal(await cdp.evaluate("document.querySelector('.viewer-mark-box').hidden && !document.querySelector('.viewer-mark-card').hidden"), true);
  await cdp.evaluate("[...document.querySelectorAll('.viewer-mark-card button')].find(b => b.textContent === 'History').click()");
  await wait("!document.querySelector('.viewer-mark-history').hidden && !!document.querySelector('[data-revert-revision]')");
  await press('[data-revert-revision="1"]');
  await wait("marks.store.state.marks.some(m => m.name === 'Staff original') && !marks.store.state.busy");
  assert.equal(await cdp.evaluate("document.querySelector('.viewer-mark-card h4').textContent"), 'Staff original');
  await cdp.evaluate('publicRead()');
  await press('.viewer-mark-layers');
  await cdp.evaluate("[...document.querySelectorAll('#viewer-marks-ui .viewer-mark-list-item')].find(b => b.textContent.startsWith('Public shared') && !b.closest('[hidden]')).click()");
  await wait("!document.querySelector('#viewer-marks-ui .viewer-mark-card').hidden");
  assert.equal(await cdp.evaluate("[...document.querySelectorAll('.viewer-mark-card button')].filter(b => !b.closest('[hidden]')).map(b => b.textContent).join('')"), '×');
  assert.equal(await cdp.evaluate("document.querySelector('.viewer-mark-add').hidden && !marks.store.canWrite() && document.querySelector('.viewer-mark-card-note').hidden"), true);
  assert.deepEqual(await cdp.evaluate('reads'), [['GET', '/api/v1/marks'], ['GET', '/api/v1/marks/shared']]);
});
