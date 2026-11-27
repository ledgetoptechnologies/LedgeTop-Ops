import test from 'node:test';
import assert from 'node:assert/strict';
import { openMarksPanel } from './helpers/marks-panel.mjs';
import { createMiniDocument, memoryStorage } from './helpers/mini-dom.mjs';
import { createMarksStore } from '../viewer-marks-store.mjs';

// Changing sharing for several marks at once: select, confirm, one paced job, Resume;
// sharing only on one's own marks; public display choices stay in the tab; a deleted
// mark is not brought back by a read that began before it went.
const mark = (name, extra = {}) => ({ name, note: '', geometry: { type: 'Point', coordinates: [-87, 43] }, categoryId: null,
  color: '#1e88e5', icon: 'pin', elevationNavd88M: null, ...extra });
const visible = node => Boolean(node && !node.hidden && (!node.parent || visible(node.parent)));
const writes = requests => requests.filter(([method]) => method !== 'GET').map(([method, path]) => `${method} ${path.replace(/[0-9a-f-]{36}/g, 'ID')}`);
const rows = p => p.q('[id=viewer-marks-list]').querySelectorAll('.viewer-mark-list-item');
const row = (p, name) => rows(p).find(node => node.textContent.startsWith(name));
const tick = (p, name) => row(p, name).parent.querySelector('input');
const jobText = p => p.q('.viewer-mark-job').textContent;
async function choose(p, value) { p.q('[name=bulkVisibility]').value = value; await p.q('[name=bulkVisibility]').fire('change'); }

test('select several own marks, confirm with Cancel focused, then one job changes exactly those', async t => {
  const f = await openMarksPanel(t), p = f.mount(), colleague = f.mount();
  t.after(() => { p.marks.dispose(); colleague.marks.dispose(); });
  await colleague.marks.setScope(f.scope('ops', 'staff-b'));
  await colleague.store.create(mark('Colleague', { visibility: 'shared', access: 'edit' }));
  await p.marks.setScope(f.scope('ops', 'staff-a'));
  const a = await p.store.create(mark('Alpha', { visibility: 'private' }));
  const b = await p.store.create(mark('Bravo', { visibility: 'private' }));
  const c = await p.store.create(mark('Charlie', { visibility: 'private' }));
  await p.q('.viewer-mark-layers').click();
  await p.button('Select').click();
  assert.equal(visible(p.q('.viewer-mark-select-head')), true);
  assert.equal(visible(p.q('.viewer-mark-bulk')), true);
  assert.equal(tick(p, 'Colleague').disabled, true, "someone else's mark cannot be picked");
  assert.equal(p.button('Apply').disabled, true);
  await row(p, 'Alpha').click();
  tick(p, 'Bravo').checked = true; await tick(p, 'Bravo').fire('change');
  assert.match(p.q('.viewer-mark-select-count').textContent, /^2 selected$/);
  await choose(p, 'shared-view');
  f.requests.length = 0;
  await p.button('Apply').click();
  assert.equal(visible(p.q('.viewer-mark-confirm')), true);
  assert.match(p.q('.viewer-mark-confirm').textContent, /2 marks to Shared, view only/);
  assert.equal(p.dom.document.activeElement?.textContent, 'Cancel');
  await p.q('.viewer-mark-confirm').querySelectorAll('button').find(node => node.textContent === 'Cancel').click();
  assert.equal(visible(p.q('.viewer-mark-confirm')), false);
  assert.deepEqual(writes(f.requests), [], 'nothing is sent until Change');
  await p.button('Apply').click();
  await p.confirm();
  assert.deepEqual(writes(f.requests), ['POST /api/v1/marks/batch/share']);
  assert.deepEqual([a, b, c].map(m => [p.store.find(m.id).visibility, p.store.find(m.id).access ?? null]),
    [['shared', 'view'], ['shared', 'view'], ['private', null]]);
  assert.match(jobText(p), /^2 of 2 changed\./);
  assert.equal(visible(p.q('.viewer-mark-select-head')), false, 'select mode ends with the change');
  await p.q('[aria-label="Close sharing status"]').click();
  assert.equal(visible(p.q('.viewer-mark-job')), false);
});

test('All takes only the marks shown; Escape leaves select mode before the list; another person starts with none', async t => {
  const f = await openMarksPanel(t), p = f.mount();
  t.after(() => p.marks.dispose());
  await p.marks.setScope(f.scope('ops', 'staff-a'));
  for (const name of ['North gate', 'North fence', 'South pond']) await p.store.create(mark(name, { visibility: 'private' }));
  await p.q('.viewer-mark-layers').click();
  await p.button('Select').click();
  await p.type('[name=markSearch]', 'north');
  await p.button('All').click();
  assert.match(p.q('.viewer-mark-select-count').textContent, /^2 selected$/);
  await p.button('None').click();
  assert.match(p.q('.viewer-mark-select-count').textContent, /^0 selected$/);
  await p.button('All').click();
  await p.dom.window.fire('keydown', { key: 'Escape', target: p.q('.viewer-mark-box') });
  assert.equal(visible(p.q('.viewer-mark-box')), true, 'Escape first leaves select mode');
  assert.equal(visible(p.q('.viewer-mark-select-head')), false);
  await p.button('Select').click();
  assert.match(p.q('.viewer-mark-select-count').textContent, /^0 selected$/, 'a new selection starts empty');
  await p.marks.setScope(f.scope('ops', 'staff-b'));
  await p.store.create(mark('Theirs', { visibility: 'private' }));
  await p.q('.viewer-mark-layers').click();
  assert.equal(visible(p.q('.viewer-mark-select-head')), false);
  assert.equal(visible(p.button('Select')), true);
});

test('held Enter does not answer: repeats are dropped and a key press counts only after the key was let go', async t => {
  const f = await openMarksPanel(t), p = f.mount();
  t.after(() => p.marks.dispose());
  await p.marks.setScope(f.scope('ops', 'staff-a'));
  const only = await p.store.create(mark('Only', { visibility: 'private' }));
  await p.q('.viewer-mark-layers').click();
  f.requests.length = 0;
  await p.button('Share all').click();
  const go = p.q('.viewer-mark-confirm').querySelectorAll('button').find(node => node.textContent === 'Change');
  const cancel = p.q('.viewer-mark-confirm').querySelectorAll('button').find(node => node.textContent === 'Cancel');
  for (const target of [cancel, go]) assert.equal((await target.fire('keydown', { key: 'Enter', repeat: true })).defaultPrevented, true);
  // The browser turns Enter on a focused button into a click: before any key-up it is the held key.
  await go.click();
  assert.deepEqual(writes(f.requests), []);
  assert.equal(p.store.find(only.id).visibility, 'private');
  await p.q('.viewer-mark-confirm').fire('keyup', { key: 'Enter' });
  await go.click();
  assert.deepEqual(writes(f.requests), ['POST /api/v1/marks/batch/share']);
  assert.equal(p.store.find(only.id).visibility, 'shared');
});

test('a job that stops part way reads the list again, says N of M with Resume, keeps it over closing the list, and redoes nothing', async t => {
  const f = await openMarksPanel(t);
  let puts = 0, refuse = false;
  const p = f.mount({ request: async (url, init) => {
    // The second change is refused for the rate.
    if (init.method === 'PUT' && refuse && ++puts === 2) return Response.json({ code: 'mark_rate_limited' }, { status: 429 });
    return fetch(url, init);
  } });
  t.after(() => p.marks.dispose());
  await p.marks.setScope(f.scope('ops', 'staff-a'));
  const made = [];
  for (const name of ['One', 'Two', 'Three']) made.push(await p.store.create(mark(name, { visibility: 'shared', access: 'edit' })));
  await p.q('.viewer-mark-layers').click();
  await p.button('Select').click();
  await p.button('All').click();
  await choose(p, 'private');
  await p.button('Apply').click();
  f.requests.length = 0;
  refuse = true;
  await p.confirm();
  assert.deepEqual(writes(f.requests), ['PUT /api/v1/marks/ID', 'PUT /api/v1/marks/ID']);
  assert.ok(f.requests.slice(2).some(([method, path]) => method === 'GET' && path === '/api/v1/marks'), 'the list is read again after the stop');
  assert.match(jobText(p), /^1 of 3 changed\./);
  assert.match(p.text(), /Too many requests/);
  assert.equal(visible(p.button('Resume')), true);
  await p.q('.viewer-mark-box').querySelector('[aria-label="Close marks"]').click();
  await p.q('.viewer-mark-layers').click();
  assert.equal(visible(p.button('Resume')), true, 'Resume is still there after the list was closed');
  f.requests.length = 0;
  await p.button('Resume').click();
  assert.equal(f.requests[0][0], 'GET', 'Resume reads first');
  assert.deepEqual(writes(f.requests), ['PUT /api/v1/marks/ID', 'PUT /api/v1/marks/ID'], 'only the two not changed yet');
  assert.deepEqual(made.map(m => p.store.find(m.id).visibility), ['private', 'private', 'private']);
  assert.match(jobText(p), /^3 of 3 changed\./);
  assert.equal(visible(p.button('Resume')), false);
});

test('an answer that does not say the change was made is never counted; a failed read is said and Resume reads first', async t => {
  const f = await openMarksPanel(t);
  let trim = true, failRead = false;
  const p = f.mount({ request: async (url, init) => {
    if (failRead && init.method === 'GET') return Response.json({ code: 'boom' }, { status: 500 });
    const response = await fetch(url, init);
    if (!url.endsWith('/batch/share') || !trim) return response;
    const data = await response.json();
    trim = false; failRead = true;
    // A 2xx whose rows are incomplete: one missing, one with other access.
    return Response.json({ marks: [{ ...data.marks[0], access: 'view' }] });
  } });
  t.after(() => p.marks.dispose());
  await p.marks.setScope(f.scope('ops', 'staff-a'));
  const a = await p.store.create(mark('Alpha', { visibility: 'private' }));
  const b = await p.store.create(mark('Bravo', { visibility: 'private' }));
  await p.q('.viewer-mark-layers').click();
  await p.button('Share all').click();
  await p.confirm();
  assert.deepEqual([a, b].map(m => p.store.find(m.id).visibility), ['private', 'private'], 'not shown as changed on that answer');
  assert.match(jobText(p), /Not sure how many changed/);
  assert.match(p.text(), /Resume reads the list first/);
  assert.equal(visible(p.button('Resume')), true);
  failRead = false;
  f.requests.length = 0;
  await p.button('Resume').click();
  assert.deepEqual(writes(f.requests), [], 'the server had made both: nothing is sent again');
  assert.deepEqual([a, b].map(m => p.store.find(m.id).visibility), ['shared', 'shared']);
  assert.match(jobText(p), /^2 of 2 changed\./);
});

test('marks changed elsewhere meanwhile are left and counted, not overwritten', async t => {
  const f = await openMarksPanel(t), p = f.mount(), other = f.mount();
  t.after(() => { p.marks.dispose(); other.marks.dispose(); });
  const scope = f.scope('ops', 'staff-a');
  await p.marks.setScope(scope);
  const a = await p.store.create(mark('Alpha', { visibility: 'private' }));
  const b = await p.store.create(mark('Bravo', { visibility: 'private' }));
  // The same person in another tab renames Bravo; this tab has not read that.
  await other.marks.setScope(scope);
  await other.store.update(other.store.find(b.id), { name: 'Bravo renamed' });
  await p.q('.viewer-mark-layers').click();
  await p.button('Share all').click();
  await p.confirm();
  assert.equal(p.store.find(a.id).visibility, 'shared');
  assert.deepEqual([p.store.find(b.id).name, p.store.find(b.id).visibility], ['Bravo renamed', 'private']);
  assert.match(jobText(p), /^1 of 2 changed\. 1 mark changed elsewhere, left as they are\./);
});

test('the sharing control is hidden on marks owned by other staff, and their sharing is sent unchanged', async t => {
  const f = await openMarksPanel(t), owner = f.mount(), colleague = f.mount();
  t.after(() => { owner.marks.dispose(); colleague.marks.dispose(); });
  await owner.marks.setScope(f.scope('ops', 'owner'));
  const shared = await owner.store.create(mark('Owner mark', { visibility: 'shared', access: 'edit' }));
  await colleague.marks.setScope(f.scope('ops', 'colleague'));
  const own = await colleague.store.create(mark('Own mark', { visibility: 'private' }));
  await colleague.open('Owner mark');
  assert.equal(visible(colleague.q('[name=visibility]')), false);
  await colleague.type('[name=note]', 'Checked on site'); await colleague.save();
  assert.deepEqual([colleague.store.find(shared.id).visibility, colleague.store.find(shared.id).access], ['shared', 'edit']);
  await colleague.open('Own mark');
  assert.equal(visible(colleague.q('[name=visibility]')), true, 'one\'s own mark still has it');
  assert.ok(own);
});

test('public link labels and grouping stay in the tab: nothing is sent and another tab starts fresh', async t => {
  const f = await openMarksPanel(t), shared = memoryStorage();
  const staff = f.mount();
  t.after(() => staff.marks.dispose());
  await staff.marks.setScope(f.scope('ops', 'staff-a'));
  await staff.store.create(mark('Public mark', { visibility: 'shared', access: 'view' }));
  const page = { marks: [{ ...mark('Public mark'), id: '00000000-0000-4000-8000-000000000001', visibility: 'shared', access: 'view', mine: false, editable: false, deletable: false }], categories: [], next: null };
  const publicRequest = async url => Response.json(url.endsWith('/shared') ? page : { marks: [], categories: [], capabilities: { write: false, staff: false, visibility: ['private'], shared: true } });
  const first = f.mount({ dom: createMiniDocument({ localStorage: shared }), request: publicRequest, group: true });
  t.after(() => first.marks.dispose());
  await first.marks.setScope({ mode: 'session', key: 'public-a', readOnly: true, token: () => 'synthetic.page' });
  await first.q('.viewer-mark-layers').click();
  await first.q('[data-tab=categories]').click();
  f.requests.length = 0;
  first.q('[name=labels]').value = 'on'; await first.q('[name=labels]').fire('change');
  first.q('[name=group]').checked = false; await first.q('[name=group]').fire('change');
  assert.deepEqual(f.requests, [], 'display choices are never sent');
  assert.deepEqual([...shared.items.keys()].filter(key => /labels|group/.test(key)), [], 'nothing kept for other tabs');
  assert.deepEqual([first.dom.window.sessionStorage.getItem('ltds.viewer.marks.labels'), first.dom.window.sessionStorage.getItem('ltds.viewer.marks.group')], ['on', 'off']);
  const second = f.mount({ dom: createMiniDocument({ localStorage: shared }), request: publicRequest, group: true });
  t.after(() => second.marks.dispose());
  await second.marks.setScope({ mode: 'session', key: 'public-b', readOnly: true, token: () => 'synthetic.page' });
  assert.deepEqual([second.q('[name=labels]').value, second.q('[name=group]').checked], ['selected', true]);
  // Signed in, the choice is kept in this browser as before.
  const signed = f.mount({ dom: createMiniDocument({ localStorage: shared }), group: true });
  t.after(() => signed.marks.dispose());
  await signed.marks.setScope(f.scope('ops', 'staff-b'));
  signed.q('[name=labels]').value = 'off'; await signed.q('[name=labels]').fire('change');
  assert.equal(shared.getItem('ltds.viewer.marks.labels'), 'off');
  assert.equal(shared.getItem('ltds.viewer.marks.group'), null, 'only the choice that changed is written');
});

test('a mark deleted while a read is in flight does not come back with that read', async () => {
  const own = { ...mark('Mine'), id: '00000000-0000-4000-8000-0000000000a1', revision: 1, visibility: 'private', mine: true, editable: true };
  const theirs = { ...mark('Theirs'), id: '00000000-0000-4000-8000-0000000000b2', revision: 1, visibility: 'shared', access: 'edit', mine: false, editable: true, deletable: true };
  let releasePage, deleted = false;
  const request = async (url, init) => {
    if (init.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
    if (url.endsWith('/shared')) return Response.json({ marks: [theirs], categories: [], next: 'p2' });
    if (url.includes('/shared?after=')) {
      // Served before the delete was made, answered after it.
      const served = deleted ? [] : [theirs];
      await new Promise(resolve => { releasePage = resolve; });
      return Response.json({ marks: served, categories: [], next: null });
    }
    return Response.json({ marks: [own], categories: [], starters: [], capabilities: { write: true, staff: true, visibility: ['shared', 'private'], access: ['edit', 'view'], shared: true } });
  };
  const store = createMarksStore({ request, newId: () => '00000000-0000-4000-8000-0000000000c3' });
  const loading = store.setScope({ mode: 'session', key: 'k', token: () => 'token' });
  for (let i = 0; i < 50 && !releasePage; i += 1) await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(store.find(theirs.id), 'the first page is shown as it arrives');
  assert.equal(await store.remove(store.find(theirs.id)), true);
  releasePage();
  await loading;
  assert.equal(store.find(theirs.id), null);
  assert.ok(store.find(own.id));
});

test('a sharing answer for a mark that went meanwhile does not bring it back', async () => {
  const one = { ...mark('One'), id: '00000000-0000-4000-8000-0000000000d1', revision: 1, visibility: 'private', mine: true, editable: true };
  let store;
  const request = async (url, init) => {
    if (url.endsWith('/batch/share')) {
      // Another view of this tab's state: the mark is gone before the answer is applied.
      store.state.marks = store.state.marks.filter(row => row.id !== one.id);
      return Response.json({ marks: [{ ...one, revision: 2, visibility: 'shared', access: 'edit' }] });
    }
    return Response.json({ marks: [one], categories: [], starters: [], capabilities: { write: true, staff: true, visibility: ['shared', 'private'], access: ['edit', 'view'], shareAll: true } });
  };
  store = createMarksStore({ request, newId: () => '00000000-0000-4000-8000-0000000000e4' });
  await store.setScope({ mode: 'session', key: 'k', token: () => 'token' });
  await store.shareAll('edit');
  assert.equal(store.state.marks.some(row => row.id === one.id), false);
});

test('the question counts only the marks it would change, and says when none would', async t => {
  const f = await openMarksPanel(t), p = f.mount();
  t.after(() => p.marks.dispose());
  await p.marks.setScope(f.scope('ops', 'staff-a'));
  await p.store.create(mark('Already', { visibility: 'shared', access: 'edit' }));
  await p.store.create(mark('Private', { visibility: 'private' }));
  await p.q('.viewer-mark-layers').click();
  await p.button('Select').click();
  await p.button('All').click();
  await choose(p, 'shared');
  await p.button('Apply').click();
  assert.match(p.q('.viewer-mark-confirm').textContent, /for 1 mark to Shared, client can edit/);
  await p.q('.viewer-mark-confirm').querySelectorAll('button').find(node => node.textContent === 'Cancel').click();
  await row(p, 'Private').click();
  f.requests.length = 0;
  await p.button('Apply').click();
  assert.equal(visible(p.q('.viewer-mark-confirm')), false);
  assert.match(p.text(), /It is already Shared, client can edit\./);
  assert.deepEqual(writes(f.requests), []);
});
