import assert from 'node:assert/strict';
import test from 'node:test';
import { mountViewerMarks } from '../viewer-marks.mjs';
import { createMarkVisibility } from '../viewer-mark-visibility.mjs';
import { createMiniDocument, memoryStorage } from './helpers/mini-dom.mjs';
import { createMiniLeaflet } from './helpers/mini-leaflet.mjs';

const owned = { name: 'Owned pin', color: '#1565c0', geometry: { type: 'Point', coordinates: [-87, 43] } };

test('category filters stay tab-local for public read-only sessions and persist for signed-in sessions', async t => {
  for (const kind of ['public fresh', 'public saved', 'staff', 'client']) await t.test(kind, async () => {
    const publicReadOnly = kind.startsWith('public');
    const key = 'synthetic-category-' + kind;
    const storageKey = 'ltds.viewer.marks.hidden';
    const storage = memoryStorage(), reads = [], writes = [], requests = [];
    if (kind === 'public saved') {
      // A choice left by an older viewer must not be restored or removed by a public session.
      const saved = createMarkVisibility({ storage: () => storage });
      saved.setScope(key);
      saved.toggle('gates');
    }
    const before = [...storage.items];
    const localStorage = {
      getItem: name => { if (name === storageKey) reads.push(name); return storage.getItem(name); },
      setItem: (name, value) => { writes.push(name); storage.setItem(name, value); },
      removeItem: name => { writes.push(name); storage.removeItem(name); },
    };
    const categories = [{ id: 'gates', name: 'Gates' }, { id: 'paths', name: 'Paths' }];
    const rows = categories.map(category => ({ ...owned, id: category.id + '-pin', name: category.name + ' pin',
      categoryId: category.id, mine: !publicReadOnly, editable: !publicReadOnly, visibility: 'shared', revision: 1 }));
    const scope = { mode: 'session', key, readOnly: publicReadOnly, token: () => 'synthetic-category-token' };
    const mount = async () => {
      const { document } = createMiniDocument({ localStorage });
      const panel = document.createElement('div'), leaflet = createMiniLeaflet(document);
      const marks = mountViewerMarks({ panel, L: leaflet.L, getMap: () => leaflet.map, request: async (path, init) => {
        requests.push([init.method, path, init.headers.authorization]);
        assert.equal(init.method, 'GET', 'filtering must not write Marks');
        assert.equal(path, '/api/v1/marks', 'the session store remains bound to the actual session');
        assert.equal(init.headers.authorization, 'Bearer synthetic-category-token');
        return Response.json({ marks: rows, categories, capabilities: {
          write: !publicReadOnly, staff: kind === 'staff', visibility: ['private', 'shared'],
        } });
      } });
      await marks.setScope(scope);
      await panel.querySelector('.viewer-mark-layers').click();
      return { marks, panel };
    };
    let ui = await mount();
    const shown = () => ui.panel.querySelectorAll('[id=viewer-marks-list] .viewer-mark-list-name span').map(node => node.textContent);
    const eye = id => ui.panel.querySelector(`[data-eye="${id}"]`);
    try {
      assert.deepEqual(shown(), ['Gates pin', 'Paths pin'], 'a new tab starts with all categories shown');
      await ui.panel.querySelector('[data-tab=categories]').click();
      await eye('gates').click();
      assert.equal(eye('gates').getAttribute('aria-label'), 'Show Gates');
      assert.deepEqual(shown(), ['Paths pin'], 'the category filter works inside the tab');
      await ui.marks.setScope(scope);
      ui.marks.setView({ map: true });
      await ui.marks.store.refresh();
      await ui.panel.querySelector('[data-tab=list]').click();
      assert.equal(eye('gates').getAttribute('aria-label'), 'Show Gates');
      assert.deepEqual(shown(), ['Paths pin'], 'same-session refresh, view and UI tab changes retain the filter');
      assert.deepEqual(ui.marks.store.state.marks, rows, 'filtering never changes store data');
      assert.equal(ui.marks.store.canWrite(), !publicReadOnly);
      if (publicReadOnly) {
        assert.deepEqual(reads, [], 'public category filters never read remembered choices');
        assert.deepEqual(writes, [], 'public category filters never write storage');
        assert.deepEqual([...storage.items], before, 'existing remembered choices remain untouched');
      } else {
        assert.ok(reads.length > 0, 'signed-in choices read storage');
        assert.ok(writes.includes(storageKey), 'signed-in choices still persist');
      }
      ui.marks.dispose();
      ui = await mount();
      assert.deepEqual(shown(), publicReadOnly ? ['Gates pin', 'Paths pin'] : ['Paths pin'],
        'a new tab restores signed-in choices only');
      assert.equal(eye('gates').getAttribute('aria-label'), publicReadOnly ? 'Hide Gates' : 'Show Gates');
      if (publicReadOnly) {
        assert.deepEqual(reads, []);
        assert.deepEqual(writes, []);
        assert.deepEqual([...storage.items], before);
      }
      assert.equal(requests.length, 3, 'initial load, refresh and new-tab load all use the session store');
    } finally {
      ui.marks.dispose();
    }
  });
});

test('staff list distinguishes owned view-only sharing from the editable default without changing access', async () => {
  const { document } = createMiniDocument();
  const panel = document.createElement('div');
  const leaflet = createMiniLeaflet(document);
  const rows = [
    { id: 'view', name: 'View pin', mine: true, visibility: 'shared', access: 'view' },
    { id: 'edit', name: 'Edit pin', mine: true, visibility: 'shared', access: 'edit' },
    { id: 'private', name: 'Private pin', mine: true, visibility: 'private' },
    { id: 'staff', name: 'Staff pin', mine: false, author: 'staff', visibility: 'shared', access: 'view' },
    { id: 'client', name: 'Client pin', mine: false, author: 'client', visibility: 'shared', access: 'edit' },
  ].map(row => ({ ...owned, note: '', icon: 'pin', editable: true, revision: 1, ...row }));
  const requests = [];
  const marks = mountViewerMarks({ panel, L: leaflet.L, getMap: () => leaflet.map, request: async (path, init) => {
    requests.push([init.method, path]);
    assert.equal(init.method, 'GET', 'displaying sharing must not write access');
    return Response.json({ marks: rows, categories: [], capabilities: {
      write: true, staff: true, visibility: ['shared', 'private'], access: ['edit', 'view'],
    } });
  } });
  try {
    await marks.setScope({ mode: 'session', key: 'synthetic-staff', token: () => 'synthetic-staff' });
    const before = structuredClone(marks.store.state.marks);
    for (const map of [false, true]) {
      marks.setView({ map });
      if (panel.querySelector('.viewer-mark-box').hidden) await panel.querySelector('.viewer-mark-open').click();
      assert.equal(panel.querySelector('.viewer-mark-box').hidden, false);
      const list = panel.querySelector('[id=viewer-marks-list]');
      assert.deepEqual(list.querySelectorAll('small').map(node => node.textContent),
        ['Shared, view only', '', 'Only me', 'From project staff', 'From a client']);
      if (!map) continue;
      for (const [id, value] of [['view', 'shared-view'], ['edit', 'shared']]) {
        const row = list.querySelectorAll('.viewer-mark-list-item').find(node => node.textContent.startsWith(rows.find(mark => mark.id === id).name));
        await row.click();
        const card = panel.querySelector('.viewer-mark-card');
        const edit = card.querySelectorAll('button').find(node => node.textContent === 'Edit');
        assert.equal(edit.hidden, false, 'owners can still edit either shared access mode');
        await edit.click();
        assert.equal(panel.querySelector('[name=visibility]').value, value);
        await card.querySelectorAll('button').find(node => node.textContent === 'Cancel').click();
      }
    }
    assert.deepEqual(marks.store.state.marks, before, 'list and editor inspection preserve access');
    assert.deepEqual(requests, [['GET', '/api/v1/marks']]);
  } finally {
    marks.dispose();
  }
});

test('the Marks list remains readable without advertising actions that need a map', async () => {
  const { document } = createMiniDocument();
  const panel = document.createElement('div');
  const leaflet = createMiniLeaflet(document);
  const marks = mountViewerMarks({ panel, L: leaflet.L, getMap: () => leaflet.map });
  try {
    await marks.setScope({ mode: 'temporary', key: 'public' });
    await marks.store.create({ ...owned, id: 'pin' });
    const coords = panel.querySelector('.viewer-mark-coords');
    const list = panel.querySelector('[id=viewer-marks-list]');
    assert.equal(coords.hidden, true);
    assert.equal(list.querySelector('.viewer-mark-list-item'), null);
    assert.equal(list.querySelector('li').textContent, 'Owned pin');

    marks.setView({ map: true });
    assert.equal(coords.hidden, false);
    assert.equal(list.querySelector('.viewer-mark-list-item').tagName, 'BUTTON');
    const input = coords.querySelector('[name=coordinates]');
    input.value = '43.05, -87';
    await coords.fire('submit');
    assert.equal(panel.querySelector('.viewer-mark-form').hidden, false);
  } finally {
    marks.dispose();
  }
});

test('Restore returns focus after its busy repaint unless the user moved it', async () => {
  for (const refused of [false, true]) for (const moveFocus of [false, true]) {
    const { document } = createMiniDocument();
    const panel = document.createElement('div');
    const chosen = document.createElement('button'), fallback = document.createElement('button');
    document.body.append(panel, chosen, fallback);
    const leaflet = createMiniLeaflet(document);
    const row = { ...owned, id: 'deleted-pin', deletedAt: '2026-07-01T00:00:00Z', revision: 2 };
    let complete, deleted = [row], accessLosses = 0, focusRestores = 0;
    const marks = mountViewerMarks({ panel, L: leaflet.L, getMap: () => leaflet.map,
      focusAfterAccessLoss: () => { focusRestores++; fallback.focus(); },
      onViewerAccessLost: () => { accessLosses++; },
      request: async (path, init) => {
        if (path.endsWith('/deleted')) return Response.json({ marks: deleted });
        if (init.method === 'POST') return new Promise(resolve => { complete = resolve; });
        return Response.json({ marks: [], categories: [], capabilities: { write: true, staff: true, visibility: ['private'] } });
      },
    });
    try {
      marks.setView({ map: true });
      await marks.setScope({ mode: 'session', key: 'staff', token: () => 'staff' });
      await panel.querySelector('.viewer-mark-layers').click();
      const deletedTab = panel.querySelector('[data-tab=deleted]');
      await deletedTab.click();
      assert.equal(marks.mapContextMenu({ lat: 43, lng: -87 }), true);
      const draft = panel.querySelector('.viewer-mark-form [name=name]');
      draft.value = 'Draft pin';
      await draft.fire('input');

      const restore = panel.querySelector('[data-restore-mark]');
      restore.focus();
      const restoring = restore.click();
      const busyRestore = panel.querySelector('[data-restore-mark]');
      assert.ok(busyRestore !== restore, 'the busy render replaced the original Restore button');
      assert.equal(busyRestore.disabled, true);
      // The miniature DOM does not automatically move focus off a removed node.
      document.activeElement = document.body;
      if (moveFocus) {
        chosen.focus();
        await document.fire('focusin', { target: chosen });
      }
      deleted = [];
      complete(Response.json({ code: refused ? 'marks_unavailable' : 'mark_not_found' }, { status: refused ? 403 : 404 }));
      await restoring;
      assert.equal(panel.querySelector('[data-restore-mark]'), null);
      assert.equal(accessLosses, Number(refused));
      const expectedFocus = moveFocus ? chosen : refused ? fallback : deletedTab;
      assert.ok(document.activeElement === expectedFocus, 'Restore recovered only focus that was lost');
      assert.equal(focusRestores, Number(refused && !moveFocus));
      if (refused) assert.equal(panel.querySelector('.viewer-mark-box').hidden, true);
      else {
        assert.equal(draft.value, 'Draft pin');
        assert.equal(panel.querySelector('.viewer-mark-form').hidden, false);
      }
    } finally {
      marks.dispose();
    }
  }
});

test('a recovered newer action remains in the Undo notice after a stale Undo click', async () => {
  const { document } = createMiniDocument();
  const panel = document.createElement('div');
  const leaflet = createMiniLeaflet(document);
  const marks = mountViewerMarks({ panel, L: leaflet.L, getMap: () => leaflet.map });
  try {
    marks.setView({ map: true });
    await marks.setScope({ mode: 'temporary', key: 'public' });
    await marks.store.create({ ...owned, id: 'first', name: 'First pin' });
    const bar = panel.querySelector('.viewer-mark-undo'), undo = bar.querySelector('button');
    assert.match(bar.textContent, /First pin/);
    marks.store.undo = async () => {
      await marks.store.create({ ...owned, id: 'newer', name: 'Newer pin' });
      marks.store.state.failure = 'undo_target_changed';
      marks.store.state.message = 'The last change changed while Undo was checked.';
      return false;
    };
    undo.focus();
    await undo.click();
    assert.match(bar.textContent, /Newer pin.*Undo was checked/);
    assert.doesNotMatch(bar.textContent, /First pin/);
    assert.equal(document.activeElement, undo);
  } finally {
    marks.dispose();
  }
});

test('a current Move hides its label and stops accepting actions when Marks access is refused', async () => {
  const { document, window } = createMiniDocument();
  const panel = document.createElement('div');
  const leaflet = createMiniLeaflet(document);
  const ownedPin = { ...owned, id: 'c7807766-0189-4736-a057-d458e73ee621', mine: true, editable: true,
    visibility: 'private', note: '', icon: 'pin', revision: 1, elevationNavd88M: null };
  const sharedPin = { ...ownedPin, id: 'c430748d-90df-477a-b228-e62d26826d7a', name: 'Client pin', mine: false, editable: false };
  let shared = 'available', writes = 0;
  const marks = mountViewerMarks({ panel, L: leaflet.L, getMap: () => leaflet.map, request: async (path, init) => {
    if (init.method !== 'GET') { writes++; return Response.json({}, { status: 500 }); }
    if (path.endsWith('/shared')) {
      if (shared === 'transient') throw new TypeError('Network unavailable');
      if (shared === 'denied') return Response.json({ code: 'marks_unavailable' }, { status: 403 });
      return Response.json({ marks: shared === 'available' ? [sharedPin] : [], categories: [], next: null });
    }
    return Response.json({ marks: [ownedPin], categories: [], capabilities: { write: true, staff: true, visibility: ['private'], shared: true } });
  } });
  try {
    marks.setView({ map: true });
    await marks.setScope({ mode: 'session', key: 'staff', token: () => 'staff' });
    const ownedRow = panel.querySelectorAll('.viewer-mark-list-item').find(row => row.textContent === ownedPin.name);
    await ownedRow.click();
    const move = panel.querySelector('.viewer-mark-card').querySelectorAll('button').find(button => button.textContent === 'Move');
    await move.click();
    const strip = panel.querySelector('.viewer-mark-strip'), moveRow = panel.querySelector('.viewer-mark-move');
    const [save, cancel] = moveRow.querySelectorAll('button');
    assert.equal(strip.hidden, false);
    assert.match(strip.textContent, /Move Owned pin/);
    assert.equal(leaflet.keyboard.on, false);
    assert.equal(marks.mapClick({ lat: 43.04, lng: -86.99 }), true);
    const savedDraft = () => JSON.parse(window.sessionStorage.getItem('ltds-viewer-mark-draft'))?.draft;
    const draft = savedDraft();
    assert.deepEqual(draft?.geometry.coordinates, [-86.99, 43.04]);

    shared = 'withdrawn';
    await marks.store.refreshShared();
    assert.equal(marks.store.find(sharedPin.id), null);
    assert.equal(strip.hidden, false);
    assert.equal(save.disabled, false);
    shared = 'transient';
    await marks.store.refreshShared();
    await window.fire('pagehide', { persisted: true });
    await window.fire('pageshow', { persisted: true });
    assert.deepEqual(savedDraft(), draft);

    shared = 'denied';
    await marks.store.refreshShared();
    assert.equal(marks.store.canWrite(), false);
    assert.equal(strip.hidden, true);
    assert.equal(moveRow.hidden, true);
    assert.doesNotMatch(strip.textContent, /Owned pin/);
    assert.equal(save.disabled, true);
    assert.equal(cancel.disabled, true);
    assert.equal(leaflet.keyboard.on, true);
    const denial = marks.store.state.message;
    // A stale click or keyboard event can still reach a handler even after its control was hidden.
    panel.querySelector('.viewer-mark-form [name=pointCoordinates]').value = 'Invalid coordinates';
    await save.fire('click');
    const enter = await window.fire('keydown', { key: 'Enter' });
    assert.equal(enter.defaultPrevented, false);
    assert.equal(marks.store.state.message, denial);
    assert.deepEqual(savedDraft(), draft);
    assert.equal(writes, 0);
  } finally {
    marks.dispose();
  }
});

test('Marks refusal ends placement and drawing, restoring map input and focus only when lost', async () => {
  for (const [drawing, movedFocus] of [[false, false], [true, false], [true, true]]) {
    const { document, window } = createMiniDocument();
    const panel = document.createElement('div');
    const fallback = document.createElement('button'), chosen = document.createElement('button');
    const leaflet = createMiniLeaflet(document);
    let delayed = false, refuse, zoom = true;
    leaflet.map.doubleClickZoom = { enable: () => { zoom = true; }, disable: () => { zoom = false; } };
    const marks = mountViewerMarks({
      panel, L: leaflet.L, getMap: () => leaflet.map, focusAfterAccessLoss: () => fallback.focus(),
      request: async path => {
        if (path.endsWith('/shared')) {
          if (delayed) return new Promise(resolve => { refuse = resolve; });
          return Response.json({ marks: [], categories: [], next: null });
        }
        return Response.json({ marks: [], categories: [], capabilities: { write: true, staff: true, visibility: ['private'], shared: true } });
      },
    });
    try {
      const session = { mode: 'session', key: 'staff', token: () => 'staff' };
      marks.setView({ map: true });
      await marks.setScope(session);
      if (drawing) {
        await panel.querySelector('[data-add=LineString]').click();
        marks.mapClick({ lat: 43.04, lng: -87 });
        marks.mapClick({ lat: 43.05, lng: -87 });
        assert.equal(zoom, false);
      } else {
        await window.fire('keydown', { key: 'm' });
        assert.equal(leaflet.keyboard.on, false);
      }
      const strip = panel.querySelector('.viewer-mark-strip');
      assert.equal(strip.hidden, false);
      const active = strip.querySelectorAll('button').find(button => button.textContent === (drawing ? 'Finish' : 'Place here'));
      active.focus();
      delayed = true;
      const losing = marks.store.refreshShared();
      if (movedFocus) chosen.focus();
      refuse(Response.json({ code: 'mark_identity_required' }, { status: 403 }));
      await losing;
      assert.equal(strip.hidden, true);
      assert.equal(zoom, true);
      assert.equal(leaflet.keyboard.on, true);
      assert.equal(marks.mapDoubleClick(), false);
      assert.equal(document.activeElement, movedFocus ? chosen : fallback);

      delayed = false;
      await marks.setScope(session);
      assert.equal(marks.store.canWrite(), true);
      assert.equal(strip.hidden, true);
    } finally {
      marks.dispose();
    }
  }
});
