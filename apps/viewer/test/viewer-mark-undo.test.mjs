import assert from 'node:assert/strict';
import test from 'node:test';
import { openMarksPanel } from './helpers/marks-panel.mjs';
import { createMiniDocument } from './helpers/mini-dom.mjs';

// A window whose timers the test moves by hand.
function clock() {
  const dom = createMiniDocument(), timers = new Map();
  let now = 0, next = 1;
  dom.window.setTimeout = (work, ms) => { timers.set(next, { work, at: now + ms }); return next++; };
  dom.window.clearTimeout = id => timers.delete(id);
  return { dom, pending: () => timers.size, pass(ms) {
    now += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.work(); }
  } };
}
async function open(t, { scope: next, mount: more = {} } = {}) {
  const setup = await openMarksPanel(t), time = clock();
  const panel = setup.mount({ dom: time.dom, ...more });
  await panel.marks.setScope(next ? next(setup) : setup.scope('client', 'client-a'));
  const bar = () => panel.bar(), undo = () => bar().querySelectorAll('button').find(node => node.textContent === 'Undo');
  const add = async (name, changes = {}) => { await panel.place('43.05, -87'); await panel.type('[name=name]', name); if (changes.note) await panel.type('[name=note]', changes.note); await panel.save(); return panel.store.state.marks.at(-1); };
  const key = (name, extra) => panel.dom.window.fire('keydown', { key: name, ...extra });
  const pin = name => panel.leaflet.pins().find(item => item.label.text === name);
  return { ...setup, panel, time, bar, undo, add, key, pin, says: () => (bar().hidden ? null : bar().textContent.replace(/Undo.*$/, '')) };
}
const focused = (panel, node) => panel.dom.document.activeElement === node;

test('each add, edit, move and delete says what happened and can be undone there', async t => {
  const { panel, undo, says, add } = await open(t);
  assert.equal(says(), null);
  const one = await add('One');
  assert.equal(says(), 'One added');
  await panel.open('One');
  await panel.type('[name=note]', 'Note');
  await panel.save();
  assert.equal(says(), 'One changed');
  await undo().click();
  assert.deepEqual([panel.store.find(one.id).note, says()], ['', null], 'done, and the one before is not offered by itself');
  await panel.show('One');
  await panel.card('Move').click();
  panel.marks.mapClick({ lat: 43.1, lng: -87.1 });
  await panel.q('.viewer-mark-move').querySelectorAll('button')[0].click();
  assert.equal(says(), 'One moved');
  await undo().click();
  assert.deepEqual(panel.store.find(one.id).geometry, one.geometry);
  await panel.show('One');
  await panel.card('Delete').click();
  assert.deepEqual([panel.store.state.marks, says()], [[], 'One deleted'], 'no question first');
  await undo().click();
  assert.deepEqual(panel.store.state.marks.map(mark => mark.id), [one.id], 'the same mark');
  assert.ok(focused(panel, panel.leaflet.pins()[0].getElement()));
});

test('restoring and importing are offered too; a change that failed is not', async t => {
  let fail = false;
  const { panel, undo, says, add, time } = await open(t, { mount: { request: (path, init) => (fail && init.method !== 'GET'
    ? Promise.resolve(new Response(JSON.stringify({ code: 'mark_rate_limited' }), { status: 429 })) : fetch(path, init)) } });
  await add('One');
  await panel.show('One');
  await panel.card('Delete').click();
  time.pass(8000);
  await panel.q('[data-tab=deleted]').click();
  await panel.q('[aria-label="Restore One"]').click();
  assert.equal(says(), 'One restored');
  const input = panel.panel.querySelectorAll('input').find(node => node.getAttribute('type') === 'file');
  const text = JSON.stringify({ type: 'MultiPoint', coordinates: [[-87, 43], [-87.1, 43]] });
  input.files = [{ size: text.length, text: async () => text }];
  await input.fire('change');
  assert.equal(says(), '2 marks imported');
  // An undo that fails stays, says why, and can be tried again.
  fail = true;
  await undo().click();
  assert.match(says(), /2 marks imported\. Too many requests/);
  assert.equal(panel.store.state.marks.length, 3);
  fail = false;
  await undo().click();
  assert.equal(panel.store.state.marks.length, 1);
  time.pass(8000);
  fail = true;
  await panel.show('One');
  await panel.card('Delete').click();
  assert.equal(says(), null);
  assert.equal(panel.store.state.marks.length, 1);
});

test('it goes after 8 seconds, unless it is pointed at or focused, and can be dismissed', async t => {
  const { panel, bar, undo, says, add, time } = await open(t);
  await add('One');
  time.pass(7999);
  assert.equal(says(), 'One added');
  time.pass(1);
  assert.equal(says(), null);
  await add('Two');
  for (const [enter, leave] of [['mouseenter', 'mouseleave'], ['focusin', 'focusout']]) {
    await bar().fire(enter);
    time.pass(60_000);
    assert.equal(says(), 'Two added', enter);
    if (enter === 'focusin') { await bar().fire(leave, { relatedTarget: undo() }); time.pass(60_000); assert.equal(says(), 'Two added', 'moving within it'); }
    await bar().fire(leave);
    time.pass(7999);
    assert.equal(says(), 'Two added');
  }
  time.pass(1);
  assert.equal(says(), null);
  await add('Three');
  time.pass(5000);
  await add('Four');
  time.pass(5000);
  assert.equal(says(), 'Four added', 'a new change has its own 8 seconds');
  await panel.q('[aria-label=Dismiss]').click();
  assert.deepEqual([says(), time.pending()], [null, 0]);
  // Gone from the bar is not gone from Undo.
  await panel.button('Undo').click();
  assert.deepEqual(panel.store.state.marks.map(mark => mark.name), ['One', 'Two', 'Three']);
});

test('Ctrl+Z takes back the last change, not while typing, placing, moving or with an unsaved edit', async t => {
  const { panel, key, add, says } = await open(t);
  await add('One');
  await add('Two');
  const z = (more = {}) => key('z', { ctrlKey: true, ...more });
  const names = () => panel.store.state.marks.map(mark => mark.name);
  for (const more of [{ target: panel.q('[name=markSearch]') }, { shiftKey: true }, { altKey: true }]) {
    assert.equal((await z(more)).defaultPrevented, false, JSON.stringify(Object.keys(more)));
  }
  await panel.q('.viewer-mark-add').click();
  assert.equal((await z()).defaultPrevented, false);
  await key('Escape');
  await panel.show('One');
  await panel.card('Move').click();
  assert.equal((await z()).defaultPrevented, false);
  await key('Escape');
  await panel.card('Edit').click();
  await panel.type('[name=note]', 'Typing');
  await z();
  assert.deepEqual([names(), panel.q('[name=note]').value], [['One', 'Two'], 'Typing']);
  await panel.card('Cancel').click();
  assert.equal((await z()).defaultPrevented, true);
  assert.deepEqual([names(), says()], [['One'], null]);
  assert.equal((await key('Z', { metaKey: true })).defaultPrevented, true);
  assert.deepEqual(names(), []);
  assert.equal((await z()).defaultPrevented, false, 'nothing left');
});

test('the Delete key deletes the focused pin at once and focus goes on; someone else\'s and a group it does not', async t => {
  const { panel, add, pin, says, mount, scope, database } = await open(t);
  await add('One');
  await add('Two');
  const press = element => element.fire('keydown', { key: 'Delete', stopPropagation() {} });
  pin('One').getElement().focus();
  await press(pin('One').getElement());
  assert.deepEqual([panel.store.state.marks.map(mark => mark.name), says()], [['Two'], 'One deleted']);
  assert.ok(focused(panel, pin('Two').getElement()));
  await panel.open('Two');
  await panel.type('[name=note]', 'Typing');
  await press(pin('Two').getElement());
  assert.equal(panel.store.state.marks.length, 1, 'not under an unsaved edit');
  panel.q('[name=visibility]').value = 'staff';
  await panel.save();
  const staff = mount({ group: true });
  await staff.marks.setScope(scope('ops', 'staff-person'));
  await press(staff.leaflet.pins()[0].getElement());
  assert.equal(database.prepare('SELECT count(*) n FROM viewer_marks WHERE deleted_at IS NULL').get().n, 1);
  await staff.store.create({ geometry: { type: 'Point', coordinates: [-87, 43.05] }, name: 'Staff one', color: '#1565c0', icon: 'pin', note: '' });
  await press(staff.leaflet.groups()[0].getElement());
  assert.equal(staff.store.state.marks.length, 2);
});

test('when a delete could not be brought back it asks, also from the keyboard', async t => {
  const { panel, add, pin, says, database } = await open(t);
  const one = await add('One');
  const insert = database.prepare(`INSERT INTO viewer_marks(id, model_id, owner_audience, owner_subject, visibility, document_json, creation_hash, revision, created_at, updated_at,
    updated_by_audience, updated_by_subject, deleted_at) VALUES (?, 'synthetic-model', 'client', 'client-a', 'private', '{"a":1}', 'x', 1, 'x', 'x', 'client', 'client-a', ?)`);
  for (let i = 0; i < 1000; i += 1) insert.run('old' + i, new Date().toISOString());
  await pin('One').getElement().fire('keydown', { key: 'Delete', stopPropagation() {} });
  assert.ok(panel.store.find(one.id));
  assert.match(panel.q('.viewer-mark-card').textContent, /Recently deleted is full/);
  await panel.card('Delete for good').click();
  assert.equal(panel.store.find(one.id), null);
  assert.equal(says(), null, 'nothing to undo, so it is not offered');
});

test('a mark put back into a hidden category is shown again', async t => {
  const { panel, undo, says } = await open(t);
  const category = await panel.store.saveCategory({ name: 'Gates', color: '#1565c0', icon: 'gate' });
  const mark = await panel.store.create({ geometry: { type: 'Point', coordinates: [-87, 43] }, name: 'Gate', color: '#1565c0', icon: 'gate', note: '', categoryId: category.id });
  await panel.show('Gate');
  await panel.card('Delete').click();
  await panel.q(`[data-eye="${category.id}"]`).click();
  assert.equal(says(), 'Gate deleted');
  await undo().click();
  assert.deepEqual(panel.leaflet.pins().map(pin => pin.label.text), ['Gate']);
  assert.ok(panel.store.find(mark.id));
});

test('deleting a category leaves the offer for the mark before it', async t => {
  const { panel, undo, says } = await open(t);
  const category = await panel.store.saveCategory({ name: 'Gates', color: '#1565c0', icon: 'gate' });
  await panel.store.create({ geometry: { type: 'Point', coordinates: [-87, 43] }, name: 'Gate', color: '#1565c0', icon: 'gate', note: '', categoryId: category.id });
  await panel.show('Gate');
  await panel.card('Delete').click();
  const remove = () => panel.q('[aria-label="Delete Gates"]').click();
  await remove();
  await remove();
  assert.equal(says(), 'Gate deleted');
  await undo().click();
  assert.equal(panel.store.state.marks[0].categoryId, null);
});

test('public links have it in the tab, and it never carries to another person or outlives the panel', async t => {
  const { panel, undo, says, add, scope, requests, time } = await open(t, { scope: () => ({ mode: 'temporary', key: 'public' }) });
  await add('Public one');
  await panel.show('Public one');
  await panel.card('Delete').click();
  assert.equal(says(), 'Public one deleted');
  await undo().click();
  assert.deepEqual([panel.store.state.marks.length, requests], [1, []]);
  await panel.show('Public one');
  await panel.card('Delete').click();
  for (const next of [scope('client', 'client-a'), scope('client', 'client-b'), null]) {
    await panel.marks.setScope(next);
    assert.deepEqual([says(), panel.bar().textContent.includes('Public'), time.pending()], [null, false, 0]);
  }
  await panel.marks.setScope(scope('client', 'client-a'));
  await add('Mine');
  assert.equal(time.pending(), 1);
  panel.marks.dispose();
  assert.deepEqual([time.pending(), panel.overlay.children], [0, []]);
});
