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
  assert.equal((await z()).defaultPrevented, false, 'refused, so the key is not taken');
  assert.deepEqual([names(), panel.q('[name=note]').value], [['One', 'Two'], 'Typing']);
  assert.match(panel.text(), /Save or cancel the open mark first/);
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

// Requests of one kind wait until they are let go, or are refused.
function gate() {
  let waiting = null;
  const held = { refuse: false,
    hold(match) { waiting = { match, promise: Promise.withResolvers(), reached: Promise.withResolvers() }; return waiting.reached.promise; },
    release() { const was = waiting; waiting = null; was.promise.resolve(); },
    request: async (path, init) => {
      const now = waiting;
      if (now && now.match(path, init)) { now.reached.resolve(); await now.promise.promise; }
      if (held.refuse && init.method !== 'GET') return new Response(JSON.stringify({ code: 'mark_rate_limited' }), { status: 429 });
      return fetch(path, { ...init, signal: undefined });
    } };
  return held;
}
const writes = (path, init) => init.method !== 'GET';
const settle = () => new Promise(resolve => setTimeout(resolve, 25));
const press = (element, more = {}) => element.fire('keydown', { key: 'Delete', stopPropagation() {}, ...more });
function fillDeleted(database) {
  const insert = database.prepare(`INSERT INTO viewer_marks(id, model_id, owner_audience, owner_subject, visibility, document_json, creation_hash, revision, created_at, updated_at,
    updated_by_audience, updated_by_subject, deleted_at) VALUES (?, 'synthetic-model', 'client', 'client-a', 'private', '{"a":1}', 'x', 1, 'x', 'x', 'client', 'client-a', ?)`);
  for (let i = 0; i < 1000; i += 1) insert.run('old' + i, new Date().toISOString());
}

test('a mark goes for good only from the button that says so; held keys and double clicks delete nothing more', async t => {
  const { panel, add, pin, database } = await open(t);
  const one = await add('One');
  for (const name of ['Two', 'Three']) await add(name);
  const there = () => panel.store.state.marks.map(mark => mark.name).sort();
  // Focus moves to the next pin: the key still held is not for that one.
  pin('Three').getElement().focus();
  await press(pin('Three').getElement());
  const event = await press(panel.dom.document.activeElement, { repeat: true });
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(there(), ['One', 'Two']);
  fillDeleted(database);
  await press(pin('One').getElement());
  assert.match(panel.q('.viewer-mark-card').textContent, /Recently deleted is full/);
  const button = panel.card('Delete for good');
  assert.ok(button);
  for (const more of [{ repeat: true }, {}, {}]) {
    await press(pin('One').getElement(), more);
    assert.ok(panel.store.find(one.id), 'a key is not a confirmation');
  }
  assert.equal((await button.fire('keydown', { key: 'Enter', repeat: true })).defaultPrevented, true, 'a held Enter does not press it again');
  assert.equal((await button.fire('keydown', { key: 'Enter' })).defaultPrevented, false);
  assert.ok(panel.card('Delete for good'), 'the last key asked again');
  await button.fire('click', { detail: 2 });
  assert.ok(panel.store.find(one.id), 'the second half of a double click on Delete');
  await panel.show('Two');
  assert.ok(panel.card('Delete'), 'asked about one, not the next');
  await panel.card('Delete').click();
  assert.deepEqual(there(), ['One', 'Two']);
  await panel.card('Delete for good').click();
  assert.deepEqual(there(), ['One']);
});

test('an import is not offered for undo once one of its marks is gone for good', async t => {
  const { panel, database, key, says, add } = await open(t);
  const before = await add('Before');
  const input = panel.panel.querySelectorAll('input').find(node => node.getAttribute('type') === 'file');
  const feature = name => ({ type: 'Feature', properties: { name }, geometry: { type: 'Point', coordinates: [-87, 43] } });
  const text = JSON.stringify({ type: 'FeatureCollection', features: [feature('Gone'), feature('Stays')] });
  input.files = [{ size: text.length, text: async () => text }];
  await input.fire('change');
  const stays = panel.store.state.marks.find(mark => mark.name === 'Stays');
  assert.ok(stays);
  fillDeleted(database);
  await panel.show('Gone');
  await panel.card('Delete').click();
  await panel.card('Delete for good').click();
  assert.deepEqual(panel.store.state.marks.map(mark => mark.name).sort(), ['Before', 'Stays']);
  assert.deepEqual([panel.store.state.undo.map(entry => entry.type), says()], [['create'], null]);
  database.exec("DELETE FROM viewer_marks WHERE id LIKE 'old%'");
  assert.equal((await key('z', { ctrlKey: true })).defaultPrevented, true);
  assert.deepEqual([panel.store.find(before.id), panel.store.find(stays.id)?.name], [null, 'Stays'], 'the one before it is next');
});

test('a delete that answers late leaves another card, another person and the focus alone', async t => {
  const held = gate();
  const { panel, add, pin, scope, database } = await open(t, { mount: { request: held.request } });
  for (const name of ['One', 'Two', 'Three']) await add(name);
  const card = () => panel.q('.viewer-mark-view').textContent;
  // It went, and another card is open by then.
  await panel.show('One');
  let reached = held.hold(writes), going = panel.card('Delete').click();
  await reached;
  await panel.show('Two');
  let focus = panel.dom.document.activeElement;
  held.release();
  await going;
  await settle();
  assert.match(card(), /Two/);
  assert.equal(panel.q('.viewer-mark-card').hidden, false);
  assert.ok(panel.dom.document.activeElement === focus, 'focus stays');
  // Refused, with another card or an unsaved edit open by then.
  fillDeleted(database);
  for (const edit of [false, true]) {
    await panel.show('Three');
    reached = held.hold(writes);
    going = press(pin('Three').getElement());
    await reached;
    await panel.show('Two');
    // Edit is off while the delete is on its way; a key press that was already queued is not.
    if (edit) { panel.card('Edit').disabled = false; await panel.card('Edit').click(); panel.q('[name=note]').value = 'Typing'; }
    focus = panel.dom.document.activeElement;
    held.release();
    await going;
    await settle();
    assert.equal(panel.q('.viewer-mark-form').hidden, !edit);
    assert.match(edit ? panel.q('[name=name]').value : card(), /Two/);
    assert.ok(panel.dom.document.activeElement === focus, 'focus stays');
    assert.equal(panel.card('Delete for good') ?? null, null);
    if (edit) { assert.equal(panel.q('[name=note]').value, 'Typing'); await panel.card('Cancel').click(); }
  }
  // Refused, with another person signed in by then.
  await panel.show('Three');
  reached = held.hold(writes);
  going = panel.card('Delete').click();
  await reached;
  await panel.marks.setScope(scope('client', 'client-b'));
  held.release();
  await going;
  await settle();
  assert.deepEqual([panel.q('.viewer-mark-card').hidden, panel.store.state.marks], [true, []]);
  assert.doesNotMatch(panel.text() + panel.overlay.textContent, /is full|Three/);
});

test('Ctrl+Z is the text\'s own in anything editable, and taken only when the map undoes something', async t => {
  const held = gate();
  const { panel, key, add } = await open(t, { mount: { request: held.request } });
  await add('One');
  await add('Two');
  const z = (more = {}) => key('z', { ctrlKey: true, ...more });
  const make = value => { const host = panel.dom.document.createElement('div'); if (value !== undefined) host.setAttribute('contenteditable', value); return host; };
  const inside = host => { const child = panel.dom.document.createElement('span'); host.append(child); return child; };
  for (const target of [make('true'), make(''), make('plaintext-only'), inside(make('')), inside(inside(make('plaintext-only'))), Object.assign(make(), { isContentEditable: true })]) {
    assert.equal((await z({ target })).defaultPrevented, false);
  }
  assert.equal((await z({ repeat: true })).defaultPrevented, false, 'one press, one change');
  assert.equal(panel.store.state.marks.length, 2);
  const reached = held.hold(writes), first = z();
  await reached;
  assert.equal((await z()).defaultPrevented, false, 'not while one is on its way');
  held.release();
  assert.equal((await first).defaultPrevented, true);
  await settle();
  assert.deepEqual(panel.store.state.marks.map(mark => mark.name), ['One']);
});

test('an undo that fails after its offer is gone says so and can be tried again', async t => {
  const held = gate();
  const { panel, key, add, undo, says, time, scope, database } = await open(t, { mount: { request: held.request } });
  await add('One');
  await add('Two');
  // The offer runs out while the undo is on its way.
  held.refuse = true;
  const reached = held.hold(writes), late = undo().click();
  await reached;
  time.pass(8000);
  held.release();
  await late;
  await settle();
  assert.match(String(says()), /Two added\. Too many requests/);
  time.pass(60_000);
  assert.match(String(says()), /Two added\. Too many requests/, 'it stays until it is dealt with');
  await panel.q('[aria-label=Dismiss]').click();
  assert.equal(says(), null);
  // With the keyboard, long after.
  assert.equal((await key('z', { ctrlKey: true })).defaultPrevented, true);
  await settle();
  assert.match(String(says()), /Two added\. Too many requests/);
  held.refuse = false;
  await undo().click();
  assert.deepEqual([panel.store.state.marks.map(mark => mark.name), says()], [['One'], null]);
  // Something else failing is not this one's error.
  await add('Three');
  held.refuse = true;
  await panel.open('One');
  await panel.type('[name=note]', 'x');
  await panel.save();
  assert.equal(says(), 'Three added');
  await panel.card('Cancel').click();
  held.refuse = false;
  // What can never be undone says so, with nothing to press.
  database.exec('UPDATE viewer_marks SET revision = revision + 1 WHERE deleted_at IS NULL');
  time.pass(8000);
  await key('z', { ctrlKey: true });
  await settle();
  assert.match(panel.bar().textContent, /Three added\. Someone else changed this mark/);
  assert.deepEqual([panel.bar().hidden, undo().hidden], [false, true]);
  assert.ok(!panel.store.state.undo.some(entry => entry.done === 'Three added'));
  await panel.marks.setScope(scope('client', 'client-b'));
  assert.deepEqual([says(), panel.bar().textContent.includes('Three')], [null, false]);
});
