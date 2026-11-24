import assert from 'node:assert/strict';
import test from 'node:test';
import { mountViewerMarks } from '../viewer-marks.mjs';
import { createMiniDocument } from './helpers/mini-dom.mjs';
import { createMiniLeaflet } from './helpers/mini-leaflet.mjs';

const owned = { name: 'Owned pin', color: '#1565c0', geometry: { type: 'Point', coordinates: [-87, 43] } };

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

test('expired Restore keeps a draft and only brings back focus that was lost', async () => {
  for (const moveFocus of [false, true]) {
    const { document } = createMiniDocument();
    const panel = document.createElement('div');
    const leaflet = createMiniLeaflet(document);
    const row = { ...owned, id: 'deleted-pin', deletedAt: '2026-07-01T00:00:00Z', revision: 2 };
    let complete, deleted = [row];
    const marks = mountViewerMarks({ panel, L: leaflet.L, getMap: () => leaflet.map, request: async (path, init) => {
      if (path.endsWith('/deleted')) return Response.json({ marks: deleted });
      if (init.method === 'POST') return new Promise(resolve => { complete = resolve; });
      return Response.json({ marks: [], categories: [], capabilities: { write: true, staff: true, visibility: ['private'] } });
    } });
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
      const chosen = panel.querySelector('[data-tab=categories]');
      // The miniature DOM does not automatically move focus off a removed node.
      if (moveFocus) {
        chosen.focus();
        await document.fire('focusin', { target: chosen });
      } else document.activeElement = document.body;
      deleted = [];
      complete(Response.json({ code: 'mark_not_found' }, { status: 404 }));
      await restoring;
      assert.equal(panel.querySelector('[data-restore-mark]'), null);
      assert.equal(document.activeElement, moveFocus ? chosen : deletedTab);
      assert.equal(draft.value, 'Draft pin');
      assert.equal(panel.querySelector('.viewer-mark-form').hidden, false);
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
